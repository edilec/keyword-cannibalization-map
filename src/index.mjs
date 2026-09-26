/**
 * keyword-cannibalization-map
 *
 * Reads a directory of query/page exports, groups their rows into candidate
 * overlap clusters inside each segment, and writes a review queue in which
 * every candidate carries the rows that produced it.
 *
 * Four properties are structural rather than incidental:
 *
 * 1. **A candidate is a review item, not a verdict.** Two pages ranking for
 *    one query is frequently deliberate -- a hub and a comparison page, a
 *    product page and its documentation. Overlap never sets `status` to
 *    `fail`, no message says a cluster is undesirable, and nothing here
 *    predicts what consolidating one would do. `fail` is reserved for export
 *    data that is internally inconsistent or could not be parsed.
 * 2. **Every candidate carries its source rows.** A cluster without the rows
 *    behind it cannot be reviewed, corrected or disbelieved. The rows travel
 *    with the candidate into the map artifact, and the count of them is in the
 *    report.
 * 3. **Regional and locale intent stays separate.** Rows are grouped inside a
 *    segment. The same query from another region is a different row set until
 *    somebody says otherwise, and the intents that a segment-blind tool would
 *    have merged are reported as information so the choice is visible.
 * 4. **Exports are read, never written.** The map is a derived artifact with
 *    its own destination, which is refused if it lies inside the export root.
 */

import { readFile, readdir, mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'

import {
  byCodeUnit,
  decodeUtf8,
  delimiterFor,
  excerpt,
  normalizeColumnName,
  parseCount,
  parseDelimited,
  parseFailureDetail,
  parsePosition,
  sanitize,
  stripBom,
} from './csv.mjs'
import {
  MATCH_MODES,
  buildIntentGroups,
  compareCandidates,
  describeSegment,
  findPageSpellingVariants,
  findSeparatedIntents,
  normalizeQuery,
  summarizeGroup,
} from './cluster.mjs'
import { assertWritableDestination, isInside } from './write-guard.mjs'

export const TOOL_ID = 'keyword-cannibalization-map'
export const REPORT_SCHEMA_VERSION = '1'
export const MAP_SCHEMA_VERSION = '1'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * A query export is ordinary untrusted input: it can be a generated 400 MB
 * file, a directory that nests forever, a single field holding a megabyte of
 * text, or a row set crafted to produce millions of groups. Every limit below
 * is explicit, overridable, and reported by name when it is hit. Exceeding one
 * produces a finding and an `incomplete` report -- never a quietly shorter
 * answer, and never a pass.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxExports: 64,
  maxExportBytes: 4194304,
  maxRows: 50000,
  maxFieldChars: 400,
  maxDepth: 6,
  maxIntentGroups: 5000,
  maxClusterRows: 200,
})

/** The configuration file is itself bounded before it is read. */
export const MAX_CONFIG_BYTES = 65536

/**
 * Thresholds decide which intent groups reach the review queue.
 *
 * They are thresholds on *evidence volume* -- how many pages, how much of the
 * intent each holds, how many impressions are behind it -- and not on harm.
 * A group below them is not "safe"; it is below the volume at which a person's
 * attention is worth spending, which is a different statement.
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  minPages: 2,
  minImpressions: 100,
  minPageShareBasisPoints: 500,
  highPriorityScore: 500,
  mediumPriorityScore: 100,
})

/** Column roles, and the export column name each defaults to. */
export const DEFAULT_COLUMNS = Object.freeze({
  query: 'query',
  page: 'page',
  impressions: 'impressions',
  clicks: 'clicks',
  position: 'position',
})

export const COLUMN_ROLES = Object.freeze(Object.keys(DEFAULT_COLUMNS).sort(byCodeUnit))

/** `position` is optional: an export without it is still a complete export. */
export const REQUIRED_COLUMN_ROLES = Object.freeze(['clicks', 'impressions', 'page', 'query'])

/**
 * The dimensions that separate one intent from another.
 *
 * Segmented by default, because pooling regions is the classic false positive
 * of this whole exercise: a UK page and a US page ranking for one phrase are
 * two audiences, not one overlap. An export with no regional dimension is
 * handled by declaring the empty set explicitly -- an assertion by the person
 * running the tool that these rows really are one segment -- rather than by
 * the tool quietly deciding it for them.
 */
export const DEFAULT_SEGMENT_COLUMNS = Object.freeze(['region', 'locale'])

export const DEFAULT_MATCH = 'tokens'

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Spread across two dozen construction sites as a literal it drifts
 * silently, and flipping one integrity rule down to a warning turns a refusal
 * into a green build with every test still passing. Every finding takes its
 * severity from here, an unknown rule id throws, and `docs/overlap-rules.md`
 * is asserted against this table in both directions.
 *
 * Note what is *not* an error: `cluster-review-candidate` is `info`. Finding
 * an overlap is not finding a fault, so it must never fail a run.
 */
