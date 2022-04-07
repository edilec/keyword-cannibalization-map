# Overlap rules, thresholds and limits

This document is the catalog. `test/severity-table.test.mjs` asserts it against
the frozen `RULE_SEVERITY` table in `src/index.mjs` in both directions, so a
rule cannot be added, removed or re-graded in one place only.

## What a candidate is

A **candidate** is a group of pages that share one intent within one segment and
that clears the review thresholds. It is an item for a person to review.

It is not a defect, a diagnosis or a prediction. Two pages ranking for one query
is frequently deliberate — a hub page and a comparison page, a product page and
its documentation, a category and a guide. This tool has no way to tell a
deliberate arrangement from an accidental one, so it does not try, and nothing
it emits says that a candidate is undesirable or that changing it would improve
anything.

That is why `cluster-review-candidate` is `info` and why the presence of
candidates never sets `status` to `fail`. `fail` means the *export data* was
inconsistent or unparseable, which is a different statement entirely.

## How rows become candidates

1. Every export under `--root` is decoded as UTF-8, strictly. No entry is
   skipped for its name: a dot-prefixed export and a directory called
   `node_modules` are walked and read like any other file, because a
   name-based skip leaves a gap nothing in the report accounts for. Entries
   that are not `.csv` or `.tsv` are not exports and are passed over in
   silence; the depth and count limits, which report themselves, are what
   bound the walk.
2. The header is resolved to column indexes for `query`, `page`, `impressions`,
   `clicks`, the optional `position`, and each declared segment column.
3. Each row is validated. An invalid row is reported and dropped; it never
   contributes a number to a candidate.
4. The query is sanitised, NFKC-normalised and case-folded, then reduced to an
   **intent key**: the folded query itself under `--match exact`, or its sorted
   set of alphanumeric tokens under `--match tokens` (the default).
5. Rows are grouped by `(segment, intent key)`. **Segments are never pooled.**
6. A group becomes a candidate when at least `minPages` distinct pages each hold
   at least `minPageShareBasisPoints` of the group's impressions, and the group
   holds at least `minImpressions` impressions in total.
7. Candidates are ordered by priority score, then impressions, then segment key,
   then intent key — all by UTF-16 code unit, never by locale collation.

### Priority

`priorityScore` is `clusterImpressions - leadPageImpressions`: the impressions
of the intent that the leading page did not hold. It is an integer subtraction,
it orders the review queue, and it says nothing about consequences. A candidate
where one page holds 93% of the impressions gets a low score not because it is
harmless but because there is less of it to look at.

| Band | Condition |
| --- | --- |
| `high` | `priorityScore >= highPriorityScore` |
| `medium` | `priorityScore >= mediumPriorityScore` |
| `low` | below both |

### Segments

Rows are grouped inside a segment, and the default segment is
`region` + `locale`. The same query from a different region is a different row
set until somebody says otherwise, because pooling regions is the classic false
positive of this exercise.

An export with no regional dimension is handled by declaring the empty segment
set explicitly — `--no-segments`, or `"segmentColumns": []` in a configuration
file. That is an assertion by the person running the tool that these rows really
are one segment. The tool never makes that assertion on their behalf.

When pooling the segments *would* have produced a candidate but at least one
segment does not produce one on its own, `cross-segment-intent-not-merged` says
so. It is information, not a correction: a reader who knows the site may decide
the segments do share one intent, and can re-run with a narrower segment set.

## Rule catalog

| Rule | Severity | Meaning |
| --- | --- | --- |
| `cluster-review-candidate` | info | A group of pages shares one intent in one segment and cleared the thresholds. An item for review. |
| `cluster-rows-exceeded` | error | A candidate is supported by more rows than `maxClusterRows`; only the first were recorded, so it is not fully evidenced. |
| `cross-segment-intent-not-merged` | info | An intent spans segments; pooling them would clear the thresholds but at least one segment does not clear them alone. |
| `directory-too-deep` | error | Directory nesting exceeded `maxDepth`; the contents were not examined. |
| `export-empty` | warning | The export holds a header and no data rows. |
| `export-not-utf8` | error | The export is not valid UTF-8; none of its rows were read. |
| `export-too-large` | error | The export exceeds `maxExportBytes`; it was not read. |
| `export-unreadable` | error | A directory or file could not be read, resolved, or is not a regular file. |
| `header-column-duplicate` | error | A column the run needs appears twice, so its values are ambiguous; the file was not read. |
| `header-column-missing` | error | A required column or a declared segment column is absent; the file's rows were not read. |
| `header-missing` | error | The export holds no header row. |
| `metrics-inconsistent` | error | A row reports more clicks than impressions; the row was not used. |
| `no-candidates-found` | info | Rows were grouped and no group reached the thresholds. A complete answer, not a failure. |
| `no-rows-parsed` | warning | No row was used at all, so the run grouped nothing. Always accompanied by `status: "incomplete"`. |
| `page-missing` | error | A row has no page; it cannot support a candidate. |
| `page-spelling-variant` | warning | A candidate counts page values that differ only in trailing slash, scheme or fragment. |
| `path-escapes-root` | error | An entry resolves outside the real export root and was refused unread. |
| `position-invalid` | warning | Average position is not a non-negative number. The row is kept with an unknown position. |
| `query-missing` | error | A row has no query; it cannot belong to an intent. |
| `row-column-count-mismatch` | error | A row has a different field count from the header; the row was not used. |
| `row-duplicate` | warning | The same query, page and segment appear twice in one export. Both rows are kept and their metrics added. |
| `row-field-too-long` | error | A field exceeds `maxFieldChars`; the row was not used. |
| `row-metric-invalid` | error | Impressions or clicks are not plain non-negative integers; the row was not used. |
| `too-many-exports` | error | The export set exceeds `maxExports`; the remaining files were not read. |
| `too-many-intent-groups` | error | The rows produce more groups than `maxIntentGroups`; no candidate was derived. |
| `too-many-rows` | error | An export exceeds `maxRows`; none of its rows were used. |
| `unterminated-quoted-field` | error | A quoted field is never closed, so the row structure is not trustworthy. |

