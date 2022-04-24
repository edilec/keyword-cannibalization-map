# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Rule ids are part of the public contract. Renaming or re-grading one is a
breaking change and is recorded here.

## [Unreleased]

### Added

- `mapQueryPageExports()` groups query/page export rows into candidate overlap
  clusters inside each segment, and returns the report envelope together with a
  map artifact in which every candidate carries the source rows that produced
  it.
- `keyword-cannibalization-map` CLI with `--help`, `--json`, `--map`,
  `--config`, `--match`, `--segment-column`, `--no-segments`, five review
  thresholds and seven limits.
- A frozen `RULE_SEVERITY` table of 27 rules, asserted against
  `docs/overlap-rules.md` in both directions.
- Cross-segment reporting: intents that pooling the segments would have merged
  are reported at `info` severity rather than merged.

### Fixed

- Exports are no longer skipped for the name they have. A dot-prefixed export,
  and any export under a directory called `node_modules`, was dropped before it
  was opened: not decoded, not counted in `exportsFound` and not reported, so a
  run that read one of three exports still said `pass`.
- Sanitising now covers the C1 range (U+0080-U+009F), including U+0085 (NEL),
  and the bidi controls (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069) alongside
  C0, DEL and U+2028/U+2029. A NEL in any value -- a query, a page, a segment
  value, a column name or a file name -- forged a line in the human report for
  every consumer that splits on Unicode line boundaries.
- An entry that resolves outside the export root now sets the run `incomplete`,
  like every other refusal. `path-escapes-root` was the only refusal that left
  the run complete, so a single re-grade of that rule turned a run that refused
  to read its exports into a `pass`, and it reported on exit 1 where the exit
  table routes missing evidence to 2.

### Documentation

- The configuration-file bound is described as what it is: a usage error with
  an empty stdout, settled before any export is read, rather than a finding in
  an `incomplete` report.
- An invalid row is described as a `fail` -- evidence the run holds and found
  contradictory -- and separated from evidence the run could not obtain, which
  is what `incomplete` means.

### Notes

- A candidate is an item for review, not a defect. Overlap is reported at `info`
  severity and never fails a run; `fail` is reserved for export data that is
  internally inconsistent or could not be parsed.

No release has been published.