export const RULE_SEVERITY = Object.freeze({
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

/**
 * Statements the map carries about what it is and is not.
 *
 * They are data in the artifact rather than prose in a README because the map
 * outlives the terminal it was produced in, and the next reader of it is the
 * person most likely to mistake a priority for a diagnosis.
 */
export const MAP_NOTES = Object.freeze([
  'A candidate is a group of pages that share an intent within one segment. It is an item for review, not a defect.',
  'Two pages ranking for one query is often deliberate. This tool does not decide whether a candidate should be changed.',
  'priorityScore is the impressions the leading page did not hold. It orders a review queue and asserts nothing about consequences.',
  'Rows are grouped inside a segment. The same query in another region or locale is a separate intent unless segmentColumns says otherwise.',
  'Intent matching is lexical. It does not understand synonyms, morphology or meaning, so a candidate can be a coincidence of wording.',
])

const EXPORT_EXTENSIONS = Object.freeze(['.csv', '.tsv'])
const ALLOWED_OPTIONS = Object.freeze(['columns', 'limits', 'match', 'root', 'segmentColumns', 'thresholds'])
const ALLOWED_CONFIG_KEYS = Object.freeze(['columns', 'limits', 'match', 'segmentColumns', 'thresholds'])
const MAX_SEGMENT_COLUMNS = 4
const MAX_COLUMN_NAME_CHARS = 120
const ROOT_LOCATION = Object.freeze({ file: '.', pointer: '/' })

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function pad(value) {
  return String(value).padStart(4, '0')
}

/**
 * Containment, checked on real paths.
 *
 * Refusing `../` and absolute strings is not confinement: a symbolic link
 * planted inside the declared root resolves out of the tree without ever
 * spelling a traversal. The converse mistake is just as real -- comparing a
 * resolved root against an unresolved target refuses files that are genuinely
 * inside it -- so both sides reaching this function have been through
 * `realpath`.
 *
 * Defined once, in `write-guard.mjs`, because the destination guard asks the
 * same question of the same kind of path and two copies of one predicate drift.
 */
export { isInside } from './write-guard.mjs'

export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${sanitize(name)}"`)
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`Limit "${sanitize(name)}" must be a positive integer`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

/**
 * Validate the review thresholds.
 *
 * `minPages` below two would let a single page be a candidate for overlapping
 * with itself, and `minImpressions` below one would let a group with no
 * observed impressions qualify -- both are vacuous candidates, so both are
 * refused rather than clamped. A high band below the medium band would make
 * the bands unorderable, so that is refused too.
 */
export function validateThresholds(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Thresholds must be an object')
  const thresholds = { ...DEFAULT_THRESHOLDS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_THRESHOLDS, name)) throw new TypeError(`Unknown threshold "${sanitize(name)}"`)
    if (!Number.isInteger(value)) throw new TypeError(`Threshold "${sanitize(name)}" must be an integer`)
    thresholds[name] = value
  }
  if (thresholds.minPages < 2) throw new TypeError('Threshold "minPages" must be at least 2; one page cannot overlap itself')
  if (thresholds.minImpressions < 1) {
    throw new TypeError('Threshold "minImpressions" must be at least 1; a candidate with no observed impressions has no evidence')
  }
  if (thresholds.minPageShareBasisPoints < 1 || thresholds.minPageShareBasisPoints > 10000) {
    throw new TypeError('Threshold "minPageShareBasisPoints" must be between 1 and 10000')
  }
  if (thresholds.mediumPriorityScore < 0 || thresholds.highPriorityScore < 0) {
    throw new TypeError('Priority band thresholds must not be negative')
  }
  if (thresholds.highPriorityScore < thresholds.mediumPriorityScore) {
    throw new TypeError('Threshold "highPriorityScore" must not be below "mediumPriorityScore"')
  }
  return Object.freeze(thresholds)
}

