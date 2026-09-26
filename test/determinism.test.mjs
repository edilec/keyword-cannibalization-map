import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { mapQueryPageExports } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/keyword-cannibalization-map.mjs')
const CLEAN_ROOT = join(projectDirectory, 'examples/exports-clean')
const BROKEN_ROOT = join(projectDirectory, 'examples/exports-broken')

const HEADER = 'query,page,region,locale,impressions,clicks,position'

async function cli(args) {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return stdout
  } catch (error) {
    return error.stdout
  }
}

async function withRoot(files, body) {
  const directory = await mkdtemp(join(tmpdir(), 'kcm-det-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(directory, name), content, 'utf8')
    }
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('two runs over identical inputs produce byte-identical stdout', async () => {
  for (const root of [CLEAN_ROOT, BROKEN_ROOT]) {
    const first = await cli(['--root', root, '--json'])
    const second = await cli(['--root', root, '--json'])
    assert.equal(first, second)
    assert.ok(first.length > 100)
  }
})

test('the derived map is byte-identical across runs', async () => {
  const first = await mapQueryPageExports({ root: CLEAN_ROOT })
  const second = await mapQueryPageExports({ root: CLEAN_ROOT })
  assert.equal(JSON.stringify(first.map), JSON.stringify(second.map))
})

test('findings are ordered by file, then line, then pointer', async () => {
  const { report } = await mapQueryPageExports({ root: BROKEN_ROOT })

  const keys = report.findings.map((finding) => [finding.location.file, finding.line ?? 0, finding.location.pointer])
  // Guard against the tautological version of this test: the fixture must span
  // more than one file and more than one line, or reversing a sort key would
  // leave the assertion below green.
  assert.ok(new Set(keys.map((key) => key[0])).size >= 2, 'the fixture must span at least two files')
  assert.ok(new Set(keys.map((key) => key[1])).size >= 3, 'the fixture must span at least three lines')

  assert.deepEqual(keys, [
    ['.', 0, '/candidates/cluster-0001'],
    ['search-console-2026-02-gb.csv', 3, '/rows/3'],
    ['search-console-2026-02-us.csv', 3, '/rows/3'],
    ['search-console-2026-02-us.csv', 4, '/rows/4'],
    ['search-console-2026-02-us.csv', 5, '/rows/5'],
    ['search-console-2026-02-us.csv', 6, '/rows/6'],
    ['search-console-2026-02-us.csv', 7, '/rows/7'],
    ['search-console-2026-02-us.csv', 8, '/rows/8'],
    ['search-console-2026-02-us.csv', 9, '/rows/9'],
  ])
})

test('row 12 sorts after row 3, which a pointer comparison alone would get wrong', async () => {
  const lines = [HEADER]
  for (let line = 2; line <= 14; line += 1) lines.push(`q ${line},/a,US,en-US,10,99,3.0`)
  lines.push('')

  await withRoot({ 'e.csv': lines.join('\n') }, async (root) => {
    const { report } = await mapQueryPageExports({ root })
    const rowLines = report.findings.filter((item) => item.ruleId === 'metrics-inconsistent').map((item) => item.line)
    assert.equal(rowLines.length, 13)
    assert.deepEqual(rowLines, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  })
})

test('the review queue is ordered by priority, not by the order rows were read', async () => {
  // The high-priority candidate lives in the alphabetically last file, on the
  // last lines of it. Any ordering that leaked the read order would put it last.
  const low = [HEADER, 'aa low,/one,US,en-US,1200,40,3.0', 'aa low,/two,US,en-US,90,2,9.0', ''].join('\n')
  const high = [HEADER, 'zz high,/three,US,en-US,1400,90,4.0', 'zz high,/four,US,en-US,900,40,7.8', ''].join('\n')

  await withRoot({ 'a-first.csv': low, 'z-last.csv': high }, async (root) => {
    const { map } = await mapQueryPageExports({ root })
    assert.equal(map.candidates.length, 2)
    assert.deepEqual(map.candidates.map((item) => item.intent), ['high zz', 'aa low'])
    assert.deepEqual(map.candidates.map((item) => item.priorityBand), ['high', 'low'])
    assert.deepEqual(map.candidates.map((item) => item.reviewRank), [1, 2])
  })
})

test('candidate ids follow the review order and sort the same way as their pointers', async () => {
  const { report, map } = await mapQueryPageExports({ root: CLEAN_ROOT })
  assert.deepEqual(map.candidates.map((item) => item.id), ['cluster-0001', 'cluster-0002', 'cluster-0003'])

  const pointers = report.findings
    .filter((finding) => finding.ruleId === 'cluster-review-candidate')
    .map((finding) => finding.location.pointer)
  assert.deepEqual(pointers, ['/candidates/cluster-0001', '/candidates/cluster-0002', '/candidates/cluster-0003'])
  assert.deepEqual(pointers.slice().sort(), pointers, 'the padded ids must sort in review order')
})

test('nothing in the shipped source consults a locale, a clock or a random source', async () => {
  // A lint, not the guarantee. Scanning for `.localeCompare(` catches the
  // obvious spelling and nothing else: a collator reached any other way
  // produces identical collation drift and different source text, so this test
  // stays green while the ordering becomes machine-dependent. What the ordering
  // actually rests on is the block of tests below, which push values whose
  // code-unit order and collation order disagree through the real report path
  // and assert the order that came out.
  for (const path of ['src/index.mjs', 'src/cluster.mjs', 'src/csv.mjs', 'bin/keyword-cannibalization-map.mjs']) {
    const source = await readFile(resolve(projectDirectory, path), 'utf8')
    // Matched as a call, so the prose explaining why localeCompare is banned
    // does not itself trip the check.
    assert.equal(/\.localeCompare\s*\(/.test(source), false, `${path} calls localeCompare`)
    assert.equal(/\.toLocale(Lower|Upper)Case\s*\(/.test(source), false, `${path} uses a locale-sensitive case fold`)
    assert.equal(/\bIntl\./.test(source), false, `${path} reaches for Intl`)
    assert.equal(/\bMath\.random\b/.test(source), false, `${path} uses Math.random`)
    assert.equal(/\bDate\.now\b/.test(source), false, `${path} reads the clock`)
    assert.equal(/\bnew Date\b/.test(source), false, `${path} reads the clock`)
  }
})

test('the export walk sorts its entries before it visits them', async () => {
  // Filesystem enumeration order is not a contract, and on this machine readdir
  // already returns names in code-unit order -- so no fixture can observe the
  // sort being DELETED. Replacing its comparator is observable, and the test
  // above ('the export walk visits entries in code-unit order') is what catches
  // that. This assertion covers the one mutation no input can reach.
  const source = await readFile(resolve(projectDirectory, 'src/index.mjs'), 'utf8')
  assert.match(source, /entries\.sort\(\(left, right\) => byCodeUnit\(left\.name, right\.name\)\)/)
})

test('which export is read when maxExports bites does not depend on creation order', async () => {
  // Written z first, a second. The bounded run must read a.csv and name z.csv
  // as the file it did not read.
  const directory = await mkdtemp(join(tmpdir(), 'kcm-order-'))
  try {
    await writeFile(join(directory, 'z-later.csv'), [HEADER, 'zed q,/z,US,en-US,900,10,3.0', ''].join('\n'), 'utf8')
    await writeFile(join(directory, 'a-earlier.csv'), [HEADER, 'ay q,/a,US,en-US,800,10,3.0', ''].join('\n'), 'utf8')

    const { report } = await mapQueryPageExports({ root: directory, limits: { maxExports: 1 } })
    const bounded = report.findings.find((finding) => finding.ruleId === 'too-many-exports')
    assert.ok(bounded)
    assert.ok(bounded.message.includes('z-later.csv'), 'the later-sorting file is the one left unread')
    assert.equal(bounded.message.includes('a-earlier.csv'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the tool makes no network call of any kind', async () => {
  for (const path of ['src/index.mjs', 'src/cluster.mjs', 'src/csv.mjs', 'bin/keyword-cannibalization-map.mjs']) {
    const source = await readFile(resolve(projectDirectory, path), 'utf8')
    for (const forbidden of ['node:http', 'node:https', 'node:net', 'node:dns', 'fetch(', 'XMLHttpRequest']) {
      assert.equal(source.includes(forbidden), false, `${path} refers to ${forbidden}`)
    }
  }
})

test('the package declares no dependency of any kind', async () => {
  const manifest = JSON.parse(await readFile(resolve(projectDirectory, 'package.json'), 'utf8'))
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(Object.hasOwn(manifest, field), false, `package.json declares ${field}`)
  }
  assert.equal(manifest.engines.node, '>=22')
})

/**
 * Ordering, pinned by what the tool emits.
 *
 * Every fixture below is built from values whose code-unit order and collation
 * order genuinely disagree: 'Z' before 'a', 'a-b' before 'a_b', 'zebra' before
 * the accented word, '/Z' before '/a'. Substituting any locale collator for
 * `byCodeUnit` -- however it is spelled -- changes one of the arrays asserted
 * here, which is the difference between a source scan and a guarantee.
 */
const ACUTE_E = String.fromCodePoint(0xe9)
const ECLAIR = `${ACUTE_E}clair`

/** One candidate, plus one row whose metrics contradict each other. */
const withBadRow = (query) => [
  HEADER,
  `${query},/one,US,en-US,600,10,3.0`,
  `${query},/two,US,en-US,400,10,4.0`,
  `${query},/three,US,en-US,10,99,5.0`,
  '',
].join('\n')

test('findings are ordered by file name by code unit, where collation disagrees', async () => {
  // Collation orders these a-b, a_b, a-second, Z-first -- and on a Node build
  // with different ICU data, differently again.
  await withRoot(
    {
      'Z-first.csv': withBadRow('zed q'),
      'a-second.csv': withBadRow('ay q'),
      'a-b.csv': withBadRow('hyphen q'),
      'a_b.csv': withBadRow('underscore q'),
    },
    async (root) => {
      const { report } = await mapQueryPageExports({ root })
      assert.deepEqual(
        report.findings.map((finding) => finding.location.file),
        ['.', '.', '.', '.', 'Z-first.csv', 'a-b.csv', 'a-second.csv', 'a_b.csv'],
      )
    },
  )
})

test('two findings on one line break their tie on the message, by code unit', async () => {
  await withRoot({ 'e.csv': ['query,page,impressions,clicks', 'q a,/one,600,10', ''].join('\n') }, async (root) => {
    const { report } = await mapQueryPageExports({ root, segmentColumns: ['zone', `${ACUTE_E}cole`] })
    const missing = report.findings.filter((finding) => finding.ruleId === 'header-column-missing')
    assert.equal(missing.length, 2, 'both declared segment columns must be reported missing')
    assert.deepEqual(
      missing.map((finding) => finding.message.match(/"([^"]+)"/)[1]),
      ['zone', `${ACUTE_E}cole`],
      'collation would put the accented column first',
    )
  })
})

test('the export walk visits entries in code-unit order, so the bounded-out file is the collated first one', async () => {
  const pair = (query, first, second) => [
    HEADER,
    `${query},${first},US,en-US,600,10,3.0`,
    `${query},${second},US,en-US,400,10,4.0`,
    '',
  ].join('\n')

  await withRoot(
    { 'Z-one.csv': pair('zed q', '/z1', '/z2'), 'a-two.csv': pair('ay q', '/a1', '/a2') },
    async (root) => {
      const { report, map } = await mapQueryPageExports({ root, limits: { maxExports: 1 } })
      const bounded = report.findings.find((finding) => finding.ruleId === 'too-many-exports')
      assert.ok(bounded)
      assert.ok(bounded.message.includes('a-two.csv'), 'a-two.csv sorts last by code unit and is the file left unread')
      assert.equal(bounded.message.includes('Z-one.csv'), false)
      assert.equal(map.candidates.length, 1)
      assert.deepEqual([...new Set(map.candidates[0].rows.map((row) => row.file))], ['Z-one.csv'])
    },
  )
})

test('a candidate orders its queries, pages and rows by code unit', async () => {
  const rows = [
    HEADER,
    'Zeta alpha,/Z,US,en-US,300,5,3.0',
    'alpha Zeta,/Z,US,en-US,300,5,4.0',
    'Zeta alpha,/a,US,en-US,600,10,5.0',
    '',
  ].join('\n')

  await withRoot({ 'e.csv': rows }, async (root) => {
    const { map } = await mapQueryPageExports({ root })
    const candidate = map.candidates[0]
    assert.ok(candidate, 'the fixture must produce a candidate')
    assert.deepEqual(candidate.queries, ['Zeta alpha', 'alpha Zeta'])
    // The two pages hold the same impressions, so only the string comparison
    // decides which is listed first.
    assert.deepEqual(candidate.pages.map((page) => page.page), ['/Z', '/a'])
    assert.deepEqual(
      candidate.rows.map((row) => `${row.page} ${row.query}`),
      ['/Z Zeta alpha', '/Z alpha Zeta', '/a Zeta alpha'],
    )
  })
})

test('supporting rows break their last tie on the file name, by code unit', async () => {
  const rows = [HEADER, 'q a,/one,US,en-US,600,10,3.0', 'q a,/two,US,en-US,400,10,4.0', ''].join('\n')
  await withRoot({ 'Z.csv': rows, 'a.csv': rows }, async (root) => {
    const { map } = await mapQueryPageExports({ root })
    assert.deepEqual(
      map.candidates[0].rows.map((row) => `${row.page} ${row.file}`),
      ['/one Z.csv', '/one a.csv', '/two Z.csv', '/two a.csv'],
    )
  })
})

test('the intent key orders its tokens by code unit', async () => {
  const rows = [
    HEADER,
    `zebra ${ECLAIR},/one,US,en-US,600,10,3.0`,
    `zebra ${ECLAIR},/two,US,en-US,400,10,4.0`,
    '',
  ].join('\n')

  await withRoot({ 'e.csv': rows }, async (root) => {
    const { map } = await mapQueryPageExports({ root })
    // Collation sorts the accented word first; code unit does not.
    assert.equal(map.candidates[0].intent, `zebra ${ECLAIR}`)
  })
})

test('segments are listed in code-unit order', async () => {
  const rows = [
    HEADER,
    'q a,/one,Z,en-US,600,10,3.0',
    'q a,/two,a,en-US,400,10,4.0',
    '',
  ].join('\n')

  await withRoot({ 'e.csv': rows }, async (root) => {
    const { map } = await mapQueryPageExports({ root })
    assert.deepEqual(map.segments.map((segment) => segment.segment.region), ['Z', 'a'])
  })
})

test('the review queue breaks a tie on segment, then on intent, by code unit', async () => {
  const segments = [
    HEADER,
    'q one,/one,Z,en-US,600,10,3.0',
    'q one,/two,Z,en-US,400,10,4.0',
    'q one,/one,a,en-US,600,10,3.0',
    'q one,/two,a,en-US,400,10,4.0',
    '',
  ].join('\n')

  await withRoot({ 'e.csv': segments }, async (root) => {
    const { map } = await mapQueryPageExports({ root })
    assert.equal(map.candidates.length, 2)
    assert.deepEqual(map.candidates.map((candidate) => candidate.priorityScore), [400, 400], 'the tie must be real')
    assert.deepEqual(map.candidates.map((candidate) => candidate.segment.region), ['Z', 'a'])
  })

  const intents = [
    HEADER,
    'zebra,/one,US,en-US,600,10,3.0',
    'zebra,/two,US,en-US,400,10,4.0',
    `${ECLAIR},/three,US,en-US,600,10,3.0`,
    `${ECLAIR},/four,US,en-US,400,10,4.0`,
    '',
  ].join('\n')

  await withRoot({ 'e.csv': intents }, async (root) => {
    const { map } = await mapQueryPageExports({ root })
    assert.deepEqual(map.candidates.map((candidate) => candidate.priorityScore), [400, 400], 'the tie must be real')
    assert.deepEqual(map.candidates.map((candidate) => candidate.intent), ['zebra', ECLAIR])
  })
})

test('separated intents and the segments they name are ordered by code unit', async () => {
  const rows = [
    HEADER,
    'zebra,/one,Z,en-US,400,20,5.5',
    'zebra,/two,a,en-US,350,18,6.1',
    `${ECLAIR},/three,Z,en-US,400,20,5.5`,
    `${ECLAIR},/four,a,en-US,350,18,6.1`,
    '',
  ].join('\n')

  await withRoot({ 'e.csv': rows }, async (root) => {
    const { map } = await mapQueryPageExports({ root })
    assert.equal(map.separatedIntents.length, 2)
    assert.deepEqual(
      map.separatedIntents.map((item) => item.pooledImpressions),
      [750, 750],
      'the tie must be real, or the intent comparison never runs',
    )
    assert.deepEqual(map.separatedIntents.map((item) => item.intent), ['zebra', ECLAIR])
    for (const item of map.separatedIntents) {
      assert.deepEqual(item.segments.map((segment) => segment.segment.region), ['Z', 'a'])
    }
  })
})

test('page spelling variants are ordered by code unit, inside a group and across groups', async () => {
  const rows = [
    HEADER,
    'q a,/Z#m,US,en-US,300,5,3.0',
    'q a,/Z#n,US,en-US,300,5,3.0',
    'q a,/p#Z,US,en-US,300,5,3.0',
    'q a,/p#a,US,en-US,300,5,3.0',
    '',
  ].join('\n')

  await withRoot({ 'e.csv': rows }, async (root) => {
    const { report } = await mapQueryPageExports({ root })
    const variants = report.findings.filter((finding) => finding.ruleId === 'page-spelling-variant')
    // Two groups: collation puts /p before /Z, and /p#a before /p#Z.
    assert.deepEqual(variants.map((finding) => finding.evidence), [
      'spellings: /Z#m , /Z#n',
      'spellings: /p#Z , /p#a',
    ])
  })
})

test('the map lists its column roles in code-unit order', async () => {
  // The role names decide the key order of `map.columns`, and that order is
  // part of the byte-identical map artifact rather than an accident of how the
  // defaults happen to be declared.
  const { map } = await mapQueryPageExports({ root: CLEAN_ROOT })
  assert.deepEqual(Object.keys(map.columns), ['clicks', 'impressions', 'page', 'position', 'query'])
})

/**
 * Four comparator sites have no fixture here, and that is a finding rather than
 * an omission.
 *
 * The `pointer` and `ruleId` keys of the findings sort, and the column-role
 * sort, compare strings from closed vocabularies this tool writes itself: rule
 * ids, `/`-rooted pointers, and five role names. Every pair in each of those
 * vocabularies orders identically by code unit and by collation, so no input
 * can distinguish a collator from `byCodeUnit` at those three sites -- the
 * mutant is equivalent, and a test asserting otherwise would be asserting
 * nothing. The fourth is the sort at the end of `buildIntentGroups`: everything
 * downstream of it (`compareCandidates`, the separated-intent sort, the
 * findings sort) re-orders by a total order, so the group array's own order
 * never reaches the report.
 *
 * All four sorts stay. They keep those arrays independent of Map insertion
 * order, which is a property worth having even where no fixture can see it.
 */
