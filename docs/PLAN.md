# Plan: extract a shared data library, then build the CLI on it

Goal: a `fx-tests` CLI ([`CLI.md`](CLI.md)) that reads the same data as the
dashboards, built on a **typed, tested library** rather than a second copy of the
data logic.

The library is the deliverable this plan is really about; the CLI is its first
consumer and the thing that proves it works. The existing dashboards are left
untouched here — migrating them onto the library is worthwhile but is a separate
exercise with a different goal (test coverage for page logic), discussed at the
end of §3.

What makes the library non-trivial is the data: nine file shapes across four
Taskcluster indexes, several of them with per-status variations, plus a handful of
semantic rules that are invisible in the format and easy to get wrong. §1 is the
survey of that, including where the current pages disagree with each other.

---

## 1. What the code looks like today

Data flow: `fetch-test-data.js` (in mozilla-central,
`testing/timings/`) queries Firefox CI and writes compact table-encoded JSON to
the Taskcluster index; every page fetches those files at runtime and decodes
them inline. Formats are documented in `testing/timings/JSON_FORMAT.md`.

There are five distinct file families, and code that reads them must handle
all five — this is the main source of accidental complexity:

| File | Shape of a `statusGroup` |
| --- | --- |
| `{harness}-{date}.json` (daily) | flat `taskIdIds` / `durations` / `timestamps`; delta-encoded timestamps |
| `{harness}-issues.json` (21d) | `counts` + delta-encoded `days`; no task IDs at all |
| `{harness}-issues-with-taskids.json` (21d) | `taskIdIds` as **array of arrays** per (day, message, signature) bucket |
| `{harness}-00.json` … `-3f.json` (64 buckets) | three *different* shapes by status: pass → `durations` as array-of-arrays + `jobNameIds`; skip → `counts` + `jobNameIds` + `messageIds`; fail → array-of-arrays `taskIdIds`. **All three carry delta-encoded `days`**, so a single-day or day-range view is a filter on this file, not a reason to fetch a daily one |
| `{harness}-stats.json`, `index.json` | flat parallel arrays by date |

Plus four more, on their own shapes and (for two of them) their own Taskcluster
indexes:

| File | Index | Shape | Consumer |
| --- | --- | --- | --- |
| `{harness}-{date}-errors.json` | `{harness}-timings` | two-level interning: `markers` grouped by (test, message), with **delta-encoded `taskIdIds`** per group and parallel `counts`; `metadata.markerCounts` gives per-kind totals. Marker kinds are data, not a fixed list (a TSan build adds `TSan Error`). **Coverage differs by harness** — see below | `errors.html` |
| `manifests.json` | `manifest-timings` | `runs` parallel arrays (`manifestIds`/`jobNameIds`/`taskIds`/`durations`) + `manifests`/`jobNames`/`tasks`/`commits`/`prefixes` tables | `manifests.html` |
| `{harness}-{date}-resources.json` | `{harness}-timings` | `jobs` parallel arrays, 10 CPU buckets, delta-encoded `startTimes` | `resource-use.html`, `job-speed.html` |
| minidump-stackwalk JSON | per-task artifact | nested `crash_info` / `threads` / `frames`; **not** table-encoded | `crash-viewer.html` |

`worker-data` is a fifth index (`workers.html`), out of scope for the CLI.

Two of these carry real domain logic that the CLI needs and that would be
error-prone to re-derive:

- **Crash signature generation** (`crash-viewer.html:520`): walk the crashing
  thread's frames, skip abort/assertion frames to find the first meaningful one,
  strip parameter lists. It also detects null-pointer dereferences from the
  faulting address (`:729`).
- **Manifest skip detection** (`manifests.html:415`): a manifest whose durations
  are all zero on a config was skipped there, not run instantly. Miss this and
  every skipped config reads as infinitely fast.

### Two execution concepts the plan was missing

Neither is expressible as a simple pass/fail count, and both change what a
failure *means*. The dashboards handle them partially and inconsistently; the
library should model them properly, and the CLI should not be worse than
`try.html` is today.