function validateColumnName(role, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Column name for "${sanitize(role)}" must be a non-empty string`)
  }
  if (value.length > MAX_COLUMN_NAME_CHARS) {
    throw new TypeError(`Column name for "${sanitize(role)}" is longer than ${MAX_COLUMN_NAME_CHARS} characters`)
  }
  return normalizeColumnName(value)
}

export function validateColumns(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Columns must be an object')
  const columns = { ...DEFAULT_COLUMNS }
  for (const [role, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_COLUMNS, role)) throw new TypeError(`Unknown column role "${sanitize(role)}"`)
    columns[role] = value
  }
  const normalized = {}
  for (const role of COLUMN_ROLES) normalized[role] = validateColumnName(role, columns[role])
  const seen = new Map()
  for (const role of COLUMN_ROLES) {
    const existing = seen.get(normalized[role])
    if (existing !== undefined) {
      throw new TypeError(`Column "${sanitize(normalized[role])}" is mapped to both "${existing}" and "${role}"`)
    }
    seen.set(normalized[role], role)
  }
  return Object.freeze(normalized)
}

/**
 * Validate the segment dimensions.
 *
 * The empty array is accepted and means "these rows are one segment", which is
 * a deliberate assertion by the caller. It is never the default: a tool that
 * silently pools regions produces exactly the false positive this one exists
 * to avoid.
 */
export function validateSegmentColumns(value) {
  if (value === undefined) return DEFAULT_SEGMENT_COLUMNS
  if (!Array.isArray(value)) throw new TypeError('Segment columns must be an array of column names')
  if (value.length > MAX_SEGMENT_COLUMNS) {
    throw new TypeError(`At most ${MAX_SEGMENT_COLUMNS} segment columns may be declared`)
  }
  const seen = new Set()
  const normalized = []
  for (const name of value) {
    const column = validateColumnName('segment', name)
    if (seen.has(column)) throw new TypeError(`Segment column "${sanitize(column)}" is declared twice`)
    seen.add(column)
    normalized.push(column)
  }
  return Object.freeze(normalized)
}

export function validateMatch(value) {
  if (value === undefined) return DEFAULT_MATCH
  if (typeof value !== 'string' || !MATCH_MODES.includes(value)) {
    throw new TypeError(`Match mode must be one of ${MATCH_MODES.join(', ')}`)
  }
  return value
}

/**
 * Read a configuration file.
 *
 * The configuration is an input like any other, so it is bounded, decoded
 * strictly, and rejected key by key. A tool in this catalog hardened the
 * decoding of its data and left its own configuration path lossy; a typo in a
 * key that silently defaults is the same defect as an ignored limit, because
 * both turn a real refusal into a green run.
 */
export async function loadConfigFile(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new TypeError('Configuration path must be a non-empty string')
  }
  let info
  try {
    info = await stat(path)
  } catch (error) {
    throw new TypeError(`Configuration file could not be read: ${error.code ?? 'unknown error'}`)
  }
  if (!info.isFile()) throw new TypeError('Configuration path is not a regular file')
  if (info.size > MAX_CONFIG_BYTES) {
    throw new TypeError(`Configuration file exceeds the ${MAX_CONFIG_BYTES} byte limit`)
  }

  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new TypeError(`Configuration file could not be read: ${error.code ?? 'unknown error'}`)
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) throw new TypeError('Configuration file is not valid UTF-8')

  let parsed
  try {
    parsed = JSON.parse(stripBom(decoded.text))
  } catch (error) {
    throw new TypeError(`Configuration file is not valid JSON: ${excerpt(parseFailureDetail(error), 120)}`)
  }
  if (!isRecord(parsed)) throw new TypeError('Configuration file must contain a JSON object')
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_CONFIG_KEYS.includes(key)) {
      throw new TypeError(`Unknown configuration key "${sanitize(key)}"; supported keys are ${ALLOWED_CONFIG_KEYS.join(', ')}`)
    }
  }
  return parsed
}

/**
 * Resolve the map destination, before any export is read.
 *
 * This is the pre-flight: a destination that can never be written to safely
 * fails here, with no report, rather than after a whole run. It cannot check
 * everything -- a hard link to an export is an identity this run has not
 * established yet -- so `writeMapFile` asks again, with the exports it read, at
 * the moment before the write. `assertWritableDestination` carries the
 * reasoning for all three holes.
 */
export async function resolveMapDestination(root, destination) {
  // The root is resolved here rather than trusted from the caller. Comparing a
  // real destination against an unresolved root is the mistake that lets a
  // write land inside the export set, and it is invisible on any system where
  // the temporary or home directory is itself a symbolic link.
  let rootReal
  try {
    rootReal = await realpath(root)
  } catch (error) {
    throw new TypeError(`Export root could not be resolved: ${error.code ?? 'unknown error'}`)
  }
  return assertWritableDestination(destination, { exportRoot: rootReal, label: 'Map destination' })
}

function createCollector() {
  return { rows: [], incomplete: false }
}

/**
 * The single construction site for a finding.
 *
 * Every untrusted string that can reach output passes through here, not only
 * the evidence field: a page URL carrying a newline would otherwise forge
 * extra lines in the human-readable report, and so would a file name or a
 * column name. Severity is never passed in -- it is looked up from the frozen
 * table when the finding is built.
 */
function record(collector, row) {
  collector.rows.push({
    file: sanitize(row.file),
    pointer: sanitize(row.pointer ?? '/'),
    line: row.line ?? 0,
    ruleId: row.ruleId,
    message: sanitize(row.message),
    ...(row.evidence === undefined ? {} : { evidence: excerpt(row.evidence) }),
    ...(row.suggestion === undefined ? {} : { suggestion: sanitize(row.suggestion) }),
  })
}

/**
 * The only place a severity is chosen.
 *
 * An unknown rule id throws rather than defaulting, because a default would let
 * a new rule ship at whatever severity happened to be convenient and a renamed
 * one disappear from the failing set without a word.
 */
export function severityFor(ruleId) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new Error(`No severity is defined for rule "${sanitize(String(ruleId))}"`)
  return severity
}

function createFinding(row) {
  const severity = severityFor(row.ruleId)
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: row.message,
    location: { file: row.file, pointer: row.pointer },
  }
  if (row.line > 0) finding.line = row.line
  if (row.evidence !== undefined) finding.evidence = row.evidence
  if (row.suggestion !== undefined) finding.suggestion = row.suggestion
  return finding
}

/**
 * Walk the export root.
 *
 * Directory entries are sorted by UTF-16 code unit before use, so the order
 * exports are visited never depends on the order the filesystem returned them.
 * Every entry is resolved to its real path and re-checked against the real
 * root before anything is read from it, and a real path already visited is not
 * visited twice.
 *
 * No entry is skipped for its name. A dot-prefixed export and a directory
 * called `node_modules` are walked like any other, because a name-based skip
 * drops evidence that nothing in the report accounts for: the file is not
 * read, not counted in `exportsFound`, and not reported -- so a run that never
 * saw two of its three exports still says `pass`. Entries that are not
 * export-shaped stay skipped in silence, as they always were: they were never
 * candidates. The depth and count limits, which do report themselves, are what
 * bound the walk.
 */
async function collectExportFiles(rootReal, limits, collector) {
  const files = []
  const visited = new Set([rootReal])
  let stopped = false

  async function walk(absolute, relativePath, depth) {
    if (stopped) return
    if (depth > limits.maxDepth) {
      record(collector, {
        file: relativePath === '' ? '.' : relativePath,
        ruleId: 'directory-too-deep',
        message: `Directory nesting exceeded the maxDepth limit of ${limits.maxDepth}; its contents were not examined.`,
        suggestion: 'Raise --max-depth or flatten the export directory.',
      })
      collector.incomplete = true
      return
    }

    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch (error) {
      record(collector, {
        file: relativePath === '' ? '.' : relativePath,
        ruleId: 'export-unreadable',
        message: `Directory could not be read: ${error.code ?? 'unknown error'}.`,
      })
      collector.incomplete = true
      return
    }

    entries.sort((left, right) => byCodeUnit(left.name, right.name))

    for (const entry of entries) {
      if (stopped) return
      const childRelative = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`
      const childAbsolute = join(absolute, entry.name)

      // Resolve and inspect in one step: an entry whose real path cannot be
      // obtained is unknown evidence, and unknown evidence is never a pass.
      let realPath
      let info
      try {
        realPath = await realpath(childAbsolute)
        info = await stat(realPath)
      } catch (error) {
        record(collector, {
          file: childRelative,
          ruleId: 'export-unreadable',
          message: `Entry could not be resolved: ${error.code ?? 'unknown error'}.`,
        })
        collector.incomplete = true
        continue
      }

      // Containment is decided on the real path, before the entry is opened or
      // walked. Neither its content nor its location leaves this function.
      //
      // The run is incomplete, like every other refusal here. An entry named
      // inside the root that was refused unread is evidence this run does not
      // have, whatever the severity table says about the rule: leaving the flag
      // off made a frozen severity the only thing standing between a refused
      // entry and a `pass`, and it put a refusal that the exit-code table routes
      // to 2 -- evidence that is missing -- on exit 1.
      if (!isInside(rootReal, realPath)) {
        record(collector, {
          file: childRelative,
          ruleId: 'path-escapes-root',
          message: 'Entry resolves outside the export root and was refused; its content was never read.',
          suggestion: 'Move the export inside the root, or map the other location separately.',
        })
        collector.incomplete = true
        continue
      }
      if (visited.has(realPath)) continue
      visited.add(realPath)

      if (info.isDirectory()) {
        await walk(realPath, childRelative, depth + 1)
        continue
      }
      if (!EXPORT_EXTENSIONS.includes(extname(entry.name).toLowerCase())) continue

      // An entry named like an export that is not a regular file -- a FIFO, a
      // socket, a device node -- cannot be read as one, and reading from it
      // could block forever. Dropping it in silence would leave an unexamined
      // export inside a passing run, so it is reported and the run is
      // incomplete. Entries that are not export-shaped stay skipped in
      // silence: they were never candidates.
      if (!info.isFile()) {
        record(collector, {
          file: childRelative,
          ruleId: 'export-unreadable',
          message: 'Entry has an export extension but is not a regular file, so it was not read.',
        })
        collector.incomplete = true
        continue
      }

      if (files.length >= limits.maxExports) {
        record(collector, {
          ...ROOT_LOCATION,
          ruleId: 'too-many-exports',
          message: `The export set exceeded the maxExports limit of ${limits.maxExports}; ${childRelative} and every later file were not read.`,
          suggestion: 'Raise --max-exports or split the export set into separate runs.',
        })
        collector.incomplete = true
        stopped = true
        return
      }

      // Device and inode travel with the path, because they are the only thing
      // that can tell a destination from an export reached by a second name.
      files.push({ relativePath: childRelative, realPath, size: info.size, dev: info.dev, ino: info.ino })
    }
  }

  await walk(rootReal, '', 0)
  return files
}

