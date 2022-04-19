import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { MAX_CONFIG_BYTES } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/keyword-cannibalization-map.mjs')
const CLEAN_ROOT = join(projectDirectory, 'examples/exports-clean')
const BROKEN_ROOT = join(projectDirectory, 'examples/exports-broken')

const HEADER = 'query,page,region,locale,impressions,clicks,position'

/** Run the real binary and report what actually reached each stream. */
async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

async function withTemporary(body) {
  const directory = await mkdtemp(join(tmpdir(), 'kcm-cli-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('--help prints usage on stdout and exits 0', async () => {
  const result = await cli(['--help'])
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.startsWith('keyword-cannibalization-map'), true)
  assert.equal(result.stdout.includes('--max-cluster-rows'), true)
  assert.equal(result.stdout.includes('--no-segments'), true)
  assert.equal(result.stdout.includes('Exit codes:'), true)
  assert.equal(result.stdout.includes('not a defect'), true)
})

test('a clean export set exits 0 and stdout carries only the JSON report', async () => {
  const result = await cli(['--root', CLEAN_ROOT, '--json'])
  assert.equal(result.code, 0)

  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'pass')
  assert.equal(report.tool, 'keyword-cannibalization-map')
  assert.equal(report.summary.candidates, 3)
  assert.equal(report.summary.errors, 0)
  assert.equal(result.stdout.endsWith('}\n'), true)
})

test('candidates alone keep the exit code at 0', async () => {
  const result = await cli(['--root', CLEAN_ROOT, '--json'])
  const report = JSON.parse(result.stdout)
  assert.ok(report.summary.candidates > 0)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'cluster-review-candidate'))
  assert.equal(result.code, 0)
})

test('a failing export set exits 1 and names the integrity failures', async () => {
  const result = await cli(['--root', BROKEN_ROOT, '--json'])
  assert.equal(result.code, 1)

  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'fail')
  const errors = [...new Set(report.findings.filter((item) => item.severity === 'error').map((item) => item.ruleId))]
  assert.deepEqual(errors.sort(), [
    'metrics-inconsistent',
    'page-missing',
    'query-missing',
    'row-column-count-mismatch',
    'row-metric-invalid',
  ])
})

test('evidence that could not be obtained exits 2 with an incomplete report on stdout', async () => {
  await withTemporary(async (directory) => {
    await writeFile(join(directory, 'notes.txt'), 'not an export', 'utf8')
    const result = await cli(['--root', directory, '--json'])

    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.findings.map((item) => item.ruleId), ['no-rows-parsed'])
    assert.equal(result.stderr.includes('incomplete'), true)
  })
})

test('invalid configuration exits 2 with an empty stdout', async () => {
  for (const args of [
    [],
    ['--root'],
    ['--root', CLEAN_ROOT, '--nope'],
    ['--root', CLEAN_ROOT, '--root', BROKEN_ROOT],
    ['--root', CLEAN_ROOT, '--max-rows', '0'],
    ['--root', CLEAN_ROOT, '--max-rows', 'many'],
    ['--root', CLEAN_ROOT, '--max-rows', '5', '--max-rows', '6'],
    ['--root', CLEAN_ROOT, '--match', 'fuzzy'],
    ['--root', CLEAN_ROOT, '--min-pages', '1'],
    ['--root', CLEAN_ROOT, '--min-impressions', '0'],
    ['--root', CLEAN_ROOT, '--high-priority-score', '10', '--medium-priority-score', '20'],
    ['--root', CLEAN_ROOT, '--no-segments', '--segment-column', 'region'],
    ['--root', join(CLEAN_ROOT, 'missing-directory')],
  ]) {
    const result = await cli(args)
    assert.equal(result.code, 2, `${args.join(' ')} should be a configuration error`)
    assert.equal(result.stdout, '', `${args.join(' ')} must not put a report on stdout`)
    assert.ok(result.stderr.length > 0, `${args.join(' ')} must explain itself on stderr`)
  }
})

test('--map writes the derived artifact outside the export root', async () => {
  await withTemporary(async (directory) => {
    const destination = join(directory, 'build/cannibalization.map.json')
    const result = await cli(['--root', CLEAN_ROOT, '--map', destination])

    assert.equal(result.code, 0)
    const map = JSON.parse(await readFile(destination, 'utf8'))
    assert.equal(map.tool, 'keyword-cannibalization-map')
    assert.equal(map.complete, true)
    assert.equal(map.candidates.length, 3)
    for (const candidate of map.candidates) assert.ok(candidate.rows.length > 0)
    assert.equal(result.stderr.includes('map written'), true)
  })
})

test('--map inside the export root is refused with an empty stdout', async () => {
  const result = await cli(['--root', CLEAN_ROOT, '--map', join(CLEAN_ROOT, 'map.json')])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.includes('inside the export root'), true)
})

test('--no-segments is an assertion the caller makes, and it changes the answer', async () => {
  await withTemporary(async (directory) => {
    await writeFile(
      join(directory, 'e.csv'),
      [
        HEADER,
        'solar battery storage,/uk/solar-battery,GB,en-GB,400,20,5.5',
        'solar battery storage,/us/solar-battery,US,en-US,350,18,6.1',
        '',
      ].join('\n'),
      'utf8',
    )

    const segmented = JSON.parse((await cli(['--root', directory, '--json'])).stdout)
    assert.equal(segmented.summary.candidates, 0)
    assert.equal(segmented.summary.separatedIntents, 1)

    const pooled = JSON.parse((await cli(['--root', directory, '--json', '--no-segments'])).stdout)
    assert.equal(pooled.summary.candidates, 1)
    assert.equal(pooled.summary.separatedIntents, 0)
  })
})

