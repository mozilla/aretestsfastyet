/**
 * `site/index-view.ts` — the landing page's view model, driven without a DOM.
 *
 * The page is 794 lines that read as a table plus four charts, and the things
 * worth testing are the ones that are invisible in that description: three
 * different time windows, two incompatible job denominators, a merge that
 * corrupts a field, and a rate that can go negative. Each of those has a test
 * here that would fail if the behaviour changed, and the synthetic cases exist
 * because the real data does not reach them.
 *
 * ## Expected values do not come from the thing under test
 *
 * The trap this project has hit eight times. Every expected number here is
 * either (a) tallied from the fixture by a loop written in the test, which is a
 * second implementation, or (b) a literal measured off the pinned file and
 * written down. Where a literal is used, the test *also* recomputes it from the
 * fixture so that a fixture refresh fails loudly rather than silently comparing
 * a stale constant against itself.
 *
 * Thousands separators are never hardcoded: this machine's locale renders 1078
 * as `1 078`, so expectations are built with `toLocaleString()`.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { StatsFile } from '../lib/formats/stats.ts';
import {
    type MergedStats,
    MOCHITEST_FLAVORS,
    SUMMARY_DAYS,
    SUMMARY_LINK_HASH,
    breakdownSeries,
    breakdownTotals,
    displayValue,
    droppedDates,
    holeCount,
    mergeBackfillStats,
    rateSeries,
    recentWindow,
    summaryRow,
    summaryRows,
    sumSeries,
    testFailedJobSeries,
    unlistedFlavors,
} from '../site/index-view.ts';

const ROOT = new URL('../', import.meta.url);
const FIXTURES = new URL('./fixtures/', import.meta.url);

function statsFixture(name: string): StatsFile {
    return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as StatsFile;
}

/** The committed backfill, read from the repository root where the page fetches it. */
function backfillFile(name: string): StatsFile {
    return JSON.parse(readFileSync(new URL(name, ROOT), 'utf8')) as StatsFile;
}

const xpcshell = (): StatsFile => statsFixture('xpcshell-stats.json');
const mochitest = (): StatsFile => statsFixture('mochitest-stats.json');
const backfill = (): StatsFile => backfillFile('mochitest-stats-backfill.json');

/** The merged mochitest file the page actually renders from. */
function mergedMochitest(): MergedStats {
    return mergeBackfillStats(backfill(), mochitest()).stats;
}

/** A minimal stats file, for the cases the real data does not reach. */
function syntheticFile(overrides: Partial<StatsFile> & { dates: string[] }): StatsFile {
    const n = overrides.dates.length;
    const zeros = (): number[] => new Array<number>(n).fill(0);
    return {
        metadata: { generatedAt: '2026-08-04T00:00:00.000Z', harness: 'xpcshell' },
        totalTestRuns: zeros(),
        failedTestRuns: zeros(),
        skippedTestRuns: zeros(),
        processedJobCount: zeros(),
        failedJobs: zeros(),
        invalidJobs: zeros(),
        ignoredJobs: zeros(),
        markerCounts: {},
        ...overrides,
    };
}

// =========================================================================
// The three windows
// =========================================================================

test('the summary window is 7 dates and the charts are the whole file', () => {
    const xpc = xpcshell();
    const moch = mergedMochitest();

    // The property the page never states, asserted as a ratio rather than as
    // two constants, so a fixture refresh does not need this test edited.
    const summary = summaryRows({ ...toMerged(xpc) }, moch);
    assert.equal(summary[0]!.totals.dates.length, SUMMARY_DAYS);
    assert.equal(summary[1]!.totals.dates.length, SUMMARY_DAYS);

    assert.ok(
        xpc.dates.length > SUMMARY_DAYS * 20,
        `the charts should cover far more than the table: ${xpc.dates.length} vs ${SUMMARY_DAYS}`
    );
    // Measured on the pinned files, and recomputed so a refresh fails loudly.
    assert.equal(xpc.dates.length, 199);
    assert.equal(moch.dates.length, 198);

    // The chart series really do span the whole file, not a window.
    const series = rateSeries(xpc.dates, xpc.failedTestRuns, xpc.totalTestRuns);
    assert.equal(series.length + droppedDates(xpc.dates, xpc.failedTestRuns, xpc.totalTestRuns), 199);
});

