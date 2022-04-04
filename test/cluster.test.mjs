import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildIntentGroups,
  canonicalPage,
  compareCandidates,
  describeSegment,
  findPageSpellingVariants,
  findSeparatedIntents,
  intentKeyFor,
  normalizeQuery,
  priorityBandFor,
  summarizeGroup,
} from '../src/cluster.mjs'
import { DEFAULT_THRESHOLDS } from '../src/index.mjs'

const T = DEFAULT_THRESHOLDS

function row(overrides) {
  const segment = overrides.segment ?? describeSegment(['region'], { region: 'US' })
  const query = overrides.query ?? 'solar panel cost'
  return {
    file: overrides.file ?? 'a.csv',
    line: overrides.line ?? 2,
    query,
    queryNormalized: normalizeQuery(query),
    page: overrides.page ?? '/a',
    segment,
    impressions: overrides.impressions ?? 100,
    clicks: overrides.clicks ?? 5,
    position: overrides.position ?? null,
  }
}

test('normalizeQuery folds case, width and whitespace and nothing else', () => {
  assert.equal(normalizeQuery('  Solar   PANEL  Cost '), 'solar panel cost')
  assert.equal(normalizeQuery('ＳＯＬＡＲ'), 'solar')
  assert.notEqual(normalizeQuery('solar panels'), normalizeQuery('solar panel'))
})

test('intentKeyFor tokens ignores word order and repetition; exact does not', () => {
  const a = intentKeyFor(normalizeQuery('heat pump grant scotland'), 'tokens')
  const b = intentKeyFor(normalizeQuery('scotland heat pump grant'), 'tokens')
  assert.equal(a, b)
  assert.equal(a, 'grant heat pump scotland')

  assert.equal(intentKeyFor(normalizeQuery('grant grant heat'), 'tokens'), 'grant heat')
  assert.notEqual(
    intentKeyFor(normalizeQuery('heat pump grant scotland'), 'exact'),
    intentKeyFor(normalizeQuery('scotland heat pump grant'), 'exact'),
  )
  assert.equal(intentKeyFor(normalizeQuery('Heat Pump'), 'exact'), 'heat pump')
})

test('intentKeyFor refuses an unknown match mode rather than defaulting', () => {
  assert.throws(() => intentKeyFor('x', 'fuzzy'), TypeError)
  assert.throws(() => intentKeyFor('x', 'token'), TypeError)
})

test('canonicalPage exposes spelling variants without rewriting the page value', () => {
  assert.equal(canonicalPage('https://example.com/a/'), canonicalPage('http://EXAMPLE.com/a'))
  assert.equal(canonicalPage('/guides/a/'), canonicalPage('/guides/a#top'))
  assert.notEqual(canonicalPage('/guides/a'), canonicalPage('/guides/b'))
  assert.notEqual(canonicalPage('https://example.com/a'), canonicalPage('https://other.com/a'))
  assert.equal(canonicalPage('/'), '/')
})

test('describeSegment keys distinct segments distinctly and cannot be collided by a value', () => {
  const gb = describeSegment(['region', 'locale'], { region: 'GB', locale: 'en-GB' })
  const us = describeSegment(['region', 'locale'], { region: 'US', locale: 'en-US' })
  assert.notEqual(gb.key, us.key)
  assert.equal(gb.label, 'region=GB, locale=en-GB')
  assert.deepEqual(gb.values, { region: 'GB', locale: 'en-GB' })

  // A value that contains the label separator must not produce the same key as
  // a different pair of values.
  const spliced = describeSegment(['region', 'locale'], { region: 'GB, locale=en-GB', locale: '' })
  assert.notEqual(spliced.key, gb.key)

  assert.equal(describeSegment([], {}).label, 'all rows')
  assert.equal(describeSegment(['region'], {}).label, 'region=(blank)')
})

test('summarizeGroup computes exact integer shares and a lead page', () => {
  const summary = summarizeGroup(
    [
      row({ page: '/a', impressions: 1400, clicks: 90, position: 4.2 }),
      row({ page: '/b', impressions: 900, clicks: 40, position: 7.8 }),
    ],
    T,
  )
  assert.equal(summary.impressions, 2300)
  assert.equal(summary.clicks, 130)
  assert.equal(summary.leadPage, '/a')
  assert.equal(summary.leadPageShareBasisPoints, 6087)
  assert.equal(summary.pages[1].shareBasisPoints, 3913)
  assert.equal(summary.contributingPages, 2)
  assert.equal(summary.priorityScore, 900)
  assert.equal(summary.qualifies, true)
})

test('a page below the share threshold does not make a candidate', () => {
  const rows = [
    row({ page: '/a', impressions: 1000 }),
    row({ page: '/b', impressions: 40 }),
  ]
  // 40 / 1040 is 384 basis points, below the 500 default.
  assert.equal(summarizeGroup(rows, T).contributingPages, 1)
  assert.equal(summarizeGroup(rows, T).qualifies, false)
  assert.equal(summarizeGroup(rows, { ...T, minPageShareBasisPoints: 300 }).qualifies, true)
})

test('a group below minImpressions does not qualify however it is split', () => {
  const rows = [row({ page: '/a', impressions: 30 }), row({ page: '/b', impressions: 30 })]
  assert.equal(summarizeGroup(rows, T).contributingPages, 2)
  assert.equal(summarizeGroup(rows, T).qualifies, false)
  assert.equal(summarizeGroup(rows, { ...T, minImpressions: 60 }).qualifies, true)
})