**Initial run vs harness rerun.** When a test fails, the harness reruns it within
the same job. `try.html` tracks this (`isRetry` at `:1022`, `passedOnRetry` at
`:1408`) and it is decisive for triage: failed-then-passed-on-rerun is an
intermittent, while failed-in-both is much closer to a real breakage. Note this
is a *within-job* rerun and is distinct from a **job-level retry**, the
`retryId`/`runs/<n>` axis — two different things that both get called "retry" and
must not be conflated in the model. `try.html:1381` keys runs by
`${taskId}.${retryId}` to keep them apart.

**Parallel vs sequential execution.** Statuses are suffixed `-PARALLEL` /
`-SEQUENTIAL` (`PASS-PARALLEL`, `FAIL-PARALLEL`, `TIMEOUT-PARALLEL`, …), so a
failure carries information about whether it happened under parallel load. A test
that only fails in parallel is likely racing with its neighbours rather than
broken on its own. `issues.html:1216` surfaces this, but only inside a tooltip
and only aggregated per platform.

Consequences for the design: `model/status.ts` must decompose a status string
into (kind, execution mode) rather than mapping it to a single enum — which is
also why the eight ad-hoc classifiers each hardcode long status lists that go
stale whenever a suffix is added. `model/execution.ts` owns the rerun concept.
Both belong in `fx-tests test` and `fx-tests try` output; a bare failure count
that silently merges initial with rerun, or parallel with sequential, is the kind
of number that reads as precise and misleads.

And one semantic constraint that is not visible in the format at all:

- **xpcshell errors data covers only failing tests.** xpcshell runs tests in
  parallel, so stdout cannot be emitted as it is produced and is replayed only on
  failure. Its errors file is therefore a biased population, not a small sample
  of the same one — passing tests' output is simply absent. Mochitest has no such
  restriction. Anything that ranks or totals markers must not silently mix the
  two harnesses, and `fx-tests errors` defaults to mochitest for this reason.

### Multi-day error aggregation does not exist, and the reason matters

`errors.html` contains code to load a `{harness}-errors-with-taskids.json`
aggregate (`:1098`, plus the `hasDays`/`hasTasks` branches), but no such file is
published — that URL 404s, and the artifact listing for the current index task
contains only per-date `{harness}-{date}-errors.json`.

The reason is **file size**, the same constraint as the memory risk in §4: a
single weekday of mochitest errors is already ~97 MB and 103M markers, so
aggregating several days produces something neither Node nor a browser tab can
comfortably parse. Multi-day aggregation is therefore deferred until the worst
offenders are cleaned up — which is exactly the work `fx-tests errors` is meant
to support, making this a chicken-and-egg the CLI helps break.

What *did* land recently is aggregation **within** a given day.

Consequences: `formats/errors.ts` needs only the per-date shape (no `days`
axis); "was this error present when the test passed?" works by **comparing two
dates**, not by joining inside one file; and the dead aggregate branches in
`errors.html` are worth deleting when that page is touched, since they are what
misled an earlier draft of this plan into assuming the file existed.

`common-test-data.js` is a partial, recent attempt at exactly the
consolidation this plan finishes: `getCountAtIndex()` (`common-test-data.js:37`)
exists solely to paper over the first four shapes above, and
`computeConfigStats()` (`:121`) is genuinely good, carefully-reasoned code with
the domain knowledge written down in its comment. It is used by only 4 of 25
pages.

### The duplication is real and it is inconsistent

The pass/fail/skip/timeout/crash classification — the single most fundamental
operation on this data — is reimplemented **eight times**, and the copies do
not agree:

What each site does with a status must be read from the `if`/`else` **chain**, not
from the `isFail` expression alone: several places compute a broad `isFail` and
then intercept specific statuses in earlier branches. Reading only the expression
gets the answer backwards.

