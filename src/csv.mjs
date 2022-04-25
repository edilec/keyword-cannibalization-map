/**
 * Decoding, sanitising and delimited parsing for one query/page export.
 *
 * Nothing in this module touches the filesystem, the clock, the locale or the
 * network. It turns bytes into records, or it says precisely why it could not.
 * An export is untrusted data: every value that leaves here has had its
 * control characters removed, because a query string containing a newline
 * would otherwise forge lines in the human-readable report.
 */

/**
 * Order by UTF-16 code unit.
 *
 * `localeCompare` depends on ICU data that varies between Node builds and
 * treats punctuation as ignorable, which produced a real ordering difference
 * elsewhere in this catalog. Every sort in this tool routes through here.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Characters removed before any export value is embedded in a report or map.
 *
 * Every class here earned its place by getting through a narrower one:
 *
 * - **C0 and DEL.** A newline in a query forges a line in the human report.
 * - **C1 (U+0080-U+009F).** The class that covered C0 and the Unicode line
 *   separators let this whole range through. U+0085 (NEL) *is* a line break to
 *   every consumer that splits on Unicode line boundaries -- Python's
 *   `splitlines`, most editors, most log viewers -- so a query carrying one
 *   forges a report line for them while the LF-counting test sees nothing
 *   wrong. U+009B is an 8-bit CSI and opens a terminal escape sequence.
 * - **U+2028 and U+2029.** Line and paragraph separators, the same forgery.
 * - **Bidi controls.** U+202E (right-to-left override) reverses the displayed
 *   order of everything after it, so a page or a file name carrying one shows
 *   a reader something other than what the tool matched on; the marks, the
 *   other embeddings and the isolates do the same thing less completely.
 *
 * Built from code points rather than written literally, because a literal
 * U+2028 inside a regular expression literal is a syntax error in a module.
 */
const CONTROL_RANGES = Object.freeze([
  [0x0000, 0x001f],
  [0x007f, 0x007f],
  [0x0080, 0x009f],
  [0x2028, 0x2029],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
])

const CONTROL = new RegExp(
  `[${CONTROL_RANGES.map(([first, last]) =>
    (first === last
      ? String.fromCharCode(first)
      : `${String.fromCharCode(first)}-${String.fromCharCode(last)}`)).join('')}]`,
  'g',
)

const BOM = String.fromCharCode(0xfeff)

/**
 * Flatten an untrusted string to a single safe line.
 *
 * Applied to every identifier, path, column name, query and page URL that
 * reaches the report or the map -- not only to evidence excerpts. A tool in
 * this catalog sanitised its evidence field and not its ids, and an id
 * carrying a newline forged extra lines in its human report. A file name is an
 * identifier this tool does not choose, so the same rule holds for it.
 */
export function sanitize(value) {
  return String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
}

export const EXCERPT_LIMIT = 200

/** A bounded, single-line excerpt. Export content is data, never an instruction. */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = sanitize(value)
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the entire point. Decoding leniently and then looking for
 * U+FFFD in the result cannot distinguish undecodable bytes from a file that
 * legitimately contains a replacement character, and that confusion has let an
 * unreadable input report a pass. The decoder decides; the decoded text never
 * gets a vote. Every byte source in this tool -- exports and the configuration
 * file alike -- goes through this function.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/**
 * Describe a JSON parse failure without repeating the document.
 *
 * V8 reports a parse failure two ways, and one of them quotes the input it
 * choked on: `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`,
 * or a ten-character prefix followed by `"..."`. A configuration file short
 * enough to be only a credential is therefore reproduced in full by its own
 * error message, and `excerpt` does not help: it strips controls and cuts from
 * the end, while the quoted copy carries no controls and sits at the front,
 * well inside the limit.
 *
 * The position, line and column are the useful half and describe the document
 * without quoting it. The quoted half never leaves this function. V8 omits the
 * position from the quoting form, so that case names the offending token alone
 * rather than inventing a location for it; callers still pass the result
 * through `excerpt`, because that token is one character of untrusted input
 * and may itself be a control.
 */
export function parseFailureDetail(error) {
  const message = String(error?.message ?? 'could not be parsed')
  const position = /at position \d+(?: \(line \d+ column \d+\))?/.exec(message)
  if (position) return message.slice(0, position.index + position[0].length)
  const token = /^Unexpected token (.+?), ".*?"(?:\.\.\.)? is not valid JSON$/s.exec(message)
  if (token) return `unexpected token ${token[1]} in the document`
  if (/^Unexpected end of JSON input$/.test(message)) return message
  return 'the document could not be parsed as JSON'
}