/**
 * Resolve the header of one export to column indexes.
 *
 * A required column that is absent, or one that appears twice, means the rows
 * of that file cannot be read correctly. Guessing which of two `page` columns
 * was meant would shift every value silently, so the file is dropped and the
 * run is incomplete.
 */
function resolveHeader(collector, relativePath, headerFields, columns, segmentColumns) {
  const names = headerFields.map(normalizeColumnName)
  const indexes = {}
  const wanted = [
    ...COLUMN_ROLES.map((role) => ({ role, column: columns[role], required: REQUIRED_COLUMN_ROLES.includes(role) })),
    ...segmentColumns.map((column) => ({ role: `segment:${column}`, column, required: true })),
  ]

  let usable = true
  for (const { role, column, required } of wanted) {
    const found = []
    for (let index = 0; index < names.length; index += 1) {
      if (names[index] === column) found.push(index)
    }
    if (found.length > 1) {
      record(collector, {
        file: relativePath,
        pointer: '/header',
        ruleId: 'header-column-duplicate',
        message: `Column "${column}" appears ${found.length} times in the header, so its values are ambiguous and the file was not read.`,
        evidence: `column: ${column}`,
        suggestion: 'Remove the duplicate column from the export.',
      })
      usable = false
      continue
    }
    if (found.length === 0) {
      if (!required) {
        indexes[role] = -1
        continue
      }
      record(collector, {
        file: relativePath,
        pointer: '/header',
        ruleId: 'header-column-missing',
        message: `Required column "${column}" is not in the header, so the rows of this file were not read.`,
        evidence: `header: ${names.join(', ')}`,
        suggestion: 'Map the column with a configuration file, or declare a different --segment-column set.',
      })
      usable = false
      continue
    }
    indexes[role] = found[0]
  }

  return usable ? indexes : null
}