test('the summary links ask issues.html for a third window', () => {
    // Not 7, and not the chart span. Pinned so a change to either of the other
    // two windows does not silently drag this one along.
    assert.equal(SUMMARY_LINK_HASH, '#date=21days');
    assert.notEqual(SUMMARY_LINK_HASH, `#date=${SUMMARY_DAYS}days`);
});

test('a short file narrows the window, which is why the heading is rewritten', () => {
    // Not reachable on the pinned files (199 and 198 dates), so it needs a
    // synthetic one — a browser run against real data would never see it.
    const short = syntheticFile({
        dates: ['2026-08-01', '2026-08-02', '2026-08-03'],
        totalTestRuns: [100, 200, 300],
        failedTestRuns: [1, 2, 3],
    });
    const window = recentWindow(toMerged(short));
    assert.equal(window.dates.length, 3, 'Math.min narrows to what the file has');
    assert.equal(window.totalTestRuns, 600);
    assert.equal(window.failedTestRuns, 6);
});

// =========================================================================
// The backfill merge
// =========================================================================

test('the merge unions the dates, live wins, and the disagreements are reported', () => {
    const live = mochitest();
    const bf = backfill();
    const { stats, warnings } = mergeBackfillStats(bf, live);

    // The union, recomputed independently of the function under test.
    const expected = [...new Set([...bf.dates, ...live.dates])].sort();
    assert.deepEqual(stats.dates, expected);
    assert.equal(stats.dates.length, 198);

    // Live is authoritative over the overlap. Checked on every overlapping
    // date, not on a sample: a rule that held for the first date and not the
    // rest would pass a spot check.
    const overlap = live.dates.filter((date) => bf.dates.includes(date));
    assert.ok(overlap.length > 0, 'the two ranges must overlap for this to test anything');
    for (const date of overlap) {
        const mergedAt = stats.dates.indexOf(date);
        const liveAt = live.dates.indexOf(date);
        assert.equal(
            stats.totalTestRuns[mergedAt],
            live.totalTestRuns[liveAt],
            `live must win on ${date}`
        );
    }

    // And the backfill fills what live lacks.
    for (const date of bf.dates.filter((d) => !live.dates.includes(d))) {
        const mergedAt = stats.dates.indexOf(date);
        const bfAt = bf.dates.indexOf(date);
        assert.equal(stats.totalTestRuns[mergedAt], bf.totalTestRuns[bfAt]);
    }

    // Measured: 446 disagreements over 13 overlapping dates. The split is
    // asserted, not just the count, because a count alone would pass on a merge
    // that had picked the wrong side — and the split is not one-directional,
    // which is itself the interesting fact:
    //
    //   400 have the backfill reading higher — the live artifact lost runs when
    //        history was rebuilt, which is why the backfill exists;
    //    46 have it reading lower, and 44 of those are on 2026-06-10, the
    //        backfill's last date, captured part-way through the day. The
    //        remaining two are single values on 06-04 and 06-08.
    assert.equal(warnings.length, 446);
    assert.equal(warnings.filter((entry) => entry.backfill > entry.live).length, 400);
    assert.equal(warnings.filter((entry) => entry.backfill < entry.live).length, 46);
    assert.equal(
        warnings.filter((entry) => entry.backfill < entry.live && entry.date === '2026-06-10')
            .length,
        44,
        'the backfill-lower cases cluster on its final, partial date'
    );
    assert.equal(new Set(warnings.map((entry) => entry.date)).size, 13);
});

test('the merge leaves no holes on the pinned data, and holeCount says so', () => {
    // This is the measurement behind reproducing `sumArray`'s null handling
    // rather than fixing it: there is nothing to fix on this data.
    const stats = mergedMochitest();
    for (const key of [
        'totalTestRuns',
        'failedTestRuns',
        'skippedTestRuns',
        'processedJobCount',
        'failedJobs',
        'invalidJobs',
        'ignoredJobs',
    ] as const) {
        assert.equal(holeCount(stats[key]), 0, `${key} should have no holes`);
    }
    for (const [name, counters] of Object.entries(stats.flavors ?? {})) {
        for (const [key, values] of Object.entries(counters)) {
            assert.equal(holeCount(values), 0, `flavors.${name}.${key} should have no holes`);
        }
    }
});

