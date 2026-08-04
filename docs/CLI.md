# `fx-tests` — command-line access to the test-health data

The dashboards at <https://tests.firefox.dev/> answer questions about Firefox
test health by drawing charts. `fx-tests` answers the same questions in plain
text or Markdown, so that an agent debugging a test failure — or anyone in a
terminal — can get the data without a browser.

It reads exactly the same pre-aggregated JSON files from the Firefox CI index
that the dashboards do, through the same shared library
(see [`PLAN.md`](PLAN.md)). There is no separate data path and no server.

> **Status: design document.** Nothing here is implemented yet. This file
> specifies the intended surface so it can be reviewed before code is written.

## Design goals

**Output is for reading, not parsing.** The default output is compact plain
text sized for a terminal or an agent's context window: no ASCII-art tables
that wrap at 80 columns, no colour required to understand the content. Every
command also takes `--json` for programmatic use, so the human-readable format
never has to double as an API.

**Context-window frugality.** An agent pasting output into a prompt pays for
every token. Commands default to a small number of rows and a truncated
message column, and say what they truncated (`… 47 more (--limit 0 for all)`)
rather than silently cutting off. This is why the default is not `--json`:
the table-encoded JSON for one test is far larger than its prose summary.

**Answers, not dumps.** `fx-tests test <path>` leads with a verdict — is this
test failing, is it perma-failing on one config, has it been failing for
three days or three weeks — because that is the question being asked. The
supporting numbers follow.

**Every number traceable.** Any command that reports a failure can print the
task IDs behind it (`--task-ids`), so a claim can always be checked against
the actual CI job.

## Invocation

```
fx-tests <command> [options]
```

Installed as a `bin` entry in `package.json`; run without installing via
`npx fx-tests` or `./bin/fx-tests.js` from a checkout. Requires Node ≥ 20
(for built-in `fetch`; see the prerequisite note in `PLAN.md`).

## Global options

| Option | Default | Meaning |
| --- | --- | --- |
| `--harness <xpcshell\|mochitest>` | inferred from the test path, else `xpcshell` — but `mochitest` for `errors` (see below) | Which harness's data files to read. |
| `--json` | off | Emit JSON instead of text. Stable shape, documented per command. |
| `--markdown` | off | Emit Markdown (tables, fenced blocks). For pasting into a bug or PR. |
| `--limit <n>` | varies per command | Max rows. `0` means no limit. |
| `--config <list>` | all configs | Comma-separated job-name substrings; an entry matches if it is contained in the job name. `--config linux,windows11` is the union. |
| `--exclude-config <list>` | none | Comma-separated substrings to exclude. Applied after `--config`, so `--config linux --exclude-config debug` means "linux, but not debug". |

`--json` and `--markdown` are mutually exclusive; passing both is a usage error
(exit 1) rather than one silently winning.

### Harness detection is a heuristic, and it fails quietly

`--harness` is inferred with the existing `detectHarness()` (`common-test-data.js:9`),
which the CLI should reuse rather than reimplement. Its rules: `browser_*.js` and
`test_*.html` are mochitest, everything else — including `test_*.js` — is xpcshell.

That misclassifies a mochitest-plain `test_foo.js`, and the symptom is
indistinguishable from a typo: the CLI reads xpcshell data, does not find the test,
and reports "no such test". So on a lookup miss, commands must exit 2 with the
inference made explicit:

```
No such test in xpcshell data (harness inferred from filename).
If this is a mochitest, retry with --harness mochitest.
```

Cheap to do, and it turns a dead end into a next step.
| `--day <date>` | the whole window | Restrict to one day (`YYYY-MM-DD`), or `--day today`/`yesterday`. A filter on the same file the command already reads. Outside the 21-day window: exit 2. |
| `--since <n>` | | Restrict to the last `n` days of the window. Mutually exclusive with `--day`. |
| `--data-source <central\|try\|local>` | `central` | Where to read data from. `local` reads `./data/`, mirroring the dashboards' `?data-source=` parameter. |
| `--cache-dir <path>` | `~/.cache/fx-tests` | On-disk cache for downloaded data files. |
| `--no-cache` | off | Ignore and do not write the cache. |
| `--quiet` | off | Suppress progress output on stderr. |
| `--help`, `--version` | | |

