import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { RULE_SEVERITY, formatReport, mapQueryPageExports } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/keyword-cannibalization-map.mjs')
const OUTSIDE_EXPORT = join(projectDirectory, 'examples/exports-clean/search-console-2026-02-us.csv')

/**
 * Severity, pinned by what a run does rather than by what a table says.
 *
 * `test/severity-table.test.mjs` asserts the frozen table against the
 * documented catalog and against a hand-written copy. That is worth having and
 * it is not enough: three declarations can be edited together, and a tool in
 * this catalog shipped 40 error rules re-graded that way with its suite green,
 * because nothing observable was asserted.
 *
 * Every rule gets a fixture here, and every fixture asserts what a person
 * actually sees: the `status` in the report, the exit code of the real binary,
 * and the severity word the human report prints on that rule's own line. A
 * downgraded `error` lets a refusal reach `pass` or turns exit 1 into exit 0;
 * an upgraded `info` turns a review candidate into a failing build. Neither
 * survives a table edit, however many declarations are edited with it.
 *
 * This is not `test/guarantees.test.mjs`, which pins the `incomplete` flag with
 * the flag itself as the subject. Here the subject is the grade, and the
 * outcomes -- pass/fail/incomplete and 0/1/2 -- are how the grade is observed.
 */

const HEADER = 'query,page,region,locale,impressions,clicks,position'

/** A companion export that parses cleanly, so no case is masked by no-rows-parsed. */
const GOOD = [
  'query,page,region,locale,impressions,clicks',
  'q a,/one,US,en-US,600,10',
  'q a,/two,US,en-US,400,10',
  '',
].join('\n')

const PADDED = [
  HEADER,
  ...Array.from({ length: 12 }, (unused, index) => `pad ${index},/pad-${index},US,en-US,10,1,3.0`),
  '',
].join('\n')

const LIMIT_FLAGS = Object.freeze({
  maxExports: '--max-exports',
  maxExportBytes: '--max-export-bytes',
  maxRows: '--max-rows',
  maxFieldChars: '--max-field-chars',
  maxDepth: '--max-depth',
  maxIntentGroups: '--max-intent-groups',
  maxClusterRows: '--max-cluster-rows',
})

/**
 * One case per rule id.
 *
 * `severity` is what the human report must print on that rule's line, and
 * `status` and `exit` are what the run must do. They are written out here
 * rather than read from RULE_SEVERITY on purpose: a test that derives its
 * expectation from the thing under test agrees with any edit to it.
 */
