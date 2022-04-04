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