| Location | `UNKNOWN` lands in | `CRASH` in `isFail`? |
| --- | --- | --- |
| `common-test-data.js:296` | **ignored** — `else if (status === 'UNKNOWN') {}` at `:323`, before the fail branch | no |
| `issues.html:995` | **pass / skip / timeout, guessed from duration** (`:1024`); with no durations, all **pass** | no |
| `xpcshell-timings.html:656` | **pass / skip / timeout, guessed from duration** (`:684`) | yes |
| `issues.html:1350` | fail (no interception in this path) | yes — scope never defines `isCrash` |
| `perma-fails.html:483` | excluded via status list | no |
| `variant.html:555` | excluded via status list | no |
| `test.html:2625` | excluded via status list | no |
| `test.html:1897` | **skipped** — explicit `continue` at `:1895` | no |

So the real disagreement is three-way — ignore it, guess it from duration, or
exclude it by name — and the two pages that guess can score an `UNKNOWN` run as a
**pass**, which inflates pass rates rather than failure counts. `xpcshell-timings.html`
carries the duration heuristic in two places (`:684` and `:1213`).

**But `UNKNOWN` no longer occurs.** It is absent from `tables.statuses` entirely
in both `xpcshell-issues.json` and `mochitest-issues.json` for the 21 days
2026-07-14 → 2026-08-03 — not rare, absent. It marked jobs where structured
logging was not enabled, which explains why pages diverged freely on it: they had
stopped encountering it, so nothing visibly broke. All of the above is therefore
**dead code**, and §2 is a deletion rather than a bug fix.

The `run-if` filter is a smaller and different divergence than an earlier draft of
this plan claimed. All the sites agree on a skip with *no* message: they count it.
`msg?.startsWith('run-if')` yields `undefined` for a null message, which is falsy,
so `perma-fails.html:511`, `variant.html:575` and `test.html:2642` fall through and
count rather than `continue`. The genuine difference is structural — one group
iterates `messageIds` counting one skip per entry
(`common-test-data.js:303`, `xpcshell-timings.html:666`), the other iterates
`jobNameIds` and adds `getCountAtIndex(...)` — which diverge only when an entry's
count is not 1.

So the duplication argument stands on **one definition, tested once**, not on a
pile of live bugs: most of these paths agree today, one class of them is dead, and
the remaining differences are the kind that stay invisible until data changes
shape. That is a good reason to consolidate, and a poor reason to expect the
consolidation to fix visible numbers.

### Other constraints found in the code

- `try.html:2584` ships shared functions into a Web Worker by
  `Function.prototype.toString()`-ing them and concatenating the source. Real
  modules make this unnecessary, but the worker path must keep working.
- `fetch-utils.js` is browser-coupled but only *incidentally*: it reads
  `window.location` to pick a data source and `?data-source=`/`?profiler=` to
  override it. That is configuration, and it can be injected.
- `try.html` also hits Treeherder (`TH_BASE`, `/api/project/try/push/`,
  `/api/jobs/?push_id=` with pagination) — that logic is needed by
  `fx-tests try` and is currently entangled with rendering.
- `try.html:3711` already exposes `formatForPrompt()` + a console API for
  pasting failures into a Claude prompt. The CLI is the better home for that
  need; keep the page affordance until the CLI replaces it.

### Prerequisite

Node is installed and managed by `fnm`, which puts the active binary in a
per-shell path (`~/.local/state/fnm_multishells/<pid>_<ts>/bin/node`) that
exists only inside an interactive shell. Two consequences:

- Anything non-interactive — a CI job, a git hook, an agent's shell — will not
  find `node` on `PATH` unless it evaluates `fnm env` first. Worth keeping in
  mind for any automation added around `npm test`.
- Add an `.nvmrc`/`.node-version` file pinning the major version, so `fnm`
  selects the same Node the project is tested against. Node ≥ 20 is required
  for built-in `fetch`.

---

## 2. Target shape