/**
 * Read and validate one export.
 *
 * Returns the rows it yielded and whether the file was read at all. The two
 * are not the same: a file whose header resolved and whose every row was
 * rejected was read and produced no rows, while a file that was never decoded
 * produced no rows because nothing about it is known. Reporting the second as
 * the first is how unread evidence gets treated as known.
 */
async function loadExport(collector, limits, settings, entry) {
  const { relativePath, realPath, size } = entry
  const unread = { rows: [], read: false }

  if (size > limits.maxExportBytes) {
    record(collector, {
      file: relativePath,
      ruleId: 'export-too-large',
      message: `Export is ${size} bytes, over the maxExportBytes limit of ${limits.maxExportBytes}; it was not read.`,
      suggestion: 'Raise --max-export-bytes or split the export.',
    })
    collector.incomplete = true
    return unread
  }

  let bytes
  try {
    bytes = await readFile(realPath)
  } catch (error) {
    record(collector, {
      file: relativePath,
      ruleId: 'export-unreadable',
      message: `Export could not be read: ${error.code ?? 'unknown error'}.`,
    })
    collector.incomplete = true
    return unread
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    record(collector, {
      file: relativePath,
      ruleId: 'export-not-utf8',
      message: 'Export is not valid UTF-8, so none of its rows were read.',
      suggestion: 'Re-export the file as UTF-8.',
    })
    collector.incomplete = true
    return unread
  }

  const text = stripBom(decoded.text)
  if (text.trim() === '') {
    record(collector, {
      file: relativePath,
      ruleId: 'header-missing',
      message: 'Export holds no header row, so no column could be located and no row was read.',
    })
    collector.incomplete = true
    return unread
  }

  const parsed = parseDelimited(text, {
    delimiter: delimiterFor(relativePath),
    maxRecords: limits.maxRows,
    maxFieldChars: limits.maxFieldChars,
  })

  if (parsed.exceeded) {
    record(collector, {
      file: relativePath,
      ruleId: 'too-many-rows',
      message: `Export holds more than the maxRows limit of ${limits.maxRows} rows; none of its rows were used, because a partial export would produce shares of the wrong total.`,
      suggestion: 'Raise --max-rows or split the export.',
    })
    collector.incomplete = true
    return unread
  }
  if (parsed.unterminatedQuote) {
    record(collector, {
      file: relativePath,
      ruleId: 'unterminated-quoted-field',
      message: 'A quoted field is never closed, so the row structure of this file is not trustworthy and none of its rows were used.',
      suggestion: 'Close the quote in the export, or re-export the file.',
    })
    collector.incomplete = true
    return unread
  }

  const [header, ...dataRecords] = parsed.records
  const overlong = new Set(parsed.overlongRecordLines)

  if (overlong.has(header.line)) {
    record(collector, {
      file: relativePath,
      pointer: '/header',
      line: header.line,
      ruleId: 'row-field-too-long',
      message: `A column name is longer than the maxFieldChars limit of ${limits.maxFieldChars}; truncating it would resolve the wrong columns, so the file was not read.`,
      suggestion: 'Raise --max-field-chars.',
    })
    collector.incomplete = true
    return unread
  }

  const indexes = resolveHeader(collector, relativePath, header.fields, settings.columns, settings.segmentColumns)
  if (indexes === null) {
    collector.incomplete = true
    return unread
  }

  if (dataRecords.length === 0) {
    record(collector, {
      file: relativePath,
      ruleId: 'export-empty',
      message: 'Export holds a header and no data rows, so it contributed no evidence.',
    })
    return { rows: [], read: true }
  }

  const rows = []
  const seen = new Map()

  for (const item of dataRecords) {
    const pointer = `/rows/${item.line}`
    const location = { file: relativePath, pointer, line: item.line }

    if (overlong.has(item.line)) {
      record(collector, {
        ...location,
        ruleId: 'row-field-too-long',
        message: `A field on this row is longer than the maxFieldChars limit of ${limits.maxFieldChars}; the row was not used.`,
        suggestion: 'Raise --max-field-chars, or check the export for a malformed quote.',
      })
      // Unlike an inconsistent row, this row was refused by a limit of ours
      // rather than found to be wrong. The evidence is missing, not invalid.
      collector.incomplete = true
      continue
    }
    if (item.fields.length !== header.fields.length) {
      record(collector, {
        ...location,
        ruleId: 'row-column-count-mismatch',
        message: `Row has ${item.fields.length} field(s) where the header declares ${header.fields.length}; the row was not used.`,
      })
      continue
    }

    const query = sanitize(item.fields[indexes.query])
    if (query === '') {
      record(collector, { ...location, ruleId: 'query-missing', message: 'Row has no query, so it cannot belong to an intent and was not used.' })
      continue
    }
    const page = sanitize(item.fields[indexes.page])
    if (page === '') {
      record(collector, { ...location, ruleId: 'page-missing', message: 'Row has no page, so it cannot support a candidate and was not used.', evidence: `query: ${query}` })
      continue
    }

    const impressions = parseCount(item.fields[indexes.impressions])
    const clicks = parseCount(item.fields[indexes.clicks])
    if (impressions === null || clicks === null) {
      record(collector, {
        ...location,
        ruleId: 'row-metric-invalid',
        message: 'Impressions and clicks must both be plain non-negative integers; the row was not used.',
        evidence: `impressions: ${excerpt(item.fields[indexes.impressions], 40)} clicks: ${excerpt(item.fields[indexes.clicks], 40)}`,
        suggestion: 'Re-export without thousands separators, percentages or decimal counts.',
      })
      continue
    }
    if (clicks > impressions) {
      record(collector, {
        ...location,
        ruleId: 'metrics-inconsistent',
        message: `Row reports ${clicks} click(s) against ${impressions} impression(s); the row was not used because the metrics contradict each other.`,
        evidence: `query: ${query}`,
      })
      continue
    }

    let position = null
    if (indexes.position >= 0) {
      const parsedPosition = parsePosition(item.fields[indexes.position])
      if (parsedPosition.ok) position = parsedPosition.value
      else {
        record(collector, {
          ...location,
          ruleId: 'position-invalid',
          message: 'Average position is not a non-negative number; the row was kept and its position recorded as unknown.',
          evidence: `position: ${excerpt(item.fields[indexes.position], 40)}`,
        })
      }
    }

    const segment = describeSegment(
      settings.segmentColumns,
      Object.fromEntries(settings.segmentColumns.map((column) => [column, item.fields[indexes[`segment:${column}`]]])),
    )
    const queryNormalized = normalizeQuery(query)
    // JSON rather than a joined string: a page value containing the separator
    // would otherwise collide with a different query and page pair and report a
    // duplicate that is not one.
    const key = JSON.stringify([segment.key, queryNormalized, page])
    const first = seen.get(key)
    if (first !== undefined) {
      record(collector, {
        ...location,
        ruleId: 'row-duplicate',
        message: `The same query, page and segment already appear on line ${first} of this export; both rows were kept and their metrics added.`,
        evidence: `query: ${query} page: ${page}`,
      })
    } else seen.set(key, item.line)

    rows.push({ file: relativePath, line: item.line, query, queryNormalized, page, segment, impressions, clicks, position })
  }

  return { rows, read: true }
}