test('a hole counts as zero in both numerator and denominator', () => {
    // The behaviour `sumArray` has and the pinned data never exercises. Pinned
    // with a synthetic file so it is a decision with a test rather than an
    // accident: a day with no data drags the rate towards the surrounding days
    // instead of being excluded.
    const withHole: (number | null)[] = [100, null, 100];
    assert.equal(sumSeries(withHole), 200);
    assert.equal(holeCount(withHole), 1);

    // 2 failures over 3 days where one day is missing reads as 2/200 = 1%.
    // Excluding the day would give the same 1% here; the difference shows when
    // the missing day is not average, which is the case that matters.
    const rate = sumSeries([1, null, 1]) / sumSeries(withHole);
    assert.equal(rate, 0.01);
});

test('markerCounts is omitted from the merge rather than mangled into nulls', () => {
    // Divergence 4. Upstream runs this object-of-arrays through its per-day
    // array merge and produces an array of 198 nulls; this asserts the shape
    // the port produces instead, and asserts the input really was an object so
    // the test cannot pass on a fixture that lost the field.
    const live = mochitest();
    assert.equal(typeof live.markerCounts, 'object');
    assert.ok(!Array.isArray(live.markerCounts));
    assert.ok(Object.keys(live.markerCounts).length > 0);

    const { stats } = mergeBackfillStats(backfill(), live);
    assert.equal(
        (stats as unknown as Record<string, unknown>)['markerCounts'],
        undefined,
        'the merged file should not carry a markerCounts at all'
    );
});

test('a missing backfill leaves the live file untouched', () => {
    // xpcshell's case: `ls *-stats-backfill.json` is one entry, so its backfill
    // fetch 404s on every load.
    const live = xpcshell();
    const { stats, warnings } = mergeBackfillStats(null, live);
    assert.equal(warnings.length, 0);
    assert.deepEqual(stats.dates, live.dates);
    assert.equal(stats.dates.length, 199);
    assert.deepEqual(stats.totalTestRuns, live.totalTestRuns);
});

// =========================================================================
// The summary rows
// =========================================================================

/** A `StatsFile` as the merged shape, for tests that do not exercise the merge. */
function toMerged(file: StatsFile): MergedStats {
    return mergeBackfillStats(null, file).stats;
}

test('the summary rows are harnesses then flavors, in source order, unsorted', () => {
    // Framing parity: `PARITY.md` §1 counts a wrong sort key among the defects
    // that produced correct numbers, so the *order* is asserted as a sequence.
    const rows = summaryRows(toMerged(xpcshell()), mergedMochitest());
    assert.deepEqual(
        rows.map((row) => row.name),
        ['XPCShell', 'Mochitest', ...MOCHITEST_FLAVORS.map((flavor) => flavor.name)]
    );
    assert.deepEqual(
        rows.map((row) => row.isFlavor),
        [false, false, ...MOCHITEST_FLAVORS.map(() => true)]
    );

    // Not sorted by any column: at least one adjacent pair must be out of order
    // for each, or "unsorted" would be indistinguishable from "sorted and the
    // data happens to be ordered".
    const flavorRows = rows.filter((row) => row.isFlavor);
    const rates = flavorRows.map((row) => row.testFailureRate ?? 0);
    assert.ok(
        rates.some((value, i) => i > 0 && value > rates[i - 1]!),
        'flavor rows are not sorted by test failure rate ascending'
    );
    assert.ok(
        rates.some((value, i) => i > 0 && value < rates[i - 1]!),
        'flavor rows are not sorted by test failure rate descending'
    );
});