```
lib/                        # the shared library — no DOM, no Node-only APIs
  formats/                  # decode: JSON in, plain objects out
    tables.ts               #   string-table + parallel-array lookups
    delta.ts                #   delta decoding (days, timestamps, startTimes)
    status-group.ts         #   the 5 statusGroup shapes -> one iterator
    daily.ts  issues.ts  buckets.ts  stats.ts  resources.ts
    errors.ts               #   markers, two-level interning, delta taskIdIds
    manifests.ts            #   manifests.json (own index, own shape)
    stackwalk.ts            #   minidump-stackwalk JSON (not table-encoded)
  model/
    status.ts               # THE status taxonomy. One definition.
    skips.ts                # run-if vs skip-if semantics
    job-name.ts             # chunk stripping, platform/build-type extraction
    execution.ts            # initial vs harness-rerun; parallel vs sequential
    crash-signature.ts      # frame-skipping signature, from crash-viewer.html
  query/
    test-stats.ts           # computeTestStats, from common-test-data.js
    config-stats.ts         # computeConfigStats, from common-test-data.js
    coverage.ts             # per-config ran/passed/skipped matrix (test.html:2610)
    issues.ts  failures.ts  crashes.ts  summary.ts
    manifest-stats.ts       # per-manifest/per-config durations + skip detection
    error-ranking.ts        # occurrences and test-spread per message
  sources/
    source.ts               # DataSource interface: name -> bytes
    http.ts                 # Taskcluster index + artifact URLs
    treeherder.ts           # push/job lookup for try
  links.ts                  # raw artifact URLs vs profiler front-end URLs
  index.ts                  # public entry point
cli/                        # Node-only: arg parsing, caching, formatting
  bin/fx-tests.ts
  commands/*.ts
  format/{text,markdown,json}.ts
  cache.ts
pages/                      # per-page entry points, one bundle each
  test.ts  try.ts  issues.ts  …
                            # build output is generated in CI, not committed:
                            # one self-contained minified .html per page + maps
test/
  fixtures/                 # small, checked-in, real-shaped data files
  ...
docs/{CLI.md,PLAN.md}
```

**Layering rule:** `lib/` is pure — it takes parsed JSON or a byte-fetching
callback and returns plain data. It must not touch `window`, `document`,
`fetch` directly, or `fs`. Browser and Node each supply a `DataSource`. This
is what makes one library serve both, and what makes it testable without a
browser or network.

### Language and module choices

- **TypeScript**, compiled. Real types beat JSDoc approximations, and the
  no-build constraint is not worth the loss — so `lib/` and `cli/` are `.ts`,
  type-checked in CI, and the pages consume build output rather than sources.
- **Inlined into each page, minified.** Load time matters for these dashboards,
  and a page importing a dozen small ES modules would pay a dozen round trips on
  a cold cache. So each page is built into a **single self-contained HTML file**:
  its own script plus exactly the library code it uses (tree-shaken), minified
  and inlined, with the HTML minified in the same pass. One request per page, no
  script round trips at all — better than today, where pages fetch several shared
  `.js` files. Splitting into small modules is for the source tree and the type
  checker; it must not reach the wire.
- **Node's built-in test runner** (`node:test`), so there are no test
  dependencies beyond the compiler and bundler.

Dependencies: none at runtime. Dev: `typescript`, plus one bundler
(`esbuild` — fast, handles TS directly, tree-shakes, minifies, no config sprawl).

### What "no build step" cost, and what replaces it

The README currently advertises no build step, and losing it has a real price:
today you edit an HTML file and reload. That property should be preserved *for
development* even though the deployed artefact is now built:

- `npm run dev` runs the bundler in watch mode, so editing `lib/` or a page
  rebuilds in milliseconds and reload still works.
- **Built in CI on deploy**, not committed — no `dist/` in the repository and no
  build output in diffs. The deployed site remains a set of static files with no
  server; it is simply generated on the way out.
- Ship source maps, so a stack trace from the deployed site remains traceable to
  source. Inlined-and-minified code is otherwise opaque, and this project's
  history already includes debugging a deployed page against a stale cache.

