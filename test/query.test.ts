/**
 * The query layer, against the checked-in fixtures.
 *
 * Golden values are written as literals and were derived from the fixtures
 * rather than from the code under test — every one of them is re-derivable by
 * summing the raw JSON, and several are cross-checked against a second,
 * independent path in the assertions below.
 *
 * The four things these tests are really defending:
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
 * 4. **The recent window's exact width.** Sized by run count rather than by
 *    days, and inclusive at both ends. An off-by-one there reports an 11-day
 *    window as 10 days — a plausible-looking wrong number, which is the
 *    failure mode this data keeps producing.
 *
 * Where a branch is reachable by the format but absent from today's data —
 * an `EXPECTED-FAIL` carrying a message, a config with both a `skip-if` and a
 * `run-if`, a day on which CI did not run — the input is built by hand and
 * says so. Those are the cases a fixture cannot supply and a mutation would
 * otherwise survive.
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
import { classifyStatus } from '../lib/model/status.ts';
import { parseJobName, stripChunkSuffix } from '../lib/model/job-name.ts';
import {
    computeTestStats,
    configFilter,
    crashSignatureCounts,
    failureMessageCounts,
    inDayRange,
    jobNameOfEntry,
} from '../lib/query/test-stats.ts';
import {
    canAttributeConfigs,
    computeConfigStats,
} from '../lib/query/config-stats.ts';
import {
    configUniverse,
    coverageGaps,
    coverageOf,
    platformsCovered,
} from '../lib/query/coverage.ts';
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

test('a failing entry resolves its job through taskInfo, not through jobName', () => {
    // The two attribution paths. `durations` and `skip-counts` groups name a
    // job directly; the failing shapes carry only task-ID indices, so their
    // configuration has to be looked up through `taskInfo.jobNameIds`. Losing
    // that hop would leave every fail, timeout and crash unattributed — the
    // failure and crash groupings would report no configurations at all, and
    // `computeConfigStats` would drop the failures from its rows.
    let viaJobName = 0;
    let viaTaskIndex = 0;
    for (let testId = 0; testId < bucket.testCount; testId++) {
        for (const entry of bucket.runsOfTest(testId)) {
            const jobName = jobNameOfEntry(bucket, entry);
            assert.notEqual(jobName, null, `${entry.status} entry resolved to no job`);
            if (entry.jobName !== undefined) {
                viaJobName += 1;
            } else {
                assert.notEqual(entry.taskIdIndexes, undefined);
                viaTaskIndex += 1;
                // Only the non-passing shapes take this path.
                const { kind } = classifyStatus(entry.status);
                assert.ok(
                    kind === 'fail' || kind === 'timeout' || kind === 'crash',
                    `${entry.status} should not need a taskInfo hop`
                );
            }
        }
    }
    assert.equal(viaJobName, 11250);
    assert.equal(viaTaskIndex, 55, 'the failing shapes must go through taskInfo');

    // And the resolved names reach the groupings that depend on them.
    const crashes = groupCrashesBySignature(bucket);
    assert.ok(crashes.length > 0);
    for (const group of crashes) {
        assert.ok(group.jobNames.size > 0, 'a crash group must know its configs');
    }
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

test('the recent window covers exactly the days it claims to', () => {
    // The off-by-one this module's own comment calls the one "most likely to
    // be simplified away", and the number `CLI.md`'s "recent (7d)" column
    // prints. `from = newestDay - windowDays + 1` is inclusive at both ends:
    // a 10-day window ending on day 20 starts at day 11, not day 10.
    //
    // The expectation is recomputed here from the entries rather than read off
    // the function, so it is evidence and not a copy of the answer. Dropping
    // the `+ 1` would widen the window to 11 days while still reporting
    // `recentDays: 10` — a wrong number that looks right, which is the failure
    // mode this project keeps warning about.
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const configs = computeConfigStats(bucket, identity.testId);
    const windowDays = configs[0]!.recentDays;
    assert.equal(windowDays, 10);

    // Independent per-day tally of everything that counts as a run.
    const perDay = new Map<number, number>();
    for (const entry of bucket.runsOfTest(identity.testId)) {
        const { kind } = classifyStatus(entry.status);
        if (kind === 'skip' || kind === 'unknown') {
            continue;
        }
        assert.notEqual(entry.day, null, 'a bucket file always carries days');
        perDay.set(entry.day!, (perDay.get(entry.day!) ?? 0) + entry.count);
    }
    const newestDay = Math.max(...perDay.keys());
    assert.equal(newestDay, 20);

    const runsSince = (from: number): number => {
        let total = 0;
        for (const [day, count] of perDay) {
            if (day >= from) {
                total += count;
            }
        }
        return total;
    };

    // Hand-checked: 637 runs fall in days 11..20, and 724 in days 10..20. The
    // gap between them is what an off-by-one silently absorbs.
    assert.equal(runsSince(newestDay - windowDays + 1), 637);
    assert.equal(runsSince(newestDay - windowDays), 724);

    const reported = configs.reduce((sum, config) => sum + config.recentRunCount, 0);
    assert.equal(reported, 637, 'the reported window must be the inclusive one');
    assert.notEqual(reported, 724, 'an 11-day window must not be reported as 10 days');

    // Per config, so the boundary is pinned on each row and not only in total.
    assert.deepEqual(
        configs.map((config) => [config.jobName, config.recentRunCount]),
        [
            ['test-windows11-64-25h2-shippable/opt-xpcshell', 26],
            ['test-windows10-64-2009-qr/debug-xpcshell', 138],
            ['test-windows10-64-2009-qr/opt-xpcshell', 120],
            ['test-windows11-64-25h2/opt-xpcshell', 109],
            ['test-windows11-64-25h2/debug-xpcshell', 150],
            ['test-windows11-64-24h2-artifact/opt-xpcshell', 25],
            ['test-windows11-64-24h2-artifact/debug-xpcshell', 25],
            ['test-windows11-64-25h2-ccov/opt-xpcshell', 23],
            ['test-windows10-64-2009-shippable-qr/opt-xpcshell', 21],
        ]
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

test('config rows are chunk-stripped, so chunks of one config aggregate', () => {
    // The daily files keep the chunk suffix and the aggregates do not, so
    // without stripping the same configuration splits into one row per chunk
    // on one family and not on the other. On this test the raw job names
    // number 85 and the configurations 34 — a table 2.5x too long, with every
    // rate computed over a chunk's runs instead of a config's.
    const identity = daily.findTest(
        'toolkit/components/extensions/test/xpcshell/test_ext_geckoProfiler_control.js'
    )!;

    // Chunked job names, counting only entries that reach a verdict — skips
    // are not runs and `computeConfigStats` excludes configs that only ever
    // skipped, so collecting every status here would compare two different
    // populations. 85 names appear in total, 47 of them on runs.
    const rawJobNames = new Set<string>();
    const runJobNames = new Set<string>();
    for (const entry of daily.runsOfTest(identity.testId)) {
        const { kind } = classifyStatus(entry.status);
        const names: string[] = [];
        if (entry.jobName !== undefined) {
            names.push(entry.jobName);
        } else if (entry.taskIdIndexes !== undefined) {
            for (const taskIdIndex of entry.taskIdIndexes) {
                const jobName = daily.jobNameOfTaskIndex(taskIdIndex);
                if (jobName !== null) {
                    names.push(jobName);
                }
            }
        }
        for (const name of names) {
            rawJobNames.add(name);
            if (kind !== 'skip' && kind !== 'unknown') {
                runJobNames.add(name);
            }
        }
    }
    assert.equal(rawJobNames.size, 85, 'the daily file names each chunk separately');
    assert.equal(runJobNames.size, 47, '47 chunked job names actually ran this test');

    const configs = computeConfigStats(daily, identity.testId);
    assert.equal(configs.length, 34, 'chunks of one config must collapse into one row');

    // No reported row may carry a chunk suffix, and every raw name must strip
    // onto one of them — the property that makes 85 become 34.
    const reported = new Set(configs.map((config) => config.jobName));
    for (const jobName of reported) {
        assert.equal(jobName, stripChunkSuffix(jobName), jobName);
    }
    for (const raw of runJobNames) {
        assert.ok(reported.has(stripChunkSuffix(raw)), `${raw} has no config row`);
    }
    // Stripping is exactly what collapses 47 onto 34 — asserted as a set
    // identity so a stripping rule that merged too much also fails.
    assert.deepEqual(
        [...new Set([...runJobNames].map(stripChunkSuffix))].sort(),
        [...reported].sort()
    );
});

test('crashes match a try push on their signature, not on a message', () => {
    // CRASH groups carry `crashSignatureIds` and no `messageIds` at all, so
    // matching them against a try push has to read the signature. Reading
    // `message` instead would find nothing and report every crash as new —
    // the "is this crash pre-existing?" path in `fx-tests try`.
    const identity = bucket.findTest('dom/indexedDB/test/unit/test_setVersion_exclusion.js')!;
    const stats = computeTestStats(bucket, identity.testId);
    assert.equal(stats.crashCount, 10);

    const signatures = [...crashSignatureCounts(bucket, identity.testId).keys()].filter(
        (signature): signature is string => signature !== null
    );
    assert.equal(signatures.length, 1);

    const matched = computeConfigStats(bucket, identity.testId, { tryMessages: signatures });
    assert.equal(
        matched.reduce((sum, config) => sum + config.sameMsgFailCount, 0),
        10,
        'every crash with a known signature must count as the same failure'
    );

    // A signature that is not in the push matches nothing, so the count is
    // discriminating rather than always-on.
    const unmatched = computeConfigStats(bucket, identity.testId, {
        tryMessages: ['@ something_that_never_crashed'],
    });
    assert.equal(
        unmatched.reduce((sum, config) => sum + config.sameMsgFailCount, 0),
        0
    );
});

test('an expected-fail is never counted as a matching failure', () => {
    // `EXPECTED-FAIL` groups in the published files carry no messages, so this
    // guard cannot be exercised from a fixture. A test annotated `fail-if`
    // that failed did what it was told, and letting its message match a try
    // push's would report an annotation working as a pre-existing failure.
    // Built by hand because the case is reachable by the format and simply
    // absent from today's data.
    const synthetic = decodeBucket({
        metadata: {
            startDate: '2026-07-14',
            endDate: '2026-08-03',
            days: 21,
            startTime: 0,
            generatedAt: '',
            totalTestCount: 1,
            testsWithFailures: 1,
            aggregatedFrom: [],
            totalBuckets: 64,
            bucketIndex: 0,
        },
        tables: {
            jobNames: ['test-linux2404-64/opt-xpcshell'],
            testPaths: ['a/b'],
            testNames: ['test_x.js'],
            repositories: ['mozilla-central'],
            statuses: ['PASS', 'EXPECTED-FAIL', 'FAIL'],
            taskIds: ['AAA.0', 'BBB.0'],
            messages: ['annotated failure', 'real failure'],
            crashSignatures: [],
            components: ['Core :: X'],
            commitIds: ['abc'],
        },
        taskInfo: {
            repositoryIds: [0, 0],
            jobNameIds: [0, 0],
            commitIds: [0, 0],
            chunks: [null, null],
        },
        testInfo: { testPathIds: [0], testNameIds: [0], componentIds: [0] },
        testRuns: [
            [
                { days: [20], durations: [[100, 100, 100]], jobNameIds: [0] },
                { days: [20], taskIdIds: [[0]], messageIds: [0] },
                { days: [20], taskIdIds: [[1]], messageIds: [1] },
            ],
        ],
    } as unknown as BucketFile);

    // Sanity: the synthetic file really does put a message on the
    // EXPECTED-FAIL group, or this test would pass vacuously.
    const statuses = new Map<string, string | null | undefined>();
    for (const entry of synthetic.runsOfTest(0)) {
        statuses.set(entry.status, entry.message);
    }
    assert.equal(statuses.get('EXPECTED-FAIL'), 'annotated failure');

    // The annotated message must not match: the run behaved as annotated.
    const annotated = computeConfigStats(synthetic, 0, { tryMessages: ['annotated failure'] });
    assert.equal(annotated[0]!.sameMsgFailCount, 0);
    // A real failure with the same shape does match, so the zero above is the
    // guard and not an inert code path.
    const real = computeConfigStats(synthetic, 0, { tryMessages: ['real failure'] });
    assert.equal(real[0]!.sameMsgFailCount, 1);

    // And `expected-fail` is not a failure: 5 runs, one of which failed.
    assert.equal(annotated[0]!.runCount, 5);
    assert.equal(annotated[0]!.failCount, 1);
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

    const byState = new Map<string, number>();
    for (const config of coverage.configs) {
        byState.set(config.state, (byState.get(config.state) ?? 0) + 1);
    }
    // The three states that look alike in a failure-only view, all present on
    // one test: a Windows-only crash-reporter test.
    assert.deepEqual(Object.fromEntries([...byState].sort()), {
        intermittent: 5,
        'never-scheduled': 20,
        ok: 4,
        skipped: 13,
    });
    assert.equal(coverage.neverScheduled?.length, 20);

    // The skipped rows carry the reason, which is what makes them actionable.
    const android = coverage.configs.find((config) => config.jobName.includes('android'));
    assert.ok(android, 'the fixture should have an android config');
    assert.equal(android.state, 'skipped');
    assert.equal(android.runCount, 0);
    assert.deepEqual([...android.skipMessages.keys()], ["os == 'android'"]);
});

test('the never-scheduled universe is scoped to the suites the test runs', () => {
    // The fix for a review finding: with the universe drawn as "every config
    // in the file", a `mochitest-browser-chrome` test was reported as never
    // scheduled on 453 of 495 configs, led by `geckoview-mochitest-media`
    // variants it could never have run under. 453 of 495 is not information.
    //
    // Checked structurally rather than by pinning a count, so it stays true as
    // the fixture changes: every never-scheduled config must run a suite the
    // test itself ran, and no config running any other suite may appear.
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const coverage = coverageOf(bucket, identity.testId, {
        universe: configUniverse(bucket),
    });

    const ownSuites = new Set(
        coverage.configs
            .filter((config) => config.state !== 'never-scheduled')
            .map((config) => parseJobName(config.jobName).suite)
    );
    assert.ok(ownSuites.size > 1, 'the fixture test should span several suites');
    for (const jobName of coverage.neverScheduled!) {
        assert.ok(
            ownSuites.has(parseJobName(jobName).suite),
            `${jobName} runs a suite this test never ran, so it is not a place it could ` +
                `have been scheduled`
        );
    }

    // …and the scope is reported, not just applied. A never-scheduled count
    // with no stated comparison set is the number a reader cannot check.
    assert.deepEqual(coverage.universeSuites, [...ownSuites].sort());

    // The narrowing is real and not vacuous: the unscoped universe would have
    // produced strictly more rows.
    const unscoped = [...configUniverse(bucket)].filter(
        (jobName) => !coverage.configs.some((config) => config.jobName === jobName)
    );
    assert.ok(
        coverage.neverScheduled!.length < unscoped.length + coverage.neverScheduled!.length,
        'scoping must drop configs'
    );
    assert.ok(unscoped.length > 0, 'the fixture must contain out-of-suite configs to drop');
});

test('a config whose name has no suite cannot widen or enter the scope', () => {
    // Built by hand, and the reason is worth stating: no config in any
    // fixture, and none in five real bucket files (2,663 configs), has an
    // unparseable job name. The guard is defensive, so the only way to test it
    // is to supply the input CI does not currently produce — and two mutations
    // that removed it survived the whole suite until this existed.
    //
    // Both halves matter. A `null` suite must not become a bucket that every
    // other `null` suite matches (which would put unrelated configs in scope),
    // and it must not be treated as matching everything (same effect, opposite
    // spelling).
    const file = decodeDaily({
        metadata: {
            date: '2026-08-03',
            startTime: 0,
            jobCount: 1,
            processedJobCount: 1,
            invalidJobCount: 0,
        },
        tables: {
            // Index 0 is the test's own config. Index 1 parses to a suite, and
            // is the control: it is out of scope for an ordinary reason. Index
            // 2 and 3 have no `/` at all, so `parseJobName` gives them a null
            // suite.
            jobNames: [
                'test-linux2404-64/opt-xpcshell',
                'test-linux2404-64/opt-mochitest-plain',
                'some-unparseable-name',
                'another-unparseable-name',
            ],
            testPaths: ['a/b'],
            testNames: ['test_x.js'],
            repositories: ['mozilla-central'],
            taskIds: ['AAA.0'],
            components: ['Core :: X'],
            commitIds: ['abc'],
            statuses: ['PASS'],
            messages: [],
            crashSignatures: [],
        },
        taskInfo: { repositoryIds: [0], jobNameIds: [0], commitIds: [0] },
        testInfo: { testPathIds: [0], testNameIds: [0], componentIds: [0] },
        testRuns: [[{ taskIdIds: [0], durations: [1], timestamps: [0], messageIds: [null] }]],
    } as unknown as DailyFile);

    const coverage = coverageOf(file, 0, {
        universe: [
            'test-linux2404-64/opt-mochitest-plain',
            'some-unparseable-name',
            'another-unparseable-name',
        ],
    });

    // The test ran only `xpcshell`, so that is the whole scope. An
    // unparseable name contributes no suite to it.
    assert.deepEqual(coverage.universeSuites, ['xpcshell']);
    // And nothing out of scope is reported missing — neither the config with a
    // different real suite nor either unparseable one.
    assert.deepEqual(coverage.neverScheduled, []);
});

test('an unparseable config in scope does not drag in its unparseable peers', () => {
    // The other direction of the same guard: when the test *itself* ran on a
    // config with no parseable suite, that config's `null` must not become a
    // key matching every other unparseable config in the file.
    const file = decodeDaily({
        metadata: {
            date: '2026-08-03',
            startTime: 0,
            jobCount: 1,
            processedJobCount: 1,
            invalidJobCount: 0,
        },
        tables: {
            jobNames: ['unparseable-one', 'unparseable-two'],
            testPaths: ['a/b'],
            testNames: ['test_x.js'],
            repositories: ['mozilla-central'],
            taskIds: ['AAA.0'],
            components: ['Core :: X'],
            commitIds: ['abc'],
            statuses: ['PASS'],
            messages: [],
            crashSignatures: [],
        },
        taskInfo: { repositoryIds: [0], jobNameIds: [0], commitIds: [0] },
        testInfo: { testPathIds: [0], testNameIds: [0], componentIds: [0] },
        testRuns: [[{ taskIdIds: [0], durations: [1], timestamps: [0], messageIds: [null] }]],
    } as unknown as DailyFile);

    const coverage = coverageOf(file, 0, {
        universe: ['unparseable-one', 'unparseable-two'],
    });
    assert.deepEqual(coverage.universeSuites, [], 'a null suite is not a scope entry');
    assert.deepEqual(
        coverage.neverScheduled,
        [],
        'unparseable-two is not "missing" merely because it is also unparseable'
    );
});

test('a never-scheduled name keeps the suite half a reader needs', () => {
    // The names exist so someone can act on them, and the actionable half is
    // the suite: `test-macosx1500-aarch64` alone does not say what did not run
    // there. A mutation truncating them at the slash survived the suite.
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const coverage = coverageOf(bucket, identity.testId, {
        universe: configUniverse(bucket),
    });
    assert.ok(coverage.neverScheduled!.length > 0);
    for (const jobName of coverage.neverScheduled!) {
        assert.ok(
            jobName.includes('/'),
            `${jobName} lost its suite, so it does not say what failed to run`
        );
        assert.notEqual(parseJobName(jobName).suite, null);
    }
    // The rollup carries the same full names, not a truncated copy.
    for (const gap of coverageGaps(coverage)) {
        for (const jobName of gap.neverConfigs) {
            assert.ok(coverage.neverScheduled!.includes(jobName));
        }
    }
});

test('universeSuites is empty when no universe was supplied', () => {
    // Symmetric with `neverScheduled: null`. Reporting suites for a comparison
    // that was never made would name a scope for a number that does not exist.
    const identity = bucket.findTest(WINDOWS_TEST)!;
    assert.deepEqual(coverageOf(bucket, identity.testId).universeSuites, []);
});

test('coverageGaps separates ran, scheduled-but-skipped and never-scheduled', () => {
    // The three cannot be folded together. A platform where every config was
    // scheduled and skipped is not covered — but it is also not a platform CI
    // declines to schedule, and only one of those is someone's `skip-if` to
    // fix.
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const coverage = coverageOf(bucket, identity.testId, {
        universe: configUniverse(bucket),
    });
    const gaps = coverageGaps(coverage);

    // Every config in the matrix lands in exactly one bucket of exactly one
    // platform: the rollup may not lose or duplicate a row.
    const total = gaps.reduce(
        (sum, gap) => sum + gap.ranCount + gap.skippedCount + gap.neverCount,
        0
    );
    assert.equal(total, coverage.configs.length);
    assert.equal(
        gaps.reduce((sum, gap) => sum + gap.neverConfigs.length, 0),
        coverage.neverScheduled!.length
    );

    // A Windows-only test: windows is where it ran, and the android configs
    // were scheduled and skipped rather than never scheduled.
    const windows = gaps.find((gap) => gap.platform === 'windows')!;
    assert.ok(windows.ranCount > 0, 'it runs on windows');
    const android = gaps.find((gap) => gap.platform === 'android')!;
    assert.equal(android.ranCount, 0, 'it never ran on android');
    assert.ok(
        android.skippedCount > 0,
        'android scheduled it and skipped it, which is not the same as never scheduling it'
    );
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

test('a config that never passed is perma-fail, not intermittent', () => {
    // The highest-signal thing the matrix says: a config where the test ran
    // and *never* passed is broken there, not flaky there, and `CLI.md`'s try
    // triage keys its top section ("these are almost certainly yours") on the
    // distinction. Collapsing the two would put a perma-fail in the same
    // bucket as a 1-in-400 intermittent.
    const permaFails: { test: string; jobName: string; runCount: number }[] = [];
    let intermittent = 0;
    for (let testId = 0; testId < daily.testCount; testId++) {
        for (const config of coverageOf(daily, testId).configs) {
            if (config.state === 'perma-fail') {
                permaFails.push({
                    test: daily.testAt(testId).fullPath,
                    jobName: config.jobName,
                    runCount: config.runCount,
                });
                // The defining property: it ran, and not one run passed.
                assert.ok(config.runCount > 0);
                assert.equal(config.passCount, 0);
                assert.equal(
                    config.failCount + config.timeoutCount + config.crashCount,
                    config.runCount
                );
            }
            if (config.state === 'intermittent') {
                // The contrast: it ran, failed at least once, and passed at
                // least once.
                assert.ok(config.passCount > 0);
                assert.ok(config.failCount + config.timeoutCount + config.crashCount > 0);
                intermittent += 1;
            }
        }
    }

    // Hand-checked against the fixture. Note the failure modes differ — two
    // crashed every run, one failed, one timed out — so the state is about
    // never passing rather than about any single non-passing status.
    assert.deepEqual(permaFails, [
        {
            test: 'toolkit/components/extensions/test/xpcshell/test_ext_background_early_shutdown.js',
            jobName: 'test-linux2404-64-ccov/opt-xpcshell',
            runCount: 2,
        },
        {
            test: 'toolkit/components/extensions/test/xpcshell/test_ext_background_early_shutdown.js',
            jobName: 'test-linux2404-64-ccov/opt-xpcshell-nofis',
            runCount: 2,
        },
        {
            test: 'toolkit/components/extensions/test/xpcshell/test_ext_dnr_dynamic_rules.js',
            jobName: 'test-linux2404-64-shippable/opt-xpcshell-nofis',
            runCount: 1,
        },
        {
            test: 'toolkit/components/extensions/test/xpcshell/test_ext_downloads_cookies.js',
            jobName: 'test-windows11-32-25h2-shippable/opt-xpcshell',
            runCount: 1,
        },
    ]);
    assert.equal(intermittent, 51, 'the two states must stay distinct, not merge');
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
    // A concrete count, not `>= 0`: the two states have to be distinguished
    // from each other, so asserting only the interesting one would still pass
    // if every `skip-if` row were relabelled.
    assert.equal(skipped, 50, 'the daily fixture has 50 genuinely disabled configs');

    // The aggregates cannot produce the state at all, because the generator
    // already filtered those rows out — and they still have skipped rows, so
    // the absence is about `run-if` and not about skips in general.
    let aggregateSkipped = 0;
    for (let testId = 0; testId < bucket.testCount; testId++) {
        for (const config of coverageOf(bucket, testId).configs) {
            assert.notEqual(config.state, 'not-applicable');
            if (config.state === 'skipped') {
                aggregateSkipped += 1;
            }
        }
    }
    assert.equal(aggregateSkipped, 25);
});

test('a config with both a skip-if and a run-if reads as disabled', () => {
    // The precedence rule inside `stateOf`. No row in the real data has both
    // annotations at once — a config either scopes the test out or disables
    // it — so this is built by hand rather than found: it is reachable by the
    // format and would be mislabelled if the `skipCount === 0` guard were
    // dropped, reporting a disabled config as merely "scoped elsewhere".
    //
    // A `skip-if` is work someone owes and a `run-if` is the annotation
    // working, so when both are present the reportable one has to win.
    const synthetic = decodeDaily({
        metadata: {
            date: '2026-08-03',
            startTime: 0,
            generatedAt: '',
            jobCount: 1,
            processedJobCount: 1,
            invalidJobCount: 0,
        },
        tables: {
            jobNames: ['test-linux2404-64/opt-xpcshell'],
            testPaths: ['a/b'],
            testNames: ['test_x.js'],
            repositories: ['mozilla-central'],
            taskIds: ['AAA.0', 'BBB.0'],
            components: ['Core :: X'],
            commitIds: ['abc'],
            statuses: ['SKIP'],
            messages: ["skip-if: os == 'linux'", "run-if: os == 'win'"],
            crashSignatures: [],
        },
        taskInfo: { repositoryIds: [0, 0], jobNameIds: [0, 0], commitIds: [0, 0] },
        testInfo: { testPathIds: [0], testNameIds: [0], componentIds: [0] },
        testRuns: [
            [
                {
                    taskIdIds: [0, 1],
                    durations: [0, 0],
                    timestamps: [0, 0],
                    messageIds: [0, 1],
                },
            ],
        ],
    } as unknown as DailyFile);

    const [row] = coverageOf(synthetic, 0).configs;
    assert.ok(row);
    // Both annotations landed on the one config, which is what makes the
    // precedence question live rather than hypothetical.
    assert.equal(row.skipCount, 1);
    assert.equal(row.runIfSkipCount, 1);
    assert.equal(row.runCount, 0);
    assert.equal(row.state, 'skipped', 'a reportable skip outranks a run-if');

    // With the `skip-if` removed the same row is correctly not-applicable, so
    // the assertion above is about precedence and not about the state being
    // unreachable.
    const runIfOnly = decodeDaily({
        metadata: {
            date: '2026-08-03',
            startTime: 0,
            generatedAt: '',
            jobCount: 1,
            processedJobCount: 1,
            invalidJobCount: 0,
        },
        tables: {
            jobNames: ['test-linux2404-64/opt-xpcshell'],
            testPaths: ['a/b'],
            testNames: ['test_x.js'],
            repositories: ['mozilla-central'],
            taskIds: ['AAA.0'],
            components: ['Core :: X'],
            commitIds: ['abc'],
            statuses: ['SKIP'],
            messages: ["run-if: os == 'win'"],
            crashSignatures: [],
        },
        taskInfo: { repositoryIds: [0], jobNameIds: [0], commitIds: [0] },
        testInfo: { testPathIds: [0], testNameIds: [0], componentIds: [0] },
        testRuns: [[{ taskIdIds: [0], durations: [0], timestamps: [0], messageIds: [0] }]],
    } as unknown as DailyFile);
    assert.equal(coverageOf(runIfOnly, 0).configs[0]!.state, 'not-applicable');
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

test('a period with no runs reports null rates, not 0%', () => {
    // "No data" and "0% failures" are different claims, and the second is the
    // one that reads as good news. A day on which CI did not run — a closed
    // tree, an outage — produces zero denominators; none of the 199 real dates
    // in the fixture does, so the case is built rather than found.
    const empty: StatsFile = {
        metadata: { generatedAt: '', harness: 'xpcshell' },
        dates: ['2026-08-01', '2026-08-02'],
        totalTestRuns: [0, 0],
        failedTestRuns: [0, 0],
        skippedTestRuns: [0, 0],
        processedJobCount: [0, 0],
        failedJobs: [0, 0],
        ignoredJobs: [0, 0],
        invalidJobs: [0, 0],
        markerCounts: {},
    };
    const summary = computeSummary(empty, { days: 1 });
    assert.equal(summary.current.testFailureRate, null);
    assert.equal(summary.current.jobFailureRate, null);
    assert.equal(summary.current.skipRate, null);
    assert.equal(summary.current.invalidJobRate, null);
    // Explicitly not zero: `0` would print as "0.00%", which claims the tree
    // was green on a day nothing ran.
    assert.notEqual(summary.current.testFailureRate, 0);
    assert.notEqual(summary.current.jobFailureRate, 0);

    // A null on either side makes the delta unknown rather than a swing from
    // or to zero.
    assert.deepEqual(summary.delta, {
        testFailureRate: null,
        jobFailureRate: null,
        skipRate: null,
        invalidJobRate: null,
    });

    // The counters themselves are still reported, so a caller can tell an
    // empty period from a missing one.
    assert.equal(summary.current.totalTestRuns, 0);
    assert.equal(summary.current.dayCount, 1);

    // And the real file, whose denominators are all non-zero, yields numbers
    // rather than nulls — so the nulls above are the zero-denominator path and
    // not a rate that never computes.
    const real = computeSummary(xpcshellStats);
    assert.notEqual(real.current.testFailureRate, null);
    assert.notEqual(real.current.jobFailureRate, null);
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
