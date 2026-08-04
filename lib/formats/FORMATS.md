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

- **No validation errors** across all 238 files: every required field present
  and non-null, every nullable field null only where the declaration permits,
  every table index in range, every parallel array the same length, no
  unexpected keys.
- Four claims made before the sweep turned out to be **wrong**, and are
  corrected below: `aggregatedFrom` holds filenames, the `manifests.json`
  job-name redundancy is not a redundancy, the errors files do not exist for
  every published date, and the resource files' `.0` convention is not what
  `JSON_FORMAT.md` describes.
- **The 21-day aggregates and the daily files do not cover the same skips.**
  The aggregates drop `run-if` skips and the daily files keep them — 63.6% of
  one full daily file's skipped runs. A skip count means a different thing
  depending on which family it came from; see below.
- `UNKNOWN` **does not occur** — see the census below. It is not rare; it is
  absent from every `tables.statuses` swept.
- **`messageIds` presence depends on the status, not the shape** — the finding
  most likely to break Step 1's unified iterator. See below.

> **On the strength of "no validation errors".** The first version of this
> validator could not fail on a missing or `null` field — both went to the
> census rather than to an error — so "clean" meant less than it sounded. That
> is fixed: presence and nullability are now declared per field and enforced,
> `test/mutations.test.ts` breaks each fixture 42 ways and asserts the checker
> notices, and the sweep above was **re-run in full against the stricter
> validator**. It found nothing new, which is now a meaningful statement:
> against the previous validator the same suite let 14 of those 42 mutations
> through.

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
**0.50% to 5.60%** of entries per file across the 42 swept, the maximum being
61 of 1,089 on xpcshell 2026-07-14.

The consequence for joining stands and is worth restating: the timing files
store `"<taskId>.<retryId>"` **always**, including `.0`, so a join against a
resources file needs normalization on one side. Neither side can be assumed to
match the other textually.

### The 21-day aggregates drop `run-if` skips; the daily files keep them

Found by decoding a daily file and an aggregate and comparing a shared test's
per-day counts: every status agreed except `SKIP`. `run-if` is a manifest
annotation scoping a test to some other platform, so it not running here is the
annotation working rather than a problem — and the generator applies that
filter when it aggregates, but not when it writes a per-date file.

| file | `tables.messages` | starting `run-if` | starting `skip-if` |
| --- | --- | --- | --- |
| `xpcshell-2026-07-30.json` (daily) | 457 | **28** | 47 |
| `xpcshell-issues.json` | 2,888 | **0** | 48 |
| `mochitest-issues.json` | 2,233 | **0** | 173 |
| `mochitest-issues-with-taskids.json` | 2,233 | **0** | 173 |
| `xpcshell-00.json` (bucket) | 24 | **0** | 11 |
| `mochitest-00.json` (bucket) | 62 | **0** | 32 |

Not a rounding difference. On the full xpcshell daily file for 2026-07-30,
**253,252 of 398,212 skipped runs are `run-if`** — 63.6% of them — and every
aggregate has none at all.

So the same question gets a different answer depending on which file it is
asked of, and the discrepancy is upstream rather than in any decoder:

- A skip count from a bucket or issues file is **already filtered**. Applying
  `!msg.startsWith('run-if')` to it again is a no-op.
- A skip count from a daily file is **not**, and needs the filter. Reporting a
  raw daily skip count as though it were comparable to a bucket one overstates
  it by whatever share of the tests are platform-scoped — on 2026-07-30, by
  2.7×.

`lib/model/skips.ts` owns the filter, and `test/formats.test.ts` asserts both
halves of this so the asymmetry cannot regress unnoticed.

### The daily and 21-day files disagree by one run on `PASS-SEQUENTIAL`

