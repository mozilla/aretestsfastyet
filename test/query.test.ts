/**
 * The query layer, against the checked-in fixtures.
 *
 * Golden values are written as literals and were derived from the fixtures
 * rather than from the code under test — every one of them is re-derivable by
 * summing the raw JSON, and several are cross-checked against a second,
 * independent path in the assertions below.
 *
 * The three things these tests are really defending:
 *
 * 1. **Reconciliation.** A test's per-config run counts must sum to its total
 *    run count. The two are computed by different code over different shapes
 *    (`durations` groups carry a job name, `task-ids` groups need a `taskInfo`
 *    hop), so agreeing is evidence rather than tautology.
 * 2. **The family asymmetry.** A skip count means a different thing per family
 *    (`FORMATS.md`), and the fixtures reproduce it exactly: 2,147 `run-if`
 *    skips in the daily file, zero in every aggregate. A regression that
 *    applied the filter in the wrong place would move one of those numbers.
 * 3. **The three coverage states.** ran-and-passed, ran-and-skipped and
 *    never-scheduled are what `--coverage` exists to separate, and the test
 *    asserts a real test that has all three.
 */

import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeBucket, type BucketFile } from '../lib/formats/buckets.ts';
import { decodeDaily, type DailyFile } from '../lib/formats/daily.ts';
import {
    decodeIssues,
    decodeIssuesWithTaskIds,
    type IssuesFile,
    type IssuesWithTaskIdsFile,
} from '../lib/formats/issues.ts';
import type { StatsFile } from '../lib/formats/stats.ts';
import {
    computeTestStats,
    configFilter,
    crashSignatureCounts,
    failureMessageCounts,
    inDayRange,
} from '../lib/query/test-stats.ts';
import {
    canAttributeConfigs,
    computeConfigStats,
} from '../lib/query/config-stats.ts';
import { configUniverse, coverageOf, platformsCovered } from '../lib/query/coverage.ts';
import { findIssues, findSkips, groupIssues } from '../lib/query/issues.ts';
import { groupFailuresByMessage } from '../lib/query/failures.ts';
import { groupCrashesBySignature } from '../lib/query/crashes.ts';
import { computeSummary, markerTotals } from '../lib/query/summary.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

async function fixture<T>(name: string): Promise<T> {
    return JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8')) as T;
}

const bucket = decodeBucket(await fixture<BucketFile>('xpcshell-00.json'));
const mochitestBucket = decodeBucket(await fixture<BucketFile>('mochitest-00.json'));
const issues = decodeIssues(await fixture<IssuesFile>('xpcshell-issues.json'));
const issuesWithTaskIds = decodeIssuesWithTaskIds(
    await fixture<IssuesWithTaskIdsFile>('xpcshell-issues-with-taskids.json')
);
const daily = decodeDaily(await fixture<DailyFile>('xpcshell-2026-08-03.json'));
const xpcshellStats = await fixture<StatsFile>('xpcshell-stats.json');
const mochitestStats = await fixture<StatsFile>('mochitest-stats.json');

/**
 * A Windows-only crash-reporter test, chosen because it exercises all three
 * coverage states at once: it runs and is intermittent on 5 Windows configs,
 * is `skip-if`-skipped on 13 others, and is never scheduled on 29 more.
 */
const WINDOWS_TEST = 'toolkit/crashreporter/test/unit/test_crash_win64cfi_push_nonvol.js';

// --- test-stats ----------------------------------------------------------

test('computeTestStats totals a test by status kind', () => {
    const identity = bucket.findTest(WINDOWS_TEST);
    assert.ok(identity, `fixture is missing ${WINDOWS_TEST}`);
    assert.equal(identity.component, 'Toolkit :: Crash Reporting');

    const stats = computeTestStats(bucket, identity.testId);
    assert.deepEqual(stats, {
        family: 'bucket',
        runCount: 1265,
        passCount: 1254,
        failCount: 9,
        timeoutCount: 2,
        crashCount: 0,
        expectedFailCount: 0,
        unknownCount: 0,
        skipCount: 1365,
        runIfSkipCount: 0,
        passRate: (1254 / 1265) * 100,
    });
    // The verdict axis: 11 of 1265 runs did not pass, so this is intermittent
    // rather than broken, and the rate is the number a caller would print.
    assert.equal(stats.failCount + stats.timeoutCount + stats.crashCount, 11);
});

