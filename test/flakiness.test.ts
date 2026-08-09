/**
 * `lib/query/flakiness.ts`, against the checked-in fixtures and hand-built
 * inputs.
 *
 * The golden values here are derived by **summing the raw fixture JSON** in the
 * test itself, not by reading them off the implementation. `page-migration-pattern`
 * records four occurrences of a test that took its expected value from the thing
 * under test — it shipped a wrong digit once and pinned a bug as correct twice —
 * so the per-day counts below are recomputed from `testRuns` by a second,
 * deliberately dumber walk that decodes the day deltas inline.
 *
 * What these tests are defending:
 *
 * 1. **The per-day split.** The classification is the whole point of the page,
 *    and the day axis is delta-encoded, so an off-by-one puts every failure on
 *    the wrong date. The independent walk below catches that.
 * 2. **Precedence between the three states.** flaky beats skipped beats stable
 *    is a stated definition, and each of the three orderings is asserted on a
 *    hand-built test that exercises exactly one of them.
 * 3. **The noise filter's denominator.** A neutralised failure becomes a pass
 *    rather than disappearing. Dropping it instead would shrink `total` on the
 *    days the filter fires, which is the subtle version of this bug.
 * 4. **Subtree sums.** A folder's counts are its whole subtree's, so a parent
 *    must equal the sum of its children plus its own direct tests. A table that
 *    fails this is one a reader cannot drill.
 */

import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeDaily, type DailyFile } from '../lib/formats/daily.ts';
import { decodeIssues, type IssuesFile } from '../lib/formats/issues.ts';
import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import { decodeTimingFile } from '../lib/formats/decode.ts';
import {
    type FlakyDay,
    dateOfDay,
    flakinessByFolder,
    folderList,
    flakinessOverTime,
    flakyPercentage,
    runningAverage,
    startDateOf,
} from '../lib/query/flakiness.ts';

const issuesFixture = JSON.parse(
    await readFile(new URL('./fixtures/xpcshell-issues.json', import.meta.url), 'utf8')
) as IssuesFile;

const dailyFixture = JSON.parse(
    await readFile(new URL('./fixtures/xpcshell-2026-08-03.json', import.meta.url), 'utf8')
) as DailyFile;

/**
 * The per-day counts, recomputed from the raw fixture by an independent walk.
 *
 * Deliberately not sharing a line of code with `lib/query/flakiness.ts`: the
 * day deltas are re-accumulated here, the status strings are matched by regular
 * expression rather than through `classifyStatus`, and the three states are
 * decided by a separate `if` chain. If both agree, the agreement is evidence.
 *
 * The `run-if` rule is reproduced by matching the message prefix, which is what
 * `lib/model/skips.ts` does — the one piece of semantics a regex has to know.
 */
function independentCounts(file: IssuesFile): FlakyDay[] {
    const days = file.metadata.days;
    const statuses = file.tables.statuses;
    const messages = file.tables.messages;
    const perDay: FlakyDay[] = [];
    for (let day = 0; day < days; day++) {
        perDay.push({
            day,
            date: dateOfDay(file.metadata.startDate, day),
            flaky: 0,
            stable: 0,
            skipped: 0,
            total: 0,
        });
    }

    for (const perTest of file.testRuns) {
        if (!perTest) {
            continue;
        }
        const fail = new Array<number>(days).fill(0);
        const pass = new Array<number>(days).fill(0);
        const skip = new Array<number>(days).fill(0);

        for (let statusId = 0; statusId < perTest.length; statusId++) {
            const group = perTest[statusId];
            if (!group) {
                continue;
            }
            const status = statuses[statusId]!;
            const raw = group as unknown as {
                days?: number[];
                counts?: number[];
                messageIds?: (number | null)[];
            };
            if (raw.days === undefined || raw.counts === undefined) {
                continue;
            }
            // Matched by prefix here rather than through the shared classifier,
            // so a change to the taxonomy cannot silently move both sides.
            const isSkip = status === 'SKIP';
            const isExpectedFail = status.startsWith('EXPECTED-FAIL');
            const isFail =
                !isExpectedFail && /^(FAIL|TIMEOUT|CRASH)/.test(status);
            const isPass = isExpectedFail || status.startsWith('PASS');

            let day = 0;
            for (let index = 0; index < raw.days.length; index++) {
                day += raw.days[index]!;
                const count = raw.counts[index]!;
                if (isFail) {
                    fail[day] = fail[day]! + count;
                } else if (isPass) {
                    pass[day] = pass[day]! + count;
                } else if (isSkip) {
                    const messageId = raw.messageIds?.[index];
                    const message =
                        messageId === null || messageId === undefined
                            ? null
                            : messages[messageId]!;
                    if (message === null || !message.startsWith('run-if')) {
                        skip[day] = skip[day]! + count;
                    }
                }
            }
        }

        for (let day = 0; day < days; day++) {
            const entry = perDay[day]!;
            if (fail[day]! > 0) {
                entry.flaky++;
            } else if (skip[day]! > 0) {
                entry.skipped++;
            } else if (pass[day]! > 0) {
                entry.stable++;
            } else {
                continue;
            }
            entry.total++;
        }
    }
    return perDay;
}

