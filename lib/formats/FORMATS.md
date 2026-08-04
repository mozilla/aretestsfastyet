# What the published files actually contain

Measured, not assumed. Every claim here comes from running
`tools/validate/` over whole published files — see "How this was measured" at
the end for exactly what was swept.

This document exists because `JSON_FORMAT.md` lives in mozilla-central and
lags: it describes what the generator was written to emit, while this describes
what the index was serving when the sweep ran. Where the two disagree, prefer
whichever you can re-measure. `tools/validate/sweep.sh` re-runs the whole thing.

**The type declarations in this directory are the specification; this file is
the evidence for them.** When the generator changes, re-run the sweep, fix the
declarations, and update this file — in that order.

## Summary

- **No validation errors.** Every file swept matched its declaration: every
  field present with the declared type, every table index in range, every
  parallel array the same length, and no unexpected keys.
- Four claims made before the sweep turned out to be **wrong**, and are
  corrected below: `aggregatedFrom` holds filenames, the `manifests.json`
  job-name redundancy is not a redundancy, the errors files do not exist for
  every published date, and the resource files' `.0` convention is not what
  `JSON_FORMAT.md` describes.
- `UNKNOWN` **does not occur** — see the census below. It is not rare; it is
  absent from every `tables.statuses` swept.

## Corrections to what was assumed

### `metadata.aggregatedFrom` holds filenames, not dates

Declared as `DateString[]`, it is actually
`["xpcshell-2026-08-03.json", "xpcshell-2026-08-02.json", …]`. A consumer that
wants the date has to parse it out of the name. Newest first.

### `manifests.json` job names differ by chunk suffix

`runs.jobNameIds[i]` and `tasks.jobName[runs.taskIds[i]]` index the same
`jobNames` table and look interchangeable. They are not:

| | value |
| --- | --- |
| `runs.jobNameIds[i]` | `test-macosx1500-aarch64/debug-web-platform-tests-wdspec` |
| `tasks.jobName[runs.taskIds[i]]` | `test-macosx1500-aarch64/debug-web-platform-tests-wdspec-2` |

The run's job name is **chunk-stripped**; the task's keeps the chunk. They
differed on 360,373 of 433,836 runs on 2026-08-03, and agreed on all 433,836
after stripping a trailing `-<digits>` from the task's. 3,318 of 4,177
`jobNames` entries end in `-<digits>`.

Which to use depends on the question: aggregating per configuration wants the
stripped name, identifying an individual job wants the chunked one. Using the
wrong one silently splits or merges configurations.

### The errors files exist for only 5 of the 21 published dates

`index.json` lists 21 dates and the index task publishes 21 daily files and 21
resources files — but only **5** `{harness}-{date}-errors.json`, for both
harnesses:

| date | xpcshell | mochitest |
| --- | --- | --- |
| 2026-07-14 … 2026-07-29 | 404 | 404 |
| 2026-07-30 | 0.6 MB | 97.1 MB |
| 2026-07-31 | 0.5 MB | 93.3 MB |
| 2026-08-01 | 0.3 MB | 49.0 MB |
| 2026-08-02 | 0.2 MB | 43.9 MB |
| 2026-08-03 | 0.4 MB | 67.2 MB |

Confirmed against the index task's artifact listing, not merely inferred from
404s: the task carries 119 artifacts, of which 5 are errors files.

This matters for `fx-tests errors`, which `CLI.md` specifies as
`--day`-scoped with a default of "the most recent available". **The available
window for errors is not the 21-day window**, so `--day` must be validated
against the errors files that exist rather than against `index.json`, and a
date inside the 21-day window can still legitimately have no errors data. The
`errors` command needs its own window, and its "compare two dates" workflow
(`CLI.md`) can only compare within those 5 days.

### Resource-file task IDs: `.0` is omitted, and so is everything else

`JSON_FORMAT.md` and `lib/formats/resources.ts` describe `jobs.taskIds` as
storing the bare ID with `.0` omitted and non-zero retries suffixed. The
omission of `.0` is confirmed — **no** entry ends in `.0` in any of the 42
resource files swept. Non-zero retries do carry a suffix, but they are rare:
between 0.5% and 5% of entries per file (for example 42 of 1,434 on
xpcshell 2026-07-30).