function compareRows(left, right) {
  return (
    byCodeUnit(left.page, right.page) ||
    byCodeUnit(left.query, right.query) ||
    byCodeUnit(left.file, right.file) ||
    left.line - right.line
  )
}

function describeRow(row) {
  return {
    file: row.file,
    line: row.line,
    query: row.query,
    page: row.page,
    segment: row.segment.values,
    impressions: row.impressions,
    clicks: row.clicks,
    position: row.position,
  }
}

/**
 * Read a directory of query/page exports and derive the review queue.
 *
 * Returns `{ report, map }`. The report is the contract envelope; the map is
 * the derived artifact that carries every candidate together with the rows
 * that produced it.
 */
export async function mapQueryPageExports(options = {}) {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.includes(key)) {
      throw new TypeError(`Unknown option "${sanitize(key)}"; supported options are ${ALLOWED_OPTIONS.join(', ')}`)
    }
  }
  if (typeof options.root !== 'string' || options.root.trim() === '') {
    throw new TypeError('Export root must be a non-empty path')
  }

  const limits = validateLimits(options.limits)
  const thresholds = validateThresholds(options.thresholds)
  const settings = {
    columns: validateColumns(options.columns),
    segmentColumns: validateSegmentColumns(options.segmentColumns),
    match: validateMatch(options.match),
  }

  let rootReal
  try {
    rootReal = await realpath(resolve(options.root))
  } catch (error) {
    throw new TypeError(`Export root could not be resolved: ${error.code ?? 'unknown error'}`)
  }
  const rootInfo = await stat(rootReal)
  if (!rootInfo.isDirectory()) throw new TypeError('Export root must be a directory')

  const collector = createCollector()
  const files = await collectExportFiles(rootReal, limits, collector)

  const rows = []
  let exportsRead = 0
  for (const entry of files) {
    const loaded = await loadExport(collector, limits, settings, entry)
    if (loaded.read) exportsRead += 1
    rows.push(...loaded.rows)
  }

  // The exports this run opened, as the identity a destination is compared
  // against. A path cannot answer "is this the same file?"; a hard link is a
  // second name for one inode and shares no path with the first name.
  const inputs = files.map((entry) => ({ label: entry.relativePath, dev: entry.dev, ino: entry.ino }))

  const groups = buildIntentGroups(rows, settings.match)
  let candidates = []
  let separated = []
  let groupsBounded = false

  if (groups.length > limits.maxIntentGroups) {
    groupsBounded = true
    record(collector, {
      ...ROOT_LOCATION,
      ruleId: 'too-many-intent-groups',
      message: `The rows produced ${groups.length} intent groups, over the maxIntentGroups limit of ${limits.maxIntentGroups}; no candidate was derived, because a partial queue would hide the rest.`,
      suggestion: 'Raise --max-intent-groups, narrow the export set, or use --match exact.',
    })
    collector.incomplete = true
  } else {
    for (const group of groups) {
      const summary = summarizeGroup(group.rows, thresholds)
      if (!summary.qualifies) continue
      candidates.push({
        segmentKey: group.segment.key,
        segment: group.segment,
        intent: group.intent,
        priorityScore: summary.priorityScore,
        impressions: summary.impressions,
        summary,
        rows: group.rows.slice().sort(compareRows),
      })
    }
    candidates.sort(compareCandidates)
    separated = findSeparatedIntents(groups, thresholds)
  }

  const mapCandidates = candidates.map((candidate, index) => {
    const id = `cluster-${pad(index + 1)}`
    const pointer = `/candidates/${id}`
    const intentLabel = excerpt(candidate.intent, 80)
    const rowsTruncated = candidate.rows.length > limits.maxClusterRows

    if (rowsTruncated) {
      record(collector, {
        ...ROOT_LOCATION,
        pointer,
        ruleId: 'cluster-rows-exceeded',
        message: `Candidate ${id} is supported by ${candidate.rows.length} rows, over the maxClusterRows limit of ${limits.maxClusterRows}; only the first ${limits.maxClusterRows} were recorded, so the candidate is not fully evidenced.`,
        evidence: `intent: ${intentLabel}`,
        suggestion: 'Raise --max-cluster-rows to record every supporting row.',
      })
      collector.incomplete = true
    }

    for (const variant of findPageSpellingVariants(candidate.summary.pages)) {
      record(collector, {
        ...ROOT_LOCATION,
        pointer,
        ruleId: 'page-spelling-variant',
        message: `Candidate ${id} counts ${variant.spellings.length} page values that differ only in spelling, so part of this grouping may reflect how the export writes URLs rather than distinct pages.`,
        evidence: `spellings: ${variant.spellings.join(' , ')}`,
        suggestion: 'Check whether these addresses are one page before reading the candidate.',
      })
    }

    record(collector, {
      ...ROOT_LOCATION,
      pointer,
      ruleId: 'cluster-review-candidate',
      message: `Candidate ${id} for review: ${candidate.summary.contributingPages} page(s) share one intent in segment ${candidate.segment.label}, over ${candidate.rows.length} supporting row(s). Review priority ${candidate.summary.priorityBand}.`,
      evidence: `intent: ${intentLabel} | impressions: ${candidate.summary.impressions} | clicks: ${candidate.summary.clicks} | lead page: ${excerpt(candidate.summary.leadPage ?? '', 60)}`,
      suggestion: 'Open the supporting rows in the map and decide whether these pages are meant to serve this intent together.',
    })

    return {
      id,
      reviewRank: index + 1,
      segment: candidate.segment.values,
      segmentLabel: candidate.segment.label,
      intent: candidate.intent,
      queries: [...new Set(candidate.rows.map((row) => row.query))].sort(byCodeUnit),
      pages: candidate.summary.pages,
      contributingPages: candidate.summary.contributingPages,
      impressions: candidate.summary.impressions,
      clicks: candidate.summary.clicks,
      leadPage: candidate.summary.leadPage,
      leadPageShareBasisPoints: candidate.summary.leadPageShareBasisPoints,
      priorityScore: candidate.summary.priorityScore,
      priorityBand: candidate.summary.priorityBand,
      supportingRowCount: candidate.rows.length,
      rowsTruncated,
      rows: candidate.rows.slice(0, limits.maxClusterRows).map(describeRow),
    }
  })

  const mapSeparated = separated.map((item, index) => {
    const pointer = `/separated-intents/${pad(index + 1)}`
    const held = item.segments.filter((entry) => !entry.qualifies).length
    record(collector, {
      ...ROOT_LOCATION,
      pointer,
      ruleId: 'cross-segment-intent-not-merged',
      message: `Intent appears in ${item.segments.length} segments and would meet the candidate thresholds if those segments were pooled, but ${held} of them ${held === 1 ? 'does' : 'do'} not meet the thresholds alone, so no cluster was formed across them.`,
      evidence: `intent: ${excerpt(item.intent, 80)} | segments: ${item.segments.map((entry) => entry.label).join(' ; ')}`,
      suggestion: 'If these segments serve one audience, re-run with a narrower segment column set to group them together.',
    })
    return {
      intent: item.intent,
      pooledContributingPages: item.pooledPages,
      pooledImpressions: item.pooledImpressions,
      segments: item.segments.map((entry) => ({
        segment: entry.values,
        segmentLabel: entry.label,
        contributingPages: entry.contributingPages,
        impressions: entry.impressions,
        qualifies: entry.qualifies,
      })),
    }
  })

  /**
   * Green on no evidence is a defect, not a clean bill of health.
   *
   * No row parsed means the run obtained nothing to group, so it is reported
   * and the run is incomplete. The finding is a warning, which means this
   * `incomplete` flag is the only thing standing between an entirely unread
   * export set and a `pass` -- removing it is the exact mutation that shipped
   * elsewhere in this catalog with a green suite, so a test pins it.
   */
  if (rows.length === 0) {
    record(collector, {
      ...ROOT_LOCATION,
      ruleId: 'no-rows-parsed',
      message: `No export row was used, so this run grouped nothing. ${files.length} export file(s) were found.`,
      suggestion: 'Point --root at the directory holding the query/page exports.',
    })
    collector.incomplete = true
  } else if (!groupsBounded && candidates.length === 0) {
    // Not a failure and not incomplete: the rows were read and none of the
    // intent groups reached the review thresholds. That is a real answer.
    record(collector, {
      ...ROOT_LOCATION,
      ruleId: 'no-candidates-found',
      message: `${groups.length} intent group(s) were examined from ${rows.length} row(s) and none reached the review thresholds.`,
      evidence: `minPages: ${thresholds.minPages} minImpressions: ${thresholds.minImpressions} minPageShareBasisPoints: ${thresholds.minPageShareBasisPoints}`,
    })
  }

  /**
   * Findings sort by (file, line, pointer, ruleId, message).
   *
   * Line precedes pointer because a row pointer carries a decimal line number,
   * and comparing `/rows/12` against `/rows/3` by code unit would order row 12
   * before row 3. File-level findings carry line 0 and so lead their file.
   */
  collector.rows.sort((left, right) =>
    byCodeUnit(left.file, right.file) ||
    left.line - right.line ||
    byCodeUnit(left.pointer, right.pointer) ||
    byCodeUnit(left.ruleId, right.ruleId) ||
    byCodeUnit(left.message, right.message))

  const findings = collector.rows.map(createFinding)
  const errors = findings.filter((item) => item.severity === 'error').length
  const warnings = findings.filter((item) => item.severity === 'warning').length
  const status = collector.incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  const segmentRows = new Map()
  for (const row of rows) {
    const existing = segmentRows.get(row.segment.key)
    if (existing === undefined) segmentRows.set(row.segment.key, { segment: row.segment, rows: 1 })
    else existing.rows += 1
  }
  const segmentKeys = [...segmentRows.keys()]
  const bands = { high: 0, medium: 0, low: 0 }
  for (const candidate of mapCandidates) bands[candidate.priorityBand] += 1

  const counts = {
    exportsFound: files.length,
    exportsRead,
    rows: rows.length,
    segments: segmentKeys.length,
    intentGroups: groups.length,
    candidates: mapCandidates.length,
    separatedIntents: mapSeparated.length,
    highPriority: bands.high,
    mediumPriority: bands.medium,
    lowPriority: bands.low,
  }

  const map = {
    schemaVersion: MAP_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    complete: status !== 'incomplete',
    match: settings.match,
    segmentColumns: [...settings.segmentColumns],
    columns: { ...settings.columns },
    thresholds: { ...thresholds },
    limits: { ...limits },
    counts,
    segments: segmentKeys
      .slice()
      .sort(byCodeUnit)
      .map((key) => {
        const entry = segmentRows.get(key)
        return { label: entry.segment.label, segment: entry.segment.values, rows: entry.rows }
      }),
    candidates: mapCandidates,
    separatedIntents: mapSeparated,
    notes: [...MAP_NOTES],
  }

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: groups.length,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      ...counts,
    },
    findings,
  }

  return { report, map, inputs }
}

