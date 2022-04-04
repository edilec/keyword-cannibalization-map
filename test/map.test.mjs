import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_LIMITS,
  MAX_CONFIG_BYTES,
  formatReport,
  isInside,
  loadConfigFile,
  mapQueryPageExports,
  resolveMapDestination,
  severityFor,
  validateColumns,
  validateLimits,
  validateMatch,
  validateSegmentColumns,
  validateThresholds,
  writeMapFile,
} from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLEAN_ROOT = join(projectDirectory, 'examples/exports-clean')
const BROKEN_ROOT = join(projectDirectory, 'examples/exports-broken')

const HEADER = 'query,page,region,locale,impressions,clicks,position'

async function withRoot(files, body) {
  const directory = await mkdtemp(join(tmpdir(), 'kcm-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(directory, name)
      await mkdir(dirname(target), { recursive: true })
      if (typeof content === 'string') await writeFile(target, content, 'utf8')
      else await writeFile(target, content)
    }
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const ruleIds = (report) => report.findings.map((finding) => finding.ruleId)
const findingsFor = (report, ruleId) => report.findings.filter((finding) => finding.ruleId === ruleId)

test('a clean export set passes and every candidate carries its source rows', async () => {
  const { report, map } = await mapQueryPageExports({ root: CLEAN_ROOT })

  assert.equal(report.status, 'pass')
  assert.equal(report.tool, 'keyword-cannibalization-map')
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.rows, 12)
  assert.equal(report.summary.exportsRead, 3)
  assert.equal(map.counts.candidates, 3)

  // The acceptance requirement: a genuine overlap candidate has source rows,
  // and those rows are the ones the numbers were computed from.
  for (const candidate of map.candidates) {
    assert.ok(candidate.rows.length > 0, `${candidate.id} carries no supporting row`)
    assert.equal(candidate.rows.length, candidate.supportingRowCount)
    assert.equal(candidate.rowsTruncated, false)
    assert.equal(
      candidate.rows.reduce((total, row) => total + row.impressions, 0),
      candidate.impressions,
    )
    assert.equal(
      candidate.rows.reduce((total, row) => total + row.clicks, 0),
      candidate.clicks,
    )
    for (const row of candidate.rows) {
      assert.equal(typeof row.file, 'string')
      assert.ok(row.line >= 2, 'a supporting row must point past the header')
      assert.ok(row.query.length > 0)
      assert.ok(row.page.length > 0)
    }
  }
})

test('a supporting row can be found verbatim in the export it names', async () => {
  const { map } = await mapQueryPageExports({ root: CLEAN_ROOT })
  const candidate = map.candidates[0]
  const row = candidate.rows[0]

  const text = await readFile(join(CLEAN_ROOT, row.file), 'utf8')
  const line = text.split('\n')[row.line - 1]
  assert.ok(line.includes(row.query), `line ${row.line} of ${row.file} does not hold the query`)
  assert.ok(line.includes(row.page), `line ${row.line} of ${row.file} does not hold the page`)
  assert.ok(line.includes(String(row.impressions)))
})

test('overlap alone never fails a run', async () => {
  const { report, map } = await mapQueryPageExports({ root: CLEAN_ROOT })
  assert.ok(map.counts.candidates > 0, 'the fixture must actually produce candidates')
  assert.equal(report.status, 'pass')
  for (const finding of findingsFor(report, 'cluster-review-candidate')) {
    assert.equal(finding.severity, 'info')
  }
  assert.equal(severityFor('cluster-review-candidate'), 'info')
})

test('a candidate whose lead page holds nearly everything is low priority, not absent', async () => {
  const { map } = await mapQueryPageExports({ root: CLEAN_ROOT })
  const bands = map.candidates.map((candidate) => candidate.priorityBand)
  assert.deepEqual(bands, ['high', 'medium', 'low'])

  const low = map.candidates[2]
  assert.ok(low.leadPageShareBasisPoints > 9000, 'the low-priority fixture should be page-dominated')
  assert.equal(low.contributingPages, 2)
  assert.ok(low.rows.length > 0)
})

test('regional intent is separable: the same query in two regions is not one candidate', async () => {
  const rows = [
    `${HEADER}`,
    'solar battery storage,/uk/solar-battery,GB,en-GB,400,20,5.5',
    'solar battery storage,/us/solar-battery,US,en-US,350,18,6.1',
    '',
  ].join('\n')

  await withRoot({ 'export.csv': rows }, async (root) => {
    const segmented = await mapQueryPageExports({ root })
    assert.equal(segmented.map.counts.candidates, 0)
    assert.equal(segmented.map.counts.separatedIntents, 1)
    assert.equal(segmented.report.status, 'pass')
    assert.equal(findingsFor(segmented.report, 'cross-segment-intent-not-merged').length, 1)

    // The same rows pooled into one segment do produce a candidate, which is
    // what makes the separation a real decision rather than a coincidence of
    // the fixture.
    const pooled = await mapQueryPageExports({ root, segmentColumns: [] })
    assert.equal(pooled.map.counts.candidates, 1)
    assert.equal(pooled.map.counts.separatedIntents, 0)
    assert.equal(pooled.map.candidates[0].rows.length, 2)
  })
})

test('a separated intent names every segment it was split across', async () => {
  const { map } = await mapQueryPageExports({ root: CLEAN_ROOT })
  const separated = map.separatedIntents.find((item) => item.intent === 'battery solar storage')
  assert.ok(separated, 'the fixture must hold a cross-region intent')
  assert.deepEqual(separated.segments.map((item) => item.segment.region), ['GB', 'US'])
  assert.deepEqual(separated.segments.map((item) => item.qualifies), [false, false])
  assert.equal(separated.pooledImpressions, 750)
})

test('the broken export set fails on data integrity and still reports its candidate', async () => {
  const { report, map } = await mapQueryPageExports({ root: BROKEN_ROOT })

  assert.equal(report.status, 'fail')
  assert.deepEqual(
    [...new Set(report.findings.filter((item) => item.severity === 'error').map((item) => item.ruleId))].sort(),
    ['metrics-inconsistent', 'page-missing', 'query-missing', 'row-column-count-mismatch', 'row-metric-invalid'],
  )
  assert.deepEqual(
    [...new Set(report.findings.filter((item) => item.severity === 'warning').map((item) => item.ruleId))].sort(),
    ['position-invalid', 'row-duplicate'],
  )
  assert.equal(map.counts.candidates, 1)
  assert.ok(map.candidates[0].rows.length > 0)
})

test('an invalid row contributes no number to any candidate', async () => {
  const good = [HEADER, 'q a,/one,US,en-US,600,10,3.0', 'q a,/two,US,en-US,400,10,4.0', ''].join('\n')
  const withBad = [
    HEADER,
    'q a,/one,US,en-US,600,10,3.0',
    'q a,/two,US,en-US,400,10,4.0',
    'q a,/three,US,en-US,"9,000",10,4.0',
    '',
  ].join('\n')

  const first = await withRoot({ 'e.csv': good }, (root) => mapQueryPageExports({ root }))
  const second = await withRoot({ 'e.csv': withBad }, (root) => mapQueryPageExports({ root }))

  assert.equal(first.map.candidates[0].impressions, 1000)
  assert.equal(second.map.candidates[0].impressions, 1000)
  assert.equal(second.map.candidates[0].pages.length, 2)
  assert.equal(second.report.status, 'fail')
})

test('a run that parsed no row is incomplete, never a pass', async () => {
  await withRoot({ 'notes.txt': 'not an export' }, async (root) => {
    const { report, map } = await mapQueryPageExports({ root })
    assert.equal(report.status, 'incomplete')
    assert.equal(map.complete, false)
    assert.equal(report.summary.checked, 0)
    assert.deepEqual(ruleIds(report), ['no-rows-parsed'])
    assert.equal(severityFor('no-rows-parsed'), 'warning')
  })
})

test('rows that were read but reached no threshold is a complete answer', async () => {
  const rows = [HEADER, 'a query,/only-page,US,en-US,900,40,3.0', ''].join('\n')
  await withRoot({ 'e.csv': rows }, async (root) => {
    const { report, map } = await mapQueryPageExports({ root })
    assert.equal(report.status, 'pass')
    assert.equal(map.complete, true)
    assert.equal(report.summary.checked, 1)
    assert.deepEqual(ruleIds(report), ['no-candidates-found'])
  })
})

test('an export that is not UTF-8 is incomplete, and its rows are never guessed at', async () => {
  const bytes = new Uint8Array([...new TextEncoder().encode(`${HEADER}\nq,`), 0xff, 0xfe, 0x0a])
  await withRoot({ 'bad.csv': bytes }, async (root) => {
    const { report } = await mapQueryPageExports({ root })
    assert.equal(report.status, 'incomplete')
    assert.ok(ruleIds(report).includes('export-not-utf8'))
    assert.equal(report.summary.rows, 0)
    assert.equal(report.summary.exportsRead, 0)
  })
})

test('a missing required column stops the file rather than shifting its values', async () => {
  const rows = ['query,page,region,locale,impressions', 'q,/a,US,en-US,100', ''].join('\n')
  await withRoot({ 'e.csv': rows }, async (root) => {
    const { report } = await mapQueryPageExports({ root })
    assert.equal(report.status, 'incomplete')
    assert.ok(ruleIds(report).includes('header-column-missing'))
    assert.equal(report.summary.rows, 0)
  })
})

test('a declared segment column that is absent is a missing column, not a blank segment', async () => {
  const rows = ['query,page,impressions,clicks', 'q,/a,100,4', ''].join('\n')
  await withRoot({ 'e.csv': rows }, async (root) => {
    const segmented = await mapQueryPageExports({ root })
    assert.equal(segmented.report.status, 'incomplete')
    assert.equal(findingsFor(segmented.report, 'header-column-missing').length, 2)

    const asserted = await mapQueryPageExports({ root, segmentColumns: [] })
    assert.equal(asserted.report.status, 'pass')
    assert.equal(asserted.report.summary.rows, 1)
  })
})

test('a duplicated column is refused rather than silently resolved', async () => {
  const rows = ['query,page,page,region,locale,impressions,clicks', 'q,/a,/b,US,en-US,100,4', ''].join('\n')
  await withRoot({ 'e.csv': rows }, async (root) => {
    const { report } = await mapQueryPageExports({ root })
    assert.equal(report.status, 'incomplete')
    assert.ok(ruleIds(report).includes('header-column-duplicate'))
  })
})

test('an export with no header at all is incomplete', async () => {
  await withRoot({ 'e.csv': '   \n\n' }, async (root) => {
    const { report } = await mapQueryPageExports({ root })
    assert.equal(report.status, 'incomplete')
    assert.ok(ruleIds(report).includes('header-missing'))
  })
})

test('an unterminated quoted field is refused rather than absorbed', async () => {
  const rows = [HEADER, '"never closed,/a,US,en-US,100,4,3.0', ''].join('\n')
  await withRoot({ 'e.csv': rows }, async (root) => {
    const { report } = await mapQueryPageExports({ root })
    assert.equal(report.status, 'incomplete')
    assert.ok(ruleIds(report).includes('unterminated-quoted-field'))
  })
})

test('an export holding a header and no rows is reported but does not stop the run', async () => {
  const good = [HEADER, 'q a,/one,US,en-US,600,10,3.0', 'q a,/two,US,en-US,400,10,4.0', ''].join('\n')
  await withRoot({ 'a-empty.csv': `${HEADER}\n`, 'b-full.csv': good }, async (root) => {
    const { report, map } = await mapQueryPageExports({ root })
    assert.equal(report.status, 'pass')
    assert.ok(ruleIds(report).includes('export-empty'))
    assert.equal(map.counts.candidates, 1)
  })
})

test('every documented limit is enforced and reported by name', async () => {
  const rows = [HEADER, 'q a,/one,US,en-US,600,10,3.0', 'q a,/two,US,en-US,400,10,4.0', ''].join('\n')

  const longQuery = 'solar panel installation cost estimate guide'
  const longRows = [HEADER, `${longQuery},/one,US,en-US,600,10,3.0`, 'q a,/two,US,en-US,400,10,4.0', ''].join('\n')
  const twoIntents = [
    HEADER,
    'alpha query,/one,US,en-US,600,10,3.0',
    'alpha query,/two,US,en-US,400,10,4.0',
    'beta query,/three,US,en-US,600,10,3.0',
    'beta query,/four,US,en-US,400,10,4.0',
    '',
  ].join('\n')

  const cases = [
    { files: { 'e.csv': rows }, limits: { maxExportBytes: 10 }, ruleId: 'export-too-large' },
    { files: { 'e.csv': rows }, limits: { maxRows: 2 }, ruleId: 'too-many-rows' },
    { files: { 'e.csv': longRows }, limits: { maxFieldChars: 20 }, ruleId: 'row-field-too-long' },
    { files: { 'e.csv': rows }, limits: { maxFieldChars: 3 }, ruleId: 'row-field-too-long' },
    { files: { 'a.csv': rows, 'b.csv': rows }, limits: { maxExports: 1 }, ruleId: 'too-many-exports' },
    { files: { 'deep/deeper/e.csv': rows }, limits: { maxDepth: 1 }, ruleId: 'directory-too-deep' },
    { files: { 'e.csv': twoIntents }, limits: { maxIntentGroups: 1 }, ruleId: 'too-many-intent-groups' },
    { files: { 'e.csv': rows }, limits: { maxClusterRows: 1 }, ruleId: 'cluster-rows-exceeded' },
  ]

  for (const item of cases) {
    const report = await withRoot(item.files, async (root) =>
      (await mapQueryPageExports({ root, limits: item.limits })).report)
    assert.ok(ruleIds(report).includes(item.ruleId), `${item.ruleId} was not reported`)
    assert.equal(report.status, 'incomplete', `${item.ruleId} did not make the run incomplete`)
  }
})

test('a column name bounded out by maxFieldChars stops the file instead of resolving the wrong columns', async () => {
  const rows = [HEADER, 'q a,/one,US,en-US,600,10,3.0', ''].join('\n')
  await withRoot({ 'e.csv': rows }, async (root) => {
    const { report } = await mapQueryPageExports({ root, limits: { maxFieldChars: 3 } })
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(ruleIds(report), ['no-rows-parsed', 'row-field-too-long'])
    assert.equal(report.findings[1].location.pointer, '/header')
    assert.equal(report.findings[1].location.file, 'e.csv')
  })
})

test('maxIntentGroups refuses a partial queue rather than showing part of one', async () => {
  const rows = [
    HEADER,
    'alpha query,/one,US,en-US,600,10,3.0',
    'alpha query,/two,US,en-US,400,10,4.0',
    'beta query,/three,US,en-US,600,10,3.0',
    'beta query,/four,US,en-US,400,10,4.0',
    '',
  ].join('\n')

  await withRoot({ 'e.csv': rows }, async (root) => {
    const within = await mapQueryPageExports({ root })
    assert.equal(within.map.counts.candidates, 2)

    const bounded = await mapQueryPageExports({ root, limits: { maxIntentGroups: 1 } })
    assert.equal(bounded.report.status, 'incomplete')
    assert.ok(ruleIds(bounded.report).includes('too-many-intent-groups'))
    assert.equal(bounded.map.counts.candidates, 0)
    assert.deepEqual(bounded.map.candidates, [])
  })
})

test('a candidate with more rows than maxClusterRows says so instead of trimming quietly', async () => {
  const lines = [HEADER]
  for (let index = 0; index < 6; index += 1) {
    lines.push(`q a,/page-${index % 2},US,en-US,${100 + index},1,3.0`)
  }
  lines.push('')

  await withRoot({ 'e.csv': lines.join('\n') }, async (root) => {
    const { report, map } = await mapQueryPageExports({ root, limits: { maxClusterRows: 2 } })
    assert.equal(report.status, 'incomplete')
    assert.equal(map.candidates[0].rowsTruncated, true)
    assert.equal(map.candidates[0].rows.length, 2)
    assert.equal(map.candidates[0].supportingRowCount, 6)
  })
})

test('a symlink out of the root is refused unread', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'kcm-outside-'))
  try {
    const secret = join(outside, 'elsewhere.csv')
    await writeFile(secret, `${HEADER}\nsecret query,/secret,US,en-US,900,40,3.0\n`, 'utf8')

    await withRoot({ 'inside.csv': `${HEADER}\nq a,/one,US,en-US,600,10,3.0\nq a,/two,US,en-US,400,10,4.0\n` }, async (root) => {
      await symlink(secret, join(root, 'escape.csv'))
      const { report, map } = await mapQueryPageExports({ root })

      assert.ok(ruleIds(report).includes('path-escapes-root'))
      const serialized = JSON.stringify({ report, map })
      assert.equal(serialized.includes('secret query'), false, 'out-of-root content reached the output')
      assert.equal(serialized.includes('/secret'), false)
      assert.equal(report.summary.exportsFound, 1)
    })
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test('a file genuinely inside a symlinked root is read, not refused', async () => {
  // The over-correction of the previous test: comparing a realpath'd root with
  // an unresolved target refuses files that are really inside the tree.
  const real = await mkdtemp(join(tmpdir(), 'kcm-real-'))
  const linkHome = await mkdtemp(join(tmpdir(), 'kcm-link-'))
  try {
    await writeFile(
      join(real, 'e.csv'),
      `${HEADER}\nq a,/one,US,en-US,600,10,3.0\nq a,/two,US,en-US,400,10,4.0\n`,
      'utf8',
    )
    const linked = join(linkHome, 'root-link')
    await symlink(real, linked)

    const { report, map } = await mapQueryPageExports({ root: linked })
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.rows, 2)
    assert.equal(map.counts.candidates, 1)
    assert.equal(ruleIds(report).includes('path-escapes-root'), false)
  } finally {
    await rm(real, { recursive: true, force: true })
    await rm(linkHome, { recursive: true, force: true })
  }
})

