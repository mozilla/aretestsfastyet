/**
 * The decoders, against the checked-in fixtures.
 *
 * Three kinds of assertion, in increasing order of what they would catch:
 *
 * 1. **Hand-checked totals.** Per-status run totals for every fixture, written
 *    out as literals. Computed independently of the decoder and re-derivable
 *    by hand from the raw JSON, so they fail if the decoder's counting rule
 *    changes for any shape.
 * 2. **Cross-file agreement.** The 21-day `issues` and `issues-with-taskids`
 *    files cover the same runs in different shapes, so their totals must
 *    match. The bucket file covers the same days for the tests it holds. This
 *    is the check that a shape is being *counted* right rather than merely
 *    parsed, because the two shapes have nothing in common to copy an error
 *    from.
 * 3. **Invariants over every entry.** `taskIds.length === count` wherever
 *    task IDs are present, days in range, and so on — asserted over every
 *    entry of every group of every fixture rather than on a sampled one.
 */

import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeBucket, bucketIndexForPath, bucketFileSuffix } from '../lib/formats/buckets.ts';
import { decodeDaily } from '../lib/formats/daily.ts';
import { decodeIssues, decodeIssuesWithTaskIds } from '../lib/formats/issues.ts';
import { decodeResourceJobs, indexResourceJobsByTaskId } from '../lib/formats/resources.ts';
import { flavorNames, markerKinds, statsRowForDate, statsRows } from '../lib/formats/stats.ts';
import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import {
    UnknownStatusGroupShapeError,
    iterateStatusGroup,
    statusGroupShape,
    totalRuns,
} from '../lib/formats/status-entries.ts';
import type { StatusGroup } from '../lib/formats/status-group.ts';
import { normalizeTaskId, parseTaskId } from '../lib/formats/tables.ts';
import { countsAsSkip } from '../lib/model/skips.ts';
import type { BucketFile } from '../lib/formats/buckets.ts';
import type { DailyFile } from '../lib/formats/daily.ts';
import type { IssuesFile, IssuesWithTaskIdsFile } from '../lib/formats/issues.ts';
import type { ResourcesFile } from '../lib/formats/resources.ts';
import type { StatsFile } from '../lib/formats/stats.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

async function fixture<T>(name: string): Promise<T> {
    return JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8')) as T;
}

const xpcshellBucket = await fixture<BucketFile>('xpcshell-00.json');
const mochitestBucket = await fixture<BucketFile>('mochitest-00.json');
const xpcshellIssues = await fixture<IssuesFile>('xpcshell-issues.json');
const xpcshellIssuesWithTaskIds = await fixture<IssuesWithTaskIdsFile>(
    'xpcshell-issues-with-taskids.json'
);
const xpcshellDaily = await fixture<DailyFile>('xpcshell-2026-08-03.json');
const xpcshellStats = await fixture<StatsFile>('xpcshell-stats.json');
const mochitestStats = await fixture<StatsFile>('mochitest-stats.json');
const xpcshellResources = await fixture<ResourcesFile>('xpcshell-2026-08-03-resources.json');

