/**
 * The CLI, end to end, against the checked-in fixtures.
 *
 * Every test here calls `run()` with a `memorySource` and captured streams:
 * no subprocess, no network, no disk cache unless the test builds one in a
 * temporary directory. `PLAN.md` §3 step 4 requires that no test hits the
 * network, and the injected source is what makes that structural rather than
 * a rule to remember.
 *
 * ## What the golden numbers are, and where they came from
 *
 * The expected counts below were derived **from the fixture JSON directly**,
 * by a throwaway script that sums the raw parallel arrays — not by running the
 * code under test and recording what it said. That distinction is the whole
 * value of the assertion: a golden captured from the implementation only
 * proves the implementation is deterministic.
 *
 * `dom/indexedDB/test/unit/test_rename_objectStore_errors.js` in
 * `xpcshell-00.json` is the workhorse fixture test, because it exercises seven
 * statuses at once: `PASS-PARALLEL` (15,638), `PASS-SEQUENTIAL` (6), `PASS`
 * (314), `SKIP` (1,348), `CRASH` (6), `FAIL-PARALLEL` (2) and
 * `FAIL-SEQUENTIAL` (2). The three pass buckets are what
 * `--executions` must not merge, and the skips are all `skip-if` with no
 * `run-if`, which is the aggregate-family invariant `FORMATS.md` records.
 *
 * ## What is deliberately asserted about *absence*
 *
 * Several tests assert that something is **not** printed or **not** fetched:
 * that `--day` reads no daily file, that a mochitest `--executions` prints no
 * mode table, that an uncomparable message shows `?` rather than `0.0%`. Those
 * are the regressions that produce plausible output, so they are the ones
 * worth pinning.
 */

import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { type DataFileName, type DataSource, DataFetchError, DataFileNotFoundError } from '../lib/sources/source.ts';
import type { TreeherderClient, TreeherderJob } from '../lib/sources/treeherder.ts';
import { ExitCode } from '../cli/errors.ts';
import { captureStreams } from '../cli/context.ts';
import { diskCache } from '../cli/cache.ts';
import { run } from '../cli/main.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

async function fixtureBytes(name: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(new URL(name, FIXTURES)));
}

/** The test whose counts every golden below refers to. */
const TEST_PATH = 'dom/indexedDB/test/unit/test_rename_objectStore_errors.js';
/** A mochitest in `mochitest-00.json`, for the no-mode-axis assertions. */
const MOCHITEST_PATH =
    'browser/components/tabbrowser/test/browser/tabs/browser_tab_dragdrop2.js';

/**
 * A source serving the fixtures under the names the CLI asks for.
 *
 * Records every requested name, so a test can assert **what was not
 * fetched** — which is how `--day must not read a daily file` is checked. An
 * assertion on the output alone could not tell the two paths apart.
 */
function fixtureSource(): DataSource & { requested: string[] } {
    const requested: string[] = [];
    const files: Record<string, string> = {
        // The bucket `TEST_PATH` hashes into is 00, which is the fixture.
        'xpcshell-timings/xpcshell-00.json': 'xpcshell-00.json',
        'mochitest-timings/mochitest-00.json': 'mochitest-00.json',
        'xpcshell-timings/xpcshell-stats.json': 'xpcshell-stats.json',
        'mochitest-timings/mochitest-stats.json': 'mochitest-stats.json',
        'xpcshell-timings/index.json': 'index.json',
        'mochitest-timings/index.json': 'index.json',
        'xpcshell-timings/xpcshell-2026-08-03.json': 'xpcshell-2026-08-03.json',
    };
    return {
        name: 'fixtures',
        requested,
        async fetch(fileName: DataFileName): Promise<Uint8Array> {
            const key = `${fileName.index}/${fileName.filename}`;
            requested.push(key);
            const local = files[key];
            if (local === undefined) {
                throw new DataFileNotFoundError(fileName);
            }
            return fixtureBytes(local);
        },
    };
}

/** Runs one invocation and returns everything a test might assert on. */
async function invoke(
    argv: string[],
    overrides: Partial<Parameters<typeof run>[0]> = {}
): Promise<{ code: number; stdout: string; stderr: string; source: DataSource & { requested: string[] } }> {
    const streams = captureStreams();
    const source = (overrides.source as DataSource & { requested: string[] }) ?? fixtureSource();
    const code = await run({
        argv,
        streams,
        source,
        // A cache that can never be read or written: these tests must not
        // depend on, or leave behind, anything in the developer's real cache.
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        ...overrides,
    });
    return { code, stdout: streams.stdout, stderr: streams.stderr, source };
}

/** Parses `--json` stdout. */
function json(stdout: string): Record<string, unknown> {
    return JSON.parse(stdout) as Record<string, unknown>;
}

// --- argument parsing and exit codes -------------------------------------

test('--json and --markdown together is a usage error, not one winning', async () => {
    const { code, stdout, stderr } = await invoke(['test', TEST_PATH, '--json', '--markdown']);
    assert.equal(code, ExitCode.Usage);
    assert.equal(stdout, '', 'a usage error must print nothing to stdout');
    assert.match(stderr, /mutually exclusive/);
});

test('an unknown option exits 1 and suggests the closest real one', async () => {
    const { code, stderr } = await invoke(['test', TEST_PATH, '--covrage']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /unknown option --covrage/);
    assert.match(stderr, /Did you mean --coverage\?/);
});

test('an option missing its value exits 1 naming the option, not consuming the next flag', async () => {
    const { code, stderr } = await invoke(['test', TEST_PATH, '--limit', '--json']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /--limit requires a value/);
});

test('--limit rejects a non-integer rather than silently flooring it', async () => {
    const { code, stderr } = await invoke(['test', TEST_PATH, '--limit', '2.5']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /non-negative integer/);
});

test('a value on a boolean option is a usage error', async () => {
    const { code, stderr } = await invoke(['test', TEST_PATH, '--json=yes']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /--json takes no value/);
});

test('--day and --since together is a usage error', async () => {
    const { code, stderr } = await invoke(['test', TEST_PATH, '--day', '2026-08-03', '--since', '3']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /mutually exclusive/);
});