Inlining has a pleasant side effect: because a page and its code are one file,
there is no way to serve new HTML against a stale cached script. The mismatch
that has bitten this project before becomes structurally impossible rather than
something to guard against with content-hashed filenames.

Its cost is no cross-page caching of shared library code — a visitor moving
between dashboards re-downloads it. That is the right trade here: the code is
small next to the multi-megabyte data files each page fetches anyway, and cold
first paint on a single page is what the dashboards are judged on.

---

## 3. Sequencing

Six steps, ending with a working CLI. Steps 0–3 build and validate the library,
step 4 is the CLI core, step 5 adds the commands that need extra formats. The
existing dashboards are not modified at any point, so the site cannot regress —
page migration is a separate exercise (below).

### Step 0 — validate the types against whole real files

The point of this step is **not** to preserve current behaviour bug-for-bug. It
is to make sure the type declarations match reality before anything is built on
them, and before fixtures are cut down.

- Install Node; add `package.json`, `tsconfig.json`, the bundler config.
- Write the type declarations for every format, then **validate them against
  full, unmodified files** — every published date for both harnesses, not a
  sample. A cheap validator (walk the file, assert every field's presence and
  type, assert every index is in range for its table, report anything
  unexpected) catches the cases a truncated fixture would silently omit: a
  `null` where a number was assumed, a status string never seen locally, a
  marker kind that only appears on a TSan build, an optional field present in one
  harness and absent in the other.
  This must precede fixture creation, because a fixture is a *subset*: cut first
  and the types get validated against exactly the cases that survived the cut,
  which is circular.

  **One file per process invocation.** Sweeping every published date means tens of
  gigabytes in total — the mochitest errors file alone is ~97 MB/day — so the
  validator must be driven by a shell loop over dates, holding one file at a time.
  The §4 argument that a single file parses safely does not extend to holding
  twenty of them.

  Success criteria, so this step has a definite end: every published file for both
  harnesses parses and validates clean; the run emits (a) a list of every distinct
  status string and marker kind observed, (b) which declared fields were ever
  `null` or absent, per file family and per harness, and (c) an **`UNKNOWN`
  census** — occurrences per harness per date. That last number gates step 2, so it
  is an output of this step, not a footnote.

  Also **measure peak heap** while parsing the largest file, once, and record it.
  §4 argues parseability is safe by construction because the generator held the
  same data in memory, but the generator's heap and a contributor's default are
  not the same thing, and one measurement settles it better than an analogy.
- **Then** cut fixtures from the validated files, from a **weekday**: one daily
  file, one `issues.json`, one `issues-with-taskids.json`, one bucket file, one
  `stats.json`, one `{harness}-{date}-errors.json` for each harness (their
  coverage differs), one `manifests.json`, one crash minidump-stackwalk JSON and
  one from a hung process. Truncate real files rather than hand-writing them —
  the shapes are too subtle to invent.
- Record which fields turned out to be nullable or absent in practice; that list
  is the actual specification, and it is worth keeping in the repo next to the
  types because `JSON_FORMAT.md` lives in another tree and lags.

### Step 1 — `lib/formats` + `lib/model`: decode and classify

The foundation, and where the test coverage pays off most.

- `model/status.ts`: one `classifyStatus(status)` returning a tagged kind
  (`pass` | `fail` | `timeout` | `crash` | `skip` | `expected-fail` |
  `unknown`), plus predicates. Every question the eight variants answer
  differently becomes an explicit, documented, tested decision — including
  `UNKNOWN` and whether `CRASH` counts inside "fail" (it should be reported
  separately and *aggregatable*, which is what the disagreement was really
  about).
- `formats/status-group.ts`: the key abstraction. One iterator that yields
  uniform `{ day, count, jobName?, taskIds?, message?, crashSignature?,
  durations? }` entries regardless of which of the five shapes the group is
  in. This is `getCountAtIndex()` generalized, and it is what lets every
  higher-level query stop caring about file family.
