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

import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { type DataFileName, type DataSource, DataFetchError, DataFileNotFoundError } from '../lib/sources/source.ts';
import type { TreeherderClient, TreeherderJob } from '../lib/sources/treeherder.ts';
import { ExitCode } from '../cli/errors.ts';
import { type CommandContext, captureStreams } from '../cli/context.ts';
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
 * A Windows-only crash-reporter test, for the `--coverage` rollup.
 *
 * Chosen because one test exhibits all four platform outcomes at once: it runs
 * on Windows, is scheduled and skipped on every Android config, and is never
 * scheduled on any mac or linux config. A rollup that conflates any two of
 * those produces a visibly wrong row here.
 */
const WINDOWS_ONLY_TEST =
    'toolkit/crashreporter/test/unit/test_crash_win64cfi_push_nonvol.js';

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

// --- the exit-code table is a contract, so it is pinned to literals -------

test('the exit codes are the literal numbers CLI.md documents', () => {
    // Pinned to literals on purpose. Every other assertion in this file
    // compares against `ExitCode.Usage` and friends, which means mutating the
    // constant moves the code and the test together — a mutation changing
    // `Usage: 1` to `Usage: 0` survived the whole suite. These values are a
    // published contract that scripts branch on, so the numbers themselves
    // have to be asserted somewhere.
    assert.equal(ExitCode.Success, 0);
    assert.equal(ExitCode.Usage, 1);
    assert.equal(ExitCode.NotFound, 2);
    assert.equal(ExitCode.Upstream, 3);
    // No producer yet — `fx-tests crash` in step 5 is the first — but the
    // value is part of the same table and the 3/4 split is the reason the
    // table exists at all.
    assert.equal(ExitCode.Gone, 4);
});

test('a usage error exits with the literal 1', async () => {
    const { code } = await invoke(['test', TEST_PATH, '--json', '--markdown']);
    assert.equal(code, 1);
});

test('a not-found exits with the literal 2', async () => {
    const { code } = await invoke(['test', 'dom/base/test/test_nonexistent90.js']);
    assert.equal(code, 2);
});

test('a transient upstream failure exits with the literal 3', async () => {
    const flaky: DataSource = {
        name: 'flaky',
        fetch(name) {
            return Promise.reject(new DataFetchError(name, 'ECONNRESET'));
        },
    };
    const { code } = await invoke(['summary', '--harness', 'xpcshell'], {
        source: flaky as DataSource & { requested: string[] },
    });
    assert.equal(code, 3);
});

test('success exits with the literal 0', async () => {
    const { code } = await invoke(['test', TEST_PATH, '--json']);
    assert.equal(code, 0);
});

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

test('a command CLI.md specifies but has not landed says so, rather than "unknown"', async () => {
    // Driven off PLANNED_COMMANDS rather than naming a command: `errors` and
    // then `manifests` both landed while this suite was being reviewed, and a
    // test pinned to a specific unimplemented command fails the day someone
    // implements it — the wrong signal entirely. What is being asserted is the
    // behaviour, which outlives any particular name.
    const { PLANNED_COMMANDS } = await import('../cli/main.ts');
    const planned = Object.entries(PLANNED_COMMANDS);
    // Step 5 landed the last of them, so this is now legitimately empty and the
    // loop below is a no-op. Kept rather than deleted: `CLI.md` will document a
    // command before it exists again, and the branch it guards — "documented
    // but unlanded" must not read as "unknown command" — still exists in
    // `dispatch()`. `the planned-command branch is still wired up` below is
    // what keeps that branch covered while the list is empty.
    for (const [name, description] of planned) {
        const { code, stderr } = await invoke([name]);
        assert.equal(code, ExitCode.Usage, name);
        assert.match(stderr, /not implemented yet/, name);
        // The description is echoed, so the user learns what it will do.
        assert.ok(stderr.includes(description), `${name} should echo its description`);
        // And the distinction that matters: not "unknown command", which would
        // send someone who read the spec correctly looking for a typo.
        assert.doesNotMatch(stderr, /unknown command/, name);
    }
});

test('the planned-command branch is still wired up, with the list empty', async () => {
    // With `PLANNED_COMMANDS` empty the loop above covers nothing, so the
    // branch would rot untested until the next unlanded command appeared — and
    // then be discovered broken. This drives it directly by injecting an entry,
    // which is the only way to exercise it while everything is implemented.
    const main = await import('../cli/main.ts');
    const planned = main.PLANNED_COMMANDS as Record<string, string>;
    planned['futurecommand'] = 'something CLI.md will describe one day';
    try {
        const { code, stderr } = await invoke(['futurecommand']);
        assert.equal(code, ExitCode.Usage);
        assert.match(stderr, /not implemented yet/);
        assert.match(stderr, /something CLI.md will describe one day/);
        assert.doesNotMatch(stderr, /unknown command/);
    } finally {
        delete planned['futurecommand'];
    }
});

