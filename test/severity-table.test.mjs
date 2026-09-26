import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_COLUMNS,
  DEFAULT_LIMITS,
  DEFAULT_SEGMENT_COLUMNS,
  DEFAULT_THRESHOLDS,
  MATCH_MODES,
  RULE_SEVERITY,
  severityFor,
} from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Severity decides whether a run fails or passes, so it is the one thing in
 * this tool most worth pinning. A literal at every construction site drifts
 * silently, and one rule quietly re-graded turns a refusal into a green build.
 * These tests assert the single table, the documented catalog and the shipped
 * source all agree, in both directions.
 */

async function readProjectFile(relativePath) {
  return readFile(resolve(projectDirectory, relativePath), 'utf8')
}

async function documentedSeverities() {
  const text = await readProjectFile('docs/overlap-rules.md')
  const rows = [...text.matchAll(/\|\s*`([a-z0-9-]+)`\s*\|\s*(error|warning|info)\s*\|/g)]
  return Object.fromEntries(rows.map((row) => [row[1], row[2]]))
}

test('the documented rule catalog matches the severity table exactly', async () => {
  const documented = await documentedSeverities()

  assert.equal(Object.keys(documented).length, 27)
  assert.deepEqual(
    Object.keys(documented).sort(),
    Object.keys(RULE_SEVERITY).sort(),
    'docs/overlap-rules.md and RULE_SEVERITY list different rules',
  )
  assert.deepEqual(documented, { ...RULE_SEVERITY })
})

test('every rule the source emits is defined in the severity table', async () => {
  const source = `${await readProjectFile('src/index.mjs')}\n${await readProjectFile('src/cluster.mjs')}`
  const emitted = new Set([...source.matchAll(/ruleId:\s*'([a-z0-9-]+)'/g)].map((match) => match[1]))

  assert.equal(emitted.size > 20, true, 'the rule scan found suspiciously few construction sites')
  for (const ruleId of emitted) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is emitted but missing from RULE_SEVERITY`)
  }
})

test('every rule in the table is actually emitted by the source', async () => {
  const source = `${await readProjectFile('src/index.mjs')}\n${await readProjectFile('src/cluster.mjs')}`
  const emitted = new Set([...source.matchAll(/ruleId:\s*'([a-z0-9-]+)'/g)].map((match) => match[1]))
  for (const ruleId of Object.keys(RULE_SEVERITY)) {
    assert.ok(emitted.has(ruleId), `${ruleId} is documented and graded but never emitted`)
  }
})

test('no severity literal is written at a finding construction site', async () => {
  // A `severity:` beside a `ruleId:` is the defect this table exists to prevent:
  // it lets one rule be downgraded without the table, the docs or a test noticing.
  for (const path of ['src/index.mjs', 'src/cluster.mjs', 'src/csv.mjs', 'bin/keyword-cannibalization-map.mjs']) {
    const source = await readProjectFile(path)
    assert.equal(
      /severity:\s*'(error|warning|info)'/.test(source),
      false,
      `${path} writes a severity literal instead of reading the table`,
    )
  }
})

test('every rule severity is pinned here, rule by rule', () => {
  // The table and the documented catalog are asserted against each other, so a
  // coordinated edit to both agrees with itself and passes. This is the third
  // copy, written out by hand: a re-grade has to walk past an expectation that
  // shares no source with either of them.
  //
  // Downgrading any `error` below turns a refusal into a green build -- a row
  // that could not be parsed, a file that was never decoded, or evidence
  // bounded out by a limit would still reach status pass. Upgrading
  // `cluster-review-candidate` above `info` is the opposite defect and the one
  // this tool exists to avoid: it would make finding an overlap a failure.
  assert.deepEqual({ ...RULE_SEVERITY }, {
    'cluster-review-candidate': 'info',
    'cluster-rows-exceeded': 'error',
    'cross-segment-intent-not-merged': 'info',
    'directory-too-deep': 'error',
    'export-empty': 'warning',
    'export-not-utf8': 'error',
    'export-too-large': 'error',
    'export-unreadable': 'error',
    'header-column-duplicate': 'error',
    'header-column-missing': 'error',
    'header-missing': 'error',
    'metrics-inconsistent': 'error',
    'no-candidates-found': 'info',
    'no-rows-parsed': 'warning',
    'page-missing': 'error',
    'page-spelling-variant': 'warning',
    'path-escapes-root': 'error',
    'position-invalid': 'warning',
    'query-missing': 'error',
    'row-column-count-mismatch': 'error',
    'row-duplicate': 'warning',
    'row-field-too-long': 'error',
    'row-metric-invalid': 'error',
    'too-many-exports': 'error',
    'too-many-intent-groups': 'error',
    'too-many-rows': 'error',
    'unterminated-quoted-field': 'error',
  })
})

test('reporting an overlap is never an error', () => {
  // Pinned separately from the table above, because this is the property the
  // whole tool turns on: a candidate is an item for review, not a fault.
  assert.equal(severityFor('cluster-review-candidate'), 'info')
  assert.equal(severityFor('cross-segment-intent-not-merged'), 'info')
  assert.equal(severityFor('no-candidates-found'), 'info')
})

test('every table entry uses a severity the report contract defines', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.ok(['error', 'warning', 'info'].includes(severity), `${ruleId} has severity ${severity}`)
  }
})

test('the severity table is frozen', () => {
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
  assert.throws(() => {
    RULE_SEVERITY['metrics-inconsistent'] = 'warning'
  }, TypeError)
  assert.equal(RULE_SEVERITY['metrics-inconsistent'], 'error')
})

test('the documented limits and thresholds are the shipped ones', async () => {
  const text = await readProjectFile('docs/overlap-rules.md')
  const rows = [...text.matchAll(/\|\s*`([A-Za-z]+)`\s*\|\s*`(--[a-z-]+)`\s*\|\s*(\d+)\s*\|/g)]
  const documented = Object.fromEntries(rows.map((row) => [row[1], Number(row[3])]))

  assert.deepEqual(documented, { ...DEFAULT_LIMITS, ...DEFAULT_THRESHOLDS })

  const help = await readProjectFile('bin/keyword-cannibalization-map.mjs')
  for (const row of rows) {
    assert.equal(help.includes(row[2]), true, `${row[2]} is documented but not offered by the CLI`)
  }
})

test('the documented configuration surface is the accepted one', async () => {
  const text = await readProjectFile('docs/overlap-rules.md')
  for (const role of Object.keys(DEFAULT_COLUMNS)) {
    assert.equal(text.includes(`\`${role}\``), true, `column role ${role} is accepted but not documented`)
  }
  for (const mode of MATCH_MODES) {
    assert.equal(text.includes(`\`"${mode}"\``), true, `match mode ${mode} is accepted but not documented`)
  }
  for (const column of DEFAULT_SEGMENT_COLUMNS) {
    assert.equal(text.includes(`\`${column}\``), true, `default segment column ${column} is not documented`)
  }
  assert.equal(text.includes('`fuzzy`'), false, 'the docs name a match mode the tool does not accept')
})

test('the changelog records that nothing has shipped yet', async () => {
  const text = await readProjectFile('CHANGELOG.md')
  assert.equal(text.trimEnd().endsWith('No release has been published.'), true)
})