test('runCount excludes skips and passRate is null when nothing ran', () => {
    // Skips are not runs: a test skipped everywhere has no pass rate at all,
    // and reporting 0% would claim it ran and failed.
    const empty = computeTestStats(bucket, bucket.testCount - 1, {
        jobFilter: () => false,
    });
    assert.equal(empty.runCount, 0);
    assert.equal(empty.passRate, null);
});

test('the day range filters the aggregate rather than refetching', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const all = computeTestStats(bucket, identity.testId);
    const lastThree = computeTestStats(bucket, identity.testId, {
        dayRange: { from: 18, to: 20 },
    });
    assert.ok(lastThree.runCount > 0, 'the last three days should have runs');
    assert.ok(
        lastThree.runCount < all.runCount,
        'a three-day slice must be smaller than the whole 21-day window'
    );

    // Slicing the window into two halves must partition it exactly: nothing
    // double-counted at the boundary, nothing dropped.
    const lower = computeTestStats(bucket, identity.testId, { dayRange: { from: 0, to: 9 } });
    const upper = computeTestStats(bucket, identity.testId, { dayRange: { from: 10, to: 20 } });
    assert.equal(lower.runCount + upper.runCount, all.runCount);
    assert.equal(lower.skipCount + upper.skipCount, all.skipCount);
});

test('a daily file ignores the day range, because it is one day', () => {
    // Entries of a daily file carry `day === null`. Filtering them out would
    // make `--day` against a daily file return nothing at all.
    assert.equal(inDayRange(null, { from: 5, to: 6 }), true);
    assert.equal(inDayRange(3, { from: 5, to: 6 }), false);
    assert.equal(inDayRange(5, { from: 5, to: 6 }), true);

    const withRange = computeTestStats(daily, 0, { dayRange: { from: 0, to: 0 } });
    const without = computeTestStats(daily, 0);
    assert.deepEqual(withRange, without);
});

test('configFilter unions the includes and applies the excludes after', () => {
    const linuxNotDebug = configFilter(['linux'], ['debug']);
    assert.equal(linuxNotDebug('test-linux2404-64/opt-xpcshell'), true);
    assert.equal(linuxNotDebug('test-linux2404-64/debug-xpcshell'), false);
    assert.equal(linuxNotDebug('test-windows11-64/opt-xpcshell'), false);

    const union = configFilter(['linux', 'windows11']);
    assert.equal(union('test-linux2404-64/opt-xpcshell'), true);
    assert.equal(union('test-windows11-64-25h2/opt-xpcshell'), true);
    assert.equal(union('test-macosx1470-64/opt-xpcshell'), false);

    // No includes means everything, which is what "all configs" has to mean.
    assert.equal(configFilter()('anything'), true);
});

test('failure messages and crash signatures are counted separately', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const messages = failureMessageCounts(bucket, identity.testId);
    const total = [...messages.values()].reduce((sum, n) => sum + n, 0);
    // Every FAIL run is accounted for by exactly one message bucket, and
    // timeouts contribute nothing because their groups carry no messageIds.
    assert.equal(total, computeTestStats(bucket, identity.testId).failCount);

    // A crashing test: signatures come off `crashSignatureIds`, never off
    // messages, because CRASH groups carry no messageIds at all.
    const crashing = bucket.findTest('dom/indexedDB/test/unit/test_setVersion_exclusion.js')!;
    const signatures = crashSignatureCounts(bucket, crashing.testId);
    const signatureTotal = [...signatures.values()].reduce((sum, n) => sum + n, 0);
    assert.equal(signatureTotal, computeTestStats(bucket, crashing.testId).crashCount);
    assert.equal(signatureTotal, 10);
});

