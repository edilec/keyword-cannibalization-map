# Keyword Cannibalization Map

Group query/page exports into **candidate overlap clusters** — pages that share
one search intent within one segment — and order them as a review queue, with
the source rows that produced every candidate travelling with it.

- **Repository:** [edilec/keyword-cannibalization-map](https://github.com/edilec/keyword-cannibalization-map)
- **Area:** Content & Publishing
- **License:** MIT

## A candidate is not a defect

Two pages ranking for one query is frequently deliberate: a hub and a
comparison page, a product page and its documentation, a category and a guide.
This tool cannot tell a deliberate arrangement from an accidental one, so it
does not try.

- Candidates are reported at `info` severity and **never fail a run**.
- `status: "fail"` means the *export data* was inconsistent or unparseable —
  more clicks than impressions, a thousands separator in a count, a short row.
- The priority score orders a review queue. It is the impressions the leading
  page did not hold, and it asserts nothing about consequences.
- No message in this tool says a cluster is undesirable, and none predicts what
  changing one would do.

## Install and run

Node 22 or newer. Zero runtime dependencies, zero dev dependencies.

```sh
node bin/keyword-cannibalization-map.mjs --root examples/exports-clean
node bin/keyword-cannibalization-map.mjs --root examples/exports-clean --json
node bin/keyword-cannibalization-map.mjs --root examples/exports-clean --map build/cannibalization.map.json
node bin/keyword-cannibalization-map.mjs --help
```

`stdout` carries the report and nothing else, so it pipes straight into a JSON
parser. Diagnostics go to `stderr`.

## Input

A directory of `.csv` or `.tsv` exports. Each needs a header row with columns
for `query`, `page`, `impressions` and `clicks`; `position` is optional, and the
segment columns (`region` and `locale` by default) are required because the
grouping depends on them. Column names are matched case-insensitively and can be
remapped in a configuration file.

```csv
query,page,region,locale,impressions,clicks,position
solar panel installation cost,/guides/solar-installation-cost,US,en-US,1400,90,4.2
solar panel installation cost,/blog/solar-pricing-2026,US,en-US,900,40,7.8
```

## Output

```
12 row(s) from 3/3 export(s) formed 8 intent group(s) across 3 segment(s): status pass.
3 review candidate(s) (1 high, 1 medium, 1 low), 2 intent(s) kept separate by segment.
0 error, 0 warning, 5 info. A candidate is an item for review, not a defect.
INFO    ./candidates/cluster-0001 cluster-review-candidate Candidate cluster-0001 for review: 2 page(s) share one intent in segment region=US, locale=en-US, over 2 supporting row(s). Review priority high.
```

`--map FILE` writes the derived artifact: every candidate with its pages, its
share of impressions, its priority band and **the rows it was built from**. The
destination is refused if it lies inside `--root`; exports are read, never
written.

## Regional intent stays separate

Rows are grouped inside a segment, and the default segment is `region` +
`locale`. The same query from a different region is a different row set until
somebody says otherwise — pooling regions is the classic false positive of this
exercise.

When pooling segments *would* have produced a candidate but at least one segment
does not produce one alone, the run says so at `info` severity rather than
merging them. If your export genuinely has one audience, say so explicitly with
`--no-segments`; the tool will not assume it.

## Library

```js
import { mapQueryPageExports, writeMapFile } from 'keyword-cannibalization-map'

const { report, map } = await mapQueryPageExports({ root: 'exports' })
for (const candidate of map.candidates) {
  console.log(candidate.id, candidate.priorityBand, candidate.rows.length)
}
```

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | every export was read and the data is internally consistent |
| 1 | the export data failed the check |
| 2 | invalid usage or configuration (stdout empty), or evidence that was missing, undecodable or bounded out (an `incomplete` report on stdout) |

An unreadable input is `incomplete`, never `pass`. A run that parsed no row is
`incomplete` too: green on no evidence is a defect, not a clean bill of health.

## Limits and non-goals

Full detail in [`docs/overlap-rules.md`](./docs/overlap-rules.md). In short,
this tool **cannot** conclude:

- **Whether an overlap matters.** It sees impressions, clicks, positions and
  URLs — not the site's purpose, navigation or internal linking, which are what
  decide whether two pages sharing a query is a problem or the plan.
- **Whether consolidating a candidate would help.** Nothing here models search
  behaviour, and no output predicts an outcome.
- **What a query means.** Matching is lexical: no synonyms, no morphology, no
  stop-word handling. `tokens` mode discards word order, so "heat pump grant
  scotland" and "scotland heat pump grant" meet — and "solar panel" and "solar
  panels" do not. Candidates can be coincidences of wording, and real overlaps
  can be missed.
- **Whether two page values are one page.** Trailing slashes, schemes and
  fragments are reported as spelling variants, never merged.
- **Whether the segment boundary is right.** It separates the segments it is
  given; an export with no regional column cannot be split by region.
- **Anything about rows it did not read.** Bounded-out files and undecodable
  exports contribute nothing, and the run reports `incomplete` rather than a
  result it does not have. A row that *was* read and found internally
  inconsistent is the other case: that evidence is in hand, the row is dropped
  from the grouping, and the run is a `fail`.
- **Anything from outside the export set.** There are no network calls, no
  telemetry and no provider lookups. Live ranking and index state are not
  consulted.

Every limit is explicit and enforced: `maxExports`, `maxExportBytes`, `maxRows`,
`maxFieldChars`, `maxDepth`, `maxIntentGroups`, `maxClusterRows`. Exceeding one
produces a finding naming it and an `incomplete` report — never a silent
truncation.

The configuration file is bounded separately, at 65536 bytes, and that bound is
checked before the file is opened. Exceeding it is a usage error — exit 2, empty
stdout, the reason on `stderr` — rather than an `incomplete` report, because no
export has been looked at when it is decided.

## Verification

```sh
npm run check
```

Runs `lint` (`node --check` over every file), `test` (`node --test`), the
example run, and `npm pack --dry-run`.

## License

MIT. See [LICENSE](./LICENSE).