test('isInside compares whole path segments', () => {
  assert.equal(isInside('/root', '/root'), true)
  assert.equal(isInside('/root', '/root/a/b.csv'), true)
  assert.equal(isInside('/root', '/rootless/a.csv'), false)
  assert.equal(isInside('/root/', '/root/a.csv'), true)
})

test('every untrusted string reaching output is flattened to one line', async () => {
  const NEWLINE = String.fromCharCode(10)
  const forgedQuery = `solar${NEWLINE}ERROR   forged query line`
  const forgedPage = `/one${NEWLINE}ERROR   forged page line`
  const forgedName = `we${NEWLINE}ird.csv`
  const rows = [
    HEADER,
    `"${forgedQuery}","${forgedPage}",US,en-US,600,10,3.0`,
    `"${forgedQuery}",/two,US,en-US,400,10,4.0`,
    '',
  ].join(NEWLINE)

  await withRoot({ 'e.csv': rows, [forgedName]: '  ' }, async (root) => {
    const { report, map } = await mapQueryPageExports({ root })

    // The file name itself is untrusted: it reaches location.file.
    for (const finding of report.findings) {
      for (const value of [
        finding.message,
        finding.evidence ?? '',
        finding.suggestion ?? '',
        finding.location.file,
        finding.location.pointer,
      ]) {
        assert.equal(value.includes(NEWLINE), false, `a finding value carried a newline: ${value}`)
      }
    }
    assert.ok(
      report.findings.some((finding) => finding.location.file.includes('ird.csv')),
      'the fixture must produce a finding against the awkwardly named file',
    )

    const candidate = map.candidates[0]
    assert.ok(candidate, 'the forged query must still form a candidate')
    for (const row of candidate.rows) {
      assert.equal(row.query.includes(NEWLINE), false)
      assert.equal(row.page.includes(NEWLINE), false)
    }
    for (const query of candidate.queries) assert.equal(query.includes(NEWLINE), false)
    for (const page of candidate.pages) assert.equal(page.page.includes(NEWLINE), false)
    assert.equal(candidate.intent.includes(NEWLINE), false)
    assert.equal(candidate.segmentLabel.includes(NEWLINE), false)

    // The end-to-end property: the human report has exactly one line per
    // finding plus its three summary lines. A forged line would add one.
    const lines = formatReport(report).trimEnd().split(NEWLINE)
    assert.equal(lines.length, report.findings.length + 3)
  })

  // A message -- not only an evidence excerpt -- can carry an untrusted path.
  await withRoot({ 'e.csv': rows, [forgedName]: rows }, async (root) => {
    const { report } = await mapQueryPageExports({ root, limits: { maxExports: 1 } })
    const bounded = report.findings.find((finding) => finding.ruleId === 'too-many-exports')
    assert.ok(bounded, 'the fixture must exceed maxExports')
    assert.ok(bounded.message.includes('ird.csv'), 'the message should name the first unread export')
    assert.equal(bounded.message.includes(NEWLINE), false)
    assert.equal(formatReport(report).trimEnd().split(NEWLINE).length, report.findings.length + 3)
  })
})