- `formats/delta.ts`, `formats/tables.ts`: delta decoding and table lookups,
  including the `taskIds` retry-suffix discrepancy between timing and
  resource files that `JSON_FORMAT.md` warns about.
- Tests: for each fixture, iterate every status group and assert totals match
  hand-checked values; assert the daily and 21-day files agree on the same
  test's counts; property-test that delta round-trips.

### Step 2 — settle the taxonomy

Smaller than it looks, because §1's `UNKNOWN` census already decides most of it:
the status is absent from 21 days of both harnesses, so the duration-guessing
heuristics are dead code. Three things remain:

- **Do not port `UNKNOWN` handling.** The shared classifier gets an `unknown`
  kind that is counted and reported separately — never silently folded into pass
  or fail. A job without structured logging did not report an outcome, so putting
  its runs in either bucket invents information. This matters because
  `issues.html:1024` and `xpcshell-timings.html:684` currently guess such runs
  into **passes**, which inflates the landing page's pass rate; if the status ever
  returns, the library should make it visible instead of absorbing it.
- **Do not port the duration heuristics** (`xpcshell-timings.html:684`, `:1213`,
  `issues.html:1024`): `<100ms` → skip, `>300s` → timeout, else pass. Guessing an
  outcome from a runtime is not something to carry into a tested library.
- **Decide `CRASH` explicitly.** The one live disagreement: `issues.html:1350` and
  `xpcshell-timings.html:656` fold crashes into failures, everything else counts
  them separately. The library reports `crash` as its own kind and lets callers
  aggregate — which is what the disagreement was actually about.

Since step 0 validates against whole real files, it should also **re-run the
`UNKNOWN` census** rather than trusting the number above: it was measured on the
21-day aggregates on one day, and "absent" is a claim worth re-checking cheaply
before deleting code on the strength of it.

### Step 3 — `lib/query` + `lib/sources`

- Port `computeTestStats()` and `computeConfigStats()` from
  `common-test-data.js` onto the new primitives, preserving behaviour and the
  reasoning comments (the recent-window logic is subtle and correct; it should
  be moved, not rewritten).
- `query/coverage.ts`: the per-config ran/passed/skipped/never-scheduled matrix,
  ported from `test.html:2610`. New as a *library* function, not new logic —
  but it is what `fx-tests test --coverage` needs, and the reason a
  failure-only view cannot answer "does this test run on Android?".
- `sources/http.ts`: the Taskcluster index URL construction and
  redirect-base caching from `fetch-utils.js:63`, with the data-source choice
  passed in as config rather than sniffed from `window.location`. Must handle
  more than one index (`{harness}-timings`, `manifest-timings`) and per-task
  artifact URLs, which `fetch-utils.js` hardcodes around today.
- `sources/treeherder.ts`: push and job lookup extracted from
  `try.html`/`fetch-utils.js:92`, needed by both `try.html` and `fx-tests try`.
- `lib/links.ts`: the URL builders from `common-links.js` (Treeherder, artifact
  URLs, crash viewer, searchfox). Pure string construction, trivially testable,
  currently duplicated inline in several pages.

  Important split: the layer must expose the **raw artifact URL** separately from
  any `profiler.firefox.com/from-url/...` wrapper. The pages want the wrapper
  (their consumer is a human with a browser); the CLI wants the bare URL
  (its consumer is `profiler-cli`, which fetches and parses the profile itself,
  and for which a front-end URL is useless). `getProfilerUrl()`
  (`common-links.js:16`) currently fuses the two, so splitting it is the port.

  Two profile kinds, differing in derivability: the per-job resource-usage
  profile is a fixed path under `/task/<id>/runs/<retry>/artifacts/public/test_info/`,
  while the per-test failure profile's filename only appears in the failure
  message (`profile uploaded in profile_<name>.json`, parsed at
  `try.html:2900`). The library should expose both, and return nothing rather
  than guess when no profile was uploaded.
- Tests: golden-file tests for the query layer against fixtures. `sources/`
  gets a fake byte-source; no test hits the network.