test('--harness rejects an unknown harness', async () => {
    const { code, stderr } = await invoke(['test', TEST_PATH, '--harness', 'reftest']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /expects xpcshell or mochitest/);
});

test('an unknown command exits 1 and lists what exists', async () => {
    const { code, stderr } = await invoke(['tset']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /unknown command "tset"/);
});

test('a command CLI.md specifies but step 5 will add says so, rather than "unknown"', async () => {
    const { code, stderr } = await invoke(['errors']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /not implemented yet/);
    assert.match(stderr, /errors and warnings in test logs/);
});

test('--help exits 0 and writes to stdout', async () => {
    const { code, stdout, stderr } = await invoke(['--help']);
    assert.equal(code, ExitCode.Success);
    assert.match(stdout, /Usage: fx-tests <command>/);
    assert.equal(stderr, '');
});

test('test with no path exits 1', async () => {
    const { code, stderr } = await invoke(['test']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /requires a path/);
});

// --- the harness-miss message --------------------------------------------

test('a lookup miss exits 2 and makes the inference explicit', async () => {
    const { code, stderr } = await invoke(['test', 'dom/base/test/test_nonexistent90.js']);
    assert.equal(code, ExitCode.NotFound);
    // Both halves matter: which harness was searched, and that it was a guess.
    assert.match(stderr, /No such test in xpcshell data \(harness inferred from filename\)/);
    assert.match(stderr, /retry with --harness mochitest/);
});

test('an explicit --harness does not claim the harness was inferred', async () => {
    const { code, stderr } = await invoke([
        'test',
        'dom/base/test/test_nonexistent90.js',
        '--harness',
        'xpcshell',
    ]);
    assert.equal(code, ExitCode.NotFound);
    assert.doesNotMatch(stderr, /inferred/);
    // And no suggestion to switch, since the user chose deliberately.
    assert.doesNotMatch(stderr, /retry with --harness/);
});

test('browser_*.js infers mochitest, test_*.js infers xpcshell', async () => {
    const miss = await invoke(['test', 'dom/base/test/browser_nonexistent70.js']);
    assert.match(miss.stderr, /No such test in mochitest data/);
    assert.match(miss.stderr, /retry with --harness xpcshell/);
});

// --- fx-tests test -------------------------------------------------------

test('test --json reports the totals the fixture actually contains', async () => {
    const { code, stdout } = await invoke(['test', TEST_PATH, '--json']);
    assert.equal(code, ExitCode.Success);
    const result = json(stdout);
    assert.equal(result['path'], TEST_PATH);
    assert.equal(result['component'], 'Core :: Storage: IndexedDB');
    assert.equal(result['harness'], 'xpcshell');

    // Derived from the fixture JSON by summing the raw arrays, not from the
    // code under test. PASS-PARALLEL 15638 + PASS-SEQUENTIAL 6 + PASS 314.
    const totals = result['totals'] as Record<string, number>;
    assert.equal(totals['passCount'], 15_958);
    assert.equal(totals['failCount'], 4, 'FAIL-PARALLEL 2 + FAIL-SEQUENTIAL 2');
    assert.equal(totals['crashCount'], 6);
    assert.equal(totals['timeoutCount'], 0);
    // Every skip here is a `skip-if`; the aggregates carry no `run-if` at all.
    assert.equal(totals['skipCount'], 1_348);
    assert.equal(totals['runIfSkipCount'], 0);
    // Runs exclude skips: 15958 + 4 + 6 + 0 + 0.
    assert.equal(totals['runCount'], 15_968);
    assert.equal(totals['unknownCount'], 0);
});

test('test --json attributes failures to configs, counting a crash as a failure', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    const configs = json(stdout)['configs'] as { jobName: string; failCount: number }[];
    // Two configs, and which two is the point: the 4 FAIL-* runs are all on
    // one Windows config, and the 6 CRASH runs are all on one macOS config.
    // A crash is a failure for the purpose of "where does this break", which
    // is the disagreement PLAN.md §2 settled — the library reports `crash`
    // separately and lets the caller aggregate, and this is the caller doing
    // so deliberately rather than by accident.
    const byJob = Object.fromEntries(configs.map((c) => [c.jobName, c.failCount]));
    assert.deepEqual(byJob, {
        'test-macosx1015-64-qr/debug-xpcshell': 6,
        'test-windows11-64-25h2-shippable/opt-xpcshell': 4,
    });
});

test('test --json reports canAttributeConfigs', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    // KNOWN WEAK ASSERTION, recorded rather than dressed up: `fx-tests test`
    // only ever reads a bucket file, for which the honest answer is `true`,
    // so replacing the call with a literal `true` passes this test. A
    // mutation confirmed it survives.
    //
    // Closing it properly needs a command that reads `issues.json`, which is
    // step 5's `fx-tests issues`. Until then the predicate itself is covered
    // against that family by the test above, and what is untested is one line
    // of wiring. Noted here so the next person does not mistake a green suite
    // for coverage of it.
    assert.equal(json(stdout)['canAttributeConfigs'], true);
});

test('canAttributeConfigs is false for a family that cannot attribute', async () => {
    // The bucket fixture can attribute, so asserting `true` against it proves
    // nothing — a hardcoded `true` survives that test. `issues.json` has no
    // `taskInfo` at all, which is the case the field exists to distinguish,
    // and it has to be reached through the library because no CLI command
    // reads that family yet.
    const { decodeIssues } = await import('../lib/formats/issues.ts');
    type IssuesFile = import('../lib/formats/issues.ts').IssuesFile;
    const { canAttributeConfigs, computeConfigStats } = await import(
        '../lib/query/config-stats.ts'
    );
    const issues = decodeIssues(
        JSON.parse(
            new TextDecoder().decode(await fixtureBytes('xpcshell-issues.json'))
        ) as IssuesFile
    );
    assert.equal(canAttributeConfigs(issues), false);

    // And the reason it matters: `computeConfigStats` returns [] here for a
    // test that definitely failed, so [] must not be read as "no config
    // failed". Only the predicate separates the two.
    let testIdWithFailures: number | null = null;
    for (let id = 0; id < issues.testCount && testIdWithFailures === null; id++) {
        for (const [status, count] of issues.totalsByStatus(id)) {
            if (status.startsWith('FAIL') && count > 0) {
                testIdWithFailures = id;
                break;
            }
        }
    }
    assert.ok(testIdWithFailures !== null, 'the issues fixture has a failing test');
    assert.deepEqual(computeConfigStats(issues, testIdWithFailures), []);
});