### `--day` and the window

Most commands read the 21-day aggregate by default, because the questions worth
asking ("is this flaky?", "is this new?") need history.

**Within the 21-day window, `--day` and `--since` are both just filters.** Every
status group in a 64-bucket file carries a delta-encoded `days` array — passes,
skips, failures, crashes and timeouts alike — so restricting to one day or to the
last *n* days happens during the single pass the command already makes. Same file,
same cost, no extra requests, and `--coverage` keeps working because the per-day
entries carry `jobNameIds` directly.

For `fx-tests test`, then, `--day 2026-07-30` and `--since 1` are the same kind of
operation. What either loses is only history: trend and recent-window columns are
omitted for a single day rather than shown as zero.

**Out of scope: dates older than the window.** The `latest` index task publishes
bucket files and daily files for exactly the same 21 dates (currently 2026-07-14 →
2026-08-03). Older data is not *gone* — Taskcluster keeps artifacts for about a
year, so an older run's files can be reached through that run's own index — but no
dashboard does this today, and adding it would mean resolving historical index
tasks, a concern the CLI does not otherwise have. So `--day` outside the window is
exit 2 with a message saying which window is available.

Worth noting the shape of that future feature, since it affects nothing now: an
older index task carries its own 64 bucket files, so history would be read the
same cheap way, not by falling back to daily files. There is no version of this
where "older date" implies "scan a daily file".

That leaves the daily `{harness}-{date}.json` files needed for only two things the
aggregates drop:

| | 64-bucket file | daily file |
| --- | --- | --- |
| per-day, per-job pass/fail counts | yes | yes |
| individual run durations | yes | yes |
| task IDs for failures | yes | yes |
| **per-run timestamps** | no — day granularity only | yes |
| **task IDs for _passing_ runs** | no — `jobNameIds` only | yes |
| size | ~3.5 MB | ~37 MB |

So `fx-tests test` reads the bucket file, full stop, unless asked for one of those
two — exact run times, or task IDs of passing runs. Both are narrow enough that
the fallback should be triggered by the flag that needs it rather than by `--day`,
which keeps the common path on one small file.

**Weekends are not representative.** Push volume drops several-fold at weekends,
so any absolute count from a Saturday or Sunday is a fraction of a weekday's and
should not be compared against one. Commands print the weekday alongside the
date for this reason, and `--day` resolves to the most recent day with data
rather than literally yesterday. This is the same effect that makes
`computeConfigStats()` size its recent window by run count instead of by days.

### Task IDs and profile URLs

`--task-ids` prints the raw task IDs.