Of the eight tests the daily and issues **fixtures** share, three report
exactly one more `PASS-SEQUENTIAL` run in the aggregate's day-20 counts than in
the daily file, and nothing else disagrees on any status — including the
`task-ids` and `durations` shapes, which are counted in completely different
ways. The difference is visible in the raw JSON before any decoding.

Small and one-sided enough not to change a conclusion, and recorded because a
test asserts the exact shape of it: if a decoder change ever makes the
disagreement *broader*, that is a decoder bug and not this.

## Fields observed `null`, absent or empty

Anything not listed here was present and non-null in everything swept. This is
the list a decoder has to handle; it is short, which is itself the finding.

### Every timing family

Occurrence counts are over the whole sweep, so the bucket rows aggregate all
64 buckets and the daily rows all 21 dates.

| field | kind | occurrences | notes |
| --- | --- | --- | --- |
| `taskInfo.chunks[]` | `null` | 74,699 xpcshell / 5,882 mochitest (buckets) | Unchunked job. Bucket files only. |
| `taskInfo.chunks` | **absent** | every daily, issues-with-taskids and errors file | Present only on the bucket files. |
| `statusGroup.messageIds[]` | `null` | 5,495 on xpcshell `FAIL-PARALLEL`; 408 on mochitest `FAIL` | A failing run that recorded no message. |
| `testInfo.componentIds[]` | `null` | 2 of 4,838 tests (xpcshell issues), 138 (mochitest) | Test with no known Bugzilla component. |
| `statusGroup.crashSignatureIds[]` | `null` | 58 (mochitest) | A crash with no symbolized signature. Never null on xpcshell. |
| `statusGroup.minidumps[]` | `null` | 58 (mochitest) | A crash whose minidump was not uploaded — `fx-tests crash` has nothing to fetch. Always the same 58 entries as the null signatures. |
| `tables.crashSignatures` | **empty** | 20 of 64 mochitest buckets | The whole table, not an entry: a third of mochitest buckets saw no crash at all. An empty table is not an error. |

#### `messageIds` presence follows the status, not the shape

The single most important thing on this page for Step 1, because it breaks the
assumption that the shape discriminant tells you which fields exist. Within the
*same* `task-ids` shape, whether a group has `messageIds` depends on its
status — and it is all-or-nothing per status, never mixed:

| status | shape | `messageIds` |
| --- | --- | --- |
| `FAIL`, `FAIL-PARALLEL`, `FAIL-SEQUENTIAL` | task-ids | **always** |
| `SKIP` | task-ids / skip-counts | **always** |
| `TIMEOUT`, `TIMEOUT-PARALLEL`, `TIMEOUT-SEQUENTIAL` | task-ids | **never** |
| `CRASH` | task-ids | **never** — carries `crashSignatureIds` instead |
| `EXPECTED-FAIL` | task-ids | **never** |
| `PASS`, `PASS-PARALLEL`, `PASS-SEQUENTIAL` | durations / counts | **never** |

In `xpcshell-issues-with-taskids.json`: all 3,689 `FAIL-PARALLEL` groups carry
`messageIds`; all 767 `TIMEOUT-PARALLEL` groups, in the identical shape, do
not. Same in every bucket file and for mochitest.

So the unified iterator in `formats/status-group.ts` must branch on the
**status string** as well as on the shape. Reading `messageIds` off a
`task-ids` group because its shape allows it yields `undefined` for every
timeout and crash, which then reads as "failed with no message" rather than
"this status does not record messages" — a distinction `fx-tests test`'s
failure-message list depends on.

`crashSignatureIds` and `minidumps` are the mirror image: they appear **only**
on `CRASH` groups, in every family.

### `{harness}-{date}-errors.json`