The consequence for joining stands and is worth restating: the timing files
store `"<taskId>.<retryId>"` **always**, including `.0`, so a join against a
resources file needs normalization on one side. Neither side can be assumed to
match the other textually.

## Fields observed `null`, absent or empty

Anything not listed here was present and non-null in everything swept. This is
the list a decoder has to handle; it is short, which is itself the finding.

### Every timing family

| field | kind | notes |
| --- | --- | --- |
| `testInfo.componentIds[]` | `null` | Test with no known Bugzilla component. Rare — 2 of 4,838 tests in `xpcshell-issues.json`. |
| `statusGroup.messageIds[]` | `null` | A failing run that recorded no message. Common on `FAIL-PARALLEL`. |
| `statusGroup.crashSignatureIds[]` | `null` | A crash with no symbolized signature. |
| `statusGroup.minidumps[]` | `null` | A crash whose minidump was not uploaded. `fx-tests crash` cannot be offered for these. |
| `taskInfo.chunks[]` | `null` | Unchunked job. Bucket files only. |
| `taskInfo.chunks` | **absent** | Whole field absent from the daily, issues-with-taskids and errors files; present only on the bucket files. |

`TIMEOUT` groups carry **no `messageIds` at all** — the field is absent from
the group, not null within it. A decoder that reads `messageIds` unconditionally
gets `undefined` for every timeout.

### `{harness}-{date}-errors.json`

| field | kind | notes |
| --- | --- | --- |
| `messages.fileIds[]` | `null` | Message with no source file. |
| `messages.lines[]` | `null` | Message with no line number. Always null when `fileIds` is. |
| `messages.componentIds[]` | `null` | Observed on mochitest only. |
| `messages.textIds[]` | `null` | A message with no text — an empty log line. |

### `{harness}-stats.json`

| field | kind | notes |
| --- | --- | --- |
| `flavors` | **absent** | xpcshell has no flavors. Present on mochitest with 8 keys. |

### `{harness}-{date}-resources.json`

| field | kind | notes |
| --- | --- | --- |
| `jobs.chunks[]` | `null` | Unchunked job. |

### minidump-stackwalk JSON

Nearly every field is nullable, which is why `lib/formats/stackwalk.ts`
declares them so. The ones that matter for the CLI:

| field | kind | notes |
| --- | --- | --- |
| `frame.function`, `.file`, `.line`, `.module` | `null` | Unsymbolized frame — fall back to `module` + `module_offset`. |
| `crash_info.adjusted_address` | `null` | Only set when the address is recognizable, e.g. a null-pointer dereference. |
| `crash_info.assertion`, `.instruction` | `null` | Frequently absent in practice. |
| `thread.thread_name` | `null` | Unnamed thread. Observed on the crashing thread itself. |
| `frame.inlines` | **absent** | Present only on frames with inlined callees — 119 of 1,025 frames on one dump. |
| `frame.registers` | **absent** | Declared as present on the innermost frame of the crashing thread, but absent from **every** frame of both fixture dumps. Do not rely on it. |
| `module.*` (most) | `null` | Symbol metadata missing for system modules. |

## Status strings

Twelve distinct strings, and **which ones exist depends on the harness**:

| status | xpcshell | mochitest |
| --- | --- | --- |
| `PASS` | yes | yes |
| `PASS-PARALLEL` | yes | — |
| `PASS-SEQUENTIAL` | yes | — |
| `FAIL` | yes | yes |
| `FAIL-PARALLEL` | yes | — |
| `FAIL-SEQUENTIAL` | yes | — |
| `TIMEOUT` | yes | yes |
| `TIMEOUT-PARALLEL` | yes | — |
| `TIMEOUT-SEQUENTIAL` | yes | — |
| `CRASH` | yes | yes |
| `SKIP` | yes | yes |
| `EXPECTED-FAIL` | yes | yes |