test('per-day counts match an independent walk of the fixture', () => {
    const decoded = decodeIssues(issuesFixture);
    // The filter off, so this compares the classification alone.
    const series = flakinessOverTime(decoded, { minWindowFailures: 0 });
    const expected = independentCounts(issuesFixture);

    assert.equal(series.days.length, issuesFixture.metadata.days);
    for (let day = 0; day < expected.length; day++) {
        assert.deepEqual(
            series.days[day],
            expected[day],
            `day ${day} (${expected[day]!.date}) disagrees with the independent walk`
        );
    }
});

test('the first and last dates are the window, and day 0 is the oldest', () => {
    const decoded = decodeIssues(issuesFixture);
    const series = flakinessOverTime(decoded, { minWindowFailures: 0 });
    assert.equal(startDateOf(decoded), issuesFixture.metadata.startDate);
    assert.equal(series.days[0]!.date, issuesFixture.metadata.startDate);
    assert.equal(series.days.at(-1)!.date, issuesFixture.metadata.endDate);
});

test('a daily file classifies as a single day', () => {
    const decoded = decodeDaily(dailyFixture);
    const series = flakinessOverTime(decoded, { minWindowFailures: 0 });
    assert.equal(series.days.length, 1);
    assert.equal(series.days[0]!.date, dailyFixture.metadata.date ?? decoded.endDate);
    // Every test in a daily file either ran or was skipped, so the three states
    // must account for every test the file describes that had any entry.
    const day = series.days[0]!;
    assert.equal(day.total, day.flaky + day.stable + day.skipped);
    assert.ok(day.total > 0, 'the daily fixture should classify some tests');
});

// --- the three states, on hand-built input --------------------------------

/**
 * A one-test file with the given status groups, for the precedence cases.
 *
 * The fixtures cannot supply "failed and skipped on the same day" on demand, so
 * the ordering rules are asserted on input built here. Uses the same
 * `decodeTimingFile` the real decoders do, so only the *data* is synthetic.
 */
function oneTest(
    groups: { status: string; days: number[]; counts: number[]; messageIds?: (number | null)[] }[],
    options: { days?: number; path?: string } = {}
): DecodedTimingFile {
    const statuses = groups.map((group) => group.status);
    const messages = ['skip-if: os == "win"', 'run-if: os == "linux"'];
    const path = options.path ?? 'dom/base/test';
    return decodeTimingFile({
        family: 'issues',
        days: options.days ?? 1,
        endDate: '2026-08-04',
        tables: {
            testPaths: [path],
            testNames: ['test_a.js'],
            statuses,
            messages,
            crashSignatures: [],
            components: ['Core :: DOM'],
        } as never,
        testInfo: {
            testPathIds: [0],
            testNameIds: [0],
            componentIds: [0],
        } as never,
        testRuns: [
            groups.map((group) => {
                const raw: Record<string, unknown> = {
                    days: group.days,
                    counts: group.counts,
                };
                if (group.messageIds !== undefined) {
                    raw['messageIds'] = group.messageIds;
                }
                return raw as never;
            }),
        ],
    });
}

test('failing beats being skipped: a test that did both is flaky', () => {
    const file = oneTest([
        { status: 'PASS', days: [0], counts: [10] },
        { status: 'SKIP', days: [0], counts: [3], messageIds: [0] },
        { status: 'FAIL', days: [0], counts: [1] },
    ]);
    const day = flakinessOverTime(file, { minWindowFailures: 0 }).days[0]!;
    assert.deepEqual(
        { flaky: day.flaky, stable: day.stable, skipped: day.skipped, total: day.total },
        { flaky: 1, stable: 0, skipped: 0, total: 1 }
    );
});

test('being skipped beats passing: a test skipped anywhere is not stable', () => {
    const file = oneTest([
        { status: 'PASS', days: [0], counts: [10] },
        { status: 'SKIP', days: [0], counts: [1], messageIds: [0] },
    ]);
    const day = flakinessOverTime(file, { minWindowFailures: 0 }).days[0]!;
    assert.deepEqual(
        { flaky: day.flaky, stable: day.stable, skipped: day.skipped },
        { flaky: 0, stable: 0, skipped: 1 }
    );
});