test('unknown options, limits, thresholds, columns and match modes are refused', async () => {
  await assert.rejects(() => mapQueryPageExports({ root: CLEAN_ROOT, roots: CLEAN_ROOT }), TypeError)
  await assert.rejects(() => mapQueryPageExports({ root: CLEAN_ROOT, limits: { maxExport: 2 } }), TypeError)
  await assert.rejects(() => mapQueryPageExports({ root: CLEAN_ROOT, thresholds: { minPage: 2 } }), TypeError)
  await assert.rejects(() => mapQueryPageExports({ root: CLEAN_ROOT, columns: { queries: 'q' } }), TypeError)
  await assert.rejects(() => mapQueryPageExports({ root: CLEAN_ROOT, match: 'fuzzy' }), TypeError)
  await assert.rejects(() => mapQueryPageExports({ root: '' }), TypeError)
  await assert.rejects(() => mapQueryPageExports({ root: join(CLEAN_ROOT, 'nope') }), TypeError)
})

test('validators refuse values that would make a threshold meaningless', () => {
  assert.throws(() => validateThresholds({ minPages: 1 }), TypeError)
  assert.throws(() => validateThresholds({ minImpressions: 0 }), TypeError)
  assert.throws(() => validateThresholds({ minPageShareBasisPoints: 0 }), TypeError)
  assert.throws(() => validateThresholds({ minPageShareBasisPoints: 10001 }), TypeError)
  assert.throws(() => validateThresholds({ highPriorityScore: 10, mediumPriorityScore: 20 }), TypeError)
  assert.throws(() => validateThresholds({ minPages: 2.5 }), TypeError)
  assert.deepEqual(validateThresholds({ minPages: 3 }).minPages, 3)

  assert.throws(() => validateLimits({ maxRows: 0 }), TypeError)
  assert.throws(() => validateLimits({ maxRows: 1.5 }), TypeError)
  assert.equal(validateLimits().maxRows, DEFAULT_LIMITS.maxRows)

  assert.throws(() => validateColumns({ query: '' }), TypeError)
  assert.throws(() => validateColumns({ query: 'page' }), TypeError)
  assert.equal(validateColumns({ query: '  Search  Term ' }).query, 'search term')

  assert.throws(() => validateSegmentColumns('region'), TypeError)
  assert.throws(() => validateSegmentColumns(['a', 'b', 'c', 'd', 'e']), TypeError)
  assert.throws(() => validateSegmentColumns(['region', 'REGION']), TypeError)
  assert.deepEqual(validateSegmentColumns([]), [])

  assert.equal(validateMatch(undefined), 'tokens')
  assert.throws(() => validateMatch('Tokens'), TypeError)
})