test('a genuinely unknown command is reported as unknown', async () => {
    // The other side of the same branch, so a mutation collapsing the two
    // messages into one cannot survive.
    const { code, stderr } = await invoke(['tsetstuff']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /unknown command "tsetstuff"/);
    assert.doesNotMatch(stderr, /not implemented yet/);
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

test('test --json reports canAttributeConfigs true for a bucket file', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    assert.equal(json(stdout)['canAttributeConfigs'], true);
});

/** Loads the issues fixture, which has no `taskInfo` and cannot attribute. */
async function issuesLoader(): Promise<NonNullable<CommandContext['loadTimingFile']>> {
    const { decodeIssues } = await import('../lib/formats/issues.ts');
    type IssuesFile = import('../lib/formats/issues.ts').IssuesFile;
    const raw = JSON.parse(
        new TextDecoder().decode(await fixtureBytes('xpcshell-issues.json'))
    ) as IssuesFile;
    return () => Promise.resolve({ raw, decoded: decodeIssues(raw) });
}

/** A test that fails in the issues fixture, so `configs` is empty for a reason. */
async function failingTestInIssues(): Promise<string> {
    const { decodeIssues } = await import('../lib/formats/issues.ts');
    type IssuesFile = import('../lib/formats/issues.ts').IssuesFile;
    const decoded = decodeIssues(
        JSON.parse(
            new TextDecoder().decode(await fixtureBytes('xpcshell-issues.json'))
        ) as IssuesFile
    );
    for (let id = 0; id < decoded.testCount; id++) {
        for (const [status, count] of decoded.totalsByStatus(id)) {
            if (status.startsWith('FAIL') && count > 0) {
                return decoded.testAt(id).fullPath;
            }
        }
    }
    throw new Error('the issues fixture has no failing test');
}

test('test over a file that cannot attribute configs says so, rather than "none failed"', async () => {
    // Driven through the `loadTimingFile` seam because `fx-tests test` always
    // reads a bucket file, which *can* attribute — so this branch is
    // unreachable from the command's own code path and a literal `true`
    // survived the suite. It stops being unreachable in step 5, where
    // `issues`, `failures`, `crashes` and `skips` all read this family, and
    // wiring the guard live untested is how it would become silently wrong.
    const path = await failingTestInIssues();
    const { code, stdout } = await invoke(['test', path, '--json'], {
        loadTimingFile: await issuesLoader(),
    });
    assert.equal(code, 0);
    const result = json(stdout);

    // The test genuinely failed, and the file genuinely cannot say where.
    const totals = result['totals'] as Record<string, number>;
    assert.ok(totals['failCount']! > 0, 'this test has failures');
    assert.deepEqual(result['configs'], []);
    assert.equal(
        result['canAttributeConfigs'],
        false,
        'an issues file has no taskInfo, so configs: [] means "cannot say"'
    );

    // And `reach` must be null rather than an empty or failing-only summary:
    // with no attributed passes, "where does this run" has no answer here.
    assert.equal(result['reach'], null);
});

test('the text output distinguishes "cannot attribute" from "no config failed"', async () => {
    const path = await failingTestInIssues();
    const { stdout } = await invoke(['test', path], {
        loadTimingFile: await issuesLoader(),
    });
    assert.match(stdout, /does not attribute runs to configurations/);
    assert.doesNotMatch(stdout, /no failing configuration in this window/);
    // And no reach line, since it would be built from failing configs only.
    assert.doesNotMatch(stdout, /^Runs on /m);
});

test('--coverage refuses on a file without attributed passes', async () => {
    const path = await failingTestInIssues();
    const { stdout } = await invoke(['test', path, '--coverage'], {
        loadTimingFile: await issuesLoader(),
    });
    // CLI.md's refusal: printing the failing configs under a "Coverage"
    // heading would present a failure-only view as the whole picture, which
    // is the exact thing --coverage exists to replace.
    assert.match(stdout, /Coverage is not available from this file/);
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

// --- the perma-fail verdict, which the fixtures cannot produce -------------

/**
 * A bucket file with one test that never passes on one of its two configs.
 *
 * Hand-built, and the comment says why: **no test in either bucket fixture
 * has a config with a 100% failure rate** — the highest anywhere is under
 * 20% — so the perma-fail branch of the verdict is unreachable from fixture
 * data. A mutation making `permaFails` permanently empty survived the entire
 * suite for exactly that reason.
 *
 * That branch is the single most important thing `fx-tests test` says: an
 * overall pass rate of 96% hides a config where the test has never once
 * passed, and CLI.md lists "a test's overall failure rate understates a
 * single-config perma-fail" among the traps the tool exists to prevent.
 *
 * The shape is copied from `xpcshell-00.json`: `durations` groups carry
 * `jobNameIds`, `task-ids` groups carry nested `taskIdIds` plus `messageIds`,
 * and every group carries delta-encoded `days`.
 */
function permaFailBucket(): string {
    const days = 3;
    return JSON.stringify({
        metadata: {
            startDate: '2026-08-01',
            endDate: '2026-08-03',
            days,
            startTime: 1_785_000_000,
            generatedAt: '2026-08-04T03:00:00.000Z',
            totalTestCount: 1,
            testsWithFailures: 1,
            totalBuckets: 64,
            bucketIndex: 0,
            aggregatedFrom: [],
        },
        tables: {
            jobNames: [
                'test-linux2404-64/debug-xpcshell',
                'test-windows11-64/opt-xpcshell',
                'test-macosx1500-64/debug-xpcshell',
            ],
            testPaths: ['dom/base/test/unit'],
            testNames: ['test_permafail.js'],
            repositories: ['mozilla-central'],
            // Order matters only in that entries are indexed by position.
            statuses: ['PASS', 'FAIL'],
            taskIds: [
                'AAAAAAAAAAAAAAAAAAAAAA.0',
                'BBBBBBBBBBBBBBBBBBBBBB.0',
                'CCCCCCCCCCCCCCCCCCCCCC.0',
                // 99 macOS tasks, so that config reaches 99% without hitting
                // 100. Generated rather than written out.
                ...Array.from({ length: 99 }, (_, i) => `M${String(i).padStart(21, '0')}.0`),
            ],
            messages: ['assertion failed: everything is broken here'],
            crashSignatures: [],
            components: ['Core :: DOM'],
            commitIds: ['abc123'],
        },
        taskInfo: {
            repositoryIds: Array.from({ length: 102 }, () => 0),
            // Tasks 0-2 are the Windows config, which never passes. Tasks 3-4
            // are macOS, which fails 2 of its 3 runs — 67%, deliberately
            // between the 50% a plausible-looking threshold might use and the
            // 100% the rule actually requires. Without a config in that band,
            // loosening the threshold to >= 50 changes nothing observable.
            jobNameIds: [1, 1, 1, ...Array.from({ length: 99 }, () => 2)],
            commitIds: Array.from({ length: 102 }, () => 0),
            chunks: Array.from({ length: 102 }, () => null),
        },
        testInfo: { testPathIds: [0], testNameIds: [0], componentIds: [0] },
        testRuns: [
            [
                // PASS: 30 runs, all on linux, none on windows.
                {
                    durations: [
                        Array.from({ length: 10 }, () => 1000),
                        Array.from({ length: 10 }, () => 1100),
                        Array.from({ length: 10 }, () => 1200),
                        // The single macOS pass. With 99 macOS failures
                        // below, that config sits at 99% — the closest a
                        // config can get to perma-failing without being one.
                        [1300],
                    ],
                    days: [0, 1, 1, 0],
                    jobNameIds: [0, 0, 0, 2],
                },
                // FAIL: three on windows (3 runs, 3 failures — 100%) and 99
                // on macOS (100 runs, 99 failures — 99%).
                {
                    taskIdIds: [
                        [0],
                        [1],
                        [2],
                        Array.from({ length: 99 }, (_, i) => 3 + i),
                    ],
                    days: [0, 1, 1, 0],
                    messageIds: [0, 0, 0, 0],
                },
            ],
        ],
    });
}

/** A source serving only the synthetic perma-fail bucket. */
function permaFailSource(): DataSource & { requested: string[] } {
    const requested: string[] = [];
    return {
        name: 'perma-fixture',
        requested,
        fetch(fileName: DataFileName): Promise<Uint8Array> {
            requested.push(`${fileName.index}/${fileName.filename}`);
            return Promise.resolve(new TextEncoder().encode(permaFailBucket()));
        },
    };
}

test('a config that never passes is reported as a perma-fail, not as 91% healthy', async () => {
    const { code, stdout } = await invoke(
        ['test', 'dom/base/test/unit/test_permafail.js', '--json'],
        { source: permaFailSource() }
    );
    assert.equal(code, 0);
    const result = json(stdout);
    const totals = result['totals'] as Record<string, number>;
    assert.equal(totals['passCount'], 31);
    assert.equal(totals['failCount'], 102);

    // And the verdict must not. This is the number CLI.md warns the overall
    // rate hides.
    const verdict = result['verdict'] as { kind: string; summary: string };
    assert.equal(verdict.kind, 'perma-fail');
    assert.match(verdict.summary, /Never passed on 1 configuration/);
    assert.match(verdict.summary, /test-windows11-64\/opt-xpcshell \(3\/3\)/);

    const configs = result['configs'] as { jobName: string; failRate: number }[];
    const windows = configs.find((config) => config.jobName.includes('windows'));
    assert.ok(windows !== undefined);
    assert.equal(windows.failRate, 100);

    // The macOS config fails 99 of its 100 runs and is still not a
    // perma-fail. "Fails almost always" and "has never once passed" are
    // different findings, and only the second says the config is simply
    // broken — so the threshold is exactly 100, not merely "high". Pinned at
    // 99% because a looser threshold anywhere below that would otherwise go
    // unnoticed.
    const macos = configs.find((config) => config.jobName.includes('macosx'));
    assert.ok(macos !== undefined);
    assert.equal(Math.round(macos.failRate), 99);
    assert.doesNotMatch(verdict.summary, /macosx/, 'a 67% config is not a perma-fail');
    assert.match(verdict.summary, /Never passed on 1 configuration/);
});

test('the perma-fail verdict appears in the text output and points at --coverage', async () => {
    const { stdout } = await invoke(['test', 'dom/base/test/unit/test_permafail.js'], {
        source: permaFailSource(),
    });
    assert.match(stdout, /Verdict: perma-fail\./);
    assert.match(stdout, /Never passed on 1 configuration/);
    // No invented denominator: computeConfigStats only returns configs that
    // ran, so the verdict points at --coverage instead of claiming a total.
    assert.match(stdout, /--coverage for every config it runs on/);
    assert.doesNotMatch(stdout, /perma-fails on 1 of 1 configuration/);
});

test('a test with failures but none perma-failing reads as intermittent', async () => {
    // The other side of the same branch: without this, a mutation forcing
    // every failing test to "perma-fail" would also survive.
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    const verdict = json(stdout)['verdict'] as { kind: string };
    assert.equal(verdict.kind, 'intermittent');
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
});

test('--coverage does not label a config with 191 skips a bare "ok"', async () => {
    const { stdout } = await invoke([
        'test',
        TEST_PATH,
        '--coverage',
        '--config',
        'android',
        '--limit',
        '0',
    ]);
    // The reading this prevents: the android configs ran the test on some
    // days and were skipped on others, so `ok` is the correct *state* and a
    // skip column of 191 sits next to it. A reader takes "ok" to mean "runs
    // fine here, nothing disabled", which is the wrong conclusion drawn from
    // right data — this project's recurring failure mode.
    assert.match(stdout, /ok \+skipped/);
    for (const line of stdout.split('\n')) {
        // No row may show a non-zero skip count with an unannotated status.
        const match = /^\s+\S+\s+\d+\s+\d+\s+\d+\s+([1-9]\d*)\s+(\S.*)$/.exec(line);
        if (match !== null) {
            assert.match(
                match[2]!,
                /skipped/,
                `a row with ${match[1]} skips must say so in its status: ${line}`
            );
        }
    }
});

test('--coverage counts the three states CLI.md says it distinguishes', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--coverage', '--limit', '4']);
    // Counted, not left for the reader to total by eye off a truncated table
    // — the skipped rows are the easiest to miss because they sort last.
    assert.match(stdout, /^States: \d+ ran/m);
    assert.match(stdout, /never scheduled/);
    assert.match(stdout, /also skipped it on other days/);
});

// --- the never-scheduled universe ------------------------------------------

test('--coverage answers "does this run on <platform>" without --limit 0', async () => {
    // The review finding this replaces: the default tail was "Never scheduled
    // on 453 configs that run this suite:" followed by five Android media
    // variants a browser-chrome test could never have run under. 453 of 495 is
    // not information, and the owner's verdict was that the reader had to
    // rerun with `--limit 0` to find anything usable in it.
    //
    // The Windows-only fixture test is the check: every platform gets one row,
    // and each row says which of the three things happened there.
    const { stdout } = await invoke(['test', WINDOWS_ONLY_TEST, '--coverage']);

    // The platform a reader asks about gets a verdict at the default limit.
    assert.match(stdout, /^ {2}mac\s+0\/\d+ ran — \d+ never scheduled$/m);
    assert.match(stdout, /^ {2}windows\s+[1-9]\d*\/\d+ ran/m);

    // …and the config names are not in the default output. They are the detail
    // behind the rollup, not the answer to the question.
    assert.doesNotMatch(stdout, /never scheduled: test-/);
    assert.match(stdout, /--limit 0 lists the \d+ never-scheduled configs by name\./);
});

test('--coverage states the scope its never-scheduled count is drawn against', async () => {
    // A count of missing configs is meaningless without the set it was
    // subtracted from, and the version this replaces printed the count and not
    // the set — which is how it stayed wrong by two orders of magnitude
    // without the output admitting anything.
    const { stdout } = await invoke(['test', WINDOWS_ONLY_TEST, '--coverage']);
    assert.match(stdout, /^Scope: compared against every config running the \d+ suites?/m);
    assert.match(stdout, /Configs running other suites cannot schedule this test/);

    // …and it names them. A count of suites is not a scope: "compared against
    // the 5 suites this test runs under" leaves the reader unable to tell
    // whether the right ones were compared, which is the whole reason the
    // scope is stated. A mutation deleting just the names survived the suite.
    const scope = /^Scope: [^\n]*$/m.exec(stdout)![0];
    const json_ = await invoke(['test', WINDOWS_ONLY_TEST, '--coverage', '--json']);
    const suites = (
        json(json_.stdout)['coverage'] as { universeSuites: string[] }
    ).universeSuites;
    assert.ok(suites.length > 1, 'the fixture test spans several suites');
    assert.ok(
        scope.includes(suites[0]!),
        `the scope line states a count but not the suites themselves: ${scope}`
    );
});

test('--coverage does not list a config from a suite the test never ran', async () => {
    // The scoping rule, asserted against the output rather than the library:
    // every named never-scheduled config must run a suite the test itself ran.
    const { stdout } = await invoke([
        'test',
        WINDOWS_ONLY_TEST,
        '--coverage',
        '--json',
    ]);
    const coverage = json(stdout)['coverage'] as {
        configs: { jobName: string; state: string }[];
        neverScheduled: string[];
        universeSuites: string[];
    };
    assert.ok(coverage.neverScheduled.length > 0, 'the fixture must have real gaps');
    const suites = new Set(coverage.universeSuites);
    assert.ok(suites.size > 1);
    for (const jobName of coverage.neverScheduled) {
        const suite = jobName.slice(jobName.indexOf('/') + 1).replace(/^[^-]+-/, '');
        assert.ok(
            suites.has(suite),
            `${jobName} runs "${suite}", which this test never ran, so it is not a gap`
        );
    }
});

test('--limit 0 is what lists the never-scheduled configs by name', async () => {
    // Not dropped, just not the default. The requirement is that the long list
    // stays available, only behind a flag.
    const { stdout } = await invoke(['test', WINDOWS_ONLY_TEST, '--coverage', '--limit', '0']);
    assert.match(stdout, /^ {6}never scheduled: test-/m);
    assert.doesNotMatch(stdout, /--limit 0 lists/);
});

test('--coverage distinguishes skipped-everywhere from never-scheduled', async () => {
    // Two different answers to "is this covered on Android", and folding them
    // together loses the only one that is someone's work: a `skip-if` that
    // disabled the test is a bug to fix, CI not scheduling the suite is not.
    const { stdout } = await invoke(['test', WINDOWS_ONLY_TEST, '--coverage']);
    assert.match(
        stdout,
        /^ {2}android\s+0\/\d+ ran — scheduled here, but skipped on every config$/m,
        'android scheduled and skipped it, which is not "never scheduled"'
    );
});

test('--coverage names a platform its suites do not run on at all', async () => {
    // The cost of scoping the universe to the test's own suites: a platform
    // the suite does not exist on drops out of the comparison entirely. That
    // must not become silence, because "does this run on Android?" is the
    // question CLI.md says --coverage exists to answer, and an omitted row
    // answers it wrongly.
    const { stdout } = await invoke(['test', MOCHITEST_PATH, '--coverage']);
    const rows = [...stdout.matchAll(/^ {2}(\w+)\s+\d+/gm)].map((match) => match[1]!);
    assert.ok(rows.length > 0, 'the rollup produced rows');
    // Every platform the file knows about is accounted for one way or another:
    // either it has a ran/skipped/never row, or it is named as a platform
    // these suites do not run on.
    const absent = [...stdout.matchAll(/these suites do not run on (\w+)/g)].map((m) => m[1]!);
    const reach = /— not ([a-z, ]+); see --coverage/.exec(stdout);
    if (reach !== null) {
        for (const platform of reach[1]!.split(', ')) {
            assert.ok(
                rows.includes(platform) || absent.includes(platform),
                `the default view says the test does not run on ${platform}, but --coverage ` +
                    `neither lists it nor says the suites do not reach it`
            );
        }
    }
});

test('--coverage never contradicts itself about a platform', async () => {
    // The bug this catches, found on real data: `test_playback.html` is
    // scheduled on 20 Android configs and skipped on all of them, so it landed
    // in the rollup *and* in the "these suites do not run on android" list —
    // two rows, saying opposite things, three lines apart.
    for (const path of [TEST_PATH, MOCHITEST_PATH, WINDOWS_ONLY_TEST]) {
        const { stdout } = await invoke(['test', path, '--coverage']);
        const rows = new Set(
            [...stdout.matchAll(/^ {2}(\w+)\s+\d+\/\d+ ran/gm)].map((match) => match[1]!)
        );
        for (const match of stdout.matchAll(/these suites do not run on (\w+)/g)) {
            const platform = match[1]!;
            assert.ok(
                !rows.has(platform),
                `${path}: ${platform} has a coverage row and is also called unreachable`
            );
        }
    }
});

test('--coverage JSON keeps the raw state, so the annotation is presentation only', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--coverage', '--json']);
    const coverage = json(stdout)['coverage'] as {
        configs: { state: string; runCount: number; skipCount: number }[];
    };
    const mixed = coverage.configs.filter(
        (config) => config.runCount > 0 && config.skipCount > 0
    );
    assert.ok(mixed.length > 0, 'the fixture has configs that both ran and skipped');
    for (const config of mixed) {
        // The library's state vocabulary is unchanged; only the text column
        // annotates. A consumer switching on `state` must not have to learn a
        // new value.
        assert.doesNotMatch(config.state, /\+/);
        assert.ok(['ok', 'intermittent', 'perma-fail'].includes(config.state));
    }
});

// --- "Runs on N configs across ..." in the default view --------------------

test('the default view says where the test runs, without --coverage', async () => {
    const { stdout } = await invoke(['test', TEST_PATH]);
    // CLI.md puts this directly under the verdict. Without it "no Android
    // failures" is unreadable: it could mean Android is fine, or that Android
    // never ran the test.
    assert.match(stdout, /^Runs on \d+ configs across /m);
    assert.match(stdout, /android \(\d+\)/);
});

test('the reach line is in --json too, and counts only configs that ran', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    const result = json(stdout);
    const reach = result['reach'] as {
        configCount: number;
        platforms: { platform: string; configCount: number }[];
        absentPlatforms: string[];
    };
    assert.ok(reach !== null);
    assert.ok(reach.configCount > 0);
    assert.ok(reach.platforms.length > 0);

    // Reconciliation: the reach count must equal the number of coverage rows
    // that actually ran, computed by a different path.
    const withCoverage = json(
        (await invoke(['test', TEST_PATH, '--coverage', '--json'])).stdout
    );
    const coverage = withCoverage['coverage'] as { configs: { runCount: number }[] };
    assert.equal(
        reach.configCount,
        coverage.configs.filter((config) => config.runCount > 0).length
    );
});

