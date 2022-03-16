/**
 * Grouping query/page rows into candidate overlap clusters.
 *
 * Three decisions in this file are deliberate and are the ones most likely to
 * be "simplified" away by a later reader:
 *
 * 1. A candidate carries the rows that produced it. A cluster with no
 *    supporting rows is not reviewable -- nobody can check the tool's working,
 *    and nobody can tell which page or which export the claim came from.
 * 2. Rows are grouped inside a segment. The same query from a different
 *    region or locale is not assumed to be the same intent, because a UK page
 *    and a US page ranking for one phrase are usually two audiences rather
 *    than one problem. Pooling segments is the classic false positive.
 * 3. A candidate is a review item, not a verdict. Two pages ranking for one
 *    query is frequently deliberate. Nothing here decides that an overlap is
 *    undesirable, and the priority is an ordering for a review queue, not a
 *    claim about consequences.
 *
 * Every number below is integer arithmetic. Shares are basis points so the
 * threshold comparison is exact.
 */

import { byCodeUnit, sanitize } from './csv.mjs'

export const MATCH_MODES = Object.freeze(['exact', 'tokens'])

const TOKEN_SEPARATOR = /[^\p{L}\p{N}]+/u

/** The separator used to join a segment key to an intent key inside one Map. */
const GROUP_SEPARATOR = String.fromCharCode(0)

/**
 * Fold a query for comparison.
 *
 * NFKC plus case folding plus whitespace collapse, and nothing else. It is a
 * crude proxy: it does not know that "trainers" and "sneakers" are one intent,
 * and `toLowerCase` is the locale-independent fold, so a Turkish dotless i is
 * folded the same way everywhere rather than the way a Turkish reader expects.
 * Both limits are documented rather than hidden behind a cleverer default.
 */
export function normalizeQuery(raw) {
  return sanitize(raw).normalize('NFKC').toLowerCase()
}

/**
 * The key two queries must share to be treated as one intent.
 *
 * `exact` is the folded query itself. `tokens` is the sorted set of its
 * alphanumeric tokens, so "cost of solar panels" and "solar panels cost" meet.
 * Word order and repetition are discarded, which is exactly why this is a
 * candidate for a human to review and not a finding of fact.
 */
export function intentKeyFor(normalizedQuery, match) {
  if (!MATCH_MODES.includes(match)) throw new TypeError(`Unknown match mode "${sanitize(match)}"`)
  if (match === 'exact') return normalizedQuery
  const tokens = normalizedQuery.split(TOKEN_SEPARATOR).filter((token) => token !== '')
  return [...new Set(tokens)].sort(byCodeUnit).join(' ')
}

/**
 * A comparison form for two spellings of the same address.
 *
 * Used only to warn that a candidate may rest on URL spelling rather than on
 * two distinct pages. The page value itself is never rewritten: deciding that
 * `/a` and `/a/` are one page is a judgment about a site, not a fact about a
 * string, so the tool reports the coincidence and leaves the judgment alone.
 */
export function canonicalPage(raw) {
  const value = sanitize(raw)
  const withoutFragment = value.includes('#') ? value.slice(0, value.indexOf('#')) : value
  const trimTrailing = (path) => (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path)
  try {
    const url = new URL(withoutFragment)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return trimTrailing(withoutFragment).toLowerCase()
    return `${url.host.toLowerCase()}${trimTrailing(url.pathname)}${url.search}`
  } catch {
    return trimTrailing(withoutFragment)
  }
}

/**
 * Describe the segment a row belongs to.
 *
 * The internal key is JSON so that a value containing the separator cannot
 * collide with a different pair of values, and the label is sanitised because
 * it reaches both the report and the map.
 */
export function describeSegment(columns, values) {
  const ordered = columns.map((column) => sanitize(values[column] ?? ''))
  return {
    key: JSON.stringify([columns, ordered]),
    label: columns.length === 0
      ? 'all rows'
      : columns
        .map((column, index) => `${sanitize(column)}=${ordered[index] === '' ? '(blank)' : ordered[index]}`)
        .join(', '),
    values: Object.fromEntries(columns.map((column, index) => [sanitize(column), ordered[index]])),
  }
}

function summarizePages(rows) {
  const byPage = new Map()
  for (const row of rows) {
    const existing = byPage.get(row.page)
    if (existing === undefined) {
      byPage.set(row.page, {
        page: row.page,
        impressions: row.impressions,
        clicks: row.clicks,
        bestPosition: row.position,
        rows: 1,
      })
      continue
    }
    existing.impressions += row.impressions
    existing.clicks += row.clicks
    existing.rows += 1
    if (row.position !== null && (existing.bestPosition === null || row.position < existing.bestPosition)) {
      existing.bestPosition = row.position
    }
  }
  return [...byPage.values()].sort(
    (left, right) => right.impressions - left.impressions || byCodeUnit(left.page, right.page),
  )
}

/**
 * Turn one intent group into a candidate description.
 *
 * `qualifies` is the only judgment made, and it is a threshold judgment about
 * evidence volume: enough distinct pages each holding enough of the intent's
 * impressions, and enough impressions overall to be worth a person's time.
 */