test('severityFor throws on a rule it does not know', () => {
  assert.throws(() => severityFor('invented-rule'), /No severity is defined/)
  assert.throws(() => severityFor(undefined), /No severity is defined/)
  assert.equal(severityFor('metrics-inconsistent'), 'error')
})

test('a configuration file is bounded, decoded strictly and rejected key by key', async () => {
  await withRoot(
    {
      'good.json': JSON.stringify({ thresholds: { minPages: 3 } }),
      'typo.json': JSON.stringify({ threshold: { minPages: 3 } }),
      'nested-typo.json': JSON.stringify({ thresholds: { minPagess: 3 } }),
      'notobject.json': JSON.stringify([1, 2]),
      'broken.json': '{ "thresholds": ',
      'bom.json': `${String.fromCharCode(0xfeff)}{"match":"exact"}`,
      'big.json': `{"match":"exact","_":"${'x'.repeat(MAX_CONFIG_BYTES)}"}`,
      'bad-bytes.json': new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    },
    async (root) => {
      assert.deepEqual(await loadConfigFile(join(root, 'good.json')), { thresholds: { minPages: 3 } })
      assert.deepEqual(await loadConfigFile(join(root, 'bom.json')), { match: 'exact' })

      await assert.rejects(() => loadConfigFile(join(root, 'typo.json')), /Unknown configuration key/)
      await assert.rejects(() => loadConfigFile(join(root, 'notobject.json')), /must contain a JSON object/)
      await assert.rejects(() => loadConfigFile(join(root, 'broken.json')), /not valid JSON/)
      await assert.rejects(() => loadConfigFile(join(root, 'big.json')), /byte limit/)
      await assert.rejects(() => loadConfigFile(join(root, 'bad-bytes.json')), /not valid UTF-8/)
      await assert.rejects(() => loadConfigFile(join(root, 'missing.json')), /could not be read/)
      await assert.rejects(() => loadConfigFile(root), /not a regular file/)

      // A nested typo must not survive the file reader either.
      const nested = await loadConfigFile(join(root, 'nested-typo.json'))
      assert.throws(() => validateThresholds(nested.thresholds), TypeError)
    },
  )
})