**The `-PARALLEL`/`-SEQUENTIAL` execution-mode suffixes are xpcshell-only.**
`PLAN.md` §1 treats the suffix as a general property of the data and
`model/status.ts` is specified to decompose a status into (kind, execution
mode) — that decomposition is right, but for mochitest the mode is always
absent rather than one of two values. `fx-tests test --executions` therefore
has nothing to report on the "by execution mode" axis for a mochitest test, and
should say so rather than printing a table with one row.

This also means the split is not a stable partition: xpcshell's plain `PASS`
coexists with `PASS-PARALLEL` and `PASS-SEQUENTIAL` in the same file, so plain
`PASS` is not "the sum of the two" — it is its own bucket, for runs where the
mode was not recorded.

## Marker kinds

Read from `tables.markerNames` and the keys of `metadata.markerCounts`, which
always agreed.

| marker kind | xpcshell | mochitest |
| --- | --- | --- |
| `C++ assertion` | yes | yes |
| `C++ warning` | yes | yes |
| `JavaScript error` | yes | yes |
| `JavaScript warning` | yes | yes |
| `console.error` | yes | yes |
| `console.warn` | yes | yes |
| `TSan Error` | — | yes |

`TSan Error` is mochitest-only, as `PLAN.md` predicted — it comes from
instrumented builds. Seven kinds is the whole observed set, but the list is
data: read it from the file.

## Status-group shapes

Every combination observed, confirming the table in
`lib/formats/status-group.ts`:

| family | pass-like | SKIP | fail-like | TIMEOUT | CRASH |
| --- | --- | --- | --- | --- | --- |
| daily | flat `taskIdIds`/`durations`/`timestamps` | + `messageIds` | + `messageIds` | flat | + `crashSignatureIds`/`minidumps` (flat strings) |
| issues | `counts` | + `messageIds` | + `messageIds` | `counts` | + `crashSignatureIds` |
| issues-with-taskids | `counts` (**unchanged**) | nested `taskIdIds` + `messageIds` | nested `taskIdIds` + `messageIds` | nested `taskIdIds`, **no** `messageIds` | + `crashSignatureIds`/`minidumps` |
| buckets | nested `durations` + `jobNameIds` | `counts` + `jobNameIds` + `messageIds` | nested `taskIdIds` + `messageIds` | nested `taskIdIds`, **no** `messageIds` | + `crashSignatureIds`/`minidumps` |

Two confirmations worth keeping:

- In `issues-with-taskids.json` the **pass-like groups keep the `counts`
  shape**. Despite the filename, the file has no task IDs for passing runs.
- `minidumps` is a flat `string` per entry in the daily files and a `string[]`
  per entry everywhere else — the same axis as `taskIdIds`.

## `UNKNOWN` census

**Zero occurrences.** `PLAN.md` §1's claim is confirmed and strengthened: the
string is absent from `tables.statuses` in *every* file swept — not rare,
not zero-count-but-declared, simply not emitted.

| | value |
| --- | --- |
| Files carrying a `tables.statuses` | 174 |
| …in which `UNKNOWN` appears | **0** |
| Runs recorded as `UNKNOWN` | **0** |
| Runs of any status, for scale | 854,914,907 |

Per harness, across everything swept:

| harness | runs | distinct statuses |
| --- | --- | --- |
| xpcshell | 167,048,147 | 12 |
| mochitest | 687,866,760 | 6 |

This is what `PLAN.md` §2 gates the deletion on, so to be explicit about what
it does and does not license: **the generator did not emit `UNKNOWN` on any of
the 21 published dates**, which is a statement about those dates, not a
guarantee about the format. The step-2 conclusion holds — the duration-guessing
heuristics are dead code and should not be ported — and the reason to still
give the classifier an `unknown` kind is that its cost is one enum member and
its benefit is that a returning `UNKNOWN` becomes visible rather than being
counted as a pass.

## Peak heap

Measured with `process.memoryUsage()` after `JSON.parse` and a full walk of the
parsed object, in a default Node 22 heap with no flags.