// --- the family asymmetry ------------------------------------------------

test('the 21-day aggregates drop run-if skips and the daily files keep them', () => {
    // `FORMATS.md`'s central measured finding, reproduced on the fixtures. A
    // change that applied the filter in the wrong place moves one of these.
    const totals = (file: typeof bucket): { skipped: number; runIf: number } => {
        let skipped = 0;
        let runIf = 0;
        for (let testId = 0; testId < file.testCount; testId++) {
            const stats = computeTestStats(file, testId);
            skipped += stats.skipCount;
            runIf += stats.runIfSkipCount;
        }
        return { skipped, runIf };
    };

    assert.deepEqual(totals(daily), { skipped: 765, runIf: 2147 });
    assert.deepEqual(totals(bucket), { skipped: 11444, runIf: 0 });
    assert.deepEqual(totals(issues), { skipped: 17787, runIf: 0 });

    // The point of the asymmetry: on a daily file most skips are `run-if`, so
    // reporting the unfiltered count would overstate by nearly 4x here. On an
    // aggregate the filter is a no-op, because the generator already ran it.
    assert.equal(totals(daily).runIf > totals(daily).skipped, true);
    assert.equal(totals(bucket).runIf, 0);
});

test('a query never sums across file families', () => {
    // `issues`, `issues-with-taskids` and the 64 buckets are three encodings
    // of the same 21 days, so adding them multiplies the population. The
    // defence is structural — every query takes one file — and this asserts
    // the encodings agree rather than compose.
    let compared = 0;
    for (let testId = 0; testId < issues.testCount; testId++) {
        const path = issues.testAt(testId).fullPath;
        const inTaskIds = issuesWithTaskIds.findTest(path);
        if (inTaskIds === null) {
            continue;
        }
        compared += 1;
        const a = computeTestStats(issues, testId);
        const b = computeTestStats(issuesWithTaskIds, inTaskIds.testId);
        // Same runs, different shapes: `counts` on one side, `task-ids` on the
        // other for the failing groups. Byte-identical totals, so the two are
        // one population encoded twice and never a pair to add together.
        assert.equal(a.runCount, b.runCount, path);
        assert.equal(a.passCount, b.passCount, path);
        assert.equal(a.failCount, b.failCount, path);
        assert.equal(a.crashCount, b.crashCount, path);
        assert.equal(a.timeoutCount, b.timeoutCount, path);
        assert.equal(a.skipCount, b.skipCount, path);
        assert.equal(a.family, 'issues');
        assert.equal(b.family, 'issues-with-taskids');
    }
    assert.equal(compared, 9, 'the two issues fixtures should share every test');
});

// --- config-stats --------------------------------------------------------

test('computeConfigStats reconciles with the test total', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const configs = computeConfigStats(bucket, identity.testId);
    const stats = computeTestStats(bucket, identity.testId);

    // The reconciliation that makes this a real check: per-config runs are
    // attributed two different ways — `durations` groups name a job, failing
    // groups go through `taskInfo` — and must still sum to the total.
    const summed = configs.reduce((sum, config) => sum + config.runCount, 0);
    assert.equal(summed, stats.runCount);
    assert.equal(
        configs.reduce((sum, config) => sum + config.failCount, 0),
        stats.failCount + stats.timeoutCount + stats.crashCount
    );

    assert.equal(configs.length, 9);
    // Sorted by descending failure rate, which is what puts a perma-fail at
    // the top rather than the config that merely runs most.
    for (let i = 1; i < configs.length; i++) {
        assert.ok(configs[i - 1]!.failRate >= configs[i]!.failRate);
    }

    // And it holds for every test in the fixture, not just the chosen one —
    // otherwise this asserts a property of one well-behaved test.
    for (let testId = 0; testId < bucket.testCount; testId++) {
        const perConfig = computeConfigStats(bucket, testId);
        const totals = computeTestStats(bucket, testId);
        const path = bucket.testAt(testId).fullPath;
        assert.equal(
            perConfig.reduce((sum, config) => sum + config.runCount, 0),
            totals.runCount,
            path
        );
        assert.equal(
            perConfig.reduce((sum, config) => sum + config.failCount, 0),
            totals.failCount + totals.timeoutCount + totals.crashCount,
            path
        );
    }
});