test('the skip section reports the skip-if condition and its count', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    const skips = json(stdout)['skips'] as { message: string; count: number }[];
    assert.equal(skips.length, 1);
    assert.equal(skips[0]!.count, 1_348);
    assert.match(skips[0]!.message, /os == 'android'/);
});

test('the recent window is reported, not assumed, and is sized by runs', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    const window = json(stdout)['recentWindow'] as { days: number; minRuns: number };
    assert.ok(window !== null, 'a multi-day query must state the window it used');
    assert.equal(window.minRuns, 20);
    assert.ok(
        window.days >= 1 && window.days <= 21,
        `recent window ${window.days} must be within the 21-day file`
    );
});

test('text output states the window width it used', async () => {
    const { stdout } = await invoke(['test', TEST_PATH]);
    assert.match(stdout, /recent = last \d+d, sized so the sparsest config has 20\+ runs/);
});

test('every date printed carries its weekday', async () => {
    const { stdout } = await invoke(['test', TEST_PATH]);
    // The fixture window ends 2026-08-03, a Monday. Without the weekday a
    // reader cannot tell a weekend count from a weekday one, and FORMATS.md
    // measures a 2.6x difference in volume between them.
    assert.match(stdout, /2026-08-03 \(Mon\)/);
    assert.match(stdout, /2026-07-14 \(Tue\)/);
});

// --- --day / --since are filters, not a different file --------------------

test('--day inside the window filters the bucket file and fetches no daily file', async () => {
    const { code, stdout, source } = await invoke([
        'test',
        TEST_PATH,
        '--day',
        '2026-08-03',
        '--json',
    ]);
    assert.equal(code, ExitCode.Success);
    // The load-bearing assertion. A daily file is 10x the size, drops
    // different skips and disagrees on job membership (FORMATS.md), so
    // switching families on a flag would silently change the population.
    assert.deepEqual(source.requested, ['xpcshell-timings/xpcshell-00.json']);
    const metadata = json(stdout)['metadata'] as Record<string, unknown>;
    assert.equal(metadata['singleDay'], true);
    assert.equal(metadata['dayCount'], 1);
    assert.equal(metadata['family'], 'bucket');
});

test('--day narrows the counts rather than returning the whole window', async () => {
    const whole = json((await invoke(['test', TEST_PATH, '--json'])).stdout);
    const oneDay = json(
        (await invoke(['test', TEST_PATH, '--day', '2026-08-03', '--json'])).stdout
    );
    const wholeRuns = (whole['totals'] as Record<string, number>)['runCount']!;
    const dayRuns = (oneDay['totals'] as Record<string, number>)['runCount']!;
    assert.ok(dayRuns > 0, 'the fixture has runs on its last day');
    assert.ok(
        dayRuns < wholeRuns,
        `one day (${dayRuns}) must be fewer runs than 21 (${wholeRuns})`
    );
});

test('--since n and --day agree when n is 1', async () => {
    const day = json((await invoke(['test', TEST_PATH, '--day', '2026-08-03', '--json'])).stdout);
    const since = json((await invoke(['test', TEST_PATH, '--since', '1', '--json'])).stdout);
    assert.deepEqual(day['totals'], since['totals']);
});

test('--since sums to the whole window when it covers it', async () => {
    const whole = json((await invoke(['test', TEST_PATH, '--json'])).stdout);
    const since21 = json((await invoke(['test', TEST_PATH, '--since', '21', '--json'])).stdout);
    assert.deepEqual(whole['totals'], since21['totals']);
});

test('--since beyond the window clamps rather than erroring', async () => {
    const { code, stdout } = await invoke(['test', TEST_PATH, '--since', '90', '--json']);
    assert.equal(code, ExitCode.Success);
    const metadata = json(stdout)['metadata'] as Record<string, number>;
    assert.equal(metadata['dayCount'], 21, 'clamped to what the file has');
});

test('--day outside the window exits 2 and names the window', async () => {
    const { code, stderr } = await invoke(['test', TEST_PATH, '--day', '2020-01-01']);
    assert.equal(code, ExitCode.NotFound);
    assert.match(stderr, /2026-07-14 … 2026-08-03/);
    assert.match(stderr, /21 days/);
});

test('--day today resolves to the data’s newest date, not the system clock', async () => {
    const { code, stdout } = await invoke(['test', TEST_PATH, '--day', 'today', '--json']);
    assert.equal(code, ExitCode.Success);
    // The fixture's window ends 2026-08-03 and the real clock is elsewhere.
    // Anchoring to the clock would 404 on the most natural thing to type.
    const metadata = json(stdout)['metadata'] as Record<string, string>;
    assert.equal(metadata['endDate'], '2026-08-03');
});

test('--day yesterday is the day before the data’s newest date', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--day', 'yesterday', '--json']);
    const metadata = json(stdout)['metadata'] as Record<string, string>;
    assert.equal(metadata['endDate'], '2026-08-02');
});

test('--day rejects a malformed date', async () => {
    const { code, stderr } = await invoke(['test', TEST_PATH, '--day', 'last-tuesday']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /expects YYYY-MM-DD/);
});

// --- --config filtering ---------------------------------------------------

test('--config keeps only matching configs and changes the totals', async () => {
    const { stdout } = await invoke([
        'test',
        TEST_PATH,
        '--config',
        'windows11-64-25h2-shippable',
        '--json',
    ]);
    const result = json(stdout);
    const configs = result['configs'] as { jobName: string }[];
    assert.equal(configs.length, 1);
    assert.match(configs[0]!.jobName, /windows11-64-25h2-shippable/);
    const totals = result['totals'] as Record<string, number>;
    assert.ok(
        totals['runCount']! < 15_968,
        'filtering to one config must reduce the run count'
    );
});