| field | kind | occurrences | notes |
| --- | --- | --- | --- |
| `messages.fileIds[]` | `null` | 47,733 mochitest / 1,144 xpcshell | Message with no source file. Very common — roughly a third of mochitest messages. |
| `messages.lines[]` | `null` | 35,021 mochitest / 1,077 xpcshell | Message with no line number. **Not** the same set as the null `fileIds`: on xpcshell 2026-07-30, 228 messages had neither, 22 had a *line but no file*, and none had a file without a line. So a null `fileIds` does not imply a null `lines`, and grouping by source location has to handle a line with nothing to attach it to. |
| `messages.componentIds[]` | `null` | 5,207 mochitest | Never null on xpcshell. |
| `messages.textIds[]` | `null` | 124 mochitest / 1 xpcshell | A message with no text at all. Rare, but it exists — grouping by text has to cope. |

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
| Distinct runs of any status, for scale | **212,361,640** |

Per harness, over the 21-day window:

| harness | runs | distinct statuses |
| --- | --- | --- |
| xpcshell | 40,804,055 | 12 |
| mochitest | 171,557,585 | 6 |

**These are runs, not file-rows.** `issues.json`, `issues-with-taskids.json`
and the 64 bucket files are three encodings of the *same* 21 days and report
byte-identical per-status totals, so adding them up multiplies the population
by the number of ways it was encoded. The figures above are the aggregate
counted once. (An earlier revision of this document quoted 854,914,907 by
summing all four families; that number was a counting artefact, not a
measurement, and is wrong by about 4×.)

### The daily files and the aggregates disagree, and only on `SKIP`

Counting the same 21 days from the daily files instead gives a slightly larger
number:

| harness | from the aggregates | from the daily files | difference |
| --- | --- | --- | --- |
| xpcshell | 40,804,055 | 44,635,982 | +3,831,927 (+9.4%) |
| mochitest | 171,557,585 | 173,194,005 | +1,636,420 (+1.0%) |

**Every status except `SKIP` matches exactly.** The whole difference is skips:
xpcshell 2,166,688 in the aggregates against 5,998,615 in the daily files.

This is a real difference in the data, not a counting artefact of the kind
above — checked per test on a single day, the daily file records more skips
than the aggregate does for the same test on the same date (for one test, 702
against 113). So the two sources genuinely do not agree about how many times a
test was skipped, and any command that reports a skip count will produce a
different number depending on which file it read.

Step 1 should not paper over this: `query/` needs to say which source a skip
count came from, and the `skips`-related commands in `CLI.md` are specified
against `-issues.json`, which is the lower of the two. Worth understanding
before `fx-tests skips` quotes a number.

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
| **mochitest daily, 2026-07-28** (the largest) | 155.2 MB | 628.5 MB | 745.8 MB | 4.8× |
| mochitest daily, 2026-07-30 | 146.7 MB | 599.1 MB | 712.8 MB | 4.9× |
| mochitest errors, 2026-07-30 | 97.1 MB | 531.9 MB | 656.8 MB | 6.8× |
| mochitest bucket (typical) | 15.1 MB | — | 195 MB | 12.9× |
| xpcshell daily, 2026-07-30 | 36.6 MB | — | 235 MB | 6.4× |

**The largest single file peaks at 746 MB of RSS and 629 MB of heap.**
`PLAN.md` §4 argues parsing is safe by construction because the generator held
the same data; the measurement supports that conclusion, and the useful
constant is the expansion factor: **roughly 5× the file size for the big
files**, rising to 7–13× for the smaller ones, where a fixed interpreter
overhead of ~35 MB dominates. Node's default old-space limit on a 64-bit
machine is around 4 GB, so one file is comfortable and `--max-old-space-size`
is not needed.

What it also settles: preferring the 64-bucket files for single-test queries is
right for memory as well as bytes. A bucket file peaks around 125–195 MB
against a daily file's 235–746 MB.

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
| minidump-stackwalk | — | 8 | **sampled** — reached via `CRASH` groups' `minidumps`; 4 macOS, 3 Windows, 1 Linux, 5–59 threads each |