### Step 4 — the CLI core

Now mostly a presentation exercise, which is the point.

- `cli/cache.ts` (disk cache keyed by URL + `generatedAt`), arg parsing
  (hand-rolled; no dependency), and the three formatters.
- Implement in ascending order of value-per-effort: `summary`, `dates`,
  `cache` (trivial), then `test` (incl. `--coverage`), then `try`, then
  `issues` / `failures` / `crashes` / `skips`.
- `guide` lands **last**, once the commands and their caveats have settled —
  written earlier it would document intentions rather than behaviour. It is
  static text, so the only real risk is drift; it should be reviewed whenever a
  command's caveats change.
- Tests: each command against fixtures via the fake source, asserting on
  `--json` output; a couple of snapshot tests for text formatting.
- `fx-tests test` and `fx-tests try` are the two commands that justify the
  project — get them right, and land the rest incrementally.

### Step 5 — the agent-facing commands: `crash`, `manifests`, `errors`

Deliberately after step 4, because each needs a format the earlier steps do not
touch — but this is the step that makes the CLI *better* than reading the
dashboards, rather than merely equivalent. Each is independent; land in any
order.

- **`crash`** — `formats/stackwalk.ts` + `model/crash-signature.ts`, ported from
  `crash-viewer.html`. The signature heuristic must be tested against real dumps
  (fixtures), because "skip abort frames, strip parameter lists" is easy to get
  subtly wrong. Cheapest of the three: one artifact fetch, no aggregation.
  Beyond the port, the CLI needs a **hang-oriented mode**: all threads, shallow
  frames, blocked-thread detection. A deadlock is diagnosed by breadth across
  threads, not depth in one, which is the opposite of the crash case and the
  reason the frame default differs between the two.
- **`manifests`** — `formats/manifests.ts` + `query/manifest-stats.ts`. Own
  index, own shape, and the all-zero-durations-means-skipped rule. Gives
  per-config manifest runtimes, which narrows a job timeout to a manifest and a
  config; explaining *why* that manifest is slow is a per-test question and
  belongs to `fx-tests test --durations`.
- **`errors`** — `formats/errors.ts` + `query/error-ranking.ts`. Decoding the
  marker format (two-level interning, delta-encoded per-group `taskIdIds`) is
  mechanical. The query layer is small: per-message occurrence totals and
  test-spread counts, plus the per-kind totals already in
  `metadata.markerCounts`. The dominant use case is ranking — "what is loudest
  in the logs" for noise-reduction work, which is what `errors.html` is mostly
  used for — and the test-spread count is what separates ambient noise from a
  message specific to one test.

### Page migration — out of scope for this plan

An earlier draft ended with two steps that migrated all 25 dashboards onto the
library. That is deliberately **removed**, for two reasons.

First, the framing was wrong. Migration's value is not "less duplication" — it is
that a page gets **test coverage** as it is rewritten, which is the thing the repo
actually lacks. Duplication is the symptom; untested code is the problem.

Second, doing it well needs decisions this plan is not the right place to make:
which page logic deserves to be shared versus stays page-specific, how to test
rendering at all (the repo has no browser tests today), how much of a page can be
restructured at once while keeping it reviewable, and in what order. Those
questions deserve their own plan, informed by how the library actually feels to
use once the CLI is built on it.

So: the CLI ships on the shared library, the pages keep working untouched, and
page migration becomes a separate exercise with test coverage as its goal. Two
small things are worth doing opportunistically whenever a page is next edited for
other reasons — `crash-viewer.html` dropping its inline signature logic in favour
of `model/crash-signature.ts`, and `errors.html` losing the dead multi-day
aggregate branches (§1) that misled this plan — but neither is scheduled here.

One consequence to keep in mind: until pages migrate, some logic exists twice, in
`lib/` and inline in a page. That is a known, temporary cost, and it is the reason
the library must be the definition of record — a fix belongs in `lib/` first, with
the page updated when it is next touched, not the reverse.