test('the four rates match a tally computed independently of the view model', () => {
    // A second implementation, written from `index.html:470-481` rather than
    // from `site/index-view.ts`, so the assertion is not the code under test
    // compared against itself.
    const stats = toMerged(xpcshell());
    const last7 = (values: (number | null)[]): number =>
        values.slice(-SUMMARY_DAYS).reduce<number>((sum, value) => sum + (value ?? 0), 0);

    const totalTests = last7(stats.totalTestRuns);
    const totalFailed = last7(stats.failedTestRuns);
    const totalSkipped = last7(stats.skippedTestRuns);
    const totalJobs = last7(stats.processedJobCount);
    const failedJobs = last7(stats.failedJobs);
    const invalidJobs = last7(stats.invalidJobs);
    // The job-failure denominator: both branches of the generator's fetch, and
    // the population `failedJobs` is counted over. See `summaryRow`.
    const jobPopulation = totalJobs + invalidJobs;

    const row = summaryRows(stats, null)[0]!;
    assert.equal(row.totals.totalTestRuns, totalTests);
    assert.equal(row.totals.failedTestRuns, totalFailed);
    assert.equal(row.jobPopulation, jobPopulation);
    assert.equal(row.testFailureRate, (totalFailed / totalTests) * 100);
    assert.equal(row.jobFailureRate, (failedJobs / jobPopulation) * 100);
    assert.equal(row.skipRate, (totalSkipped / totalTests) * 100);
    assert.equal(row.invalidJobRate, (invalidJobs / totalJobs) * 100);

    // And the rendered form, measured off the pinned file. These are the eight
    // numbers a visitor reads, so they are pinned as literals too — a change to
    // any of them should be a deliberate edit here.
    assert.equal(row.testFailureRate!.toFixed(2), '0.17');
    assert.equal(row.jobFailureRate!.toFixed(2), '12.24');
    assert.equal(row.skipRate!.toFixed(2), '4.72');
    assert.equal(row.invalidJobRate!.toFixed(2), '0.47');

    // The counters behind the job rate, as literals, so a fixture refresh that
    // moved the rate cannot be mistaken for a formula change.
    assert.equal(failedJobs, 918);
    assert.equal(totalJobs, 7464);
    assert.equal(invalidJobs, 35);
    assert.equal(jobPopulation, 7499);
});

test('a rate is carried unrounded so the renderer rounds once', () => {
    // The double-round that shipped 14.37% where the page showed 14.38%. A
    // ratio that rounds differently at 4dp than at 2dp-of-2dp.
    const file = syntheticFile({
        dates: ['2026-08-03'],
        totalTestRuns: [10000],
        failedTestRuns: [1438],
    });
    const row = summaryRows(toMerged(file), null)[0]!;
    assert.equal(row.testFailureRate, 14.38, 'the raw ratio, not a string');
    assert.equal(typeof row.testFailureRate, 'number');
});

test('more invalid jobs than failed ones no longer produces a negative rate', () => {
    // Upstream's `(failedJobs − invalidJobs) / processedJobCount` renders
    // -4.00% on exactly this input, and the port used to pin that. Divergence 1
    // replaced the subtraction with a wider denominator, so the same counters
    // now give a rate that is in range and is not a clamp of a negative one:
    // 10 / (1000 + 50) = 0.952…%, which no `Math.max(0, …)` would produce.
    const file = syntheticFile({
        dates: ['2026-08-03'],
        processedJobCount: [1000],
        failedJobs: [10],
        invalidJobs: [50],
    });
    const row = summaryRows(toMerged(file), null)[0]!;
    assert.equal(row.jobPopulation, 1050);
    assert.equal(row.jobFailureRate, (10 / 1050) * 100);
    assert.ok(row.jobFailureRate! > 0, 'not clamped to zero: the rate is a real positive value');
});