test('a 100% pass test is stable, and EXPECTED-FAIL counts as passing', () => {
    const passOnly = oneTest([{ status: 'PASS', days: [0], counts: [10] }]);
    assert.equal(flakinessOverTime(passOnly, { minWindowFailures: 0 }).days[0]!.stable, 1);

    const expectedFail = oneTest([{ status: 'EXPECTED-FAIL', days: [0], counts: [4] }]);
    const day = flakinessOverTime(expectedFail, { minWindowFailures: 0 }).days[0]!;
    assert.deepEqual(
        { flaky: day.flaky, stable: day.stable, skipped: day.skipped },
        { flaky: 0, stable: 1, skipped: 0 },
        'a fail-if test that failed did what the manifest said'
    );
});

test('a run-if skip is not a skip', () => {
    const file = oneTest([
        { status: 'PASS', days: [0], counts: [5] },
        // messageId 1 is the `run-if` message.
        { status: 'SKIP', days: [0], counts: [7], messageIds: [1] },
    ]);
    const day = flakinessOverTime(file, { minWindowFailures: 0 }).days[0]!;
    assert.equal(day.stable, 1, 'run-if means scoped elsewhere, not disabled');
    assert.equal(day.skipped, 0);
});

test('a test with no runs on a day is in no state and out of the denominator', () => {
    // Two days; the test only ran on the second.
    const file = oneTest([{ status: 'PASS', days: [1], counts: [3] }], { days: 2 });
    const series = flakinessOverTime(file, { minWindowFailures: 0 });
    assert.deepEqual(
        series.days.map((day) => day.total),
        [0, 1]
    );
    assert.equal(series.days[0]!.stable, 0);
    assert.equal(series.days[1]!.stable, 1);
});

// --- the noise filter -----------------------------------------------------

test('a single failure in the window is neutralised and read as a pass', () => {
    const file = oneTest([
        { status: 'PASS', days: [0, 1], counts: [5, 5] },
        { status: 'FAIL', days: [1], counts: [1] },
    ], { days: 2 });

    const unfiltered = flakinessOverTime(file, { minWindowFailures: 0 });
    assert.equal(unfiltered.days[1]!.flaky, 1);
    assert.equal(unfiltered.neutralisedTests, 0);

    const filtered = flakinessOverTime(file, { minWindowFailures: 1 });
    assert.equal(filtered.neutralisedTests, 1);
    assert.equal(filtered.days[1]!.flaky, 0);
    assert.equal(filtered.days[1]!.stable, 1, 'the failure is read as a pass');
    // The point of reading it as a pass rather than dropping it: the test is
    // still counted on that day.
    assert.equal(filtered.days[1]!.total, 1);
});

test('a neutralised failure keeps its test in the denominator when it was the only run', () => {
    // The test's *only* run that day is the filtered failure. Dropping the run
    // instead of passing it would leave the day with no test at all.
    const file = oneTest([
        { status: 'PASS', days: [0], counts: [5] },
        { status: 'FAIL', days: [1], counts: [1] },
    ], { days: 2 });
    const filtered = flakinessOverTime(file, { minWindowFailures: 1 });
    assert.equal(filtered.days[1]!.total, 1, 'the day still has a test');
    assert.equal(filtered.days[1]!.stable, 1);
});

test('two failures survive the default filter', () => {
    const file = oneTest([
        { status: 'PASS', days: [0, 1], counts: [5, 5] },
        { status: 'FAIL', days: [0, 1], counts: [1, 1] },
    ], { days: 2 });
    const filtered = flakinessOverTime(file, { minWindowFailures: 1 });
    assert.equal(filtered.neutralisedTests, 0);
    assert.equal(filtered.days[0]!.flaky, 1);
    assert.equal(filtered.days[1]!.flaky, 1);
});

test('a threshold of 0 neutralises nothing, including clean tests', () => {
    const file = oneTest([{ status: 'PASS', days: [0], counts: [5] }]);
    assert.equal(flakinessOverTime(file, { minWindowFailures: 0 }).neutralisedTests, 0);
});

test('the noise filter is not applied to a single-day file', () => {
    // The filter asks "was this one unlucky run over a long period"; a one-day
    // file cannot answer it, and applying it there neutralises every test that
    // failed once that day. Measured on the real pair: the same 2026-08-04 read
    // 923 flaky inside the window and 562 as a standalone daily file.
    const decoded = decodeDaily(dailyFixture);
    const asked = flakinessOverTime(decoded, { minWindowFailures: 1 });
    const off = flakinessOverTime(decoded, { minWindowFailures: 0 });

    assert.equal(asked.minWindowFailures, 0, 'the effective threshold is reported, not the request');
    assert.equal(asked.neutralisedTests, 0);
    assert.deepEqual(asked.days, off.days, 'a daily file classifies the same either way');
});