test('every config shares one recent window, sized by run count', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const configs = computeConfigStats(bucket, identity.testId);

    // The load-bearing property: one window for all configs, so their recent
    // rates cover the same period and are comparable. Sized by runs and not by
    // days, because weekend push volume drops several-fold.
    const widths = new Set(configs.map((config) => config.recentDays));
    assert.equal(widths.size, 1, 'all configs must share one window');
    const [windowDays] = [...widths];
    assert.equal(windowDays, 10);

    // The window is wide enough that at least one config reached the minimum,
    // which is what sized it.
    assert.ok(
        configs.some((config) => config.recentRunCount >= 20),
        'the window should be sized by a config that reached minRecentRuns'
    );
});

test('a config too sparse for the minimum gets null, not zero', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    // A minimum no config can reach in the window leaves every recent rate
    // unknown — "not enough data to say" is not "0% failures".
    const configs = computeConfigStats(bucket, identity.testId, {
        minRecentRuns: 1_000_000,
    });
    assert.ok(configs.length > 0);
    for (const config of configs) {
        assert.equal(config.recentFailRate, null);
        assert.equal(config.recentSameMsgFailRate, null);
    }
    // And it did not widen the window for everyone: unreachable minimums leave
    // the default width of 1 rather than stretching to the whole file.
    assert.equal(configs[0]!.recentDays, 1);
});

test('a day range re-anchors the recent window to the filtered days', () => {
    // Worth pinning because it is easy to assume otherwise: the window is
    // derived from whatever days survived the filter and is anchored to the
    // newest of *those*, not to the newest day in the file. So `--since` and
    // `--day` narrow the recent window too rather than leaving it dangling
    // past the end of the requested range.
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const full = computeConfigStats(bucket, identity.testId);
    const sliced = computeConfigStats(bucket, identity.testId, { dayRange: { from: 0, to: 5 } });

    assert.equal(full[0]!.recentDays, 10);
    assert.equal(sliced[0]!.recentDays, 4);
    assert.ok(
        sliced.reduce((sum, config) => sum + config.runCount, 0) <
            full.reduce((sum, config) => sum + config.runCount, 0)
    );
    // The window can never exceed the slice it was derived from.
    for (const config of sliced) {
        assert.ok(config.recentDays <= 6, 'the window must fit inside the requested range');
    }
});

test('--recent-days overrides the derived window', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const configs = computeConfigStats(bucket, identity.testId, { recentDays: 3 });
    for (const config of configs) {
        assert.equal(config.recentDays, 3);
    }
});

test('same-message rates separate "fails" from "fails this way"', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const all = computeConfigStats(bucket, identity.testId);
    const failing = all.filter((config) => config.failCount > 0);
    assert.ok(failing.length > 0);

    // With no try messages supplied, nothing matches: a test that fails for
    // some other reason is not exonerated by failing at all.
    for (const config of all) {
        assert.equal(config.sameMsgFailCount, 0);
    }

    // Feeding back the messages this test actually produced makes them match,
    // which is the "this failure is pre-existing" path in `fx-tests try`.
    const messages = [...failureMessageCounts(bucket, identity.testId).keys()].filter(
        (message): message is string => message !== null
    );
    assert.ok(messages.length > 0, 'the test should have failure messages');
    const matched = computeConfigStats(bucket, identity.testId, { tryMessages: messages });
    const matchedTotal = matched.reduce((sum, config) => sum + config.sameMsgFailCount, 0);
    assert.equal(matchedTotal, computeTestStats(bucket, identity.testId).failCount);
});

