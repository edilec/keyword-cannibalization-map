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

### Notes

- A candidate is an item for review, not a defect. Overlap is reported at `info`
  severity and never fails a run; `fail` is reserved for export data that is
  internally inconsistent or could not be parsed.

No release has been published.