test('the folder table also ignores the filter on a single-day file', () => {
    const decoded = decodeDaily(dailyFixture);
    const asked = flakinessByFolder(decoded, { minWindowFailures: 1 });
    const off = flakinessByFolder(decoded, { minWindowFailures: 0 });
    assert.equal(asked.flaky, off.flaky);
    assert.equal(asked.total, off.total);
});

test('a two-day file is long enough for the filter', () => {
    const file = oneTest([
        { status: 'PASS', days: [0, 1], counts: [5, 5] },
        { status: 'FAIL', days: [1], counts: [1] },
    ], { days: 2 });
    const series = flakinessOverTime(file, { minWindowFailures: 1 });
    assert.equal(series.minWindowFailures, 1, 'MIN_FILTERABLE_DAYS is 2, so this applies');
    assert.equal(series.neutralisedTests, 1);
});

test('the default threshold is 1', () => {
    const decoded = decodeIssues(issuesFixture);
    assert.equal(flakinessOverTime(decoded).minWindowFailures, 1);
});

// --- the running average --------------------------------------------------

test('the running average is centred and spans the whole axis', () => {
    const days: FlakyDay[] = [10, 20, 30, 40, 50].map((flaky, index) => ({
        day: index,
        date: dateOfDay('2026-08-01', index),
        flaky,
        stable: 100 - flaky,
        skipped: 0,
        total: 100,
    }));

    const average = runningAverage(days, 3);
    assert.equal(average.length, days.length);
    // Centred: index 1 averages days 0..2 = (10+20+30)/300.
    assert.equal(average[1], 20);
    assert.equal(average[2], 30);
    // The ends average over the days that exist: index 0 is days 0..1.
    assert.equal(average[0], 15);
    assert.equal(average[4], 45);
});

test('the running average weights by tests, not by day, and skips empty days', () => {
    const days: FlakyDay[] = [
        { day: 0, date: '2026-08-01', flaky: 10, stable: 90, skipped: 0, total: 100 },
        // A day CI did not run: it must not pull the mean toward zero.
        { day: 1, date: '2026-08-02', flaky: 0, stable: 0, skipped: 0, total: 0 },
        { day: 2, date: '2026-08-03', flaky: 30, stable: 70, skipped: 0, total: 100 },
    ];
    const average = runningAverage(days, 3);
    // (10 + 30) / (100 + 100) = 20%, not (10 + 0 + 30) / 3.
    assert.equal(average[1], 20);
});

test('a window with no data at all averages to null rather than zero', () => {
    const days: FlakyDay[] = [
        { day: 0, date: '2026-08-01', flaky: 0, stable: 0, skipped: 0, total: 0 },
    ];
    assert.deepEqual(runningAverage(days, 3), [null]);
});

// --- the folder tree ------------------------------------------------------

test('a folder node is its whole subtree, and children sum to their parent', () => {
    const decoded = decodeIssues(issuesFixture);
    const root = flakinessByFolder(decoded, { minWindowFailures: 0 });

    // The root's counts against the chart's for the same day — the cross-check
    // between the two entry points.
    //
    // `flaky`, `stable` and `total` must agree exactly. **`skipped` must not**:
    // the chart is exclusive (a flaky-and-skipped test is only flaky, so the
    // stack and its percentages still add to 100) while the table counts that
    // test in both columns. The difference is exactly `flakyAndSkipped`, and
    // asserting that is what would catch either side drifting.
    const series = flakinessOverTime(decoded, { minWindowFailures: 0 });
    const lastDay = series.days.at(-1)!;
    assert.deepEqual(
        { flaky: root.flaky, stable: root.stable, total: root.total },
        { flaky: lastDay.flaky, stable: lastDay.stable, total: lastDay.total }
    );
    assert.equal(
        root.skipped,
        lastDay.skipped + root.flakyAndSkipped,
        'the table adds the flaky-and-skipped tests the chart left out'
    );

    // Every node: its own counts are at least the sum of its children's, and
    // the difference is the tests sitting directly in that folder.
    const visit = (node: typeof root): void => {
        const childTotal = node.children.reduce((sum, child) => sum + child.total, 0);
        assert.ok(
            node.total >= childTotal,
            `${node.path || '(root)'}: total ${node.total} is less than its children's ${childTotal}`
        );
        for (const key of ['flaky', 'stable', 'skipped'] as const) {
            const sum = node.children.reduce((total, child) => total + child[key], 0);
            assert.ok(
                node[key] >= sum,
                `${node.path || '(root)'}: ${key} ${node[key]} is less than its children's ${sum}`
            );
        }
        // `skipped` overlaps `flaky` in the table, so the three columns exceed
        // the population by exactly the overlap. See `OverlappingCounts`.
        assert.equal(
            node.flaky + node.stable + node.skipped,
            node.total + node.flakyAndSkipped
        );
        for (const child of node.children) {
            visit(child);
        }
    };
    visit(root);
});