test('the job failure rate is in [0, 100] on every window of the pinned files', () => {
    // The property the corrected numerator buys, checked over real history
    // rather than asserted: a numerator drawn from the denominator's own
    // population cannot escape the range, on any window, on either harness.
    for (const stats of [toMerged(xpcshell()), mergedMochitest()]) {
        // `recentWindow` reads the *tail*, so a prefix of every array is what
        // moves the window backwards one day at a time.
        const prefix = (end: number): MergedStats => ({
            ...stats,
            dates: stats.dates.slice(0, end),
            totalTestRuns: stats.totalTestRuns.slice(0, end),
            failedTestRuns: stats.failedTestRuns.slice(0, end),
            skippedTestRuns: stats.skippedTestRuns.slice(0, end),
            processedJobCount: stats.processedJobCount.slice(0, end),
            failedJobs: stats.failedJobs.slice(0, end),
            invalidJobs: stats.invalidJobs.slice(0, end),
        });
        let checked = 0;
        for (let end = 1; end <= stats.dates.length; end++) {
            const row = summaryRow(recentWindow(prefix(end)), 'x', 'xpcshell', false);
            if (row.jobFailureRate !== null) {
                assert.ok(
                    row.jobFailureRate >= 0 && row.jobFailureRate <= 100,
                    `${stats.dates[end - 1]}: jobFailureRate=${row.jobFailureRate}`
                );
                checked++;
            }
        }
        // Guard the loop itself: an all-`null` run would make the body vacuous.
        assert.equal(checked, stats.dates.length);
    }
});

test('a flavor row has no invalid-job rate, and flavors carry no such series', () => {
    const moch = mergedMochitest();
    // The data fact the dash is there for, asserted so a future file that grew
    // the field would make the dash a lie and fail here.
    for (const [name, counters] of Object.entries(moch.flavors ?? {})) {
        assert.ok(!('invalidJobs' in counters), `flavors.${name} should have no invalidJobs`);
    }
    const flavorRows = summaryRows(null, moch).filter((row) => row.isFlavor);
    assert.ok(flavorRows.length > 0);
    for (const row of flavorRows) {
        assert.equal(row.invalidJobRate, null);
        assert.equal(row.totals.invalidJobs, 0);
    }
});

test('a flavor row divides by processedJobCount alone, not by the wider population', () => {
    // The generator gives a flavor `processedJobCount = jc.total` and
    // `failedJobs = jc.failed` from one loop over the raw job list
    // (`fetch-test-data.js:1826-1844`, `:2767-2770`), so its denominator is
    // already the population its numerator was drawn from. Distinguishable from
    // the harness expression only when `invalidJobs` is non-zero — which it
    // never is on real flavor data — so this drives it with an explicit value.
    const totals = {
        dates: ['2026-08-03'],
        totalTestRuns: 1000,
        failedTestRuns: 10,
        skippedTestRuns: 20,
        processedJobCount: 100,
        failedJobs: 8,
        invalidJobs: 50,
    };
    const flavor = summaryRow(totals, 'browser-chrome', 'mochitest', true);
    assert.equal(flavor.jobPopulation, 100, 'a flavor must not widen its denominator');
    assert.equal(flavor.jobFailureRate, 8);

    const harness = summaryRow(totals, 'Mochitest', 'mochitest', false);
    assert.equal(harness.jobPopulation, 150);
    assert.equal(harness.jobFailureRate, (8 / 150) * 100);

    // And on the real file, where `invalidJobs` is 0, the two expressions
    // coincide — so the branch above is a statement about *why*, not a number
    // anyone sees today.
    for (const row of summaryRows(null, mergedMochitest()).filter((r) => r.isFlavor)) {
        assert.equal(row.jobPopulation, row.totals.processedJobCount);
    }
});

test('a flavor with zero test runs in the window is hidden, and hides nothing else', () => {
    // `index.html:545`. The aggregate row must not move when a flavor drops
    // out, because it comes from the top-level arrays.
    const moch = mergedMochitest();
    const before = summaryRows(null, moch);
    const aggregateBefore = before.find((row) => row.name === 'Mochitest')!;

    const silenced = structuredClone(moch);
    silenced.flavors!['webgl']!.totalTestRuns = silenced.dates.map(() => 0);
    const after = summaryRows(null, silenced);

    assert.ok(before.some((row) => row.name === 'WebGL'));
    assert.ok(!after.some((row) => row.name === 'WebGL'), 'WebGL should be hidden');
    assert.deepEqual(
        after.find((row) => row.name === 'Mochitest')!.totals,
        aggregateBefore.totals,
        'the aggregate is not the sum of the visible sub-rows'
    );
});