test('timeouts and crashes match on the status, since they record no message', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const stats = computeTestStats(bucket, identity.testId);
    assert.ok(stats.timeoutCount > 0, 'the chosen test should have timeouts');

    // A timeout group carries no messageIds at all, so a message-based match
    // can never find it. `matchAnyTimeout` is what makes it matchable.
    const withoutFlag = computeConfigStats(bucket, identity.testId, { tryMessages: [] });
    const withFlag = computeConfigStats(bucket, identity.testId, {
        tryMessages: [],
        matchAnyTimeout: true,
    });
    const total = (configs: typeof withFlag): number =>
        configs.reduce((sum, config) => sum + config.sameMsgFailCount, 0);
    assert.equal(total(withoutFlag), 0);
    assert.equal(total(withFlag), stats.timeoutCount);
});

test('the issues family cannot attribute configs, and says so', () => {
    // `{harness}-issues.json` has no taskInfo and no jobNameIds: the question
    // has no answer there, which is different from "no configs failed".
    assert.equal(canAttributeConfigs(issues), false);
    assert.equal(canAttributeConfigs(bucket), true);
    assert.equal(canAttributeConfigs(issuesWithTaskIds), true);
    assert.deepEqual(computeConfigStats(issues, 0), []);
});

// --- coverage ------------------------------------------------------------

test('coverage separates ran-and-passed, ran-and-skipped and never-scheduled', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const universe = configUniverse(bucket);
    assert.equal(universe.size, 51);

    const coverage = coverageOf(bucket, identity.testId, { universe });
    assert.equal(coverage.attributedPasses, true);
    assert.equal(coverage.configs.length, 51);

    const byState = new Map<string, number>();
    for (const config of coverage.configs) {
        byState.set(config.state, (byState.get(config.state) ?? 0) + 1);
    }
    // The three states that look alike in a failure-only view, all present on
    // one test: a Windows-only crash-reporter test.
    assert.deepEqual(Object.fromEntries([...byState].sort()), {
        intermittent: 5,
        'never-scheduled': 29,
        ok: 4,
        skipped: 13,
    });
    assert.equal(coverage.neverScheduled?.length, 29);

    // The skipped rows carry the reason, which is what makes them actionable.
    const android = coverage.configs.find((config) => config.jobName.includes('android'));
    assert.ok(android, 'the fixture should have an android config');
    assert.equal(android.state, 'skipped');
    assert.equal(android.runCount, 0);
    assert.deepEqual([...android.skipMessages.keys()], ["os == 'android'"]);
});

test('coverage row counts reconcile with the test totals', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const coverage = coverageOf(bucket, identity.testId);
    const stats = computeTestStats(bucket, identity.testId);
    const sum = (pick: (row: (typeof coverage.configs)[number]) => number): number =>
        coverage.configs.reduce((total, row) => total + pick(row), 0);

    assert.equal(sum((row) => row.passCount), stats.passCount);
    assert.equal(sum((row) => row.failCount), stats.failCount);
    assert.equal(sum((row) => row.timeoutCount), stats.timeoutCount);
    assert.equal(sum((row) => row.skipCount), stats.skipCount);
    assert.equal(sum((row) => row.runCount), stats.runCount);
});

test('a run-if-only config reads as not-applicable, not as skipped', () => {
    // Only reachable from a daily file: the aggregates drop `run-if` skips
    // upstream, so a config that appears solely through one is invisible
    // there. Labelling it "skipped" would read as "someone disabled this
    // here", which is the opposite of what a `run-if` says.
    let notApplicable = 0;
    let skipped = 0;
    for (let testId = 0; testId < daily.testCount; testId++) {
        for (const config of coverageOf(daily, testId).configs) {
            if (config.state === 'not-applicable') {
                notApplicable += 1;
                assert.equal(config.skipCount, 0);
                assert.ok(config.runIfSkipCount > 0);
                assert.equal(config.runCount, 0);
            }
            if (config.state === 'skipped') {
                skipped += 1;
                assert.ok(config.skipCount > 0);
            }
        }
    }
    assert.equal(notApplicable, 11, 'the daily fixture has 11 run-if-only configs');

    // The aggregates cannot produce the state at all, because the generator
    // already filtered those rows out.
    for (let testId = 0; testId < bucket.testCount; testId++) {
        for (const config of coverageOf(bucket, testId).configs) {
            assert.notEqual(config.state, 'not-applicable');
        }
    }
    assert.ok(skipped >= 0);
});