test('a folder credits every ancestor exactly once', () => {
    // Two tests in one deep directory: every ancestor must read 2, not 2 per
    // level or 1 at the leaf.
    const file = decodeTimingFile({
        family: 'issues',
        days: 1,
        endDate: '2026-08-04',
        tables: {
            testPaths: ['dom/base/test'],
            testNames: ['a.js', 'b.js'],
            statuses: ['PASS', 'FAIL'],
            messages: [],
            crashSignatures: [],
            components: ['Core :: DOM'],
        } as never,
        testInfo: {
            testPathIds: [0, 0],
            testNameIds: [0, 1],
            componentIds: [0, 0],
        } as never,
        testRuns: [
            [{ days: [0], counts: [5] } as never],
            [{ days: [0], counts: [5] } as never, { days: [0], counts: [2] } as never],
        ],
    });

    const root = flakinessByFolder(file, { minWindowFailures: 0 });
    assert.equal(root.total, 2);
    assert.equal(root.flaky, 1);

    const dom = root.children.find((child) => child.name === 'dom')!;
    assert.equal(dom.total, 2);
    assert.equal(dom.flaky, 1);
    assert.equal(dom.path, 'dom');

    const base = dom.children.find((child) => child.name === 'base')!;
    assert.equal(base.total, 2);
    assert.equal(base.path, 'dom/base');

    const leaf = base.children.find((child) => child.name === 'test')!;
    assert.equal(leaf.total, 2);
    assert.equal(leaf.flaky, 1);
    assert.equal(leaf.path, 'dom/base/test');
    assert.equal(leaf.children.length, 0);
    assert.equal(leaf.testCount, 2);
});

test('children are ranked by flaky count, not by percentage', () => {
    // `big` has 2 flaky of 10; `small` has 1 flaky of 1 — 100%, but one test.
    const testPaths = ['big', 'small'];
    const names: string[] = [];
    const testPathIds: number[] = [];
    const testNameIds: number[] = [];
    const testRuns: unknown[][] = [];
    const push = (pathId: number, name: string, flaky: boolean): void => {
        testPathIds.push(pathId);
        testNameIds.push(names.length);
        names.push(name);
        testRuns.push(
            flaky
                ? [{ days: [0], counts: [5] }, { days: [0], counts: [2] }]
                : [{ days: [0], counts: [5] }]
        );
    };
    for (let index = 0; index < 10; index++) {
        push(0, `big${index}.js`, index < 2);
    }
    push(1, 'small.js', true);

    const file = decodeTimingFile({
        family: 'issues',
        days: 1,
        endDate: '2026-08-04',
        tables: {
            testPaths,
            testNames: names,
            statuses: ['PASS', 'FAIL'],
            messages: [],
            crashSignatures: [],
            components: ['Core :: DOM'],
        } as never,
        testInfo: {
            testPathIds,
            testNameIds,
            componentIds: testPathIds.map(() => 0),
        } as never,
        testRuns: testRuns as never,
    });

    const root = flakinessByFolder(file, { minWindowFailures: 0 });
    assert.deepEqual(
        root.children.map((child) => child.name),
        ['big', 'small'],
        'the folder with more flaky tests ranks first even at a lower percentage'
    );
    assert.equal(flakyPercentage(root.children[1]!), 100);
    assert.equal(flakyPercentage(root.children[0]!), 20);
});

test('allDays counts each test once, not once per day', () => {
    const file = oneTest([
        { status: 'PASS', days: [0, 1], counts: [5, 5] },
        { status: 'FAIL', days: [0, 1], counts: [1, 1] },
    ], { days: 2 });

    const oneDay = flakinessByFolder(file, { minWindowFailures: 0 });
    assert.equal(oneDay.total, 1, 'the default is a single day');

    const allDays = flakinessByFolder(file, { minWindowFailures: 0, allDays: true });
    // One test, one count — not one per day. The regression this pins turned
    // 4,805 tests into 100,716 test-days under a column headed "Tests".
    assert.equal(allDays.total, 1);
    assert.equal(allDays.flaky, 1);
    assert.equal(allDays.testCount, 1);
});

test('over the window a test is flaky if it was flaky on any single day', () => {
    // Stable on day 0, flaky on day 1: flaky for the window.
    const file = oneTest([
        { status: 'PASS', days: [0, 1], counts: [5, 5] },
        { status: 'FAIL', days: [1], counts: [3] },
    ], { days: 2 });
    const root = flakinessByFolder(file, { minWindowFailures: 0, allDays: true });
    assert.deepEqual(
        { flaky: root.flaky, stable: root.stable, skipped: root.skipped, total: root.total },
        { flaky: 1, stable: 0, skipped: 0, total: 1 },
        'the same test must not be counted as both flaky and stable'
    );
});