test('--segment-column replaces the whole default segment set', async () => {
  await withTemporary(async (directory) => {
    await writeFile(
      join(directory, 'e.csv'),
      [
        HEADER,
        'q one,/a,US,en-US,600,10,3.0',
        'q one,/b,US,en-GB,400,10,4.0',
        '',
      ].join('\n'),
      'utf8',
    )

    // region+locale keeps these apart; region alone brings them together.
    const both = JSON.parse((await cli(['--root', directory, '--json'])).stdout)
    assert.equal(both.summary.candidates, 0)

    const regionOnly = JSON.parse(
      (await cli(['--root', directory, '--json', '--segment-column', 'region'])).stdout,
    )
    assert.equal(regionOnly.summary.candidates, 1)
  })
})

test('a configuration file is honoured and the command line overrides it key by key', async () => {
  await withTemporary(async (directory) => {
    await writeFile(
      join(directory, 'e.csv'),
      [
        'Search Term,Landing Page,Country,Impr.,Clicks',
        'q one,/a,US,600,10',
        'q one,/b,US,400,10',
        'q two,/c,US,35,1',
        'q two,/d,US,25,1',
        '',
      ].join('\n'),
      'utf8',
    )

    // Both thresholds in the file differ from the shipped defaults, so each one
    // surviving -- or not -- is visible in the candidate count.
    const config = join(directory, 'config.json')
    await writeFile(
      config,
      JSON.stringify({
        columns: { query: 'Search Term', page: 'Landing Page', impressions: 'Impr.', clicks: 'Clicks' },
        segmentColumns: ['Country'],
        thresholds: { minPages: 3, minImpressions: 50 },
      }),
      'utf8',
    )

    const configured = JSON.parse((await cli(['--root', directory, '--json', '--config', config])).stdout)
    assert.equal(configured.status, 'pass')
    assert.equal(configured.summary.rows, 4, 'the column mapping in the file must have been used')
    assert.equal(configured.summary.candidates, 0, 'minPages 3 from the file must have been used')

    // minPages comes from the command line; minImpressions must still come from
    // the file. Had the command line replaced the whole thresholds block, the
    // 60-impression intent would have fallen below the default of 100 and only
    // one candidate would appear.
    const merged = JSON.parse(
      (await cli(['--root', directory, '--json', '--config', config, '--min-pages', '2'])).stdout,
    )
    assert.equal(merged.summary.candidates, 2)

    const overridden = JSON.parse(
      (await cli([
        '--root', directory, '--json', '--config', config, '--min-pages', '2', '--min-impressions', '200',
      ])).stdout,
    )
    assert.equal(overridden.summary.candidates, 1)
  })
})

test('an unusable configuration file exits 2 with an empty stdout', async () => {
  await withTemporary(async (directory) => {
    const typo = join(directory, 'typo.json')
    await writeFile(typo, JSON.stringify({ threshold: { minPages: 3 } }), 'utf8')

    const result = await cli(['--root', CLEAN_ROOT, '--config', typo])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.includes('Unknown configuration key'), true)

    const missing = await cli(['--root', CLEAN_ROOT, '--config', join(directory, 'absent.json')])
    assert.equal(missing.code, 2)
    assert.equal(missing.stdout, '')
  })
})

test('the configuration bound is a usage error, not a finding in an incomplete report', async () => {
  await withTemporary(async (directory) => {
    // Padded with spaces, so the file is valid JSON at either size and only the
    // bound can decide. The README used to promise a finding and an incomplete
    // report here; there is no report, because no export has been looked at.
    const body = '{"thresholds":{"minPages":3}'
    const over = join(directory, 'over.json')
    await writeFile(over, `${body}${' '.repeat(MAX_CONFIG_BYTES)}}`, 'utf8')

    const refused = await cli(['--root', CLEAN_ROOT, '--json', '--config', over])
    assert.equal(refused.code, 2)
    assert.equal(refused.stdout, '', 'a configuration error puts no report on stdout')
    assert.ok(refused.stderr.includes('byte limit'), refused.stderr)

    // Exactly at the bound is accepted and honoured, so what was refused above
    // was the size and not the padding.
    const exact = join(directory, 'exact.json')
    await writeFile(exact, `${body}${' '.repeat(MAX_CONFIG_BYTES - body.length - 1)}}`, 'utf8')

    const accepted = await cli(['--root', CLEAN_ROOT, '--json', '--config', exact])
    assert.equal(accepted.code, 0)
    const report = JSON.parse(accepted.stdout)
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.candidates, 0, 'minPages 3 from the configuration file must have been used')
  })
})

test('the human report is one line per finding plus a three line summary', async () => {
  const result = await cli(['--root', BROKEN_ROOT])
  assert.equal(result.code, 1)
  const lines = result.stdout.trimEnd().split('\n')

  const json = JSON.parse((await cli(['--root', BROKEN_ROOT, '--json'])).stdout)
  assert.equal(lines.length, json.findings.length + 3)
  assert.equal(lines[2].includes('not a defect'), true)
  for (const line of lines.slice(3)) {
    assert.match(line, /^(ERROR|WARNING|INFO) +\S/)
  }
})

test('a limit named on the command line is actually enforced by the binary', async () => {
  await withTemporary(async (directory) => {
    await writeFile(
      join(directory, 'e.csv'),
      [HEADER, 'q one,/a,US,en-US,600,10,3.0', 'q one,/b,US,en-US,400,10,4.0', ''].join('\n'),
      'utf8',
    )

    const within = await cli(['--root', directory, '--json'])
    assert.equal(within.code, 0)

    const bounded = await cli(['--root', directory, '--json', '--max-rows', '2'])
    assert.equal(bounded.code, 2)
    const report = JSON.parse(bounded.stdout)
    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'too-many-rows'))
  })
})