test('--exclude-config is applied after --config', async () => {
    const { stdout } = await invoke([
        'test',
        TEST_PATH,
        '--config',
        'windows',
        '--exclude-config',
        'shippable',
        '--json',
    ]);
    const configs = json(stdout)['configs'] as { jobName: string }[];
    // The only failing config is windows *and* shippable, so excluding
    // shippable must leave nothing.
    assert.equal(configs.length, 0);
});

// --- --executions ---------------------------------------------------------

test('--executions keeps the three mode states separate on xpcshell', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--executions', '--json']);
    const executions = json(stdout)['executions'] as {
        modeAxis: { failures: Record<string, number>; runs: Record<string, number> } | null;
    };
    assert.ok(executions.modeAxis !== null, 'xpcshell records a mode axis');
    const { failures, runs } = executions.modeAxis;
    assert.equal(failures['parallel'], 2, 'FAIL-PARALLEL');
    assert.equal(failures['sequential'], 2, 'FAIL-SEQUENTIAL');
    // CRASH carries no mode suffix, so its 6 runs land in `unrecorded`.
    assert.equal(failures['unrecorded'], 6);

    // The measured fact this pins: plain PASS is its own bucket, NOT the sum
    // of the two modes. 15638 parallel, 6 sequential, and 314 unsuffixed
    // passes plus 6 crashes = 320 unrecorded runs.
    assert.equal(runs['parallel'], 15_640, 'PASS-PARALLEL 15638 + FAIL-PARALLEL 2');
    assert.equal(runs['sequential'], 8, 'PASS-SEQUENTIAL 6 + FAIL-SEQUENTIAL 2');
    assert.equal(runs['unrecorded'], 320, 'PASS 314 + CRASH 6');
    assert.notEqual(
        runs['unrecorded'],
        runs['parallel']! + runs['sequential']!,
        'unrecorded must not be the sum of the other two'
    );
});

test('--executions on mochitest reports no mode axis rather than a table of zeros', async () => {
    const { code, stdout } = await invoke([
        'test',
        MOCHITEST_PATH,
        '--executions',
        '--json',
    ]);
    assert.equal(code, ExitCode.Success);
    const executions = json(stdout)['executions'] as { modeAxis: unknown };
    // FORMATS.md: the -PARALLEL/-SEQUENTIAL suffixes are xpcshell-only.
    // `null` rather than a breakdown of zeros, which would read as "measured
    // and found nothing" instead of "this harness does not record it".
    assert.equal(executions.modeAxis, null);
});

test('--executions text on mochitest says the axis is absent', async () => {
    const { stdout } = await invoke(['test', MOCHITEST_PATH, '--executions']);
    assert.match(stdout, /By execution mode: not recorded for this harness/);
    assert.match(stdout, /xpcshell-only/);
    assert.doesNotMatch(stdout, /^\s+parallel\s+0/m, 'no zero-filled mode table');
});

test('--executions text says the two blocks are not additive', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--executions']);
    assert.match(stdout, /partition the same failures two ways; they are not additive/);
});

// --- --coverage -----------------------------------------------------------

test('--coverage lists passing configs, which the default view omits', async () => {
    const { code, stdout } = await invoke(['test', TEST_PATH, '--coverage', '--json']);
    assert.equal(code, ExitCode.Success);
    const coverage = json(stdout)['coverage'] as {
        attributedPasses: boolean;
        configs: { jobName: string; state: string; passCount: number }[];
        neverScheduled: string[] | null;
    };
    assert.equal(coverage.attributedPasses, true);
    assert.ok(
        coverage.configs.length > 1,
        'coverage must show more configs than the one that failed'
    );
    assert.ok(
        coverage.configs.some((config) => config.state === 'ok' && config.passCount > 0),
        'at least one config that only ever passed'
    );
    assert.ok(coverage.neverScheduled !== null, 'a universe was supplied, so this is a list');
});

test('--coverage reports a config that both ran and skipped as having run', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--coverage', '--json']);
    const coverage = json(stdout)['coverage'] as {
        configs: {
            jobName: string;
            state: string;
            runCount: number;
            skipCount: number;
            skipMessages: { message: string; count: number }[];
        }[];
    };
    // A subtlety the fixture happens to contain, and worth pinning because
    // the obvious expectation is wrong: this test is skip-if'd on android,
    // but the android configs *also* ran it on other days in the window. So
    // they are not in the `skipped` state — they ran, and they passed. The
    // skip count is carried alongside rather than instead.
    const android = coverage.configs.find((config) =>
        config.jobName.startsWith('test-android-em-14-x86_64/debug-geckoview-xpcshell')
    );
    assert.ok(android !== undefined, 'the fixture has android configs');
    assert.ok(android.runCount > 0, 'it ran');
    assert.ok(android.skipCount > 0, 'and it was skipped on other days');
    assert.equal(android.state, 'ok', 'having run and passed, it is not "skipped"');
    assert.ok(
        android.skipMessages.some((skip) => /os == 'android'/.test(skip.message)),
        'and the skip-if condition is reported'
    );

    const states = new Set(coverage.configs.map((config) => config.state));
    assert.ok(states.has('ok'));
    assert.ok(
        states.has('never-scheduled'),
        'the universe difference produced never-scheduled rows'
    );
});

// --- --profiles -----------------------------------------------------------

test('--profiles emits raw artifact URLs, never profiler.firefox.com', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--profiles', '--json']);
    const profiles = json(stdout)['profiles'] as { resourceUsage: string }[];
    assert.ok(profiles.length > 0, 'the fixture test has failures with task IDs');
    for (const profile of profiles) {
        // The consumer is profiler-cli, which fetches the JSON itself; a
        // front-end URL would be useless to it.
        assert.match(profile.resourceUsage, /firefox-ci-tc\.services\.mozilla\.com/);
        assert.match(profile.resourceUsage, /profile_resource-usage\.json$/);
        assert.doesNotMatch(profile.resourceUsage, /profiler\.firefox\.com/);
        assert.doesNotMatch(profile.resourceUsage, /from-url/);
    }
});