---

## 4. Risks

**The dashboards are untouched, so their numbers cannot regress.** Page
migration is out of scope (above), which removes what was previously the largest
risk here. The flip side is that the library and the pages will disagree until
pages migrate, and the library is the one with tests.

**Format drift.** `fetch-test-data.js` evolves in mozilla-central — the within-day
error aggregation landed days ago, and a sixth `statusGroup` shape could appear
next. Mitigations: validate types against whole real files (step 0) rather than
trusting `JSON_FORMAT.md`, which lives in another tree and lags; refresh fixtures
when the generator changes; and make `formats/` **throw** on an unrecognized shape
rather than silently returning a plausible number, which is exactly how the
current `getCountAtIndex()` `else { return 1; }` fallback hides surprises.

**Scope creep into the generator.** Tempting to also refactor
`fetch-test-data.js`; it lives in a different repo with a different review
process. Out of scope. The library treats the on-disk format as a contract.

**Build step regressions.** Adding a build introduces failure modes the current
setup cannot have: a deploy that fails in CI leaves the site un-updated, and
minified inlined code is harder to debug in the wild. Mitigations: source maps,
`npm run dev` in watch mode so the edit-reload loop stays as fast as today, and a
CI check that every page builds before deploy is attempted. Inlining removes the
worst of the class — new HTML can no longer be served against a stale cached
script — but this is still a real cost accepted in exchange for type checking,
not a free win.

**Large files are a real constraint, but not on parsing.** `issues-with-taskids.json`
is ~30 MB and the mochitest errors file ~97 MB for a single weekday (103M markers
on 2026-07-30), so memory is worth thinking about — but reading one file is safe
by construction: these files are produced by a Node script that builds the whole
object in memory and writes it with a single `JSON.stringify`
(`fetch-test-data.js:1033`). Anything published has already been held in one
process as both an object graph and a string, so `JSON.parse` of it is the cheaper
half of what the generator already did. No streaming parser, no heap flags.

Two things do follow. Prefer the 64-bucket files for single-test queries — what
`fx-tests test` does, and why it is fast. And aggregate in a single pass over
integer-indexed arrays rather than materializing per-occurrence objects, the way
`errors.html:275` already does, since 103M markers is where object-per-occurrence
would stop being viable.

The binding limit is on *aggregating across days*: several days of mochitest
errors exceeds what one process can hold, which is why multi-day aggregation is
deferred upstream (§1).

**Weekend volume skews every absolute number.** Push volume drops several-fold at
weekends: the same mochitest errors file for Sunday 2026-08-02 has 38.2M markers
against Thursday's 103.2M. Anything that quotes counts, compares two dates, or
picks a "recent" day must account for this — prefer weekdays for baselines, and
prefer rates over counts. `computeConfigStats()` already sizes its recent window
by run count rather than by days for exactly this reason, which is the pattern to
follow rather than reinvent.

**Per-task artifact fetching is a new dependency shape.** Every other command
reads nightly aggregates: stable URLs, cacheable, one round trip. `fx-tests
crash` instead fetches a *specific task's* artifact, which can 404 (never
uploaded), expire (Taskcluster retention), or require following a redirect to
`firefoxci.taskcluster-artifacts.net`. It needs its own error handling and
should not share the aggregate cache's assumptions — hence the distinct exit
exit code 4 for permanently-gone artifacts, distinct from 3 for a transient
upstream failure.

---

## 5. What I would confirm before starting

1. **Command priorities.** Twelve commands is a lot to land at once. My ordering
   assumption is `test`/`try` first (step 4), then `errors` > `manifests` >
   `crash` (step 5, by value); say if your debugging loop weights them
   differently.
2. **How much execution detail belongs in default output?** Initial-vs-rerun and
   parallel-vs-sequential both matter, but showing every axis by default makes
   `fx-tests test` noisy. My assumption: the verdict line mentions them when they
   change the interpretation (passed on rerun, fails only in parallel), with full
   breakdowns behind flags.
