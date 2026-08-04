# Are Tests Fast Yet?

Dashboards, and a command-line tool, for inspecting the health and performance
of Firefox's automated tests, built from data generated in Firefox CI.

Live site: <https://tests.firefox.dev/>, where the data is refreshed every
night. There is also a staging instance at
<https://fqueze.github.io/aretestsfastyet/> used to develop the dashboards
themselves; its data is regenerated whenever work-in-progress patches to the
data generator are pushed to Try.

## Dashboards

Every page is listed on [`help.html`](help.html); the most useful ones are
also reachable from the "Dashboards ▾" menu in the top-right corner of each
page. The main ones:

- **Test Health** (`index.html`) — the landing page. Trend charts and a 7-day
  summary of flaky test-failure, flaky job-failure, skip and invalid-job rates
  for XPCShell and Mochitest.
- **Test Issues** (`issues.html`) — every non-passing test outcome (failures,
  timeouts, crashes, skips) over the last 21 days, grouped by Bugzilla
  component and by directory tree. The best place to start triaging
  intermittents.
- **Test Info** (`test.html`) — a deep dive on a single test
  (`?test=path/to/test`): failure/skip/crash history, per-run timings, and a
  pass/fail breakdown across job configurations.
- **Try Push Results** (`try.html`) — aggregates the failed tests from a single
  Try push, perma-fails first, matched against historical data.
- **Failures** (`failures.html`) / **Crashes** (`crashes.html`) — failures
  grouped by message, and crashes grouped by signature.
- **Test Timings** (`xpcshell-timings.html`) — per-test run times with a tree
  view and scatter charts.
- **Build Times** (`builds.html`), **Mochitest Jobs** (`mochitest-jobs.html`),
  **XPCShell Jobs** (`xpcshell-jobs.html`), **Manifest Runtimes**
  (`manifests.html`), **Worker Pools** (`workers.html`) — job- and
  infrastructure-level timing views.

A number of older or more specialized dashboards (Perma-Fails, Variant Impact,
Errors & Warnings, Resource Usage, and others) are listed under "Less
frequently used dashboards" on `help.html`.

## How it works

The site is a set of static HTML pages with inline CSS and JavaScript, sharing
a few scripts (`fetch-utils.js`, `shared.js`, `common-ui.js`, `dashboards.js`,
…). **The dashboards have no build step** — they are served exactly as they
appear in the tree, and editing a page and reloading it is the whole loop.

Each page fetches pre-aggregated JSON data from the Firefox CI (Taskcluster)
index at runtime — there is no server. The data is produced by
[`fetch-test-data.js`](https://searchfox.org/mozilla-central/source/testing/timings/fetch-test-data.js)
in mozilla-central, which queries Firefox CI and writes the compact,
table-encoded JSON files the dashboards consume.

The command-line tool below does have a toolchain — TypeScript, a bundler and a
test suite — and it is deliberately confined to `cli/`, `lib/`, `test/` and
`tools/`. No page depends on it, and none of the HTML in this repository is
generated. See [`docs/PLAN.md`](docs/PLAN.md) for why migrating the pages onto
the shared library is a separate exercise rather than part of this one.

## `fx-tests`, the command-line tool

`fx-tests` answers the same questions as the dashboards in plain text, for
people and agents working in a terminal rather than a browser. It reads exactly
the same published JSON files, through a shared, typed and tested library in
`lib/` — there is no second data path and no server.

```sh
./bin/fx-tests guide                       # start here
./bin/fx-tests test netwerk/test/unit/test_bug1195415.js
./bin/fx-tests try <revision>              # triage a Try push
./bin/fx-tests errors --limit 10           # what is loudest in the logs
./bin/fx-tests --help                      # the full command list
```

Node ≥ 20 is required, for built-in `fetch`; `.node-version` pins the major
version for `fnm`. `./bin/fx-tests` runs the TypeScript sources directly and
needs no build. `npm run build` produces the bundled `bin/fx-tests.js` that the
`bin` entry in `package.json` points at, and `npm test` and `npm run typecheck`
are the other two gates.

**`fx-tests guide` is the intended entry point.** It prints what each command
answers, which file family it reads, and — the reason it exists — the traps in
this data that are not discoverable from `--help`: that the errors files exist
for only a few of the published dates, that a manifest with all-zero durations
was skipped rather than instant, that a test's overall failure rate hides a
single-config perma-fail. Its factual claims are covered by tests, so it fails
the suite rather than going quietly stale.

[`docs/CLI.md`](docs/CLI.md) is the full command reference and
[`docs/PLAN.md`](docs/PLAN.md) describes how the library was extracted.

## Data format

The JSON file formats are documented in
[`JSON_FORMAT.md`](https://searchfox.org/mozilla-central/source/testing/timings/JSON_FORMAT.md),
which lives next to the generator in mozilla-central, and in
[`lib/formats/FORMATS.md`](lib/formats/FORMATS.md) in this repository.

The two differ in kind. `JSON_FORMAT.md` describes what the generator was
written to emit; `FORMATS.md` records what the index was actually serving, from
validating every file the index publishes. It lags less, and where the two
disagree it is the one to trust — it exists because several documented claims
turned out not to hold.