/**
 * Serialise the derived map to its own destination. Exports are never touched.
 *
 * The destination is checked again here, immediately before the write and with
 * the exports this run actually read. The pre-flight in `resolveMapDestination`
 * could not do this part: a hard link to an export shares no path with it, so
 * only a device-and-inode comparison against a file the run has opened can see
 * that the destination *is* that export. `mkdir` runs only after that check,
 * and only under a parent the guard resolved.
 */
export async function writeMapFile(destination, map, options = {}) {
  const { inputs = [], exportRoot = null } = options
  const target = await assertWritableDestination(destination, {
    inputs,
    exportRoot,
    label: 'Map destination',
  })
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(map, null, 2)}\n`, 'utf8')
  return target
}

const SEVERITY_WIDTH = 7

export function formatReport(report) {
  const { summary } = report
  const lines = [
    `${summary.rows} row(s) from ${summary.exportsRead}/${summary.exportsFound} export(s) formed ${summary.checked} intent group(s) across ${summary.segments} segment(s): status ${report.status}.`,
    `${summary.candidates} review candidate(s) (${summary.highPriority} high, ${summary.mediumPriority} medium, ${summary.lowPriority} low), ${summary.separatedIntents} intent(s) kept separate by segment.`,
    `${summary.errors} error, ${summary.warnings} warning, ${summary.info} info. A candidate is an item for review, not a defect.`,
  ]
  for (const finding of report.findings) {
    const place = finding.line === undefined
      ? `${finding.location.file}${finding.location.pointer}`
      : `${finding.location.file}:${finding.line}${finding.location.pointer}`
    lines.push(`${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${place} ${finding.ruleId} ${finding.message}`)
  }
  return `${lines.join('\n')}\n`
}

export {
  byCodeUnit,
  decodeUtf8,
  excerpt,
  parseDelimited,
  parseFailureDetail,
  sanitize,
} from './csv.mjs'
export {
  MATCH_MODES,
  buildIntentGroups,
  canonicalPage,
  describeSegment,
  findPageSpellingVariants,
  findSeparatedIntents,
  intentKeyFor,
  normalizeQuery,
  priorityBandFor,
  summarizeGroup,
} from './cluster.mjs'