test('never-scheduled is null when no universe was supplied', () => {
    // "not checked" and "none missing" must not look the same: without a
    // universe there is nothing to subtract from, and [] would claim there is.
    const identity = bucket.findTest(WINDOWS_TEST)!;
    assert.equal(coverageOf(bucket, identity.testId).neverScheduled, null);
    assert.deepEqual(
        coverageOf(bucket, identity.testId, { universe: [] }).neverScheduled,
        []
    );
});

test('coverage reports when a family cannot attribute passing runs', () => {
    // On the issues families the pass-like groups are `counts` with no job
    // attribution, so a coverage table there would show only failing configs —
    // exactly the partial view `--coverage` exists to replace.
    const coverage = coverageOf(issues, 0);
    assert.equal(coverage.attributedPasses, false);
    assert.deepEqual(coverage.configs, []);

    // Even `issues-with-taskids` cannot: despite the name, its pass-like
    // groups keep the `counts` shape and have no task IDs.
    assert.equal(coverageOf(issuesWithTaskIds, 0).attributedPasses, false);
});

test('platformsCovered counts only configs the test ran on', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const coverage = coverageOf(bucket, identity.testId, { universe: configUniverse(bucket) });
    const platforms = platformsCovered(coverage);
    // A Windows-only test: it runs on windows and nowhere else, even though
    // android rows exist (skipped) and 29 configs never scheduled it.
    assert.deepEqual([...platforms.keys()], ['windows']);
    assert.equal(platforms.get('windows'), 9);
});

// --- issues / skips ------------------------------------------------------

test('findIssues reports only tests with a non-passing outcome', () => {
    const rows = findIssues(bucket);
    assert.ok(rows.length > 0);
    for (const row of rows) {
        assert.ok(
            row.failCount + row.timeoutCount + row.crashCount > 0,
            `${row.fullPath} has no non-passing outcome but was reported`
        );
    }
    // Sorted by descending failure rate: rate ranks the worst tests, count
    // would rank the ones that merely run most.
    for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i - 1]!.failRate >= rows[i]!.failRate);
    }

    // Each row's totals must match the per-test query over the same file.
    for (const row of rows) {
        const stats = computeTestStats(bucket, row.testId);
        assert.equal(row.runCount, stats.runCount, row.fullPath);
        assert.equal(row.failCount, stats.failCount, row.fullPath);
        assert.equal(row.skipCount, stats.skipCount, row.fullPath);
    }
});

test('findIssues filters by path, component, type and rate', () => {
    const all = findIssues(bucket);

    const scoped = findIssues(bucket, { pathPrefix: 'dom/indexedDB' });
    assert.ok(scoped.length > 0 && scoped.length < all.length);
    for (const row of scoped) {
        assert.ok(row.fullPath.startsWith('dom/indexedDB'));
    }

    // Crashes only: every row must have one, and the set must be a subset.
    const crashesOnly = findIssues(bucket, { types: ['crash'] });
    assert.ok(crashesOnly.length > 0);
    for (const row of crashesOnly) {
        assert.ok(row.crashCount > 0);
    }
    assert.ok(crashesOnly.length <= all.length);

    // A rate threshold above everything present yields nothing rather than
    // silently ignoring the filter.
    assert.deepEqual(findIssues(bucket, { minRate: 100 }), []);

    const byComponent = findIssues(bucket, { component: 'crash reporting' });
    assert.ok(byComponent.length > 0, 'component match should be case-insensitive');
    for (const row of byComponent) {
        assert.match(row.component ?? '', /Crash Reporting/i);
    }
});

test('groupIssues aggregates rows without double-counting', () => {
    const rows = findIssues(bucket);
    const groups = groupIssues(rows, 'component');
    assert.equal(
        groups.reduce((sum, group) => sum + group.testCount, 0),
        rows.length
    );
    assert.equal(
        groups.reduce((sum, group) => sum + group.failCount, 0),
        rows.reduce((sum, row) => sum + row.failCount, 0)
    );

    const byDirectory = groupIssues(rows, 'directory');
    assert.equal(
        byDirectory.reduce((sum, group) => sum + group.testCount, 0),
        rows.length
    );
});