test('--profiles emits no per-test profile URL when no message named one', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--profiles', '--json']);
    const profiles = json(stdout)['profiles'] as { testProfile?: string }[];
    // The fixture's failure messages name no uploaded profile, and CLI.md is
    // explicit: emit nothing rather than guess a filename.
    for (const profile of profiles) {
        assert.equal(profile.testProfile, undefined);
    }
});

test('--profiles text says when no per-test profile was found', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--profiles']);
    // Otherwise "no profile was uploaded" and "the command did not look" are
    // indistinguishable to the reader.
    assert.match(stdout, /no per-test failure profile was named/);
});

// --- --history, --task-ids, --durations ------------------------------------

test('--history has one row per day, oldest first, dated correctly', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--history', '--json']);
    const history = json(stdout)['history'] as { date: string; pass: number }[];
    assert.equal(history.length, 21);
    // Day 0 is the OLDEST. Reading it as "today" reverses every trend and
    // still looks plausible, which is why the ends are pinned.
    assert.equal(history[0]!.date, '2026-07-14');
    assert.equal(history[20]!.date, '2026-08-03');
});

test('--history counts sum to the totals', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--history', '--json']);
    const result = json(stdout);
    const history = result['history'] as { pass: number; fail: number; crash: number; skip: number }[];
    const totals = result['totals'] as Record<string, number>;
    const sum = (key: 'pass' | 'fail' | 'crash' | 'skip'): number =>
        history.reduce((acc, row) => acc + row[key], 0);
    // Reconciliation across two independent paths: the per-day rollup and the
    // one-pass totals. Agreeing is evidence, not tautology.
    assert.equal(sum('pass'), totals['passCount']! + totals['expectedFailCount']!);
    assert.equal(sum('fail'), totals['failCount']);
    assert.equal(sum('crash'), totals['crashCount']);
    assert.equal(sum('skip'), totals['skipCount']);
});

test('--task-ids yields one row per failing run, with the retry split off', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--task-ids', '--json']);
    const taskIds = json(stdout)['taskIds'] as {
        taskId: string;
        retryId: number;
        status: string;
    }[];
    // 4 fails + 6 crashes, each carrying task IDs in a bucket file.
    assert.equal(taskIds.length, 10);
    for (const row of taskIds) {
        assert.ok(Number.isInteger(row.retryId), 'the retry is parsed off, not left in the ID');
        assert.doesNotMatch(row.taskId, /\.\d+$/, 'the task ID must not keep its retry suffix');
    }
});

test('--durations reports a distribution ordered min <= median <= p95 <= max', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--durations', '--json']);
    const durations = json(stdout)['durations'] as {
        min: number;
        median: number;
        p95: number;
        max: number;
        runCount: number;
    }[];
    assert.ok(durations.length > 0);
    for (const row of durations) {
        assert.ok(row.min <= row.median, `min ${row.min} <= median ${row.median}`);
        assert.ok(row.median <= row.p95, `median ${row.median} <= p95 ${row.p95}`);
        assert.ok(row.p95 <= row.max, `p95 ${row.p95} <= max ${row.max}`);
        assert.ok(row.runCount > 0);
    }
});

// --- limits and truncation -------------------------------------------------

test('a truncated list says how much it cut and how to see it all', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--coverage', '--limit', '2']);
    assert.match(stdout, /… \d+ more \(--limit 0 for all\)/);
});

test('--limit 0 means no limit', async () => {
    const limited = await invoke(['test', TEST_PATH, '--coverage', '--limit', '2']);
    const all = await invoke(['test', TEST_PATH, '--coverage', '--limit', '0']);
    assert.match(limited.stdout, /… \d+ more/);
    assert.doesNotMatch(all.stdout, /… \d+ more \(--limit 0 for all\)/);
    assert.ok(all.stdout.length > limited.stdout.length);
});

// --- output stream discipline ---------------------------------------------

test('progress goes to stderr so stdout stays pipeable', async () => {
    const { stdout, stderr } = await invoke(['test', TEST_PATH, '--json']);
    // stdout must parse as JSON on its own — this is the `| jq` contract.
    assert.doesNotThrow(() => JSON.parse(stdout));
    assert.match(stderr, /Reading xpcshell bucket/);
});

test('--quiet suppresses progress but keeps the data', async () => {
    const { stdout, stderr } = await invoke(['test', TEST_PATH, '--json', '--quiet']);
    assert.equal(stderr, '');
    assert.doesNotThrow(() => JSON.parse(stdout));
});

// --- markdown -------------------------------------------------------------

test('markdown escapes a pipe in a message rather than splitting the row', async () => {
    const { code, stdout } = await invoke(['test', TEST_PATH, '--markdown']);
    assert.equal(code, ExitCode.Success);
    assert.match(stdout, /^\| /m, 'a Markdown table is emitted');
    // Every table row must have a consistent column count; an unescaped `|`
    // in a message is what breaks that, and it renders without complaint.
    for (const line of stdout.split('\n')) {
        if (!line.startsWith('|')) {
            continue;
        }
        const unescaped = line.replace(/\\\|/g, '');
        assert.ok(unescaped.split('|').length >= 3, `malformed row: ${line}`);
    }
});

test('markdown escaping is exercised directly, since no fixture message has a pipe', async () => {
    // The end-to-end markdown test above cannot catch a broken escaper:
    // measured, zero of the 13 messages in either bucket fixture contain a
    // `|`, so the escaping branch never runs on fixture data. A mutation
    // removing the pipe replacement survived the suite until this test.
    const md = await import('../cli/format/markdown.ts');
    assert.equal(md.escapeCell('a|b'), 'a\\|b');
    assert.equal(md.escapeCell('line1\nline2'), 'line1<br>line2');
    assert.equal(md.escapeCell('line1\r\nline2'), 'line1<br>line2');
    assert.equal(md.escapeCell('back\\slash'), 'back\\\\slash');

    // And the property that matters: a cell can never introduce a column.
    const row = md.table(
        [{ header: 'a' }, { header: 'b' }],
        [['x|y', 'plain']]
    );
    const body = row[2]!;
    assert.equal(
        body.replace(/\\\|/g, '').split('|').length,
        4,
        `an escaped cell must not add a column: ${body}`
    );
});

