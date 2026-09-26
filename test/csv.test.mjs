import assert from 'node:assert/strict'
import test from 'node:test'

import {
  byCodeUnit,
  decodeUtf8,
  delimiterFor,
  excerpt,
  normalizeColumnName,
  parseCount,
  parseDelimited,
  parsePosition,
  sanitize,
  stripBom,
} from '../src/csv.mjs'

const parse = (text, overrides = {}) =>
  parseDelimited(text, { delimiter: ',', maxRecords: 100, maxFieldChars: 200, ...overrides })

test('byCodeUnit orders by code unit, where collation would not', () => {
  // 'S' is 0x53 and '_' is 0x5F, so a code-unit sort puts MAXS first. ICU
  // collation treats the underscore as ignorable punctuation and puts
  // MAX_ENTRIES first -- the exact difference that produced a real ordering
  // bug in this catalog. The expected array below is not the input order.
  assert.equal(byCodeUnit('MAXS', 'MAX_ENTRIES'), -1)
  assert.equal(byCodeUnit('MAX_ENTRIES', 'MAXS'), 1)
  assert.equal(byCodeUnit('MAXS', 'MAXS'), 0)
  assert.deepEqual(
    ['MAX_ENTRIES', 'MAXS', 'MAXA', 'MAX-ONE'].sort(byCodeUnit),
    ['MAX-ONE', 'MAXA', 'MAXS', 'MAX_ENTRIES'],
  )
})

/** How a consumer that respects Unicode line boundaries splits text. */
const UNICODE_LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/

/**
 * Every class below got through a narrower version of this filter somewhere,
 * and each is named so a failure says which one came back.
 *
 * C1 is the class this tool actually shipped without: a filter covering C0 and
 * the Unicode line separators let U+0085 (NEL) through, and NEL *is* a line
 * break to anything that splits on Unicode line boundaries -- so a value
 * carrying one forged a line in the human report while a test counting LFs saw
 * a report of exactly the right length.
 */
const CONTROL_CLASSES = [
  ['C0 NUL', 0x00], ['C0 BEL', 0x07], ['C0 TAB', 0x09], ['C0 LF', 0x0a], ['C0 VT', 0x0b],
  ['C0 FF', 0x0c], ['C0 CR', 0x0d], ['C0 ESC', 0x1b], ['C0 US', 0x1f],
  ['DEL', 0x7f],
  ['C1 PAD', 0x80], ['C1 NEL', 0x85], ['C1 CSI', 0x9b], ['C1 APC', 0x9f],
  ['line separator', 0x2028], ['paragraph separator', 0x2029],
  ['LRM', 0x200e], ['RLM', 0x200f],
  ['LRE', 0x202a], ['RLE', 0x202b], ['PDF', 0x202c], ['LRO', 0x202d], ['RLO', 0x202e],
  ['LRI', 0x2066], ['RLI', 0x2067], ['FSI', 0x2068], ['PDI', 0x2069],
]