test('findSkips excludes run-if by default and includes it on request', () => {
    // On an aggregate the flag changes nothing, because the generator already
    // dropped `run-if`. On a daily file it changes the count substantially,
    // and that difference is the asymmetry itself.
    const aggregateDefault = findSkips(bucket).reduce((sum, row) => sum + row.skipCount, 0);
    const aggregateWithRunIf = findSkips(bucket, { includeRunIf: true }).reduce(
        (sum, row) => sum + row.skipCount,
        0
    );
    assert.equal(aggregateDefault, 11444);
    assert.equal(aggregateWithRunIf, 11444);

    const dailyDefault = findSkips(daily).reduce((sum, row) => sum + row.skipCount, 0);
    const dailyWithRunIf = findSkips(daily, { includeRunIf: true }).reduce(
        (sum, row) => sum + row.skipCount,
        0
    );
    assert.equal(dailyDefault, 765);
    assert.equal(dailyWithRunIf, 765 + 2147);
});

test('skip rows carry the condition and the configs', () => {
    const rows = findSkips(bucket);
    assert.ok(rows.length > 0);
    const withMessages = rows.find((row) => row.messages.size > 0);
    assert.ok(withMessages, 'some skip should record a condition');
    // The `skip-if: ` prefix is stripped for display; the condition is the
    // informative part and is the same on every message otherwise.
    for (const message of withMessages.messages.keys()) {
        assert.ok(!message.startsWith('skip-if:'), message);
    }
    // The bucket files' SKIP groups carry `jobNameIds`, so the configs are
    // known — which is what "what is turned off on Windows?" needs.
    assert.ok(withMessages.jobNames.size > 0);
});

// --- failures / crashes --------------------------------------------------

test('failures group by message and count distinct tests', () => {
    const groups = groupFailuresByMessage(bucket);
    assert.ok(groups.length > 0);

    // Every failing run in the file is in exactly one group.
    let expected = 0;
    for (let testId = 0; testId < bucket.testCount; testId++) {
        expected += computeTestStats(bucket, testId).failCount;
    }
    assert.equal(
        groups.reduce((sum, group) => sum + group.count, 0),
        expected
    );

    // Sorted by occurrences, descending.
    for (let i = 1; i < groups.length; i++) {
        assert.ok(groups[i - 1]!.count >= groups[i]!.count);
    }

    // The test-spread count is the ambient-vs-specific discriminator, and it
    // is exact even when the `tests` list is capped.
    for (const group of groups) {
        assert.ok(group.testCount >= 1);
        assert.ok(group.tests.length <= group.testCount);
        assert.equal(
            group.tests.reduce((sum, entry) => sum + entry.count, 0) <= group.count,
            true
        );
    }
});

test('failures filter by message substring, case-insensitively', () => {
    const all = groupFailuresByMessage(bucket);
    const first = all.find((group) => group.message !== null);
    assert.ok(first?.message);
    const needle = first.message.slice(0, 12).toUpperCase();
    const filtered = groupFailuresByMessage(bucket, { message: needle });
    assert.ok(filtered.length > 0 && filtered.length <= all.length);
    for (const group of filtered) {
        assert.match(group.message ?? '', new RegExp(escapeRegExp(needle), 'i'));
    }
});

test('crashes group by signature, not by message', () => {
    const groups = groupCrashesBySignature(bucket);
    assert.ok(groups.length > 0);

    let expected = 0;
    for (let testId = 0; testId < bucket.testCount; testId++) {
        expected += computeTestStats(bucket, testId).crashCount;
    }
    assert.equal(
        groups.reduce((sum, group) => sum + group.count, 0),
        expected
    );

    // CRASH groups carry no messageIds at all, so grouping them by message
    // would put every crash in one `(no message)` bucket. Signatures are what
    // they do carry.
    for (const group of groups) {
        assert.ok(group.signature === null || typeof group.signature === 'string');
        for (const dump of group.minidumps) {
            assert.match(dump.taskId, /^[\w-]+$/);
            assert.ok(Number.isInteger(dump.retryId) && dump.retryId >= 0);
            assert.ok(dump.minidumpId.length > 0);
        }
    }
});