test('over the window the exclusive verdict is still one state per test', () => {
    // Flaky on day 0, skipped on day 1, stable on day 2. The *verdict* is one
    // state — flaky wins — and `total` stays 1, which is what keeps the table a
    // count of tests. The skipped column separately counts it as well, so the
    // three columns exceed `total` by the named overlap. See `OverlappingCounts`.
    const file = oneTest([
        { status: 'PASS', days: [0, 2], counts: [5, 5] },
        { status: 'FAIL', days: [0], counts: [2] },
        { status: 'SKIP', days: [1], counts: [1], messageIds: [0] },
    ], { days: 3 });
    const root = flakinessByFolder(file, { minWindowFailures: 0, allDays: true });
    assert.equal(root.total, 1, 'one test');
    assert.equal(root.flaky, 1, 'flaky wins the verdict');
    assert.equal(root.skipped, 1, 'and it is also counted as skipped');
    assert.equal(root.flakyAndSkipped, 1);
    assert.equal(root.flaky + root.stable + root.skipped, root.total + root.flakyAndSkipped);
});

test('over the window a never-flaky test that was skipped somewhere is skipped', () => {
    const file = oneTest([
        { status: 'PASS', days: [0, 1], counts: [5, 5] },
        { status: 'SKIP', days: [1], counts: [1], messageIds: [0] },
    ], { days: 2 });
    const root = flakinessByFolder(file, { minWindowFailures: 0, allDays: true });
    assert.deepEqual(
        { flaky: root.flaky, stable: root.stable, skipped: root.skipped },
        { flaky: 0, stable: 0, skipped: 1 }
    );
});

test('over the window a test clean on every day is stable', () => {
    const file = oneTest([{ status: 'PASS', days: [0, 1], counts: [5, 5] }], { days: 2 });
    const root = flakinessByFolder(file, { minWindowFailures: 0, allDays: true });
    assert.deepEqual(
        { flaky: root.flaky, stable: root.stable, skipped: root.skipped },
        { flaky: 0, stable: 1, skipped: 0 }
    );
});

// --- the table's overlapping skipped column -------------------------------

test('a test that is flaky and skipped counts in both table columns', () => {
    // Failed on one configuration, disabled on another, on the same day.
    const file = oneTest([
        { status: 'PASS', days: [0], counts: [10] },
        { status: 'FAIL', days: [0], counts: [3] },
        { status: 'SKIP', days: [0], counts: [2], messageIds: [0] },
    ]);
    const root = flakinessByFolder(file, { minWindowFailures: 0 });
    assert.equal(root.flaky, 1, 'the exclusive verdict is flaky');
    assert.equal(root.skipped, 1, 'and it is counted as skipped too');
    assert.equal(root.flakyAndSkipped, 1, 'the overlap is named');
    assert.equal(root.total, 1, 'but it is still one test');
    // Which means the columns deliberately do not add up.
    assert.equal(root.flaky + root.stable + root.skipped, root.total + root.flakyAndSkipped);
});

test('a flaky test that was never skipped is not in the skipped column', () => {
    const file = oneTest([
        { status: 'PASS', days: [0], counts: [10] },
        { status: 'FAIL', days: [0], counts: [3] },
    ]);
    const root = flakinessByFolder(file, { minWindowFailures: 0 });
    assert.equal(root.flaky, 1);
    assert.equal(root.skipped, 0);
    assert.equal(root.flakyAndSkipped, 0);
});

test('a skipped-only test is counted once, not twice', () => {
    const file = oneTest([
        { status: 'PASS', days: [0], counts: [10] },
        { status: 'SKIP', days: [0], counts: [2], messageIds: [0] },
    ]);
    const root = flakinessByFolder(file, { minWindowFailures: 0 });
    assert.equal(root.skipped, 1, 'the exclusive verdict already put it here');
    assert.equal(root.flaky, 0);
    assert.equal(root.flakyAndSkipped, 0);
    assert.equal(root.flaky + root.stable + root.skipped, root.total);
});

test('over the window, flaky on one day and skipped on another counts in both', () => {
    const file = oneTest([
        { status: 'PASS', days: [0, 1], counts: [5, 5] },
        { status: 'FAIL', days: [0], counts: [2] },
        { status: 'SKIP', days: [1], counts: [1], messageIds: [0] },
    ], { days: 2 });
    const root = flakinessByFolder(file, { minWindowFailures: 0, allDays: true });
    assert.equal(root.flaky, 1);
    assert.equal(root.skipped, 1);
    assert.equal(root.flakyAndSkipped, 1);
    assert.equal(root.total, 1);
});