test('a platform the test never runs on is named, and is a measured absence', async () => {
    // The synthetic bucket has linux, windows and macOS configs, and the test
    // runs on all three, so nothing is absent. Filtering to two of them makes
    // the third absent — which exercises the set difference rather than
    // asserting a hardcoded platform list.
    const { stdout } = await invoke(
        ['test', 'dom/base/test/unit/test_permafail.js', '--json', '--config', 'linux,windows'],
        { source: permaFailSource() }
    );
    const reach = json(stdout)['reach'] as {
        platforms: { platform: string }[];
        absentPlatforms: string[];
    };
    const covered = reach.platforms.map((entry) => entry.platform);
    assert.ok(!covered.includes('mac'), 'macOS was filtered out');
    assert.deepEqual(reach.absentPlatforms, ['mac']);
});

test('the reach line points at --coverage when a platform is absent', async () => {
    const { stdout } = await invoke(
        ['test', 'dom/base/test/unit/test_permafail.js', '--config', 'linux,windows'],
        { source: permaFailSource() }
    );
    assert.match(stdout, /Runs on \d+ configs across .*— not mac; see --coverage/);
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

test('percent() renders "no rate to state" as a dash, never as 0%', async () => {
    // `null` and `0` are different claims: "too few runs to say" against "no
    // failures". config-stats.ts returns `null` deliberately for the first,
    // and collapsing it to 0.0% in the formatter throws that away at the last
    // step — a column of confident zeroes for configs that were never
    // measured. A mutation removing the null branch survived the suite.
    const { percent } = await import('../cli/format/text.ts');
    assert.equal(percent(null), '—');
    assert.equal(percent(undefined), '—');
    assert.equal(percent(0), '0.0%');
    assert.notEqual(percent(null), percent(0), 'null must not render like zero');
    assert.equal(percent(8.14), '8.1%');
    assert.equal(percent(8.14, 2), '8.14%');
});

test('a config with too few recent runs prints a dash rather than 0.0%', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    const configs = json(stdout)['configs'] as { recentFailRate: number | null }[];
    // The JSON keeps `null`; the text column must not turn it into a number.
    // Whether the fixture has such a config depends on the window, so this
    // asserts the mapping rather than requiring one to exist.
    const { percent } = await import('../cli/format/text.ts');
    for (const config of configs) {
        const cell = percent(config.recentFailRate);
        if (config.recentFailRate === null) {
            assert.equal(cell, '—');
        } else {
            assert.match(cell, /^\d+\.\d%$/);
        }
    }
});

test('truncate() cuts to the width and marks the cut', async () => {
    // CLI.md's frugality rule has two halves — fewer rows, and a truncated
    // message column — and only the row half was tested. A no-op `truncate`
    // survived: the fixture messages are short enough that nothing visibly
    // changed, so the guard has to be asserted on its own.
    const { truncate } = await import('../cli/format/text.ts');
    assert.equal(truncate('short', 10), 'short');
    assert.equal(truncate('exactlyten', 10), 'exactlyten');
    const cut = truncate('a message far longer than the column', 10);
    assert.equal(cut.length, 10, 'the result never exceeds the width');
    assert.ok(cut.endsWith('…'), `the cut must be visible: ${cut}`);
    assert.equal(cut, 'a message…');
    // 0 means "no limit", matching --limit 0.
    assert.equal(truncate('unbounded', 0), 'unbounded');
});

test('truncatePath() drops leading directories, never the filename', async () => {
    // The bug: `truncate()` on a path cuts the basename, which is the only part
    // that identifies a test, so the output could not be pasted into
    // `fx-tests test` or grepped for. Every assertion here is about the
    // basename surviving.
    const { truncatePath } = await import('../cli/format/text.ts');
    const path = 'browser/extensions/formautofill/test/browser/browser_ml_heuristics.js';

    assert.equal(truncatePath(path, 200), path, 'a path that fits is untouched');
    assert.equal(truncatePath('a/b.js', 0), 'a/b.js', '0 means no limit');

    // Every width that shortens the 69-character path but can still hold its
    // 24-character basename must keep that basename whole.
    for (const width of [30, 45, 60, 68]) {
        const cut = truncatePath(path, width);
        assert.ok(cut.length <= width, `${width}: ${cut.length} chars is over budget`);
        assert.ok(
            cut.endsWith('browser_ml_heuristics.js'),
            `${width}: the filename must survive, got ${cut}`
        );
        assert.ok(cut.startsWith('…'), `${width}: the cut must be visible, got ${cut}`);
    }

    // Whole segments, so the result is still a readable path fragment.
    assert.equal(truncatePath(path, 45), '…/test/browser/browser_ml_heuristics.js');

    // A basename that does not fit on its own keeps its *tail*: neighbouring
    // tests differ at the end (`…_forms.html` vs `…_form.html`), so cutting
    // the tail here would make them identical.
    const long = 'dom/test/test_a_very_long_file_name_indeed.html';
    const tiny = truncatePath(long, 12);
    assert.ok(tiny.length <= 12);
    assert.ok(tiny.endsWith('.html'), `the distinguishing tail survives: ${tiny}`);
});

test('the try test column truncates paths from the left', async () => {
    // End to end: the column is the thing the owner reported as unusable, and a
    // unit test on `truncatePath` alone would not catch the column forgetting
    // to opt in with `path: true`.
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-mochitest-plain', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const basename = MOCHITEST_PATH.slice(MOCHITEST_PATH.lastIndexOf('/') + 1);
    assert.ok(
        streams.stdout.includes(basename),
        `the filename must appear in full somewhere: ${basename}`
    );
    // And the full path is present too, so it can be copied into the next
    // command. That is the whole purpose of the output.
    assert.ok(
        streams.stdout.includes(MOCHITEST_PATH),
        'the full path must be obtainable from the default output'
    );
});

test('a long failure message is truncated in the text table', async () => {
    // End to end, with a message the fixture does not have: built through the
    // try path, which is where a real stack-trace-bearing message arrives.
    const streams = captureStreams();
    const longMessage = `LEADING ${'x'.repeat(400)} TRAILING`;
    await run({
        argv: ['try', 'abcdef123456'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: longMessage, start: 1, end: 2 },
            ]),
        }),
    });
    assert.match(streams.stdout, /LEADING/, 'the start of the message survives');
    assert.doesNotMatch(streams.stdout, /TRAILING/, 'the end is cut');
    assert.match(streams.stdout, /…/, 'and the cut is marked');
    for (const line of streams.stdout.split('\n')) {
        assert.ok(line.length < 300, `no line may run away: ${line.length} chars`);
    }
});