test('harness inference follows detectHarness for every rule, including the hole', async () => {
    // Table-driven because the end-to-end tests only reach two of the four
    // branches, and a mutation deleting the `test_*.html` rule survived them.
    const { detectHarness } = await import('../cli/options.ts');
    const cases: [string, string][] = [
        ['browser/base/content/test/browser_foo.js', 'mochitest'],
        ['dom/base/test/test_selection.html', 'mochitest'],
        // The documented hole: a mochitest-plain `test_foo.js` is
        // misclassified as xpcshell. Asserted deliberately — the CLI must
        // agree with common-test-data.js:9 rather than improve on it, and
        // this is the case harnessMissHint() exists for.
        ['dom/base/test/test_foo.js', 'xpcshell'],
        ['netwerk/test/unit/test_bug1195415.js', 'xpcshell'],
        ['some/dir/browser_foo.html', 'xpcshell'],
        ['no_prefix.js', 'xpcshell'],
        ['test_at_root.html', 'mochitest'],
    ];
    for (const [path, expected] of cases) {
        assert.equal(detectHarness(path), expected, path);
    }
});

// --- summary --------------------------------------------------------------

test('summary reports both harnesses with rates and a prior-period delta', async () => {
    const { code, stdout } = await invoke(['summary', '--json']);
    assert.equal(code, ExitCode.Success);
    const harnesses = json(stdout)['harnesses'] as {
        harness: string;
        current: Record<string, number>;
        prior: Record<string, number> | null;
        delta: Record<string, number | null>;
    }[];
    assert.deepEqual(
        harnesses.map((entry) => entry.harness),
        ['xpcshell', 'mochitest']
    );
    for (const entry of harnesses) {
        assert.equal(entry.current['dayCount'], 7, 'the default period is 7 days');
        assert.ok(entry.current['testFailureRate']! >= 0);
        assert.ok(entry.prior !== null, 'the stats fixtures reach back far enough');
        // A delta in percentage points, so a rate moving 0.42 -> 0.50 is 0.08.
        assert.equal(
            Math.abs(
                entry.delta['testFailureRate']! -
                    (entry.current['testFailureRate']! - entry.prior['testFailureRate']!)
            ) < 1e-9,
            true
        );
    }
});

test('summary --harness reads only that harness', async () => {
    const { stdout, source } = await invoke(['summary', '--harness', 'xpcshell', '--json']);
    const harnesses = json(stdout)['harnesses'] as { harness: string }[];
    assert.equal(harnesses.length, 1);
    assert.deepEqual(source.requested, ['xpcshell-timings/xpcshell-stats.json']);
});

test('summary --days rejects zero', async () => {
    const { code, stderr } = await invoke(['summary', '--days', '0']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /at least 1/);
});

test('summary takes no positional argument', async () => {
    const { code, stderr } = await invoke(['summary', 'xpcshell']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /takes no arguments/);
});

// --- dates ----------------------------------------------------------------

test('dates reports the window ends the right way round', async () => {
    const { code, stdout } = await invoke(['dates', '--harness', 'xpcshell', '--json']);
    assert.equal(code, ExitCode.Success);
    const entry = (json(stdout)['harnesses'] as {
        dates: string[];
        oldest: string;
        newest: string;
        dayCount: number;
    }[])[0]!;
    assert.equal(entry.dayCount, 21);
    // index.json is newest first, unlike stats.json. Getting this backwards
    // reports the window inverted and still looks like a date range.
    assert.equal(entry.newest, '2026-08-03');
    assert.equal(entry.oldest, '2026-07-14');
    assert.equal(entry.dates[0], '2026-08-03');
});

test('dates marks weekend days', async () => {
    const { stdout } = await invoke(['dates', '--harness', 'xpcshell']);
    assert.match(stdout, /2026-08-02 \(Sun\)\s+— weekend/);
    assert.match(stdout, /2026-08-03 \(Mon\)$/m);
});

// --- cache ----------------------------------------------------------------