test('a crash group can have occurrences and no minidump to fetch', () => {
    // Mochitest has 58 crashes whose dump was never uploaded, always the same
    // entries as the null signatures. A group with a count and an empty
    // `minidumps` is that case, not a bug.
    const groups = groupCrashesBySignature(mochitestBucket);
    for (const group of groups) {
        assert.ok(group.count > 0);
        assert.ok(group.minidumps.length <= group.count);
    }
});

// --- summary -------------------------------------------------------------

test('computeSummary compares a period against the one before it', () => {
    const summary = computeSummary(xpcshellStats);
    assert.equal(summary.harness, 'xpcshell');
    assert.equal(summary.current.dayCount, 7);
    assert.ok(summary.prior, 'the stats file reaches back far enough for a prior period');
    assert.equal(summary.prior.dayCount, 7);

    // The periods must not overlap, or the comparison compares a window with
    // itself.
    assert.ok(summary.prior.endDate < summary.current.startDate);

    // Rates are rates, and the delta is in percentage points.
    for (const rate of [
        summary.current.testFailureRate,
        summary.current.jobFailureRate,
        summary.current.skipRate,
        summary.current.invalidJobRate,
    ]) {
        assert.ok(rate !== null && rate >= 0 && rate <= 100, `implausible rate ${rate}`);
    }
    assert.equal(
        summary.delta.testFailureRate,
        summary.current.testFailureRate! - summary.prior.testFailureRate!
    );
});

test('the skip rate denominator includes the skips', () => {
    // Dividing skips by runs alone would exceed 100% whenever more is skipped
    // than run, which is possible on a heavily platform-scoped harness.
    const summary = computeSummary(xpcshellStats);
    const { skippedTestRuns, totalTestRuns, skipRate } = summary.current;
    assert.equal(skipRate, (skippedTestRuns / (totalTestRuns + skippedTestRuns)) * 100);
    assert.ok(skipRate! <= 100);
});

test('computeSummary rejects a date the file does not have', () => {
    assert.throws(
        () => computeSummary(xpcshellStats, { endDate: '1999-01-01' }),
        /has no date 1999-01-01/
    );
    // And it honours one it does, rather than silently using the newest.
    const middle = xpcshellStats.dates[xpcshellStats.dates.length - 3]!;
    assert.equal(computeSummary(xpcshellStats, { endDate: middle }).current.endDate, middle);
});

test('a period with no prior window reports null rather than inventing one', () => {
    // A window as wide as the file leaves nothing before it. A partial prior
    // period would have a different weekday mix, so it is refused outright.
    const summary = computeSummary(xpcshellStats, { days: xpcshellStats.dates.length });
    assert.equal(summary.prior, null);
    assert.deepEqual(summary.delta, {
        testFailureRate: null,
        jobFailureRate: null,
        skipRate: null,
        invalidJobRate: null,
    });
});

test('marker totals come from the file, and the kinds differ by harness', () => {
    const xpcshell = markerTotals(xpcshellStats);
    const mochitest = markerTotals(mochitestStats);
    assert.ok(xpcshell.size > 0 && mochitest.size > 0);

    // `TSan Error` is mochitest-only — it comes from instrumented builds — so
    // the kind list is data and must not be hardcoded.
    assert.ok(mochitest.has('TSan Error'));
    assert.ok(!xpcshell.has('TSan Error'));

    // Sorted by descending count, so the loudest kind leads.
    const counts = [...mochitest.values()];
    for (let i = 1; i < counts.length; i++) {
        assert.ok(counts[i - 1]! >= counts[i]!);
    }
});

/** Escapes a string for use inside a RegExp. */
function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