## Thresholds

| Threshold | Flag | Default | Constraint |
| --- | --- | ---: | --- |
| `minPages` | `--min-pages` | 2 | at least 2; one page cannot overlap itself |
| `minImpressions` | `--min-impressions` | 100 | at least 1; a candidate with no impressions has no evidence |
| `minPageShareBasisPoints` | `--min-page-share-bp` | 500 | 1 to 10000 |
| `highPriorityScore` | `--high-priority-score` | 500 | not below `mediumPriorityScore` |
| `mediumPriorityScore` | `--medium-priority-score` | 100 | not negative |

Shares are basis points so the comparison
`pageImpressions * 10000 >= minPageShareBasisPoints * clusterImpressions` is
exact integer arithmetic.

## Limits

Every limit below is enforced, overridable and reported by name. Exceeding one
produces a finding and `status: "incomplete"` — never a silently shorter answer,
and never a pass.

| Limit | Flag | Default |
| --- | --- | ---: |
| `maxExports` | `--max-exports` | 64 |
| `maxExportBytes` | `--max-export-bytes` | 4194304 |
| `maxRows` | `--max-rows` | 50000 |
| `maxFieldChars` | `--max-field-chars` | 400 |
| `maxDepth` | `--max-depth` | 6 |
| `maxIntentGroups` | `--max-intent-groups` | 5000 |
| `maxClusterRows` | `--max-cluster-rows` | 200 |

`maxRows` counts records per export including the header. The configuration file
is separately bounded at 65536 bytes before it is read.

There is deliberately **no wall-clock timeout**. Every phase is bounded by the
counts above and by nothing else: there is no network call, no subprocess and no
unbounded loop, so the work is a function of input size rather than of elapsed
time. A time limit would make the result depend on how busy the machine was,
which is exactly the nondeterminism the rest of this document rules out.

## Configuration file

`--config FILE` reads a JSON object. Unknown keys are refused rather than
ignored: a typo that silently defaults is the same defect as an ignored limit.

| Key | Shape |
| --- | --- |
| `columns` | object mapping the roles `clicks`, `impressions`, `page`, `position`, `query` to export column names |
| `limits` | object of the limits above |
| `match` | `"exact"` or `"tokens"` |
| `segmentColumns` | array of column names, at most 4; `[]` asserts one segment |
| `thresholds` | object of the thresholds above |

Command-line options override the configuration file key by key, so
`--min-pages 3` beside a file that sets `minImpressions` keeps both.

## Determinism

Findings sort by `(location.file, line, location.pointer, ruleId, message)`.
Line precedes pointer because a row pointer carries a decimal line number, and
comparing `/rows/12` against `/rows/3` by code unit would order row 12 first.

Directory entries are sorted by code unit before they are visited, so the order
exports are read never depends on the order the filesystem returned them. No
wall clock, no random seed, no locale collation and no hash iteration order
reaches the output. Two runs over identical inputs produce byte-identical
stdout.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | every export was read and the data is internally consistent |
| 1 | the export data failed the check |
| 2 | invalid usage or configuration (stdout empty), or evidence that was missing, undecodable or bounded out (an `incomplete` report on stdout) |

## What this tool cannot conclude

- **Whether an overlap matters.** It sees impressions, clicks, positions and
  URLs. It does not see the site's intent, its internal linking, its navigation
  or its commercial purpose, and those decide whether two pages sharing a query
  is a problem or the plan.
- **Whether consolidating a candidate would change anything.** Nothing here
  models search behaviour, and no message predicts an outcome.
- **What a query means.** Intent matching is lexical. It does not know that
  "trainers" and "sneakers" are one intent, that "solar panels" and "solar
  panel" are the same product, or that "of" is a stop word. Under `tokens`,
  word order and repetition are discarded and stop words are kept, so a
  candidate can be a coincidence of wording and a real overlap can be missed.
- **Whether two page values are one page.** Trailing slashes, schemes and
  fragments are reported as spelling variants, never merged.
- **Whether a segment boundary is the right one.** The tool separates the
  segments it was given. If your export has no regional column, it cannot tell
  a UK row from a US one.
- **Anything about rows it did not read.** An export that was not decoded,
  a file bounded out by a limit, or a row that failed validation contributes
  nothing, and the run says `incomplete` rather than reporting a result it does
  not have.
- **Anything from outside the export set.** There are no network calls. Ranking
  data, index coverage and live SERP state are not consulted, and a claim that
  would need them is not made.