test('the cache serves a second read with no further fetch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fx-tests-cache-'));
    try {
        const cache = diskCache({ directory });
        const source = fixtureSource();
        const streams = captureStreams();
        // Two runs against a cache-wrapped source: the second must not reach
        // the inner source at all. This is CLI.md's "a warm run should need no
        // network".
        const { cachedSource } = await import('../cli/cache.ts');
        const wrapped = cachedSource(source, cache);
        await run({ argv: ['summary', '--harness', 'xpcshell', '--json'], streams, source: wrapped, cache });
        assert.equal(source.requested.length, 1);
        await run({ argv: ['summary', '--harness', 'xpcshell', '--json'], streams, source: wrapped, cache });
        assert.equal(source.requested.length, 1, 'the second run must fetch nothing');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('the cache records the file’s own generatedAt, not the fetch time', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fx-tests-cache-'));
    try {
        const cache = diskCache({ directory });
        const { cachedSource } = await import('../cli/cache.ts');
        const wrapped = cachedSource(fixtureSource(), cache);
        const streams = captureStreams();
        await run({ argv: ['summary', '--harness', 'xpcshell', '--json'], streams, source: wrapped, cache });
        const entries = await cache.list();
        assert.equal(entries.length, 1);
        // Read out of the payload, so a file re-fetched today but generated
        // last night reports last night — which is the question a surprising
        // number raises.
        assert.match(entries[0]!.generatedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
        assert.notEqual(entries[0]!.generatedAt, entries[0]!.fetchedAt);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('an expired cache entry is re-fetched', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fx-tests-cache-'));
    try {
        let now = Date.now();
        const cache = diskCache({ directory, ttlMs: 1000, now: () => now });
        const { cachedSource } = await import('../cli/cache.ts');
        const source = fixtureSource();
        const wrapped = cachedSource(source, cache);
        const streams = captureStreams();
        await run({ argv: ['summary', '--harness', 'xpcshell', '--json'], streams, source: wrapped, cache });
        assert.equal(source.requested.length, 1);
        now += 5000;
        await run({ argv: ['summary', '--harness', 'xpcshell', '--json'], streams, source: wrapped, cache });
        assert.equal(source.requested.length, 2, 'past the TTL it must re-fetch');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('--no-cache neither reads nor writes the cache', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fx-tests-cache-'));
    try {
        const cache = diskCache({ directory });
        const streams = captureStreams();
        await run({
            argv: ['summary', '--harness', 'xpcshell', '--json', '--no-cache'],
            streams,
            source: fixtureSource(),
            cache,
        });
        assert.deepEqual(await cache.list(), [], 'nothing was written');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('cache --clear empties it and reports how many entries went', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fx-tests-cache-'));
    try {
        const cache = diskCache({ directory });
        const { cachedSource } = await import('../cli/cache.ts');
        const wrapped = cachedSource(fixtureSource(), cache);
        const streams = captureStreams();
        await run({ argv: ['summary', '--harness', 'xpcshell', '--json'], streams, source: wrapped, cache });
        assert.equal((await cache.list()).length, 1);

        const clearStreams = captureStreams();
        const code = await run({ argv: ['cache', '--clear'], streams: clearStreams, cache, source: fixtureSource() });
        assert.equal(code, ExitCode.Success);
        assert.match(clearStreams.stdout, /Cleared 1 entry/);
        assert.deepEqual(await cache.list(), []);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

// --- error mapping --------------------------------------------------------

test('a missing published file exits 2, not 1', async () => {
    const missing: DataSource = {
        name: 'empty',
        fetch(name) {
            return Promise.reject(new DataFileNotFoundError(name));
        },
    };
    const { code } = await invoke(['summary', '--harness', 'xpcshell'], {
        source: missing as DataSource & { requested: string[] },
    });
    assert.equal(code, ExitCode.NotFound);
});

test('a transport failure exits 3, so a script can tell it from missing data', async () => {
    const flaky: DataSource = {
        name: 'flaky',
        fetch(name) {
            return Promise.reject(new DataFetchError(name, 'ECONNRESET'));
        },
    };
    const { code, stderr } = await invoke(['summary', '--harness', 'xpcshell'], {
        source: flaky as DataSource & { requested: string[] },
    });
    // The 3/4 split exists so "try again in a minute" is distinguishable from
    // "this is never coming back". Collapsing them makes retry logic
    // impossible to write correctly.
    assert.equal(code, ExitCode.Upstream);
    assert.match(stderr, /ECONNRESET/);
});

// --- fx-tests try ---------------------------------------------------------

/** A Treeherder client over canned jobs. */
function fakeTreeherder(jobs: TreeherderJob[]): TreeherderClient {
    return {
        findPush: () =>
            Promise.resolve({
                pushId: 1,
                revision: 'abcdef1234567890',
                repository: 'try',
                revisions: [],
            }),
        jobsOfPush: () => Promise.resolve(jobs),
    };
}

/** A completed job. */
function job(
    jobName: string,
    taskId: string,
    result: string,
    retryId = 0
): TreeherderJob {
    return { jobId: 1, jobName, taskId, retryId, state: 'completed', result };
}

/**
 * A minimal Gecko profile with the markers `parseTestMarkers` reads.
 *
 * Hand-built rather than a fixture because the cases that matter — a crash
 * marker no test claims, a rerun that passed, a FAIL that is green — are
 * combinations a captured profile does not contain all of at once.
 */
function profileWith(
    entries: {
        type: 'Test' | 'Crash' | 'Text';
        test?: string;
        text?: string;
        status?: string;
        message?: string;
        color?: string;
        signature?: string;
        start: number;
        end: number;
    }[]
): string {
    const stringArray = ['test'];
    const data = entries.map((entry) => {
        const record: Record<string, unknown> = { type: entry.type };
        if (entry.test !== undefined) record['test'] = entry.test;
        if (entry.text !== undefined) record['text'] = entry.text;
        if (entry.status !== undefined) record['status'] = entry.status;
        if (entry.message !== undefined) record['message'] = entry.message;
        if (entry.color !== undefined) record['color'] = entry.color;
        if (entry.signature !== undefined) record['signature'] = entry.signature;
        return record;
    });
    return JSON.stringify({
        meta: { startTime: 0 },
        threads: [
            {
                stringArray,
                markers: {
                    length: entries.length,
                    // Only `Test` markers are named `test`; the rest get an
                    // index that is not 0, matching how a real profile names
                    // its Text and Crash markers something else.
                    name: entries.map((entry) => (entry.type === 'Test' ? 0 : 1)),
                    data,
                    startTime: entries.map((entry) => entry.start),
                    endTime: entries.map((entry) => entry.end),
                },
            },
        ],
    });
}

/** Serves one profile for every task. */
function profileFetcher(byTask: Record<string, string>): (url: string) => Promise<Uint8Array | null> {
    return (url: string) => {
        const match = /task\/([^/]+)\//.exec(url);
        const body = match === null ? undefined : byTask[match[1]!];
        return Promise.resolve(
            body === undefined ? null : new TextEncoder().encode(body)
        );
    };
}

test('try exits 0 when it finds failures — the failures are the answer', async () => {
    const streams = captureStreams();
    const code = await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'boom', start: 1, end: 2 },
            ]),
        }),
    });
    assert.equal(code, ExitCode.Success);
    const result = json(streams.stdout);
    const perma = result['permaFails'] as { path: string }[];
    const known = result['knownIntermittents'] as { path: string }[];
    assert.equal(perma.length + known.length, 1);
});

test('try exits 0 when it finds nothing', async () => {
    const streams = captureStreams();
    const code = await run({
        argv: ['try', 'abcdef123456'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'success')]),
        fetchUrl: profileFetcher({}),
    });
    assert.equal(code, ExitCode.Success);
    assert.match(streams.stdout, /No test-level failures found/);
});

test('try surfaces a crash no test marker claimed', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-mochitest-plain', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            // Exactly the shape measured on try push 717fc67feaa071: the test
            // reported PASS and the failure is a shutdown-hang crash recorded
            // against it afterwards. Dropping it reports "no failures".
            TASK1: profileWith([
                { type: 'Test', test: MOCHITEST_PATH, status: 'PASS', start: 1, end: 2 },
                {
                    type: 'Crash',
                    test: `${MOCHITEST_PATH} (finished)`,
                    signature: '@ RunWatchdog',
                    start: 3,
                    end: 3,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { path: string; messages: string[] }[]),
        ...(result['knownIntermittents'] as { path: string; messages: string[] }[]),
        ...(result['newIntermittents'] as { path: string; messages: string[] }[]),
    ];
    assert.equal(all.length, 1, 'the unclaimed crash must become a failure');
    assert.equal(all[0]!.path, MOCHITEST_PATH, 'the (finished) suffix is stripped');
    assert.deepEqual(all[0]!.messages, ['@ RunWatchdog']);
});

test('try does not report a no-message failure as a perma-fail when central fails too', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            // No `message`, which is what 20 of 21 candidate perma-fails
            // looked like on autoland push 7c06165ae50f70.
            TASK1: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'FAIL', start: 1, end: 2 },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const perma = result['permaFails'] as unknown[];
    const known = result['knownIntermittents'] as { messageComparable: boolean }[];
    // The fixture test fails on central, so with nothing to compare this must
    // not be called "almost certainly yours".
    assert.equal(perma.length, 0);
    assert.equal(known.length, 1);
    assert.equal(known[0]!.messageComparable, false);
});

