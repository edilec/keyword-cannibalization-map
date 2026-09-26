#!/usr/bin/env node

import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  formatReport,
  loadConfigFile,
  mapQueryPageExports,
  resolveMapDestination,
  writeMapFile,
} from '../src/index.mjs'

const HELP = `keyword-cannibalization-map

Group query/page exports into candidate overlap clusters, each carrying the
rows that produced it and a review priority. Nothing is fetched, and no export
is ever written to -- a --map destination that is one of them, by device and
inode or through a link, is refused before the run reads anything.

A candidate is an item for a person to review, not a defect. Two pages ranking
for one query is often deliberate, so an overlap never fails a run: the check
fails only when export data is internally inconsistent or could not be parsed.
The priority orders the review queue and claims nothing about consequences.

Usage:
  keyword-cannibalization-map --root DIR [--map FILE] [--json] [--config FILE]
                              [--match MODE] [--segment-column NAME]...
                              [--no-segments] [thresholds] [limits]

Options:
  --root DIR                 Directory holding the query/page exports (required)
  --map FILE                 Write the derived map here. Refused, as a
                             configuration error, when it is a symbolic link
                             (resolving the link is the dangerous act, so it is
                             refused unresolved), when it resolves inside --root
                             through a symlinked parent, when it is the same
                             file as an export by device and inode, or when it
                             is not a regular file
  --json                     Emit the machine-readable report on stdout
  --config FILE              JSON configuration; CLI options override its values
  --match MODE               exact or tokens (default tokens)
  --segment-column NAME      Segment dimension; repeat to declare the whole set,
                             replacing the default region, locale
  --no-segments              Assert that every row belongs to one segment
  --min-pages N              Distinct contributing pages a candidate needs (default 2)
  --min-impressions N        Impressions a candidate needs (default 100)
  --min-page-share-bp N      Share of cluster impressions a page needs to count,
                             in basis points (default 500, i.e. 5%)
  --high-priority-score N    Priority score at which a candidate is high (default 500)
  --medium-priority-score N  Priority score at which a candidate is medium (default 100)
  --max-exports N            Maximum export files (default 64)
  --max-export-bytes N       Maximum bytes per export (default 4194304)
  --max-rows N               Maximum rows per export, header included (default 50000)
  --max-field-chars N        Maximum characters in one field (default 400)
  --max-depth N              Maximum directory depth below the root (default 6)
  --max-intent-groups N      Maximum intent groups (default 5000)
  --max-cluster-rows N       Maximum supporting rows recorded per candidate (default 200)
  -h, --help                 Show this help

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins. --segment-column is the exception,
and is repeated to declare the whole segment set.

Rows are grouped inside a segment, so the same query from another region or
locale is a separate intent. Intents that pooling the segments would have
merged are reported as information, never merged silently.

Exit codes:
  0  every export was read and the data is internally consistent
  1  the export data failed the check
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, undecodable or bounded out (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-exports', 'maxExports'],
  ['--max-export-bytes', 'maxExportBytes'],
  ['--max-rows', 'maxRows'],
  ['--max-field-chars', 'maxFieldChars'],
  ['--max-depth', 'maxDepth'],
  ['--max-intent-groups', 'maxIntentGroups'],
  ['--max-cluster-rows', 'maxClusterRows'],
])

const THRESHOLD_FLAGS = new Map([
  ['--min-pages', 'minPages'],
  ['--min-impressions', 'minImpressions'],
  ['--min-page-share-bp', 'minPageShareBasisPoints'],
  ['--high-priority-score', 'highPriorityScore'],
  ['--medium-priority-score', 'mediumPriorityScore'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = {
    root: null,
    map: null,
    config: null,
    json: false,
    match: null,
    segmentColumns: null,
    noSegments: false,
    limits: {},
    thresholds: {},
  }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat means the earlier value is discarded with no diagnostic,
   * so `--min-pages 5 --min-pages 2` runs a threshold nobody asked for and
   * `--root a --root b` maps a directory nobody named. That is the same defect
   * as an ignored typo, which this tool already refuses. `--segment-column` is
   * the documented exception: repeating it declares a set.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (argument === '--no-segments') {
      once('--no-segments')
      options.noSegments = true
    } else if (argument === '--root') {
      once('--root')
      options.root = takeValue('--root')
    } else if (argument === '--map') {
      once('--map')
      options.map = takeValue('--map')
    } else if (argument === '--config') {
      once('--config')
      options.config = takeValue('--config')
    } else if (argument === '--match') {
      once('--match')
      options.match = takeValue('--match')
    } else if (argument === '--segment-column') {
      if (options.segmentColumns === null) options.segmentColumns = []
      options.segmentColumns.push(takeValue('--segment-column'))
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else if (THRESHOLD_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw)) throw new Error(`${argument} requires a non-negative integer`)
      options.thresholds[THRESHOLD_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.root === null) throw new Error('--root is required')
  if (options.noSegments && options.segmentColumns !== null) {
    throw new Error('--no-segments and --segment-column contradict each other')
  }
  return options
}

/**
 * Merge the configuration file under the command line.
 *
 * The command line wins, key by key rather than block by block, so
 * `--min-pages 3` beside a configuration file that sets `minImpressions` keeps
 * both. A block-level override would silently discard the other thresholds.
 */
function merge(fileValue, cliValue) {
  if (fileValue === undefined) return cliValue
  return { ...fileValue, ...cliValue }
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  // Configuration is settled before any export is read, so a bad root, an
  // unreadable configuration file or a destination inside the export set fails
  // with no report rather than half a run.
  let fileConfig = {}
  if (options.config !== null) {
    try {
      fileConfig = await loadConfigFile(options.config)
    } catch (error) {
      process.stderr.write(`--config is not usable: ${error.message}\n`)
      return 2
    }
  }

  let rootReal
  try {
    rootReal = await realpath(resolve(options.root))
  } catch (error) {
    process.stderr.write(`--root could not be read: ${error.code ?? error.message}\n`)
    return 2
  }

  let destination = null
  if (options.map !== null) {
    try {
      destination = await resolveMapDestination(rootReal, options.map)
    } catch (error) {
      process.stderr.write(`--map is not usable: ${error.message}\n`)
      return 2
    }
  }

  const segmentColumns = options.noSegments
    ? []
    : options.segmentColumns !== null
      ? options.segmentColumns
      : fileConfig.segmentColumns

  let report
  let map
  let inputs
  try {
    const result = await mapQueryPageExports({
      root: options.root,
      limits: merge(fileConfig.limits, options.limits),
      thresholds: merge(fileConfig.thresholds, options.thresholds),
      ...(fileConfig.columns === undefined ? {} : { columns: fileConfig.columns }),
      ...(segmentColumns === undefined ? {} : { segmentColumns }),
      ...(options.match === null && fileConfig.match === undefined
        ? {}
        : { match: options.match ?? fileConfig.match }),
    })
    report = result.report
    map = result.map
    inputs = result.inputs
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  if (destination !== null) {
    // Asked again here, with the exports this run actually opened. The
    // pre-flight above could not answer "is this destination one of them?":
    // a hard link shares no path with the file it is a second name for, so only
    // a device-and-inode comparison against an opened input can see it.
    try {
      await writeMapFile(destination, map, { inputs, exportRoot: rootReal })
      process.stderr.write(
        `map written: ${map.counts.candidates} candidate(s), ${map.counts.separatedIntents} separated intent(s), complete=${map.complete}\n`,
      )
    } catch (error) {
      process.stderr.write(`map could not be written: ${error.code ?? error.message}\n`)
      return 2
    }
  }

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))

  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.exportsRead} of ${report.summary.exportsFound} export(s) were read; evidence is missing, so this run is not a pass.\n`,
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