test('the leaf agrees with the folder row above it', () => {
    const file = oneTest([
        { status: 'PASS', days: [0], counts: [10] },
        { status: 'FAIL', days: [0], counts: [3] },
        { status: 'SKIP', days: [0], counts: [2], messageIds: [0] },
    ]);
    const root = flakinessByFolder(file, { minWindowFailures: 0 });
    const leaf = findLeafAnywhere(root);
    assert.equal(leaf.flaky, 1);
    assert.equal(leaf.skipped, 1, 'a leaf row shows the same overlap as its folder');
    assert.equal(leaf.flakyAndSkipped, 1);
    assert.equal(leaf.total, 1);
});

test('the overlap reconciles against the real fixture at every node', () => {
    const decoded = decodeIssues(issuesFixture);
    for (const options of [{ allDays: true }, { day: 0 }] as const) {
        const root = flakinessByFolder(decoded, { minWindowFailures: 0, ...options });
        const visit = (node: typeof root): void => {
            // The identity that defines the overlap: the three columns exceed
            // the population by exactly the number of both-flaky-and-skipped
            // tests, and never by anything else.
            assert.equal(
                node.flaky + node.stable + node.skipped,
                node.total + node.flakyAndSkipped,
                `${node.path || '(root)'} does not reconcile`
            );
            assert.ok(node.flakyAndSkipped <= node.flaky);
            assert.ok(node.skipped <= node.total);
            // A subtree's overlap is its children's plus its own files'.
            const childOverlap = node.children.reduce((sum, c) => sum + c.flakyAndSkipped, 0);
            const leafOverlap = node.tests.reduce((sum, t) => sum + t.flakyAndSkipped, 0);
            assert.equal(node.flakyAndSkipped, childOverlap + leafOverlap);
            for (const child of node.children) {
                visit(child);
            }
        };
        visit(root);
    }
});

/** The first leaf found anywhere in a tree, for the single-test fixtures. */
function findLeafAnywhere(node: {
    tests: { flaky: number; skipped: number; flakyAndSkipped: number; total: number }[];
    children: unknown[];
}): { flaky: number; skipped: number; flakyAndSkipped: number; total: number } {
    if (node.tests.length > 0) {
        return node.tests[0]!;
    }
    for (const child of node.children) {
        const found = findLeafAnywhere(
            child as Parameters<typeof findLeafAnywhere>[0]
        );
        if (found !== undefined) {
            return found;
        }
    }
    throw new Error('no leaf in the tree');
}

test('the window table counts the same tests as a single day', () => {
    // The real fixture: both modes must agree on how many tests there are,
    // which is what makes the two views comparable.
    const decoded = decodeIssues(issuesFixture);
    const oneDay = flakinessByFolder(decoded, { minWindowFailures: 0 });
    const allDays = flakinessByFolder(decoded, { minWindowFailures: 0, allDays: true });
    assert.equal(
        allDays.total,
        allDays.testCount,
        'a total that exceeds the file count means a test was counted twice'
    );
    assert.ok(
        allDays.total >= oneDay.total,
        'the window includes every test that ran on any day, so it is at least the single day'
    );
    assert.equal(
        allDays.flaky + allDays.stable + allDays.skipped,
        allDays.total + allDays.flakyAndSkipped
    );
});

test('the folder table can be built for a chosen day', () => {
    const file = oneTest([
        { status: 'PASS', days: [0, 1], counts: [5, 5] },
        { status: 'FAIL', days: [1], counts: [3] },
    ], { days: 2 });

    assert.equal(flakinessByFolder(file, { minWindowFailures: 0, day: 0 }).flaky, 0);
    assert.equal(flakinessByFolder(file, { minWindowFailures: 0, day: 1 }).flaky, 1);
});

test('pathPrefix restricts the population', () => {
    const decoded = decodeIssues(issuesFixture);
    const all = flakinessByFolder(decoded, { minWindowFailures: 0 });
    const scoped = flakinessByFolder(decoded, {
        minWindowFailures: 0,
        pathPrefix: 'toolkit/',
    });
    assert.ok(scoped.total <= all.total);
    for (const child of scoped.children) {
        assert.equal(child.name, 'toolkit');
    }
});

test('flakyPercentage is 0 for an empty node and never divides by zero', () => {
    assert.equal(flakyPercentage({ flaky: 0, stable: 0, skipped: 0, total: 0 }), 0);
    assert.equal(flakyPercentage({ flaky: 1, stable: 1, skipped: 2, total: 4 }), 25);
});

// --- test leaves and the flat list ----------------------------------------