test('markdown also states what a truncated list left out', async () => {
    const md = await import('../cli/format/markdown.ts');
    // Every format has to say a list is partial, not just the text one.
    assert.equal(md.moreLine(5, 5), null);
    assert.equal(md.moreLine(5, 7), null);
    const line = md.moreLine(50, 3);
    assert.ok(line !== null);
    assert.match(line, /47 more/);
    assert.match(line, /--limit 0/);
});

test('serializing a Map or Set throws rather than emitting {}', async () => {
    // A safety net with no live trigger today: every command already converts
    // its Maps before emitting, so a mutation disabling this guard survives
    // the end-to-end tests. It is tested directly because the thing it
    // prevents is silent — JSON.stringify turns both into {}, so the output
    // parses, validates as an object, and is empty. That is the failure mode
    // this project keeps finding, and the guard is what makes it a crash at
    // development time instead.
    const { toJson, mapToObject } = await import('../cli/format/json.ts');
    assert.throws(
        () => toJson({ counts: new Map([['a', 1]]) }),
        /refusing to serialize a Map at "counts"/
    );
    assert.throws(
        () => toJson({ seen: new Set(['a']) }),
        /refusing to serialize a Set at "seen"/
    );
    // An empty Map is the worst case: `{}` is indistinguishable from a field
    // that legitimately has no entries, so it must throw too.
    assert.throws(() => toJson({ counts: new Map() }), /refusing to serialize a Map/);

    // And the conversion helper it points at works.
    assert.equal(toJson({ counts: mapToObject(new Map([['a', 1]])) }), '{\n  "counts": {\n    "a": 1\n  }\n}');
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

test('the cache keys on the file name, so two files do not share an entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fx-tests-cache-'));
    try {
        const cache = diskCache({ directory });
        const { cachedSource } = await import('../cli/cache.ts');
        const source = fixtureSource();
        const wrapped = cachedSource(source, cache);
        const streams = captureStreams();
        // Both harnesses, so two different files go through one cache. A
        // constant cache key passes every single-file test — the entry is
        // written and read back correctly — and only shows up as one file
        // being served in place of another.
        await run({ argv: ['summary', '--json'], streams, source: wrapped, cache });
        const entries = await cache.list();
        assert.equal(entries.length, 2, 'two files must occupy two entries');
        assert.deepEqual(
            entries.map((entry) => entry.key).sort(),
            [
                'mochitest-timings/mochitest-stats.json',
                'xpcshell-timings/xpcshell-stats.json',
            ]
        );

        // And the consequence that matters: a second run served entirely from
        // cache must still report each harness's own numbers. Under a shared
        // key one of them silently becomes a copy of the other.
        const first = json(streams.stdout);
        const warmStreams = captureStreams();
        await run({ argv: ['summary', '--json'], streams: warmStreams, source: wrapped, cache });
        assert.equal(source.requested.length, 2, 'the warm run fetched nothing');
        const second = json(warmStreams.stdout);
        assert.deepEqual(second, first, 'the cached answer matches the fetched one');
        const harnesses = second['harnesses'] as { harness: string; current: Record<string, number> }[];
        assert.notDeepEqual(
            harnesses[0]!.current,
            harnesses[1]!.current,
            'xpcshell and mochitest must not report identical numbers'
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

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

test('an unwritable cache warns actionably and still answers', async () => {
    // A read-only path: writing under a file is EACCES/ENOTDIR everywhere.
    const directory = await mkdtemp(join(tmpdir(), 'fx-tests-cache-'));
    const blocked = join(directory, 'a-file', 'cache');
    await writeFile(join(directory, 'a-file'), 'not a directory');
    try {
        const cache = diskCache({ directory: blocked });
        const { cachedSource } = await import('../cli/cache.ts');
        const streams = captureStreams();
        const code = await run({
            argv: ['summary', '--harness', 'xpcshell', '--json'],
            streams,
            source: cachedSource(fixtureSource(), cache, {
                onWarning: (message) => streams.err(`warning: ${message}\n`),
            }),
            cache,
        });

        // The behaviour that matters first: a cache that cannot be written
        // makes the CLI slower, not broken.
        assert.equal(code, 0);
        assert.doesNotThrow(() => JSON.parse(streams.stdout));

        // And the message has to be usable. The raw form was
        // `EPERM: operation not permitted, mkdir '/proc'` — accurate, and it
        // tells a reader neither that the run succeeded nor what to do, so
        // seeing it mid-output reads as a failed run.
        assert.match(streams.stderr, /cache directory/);
        assert.match(streams.stderr, /complete and correct/);
        assert.match(streams.stderr, /--cache-dir/);
        assert.match(streams.stderr, /--no-cache/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('the cache-failure message names the cause for each errno it knows', async () => {
    const { describeCacheWriteFailure } = await import('../cli/cache.ts');
    const of = (code: string): string => {
        const error = new Error(`${code}: something went wrong`) as NodeJS.ErrnoException;
        error.code = code;
        return describeCacheWriteFailure('/some/dir', error);
    };
    assert.match(of('EACCES'), /no permission to write/);
    assert.match(of('EPERM'), /no permission to write/);
    assert.match(of('ENOSPC'), /no space left/);
    assert.match(of('EROFS'), /read-only filesystem/);
    // An unrecognized errno still gets the directory, the reassurance and the
    // two flags — only the first clause is generic.
    const unknown = of('EWEIRD');
    assert.match(unknown, /could not write the cache directory \/some\/dir/);
    assert.match(unknown, /--no-cache/);
    // The raw errno is kept at the end: it is the part worth searching for.
    assert.match(unknown, /EWEIRD/);
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
 *
 * `TestStatus` is where a real mochitest failure's message lives, and the
 * marker *name* is what identifies it: `FAIL` or `ERROR` in the string table,
 * not `test`. The `Test` marker itself carries no `message` for a plain
 * assertion failure, so a fixture that puts the message on the `Test` marker
 * tests a shape the harness does not emit.
 */
function profileWith(
    entries: {
        type: 'Test' | 'Crash' | 'Text' | 'TestStatus';
        test?: string;
        text?: string;
        status?: string;
        message?: string;
        color?: string;
        signature?: string;
        /** For `TestStatus`: the marker name, `FAIL` (default) or `ERROR`. */
        markerName?: 'FAIL' | 'ERROR';
        start: number;
        end: number;
    }[]
): string {
    // Index 0 is `test`; `FAIL` and `ERROR` get their own indexes so a
    // `TestStatus` marker can be named one of them, as the harness names them.
    const stringArray = ['test', 'other', 'FAIL', 'ERROR'];
    const nameIndexOf = (entry: (typeof entries)[number]): number => {
        if (entry.type === 'Test') return 0;
        if (entry.type === 'TestStatus') return entry.markerName === 'ERROR' ? 3 : 2;
        return 1;
    };
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
                    // Only `Test` markers are named `test`; Text and Crash get
                    // an index that is not 0, and `TestStatus` is named after
                    // its status, matching how a real profile names them.
                    name: entries.map(nameIndexOf),
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

test('try drops a crash recorded against a manifest rather than a test', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-mochitest-plain', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                // Two unclaimed crashes: one against a real test, one against
                // the manifest. Measured on try push 717fc67feaa071, the
                // `-xorig-2` job recorded 27 of the manifest kind.
                {
                    type: 'Crash',
                    test: `${MOCHITEST_PATH} (finished)`,
                    signature: '@ RunWatchdog',
                    start: 1,
                    end: 1,
                },
                {
                    type: 'Crash',
                    test: 'dom/canvas/test/mochitest.toml',
                    signature: '@ RunWatchdog',
                    start: 2,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { path: string }[]),
        ...(result['knownIntermittents'] as { path: string }[]),
        ...(result['newIntermittents'] as { path: string }[]),
    ];
    // The test-path crash becomes a failure; the manifest one does not. A
    // manifest is not a test, has nothing to join against central, and
    // reporting it as a failing test invents a test that does not exist.
    assert.deepEqual(
        all.map((failure) => failure.path),
        [MOCHITEST_PATH]
    );
    assert.ok(
        !all.some((failure) => failure.path.endsWith('.toml')),
        'no .toml may be reported as a failing test'
    );
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

/**
 * The message the fixture test already fails with on central.
 *
 * Taken verbatim from `xpcshell-00.json`'s `FAIL-PARALLEL` and
 * `FAIL-SEQUENTIAL` groups for `TEST_PATH`, so a push reporting it is
 * reporting the *same* failure central already sees.
 */
const CENTRAL_FAILURE_MESSAGE =
    'NS_ERROR_FILE_CORRUPTED: Component returned failure code: 0x8052000b ' +
    '(NS_ERROR_FILE_CORRUPTED) [nsIPrefService.readUserPrefsFromFile]';

test('try does NOT call it a perma-fail when central fails with the same message', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            // Fails in the only run, never passed on rerun, and reports the
            // message central already fails with. Everything about it looks
            // like a perma-fail except the one thing that decides it.
            TASK1: profileWith([
                {
                    type: 'Test',
                    test: TEST_PATH,
                    status: 'FAIL',
                    message: CENTRAL_FAILURE_MESSAGE,
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const perma = result['permaFails'] as { path: string }[];
    const known = result['knownIntermittents'] as {
        messageComparable: boolean;
        central: { sameMessageFailCount: number };
    }[];

    // The assertion the whole same-message rule exists for, and the direction
    // that was unguarded: `messageComparable` protected against calling an
    // *uncomparable* failure a perma-fail, but nothing protected against
    // calling a *matched* one a perma-fail. Removing
    // `sameMessageFailCount === 0` produced 15 false "almost certainly yours"
    // verdicts on autoland push 7c06165ae50f70 with the suite fully green —
    // one of them against a test failing 922 of 8,386 runs on central with
    // the identical message.
    assert.deepEqual(perma, [], 'a same-message central failure is not the patch’s fault');
    assert.equal(known.length, 1);
    assert.equal(known[0]!.messageComparable, true);
    assert.ok(
        known[0]!.central.sameMessageFailCount > 0,
        'and the same-message count is what exonerated it'
    );
});

test('try text output states the same-message rate that exonerated a failure', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456'],
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
                    message: CENTRAL_FAILURE_MESSAGE,
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    assert.match(streams.stdout, /PERMA-FAILS \(0\)/);
    assert.match(streams.stdout, /KNOWN INTERMITTENTS \(1\)/);
    // Both rates in the table, so a reader can see it is flaky *this way* and
    // not merely flaky.
    assert.match(streams.stdout, /same msg/);
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

// --- where the message actually lives -------------------------------------

/**
 * The shape measured on task `GwXgN5-rTOOtVkoQvJlDBQ` of try push 7d16bff8:
 * a `Test` marker with a status and no `message` field at all, and the real
 * message on a `TestStatus` marker inside its time range.
 *
 * This is what a plain mochitest assertion failure looks like. Reading only
 * `data.message` off the `Test` marker left 12 of that push's 26 failing tests
 * with no message, which printed `?` in the `same msg` column and — because an
 * uncomparable failure cannot be exonerated or convicted — took every one of
 * them out of the running for PERMA-FAILS.
 */
test('try reads a failure message off the TestStatus markers, not the Test marker', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                // No `message` on the Test marker — the harness does not put
                // one there for a FAIL.
                { type: 'Test', test: TEST_PATH, status: 'FAIL', start: 10, end: 20 },
                {
                    type: 'TestStatus',
                    test: TEST_PATH,
                    message: 'the real failure message',
                    start: 12,
                    end: 12,
                },
                // A later one inside the same range: the first is the one taken.
                {
                    type: 'TestStatus',
                    test: TEST_PATH,
                    message: 'a subsequent message',
                    start: 15,
                    end: 15,
                },
                // Outside the range, so it belongs to no execution here.
                {
                    type: 'TestStatus',
                    test: TEST_PATH,
                    message: 'from some other execution',
                    start: 90,
                    end: 90,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { messages: string[]; messageComparable: boolean }[]),
        ...(result['knownIntermittents'] as { messages: string[]; messageComparable: boolean }[]),
        ...(result['newIntermittents'] as { messages: string[]; messageComparable: boolean }[]),
    ];
    assert.equal(all.length, 1);
    assert.deepEqual(
        all[0]!.messages,
        ['the real failure message'],
        'the message on the TestStatus marker inside the range, and only that one'
    );
    // The whole point: with a message there is something to compare, so the
    // failure can reach a verdict instead of being parked as uncomparable.
    assert.equal(all[0]!.messageComparable, true);
});

test('try takes an ERROR-named TestStatus marker as a message too', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'FAIL', start: 10, end: 20 },
                {
                    type: 'TestStatus',
                    test: TEST_PATH,
                    markerName: 'ERROR',
                    message: 'an ERROR-named status marker',
                    start: 12,
                    end: 12,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { messages: string[] }[]),
        ...(result['knownIntermittents'] as { messages: string[] }[]),
        ...(result['newIntermittents'] as { messages: string[] }[]),
    ];
    assert.equal(all.length, 1);
    assert.deepEqual(all[0]!.messages, ['an ERROR-named status marker']);
});

test('try ignores a TestStatus marker recorded against a different test', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'FAIL', start: 10, end: 20 },
                // Same time range, different test: two tests can be in flight
                // at once under parallel execution, so the range alone does not
                // identify the owner.
                {
                    type: 'TestStatus',
                    test: 'dom/base/test/unit/test_other.js',
                    message: 'belongs to the neighbour',
                    start: 12,
                    end: 12,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { messages: string[]; messageComparable: boolean }[]),
        ...(result['knownIntermittents'] as { messages: string[]; messageComparable: boolean }[]),
        ...(result['newIntermittents'] as { messages: string[]; messageComparable: boolean }[]),
    ];
    assert.equal(all.length, 1);
    assert.deepEqual(all[0]!.messages, [], 'the neighbour’s message is not this test’s');
    assert.equal(all[0]!.messageComparable, false);
});

// --- perma-fail classification is per configuration -----------------------

/**
 * The shape measured for `browser_ml_heuristics.js` on try push 7d16bff8, and
 * the case `try.html` and this command used to disagree on.
 *
 * The test fails on two configurations. On CONFIG-A it is plainly intermittent
 * — another run of the same job name passed outright. On CONFIG-B every run
 * failed and none passed. `try.html` lists the test under "Permanent failures"
 * because it tags each failing *instance* and calls the test permanent when any
 * instance is not intermittent (`try.html:1400`, `:1765`).
 *
 * Asking "did every run of this test fail?" of the whole test answers no, and
 * hides a configuration the test never once passed on. That is the question
 * this command used to ask.
 */
test('try calls a test perma-failing when one config failed every run, even if another is flaky', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            // CONFIG-A: two runs, one failed the test and one passed the job
            // outright, so the failure is intermittent there.
            job('test-linux/opt-xpcshell-a', 'TASKA1', 'testfailed'),
            job('test-linux/opt-xpcshell-a', 'TASKA2', 'success'),
            // CONFIG-B: one run, and it failed. Nothing passed here.
            job('test-linux/opt-xpcshell-b', 'TASKB1', 'testfailed'),
        ]),
        fetchUrl: profileFetcher({
            TASKA1: profileWith([
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
            ]),
            TASKB1: profileWith([
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const perma = result['permaFails'] as {
        path: string;
        everyRunFailed: boolean;
        permaFailingConfigs: string[];
    }[];
    assert.equal(perma.length, 1, 'the config that never passed makes this a perma-fail');
    assert.equal(perma[0]!.path, MOCHITEST_PATH);
    assert.equal(perma[0]!.everyRunFailed, true);
    // And it names *which* config, since that is the actionable part and the
    // test is perfectly healthy on the other one.
    assert.deepEqual(perma[0]!.permaFailingConfigs, ['test-linux/opt-xpcshell-b']);
});

test('try does not call a config perma-failing when a run of it passed the job', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            job('test-linux/opt-xpcshell-a', 'TASKA1', 'testfailed'),
            job('test-linux/opt-xpcshell-a', 'TASKA2', 'success'),
        ]),
        fetchUrl: profileFetcher({
            TASKA1: profileWith([
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    // The only config had a fully successful run, so nothing here is permanent.
    assert.equal((result['permaFails'] as unknown[]).length, 0);
    const rest = [
        ...(result['knownIntermittents'] as { everyRunFailed: boolean; permaFailingConfigs: string[] }[]),
        ...(result['newIntermittents'] as { everyRunFailed: boolean; permaFailingConfigs: string[] }[]),
    ];
    assert.equal(rest.length, 1);
    assert.equal(rest[0]!.everyRunFailed, false);
    assert.deepEqual(rest[0]!.permaFailingConfigs, []);
});

/**
 * The other half of the per-config rule, and the one that is easy to get
 * backwards: a test that passed on the harness's rerun *on one config* must
 * still be a perma-fail when a different config failed every run.
 *
 * `isPermaFail` used to reject on the test-level `passedOnRerun`, which threw
 * the permanent config away. Measured on push 7d16bff8: four of that push's
 * five every-run-failed tests had `passedOnRerun` set somewhere.
 */
test('try keeps a perma-failing config when the test passed on rerun elsewhere', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            job('test-linux/opt-xpcshell-a', 'TASKA1', 'testfailed'),
            job('test-linux/opt-xpcshell-b', 'TASKB1', 'testfailed'),
        ]),
        fetchUrl: profileFetcher({
            // CONFIG-A: failed, then passed when the harness reran it.
            TASKA1: profileWith([
                { type: 'Text', text: 'retry', start: 10, end: 20 },
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
                { type: 'Test', test: MOCHITEST_PATH, status: 'PASS', start: 12, end: 14 },
            ]),
            // CONFIG-B: failed, and never passed.
            TASKB1: profileWith([
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const perma = result['permaFails'] as {
        passedOnRerun: boolean;
        permaFailingConfigs: string[];
    }[];
    assert.equal(perma.length, 1, 'the rerun on one config does not excuse the other');
    // The test-level flag is still true and reported — it is a real fact about
    // the push — it just does not decide the section on its own.
    assert.equal(perma[0]!.passedOnRerun, true);
    assert.deepEqual(perma[0]!.permaFailingConfigs, ['test-linux/opt-xpcshell-b']);
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