export function summarizeGroup(rows, thresholds) {
  const pages = summarizePages(rows)
  const impressions = pages.reduce((total, page) => total + page.impressions, 0)
  const clicks = pages.reduce((total, page) => total + page.clicks, 0)
  const lead = pages[0]

  const shareOf = (pageImpressions) =>
    (impressions === 0 ? 0 : Math.round((pageImpressions * 10000) / impressions))

  // Integer comparison: `pageImpressions / impressions >= bp / 10000` without
  // ever forming a ratio, so the threshold means the same thing for every input.
  const contributing = pages.filter(
    (page) => page.impressions * 10000 >= thresholds.minPageShareBasisPoints * impressions,
  )

  const priorityScore = impressions - (lead === undefined ? 0 : lead.impressions)

  return {
    pages: pages.map((page) => ({ ...page, shareBasisPoints: shareOf(page.impressions) })),
    contributingPages: contributing.length,
    impressions,
    clicks,
    leadPage: lead === undefined ? null : lead.page,
    leadPageShareBasisPoints: lead === undefined ? 0 : shareOf(lead.impressions),
    /**
     * Impressions the leading page did not hold.
     *
     * It orders a review queue by how much of the intent is actually split,
     * and it says nothing about whether the split costs anything. An integer
     * subtraction keeps it exact and reproducible.
     */
    priorityScore,
    priorityBand: priorityBandFor(priorityScore, thresholds),
    qualifies: contributing.length >= thresholds.minPages && impressions >= thresholds.minImpressions,
  }
}

export function priorityBandFor(score, thresholds) {
  if (score >= thresholds.highPriorityScore) return 'high'
  if (score >= thresholds.mediumPriorityScore) return 'medium'
  return 'low'
}

/**
 * Group rows by (segment, intent).
 *
 * Insertion order is never relied on: the returned groups are sorted by their
 * segment key and intent key before anything downstream sees them.
 */
export function buildIntentGroups(rows, match) {
  const groups = new Map()
  for (const row of rows) {
    const intent = intentKeyFor(row.queryNormalized, match)
    const key = `${row.segment.key}${GROUP_SEPARATOR}${intent}`
    let group = groups.get(key)
    if (group === undefined) {
      group = { key, intent, segment: row.segment, rows: [] }
      groups.set(key, group)
    }
    group.rows.push(row)
  }
  return [...groups.values()].sort(
    (left, right) => byCodeUnit(left.segment.key, right.segment.key) || byCodeUnit(left.intent, right.intent),
  )
}

/**
 * Intents whose rows live in more than one segment.
 *
 * Reported when pooling the segments together would have produced a candidate
 * but at least one segment does not produce one on its own -- that is, exactly
 * the case where a segment-blind tool would have raised an overlap that the
 * regional split does not support. It is reported as information: the grouping
 * was kept separate on purpose, and a reader who knows the site may decide the
 * segments really do share one intent.
 */
export function findSeparatedIntents(groups, thresholds) {
  const byIntent = new Map()
  for (const group of groups) {
    const existing = byIntent.get(group.intent)
    if (existing === undefined) byIntent.set(group.intent, [group])
    else existing.push(group)
  }

  const separated = []
  for (const [intent, members] of byIntent) {
    if (members.length < 2) continue
    const pooled = summarizeGroup(members.flatMap((member) => member.rows), thresholds)
    if (!pooled.qualifies) continue
    const perSegment = members.map((member) => ({
      segment: member.segment,
      summary: summarizeGroup(member.rows, thresholds),
    }))
    if (perSegment.every((member) => member.summary.qualifies)) continue
    separated.push({
      intent,
      pooledPages: pooled.contributingPages,
      pooledImpressions: pooled.impressions,
      segments: perSegment
        .map((member) => ({
          key: member.segment.key,
          label: member.segment.label,
          values: member.segment.values,
          contributingPages: member.summary.contributingPages,
          impressions: member.summary.impressions,
          qualifies: member.summary.qualifies,
        }))
        .sort((left, right) => byCodeUnit(left.key, right.key)),
    })
  }
  return separated.sort(
    (left, right) => right.pooledImpressions - left.pooledImpressions || byCodeUnit(left.intent, right.intent),
  )
}

/**
 * Order the review queue.
 *
 * Priority first, then the volume behind it, then two string keys so that two
 * candidates with identical numbers still have one fixed order. No clock, no
 * locale, no hash iteration order.
 */
export function compareCandidates(left, right) {
  return (
    right.priorityScore - left.priorityScore ||
    right.impressions - left.impressions ||
    byCodeUnit(left.segmentKey, right.segmentKey) ||
    byCodeUnit(left.intent, right.intent)
  )
}

/** Page values in one group that differ only in spelling, grouped by their comparison form. */
export function findPageSpellingVariants(pages) {
  const byCanonical = new Map()
  for (const page of pages) {
    const canonical = canonicalPage(page.page)
    const existing = byCanonical.get(canonical)
    if (existing === undefined) byCanonical.set(canonical, [page.page])
    else if (!existing.includes(page.page)) existing.push(page.page)
  }
  return [...byCanonical.entries()]
    .filter(([, spellings]) => spellings.length > 1)
    .map(([canonical, spellings]) => ({ canonical, spellings: spellings.slice().sort(byCodeUnit) }))
    .sort((left, right) => byCodeUnit(left.canonical, right.canonical))
}