That is a **complete sweep of every file the index publishes**, not a sample —
238 files and 4.4 GB — with the single exception of the minidump-stackwalk
artifacts, which are per-task and effectively unbounded in number, so those
are sampled (`STACKWALK_SAMPLE`, default 8).

To reproduce:

```sh
tools/validate/sweep.sh --all      # writes artifacts/sweep-results.jsonl
node --experimental-strip-types tools/validate/report.ts \
    artifacts/sweep-results.jsonl  # writes this document's numbers
```

`--all` includes the daily and errors families and a sample of
minidump-stackwalk artifacts (`STACKWALK_SAMPLE`, default 8), discovered from
`CRASH` groups the same way `crashes.html` finds them.

**It will not reproduce these numbers exactly, and cannot.** The index
publishes a rolling 21-day window, so a sweep run tomorrow covers a different
21 days: counts move, the errors window slides, and dumps referenced by an
older run expire. What should reproduce is the *shape* of the result — clean
validation, the same status and marker-kind sets, no `UNKNOWN`. Treat a
difference in those as a finding; treat a difference in the totals as the
calendar.

### Validating a single file

```sh
npx esbuild tools/validate/main.ts --bundle --platform=node \
    --format=esm --target=node20 --outfile=artifacts/validate.mjs
node artifacts/validate.mjs bucket xpcshell 00
node artifacts/validate.mjs errors mochitest 2026-08-03
node artifacts/validate.mjs stackwalk stackwalk --url <artifact-url>
node artifacts/validate.mjs daily xpcshell 2026-08-03 --file ./local-copy.json
```

Exit 0 clean, 1 with validation errors, 3 if the file could not be fetched.

## The fixtures

`test/fixtures/` holds truncated real files, regenerated by `npm run fixtures`
and re-validated by `npm test` with the same checkers the sweep used.

**Regeneration is not idempotent, by construction.** `npm run fixtures` picks
the most recent weekday from a rolling window, so re-running it on a different
day produces different files: the date in the filenames moves, the checked-in
`stats.json` files grow by a row a day, and the counts change. The stackwalk
fixtures are worse — they are discovered from whichever crashes are in the
current window, and Taskcluster expires the artifacts, so an old dump cannot
be re-fetched at all. Regenerate deliberately (when the generator's format
changes), not routinely, and expect the diff to touch every file. Pass
`--date YYYY-MM-DD` to pin the day while it is still in the window.

They are cut **from a weekday** and, crucially, **not from a prefix of the
file**. Keeping the first N tests is circular — the first `FAIL` group in
`xpcshell-00.json` is on test 76, so a 40-test prefix contains no failures at
all and would validate a decoder against only the shapes that survived the cut.
`selectTests()` instead keeps the first couple of tests carrying *each* status,
which covers all twelve xpcshell statuses in about a dozen tests. A test
asserts that every status in a fixture's `tables.statuses` has at least one
test carrying it, so this property cannot quietly regress.

Both harnesses' buckets and errors files are checked in, because their coverage
genuinely differs: mochitest has no `-PARALLEL`/`-SEQUENTIAL` statuses, and
xpcshell's errors file only contains failing tests' output.

Two real minidump-stackwalk dumps are included:

- `stackwalk-crash.json` — a Windows crash, 59 threads, 1,025 frames, all
  symbolized.
- `stackwalk-hang.json` — a macOS **hang**, not a crash: the main thread is
  parked in `RunCurrentEventLoopInMode` and the process was killed from
  outside, so the dump is taken by breakpad
  (`ExceptionHandler::WriteMinidumpWithException` is on the stack) and
  `crash_info.type` is `EXC_SOFTWARE / SIGABRT`. This is the shape
  `fx-tests crash --all-threads` exists for, and it is worth noting that a
  hang is *not* distinguishable by `crash_info.type` alone — a real `SIGABRT`
  crash looks the same. The distinguishing evidence is breakpad frames at the
  top of a thread that is otherwise waiting.