export function stripBom(text) {
  return text.startsWith(BOM) ? text.slice(1) : text
}

/** Tab-separated exports are common enough to detect from the extension. */
export function delimiterFor(filename) {
  return filename.toLowerCase().endsWith('.tsv') ? '\t' : ','
}

/** Column names are matched after sanitising, folding case and collapsing runs of spaces. */
export function normalizeColumnName(name) {
  return sanitize(name).toLowerCase()
}

const COUNT_PATTERN = /^\d{1,12}$/
const POSITION_PATTERN = /^\d{1,9}(\.\d{1,6})?$/

/**
 * Parse an impression or click count.
 *
 * Only an unadorned non-negative integer is accepted. A thousands separator,
 * a percentage sign or a float is refused rather than coerced: guessing what
 * "1,200" meant is how an export silently turns into different numbers.
 */
export function parseCount(raw) {
  const value = String(raw).trim()
  return COUNT_PATTERN.test(value) ? Number(value) : null
}

/** Average position. Empty means "not reported", which is not the same as invalid. */
export function parsePosition(raw) {
  const value = String(raw).trim()
  if (value === '') return { ok: true, value: null }
  if (!POSITION_PATTERN.test(value)) return { ok: false, value: null }
  return { ok: true, value: Number(value) }
}

/**
 * Parse delimited text into records.
 *
 * A hand-written state machine rather than a split on the delimiter: a query
 * containing a comma inside quotes is ordinary in a search export, and
 * splitting would shift every later column by one and quietly produce wrong
 * numbers. Quoting follows RFC 4180 -- a field is quoted only when the quote
 * is its first character, and a doubled quote inside a quoted field is one
 * literal quote.
 *
 * Two bounds are enforced here rather than after the fact, so an oversized
 * export is never fully materialised: `maxRecords` stops the scan and
 * `maxFieldChars` marks the offending record. Both are reported by the caller
 * as findings; neither is a silent truncation.
 */
export function parseDelimited(text, { delimiter, maxRecords, maxFieldChars }) {
  if (typeof delimiter !== 'string' || delimiter.length !== 1) {
    throw new TypeError('Delimiter must be a single character')
  }
  if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords must be a positive integer')
  if (!Number.isInteger(maxFieldChars) || maxFieldChars < 1) {
    throw new TypeError('maxFieldChars must be a positive integer')
  }

  const records = []
  const overlong = new Set()
  let unterminatedQuote = false
  let exceeded = false

  let fields = []
  let field = ''
  let inQuotes = false
  let fieldStarted = false
  let recordStarted = false
  let line = 1
  let recordLine = 1

  const endField = () => {
    if (field.length > maxFieldChars) {
      overlong.add(recordLine)
      field = field.slice(0, maxFieldChars)
    }
    fields.push(field)
    field = ''
    fieldStarted = false
  }

  const endRecord = () => {
    if (!recordStarted && fields.length === 0 && field === '') return true
    endField()
    if (records.length >= maxRecords) {
      exceeded = true
      return false
    }
    records.push({ line: recordLine, fields })
    fields = []
    recordStarted = false
    return true
  }

  let index = 0
  while (index < text.length) {
    const character = text[index]

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        inQuotes = false
        index += 1
        continue
      }
      if (character === '\n') line += 1
      field += character
      index += 1
      continue
    }

    if (character === '"' && !fieldStarted) {
      inQuotes = true
      fieldStarted = true
      recordStarted = true
      index += 1
      continue
    }
    if (character === delimiter) {
      endField()
      recordStarted = true
      index += 1
      continue
    }
    if (character === '\r' || character === '\n') {
      const width = character === '\r' && text[index + 1] === '\n' ? 2 : 1
      if (!endRecord()) break
      line += 1
      recordLine = line
      index += width
      continue
    }

    field += character
    fieldStarted = true
    recordStarted = true
    index += 1
  }

  if (!exceeded) {
    if (inQuotes) {
      unterminatedQuote = true
      recordStarted = true
    }
    endRecord()
  }

  return {
    records,
    exceeded,
    unterminatedQuote,
    overlongRecordLines: [...overlong].sort((left, right) => left - right),
  }
}
