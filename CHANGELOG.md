# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Rule ids are part of the public contract. Renaming or re-grading one is a
breaking change and is recorded here.

## [0.1.0] - 2026-10-14

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

- **Data loss, twice.** `--map` accepted a symbolic link at the destination and
  a hard link to an export, and destroyed a file on each. Reproduced before the
  fix: a symlink pointing at a file in another tree replaced that file with the
  map, exit `0`, stderr `map written` -- and *resolving* the link is what made
  the destination look legitimate, because the resolved path was outside the
  export root, which is exactly what this tool requires. A hard link to one of
  the exports replaced it too: 513 bytes of CSV became 9239 bytes of JSON on a
  file the run had just read, exit `0`, stderr `map written`. Both now exit `2`
  with an empty stdout and leave the file untouched. `lstat` refuses a symbolic
  link unresolved, including one whose target does not exist yet, and the
  destination is compared against every export by device and inode, because a
  hard link shares no path with the file it is a second name for.
  `test/destination-guard.test.mjs` drives the real binary through one case per
  hole plus five destinations that must still be **written** -- including a
  parent directory that does not exist yet and a symlinked parent that stays out
  of the export root -- because a guard that refuses everything passes every
  data-loss case while making the tool useless. Each of the three checks was
  removed in turn and the failures watched.

- Exports are no longer skipped for the name they have. A dot-prefixed export,
  and any export under a directory called `node_modules`, was dropped before it
  was opened: not decoded, not counted in `exportsFound` and not reported, so a
  run that read one of three exports still said `pass`.
- Sanitising now covers the C1 range (U+0080-U+009F), including U+0085 (NEL),
  and the bidi controls (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069) alongside
  C0, DEL and U+2028/U+2029. A NEL in any value -- a query, a page, a segment
  value, a column name or a file name -- forged a line in the human report for
  every consumer that splits on Unicode line boundaries.
- A configuration file that fails to parse is no longer quoted back on stderr.
  V8 embeds the input in one of its two parse-error shapes (`Unexpected token
  'A', "AKIA..." is not valid JSON`), and excerpting did not remove it: the
  quoted copy carries no control characters and sits at the front of the
  message, well inside the 120-character limit. A file short enough to be only
  a credential was therefore printed in full. `parseFailureDetail` keeps the
  position, line and column and drops the quoted document.
- That first fix was incomplete: it matched the offset BEFORE recognising the
  quoting shape, so a configuration file whose own text reads `at position 1`
  produced `Unexpected token 'a', "at position 1" is not valid JSON` and was
  sliced at the offset found INSIDE the quoted span, handing the file straight
  back. The quoting shape is now recognised first, and any detail still
  carrying a double quote is replaced by the generic sentence.
  `parseFailureDetail` now reports `at the start of the document` or `inside
  the document` rather than `in the document`, distinguishing a leading snippet
  from a window V8 took further in.
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

GitHub source release v0.1.0 — 2026-10-14.
