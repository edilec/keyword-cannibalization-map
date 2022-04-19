import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { DEFAULT_LIMITS, MAP_NOTES, MAX_CONFIG_BYTES, mapQueryPageExports } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLEAN_ROOT = join(projectDirectory, 'examples/exports-clean')
const BROKEN_ROOT = join(projectDirectory, 'examples/exports-broken')

const HEADER = 'query,page,region,locale,impressions,clicks,position'
const TWO_PAGES = [HEADER, 'q a,/one,US,en-US,600,10,3.0', 'q a,/two,US,en-US,400,10,4.0', ''].join('\n')

async function withRoot(files, body) {
  const directory = await mkdtemp(join(tmpdir(), 'kcm-g-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(directory, name)
      await mkdir(dirname(target), { recursive: true })
      if (typeof content === 'string') await writeFile(target, content, 'utf8')
      else await writeFile(target, content)
    }
    return await body(directory)
  } finally {
    await chmod(directory, 0o755).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
}

const ruleIds = (report) => report.findings.map((finding) => finding.ruleId)

/**
 * Every `incomplete = true` in the source gets an entry here.
 *
 * Deleting one of those assignments elsewhere in this catalog let an entirely
 * unread input report `pass` with the full suite still green. Each case below
 * fails when its own assignment is removed: for an `error` rule the status
 * drops to `fail`, and for `no-rows-parsed` -- a `warning` -- it drops all the
 * way to `pass`, which is the defect in its purest form.
 *
 * Every case but the last carries a COMPANION export that parses cleanly. That
 * is deliberate: without it the run would have no rows at all, `no-rows-parsed`
 * would fire, and its flag would mask the one under test. An isolation failure
 * like that is how a suite ends up green against a mutation it was written to
 * catch.
 */
const SMALL_GOOD = ['query,page,region,locale,impressions,clicks', 'q a,/one,US,en-US,600,10', 'q a,/two,US,en-US,400,10', ''].join('\n')
const PADDED = [HEADER, ...Array.from({ length: 12 }, (unused, index) => `pad ${index},/pad-${index},US,en-US,10,1,3.0`), ''].join('\n')

test('every path that could not obtain evidence reports incomplete', async (t) => {
  const cases = [
    {
      name: 'a directory nested past maxDepth',
      files: { 'a-good.csv': SMALL_GOOD, 'deep/deeper/e.csv': SMALL_GOOD },
      options: { limits: { maxDepth: 1 } },
      ruleId: 'directory-too-deep',
    },
    {
      name: 'an entry whose real path cannot be resolved',
      files: { 'a-good.csv': SMALL_GOOD },
      prepare: async (root) => symlink(join(root, 'absent.csv'), join(root, 'dangling.csv')),
      ruleId: 'export-unreadable',
    },
    {
      name: 'an entry that resolves outside the export root',
      files: { 'a-good.csv': SMALL_GOOD },
      prepare: async (root) => symlink(join(CLEAN_ROOT, 'search-console-2026-02-us.csv'), join(root, 'escape.csv')),
      ruleId: 'path-escapes-root',
    },
    {
      name: 'an export that cannot be opened',
      files: { 'a-good.csv': SMALL_GOOD, 'locked.csv': SMALL_GOOD },
      prepare: async (root) => chmod(join(root, 'locked.csv'), 0o000),
      ruleId: 'export-unreadable',
    },
    {
      name: 'an export past maxExportBytes',
      files: { 'a-good.csv': SMALL_GOOD, 'big.csv': PADDED },
      options: { limits: { maxExportBytes: 200 } },
      ruleId: 'export-too-large',
    },
    {
      name: 'an export that is not UTF-8',
      files: { 'a-good.csv': SMALL_GOOD, 'bad.csv': new Uint8Array([0x71, 0xff, 0xfe, 0x0a]) },
      ruleId: 'export-not-utf8',
    },
    {
      name: 'an export with no header',
      files: { 'a-good.csv': SMALL_GOOD, 'blank.csv': '  \n' },
      ruleId: 'header-missing',
    },
    {
      name: 'an export past maxRows',
      files: { 'a-good.csv': SMALL_GOOD, 'big.csv': PADDED },
      options: { limits: { maxRows: 3 } },
      ruleId: 'too-many-rows',
    },
    {
      name: 'an unterminated quoted field',
      files: { 'a-good.csv': SMALL_GOOD, 'quoted.csv': `${HEADER}\n"never closed,/a,US,en-US,100,4,3.0\n` },
      ruleId: 'unterminated-quoted-field',
    },
    {
      name: 'a column name past maxFieldChars',
      files: {
        'a-good.csv': SMALL_GOOD,
        'wide.csv': 'query,page,region,locale,impressions,clicks,average position in the results\nq,/a,US,en-US,100,4,3.0\n',
      },
      options: { limits: { maxFieldChars: 20 } },
      ruleId: 'row-field-too-long',
    },
    {
      name: 'a row field past maxFieldChars',
      files: {
        'a-good.csv': SMALL_GOOD,
        'wide.csv': [HEADER, 'a very long query indeed here,/one,US,en-US,600,10,3.0', ''].join('\n'),
      },
      options: { limits: { maxFieldChars: 20 } },
      ruleId: 'row-field-too-long',
    },
    {
      name: 'a missing required column',
      files: { 'a-good.csv': SMALL_GOOD, 'short.csv': 'query,page,region,locale,impressions\nq,/a,US,en-US,100\n' },
      ruleId: 'header-column-missing',
    },
    {
      name: 'a duplicated column',
      files: {
        'a-good.csv': SMALL_GOOD,
        'dup.csv': 'query,page,page,region,locale,impressions,clicks\nq,/a,/b,US,en-US,100,4\n',
      },
      ruleId: 'header-column-duplicate',
    },
    {
      name: 'more exports than maxExports',
      files: { 'a-good.csv': SMALL_GOOD, 'b-second.csv': SMALL_GOOD },
      options: { limits: { maxExports: 1 } },
      ruleId: 'too-many-exports',
    },
    {
      name: 'more intent groups than maxIntentGroups',
      files: {
        'a-good.csv': SMALL_GOOD,
        'more.csv': [
          HEADER,
          'beta q,/three,US,en-US,600,10,3.0',
          'beta q,/four,US,en-US,400,10,4.0',
          '',
        ].join('\n'),
      },
      options: { limits: { maxIntentGroups: 1 } },
      ruleId: 'too-many-intent-groups',
    },
    {
      name: 'a candidate with more rows than maxClusterRows',
      files: { 'a-good.csv': SMALL_GOOD },
      options: { limits: { maxClusterRows: 1 } },
      ruleId: 'cluster-rows-exceeded',
    },
    {
      name: 'an export set that yielded no row at all',
      files: { 'notes.txt': 'not an export' },
      ruleId: 'no-rows-parsed',
      expectNoRows: true,
    },
  ]

  for (const item of cases) {
    await t.test(item.name, async () => {
      await withRoot(item.files, async (root) => {
        if (item.prepare) await item.prepare(root)
        const { report, map } = await mapQueryPageExports({ root, ...(item.options ?? {}) })

        assert.ok(ruleIds(report).includes(item.ruleId), `${item.ruleId} was not reported`)
        assert.equal(report.status, 'incomplete', `${item.name} did not report incomplete`)
        assert.equal(map.complete, false)

        // Isolation: unless this case IS the vacuous-pass guard, the run must
        // have parsed rows, so that guard's flag cannot be what made it
        // incomplete.
        if (item.expectNoRows) {
          assert.equal(report.summary.rows, 0)
        } else {
          assert.ok(report.summary.rows > 0, `${item.name} parsed no row, so the case does not isolate its flag`)
          assert.equal(
            ruleIds(report).includes('no-rows-parsed'),
            false,
            `${item.name} is masked by the vacuous-pass guard`,
          )
        }
      })
    })
  }
})

test('a directory that cannot be listed is incomplete, not an empty directory', async () => {
  await withRoot({ 'a-good.csv': TWO_PAGES, 'locked/e.csv': TWO_PAGES }, async (root) => {
    const locked = join(root, 'locked')
    await chmod(locked, 0o000)
    try {
      const { report } = await mapQueryPageExports({ root })
      assert.ok(ruleIds(report).includes('export-unreadable'))
      assert.equal(report.status, 'incomplete')
      assert.ok(report.summary.rows > 0, 'the readable export beside it must still have been read')
      assert.equal(ruleIds(report).includes('no-rows-parsed'), false)
    } finally {
      await chmod(locked, 0o755)
    }
  })
})

test('an export-shaped entry that is not a regular file is reported, not skipped', async () => {
  await withRoot({ 'e.csv': TWO_PAGES }, async (root) => {
    const socketPath = join(root, 'pipe.csv')
    const server = createServer()
    await new Promise((done, fail) => {
      server.once('error', fail)
      server.listen(socketPath, done)
    })
    try {
      const { report } = await mapQueryPageExports({ root })
      assert.ok(ruleIds(report).includes('export-unreadable'))
      assert.equal(report.status, 'incomplete')
      // The real export beside it was still read; the run is incomplete, not empty.
      assert.equal(report.summary.rows, 2)
    } finally {
      await new Promise((done) => server.close(done))
      await rm(socketPath, { force: true })
    }
  })
})

/**
 * The rule the whole tool turns on: overlap is a candidate for review, never a
 * claim that something is wrong. These assertions read the strings that
 * actually reach a user rather than scanning the source, so a message added
 * later is covered without anyone remembering to extend a list.
 */
const FORBIDDEN_CLAIMS = [
  'harm',
  'damag',
  'hurt',
  'penal',
  'cannibal',
  'duplicate content',
  'will improve',
  'improves',
  'should merge',
  'should consolidate',
  'must consolidate',
  'must merge',
  'fix this',
  'problem',
  'bad ',
  'wasted',
  'wasting',
]

function assertMakesNoClaim(value, where) {
  const lowered = value.toLowerCase()
  for (const phrase of FORBIDDEN_CLAIMS) {
    assert.equal(lowered.includes(phrase), false, `${where} claims "${phrase}": ${value}`)
  }
}

test('no message, suggestion, evidence or note claims a candidate is undesirable', async () => {
  const busy = [
    HEADER,
    'alpha q,/one,US,en-US,1400,90,4.0',
    'alpha q,/two,US,en-US,900,40,7.8',
    'beta q,/three,GB,en-GB,800,55,3.1',
    'beta q,/four,GB,en-GB,300,12,9.5',
    'gamma q,/five,GB,en-GB,400,20,5.5',
    'gamma q,/six,US,en-US,350,18,6.1',
    'delta q,/seven,US,en-US,600,40,2.2',
    'delta q,/seven/,US,en-US,120,8,2.4',
    '',
  ].join('\n')

  const roots = [CLEAN_ROOT, BROKEN_ROOT]
  for (const root of roots) {
    const { report, map } = await mapQueryPageExports({ root })
    for (const finding of report.findings) {
      assertMakesNoClaim(finding.message, `${finding.ruleId} message`)
      if (finding.suggestion) assertMakesNoClaim(finding.suggestion, `${finding.ruleId} suggestion`)
      if (finding.evidence) assertMakesNoClaim(finding.evidence, `${finding.ruleId} evidence`)
    }
    for (const note of map.notes) assertMakesNoClaim(note, 'map note')
  }

  await withRoot({ 'e.csv': busy }, async (root) => {
    const { report, map } = await mapQueryPageExports({ root })
    assert.ok(map.counts.candidates >= 2, 'the fixture must exercise several candidate messages')
    assert.ok(
      ruleIds(report).includes('page-spelling-variant'),
      'the fixture must exercise the spelling-variant message',
    )
    assert.ok(
      ruleIds(report).includes('cross-segment-intent-not-merged'),
      'the fixture must exercise the separation message',
    )
    for (const finding of report.findings) {
      assertMakesNoClaim(finding.message, `${finding.ruleId} message`)
      if (finding.suggestion) assertMakesNoClaim(finding.suggestion, `${finding.ruleId} suggestion`)
    }
  })
})

test('the map states what a candidate is and is not, in the artifact itself', async () => {
  const { map } = await mapQueryPageExports({ root: CLEAN_ROOT })
  assert.deepEqual(map.notes, [...MAP_NOTES])
  const joined = map.notes.join(' ').toLowerCase()
  assert.ok(joined.includes('item for review'))
  assert.ok(joined.includes('not a defect'))
  assert.ok(joined.includes('often deliberate'))
  assert.ok(joined.includes('asserts nothing about consequences'))
  assert.ok(joined.includes('separate intent'))
})

test('a run whose only findings are candidates passes and is complete', async () => {
  const rows = [
    HEADER,
    'alpha q,/one,US,en-US,1400,90,4.0',
    'alpha q,/two,US,en-US,900,40,7.8',
    'beta q,/three,US,en-US,800,55,3.1',
    'beta q,/four,US,en-US,300,12,9.5',
    '',
  ].join('\n')

  await withRoot({ 'e.csv': rows }, async (root) => {
    const { report, map } = await mapQueryPageExports({ root })
    assert.equal(report.status, 'pass')
    assert.equal(map.complete, true)
    assert.equal(report.summary.errors, 0)
    assert.equal(report.summary.warnings, 0)
    assert.equal(map.counts.candidates, 2)
    assert.deepEqual([...new Set(ruleIds(report))], ['cluster-review-candidate'])
  })
})

test('a candidate is never emitted without the rows that produced it', async () => {
  const roots = [CLEAN_ROOT, BROKEN_ROOT]
  for (const root of roots) {
    const { map } = await mapQueryPageExports({ root })
    for (const candidate of map.candidates) {
      assert.ok(candidate.rows.length > 0, `${candidate.id} in ${root} carries no row`)
      assert.ok(candidate.supportingRowCount >= candidate.contributingPages)
      const pagesInRows = new Set(candidate.rows.map((row) => row.page))
      for (const page of candidate.pages) {
        assert.ok(pagesInRows.has(page.page), `${page.page} is counted but has no supporting row`)
      }
    }
  }
})

test('a separated intent is never emitted without the segments it was split across', async () => {
  const { map } = await mapQueryPageExports({ root: CLEAN_ROOT })
  assert.ok(map.separatedIntents.length > 0)
  for (const item of map.separatedIntents) {
    assert.ok(item.segments.length >= 2, 'a separation must name at least two segments')
    assert.ok(item.segments.some((segment) => !segment.qualifies))
    assert.equal(
      item.segments.reduce((total, segment) => total + segment.impressions, 0),
      item.pooledImpressions,
    )
  }
})

test('a query that resolves out of the root never reaches the output', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'kcm-out-'))
  try {
    await writeFile(
      join(outside, 'elsewhere.csv'),
      `${HEADER}\nconfidential term,/private,US,en-US,900,40,3.0\n`,
      'utf8',
    )
    await withRoot({ 'e.csv': TWO_PAGES }, async (root) => {
      await symlink(join(outside, 'elsewhere.csv'), join(root, 'escape.csv'))
      const { report, map } = await mapQueryPageExports({ root })
      const serialized = JSON.stringify({ report, map })
      assert.equal(serialized.includes('confidential term'), false)
      assert.equal(serialized.includes('/private'), false)
      assert.ok(ruleIds(report).includes('path-escapes-root'))
    })
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

/** The body of one Markdown section, up to the next heading of the same level. */
function markdownSection(text, heading) {
  const start = text.indexOf(`${heading}\n`)
  assert.notEqual(start, -1, `${heading} is missing`)
  const rest = text.slice(start + heading.length)
  const next = rest.indexOf('\n## ')
  return next === -1 ? rest : rest.slice(0, next)
}

/** The seven things the tool refuses to conclude, each judged on the README's own wording. */
const README_NON_GOALS = [
  'Whether an overlap matters',
  'Whether consolidating a candidate would help',
  'What a query means',
  'Whether two page values are one page',
  'Whether the segment boundary is right',
  'Anything about rows it did not read',
  'Anything from outside the export set',
]

const DOCS_NON_GOALS = [
  'Whether an overlap matters',
  'Whether consolidating a candidate would change anything',
  'What a query means',
  'Whether two page values are one page',
  'Whether a segment boundary is the right one',
  'Anything about rows it did not read',
  'Anything from outside the export set',
]

test('the README states the guarantee it is judged on, inside the section that carries it', async () => {
  // `readme.includes('cannot')` was the whole of this check, and the word
  // appears in the "A candidate is not a defect" section too -- so the entire
  // body of the limits section, all seven non-goals, could be replaced by one
  // line with the suite green. Every claim is now read out of the section it
  // belongs to, and every limit the code enforces has to be named there.
  const readme = await readFile(resolve(projectDirectory, 'README.md'), 'utf8')
  assert.ok(readme.includes('A candidate is not a defect'))
  assert.ok(readme.includes('never fail a run'))

  const limits = markdownSection(readme, '## Limits and non-goals')
  assert.ok(limits.includes('cannot'), 'the limits section must say what the tool cannot conclude')
  assert.ok(limits.includes('no network calls'), 'the limits section must rule out network access')
  for (const claim of README_NON_GOALS) {
    assert.ok(limits.includes(claim), `the limits section no longer says what it cannot conclude: ${claim}`)
  }
  for (const limit of Object.keys(DEFAULT_LIMITS)) {
    assert.ok(limits.includes(limit), `${limit} is enforced but the limits section does not name it`)
  }
  assert.ok(limits.includes(String(MAX_CONFIG_BYTES)), 'the configuration bound must be named with its value')

  const docs = await readFile(resolve(projectDirectory, 'docs/overlap-rules.md'), 'utf8')
  const cannot = markdownSection(docs, '## What this tool cannot conclude')
  for (const claim of DOCS_NON_GOALS) {
    assert.ok(cannot.includes(claim), `the rule catalog no longer says what it cannot conclude: ${claim}`)
  }
})

test('a row found wrong is a fail; a row this run never obtained is incomplete', async () => {
  // The README promised `incomplete` for both, and they are different answers:
  // one is evidence in hand that contradicts itself, the other is evidence the
  // run does not have. The code was right and the sentence was not.
  const inconsistent = [
    HEADER,
    'q a,/one,US,en-US,600,10,3.0',
    'q a,/two,US,en-US,400,10,4.0',
    'q b,/three,US,en-US,10,99,3.0',
    '',
  ].join('\n')

  await withRoot({ 'e.csv': inconsistent }, async (root) => {
    const { report, map } = await mapQueryPageExports({ root })
    assert.ok(ruleIds(report).includes('metrics-inconsistent'))
    assert.equal(report.status, 'fail')
    assert.equal(map.complete, true, 'the run read everything it was given')
    assert.equal(report.summary.rows, 2, 'the contradictory row is dropped from the grouping')
  })

  const bounded = [
    HEADER,
    'q a,/one,US,en-US,600,10,3.0',
    'q a,/two,US,en-US,400,10,4.0',
    'a very long query indeed,/three,US,en-US,100,4,3.0',
    '',
  ].join('\n')

  await withRoot({ 'e.csv': bounded }, async (root) => {
    const { report, map } = await mapQueryPageExports({ root, limits: { maxFieldChars: 12 } })
    assert.ok(ruleIds(report).includes('row-field-too-long'))
    assert.equal(report.status, 'incomplete')
    assert.equal(map.complete, false)
    assert.equal(report.summary.rows, 2)
  })
})

test('no fixture in the repository carries a secret or a personal detail', async () => {
  const files = [
    'examples/exports-clean/search-console-2026-02-gb.csv',
    'examples/exports-clean/search-console-2026-02-us.csv',
    'examples/exports-clean/search-console-2026-02-in.csv',
    'examples/exports-broken/search-console-2026-02-gb.csv',
    'examples/exports-broken/search-console-2026-02-us.csv',
  ]
  for (const path of files) {
    const text = await readFile(resolve(projectDirectory, path), 'utf8')
    for (const pattern of [/@[a-z0-9.-]+\.[a-z]{2,}/i, /\bsecret\b/i, /\btoken\b/i, /\bapi[-_ ]?key\b/i, /\bBearer\b/]) {
      assert.equal(pattern.test(text), false, `${path} matches ${pattern}`)
    }
  }
})