test('sanitize removes every class of character that forges or hides output', () => {
  const forged = `first${String.fromCharCode(10)}ERROR   forged line`
  assert.equal(sanitize(forged), 'first ERROR forged line')
  assert.equal(sanitize(forged).includes(String.fromCharCode(10)), false)

  const separators = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c${String.fromCharCode(0)}d`
  assert.equal(sanitize(separators), 'a b c d')

  for (const [name, code] of CONTROL_CLASSES) {
    const character = String.fromCharCode(code)
    assert.equal(sanitize(`x${character}y`).includes(character), false, `${name} survived sanitize`)
    assert.equal(sanitize(`x${character}y`), 'x y', `${name} was not replaced by a space`)
  }
})

test('a C1 line break cannot forge a line for a consumer that splits on Unicode boundaries', () => {
  // The LF-only version of this assertion is what let U+0085 ship: the forged
  // line is invisible to `split('\n')` and plain to `splitlines()`.
  for (const code of [0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029]) {
    const forged = `first${String.fromCharCode(code)}ERROR   forged line`
    assert.equal(sanitize(forged).split(UNICODE_LINE_BREAK).length, 1, `U+${code.toString(16)} forged a line`)
  }
})

test('a bidi override cannot reverse what a reader sees', () => {
  // U+202E makes the text after it display right to left, so `/admin` shows as
  // `nimda/` and an id shows as something the tool never matched on.
  const reversed = `report${String.fromCharCode(0x202e)}gpj.exe`
  assert.equal(sanitize(reversed), 'report gpj.exe')
  for (const code of [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    assert.equal(excerpt(`a${String.fromCharCode(code)}b`).includes(String.fromCharCode(code)), false)
  }
})

test('sanitize keeps ordinary text intact', () => {
  assert.equal(sanitize('  solar panel   cost  '), 'solar panel cost')
  assert.equal(sanitize('/guides/solar-installation-cost'), '/guides/solar-installation-cost')
})

test('excerpt bounds its output and marks the truncation', () => {
  const long = 'q'.repeat(500)
  const short = excerpt(long, 40)
  assert.equal(short.length, 43)
  assert.equal(short.endsWith('...'), true)
  assert.equal(excerpt('short', 40), 'short')
  assert.equal(excerpt(long).length, 203)
})

test('decodeUtf8 refuses undecodable bytes and never guesses from content', () => {
  assert.deepEqual(decodeUtf8(new Uint8Array([0x61, 0x62])), { ok: true, text: 'ab' })
  assert.equal(decodeUtf8(new Uint8Array([0xff, 0xfe, 0xfd])).ok, false)
  assert.equal(decodeUtf8(new Uint8Array([0x61, 0xc3, 0x28])).ok, false)

  // A file that legitimately holds U+FFFD is valid UTF-8. Inferring "not UTF-8"
  // from a replacement character in decoded text is the defect this guards.
  const withReplacement = new TextEncoder().encode(`a${String.fromCharCode(0xfffd)}b`)
  const decoded = decodeUtf8(withReplacement)
  assert.equal(decoded.ok, true)
  assert.equal(decoded.text.length, 3)
})

test('stripBom, delimiterFor and normalizeColumnName', () => {
  assert.equal(stripBom(`${String.fromCharCode(0xfeff)}query,page`), 'query,page')
  assert.equal(stripBom('query,page'), 'query,page')
  assert.equal(delimiterFor('export.tsv'), String.fromCharCode(9))
  assert.equal(delimiterFor('EXPORT.TSV'), String.fromCharCode(9))
  assert.equal(delimiterFor('export.csv'), ',')
  assert.equal(normalizeColumnName('  Landing   Page '), 'landing page')
})

test('parseCount accepts only plain non-negative integers', () => {
  assert.equal(parseCount('0'), 0)
  assert.equal(parseCount(' 1400 '), 1400)
  assert.equal(parseCount('1,200'), null)
  assert.equal(parseCount('1200.0'), null)
  assert.equal(parseCount('-5'), null)
  assert.equal(parseCount('1e3'), null)
  assert.equal(parseCount(''), null)
  assert.equal(parseCount('12%'), null)
})

test('parsePosition separates "not reported" from "not a number"', () => {
  assert.deepEqual(parsePosition(''), { ok: true, value: null })
  assert.deepEqual(parsePosition('  '), { ok: true, value: null })
  assert.deepEqual(parsePosition('4.2'), { ok: true, value: 4.2 })
  assert.deepEqual(parsePosition('12'), { ok: true, value: 12 })
  assert.deepEqual(parsePosition('n/a'), { ok: false, value: null })
  assert.deepEqual(parsePosition('-1'), { ok: false, value: null })
})

test('a quoted field keeps its delimiter instead of shifting every later column', () => {
  const result = parse('query,page,impressions\n"solar panels, batteries",/a,210\n')
  assert.equal(result.records.length, 2)
  assert.deepEqual(result.records[1].fields, ['solar panels, batteries', '/a', '210'])
})

test('a doubled quote inside a quoted field is one literal quote', () => {
  const result = parse('query\n"say ""hi"" now"\n')
  assert.deepEqual(result.records[1].fields, ['say "hi" now'])
})

test('a quote that is not the first character of a field stays literal', () => {
  const result = parse('query\n12" monitor\n')
  assert.deepEqual(result.records[1].fields, ['12" monitor'])
})

test('CRLF, lone CR and a newline inside quotes are all handled', () => {
  const crlf = parse('a,b\r\n1,2\r\n')
  assert.deepEqual(crlf.records.map((item) => item.fields), [['a', 'b'], ['1', '2']])

  const cr = parse('a,b\r1,2')
  assert.deepEqual(cr.records.map((item) => item.fields), [['a', 'b'], ['1', '2']])

  const embedded = parse('query,page\n"two\nlines",/a\nnext,/b\n')
  assert.deepEqual(embedded.records[1].fields, ['two\nlines', '/a'])
  assert.deepEqual(embedded.records[2], { line: 4, fields: ['next', '/b'] })
})

test('blank lines are skipped and line numbers stay true to the file', () => {
  const result = parse('a,b\n\n1,2\n\n3,4\n')
  assert.deepEqual(result.records.map((item) => item.line), [1, 3, 5])
})

test('maxRecords stops the scan and is reported rather than silently truncating', () => {
  const result = parse('a\n1\n2\n3\n', { maxRecords: 3 })
  assert.equal(result.exceeded, true)
  assert.equal(result.records.length, 3)

  const within = parse('a\n1\n2\n', { maxRecords: 3 })
  assert.equal(within.exceeded, false)
  assert.equal(within.records.length, 3)
})

test('maxFieldChars marks the offending record instead of shortening it in silence', () => {
  const result = parse(`a,b\nshort,${'x'.repeat(50)}\nfine,ok\n`, { maxFieldChars: 10 })
  assert.deepEqual(result.overlongRecordLines, [2])
  assert.equal(result.records[1].fields[1].length, 10)
  assert.deepEqual(result.records[2].fields, ['fine', 'ok'])
})

test('an unterminated quote is reported, not absorbed', () => {
  const result = parse('a,b\n"never closed,2\n')
  assert.equal(result.unterminatedQuote, true)
})

test('parseDelimited refuses a configuration it cannot honour', () => {
  assert.throws(() => parseDelimited('a', { delimiter: ',,', maxRecords: 1, maxFieldChars: 1 }), TypeError)
  assert.throws(() => parseDelimited('a', { delimiter: ',', maxRecords: 0, maxFieldChars: 1 }), TypeError)
  assert.throws(() => parseDelimited('a', { delimiter: ',', maxRecords: 1, maxFieldChars: 0 }), TypeError)
})

test('a tab-delimited export parses on its own delimiter', () => {
  const tab = String.fromCharCode(9)
  const result = parse(`a${tab}b\n1${tab}2\n`, { delimiter: tab })
  assert.deepEqual(result.records.map((item) => item.fields), [['a', 'b'], ['1', '2']])
})