test('the map destination is refused inside the export root, including through a symlink', async () => {
  await withRoot({ 'e.csv': `${HEADER}\n` }, async (root) => {
    const outside = await mkdtemp(join(tmpdir(), 'kcm-out-'))
    try {
      await assert.rejects(() => resolveMapDestination(root, join(root, 'map.json')), /inside the export root/)
      await assert.rejects(() => resolveMapDestination(root, join(root, 'nested/map.json')), /inside the export root/)
      await assert.rejects(() => resolveMapDestination(root, root), /inside the export root/)
      await assert.rejects(() => resolveMapDestination(root, ''), /non-empty path/)

      // A symlinked parent is how a "separate destination" becomes a file
      // written into the export set.
      const bridge = join(outside, 'bridge')
      await symlink(root, bridge)
      await assert.rejects(() => resolveMapDestination(root, join(bridge, 'map.json')), /inside the export root/)

      const allowed = await resolveMapDestination(root, join(outside, 'build/map.json'))
      assert.equal(allowed.endsWith(join('build', 'map.json')), true)
      await assert.rejects(() => resolveMapDestination(root, outside), /not a file/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test('writeMapFile creates the destination and writes parseable JSON', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'kcm-write-'))
  try {
    const { map } = await mapQueryPageExports({ root: CLEAN_ROOT })
    const destination = join(outside, 'nested/deeper/map.json')
    await writeMapFile(destination, map)
    const written = JSON.parse(await readFile(destination, 'utf8'))
    assert.equal(written.tool, 'keyword-cannibalization-map')
    assert.equal(written.candidates.length, 3)
    assert.equal(written.notes.length > 0, true)
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test('column mapping reads an export that names its columns differently', async () => {
  const rows = [
    'Search Term,Landing Page,Country,Language,Impr.,Clicks,Avg. Pos',
    'q a,/one,US,en-US,600,10,3.0',
    'q a,/two,US,en-US,400,10,4.0',
    '',
  ].join('\n')

  await withRoot({ 'e.csv': rows }, async (root) => {
    const { report, map } = await mapQueryPageExports({
      root,
      columns: {
        query: 'Search Term',
        page: 'Landing Page',
        impressions: 'Impr.',
        clicks: 'Clicks',
        position: 'Avg. Pos',
      },
      segmentColumns: ['Country', 'Language'],
    })
    assert.equal(report.status, 'pass')
    assert.equal(map.counts.candidates, 1)
    assert.deepEqual(map.candidates[0].segment, { country: 'US', language: 'en-US' })
  })
})

test('an export without a position column is still complete, with unknown positions', async () => {
  const rows = ['query,page,region,locale,impressions,clicks', 'q a,/one,US,en-US,600,10', 'q a,/two,US,en-US,400,10', ''].join('\n')
  await withRoot({ 'e.csv': rows }, async (root) => {
    const { report, map } = await mapQueryPageExports({ root })
    assert.equal(report.status, 'pass')
    for (const page of map.candidates[0].pages) assert.equal(page.bestPosition, null)
    for (const row of map.candidates[0].rows) assert.equal(row.position, null)
  })
})

test('the map records the settings it was produced under', async () => {
  const { map } = await mapQueryPageExports({ root: CLEAN_ROOT, match: 'exact', thresholds: { minPages: 3 } })
  assert.equal(map.match, 'exact')
  assert.equal(map.thresholds.minPages, 3)
  assert.deepEqual(map.segmentColumns, ['region', 'locale'])
  assert.deepEqual(map.limits, { ...DEFAULT_LIMITS })
})