| file | on disk | heapUsed | rss | rss / bytes |
| --- | --- | --- | --- | --- |
| mochitest daily, 2026-07-28 | 155.2 MB | 625.8 MB | 742.1 MB | 4.8× |
| mochitest daily, 2026-07-30 | 146.7 MB | 599.1 MB | 712.8 MB | 4.9× |
| mochitest errors, 2026-07-30 | 97.1 MB | 530.2 MB | 652.1 MB | 6.7× |
| mochitest issues-with-taskids | 75.3 MB | — | — | — |
| xpcshell daily, 2026-07-30 | 36.6 MB | — | 235 MB | 6.4× |

**The largest single file needs about 740 MB of RSS.** `PLAN.md` §4 argues
parsing is safe by construction because the generator held the same data; the
measurement supports the conclusion but the constant is worth knowing — the
expansion factor is roughly **5× on disk size**, and Node's default old-space
limit on a 64-bit machine is around 4 GB, so one file is comfortable and there
is no need for `--max-old-space-size`.

What it also settles: the plan's decision to prefer the 64-bucket files for
single-test queries is right for memory as well as bytes. A bucket file is
3.5–15 MB against the daily file's 37–155 MB, so `fx-tests test` peaks around
100 MB rather than 700 MB.

Aggregating across days remains out of reach, as `PLAN.md` §1 says: three
mochitest daily files would exceed 2 GB of heap.

## Other measurements

- **Weekend volume.** Confirmed, from `mochitest-stats.json`'s per-date
  `markerCounts`: 103,186,014 markers on Thursday 2026-07-30 against
  39,050,879 on Sunday 2026-08-02 — 2.6×. (`PLAN.md` quotes 38.2M for that
  Sunday; the stats file says 39.1M. Close enough not to change any conclusion,
  and noted only so the number here is the one that was measured.) xpcshell
  shows the same ratio: 339,153 against 137,228. Any absolute count needs the
  weekday alongside it.
- **`manifests.json` zero durations.** 71,272 of 433,836 runs on 2026-08-03 —
  16.4%. These are skipped manifests, not instant ones
  (`manifests.html:415`). Missing this rule affects a sixth of the data.
- **`manifests.json` task IDs.** 216 of 9,543 carry a `.<retry>` suffix; the
  rest are bare. Same normalization problem as the resource files.
- **`stats.json` reaches beyond the 21-day window.** xpcshell has 199 dates
  (from 2026-01-16), mochitest 66 (from 2026-05-29 — mochitest collection
  started later). This is the only file with real history, which is why
  `fx-tests summary` is cheap.
- **`metadata.markerCounts` and `tables.markerNames` always agreed** on the set
  of kinds.
- **`totalBuckets` is 64** in all 128 bucket files.

## How this was measured

`tools/validate/` walks a whole file asserting every field's presence and type,
every table index's range, every parallel array's length, and reporting any key
it does not know about. It reports rather than throws, so one bad field does
not mask the rest of a file.

**One file per process invocation.** `tools/validate/sweep.sh` is a shell loop
that downloads, validates, records and deletes each file before fetching the
next, so peak memory is one file rather than the sweep.

What was swept:

| family | harness | files | coverage |
| --- | --- | --- | --- |
| daily | both | 42 | **every published date** (21 × 2) |
| errors | both | 10 | **every date for which a file exists** (5 × 2); the other 32 requests 404 |
| resources | both | 42 | **every published date** (21 × 2) |
| buckets | both | 128 | **all 64 buckets**, both harnesses — the complete 21-day aggregate |
| issues | both | 2 | the whole file |
| issues-with-taskids | both | 2 | the whole file |
| stats | both | 2 | the whole file, all 199 / 66 dates |
| manifests | — | 1 | the whole file |
| index | — | 1 | the whole file |
| minidump-stackwalk | — | 6 | sampled from crash groups across bucket files |

That is a **complete sweep of every file the index publishes**, not a sample —
230 files and 4.4 GB — with the single exception of the minidump-stackwalk
artifacts, which are per-task and effectively unbounded in number, so those
were sampled.

To reproduce:

```sh
tools/validate/sweep.sh --all      # writes artifacts/sweep-results.jsonl
node --experimental-strip-types tools/validate/report.ts \
    artifacts/sweep-results.jsonl  # writes this document's numbers
```