const CASES = [
  // info: finding an overlap is not finding a fault, so the run still passes.
  {
    ruleId: 'cluster-review-candidate',
    files: { 'a-good.csv': GOOD },
    severity: 'info',
    status: 'pass',
    exit: 0,
  },
  {
    ruleId: 'cross-segment-intent-not-merged',
    files: {
      'e.csv': [
        HEADER,
        'solar battery storage,/uk/solar-battery,GB,en-GB,400,20,5.5',
        'solar battery storage,/us/solar-battery,US,en-US,350,18,6.1',
        '',
      ].join('\n'),
    },
    severity: 'info',
    status: 'pass',
    exit: 0,
  },
  {
    ruleId: 'no-candidates-found',
    files: { 'e.csv': [HEADER, 'q a,/one,US,en-US,600,10,3.0', ''].join('\n') },
    severity: 'info',
    status: 'pass',
    exit: 0,
  },

  // warning: worth saying, never worth failing over on its own.
  {
    ruleId: 'export-empty',
    files: { 'a-good.csv': GOOD, 'empty.csv': 'query,page,region,locale,impressions,clicks\n' },
    severity: 'warning',
    status: 'pass',
    exit: 0,
  },
  {
    ruleId: 'page-spelling-variant',
    files: {
      'e.csv': [HEADER, 'q a,/seven,US,en-US,600,40,2.2', 'q a,/seven/,US,en-US,120,8,2.4', ''].join('\n'),
    },
    severity: 'warning',
    status: 'pass',
    exit: 0,
  },
  {
    ruleId: 'position-invalid',
    files: {
      'e.csv': [HEADER, 'q a,/one,US,en-US,600,10,n/a', 'q a,/two,US,en-US,400,10,4.0', ''].join('\n'),
    },
    severity: 'warning',
    status: 'pass',
    exit: 0,
  },
  {
    ruleId: 'row-duplicate',
    files: {
      'e.csv': [
        HEADER,
        'q a,/one,US,en-US,600,10,3.0',
        'q a,/one,US,en-US,400,10,4.0',
        'q a,/two,US,en-US,300,5,5.0',
        '',
      ].join('\n'),
    },
    severity: 'warning',
    status: 'pass',
    exit: 0,
  },
  {
    // A warning that still cannot be a pass: nothing was grouped, so there is
    // no evidence to pass on. The severity is low and the outcome is exit 2.
    ruleId: 'no-rows-parsed',
    files: { 'notes.txt': 'not an export' },
    severity: 'warning',
    status: 'incomplete',
    exit: 2,
    expectNoRows: true,
  },

  // error, with evidence that was read and found wrong: the data failed.
  {
    ruleId: 'metrics-inconsistent',
    files: { 'a-good.csv': GOOD, 'bad.csv': [HEADER, 'q b,/x,US,en-US,10,99,3.0', ''].join('\n') },
    severity: 'error',
    status: 'fail',
    exit: 1,
  },
  {
    ruleId: 'page-missing',
    files: { 'a-good.csv': GOOD, 'bad.csv': [HEADER, 'q b,,US,en-US,100,4,3.0', ''].join('\n') },
    severity: 'error',
    status: 'fail',
    exit: 1,
  },
  {
    ruleId: 'query-missing',
    files: { 'a-good.csv': GOOD, 'bad.csv': [HEADER, ',/x,US,en-US,100,4,3.0', ''].join('\n') },
    severity: 'error',
    status: 'fail',
    exit: 1,
  },
  {
    ruleId: 'row-column-count-mismatch',
    files: { 'a-good.csv': GOOD, 'bad.csv': [HEADER, 'q b,/x,US,en-US,100,4', ''].join('\n') },
    severity: 'error',
    status: 'fail',
    exit: 1,
  },
  {
    ruleId: 'row-metric-invalid',
    files: { 'a-good.csv': GOOD, 'bad.csv': [HEADER, 'q b,/x,US,en-US,1.5,4,3.0', ''].join('\n') },
    severity: 'error',
    status: 'fail',
    exit: 1,
  },

  // error, with evidence that was never obtained: the run is incomplete.
  {
    ruleId: 'cluster-rows-exceeded',
    files: { 'a-good.csv': GOOD },
    limits: { maxClusterRows: 1 },
    severity: 'error',
    status: 'incomplete',
    exit: 2,
  },
  {
    ruleId: 'directory-too-deep',
    files: { 'a-good.csv': GOOD, 'deep/deeper/e.csv': GOOD },
    limits: { maxDepth: 1 },
    severity: 'error',
    status: 'incomplete',
    exit: 2,
  },
  {
    ruleId: 'export-not-utf8',
    files: { 'a-good.csv': GOOD, 'bad.csv': new Uint8Array([0x71, 0xff, 0xfe, 0x0a]) },
    severity: 'error',
    status: 'incomplete',
    exit: 2,
  },
  {
    ruleId: 'export-too-large',
    files: { 'a-good.csv': GOOD, 'big.csv': PADDED },
    limits: { maxExportBytes: 200 },
    severity: 'error',
    status: 'incomplete',
    exit: 2,
  },
  {
    ruleId: 'export-unreadable',
    files: { 'a-good.csv': GOOD, 'locked.csv': GOOD },
    prepare: async (root) => chmod(join(root, 'locked.csv'), 0o000),
    severity: 'error',
    status: 'incomplete',
    exit: 2,
  },
  {
    ruleId: 'header-column-duplicate',
    files: {
      'a-good.csv': GOOD,
      'dup.csv': 'query,page,page,region,locale,impressions,clicks\nq,/a,/b,US,en-US,100,4\n',
    },
    severity: 'error',
    status: 'incomplete',
    exit: 2,
  },
  {
    ruleId: 'header-column-missing',
    files: { 'a-good.csv': GOOD, 'short.csv': 'query,page,region,locale,impressions\nq,/a,US,en-US,100\n' },
    severity: 'error',
    status: 'incomplete',
    exit: 2,
  },
  {
    ruleId: 'header-missing',
    files: { 'a-good.csv': GOOD, 'blank.csv': '  \n' },
    severity: 'error',
    status: 'incomplete',
    exit: 2,
  },
  {
    // The entry was named inside the root and refused unread, so the run has
    // less evidence than the root declared. Exit 2, like every other refusal.
    ruleId: 'path-escapes-root',
    files: { 'a-good.csv': GOOD },
    prepare: async (root) => symlink(OUTSIDE_EXPORT, join(root, 'escape.csv')),
    severity: 'error',
    status: 'incomplete',
    exit: 2,
  },
  {
    ruleId: 'row-field-too-long',
    files: {
      'a-good.csv': GOOD,
      'wide.csv': [HEADER, 'a very long query indeed here,/one,US,en-US,600,10,3.0', ''].join('\n'),
    },
    limits: { maxFieldChars: 20 },
    severity: 'error',
    status: 'incomplete',
    exit: 2,
  },
  {
    ruleId: 'too-many-exports',
    files: { 'a-good.csv': GOOD, 'b-second.csv': GOOD },
    limits: { maxExports: 1 },
    severity: 'error',
    status: 'incomplete',
    exit: 2,
  },
  {
    ruleId: 'too-many-intent-groups',
    files: {
      'a-good.csv': GOOD,
      'more.csv': [HEADER, 'beta q,/three,US,en-US,600,10,3.0', 'beta q,/four,US,en-US,400,10,4.0', ''].join('\n'),
    },
    limits: { maxIntentGroups: 1 },
    severity: 'error',
    status: 'incomplete',
    exit: 2,
  },
  {
    ruleId: 'too-many-rows',
    files: { 'a-good.csv': GOOD, 'big.csv': PADDED },
    limits: { maxRows: 3 },
    severity: 'error',
    status: 'incomplete',
    exit: 2,
  },
  {
    ruleId: 'unterminated-quoted-field',
    files: { 'a-good.csv': GOOD, 'quoted.csv': `${HEADER}\n"never closed,/a,US,en-US,100,4,3.0\n` },
    severity: 'error',
    status: 'incomplete',
    exit: 2,
  },
]