test('the lead page tie is broken by code unit, not by insertion order', () => {
  const forward = summarizeGroup([row({ page: '/z', impressions: 50 }), row({ page: '/a', impressions: 50 })], T)
  const reverse = summarizeGroup([row({ page: '/a', impressions: 50 }), row({ page: '/z', impressions: 50 })], T)
  assert.equal(forward.leadPage, '/a')
  assert.equal(reverse.leadPage, '/a')
})

test('rows for one page are added together and the best position kept', () => {
  const summary = summarizeGroup(
    [
      row({ page: '/a', impressions: 100, clicks: 4, position: 9.1, line: 2 }),
      row({ page: '/a', impressions: 50, clicks: 3, position: 3.3, line: 3 }),
    ],
    T,
  )
  assert.equal(summary.pages.length, 1)
  assert.equal(summary.pages[0].impressions, 150)
  assert.equal(summary.pages[0].clicks, 7)
  assert.equal(summary.pages[0].bestPosition, 3.3)
  assert.equal(summary.pages[0].rows, 2)
})

test('priorityBandFor reads the thresholds at their exact boundaries', () => {
  assert.equal(priorityBandFor(500, T), 'high')
  assert.equal(priorityBandFor(499, T), 'medium')
  assert.equal(priorityBandFor(100, T), 'medium')
  assert.equal(priorityBandFor(99, T), 'low')
  assert.equal(priorityBandFor(0, T), 'low')
})

test('buildIntentGroups keeps regions apart and orders groups deterministically', () => {
  const gb = describeSegment(['region'], { region: 'GB' })
  const us = describeSegment(['region'], { region: 'US' })
  const groups = buildIntentGroups(
    [
      row({ segment: us, query: 'solar battery storage', page: '/us/a' }),
      row({ segment: gb, query: 'solar battery storage', page: '/uk/a' }),
      row({ segment: gb, query: 'storage battery solar', page: '/uk/b' }),
    ],
    'tokens',
  )
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((group) => group.segment.values.region), ['GB', 'US'])
  assert.equal(groups[0].rows.length, 2)
  assert.equal(groups[1].rows.length, 1)
})

test('the same rows under exact matching split where token matching joined them', () => {
  const rows = [
    row({ query: 'solar battery storage', page: '/a' }),
    row({ query: 'storage battery solar', page: '/b' }),
  ]
  assert.equal(buildIntentGroups(rows, 'tokens').length, 1)
  assert.equal(buildIntentGroups(rows, 'exact').length, 2)
})

test('an intent split across segments is reported, not merged', () => {
  const gb = describeSegment(['region'], { region: 'GB' })
  const us = describeSegment(['region'], { region: 'US' })
  const groups = buildIntentGroups(
    [
      row({ segment: gb, query: 'solar battery storage', page: '/uk/a', impressions: 400 }),
      row({ segment: us, query: 'solar battery storage', page: '/us/a', impressions: 350 }),
    ],
    'tokens',
  )
  // Neither segment has two pages, so neither is a candidate.
  for (const group of groups) assert.equal(summarizeGroup(group.rows, T).qualifies, false)

  const separated = findSeparatedIntents(groups, T)
  assert.equal(separated.length, 1)
  assert.equal(separated[0].pooledPages, 2)
  assert.equal(separated[0].pooledImpressions, 750)
  assert.deepEqual(separated[0].segments.map((item) => item.qualifies), [false, false])
})

test('an intent confined to one segment is never reported as separated', () => {
  const us = describeSegment(['region'], { region: 'US' })
  const groups = buildIntentGroups(
    [
      row({ segment: us, query: 'solar battery storage', page: '/a', impressions: 400 }),
      row({ segment: us, query: 'solar battery storage', page: '/b', impressions: 350 }),
    ],
    'tokens',
  )
  assert.equal(summarizeGroup(groups[0].rows, T).qualifies, true)
  assert.deepEqual(findSeparatedIntents(groups, T), [])
})

test('segments that each qualify alone are not reported as separated', () => {
  const gb = describeSegment(['region'], { region: 'GB' })
  const us = describeSegment(['region'], { region: 'US' })
  const groups = buildIntentGroups(
    [
      row({ segment: gb, query: 'q one', page: '/uk/a', impressions: 400 }),
      row({ segment: gb, query: 'q one', page: '/uk/b', impressions: 300 }),
      row({ segment: us, query: 'q one', page: '/us/a', impressions: 400 }),
      row({ segment: us, query: 'q one', page: '/us/b', impressions: 300 }),
    ],
    'tokens',
  )
  assert.deepEqual(findSeparatedIntents(groups, T), [])
})

test('compareCandidates orders by priority, then volume, then two string keys', () => {
  const candidates = [
    { priorityScore: 90, impressions: 1290, segmentKey: 'b', intent: 'z' },
    { priorityScore: 900, impressions: 2300, segmentKey: 'a', intent: 'a' },
    { priorityScore: 300, impressions: 1220, segmentKey: 'a', intent: 'm' },
    { priorityScore: 300, impressions: 4000, segmentKey: 'c', intent: 'q' },
    { priorityScore: 300, impressions: 1220, segmentKey: 'a', intent: 'b' },
  ]
  assert.deepEqual(
    candidates.slice().sort(compareCandidates).map((item) => item.intent),
    ['a', 'q', 'b', 'm', 'z'],
  )
})

test('findPageSpellingVariants groups only the addresses that differ in spelling', () => {
  const variants = findPageSpellingVariants([
    { page: '/guides/a' },
    { page: '/guides/a/' },
    { page: '/guides/b' },
  ])
  assert.equal(variants.length, 1)
  assert.deepEqual(variants[0].spellings, ['/guides/a', '/guides/a/'])

  assert.deepEqual(findPageSpellingVariants([{ page: '/a' }, { page: '/b' }]), [])
})