test('try marks a matching message as comparable and reports both rates', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                {
                    type: 'Test',
                    test: TEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { messageComparable: boolean; central: { failCount: number; sameMessageFailCount: number } }[]),
        ...(result['knownIntermittents'] as { messageComparable: boolean; central: { failCount: number; sameMessageFailCount: number } }[]),
    ];
    assert.equal(all.length, 1);
    assert.equal(all[0]!.messageComparable, true);
    // Central has failures for this test but not with this message — the
    // distinction CLI.md says is load-bearing.
    assert.ok(all[0]!.central.failCount > 0);
    assert.equal(all[0]!.central.sameMessageFailCount, 0);
});

test('try reports a test that passed on harness rerun as intermittent', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Text', text: 'retry', start: 10, end: 20 },
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'x', start: 1, end: 2 },
                // Inside the retry range: the harness reran it and it passed.
                { type: 'Test', test: TEST_PATH, status: 'PASS', start: 12, end: 14 },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { passedOnRerun: boolean }[]),
        ...(result['knownIntermittents'] as { passedOnRerun: boolean }[]),
        ...(result['newIntermittents'] as { passedOnRerun: boolean }[]),
    ];
    assert.equal(all.length, 1);
    assert.equal(all[0]!.passedOnRerun, true);
    // Passing on rerun is decisive: it cannot be a perma-fail.
    assert.equal((result['permaFails'] as unknown[]).length, 0);
});

test('try treats a green FAIL as an expected failure, not a failure', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                {
                    type: 'Test',
                    test: TEST_PATH,
                    status: 'FAIL',
                    color: 'green',
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    // Missing this reports every fail-if annotated test as broken.
    assert.equal((result['permaFails'] as unknown[]).length, 0);
    assert.equal((result['knownIntermittents'] as unknown[]).length, 0);
    assert.equal((result['newIntermittents'] as unknown[]).length, 0);
});

test('try derives the parallel suffix from the parallel range', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Text', text: 'parallel', start: 0, end: 100 },
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'x', start: 10, end: 20 },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { statuses: string[]; parallelOnly: boolean }[]),
        ...(result['knownIntermittents'] as { statuses: string[]; parallelOnly: boolean }[]),
    ];
    assert.deepEqual(all[0]!.statuses, ['FAIL-PARALLEL']);
    assert.equal(all[0]!.parallelOnly, true);
});

test('try counts non-test job failures separately from test ones', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            job('build-linux64/opt', 'TASKB', 'busted'),
            job('source-test-mozlint-eslint', 'TASKL', 'testfailed'),
            job('test-linux/opt-xpcshell', 'TASK1', 'success'),
        ]),
        fetchUrl: profileFetcher({}),
    });
    const result = json(streams.stdout);
    const other = result['otherFailedJobs'] as { jobName: string }[];
    // A lint job's name contains neither "mochitest" nor "xpcshell", so it is
    // not a test job and its profile carries no test markers.
    assert.equal(other.length, 2);
    assert.equal((result['permaFails'] as unknown[]).length, 0);
});

test('try counts a failed test job whose profile yielded nothing as unblamed', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        // No profile at all — expired, or never uploaded.
        fetchUrl: profileFetcher({}),
    });
    const result = json(streams.stdout);
    // Reporting 0 failures without saying a job could not be read would claim
    // the push is clean when it is not.
    assert.equal(result['unblamedJobCount'], 1);
});

test('try --perma-only omits the other sections from the text output', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--perma-only'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'novel', start: 1, end: 2 },
            ]),
        }),
    });
    assert.match(streams.stdout, /PERMA-FAILS/);
    assert.doesNotMatch(streams.stdout, /KNOWN INTERMITTENTS/);
});

test('try still answers when a central bucket cannot be read', async () => {
    const streams = captureStreams();
    const brokenCentral: DataSource = {
        name: 'broken',
        fetch(name) {
            return Promise.reject(new DataFetchError(name, 'upstream is down'));
        },
    };
    const code = await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: brokenCentral,
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'x', start: 1, end: 2 },
            ]),
        }),
    });
    // Central history is an enrichment. Losing it must warn and downgrade,
    // not fail the command — but the warning has to be there, or a missing
    // comparison reads as "never failed on central".
    assert.equal(code, ExitCode.Success);
    assert.match(streams.stderr, /could not read central history/);
    const result = json(streams.stdout);
    const perma = result['permaFails'] as { central: unknown }[];
    assert.equal(perma.length, 1);
    assert.equal(perma[0]!.central, null);
});