`--profiles` prints **raw profile JSON URLs** — Taskcluster artifact URLs, not
`profiler.firefox.com/from-url/...` links. The consumer is
[`profiler-cli`](https://github.com/mozilla/profiler-cli), which downloads and
queries a profile directly; wrapping the URL in the web profiler's front end
would only make it unusable for that. (The dashboards wrap them because their
consumer is a human with a browser — same underlying artifact, different
presentation, which is precisely the split `lib/links.js` should express.)

Two kinds of profile, with different availability:

- **Resource-usage profile**, one per job: reconstructible from the task ID and
  retry alone —
  `…/task/<taskId>/runs/<retryId>/artifacts/public/test_info/profile_resource-usage.json`.
  Shows whether a timeout was the test being slow or the machine saturated.
  Available for any job, so any command with a task ID can emit it.
- **Per-test failure profile**, uploaded only when a test fails: the filename is
  *not* derivable from the task ID. It appears in the failure message as
  `"profile uploaded in profile_<name>.json"`, so getting it means reading that
  message (`try.html:2900`). This is why profile URLs matter most for
  `fx-tests try`, which already has the push's failure messages in hand.

For commands working from aggregated data, the failure message is in the data
file, so the same extraction applies. Where no profile was uploaded, no URL is
emitted — the command does not guess a filename.

Progress and diagnostics go to **stderr**; only the requested data goes to
**stdout**, so `fx-tests ... > out.md` and piping into `jq` both behave.

### Caching

The 21-day aggregate files are tens of megabytes and change once a night, so
the CLI caches them on disk keyed by URL plus the file's `metadata.generatedAt`.
A warm run of `fx-tests test <path>` should need no network at all. `fx-tests
cache` inspects and clears it.

## Commands

### `fx-tests test <path>` — everything about one test

The workhorse. Answers "why is this test failing, and is it my fault?"

> **Illustrative output.** The numbers in this section's examples are made up to
> show layout and which facts appear where — they are not measurements, and the
> percentages are not necessarily self-consistent. Only the `errors` ranking
> example further down uses real data, and it says so. Do not treat column widths
> or derived values here as goldens.

```
$ fx-tests test toolkit/components/places/tests/unit/test_frecency.js

test_frecency.js — toolkit/components/places/tests/unit
Component: Toolkit :: Places
Data: xpcshell, 21 days (2026-07-13 … 2026-08-02), mozilla-central + autoland

  4812 runs   4788 pass (99.50%)   21 fail   3 timeout   0 crash   672 skip

Verdict: intermittent. Fails on 3 of 34 configs; no config fails
         more than 8% of the time.

Runs on 34 configs across linux, windows, macos (not android — see --coverage)

Failing configurations                     fail rate    recent (7d)     runs
  test-linux1804-64/debug-xpcshell           8.1% (13)    9.4%           160
  test-macosx1470-64/debug-xpcshell          2.4% (5)     1.9%           208
  test-windows11-64-24h2/debug-xpcshell      1.6% (3)     0.0%           187

Failure messages
  17x  Assertion failed: frecency of 100 != 120
   4x  Test timed out after 300 seconds

Skips
  672x  skip-if: os == 'android'      (4 android configs × 168 runs)
```

Options:

- `--coverage` — **every** config the test ran on, passing ones included, with
  run counts (see below).
- `--executions` — break failures down by initial run vs harness rerun, and by
  parallel vs sequential (see below).
- `--config <list>` — comma-separated substrings, e.g.
  `--config 'linux1804-64/debug,windows11'`.
- `--day <date>` / `--since <n>` — one day, or the last *n* days.
- `--recent-days <n>` — override the automatically-sized recent window
  (see "recent window" below).
- `--task-ids`, `--links` — provenance for each failure (see above).
- `--durations` — per-config run-time distribution (min/median/p95/max) from
  the pass durations, for "is this test slow?" rather than "is it failing?".
- `--history` — a per-day sparkline of pass/fail counts, which distinguishes
  "broken since Tuesday" from "flaky for a month".

#### `--coverage`: where does this test actually run?

The default output lists only *failing* configs, which cannot answer "is this
test running on Android at all?" — a question that matters before concluding a
platform is unaffected. `--coverage` lists every config, including the ones
that only ever passed:

```
$ fx-tests test dom/base/test/test_selection.html --coverage

Configuration                              runs   pass   fail  skip   status
  test-linux1804-64/opt-mochitest-plain     412    412      0     0   ok
  test-linux1804-64/debug-mochitest-plain   398    395      3     0   intermittent
  test-windows11-64-24h2/opt-…-plain        204    204      0     0   ok
  test-macosx1470-64/opt-…-plain            196    196      0     0   ok
  test-android-em-7-0-x86_64/debug-…        168      0      0   168   skipped
                                                                      (skip-if: os == 'android')

34 configs, 5 platforms: linux (14), windows (8), macos (6), android (4), linux-aarch64 (2)
Never ran on: windows-aarch64
```

This is available because the 64-bucket per-test files attribute passing runs to
a job name (`jobNameIds` on PASS status groups), and `test.html` already builds
this matrix — it simply has no CLI equivalent today. `--coverage` also
distinguishes the three states that look alike in a failure-only view: ran and
passed, ran and was skipped, never scheduled.

#### `--executions`: a failure is not just a failure

Two distinctions change what a failure means, and a bare count hides both.

**Initial run vs harness rerun.** When a test fails, the harness reruns it within
the same job. Failed-then-passed-on-rerun is an intermittent; failed in both is
much closer to real breakage. (This is a *within-job* rerun — distinct from a
job-level retry, which is the `.<retryId>` on a task ID. Both get called "retry";
they are different things.)

**Parallel vs sequential.** Statuses carry the execution mode
(`FAIL-PARALLEL`, `PASS-SEQUENTIAL`, …). A test that fails only in parallel is
likely racing with its neighbours rather than broken on its own — a different bug,
with a different fix.

```
$ fx-tests test dom/base/test/test_selection.html --executions

  21 tests failed on their initial run
    passed when the harness reran it      18   (86%)  -> intermittent
    failed again on rerun                  3   (14%)  -> candidate breakage

  By execution mode
    parallel      20 failures / 833 runs    2.4%
    sequential     1 failure  / 1000 runs   0.1%

  Reads as: intermittent, and strongly parallel-biased — 20 of 21 failures
  happened under parallel load, at ~24× the sequential rate.
```

The two blocks partition the same 21 failures two different ways — by what
happened on rerun, and by execution mode — rather than being additive.

The default output mentions these only when they change the interpretation
("passed on rerun", "fails almost only in parallel"), to keep it short; the full
breakdown is behind the flag. `try.html` already tracks reruns (`:1408`) and
`issues.html` surfaces parallel failures in a tooltip (`:1216`), but neither
exposes it usefully, and the CLI should not inherit that limitation.

The **recent window** is not a fixed number of days. Push volume varies
several-fold across a week, so a fixed window measured after a weekend rests
on very few runs. The window is instead widened until the sparsest config has
enough runs to support a percentage, and all configs then share that one
window so their rates are comparable. The output always states the window it
used. This is existing `computeConfigStats()` behaviour, surfaced verbatim.

`--json` shape: `{ test, component, harness, metadata, totals, verdict,
configs[], messages[], skips[] }`.

### `fx-tests try <revision>` — triage a Try push

The command most useful to an agent that just pushed to Try. Aggregates the
push's test failures and, crucially, separates failures **caused by the patch**
from failures that were **already failing on central**.

```
$ fx-tests try 4f2c1a9e8b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a

Try push 4f2c1a9e (try) — 1284 jobs, 37 failed
Compared against 21 days of mozilla-central history.

PERMA-FAILS (2) — fail in every run on the affected config, and were
                  not failing on central. These are almost certainly yours.

  dom/base/test/test_selection.html
    fails on test-linux1804-64/debug-mochitest-plain (3/3 runs)
    Never failed on central in 21 days (0/412 runs)
    Assertion failed: selection.rangeCount == 1

  browser/base/content/test/browser_tabs.js
    fails on 4 configs (7/7 runs)
    Never failed on central in 21 days (0/1608 runs)
    uncaught exception: TypeError: tab is null

KNOWN INTERMITTENTS (14) — also fail on central; likely not yours.
  test_frecency.js                   8.1% on central (same message)
  browser_download_panel.js          3.2% on central (same message)
  … 12 more (--limit 0 for all)

NEW INTERMITTENTS (1) — failed once here, never on central. Worth a look.
  toolkit/xre/test/test_startup.js   1/3 runs, no central failures
```

Options: `--project <try|autoland|…>` (default `try`), `--perma-only` (just
the first section — the highest-signal output for an agent), `--all-jobs`
(include non-test job failures), `--task-ids`, `--profiles`,
`--config <list>`.

The perma-fail/intermittent split above rests on the harness-rerun distinction:
a test that failed and then **passed when the harness reran it** in the same job
is intermittent almost by definition, while one that failed in every run
including reruns is a perma-fail candidate. `try.html` computes this already
(`isRetry` at `:1022`, `passedOnRetry` at `:1408`); the CLI reports it per failure
rather than only using it for sorting, since "it passed on rerun" is often the
single most useful fact about a Try failure.

Failures are also labelled when they occur only in parallel execution, which
points at a race with concurrently-running tests rather than a defect in the test
itself.

The same-message distinction matters and is preserved from the dashboard: a
test that already fails on central 8% of the time, but with a *different*
message than the one in your push, is not exonerated. Sections report
same-message rates alongside overall rates.

`--json` shape: `{ revision, pushId, jobCount, failedJobCount,
permaFails[], knownIntermittents[], newIntermittents[] }`.

### `fx-tests issues` — what is failing right now, across the tree

The triage view. Every non-passing outcome over the window, grouped.

```
$ fx-tests issues --component "Core :: Storage: IndexedDB" --limit 5
```

Options: `--component <substring>`, `--path <prefix>` (directory subtree),
`--type <fail|timeout|crash|skip>` (repeatable), `--min-rate <pct>`,
`--sort <rate|count|name>`, `--group-by <test|component|directory|message>`.

`--group-by message` is the "one bug, many tests" view: a single harness
change or infra fault often shows up as the same message across dozens of
tests, and grouping by message makes that one line instead of thirty.

### `fx-tests failures` / `fx-tests crashes` — group by message / signature

`failures` groups failing runs by message; `crashes` groups by crash signature
and can print minidump IDs (`--minidumps`), which `fx-tests crash` then reads.
Both accept `--limit`, `--path`, `--component`, `--config`, `--day`.

### `fx-tests crash <task-id> <minidump-id>` — read a processed crash dump

Prints a symbolized report from a job's minidump-stackwalk JSON: signature,
crash reason, faulting address, and thread stacks.

The point is token cost. The raw stackwalk JSON is large and deeply nested; an
agent that fetches and interprets it inline spends a great deal of context
re-deriving what `crash-viewer.html` already knows how to do.

```
$ fx-tests crash YJJe4a0CRIqbAmcCo8n63w 12345678-abcd-1234-abcd-1234567890ab

Crash @ mozilla::dom::Selection::AddRangeAndSelectFramesAndNotifyListeners
  Type:    EXCEPTION_ACCESS_VIOLATION_READ
  Address: 0x0000000000000018  ** null pointer with offset 0x18
  Instruction: mov rax, qword [rcx+0x18]

Crashing thread #12 (Main Thread)
   0  xul.dll!mozilla::dom::Selection::AddRangeAndSelectFrames…  selection.cpp:1284
   1  xul.dll!mozilla::dom::Selection::AddRangeJS                selection.cpp:1150
   2  xul.dll!mozilla::dom::Selection_Binding::addRange          SelectionBinding.cpp:412
   …

7 other threads (--all-threads to show, --thread <n> for one)
```

The signature is computed the way `crash-viewer.html:520` computes it —
skipping abort/assertion frames to find the first meaningful one, and stripping
parameter lists. Reimplementing that heuristic in a prompt would get it subtly
wrong.

#### Hangs, not just crashes

A minidump is also how a **hung** process is diagnosed, and that inverts the
default output. For a crash, one thread matters and deep frames help. For a
deadlock, the question is which threads are blocked on each other, so breadth
beats depth: `--all-threads` with a shallower default.

`--all-threads` therefore uses `--frames 8`, not 20. Twenty frames × 40 threads
is thousands of lines of mostly-irrelevant stack, which is the opposite of this
command's purpose. The single-thread default stays deeper (20), since there the
frames are the answer. Both are overridable.

```
$ fx-tests crash <task-id> <minidump-id> --all-threads

41 threads. Blocked on a lock: #0, #7, #12  (see ** markers)

 #0  Main Thread                                          ** blocked
   0  ntdll.dll!NtWaitForAlertByThreadId
   1  mozilla::detail::MutexImpl::lock                     mutex.cpp:82
   …
```

Options: `--all-threads`, `--thread <n>`, `--frames <n>` (default 20, or 8 with
`--all-threads`), `--raw` (unprocessed JSON).

The retry is part of the task ID, not a separate flag: pass
`<taskId>.<retryId>`, with `.0` implied when omitted. That is already the
convention in the data files — the `taskIds` table stores `"<id>.<retry>"`, and
the resource-usage files omit `.0` exactly this way (`JSON_FORMAT.md`) — so a
task ID copied from any other command or file works unchanged.

Both arguments are required. A minidump ID is always available from wherever the
crash was found (`fx-tests crashes --minidumps`, `fx-tests test --task-ids`), and
making it optional would mean fetching the task's artifact listing to guess —
a round trip to solve a problem the caller does not have.

### `fx-tests manifests` — which manifests run where, and for how long

Reads `manifests.json` from the `manifest-timings` index. The question this
answers: a job is timing out — **which manifest is eating the budget**, and on
which configs is it worst?

It does *not* say why a manifest is slow: the file has per-manifest durations,
not per-test ones, so "one slow test or a thousand cheap ones" is a follow-up
question for `fx-tests test --durations` on the tests in that manifest. The
division of labour is worth stating because it is easy to expect more from this
data than it holds — the manifest view narrows the search to a manifest and a
config, and the per-test view explains it.

```
$ fx-tests manifests --job linux1804-64/debug-xpcshell --limit 5

Manifest                                            runs  median    p95    max
  toolkit/components/extensions/test/xpcshell/…      164   8m 12s  11m 4s  14m 2s
  dom/indexedDB/test/unit/xpcshell.toml              164   4m 30s   5m 1s   6m 12s
  netwerk/test/unit/xpcshell.toml                    164   3m 58s   4m 20s  5m 3s
  …

$ fx-tests manifests dom/indexedDB/test/unit/xpcshell.toml

dom/indexedDB/test/unit/xpcshell.toml
  Runs on 18 configs, 3 platforms: linux (10), windows (5), macos (3)
  Skipped on: test-android-em-7-0-x86_64/debug-xpcshell (4 configs)

Configuration                              runs   median      p95      max
  test-linux1804-64/debug-xpcshell          164   4m 30s    5m 1s   6m 12s
  test-windows11-64-24h2/debug-xpcshell      82   6m 12s    7m 8s   9m 30s
  …
```

A manifest whose durations are all zero on a config was skipped there rather
than run instantly (`manifests.html:415`), which is how the platform and
"skipped on" lines are derived — and a distinction easy to get wrong when
reading the raw file.

Options: `--job <list>` / `--config <list>`, `--platform <list>`,
`--sort <median|p95|max|runs|name>`, `--slower-than <duration>`, `--limit`.

### `fx-tests errors` — errors and warnings in test logs

Reads `{harness}-{date}-errors.json`. **These files are per-date only**; there
is no multi-day errors aggregate, so every invocation is scoped to one day
(`--day`, defaulting to the most recent available).

This command defaults to **`--harness mochitest`**, unlike the rest of the CLI,
which defaults to xpcshell — and the reason is a property of the data, not just
its size.

xpcshell runs its tests in parallel, so their stdout cannot be emitted as it is
produced; it is replayed only when a test fails. The xpcshell errors file is
therefore effectively **limited to the output of failing tests**, which defeats
the purpose of asking "what is noisy in CI": it is not a smaller sample of the
same population, it is a biased one, missing everything the passing majority
prints. Mochitest has no such restriction, so its file is the one that answers
the question.

The volume difference follows from this: on Thursday 2026-07-30, mochitest
recorded 103.2M markers across 31,047 jobs against xpcshell's 339K across 1,434.

Pick a weekday when quoting or comparing these numbers. Push volume drops
several-fold at weekends — the same two files for Sunday 2026-08-02 show 38.2M
and 134K, about a third of the Thursday figures — so a weekend day understates
everything and is a poor baseline for "is this normal?".

`--harness xpcshell` still works, and is meaningful for the narrower question
"what did this failing xpcshell test print?" — just not for measuring overall
noise.

One practical consequence: the mochitest errors file is large — ~97 MB for that
Thursday, vs ~570 KB for xpcshell. It is worth caching, and worth having
`--limit` default to something small.

Marker kinds come from the file itself (`tables.markerNames`) and vary by
harness and build: `C++ warning`, `C++ assertion`, `JavaScript error`,
`JavaScript warning`, `console.error`, `console.warn`, and — on instrumented
builds — `TSan Error`. Do not hardcode the list; read it from the file.

#### Ranking noise (the dominant use case)

The main reason to run this: an agent tasked with reducing CI log noise needs to
know what the loudest offenders are, since a handful of messages account for
most of the volume.

```
$ fx-tests errors --kind "C++ warning" --limit 3

mochitest, 2026-07-30 — 31,047 jobs, 103,186,014 markers
  C++ warning 75,901,067 · JS error 13,218,657 · console.error 7,441,599
  JS warning 3,537,720 · console.warn 3,060,974 · C++ assertion 25,948 · TSan 49

 occurrences  tests  message
  16,944,808  4,827  'NS_FAILED(rv)'
                     xpcom/threads/nsThreadUtils.cpp:237
   5,590,810  7,894  Frames were in different child lists???
                     layout/base/nsLayoutUtils.cpp:1300
   5,183,224  9,367  NS_ENSURE_TRUE(entry && entry->mInfo->mSharedState.Get()…
                     docshell/shistory/SessionHistoryEntry.cpp:1106
```

Real numbers from that date's file. The shape of the problem is visible in the
first row: one warning accounts for 16.9M of 103.2M markers, and the top three
for over a quarter — which is why ranking is the useful default view.

The per-kind totals on the second line come from `metadata.markerCounts`, so
"how noisy is this harness today, and in which category" costs one file read.

#### Is this error specific to one test, or everywhere?

The `tests` column is the discriminator, and it is available because marker
groups are keyed by (test, message). A message in 119 tests is background noise;
one in a single test is a candidate cause.

```
$ fx-tests errors --message "NS_ERROR_MALFORMED_URI"

"NS_ERROR_MALFORMED_URI: Couldn't build a valid uri"
  JavaScript error · resource://gre/modules/URIFixup.sys.mjs:450
  6,504 occurrences in 1 test  — specific to this test, not ambient noise
    6,504  netwerk/test/unit/test_URIFixup.js
```

#### Was the error there when the test was passing?

Answer this by **comparing days**, not within a day: run the command for a date
when the test was passing and for one when it was failing, and compare. Use
`fx-tests test <path> --history` to find those dates.

```
$ fx-tests errors --test netwerk/test/unit/test_bug1195415.js --day 2026-07-28
$ fx-tests errors --test netwerk/test/unit/test_bug1195415.js --day 2026-07-30
```

Compare like with like: two weekdays, as above. Pairing a weekday against a
weekend day makes the occurrence counts differ for reasons that have nothing to
do with the test.

A single-day errors file cannot answer it directly: it has no day axis, and it
records which *task* each occurrence came from but not whether that task's run
of the test passed. Correlating error-to-outcome within one file would mean
joining against the timing data for the same date — possible, but it is not
what the errors file gives you, so the CLI does not pretend otherwise.

Options: `--message <substring>`, `--kind <name>`, `--test <path>`,
`--component <substring>`, `--file <substring>`, `--day <date>`,
`--group-by <message|location|test|component|kind>`,
`--sort <occurrences|tests>`, `--task-ids`, `--limit` (default 20).

Grouping is by source location (file + line) as well as message text, following
`errors.html`'s change to group by location rather than message alone — the same
message from two different files is two different problems.

### `fx-tests summary` — the landing-page numbers

The 7-day topline: flaky test-failure rate, flaky job-failure rate, skip
rate, invalid-job rate, per harness, with the trend against the prior period.
Cheap: reads only the small `*-stats.json`.

```
$ fx-tests summary

xpcshell   (7d ending 2026-08-02)          vs prior 7d
  test failure rate      0.42%                 -0.08
  job failure rate       3.10%                 +0.20
  skip rate              2.41%                 =
  invalid job rate       0.71%                 -0.05
```

### `fx-tests skips` — what is disabled and where

Skipped tests grouped by directory or component with their `skip-if`
conditions — for "what is turned off on Windows?". `run-if` annotations mean
"not applicable on this platform" rather than "disabled because broken", and
are excluded by default; `--include-run-if` keeps them.

### `fx-tests guide` — orientation for an agent

Prints the whole tool's model of the data in one go: what each command answers,
which file family it reads, what the data cannot tell you, and worked
investigation patterns ("a test failed on Try", "a job is timing out", "reduce
log noise"). Modelled on `profiler-cli guide`, which the `profiler-analysis`
skill has agents read in full before touching a profile.

The reason to have it is that the traps here are not discoverable from `--help`:
that the errors files are per-date with no aggregate, that a manifest's
all-zero durations mean skipped rather than instant, that per-test profile URLs
require the failure message, that a test's overall failure rate understates a
single-config perma-fail. An agent that reads `guide` first stops re-deriving
those; one that does not will confidently get them wrong.

It should stay well under `profiler-cli guide`'s ~400 lines — long enough to
convey the traps, short enough that reading it is cheap. If a companion skill is
added later, its instruction is one line: run `fx-tests guide` and read all of
it.

**Its factual claims should be test assertions, not prose to remember to update.**
"Review it when caveats change" is the mitigation that always fails. Anything
`guide` asserts that is mechanically checkable — the errors files are per-date,
`errors` defaults to mochitest, `--since` filters the aggregate while `--day`
fetches a daily file, these exit codes mean these things — should be covered by a
test that fails when the behaviour and the text diverge. The prose that remains
unverifiable (why a trap matters, how to approach an investigation) is the part
worth writing by hand.

### `fx-tests dates` / `fx-tests cache`

`dates` lists the dates for which data exists (from `index.json`) — useful
for checking whether last night's job actually ran. `cache [--clear] [--size]`
inspects the local cache.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | Usage error (bad flag, missing argument, `--json` with `--markdown`). |
| 2 | Not found (no such test, no data for that revision, no such minidump). |
| 3 | Upstream **temporarily** unavailable — CI index unreachable, network failure, 5xx. Retrying may work. |
| 4 | Data **permanently** gone — a Taskcluster artifact that has expired. Retrying will not help. |

The 3/4 split exists so a script can tell "try again in a minute" from "this crash
dump is never coming back". Taskcluster artifacts expire (typically after a year,
sooner for some), so `fx-tests crash` on an old task exits 4 — the crash existed,
its dump is gone — while the same command during a Taskcluster outage exits 3.

`fx-tests try` exits 0 whether or not it found failures: the failures are the
answer, not an error. Scripts should branch on `--json` output, not the exit
code.

## Non-goals

- **No writes.** The CLI never mutates CI, Bugzilla, or Treeherder.
- **No data generation.** Producing the JSON files is `fetch-test-data.js`'s
  job, in mozilla-central. The CLI is strictly a reader.
- **No chart rendering.** Distributions are reported as summary statistics
  (median/p95/max) rather than plotted.
- **No symbolication.** `fx-tests crash` reads the *already* symbolized
  stackwalk JSON that CI uploads; it does not run minidump-stackwalk.
- **No history beyond 21 days.** Taskcluster retains artifacts for roughly a
  year, so deeper history is *possible* by resolving older index tasks — but no
  dashboard does it, and the CLI matches them. Deliberately deferred, not
  precluded.
- **Not a dashboard replacement.** Visual exploration across thousands of
  tests is what the web pages are good at; this is for targeted questions.

## Command summary

| Command | Reads | Answers |
| --- | --- | --- |
| `test <path>` | 64-bucket file, or daily with `--day` | Is this test failing, where, since when, and where does it run at all? |
| `try <rev>` | Treeherder + 21-day aggregate | Which failures in my push are mine? |
| `issues` | `-issues.json` | What is failing across the tree? |
| `failures` / `crashes` | `-issues.json` | Grouped by message / signature. |
| `crash <task-id> <minidump>` | task artifact | What crashed or deadlocked, and where? |
| `manifests [name]` | `manifests.json` | Which manifest is eating a job's time budget? |
| `errors` | `{harness}-{date}-errors.json` | What is loudest in the logs? Is this message ambient or specific? |
| `summary` | `-stats.json` | The 7-day topline. |
| `skips` | `-issues.json` | What is disabled, and where? |
| `guide` | — | How do I use this, and what can the data not tell me? |
| `dates` / `cache` | `index.json` / local | Is the data fresh? What is cached? |