async function withRoot(files, body) {
  const directory = await mkdtemp(join(tmpdir(), 'kcm-sev-'))
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

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

test('every rule id in the table has a behavioural case', () => {
  // A new rule cannot ship with a severity nobody watched a run produce.
  assert.deepEqual(CASES.map((item) => item.ruleId).sort(), Object.keys(RULE_SEVERITY).sort())
  assert.equal(new Set(CASES.map((item) => item.ruleId)).size, CASES.length)
})

test('every rule severity is what a real run does', async (t) => {
  for (const item of CASES) {
    await t.test(`${item.ruleId} is ${item.severity}: status ${item.status}, exit ${item.exit}`, async () => {
      await withRoot(item.files, async (root) => {
        if (item.prepare) await item.prepare(root)

        const flags = Object.entries(item.limits ?? {}).flatMap(([name, value]) => [LIMIT_FLAGS[name], String(value)])
        const { report, map } = await mapQueryPageExports({ root, ...(item.limits ? { limits: item.limits } : {}) })

        // Non-vacuous: the rule under test must actually have fired.
        const fired = report.findings.filter((finding) => finding.ruleId === item.ruleId)
        assert.ok(fired.length > 0, `${item.ruleId} was not reported by its own fixture`)

        // Isolation: unless this case IS the vacuous-pass guard, rows were
        // parsed, so that guard is not what decided the outcome.
        if (item.expectNoRows) assert.equal(report.summary.rows, 0)
        else {
          assert.ok(report.summary.rows > 0, `${item.ruleId} parsed no row, so the case does not isolate its grade`)
          assert.equal(
            report.findings.some((finding) => finding.ruleId === 'no-rows-parsed'),
            false,
            `${item.ruleId} is masked by the vacuous-pass guard`,
          )
        }

        // What the run does, which is the whole point of a severity.
        assert.equal(report.status, item.status, `${item.ruleId} produced status ${report.status}`)
        assert.equal(map.complete, item.status !== 'incomplete')

        // What the reader is shown on that rule's own line.
        const line = formatReport(report)
          .split('\n')
          .find((text) => text.includes(` ${item.ruleId} `))
        assert.ok(line, `${item.ruleId} has no line in the human report`)
        assert.equal(
          line.startsWith(item.severity.toUpperCase()),
          true,
          `${item.ruleId} printed "${line.split(' ')[0]}" where ${item.severity.toUpperCase()} was expected`,
        )

        // And what a script running the binary sees.
        const result = await cli(['--root', root, '--json', ...flags])
        assert.equal(result.code, item.exit, `${item.ruleId} exited ${result.code}`)
        const fromCli = JSON.parse(result.stdout)
        assert.equal(fromCli.status, item.status)
        assert.equal(
          fromCli.findings.some((finding) => finding.ruleId === item.ruleId && finding.severity === item.severity),
          true,
          `${item.ruleId} did not reach the JSON report at ${item.severity}`,
        )
      })
    })
  }
})

test('a refused entry cannot reach a pass, whatever its grade', async () => {
  // The refusal that had no second line of defence: path-escapes-root was the
  // only refusal in the tool that left the run complete, so a single re-grade
  // of one table entry turned "two declared exports were never read" into pass.
  await withRoot({ 'a-good.csv': GOOD }, async (root) => {
    await symlink(OUTSIDE_EXPORT, join(root, 'escape.csv'))
    await symlink(OUTSIDE_EXPORT, join(root, 'escape-two.csv'))

    const { report, map } = await mapQueryPageExports({ root })
    assert.equal(report.findings.filter((finding) => finding.ruleId === 'path-escapes-root').length, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(map.complete, false)
    assert.ok(report.summary.rows > 0, 'the export beside the symlinks must still have been read')

    const result = await cli(['--root', root, '--json'])
    assert.equal(result.code, 2)
    assert.equal(JSON.parse(result.stdout).status, 'incomplete')
    assert.equal(result.stderr.includes('incomplete'), true)

    // Still no leakage of what was on the other side of the link.
    const serialized = JSON.stringify({ report, map })
    assert.equal(serialized.includes('solar panel installation cost'), false)
  })
})