test('a flavor absent from the data is skipped', () => {
    // `index.html:540`, the other implicit hider.
    const moch = mergedMochitest();
    const trimmed = structuredClone(moch);
    delete trimmed.flavors!['media'];
    const rows = summaryRows(null, trimmed);
    assert.ok(!rows.map((row) => row.name).includes('Media'));
    assert.equal(rows.length, summaryRows(null, moch).length - 1);
});

test('the aggregate row is not the sum of the flavor rows', () => {
    // Measured: the eight flavors sum to 60,101,543 test runs against the
    // aggregate's 60,119,846 — an 18,303 shortfall. Recomputed here so a
    // fixture refresh does not compare a stale constant.
    const rows = summaryRows(null, mergedMochitest());
    const aggregate = rows.find((row) => row.name === 'Mochitest')!;
    const flavorSum = rows
        .filter((row) => row.isFlavor)
        .reduce((sum, row) => sum + row.totals.totalTestRuns, 0);
    assert.ok(
        flavorSum < aggregate.totals.totalTestRuns,
        'the flavors do not account for every mochitest test run'
    );
    assert.equal(aggregate.totals.totalTestRuns - flavorSum, 18303);
});

test('a rate with a zero denominator is null, not zero', () => {
    const empty = syntheticFile({ dates: ['2026-08-03'] });
    const row = summaryRows(toMerged(empty), null)[0]!;
    // The view model keeps the distinction the renderer collapses: "no tests
    // ran" and "no tests failed" are different answers.
    assert.equal(row.testFailureRate, null);
    assert.equal(row.jobFailureRate, null);
    assert.equal(row.skipRate, null);
    assert.equal(row.invalidJobRate, null);
});

test('summaryRow keeps its window and labels', () => {
    const totals = recentWindow(toMerged(xpcshell()));
    const row = summaryRow(totals, 'XPCShell', 'xpcshell', false);
    assert.equal(row.name, 'XPCShell');
    assert.equal(row.kind, 'xpcshell');
    assert.equal(row.isFlavor, false);
    assert.equal(row.totals.dates.length, SUMMARY_DAYS);
});

test('a missing required series throws rather than reading as zero', () => {
    // `totalTestRuns` is not guarded upstream and is not guarded here: a
    // landing page confidently showing 0.00% for a metric the file lacks is
    // worse than a page that fails.
    const file = toMerged(syntheticFile({ dates: ['2026-08-03'] }));
    delete (file as unknown as Record<string, unknown>)['totalTestRuns'];
    assert.throws(() => recentWindow(file), /totalTestRuns/);
});

test('a missing optional job series degrades to zero', () => {
    // `index.html:452-455`. The three arrays a flavor lacks.
    const file = toMerged(syntheticFile({ dates: ['2026-08-03'], totalTestRuns: [10] }));
    delete (file as unknown as Record<string, unknown>)['processedJobCount'];
    delete (file as unknown as Record<string, unknown>)['failedJobs'];
    delete (file as unknown as Record<string, unknown>)['invalidJobs'];
    const totals = recentWindow(file);
    assert.equal(totals.processedJobCount, 0);
    assert.equal(totals.failedJobs, 0);
    assert.equal(totals.invalidJobs, 0);
});

// =========================================================================
// The charts
// =========================================================================

test('a rate series drops a date with no denominator rather than plotting zero', () => {
    const points = rateSeries(
        ['2026-08-01', '2026-08-02', '2026-08-03'],
        [1, 5, 2],
        [100, 0, 200]
    );
    assert.deepEqual(
        points.map((point) => point.date),
        ['2026-08-01', '2026-08-03'],
        'a zero denominator would plot as a spike to the axis, reading as a perfect day'
    );
    assert.equal(points[0]!.percentage, 1);
    assert.equal(points[1]!.percentage, 1);
});

test('a rate series drops a date with a null on either side', () => {
    const dates = ['2026-08-01', '2026-08-02', '2026-08-03'];
    assert.equal(rateSeries(dates, [1, null, 2], [100, 100, 100]).length, 2);
    assert.equal(rateSeries(dates, [1, 1, 2], [100, null, 100]).length, 2);
    assert.equal(droppedDates(dates, [1, null, 2], [100, 100, 100]), 1);
});