test('a test file is a leaf of the folder it lives in, and only that one', () => {
    const decoded = decodeIssues(issuesFixture);
    const root = flakinessByFolder(decoded, { minWindowFailures: 0 });

    // Every leaf, everywhere, with the folder that carries it.
    const seen = new Map<string, string>();
    const visit = (node: typeof root): void => {
        for (const leaf of node.tests) {
            assert.ok(
                !seen.has(leaf.fullPath),
                `${leaf.fullPath} is listed under both ${seen.get(leaf.fullPath)} and ${node.path}`
            );
            seen.set(leaf.fullPath, node.path);
            // The leaf belongs to the directory its own path names.
            const directory = leaf.fullPath.slice(0, leaf.fullPath.lastIndexOf('/'));
            assert.equal(node.path, directory);
        }
        for (const child of node.children) {
            visit(child);
        }
    };
    visit(root);
    assert.ok(seen.size > 0, 'the fixture should produce some leaves');
    // Every classified test is a leaf somewhere.
    assert.equal(seen.size, root.testCount);
});

test('a folder’s leaves sum to the tests it holds directly', () => {
    const decoded = decodeIssues(issuesFixture);
    const root = flakinessByFolder(decoded, { minWindowFailures: 0 });
    const visit = (node: typeof root): void => {
        const childTotal = node.children.reduce((sum, child) => sum + child.total, 0);
        const leafTotal = node.tests.reduce((sum, leaf) => sum + leaf.total, 0);
        assert.equal(
            node.total,
            childTotal + leafTotal,
            `${node.path || '(root)'}: subtree ${node.total} != children ${childTotal} + own ${leafTotal}`
        );
        for (const child of node.children) {
            visit(child);
        }
    };
    visit(root);
});

test('a leaf is one test, in one verdict, on a single day', () => {
    const decoded = decodeIssues(issuesFixture);
    const root = flakinessByFolder(decoded, { minWindowFailures: 0 });
    const visit = (node: typeof root): void => {
        for (const leaf of node.tests) {
            // One test — but a flaky-and-skipped one shows 1 in both columns,
            // so the sum is 1 + the overlap rather than always 1.
            assert.equal(
                leaf.flaky + leaf.stable + leaf.skipped,
                1 + leaf.flakyAndSkipped,
                leaf.fullPath
            );
            assert.equal(leaf.total, 1);
        }
        for (const child of node.children) {
            visit(child);
        }
    };
    visit(root);
});

test('over the window a leaf is still exactly one test', () => {
    const decoded = decodeIssues(issuesFixture);
    const root = flakinessByFolder(decoded, { minWindowFailures: 0, allDays: true });
    const visit = (node: typeof root): void => {
        for (const leaf of node.tests) {
            assert.equal(
                leaf.flaky + leaf.stable + leaf.skipped,
                1 + leaf.flakyAndSkipped,
                `${leaf.fullPath} does not reconcile against its overlap`
            );
            assert.equal(leaf.total, 1, `${leaf.fullPath} counts as more than one test`);
        }
        for (const child of node.children) {
            visit(child);
        }
    };
    visit(root);
});

test('the flat list reports each folder’s own tests, and drops pure containers', () => {
    const decoded = decodeIssues(issuesFixture);
    const root = flakinessByFolder(decoded, { minWindowFailures: 0 });
    const rows = folderList(root);

    const byPath = new Map(rows.map((row) => [row.path, row]));
    // Cross-check every row against the tree it came from.
    const visit = (node: typeof root): void => {
        const row = byPath.get(node.path);
        if (node.path !== '' && node.tests.length > 0) {
            assert.ok(row !== undefined, `${node.path} holds tests but is absent from the list`);
            assert.equal(row.selfTestCount, node.tests.length);
            assert.equal(
                row.selfFlaky,
                node.tests.reduce((sum, leaf) => sum + leaf.flaky, 0)
            );
            assert.equal(row.flaky, node.flaky, 'the subtree total is carried too');
        } else if (node.path !== '') {
            assert.equal(row, undefined, `${node.path} has no tests of its own and should be absent`);
        }
        for (const child of node.children) {
            visit(child);
        }
    };
    visit(root);

    // Ranked by the folder's own flaky tests, descending.
    for (let index = 1; index < rows.length; index++) {
        assert.ok(rows[index - 1]!.selfFlaky >= rows[index]!.selfFlaky);
    }
});

test('the flat list’s own-flaky totals reconcile with the root', () => {
    const decoded = decodeIssues(issuesFixture);
    const root = flakinessByFolder(decoded, { minWindowFailures: 0 });
    const rows = folderList(root);
    // Every flaky test lives in exactly one folder, so the folders' own counts
    // must sum to the tree's — this is what a double-counted leaf would break.
    const summed = rows.reduce((sum, row) => sum + row.selfFlaky, 0);
    const rootLoose = root.tests.reduce((sum, leaf) => sum + leaf.flaky, 0);
    assert.equal(summed + rootLoose, root.flaky);
});

test('dateOfDay walks the calendar, including across a month boundary', () => {
    assert.equal(dateOfDay('2026-07-30', 0), '2026-07-30');
    assert.equal(dateOfDay('2026-07-30', 3), '2026-08-02');
    assert.equal(dateOfDay('2026-12-31', 1), '2027-01-01');
});