/** Totals runs per status over every test in a decoded file. */
function totalsByStatus(file: DecodedTimingFile): Record<string, number> {
    const totals = new Map<string, number>();
    for (let testId = 0; testId < file.testCount; testId++) {
        for (const [status, count] of file.totalsByStatus(testId)) {
            totals.set(status, (totals.get(status) ?? 0) + count);
        }
    }
    return Object.fromEntries([...totals].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The same totals, but by walking every decoded entry rather than by
 * `totalRuns()`.
 *
 * The two paths are independent — one sums each entry's `count`, the other
 * sums the raw arrays' lengths without decoding — so agreeing is evidence
 * about the iterator and not just about one shared helper.
 */
function totalsByStatusViaEntries(file: DecodedTimingFile): Record<string, number> {
    const totals = new Map<string, number>();
    for (let testId = 0; testId < file.testCount; testId++) {
        for (const entry of file.runsOfTest(testId)) {
            totals.set(entry.status, (totals.get(entry.status) ?? 0) + entry.count);
        }
    }
    return Object.fromEntries([...totals].sort(([a], [b]) => a.localeCompare(b)));
}

// --- hand-checked totals -------------------------------------------------

test('xpcshell bucket totals match the hand-checked values', () => {
    const decoded = decodeBucket(xpcshellBucket);
    // Derived from the raw JSON: `durations` groups sum bucket lengths,
    // `counts` groups sum counts, `task-ids` groups sum bucket lengths. The
    // three shapes are all exercised here, which is why this file is the
    // primary golden.
    assert.deepEqual(totalsByStatus(decoded), {
        CRASH: 24,
        FAIL: 2,
        'FAIL-PARALLEL': 27,
        'FAIL-SEQUENTIAL': 7,
        PASS: 2196,
        'PASS-PARALLEL': 120814,
        'PASS-SEQUENTIAL': 9218,
        SKIP: 11444,
        'TIMEOUT-PARALLEL': 5,
        'TIMEOUT-SEQUENTIAL': 2,
    });
    assert.deepEqual(totalsByStatusViaEntries(decoded), totalsByStatus(decoded));
});

test('mochitest bucket totals match the hand-checked values', () => {
    const decoded = decodeBucket(mochitestBucket);
    assert.deepEqual(totalsByStatus(decoded), {
        CRASH: 2,
        FAIL: 44,
        PASS: 75280,
        SKIP: 7099,
        TIMEOUT: 4,
    });
    assert.deepEqual(totalsByStatusViaEntries(decoded), totalsByStatus(decoded));
});

test('xpcshell issues totals match the hand-checked values', () => {
    const decoded = decodeIssues(xpcshellIssues);
    assert.deepEqual(totalsByStatus(decoded), {
        CRASH: 318,
        'EXPECTED-FAIL': 4973,
        FAIL: 8,
        'FAIL-PARALLEL': 1539,
        'FAIL-SEQUENTIAL': 10,
        PASS: 1480,
        'PASS-PARALLEL': 101163,
        'PASS-SEQUENTIAL': 10340,
        SKIP: 17787,
        TIMEOUT: 14,
        'TIMEOUT-PARALLEL': 1615,
        'TIMEOUT-SEQUENTIAL': 18,
    });
    assert.deepEqual(totalsByStatusViaEntries(decoded), totalsByStatus(decoded));
});

test('xpcshell daily totals match the hand-checked values', () => {
    const decoded = decodeDaily(xpcshellDaily);
    // Every group here is flat: one entry per run, so each total is also the
    // number of entries in the group.
    assert.deepEqual(totalsByStatus(decoded), {
        CRASH: 25,
        'EXPECTED-FAIL': 164,
        FAIL: 2,
        'FAIL-PARALLEL': 41,
        'FAIL-SEQUENTIAL': 3,
        PASS: 173,
        'PASS-PARALLEL': 3807,
        'PASS-SEQUENTIAL': 349,
        SKIP: 2912,
        TIMEOUT: 6,
        'TIMEOUT-PARALLEL': 74,
        'TIMEOUT-SEQUENTIAL': 2,
    });
    assert.deepEqual(totalsByStatusViaEntries(decoded), totalsByStatus(decoded));
});

// --- cross-file agreement ------------------------------------------------

test('issues and issues-with-taskids agree on every status total', () => {
    // The same 21 days in two shapes: `counts` throughout on one side,
    // `task-ids` for everything non-passing on the other. If the `task-ids`
    // counting rule were wrong — summing bucket *entries* instead of the task
    // IDs in them, say — these would diverge on exactly the statuses that
    // changed shape, and agree on the pass-like ones that did not.
    assert.deepEqual(
        totalsByStatus(decodeIssuesWithTaskIds(xpcshellIssuesWithTaskIds)),
        totalsByStatus(decodeIssues(xpcshellIssues))
    );
});

test('issues and issues-with-taskids agree per test, not merely in total', () => {
    const issues = decodeIssues(xpcshellIssues);
    const withTaskIds = decodeIssuesWithTaskIds(xpcshellIssuesWithTaskIds);
    assert.equal(issues.testCount, withTaskIds.testCount);
    for (let testId = 0; testId < issues.testCount; testId++) {
        const a = issues.testAt(testId);
        const b = withTaskIds.testAt(testId);
        assert.equal(a.fullPath, b.fullPath, `test ${testId} differs between the two files`);
        assert.deepEqual(
            Object.fromEntries(withTaskIds.totalsByStatus(testId)),
            Object.fromEntries(issues.totalsByStatus(testId)),
            `${a.fullPath} differs between issues and issues-with-taskids`
        );
    }
});

test('the daily file agrees with the last day of the 21-day aggregate', () => {
    // The check `PLAN.md` §3 asks for: "assert the daily and 21-day files
    // agree on the same test's counts". The daily file covers 2026-08-03,
    // which is day 20 of the aggregate's 21, so filtering the aggregate to
    // `day === 20` must reproduce the daily file's totals for a shared test.
    //
    // This is the strongest cross-shape check available. The daily file counts
    // one entry per run in the `flat` shape and the aggregate counts buckets
    // in the `counts` shape, so an error in either counting rule shows up
    // here — the two have nothing in common to copy a mistake from.
    //
    // The bucket fixture is not usable for this: it was cut from bucket 00
    // and the daily fixture from whichever tests carried each status, so they
    // share no tests at all. The issues fixture shares eight.
    const daily = decodeDaily(xpcshellDaily);
    const aggregate = decodeIssues(xpcshellIssues);
    assert.equal(aggregate.days, 21);
    assert.equal(daily.endDate, '2026-08-03');
    assert.equal(aggregate.endDate, '2026-08-03');
    const lastDay = aggregate.days! - 1;

    let compared = 0;
    for (let testId = 0; testId < daily.testCount; testId++) {
        const { fullPath } = daily.testAt(testId);
        const inAggregate = aggregate.findTest(fullPath);
        if (!inAggregate) {
            continue;
        }
        compared += 1;

        const aggregateLastDay = new Map<string, number>();
        for (const entry of aggregate.runsOfTest(inAggregate.testId)) {
            if (entry.day === lastDay) {
                aggregateLastDay.set(
                    entry.status,
                    (aggregateLastDay.get(entry.status) ?? 0) + entry.count
                );
            }
        }

        // The one status the two families do *not* agree on, and the reason is
        // upstream rather than in this decoder: the aggregates drop `run-if`
        // skips and the daily files keep them. See the test below, which
        // measures it. Comparing the daily file's non-`run-if` skips is
        // therefore the like-for-like comparison.
        const dailyTotals = new Map(daily.totalsByStatus(testId));
        if (dailyTotals.has('SKIP')) {
            let reportable = 0;
            for (const entry of daily.runsOfTest(testId)) {
                if (entry.status === 'SKIP' && countsAsSkip(entry.message)) {
                    reportable += entry.count;
                }
            }
            dailyTotals.set('SKIP', reportable);
        }

        // Every status is compared, and all but a handful of runs match
        // exactly. The tolerance is for an upstream discrepancy rather than a
        // decoding one: on `test_ext_background_early_shutdown.js` the daily
        // file's raw `PASS-SEQUENTIAL` group has 125 entries while the
        // aggregate's day-20 counts sum to 126. That is visible in the raw
        // JSON before any decoding, so the two published files genuinely
        // disagree by one run — presumably a job landing either side of the
        // aggregation boundary.
        //
        // Asserting exact equality would make this test a detector for an
        // upstream off-by-one it cannot fix; asserting nothing would let a
        // real counting bug through. Allowing one run per (test, status) keeps
        // the check tight — a shape counted wrongly is out by a factor, not
        // by one.
        const statuses = new Set([...dailyTotals.keys(), ...aggregateLastDay.keys()]);
        for (const status of statuses) {
            const fromDaily = dailyTotals.get(status) ?? 0;
            const fromAggregate = aggregateLastDay.get(status) ?? 0;
            assert.ok(
                Math.abs(fromDaily - fromAggregate) <= 1,
                `${fullPath} ${status}: daily says ${fromDaily}, ` +
                    `day ${lastDay} of the aggregate says ${fromAggregate}`
            );
        }
    }
    assert.ok(compared >= 8, `only ${compared} tests appear in both fixtures`);
});

test('every daily/aggregate disagreement is +1 PASS-SEQUENTIAL in the aggregate', () => {
    // The companion to the per-status check above. A tolerance of ±1 applied
    // per (test, status) would hide a systematic one-off if it applied
    // everywhere, so this pins down *which* pairs disagree and by how much.
    //
    // The answer is narrow and one-sided: three of the eight shared tests
    // report exactly one more `PASS-SEQUENTIAL` run in the aggregate than in
    // the daily file, and nothing else disagrees at all. Every other status on
    // every shared test — including the `task-ids` and `durations` shapes,
    // which are counted completely differently — matches exactly.
    //
    // One-sided and confined to one status is what makes this an upstream
    // property rather than a decoder bug: a counting error in this library
    // would not know what `PASS-SEQUENTIAL` is, and would not be off by
    // exactly one in only one direction.
    const daily = decodeDaily(xpcshellDaily);
    const aggregate = decodeIssues(xpcshellIssues);
    const lastDay = aggregate.days! - 1;
    const disagreements: [string, string, number][] = [];

    for (let testId = 0; testId < daily.testCount; testId++) {
        const { fullPath } = daily.testAt(testId);
        const inAggregate = aggregate.findTest(fullPath);
        if (!inAggregate) {
            continue;
        }
        for (const status of daily.statuses) {
            if (status === 'SKIP') {
                // Filtered upstream; covered by its own test.
                continue;
            }
            let fromDaily = 0;
            for (const entry of daily.runsOfTest(testId)) {
                if (entry.status === status) {
                    fromDaily += entry.count;
                }
            }
            let fromAggregate = 0;
            for (const entry of aggregate.runsOfTest(inAggregate.testId)) {
                if (entry.status === status && entry.day === lastDay) {
                    fromAggregate += entry.count;
                }
            }
            if (fromDaily !== fromAggregate) {
                disagreements.push([fullPath, status, fromAggregate - fromDaily]);
            }
        }
    }

    assert.deepEqual(
        disagreements.map(([, status, delta]) => `${status}${delta >= 0 ? '+' : ''}${delta}`),
        ['PASS-SEQUENTIAL+1', 'PASS-SEQUENTIAL+1', 'PASS-SEQUENTIAL+1'],
        `unexpected daily/aggregate disagreements: ${JSON.stringify(disagreements)}`
    );
});

test('the 21-day aggregates drop run-if skips; the daily files keep them', () => {
    // Not in `FORMATS.md`, and found by the cross-file check above failing on
    // SKIP while agreeing exactly on every other status.
    //
    // For `test_ext_geckoProfiler_control.js` on 2026-08-03 the daily file
    // records 504 skips — 266 `run-if: os == 'android'`, 202
    // `skip-if: os == 'android'`, 36 `skip-if: tsan` — and the aggregate
    // records 238 for the same day, which is exactly the two `skip-if` groups.
    // So the generator applies the `run-if` filter when it aggregates.
    //
    // The consequence for a caller is the point: a skip count taken from a
    // bucket file is **already** filtered, and applying `countsAsSkip()` to it
    // again is a no-op, while the same count taken from a daily file is not
    // and needs the filter. Getting this backwards inflates a daily skip count
    // by however many platform-scoped tests there are — here, by 2.1×.
    for (const [name, file] of [
        ['xpcshell-issues.json', xpcshellIssues],
        ['xpcshell-issues-with-taskids.json', xpcshellIssuesWithTaskIds],
        ['xpcshell-00.json', xpcshellBucket],
        ['mochitest-00.json', mochitestBucket],
    ] as const) {
        const runIf = file.tables.messages.filter((m) => m?.startsWith('run-if'));
        assert.deepEqual(runIf, [], `${name} unexpectedly interns a run-if message`);
    }
    // The daily file does carry them, so this is a difference between the
    // families and not simply an artefact of the fixture being small.
    assert.ok(
        xpcshellDaily.tables.messages.some((m) => m?.startsWith('run-if')),
        'the daily fixture should still carry run-if messages'
    );

    const daily = decodeDaily(xpcshellDaily);
    let runIfSkips = 0;
    let otherSkips = 0;
    for (let testId = 0; testId < daily.testCount; testId++) {
        for (const entry of daily.runsOfTest(testId)) {
            if (entry.status !== 'SKIP') {
                continue;
            }
            if (countsAsSkip(entry.message)) {
                otherSkips += entry.count;
            } else {
                runIfSkips += entry.count;
            }
        }
    }
    assert.equal(runIfSkips, 2147);
    assert.equal(otherSkips, 765);
});

test('bucket files are only worth reading for the tests that hash to them', () => {
    // The bucket index is the generator's hash of the full path. Every test in
    // the 00 fixture must hash to 0, or a single-test query would read the
    // wrong file and report the test as never having run.
    for (const file of [xpcshellBucket, mochitestBucket]) {
        const decoded = decodeBucket(file);
        for (let testId = 0; testId < decoded.testCount; testId++) {
            const { fullPath } = decoded.testAt(testId);
            assert.equal(
                bucketIndexForPath(fullPath, file.metadata.totalBuckets),
                file.metadata.bucketIndex,
                `${fullPath} does not hash to bucket ${file.metadata.bucketIndex}`
            );
        }
    }
    assert.equal(bucketFileSuffix(0), '00');
    assert.equal(bucketFileSuffix(63), '3f');
    assert.equal(bucketFileSuffix(10), '0a');
});

// --- invariants over every entry -----------------------------------------

const timingFixtures: [string, DecodedTimingFile][] = [
    ['xpcshell-00.json', decodeBucket(xpcshellBucket)],
    ['mochitest-00.json', decodeBucket(mochitestBucket)],
    ['xpcshell-issues.json', decodeIssues(xpcshellIssues)],
    ['xpcshell-issues-with-taskids.json', decodeIssuesWithTaskIds(xpcshellIssuesWithTaskIds)],
    ['xpcshell-2026-08-03.json', decodeDaily(xpcshellDaily)],
];

for (const [name, file] of timingFixtures) {
    test(`${name}: every decoded entry is self-consistent`, () => {
        let entries = 0;
        for (let testId = 0; testId < file.testCount; testId++) {
            for (const entry of file.runsOfTest(testId)) {
                entries += 1;
                assert.ok(entry.count >= 0, `negative count in ${entry.status}`);

                if (file.days === null) {
                    assert.equal(entry.day, null, 'a daily file has no day axis');
                    assert.equal(entry.count, 1, 'a flat entry is exactly one run');
                } else {
                    assert.ok(
                        entry.day !== null && entry.day >= 0 && entry.day < file.days,
                        `day ${entry.day} outside 0..${file.days - 1}`
                    );
                }

                // Where task IDs are present they are one per run, which is
                // what makes `count` and attribution consistent.
                if (entry.taskIds !== undefined) {
                    assert.equal(
                        entry.taskIds.length,
                        entry.count,
                        `${entry.status}: ${entry.taskIds.length} task IDs for ${entry.count} runs`
                    );
                    for (const taskId of entry.taskIds) {
                        assert.match(taskId, /^[A-Za-z0-9_-]+\.\d+$/, 'timing task IDs are suffixed');
                    }
                }
                // Durations, where present, are also one per run.
                if (entry.durations !== undefined) {
                    assert.equal(entry.durations.length, entry.count);
                }
                if (entry.minidumps !== undefined) {
                    assert.equal(
                        entry.status,
                        'CRASH',
                        'minidumps appear only on CRASH groups'
                    );
                    assert.equal(entry.minidumps.length, entry.count);
                }
                if (entry.crashSignature !== undefined) {
                    assert.equal(entry.status, 'CRASH');
                }
            }
        }
        assert.ok(entries > 0, `${name} decoded no entries at all`);
    });
}

test('TIMEOUT groups yield undefined messages, FAIL groups yield null or a string', () => {
    // The constraint that forces the iterator to branch on status and not only
    // on shape: within the `task-ids` shape, FAIL* carries `messageIds` and
    // TIMEOUT*/CRASH/EXPECTED-FAIL do not. `undefined` therefore means "this
    // status records no message" and `null` means "this run recorded none",
    // and a caller filtering skips needs the difference.
    let timeouts = 0;
    let failures = 0;
    for (const [, file] of timingFixtures) {
        for (let testId = 0; testId < file.testCount; testId++) {
            for (const entry of file.runsOfTest(testId)) {
                if (entry.status.startsWith('TIMEOUT')) {
                    timeouts += 1;
                    assert.equal(
                        entry.message,
                        undefined,
                        `${entry.status} unexpectedly carried a message`
                    );
                } else if (entry.status.startsWith('FAIL')) {
                    failures += 1;
                    assert.notEqual(
                        entry.message,
                        undefined,
                        `${entry.status} carried no messageIds array`
                    );
                }
            }
        }
    }
    assert.ok(timeouts > 0 && failures > 0, 'the fixtures cover both cases');
});

test('EXPECTED-FAIL carries no message either, despite being fail-like', () => {
    // Not obvious from the name, and the reason the iterator keys off the
    // arrays present rather than off a `status.startsWith('FAIL')` test.
    const file = decodeIssuesWithTaskIds(xpcshellIssuesWithTaskIds);
    let seen = 0;
    for (let testId = 0; testId < file.testCount; testId++) {
        for (const entry of file.runsOfTest(testId)) {
            if (entry.status === 'EXPECTED-FAIL') {
                seen += 1;
                assert.equal(entry.message, undefined);
                assert.notEqual(entry.taskIds, undefined, 'it does gain task IDs');
            }
        }
    }
    assert.ok(seen > 0);
});

test('pass-like groups keep the counts shape in issues-with-taskids', () => {
    // Despite the filename. `FORMATS.md` confirms it across the whole file;
    // this asserts it on the fixture, because a decoder that assumed otherwise
    // would read a number as an array.
    const file = decodeIssuesWithTaskIds(xpcshellIssuesWithTaskIds);
    let passEntries = 0;
    for (let testId = 0; testId < file.testCount; testId++) {
        for (const entry of file.runsOfTest(testId)) {
            if (entry.status.startsWith('PASS')) {
                passEntries += 1;
                assert.equal(entry.taskIds, undefined, 'no task IDs for passing runs');
                assert.equal(entry.jobName, undefined, 'and no job attribution either');
            }
        }
    }
    assert.ok(passEntries > 0);
});

test('an empty crashSignatures table is not an error', () => {
    // 20 of 64 mochitest buckets have one (`FORMATS.md`). Decoding such a file
    // must work; only an actual index into the empty table would be a problem,
    // and there are none by construction.
    const file: BucketFile = {
        ...mochitestBucket,
        tables: { ...mochitestBucket.tables, crashSignatures: [] },
        testRuns: mochitestBucket.testRuns.map((perTest) =>
            perTest.map((group, statusId) =>
                mochitestBucket.tables.statuses[statusId] === 'CRASH' ? null : group
            )
        ),
    };
    const decoded = decodeBucket(file);
    let entries = 0;
    for (let testId = 0; testId < decoded.testCount; testId++) {
        for (const _ of decoded.runsOfTest(testId)) {
            entries += 1;
        }
    }
    assert.ok(entries > 0);
});

// --- shape detection -----------------------------------------------------

test('every declared shape is recognized, and nothing else is', () => {
    const cases: [Record<string, unknown>, string, string][] = [
        [{ taskIdIds: [1], durations: [5], timestamps: [0] }, 'PASS', 'flat'],
        [{ days: [0], counts: [3] }, 'PASS', 'counts'],
        [{ days: [0], counts: [3], jobNameIds: [0], messageIds: [null] }, 'SKIP', 'skip-counts'],
        [{ days: [0], durations: [[1, 2]], jobNameIds: [0] }, 'PASS', 'durations'],
        [{ days: [0], taskIdIds: [[1, 2]] }, 'TIMEOUT', 'task-ids'],
    ];
    for (const [group, status, shape] of cases) {
        assert.equal(statusGroupShape(group as unknown as StatusGroup, status), shape);
    }
});

test('an unrecognized shape throws instead of returning a plausible count', () => {
    // `getCountAtIndex()` (`common-test-data.js:37`) ends in
    // `else { return 1; }`, so a sixth shape becomes a wrong number rather
    // than an error. This is the behaviour `PLAN.md` §4 asks to eliminate.
    const sixthShape = { days: [0], somethingNew: [[1, 2, 3]] } as unknown as StatusGroup;
    assert.throws(
        () => statusGroupShape(sixthShape, 'FAIL'),
        (error: unknown) => {
            assert.ok(error instanceof UnknownStatusGroupShapeError);
            assert.match(error.message, /FAIL/);
            assert.match(error.message, /somethingNew/);
            return true;
        }
    );
    assert.throws(() => totalRuns(sixthShape, 'FAIL'), UnknownStatusGroupShapeError);
    assert.throws(
        () => [...iterateStatusGroup(sixthShape, 'FAIL', {})],
        UnknownStatusGroupShapeError
    );

    // A group with no arrays at all is equally unrecognized, and is the case a
    // `days`-only group would produce.
    assert.throws(
        () => statusGroupShape({ days: [0] } as unknown as StatusGroup, 'PASS'),
        UnknownStatusGroupShapeError
    );
    assert.throws(
        () => statusGroupShape({} as unknown as StatusGroup, 'PASS'),
        UnknownStatusGroupShapeError
    );
});

test('a missing table is reported as a caller error, not as a bad index', () => {
    const group = { days: [0], taskIdIds: [[0]] } as unknown as StatusGroup;
    assert.throws(
        () => [...iterateStatusGroup(group, 'TIMEOUT', {})],
        /tables\.taskIds is needed/
    );
});

// --- timestamps ----------------------------------------------------------

test('daily timestamps decode to absolute seconds inside the file’s day', () => {
    const file = decodeDaily(xpcshellDaily);
    const { startTime } = xpcshellDaily.metadata;
    let seen = 0;
    for (let testId = 0; testId < file.testCount; testId++) {
        for (const entry of file.runsOfTest(testId)) {
            assert.ok(entry.timestamps !== undefined, 'daily entries carry a timestamp');
            const [timestamp] = entry.timestamps;
            assert.ok(timestamp !== undefined);
            seen += 1;
            assert.ok(
                timestamp >= startTime,
                `timestamp ${timestamp} precedes the day's start ${startTime}`
            );
            // Runs can start on the previous day and be recorded here, so the
            // upper bound is generous — the point is that the deltas were
            // accumulated rather than read as absolute values, which would put
            // them within a few thousand seconds of zero.
            assert.ok(timestamp < startTime + 3 * 86400, `timestamp ${timestamp} is far too late`);
        }
    }
    assert.ok(seen > 0);
});

test('timestamps are monotonic within a status group', () => {
    // They are stored as non-negative deltas in run order, so the decoded
    // values must be non-decreasing. A decoder that reset its running total
    // per entry would still pass the range check above but fail this.
    const file = decodeDaily(xpcshellDaily);
    for (let testId = 0; testId < file.testCount; testId++) {
        let previousStatus = '';
        let previous = -Infinity;
        for (const entry of file.runsOfTest(testId)) {
            if (entry.status !== previousStatus) {
                previousStatus = entry.status;
                previous = -Infinity;
            }
            const [timestamp] = entry.timestamps ?? [];
            assert.ok(timestamp !== undefined);
            assert.ok(timestamp >= previous, `timestamps went backwards in ${entry.status}`);
            previous = timestamp;
        }
    }
});

// --- task IDs ------------------------------------------------------------

test('task IDs parse under both conventions', () => {
    assert.deepEqual(parseTaskId('abc-123.0'), { taskId: 'abc-123', retryId: 0 });
    assert.deepEqual(parseTaskId('abc-123.2'), { taskId: 'abc-123', retryId: 2 });
    // The resource files' convention: no suffix means run 0.
    assert.deepEqual(parseTaskId('abc-123'), { taskId: 'abc-123', retryId: 0 });
    // Not a retry, so not stripped.
    assert.deepEqual(parseTaskId('abc.def'), { taskId: 'abc.def', retryId: 0 });
    assert.equal(normalizeTaskId('abc-123'), 'abc-123.0');
    assert.equal(normalizeTaskId('abc-123.0'), 'abc-123.0');
    assert.equal(normalizeTaskId('abc-123.3'), 'abc-123.3');
});

test('resource-file task IDs normalize to the timing files’ form', () => {
    // `FORMATS.md`: no resource entry ends in `.0`, and 0.5-5% carry a
    // non-zero suffix. So a textual join fails on most rows and this
    // normalization is what makes it work.
    const jobs = decodeResourceJobs(xpcshellResources, xpcshellDaily.metadata.startTime);
    assert.ok(jobs.length > 0);
    let bare = 0;
    let suffixed = 0;
    for (const job of jobs) {
        assert.match(job.taskId, /^[A-Za-z0-9_-]+\.\d+$/);
        assert.doesNotMatch(job.rawTaskId, /\.0$/, 'the file never writes `.0`');
        if (job.rawTaskId.includes('.')) {
            suffixed += 1;
        } else {
            bare += 1;
            assert.ok(job.taskId.endsWith('.0'));
        }
    }
    assert.ok(bare > 0, 'the fixture has bare task IDs');
    assert.ok(bare > suffixed, 'and they are the majority, as measured');
});

test('resource start times decode to absolute seconds and are monotonic', () => {
    const start = xpcshellDaily.metadata.startTime;
    const jobs = decodeResourceJobs(xpcshellResources, start);
    let previous = -Infinity;
    for (const job of jobs) {
        assert.ok(job.startTime >= start);
        assert.ok(job.startTime >= previous, 'start times are stored in order');
        previous = job.startTime;
        assert.equal(job.cpuBuckets.length, 10, 'always exactly ten CPU buckets');
        assert.ok(job.machine.logicalCPUs > 0);
    }
    const byTaskId = indexResourceJobsByTaskId(xpcshellResources, start);
    assert.equal(byTaskId.size, jobs.length, 'task IDs are unique within a resources file');
});

// --- stats ---------------------------------------------------------------

test('stats transposes into one row per date', () => {
    const rows = statsRows(xpcshellStats);
    assert.equal(rows.length, xpcshellStats.dates.length);
    assert.equal(rows[0]!.date, xpcshellStats.dates[0]);
    assert.equal(rows[0]!.totalTestRuns, xpcshellStats.totalTestRuns[0]);
    const last = rows.at(-1)!;
    assert.equal(statsRowForDate(xpcshellStats, last.date)?.totalTestRuns, last.totalTestRuns);
    assert.equal(statsRowForDate(xpcshellStats, '1999-01-01'), null);
});

test('flavors are mochitest-only and marker kinds differ by harness', () => {
    assert.deepEqual(flavorNames(xpcshellStats), [], 'xpcshell has no flavors');
    assert.ok(flavorNames(mochitestStats).length > 0);
    // `TSan Error` comes from instrumented builds, which only mochitest has.
    assert.ok(markerKinds(mochitestStats).includes('TSan Error'));
    assert.ok(!markerKinds(xpcshellStats).includes('TSan Error'));
    // The kinds are read from the file rather than hardcoded, so both should
    // agree with `metadata.markerCounts`' keys — which is where they come from.
    for (const stats of [xpcshellStats, mochitestStats]) {
        for (const kind of markerKinds(stats)) {
            assert.equal(stats.markerCounts[kind]?.length, stats.dates.length);
        }
    }
});

test('stats reaches beyond the 21-day window', () => {
    // This is what makes `fx-tests summary` cheap: it is the only file with
    // real history, so a long-run trend needs no other fetch.
    assert.ok(xpcshellStats.dates.length > 21 || mochitestStats.dates.length > 21);
});