test('no date is dropped from the pinned files', () => {
    // So the browser comparison is over the full span on both sides, and a
    // future file with a zero-job day is noticed here.
    for (const stats of [toMerged(xpcshell()), mergedMochitest()]) {
        assert.equal(droppedDates(stats.dates, stats.failedTestRuns, stats.totalTestRuns), 0);
        assert.equal(droppedDates(stats.dates, stats.failedJobs, stats.processedJobCount), 0);
    }
});

test('the breakdown chart uses a different denominator from the summary table', () => {
    // The second of the two incompatible job denominators, and the reason
    // `breakdownTotals` is its own function.
    const stats = toMerged(xpcshell());
    const totals = breakdownTotals(stats);
    for (const [i, total] of totals.entries()) {
        assert.equal(
            total,
            (stats.processedJobCount[i] ?? 0) +
                (stats.invalidJobs[i] ?? 0) +
                (stats.ignoredJobs[i] ?? 0)
        );
    }
    // Measured over the last 7 dates: 7,464 against 7,568 — the chart's
    // denominator is 1.39% larger, so its Intermittent band reads lower than
    // the table's Flaky Job Failures for the same days.
    const last7 = (values: readonly (number | null)[]): number =>
        values.slice(-SUMMARY_DAYS).reduce<number>((sum, value) => sum + (value ?? 0), 0);
    assert.equal(last7(stats.processedJobCount), 7464);
    assert.equal(last7(totals), 7568);
    assert.ok(last7(totals) > last7(stats.processedJobCount));
});

test('the breakdown series keeps every date, unlike a rate series', () => {
    // The three bands are stacked and must share an x array, so a day with no
    // jobs is a null percentage rather than a dropped date.
    const file = toMerged(
        syntheticFile({
            dates: ['2026-08-01', '2026-08-02'],
            processedJobCount: [100, 0],
            failedJobs: [10, 0],
            invalidJobs: [2, 0],
            ignoredJobs: [3, 0],
        })
    );
    const points = breakdownSeries(file, testFailedJobSeries(file));
    assert.equal(points.length, 2, 'every date is kept');
    assert.equal(points[0]!.total, 105);
    assert.equal(points[0]!.count, 8);
    assert.equal(points[0]!.percentage, (8 / 105) * 100);
    assert.equal(points[1]!.total, 0);
    assert.equal(points[1]!.percentage, null, 'a zero-total day is a gap, not a zero');
});

test('the test-failed-job series subtracts invalid jobs per day', () => {
    const file = toMerged(
        syntheticFile({
            dates: ['2026-08-01', '2026-08-02'],
            failedJobs: [10, 20],
            invalidJobs: [2, 5],
        })
    );
    assert.deepEqual(testFailedJobSeries(file), [8, 15]);
});

test('the display mode picks the percentage or the numerator', () => {
    const point = { date: '2026-08-03', numerator: 3, denominator: 200, percentage: 1.5 };
    assert.equal(displayValue(point, 'percentage'), 1.5);
    assert.equal(displayValue(point, 'count'), 3);
});

// =========================================================================
// Flavors
// =========================================================================

test('every flavor in the pinned data is one this page shows', () => {
    // The hardcoded list is a presentation choice, but a flavor the data grew
    // and the list lacks would silently vanish from the page.
    assert.deepEqual(unlistedFlavors(mochitest()), []);
    assert.equal(Object.keys(mochitest().flavors ?? {}).length, MOCHITEST_FLAVORS.length);
});

test('unlistedFlavors names a flavor the page would drop', () => {
    const grown = mochitest();
    grown.flavors!['brand-new'] = grown.flavors!['plain']!;
    assert.deepEqual(unlistedFlavors(grown), ['brand-new']);
    // And it really is dropped, which is the behaviour the warning exists for.
    const rows = summaryRows(null, toMerged(grown));
    assert.ok(!rows.map((row) => row.name).includes('brand-new'));
});
