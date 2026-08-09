/**
 * `lib/formats/flaky-backfill.ts`, the committed backfill files, and the two
 * `site/flaky-view.ts` decisions that depend on the window being long.
 *
 * ## Where the golden values come from
 *
 * The committed files are checked by a **second, deliberately different walk**:
 * `mergeFlakyBackfill` is given rows and asked what it produced, while the
 * integrity assertions below re-read the raw JSON with plain `reduce`s and
 * `Date` arithmetic and share no code with the merge. `page-migration-pattern`
 * records four occurrences of a test taking its expected value from the thing
 * under test; the numbers here — 257 xpcshell days, 193 mochitest days, the
 * contiguity of both — were obtained by counting the file, not by asking the
 * library to count it.
 *
 * ## What these tests are defending
 *
 * 1. **The seam.** The whole risk of a backfill is a visible step where the
 *    committed data meets the live artifact. `no visible step at the seam`
 *    asserts the joined series' day-to-day movement at the join is no larger
 *    than the movement it shows elsewhere, which is the property a reader
 *    actually sees.
 * 2. **Live wins, and the disagreement is reported.** Preferring the backfill
 *    would let a stale committed file override a freshly regenerated date, and
 *    resolving silently would throw away the only cross-check the two sources
 *    admit.
 * 3. **No date is counted twice, and none is summed.** `FORMATS.md` records two
 *    agents multiplying a population by summing across encodings of the same
 *    days. A merged series with a duplicated date, or with a total larger than
 *    either source's, is that bug.
 * 4. **The counts chart's third band appears on a long window and not a short
 *    one**, and the caption follows it. A caption asserting stable is omitted
 *    while the plot draws it is worse than no caption.
 */

import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    type FlakyBackfillFile,
    type FlakyBackfillRow,
    BACKFILL_WINDOW_DAYS,
    mergeFlakyBackfill,
} from '../lib/formats/flaky-backfill.ts';
import { decodeIssues, type IssuesFile } from '../lib/formats/issues.ts';
import {
    type FlakyDay,
    flakinessOverTime,
    runningAverage,
    thinDays,
} from '../lib/query/flakiness.ts';
import {
    STABLE_CHART_DAYS,
    chartScopeNote,
    chartSeries,
    countChartNote,
} from '../site/flaky-view.ts';

/**
 * The committed files, read from the repository root rather than from
 * `test/fixtures/`.
 *
 * They *are* the artefact under test — a fixture copy would let the shipped file
 * rot while the test kept passing on a snapshot of it, which is the failure mode
 * a committed data file invites.
 */
async function committed(harness: string): Promise<FlakyBackfillFile> {
    const url = new URL(`../${harness}-flaky-backfill.json`, import.meta.url);
    return JSON.parse(await readFile(url, 'utf8')) as FlakyBackfillFile;
}

const HARNESSES = ['xpcshell', 'mochitest'] as const;

/** Turns a backfill row into the `FlakyDay` shape the page merges into. */
function asDay(row: FlakyBackfillRow, day: number): FlakyDay {
    return { ...row, day };
}

/** A day, for the hand-built merges. */
function day(date: string, flaky: number, stable: number, skipped: number): FlakyDay {
    return { day: 0, date, flaky, stable, skipped, total: flaky + stable + skipped };
}

// --- the committed files --------------------------------------------------

for (const harness of HARNESSES) {
    test(`${harness} backfill is contiguous, sorted and self-consistent`, async () => {
        const file = await committed(harness);
        const rows = file.days;
        assert.ok(rows.length > 0, 'has rows');

        // Independent of `metadata`: recount rather than trust what it says.
        assert.equal(file.metadata.days, rows.length);
        assert.equal(file.metadata.startDate, rows[0]!.date);
        assert.equal(file.metadata.endDate, rows.at(-1)!.date);
        assert.equal(file.metadata.harness, harness);
        assert.equal(file.metadata.windowDays, BACKFILL_WINDOW_DAYS);

        // Sorted, no duplicates, and no missing calendar day. A gap would draw a
        // straight segment across dates that have data available, and a
        // duplicate is the summed-population bug.
        const dates = rows.map((row) => row.date);
        assert.deepEqual(dates, [...dates].sort(), 'sorted by date');
        assert.equal(new Set(dates).size, dates.length, 'no duplicated date');
        const firstMs = Date.parse(`${dates[0]!}T00:00:00Z`);
        for (const [index, date] of dates.entries()) {
            assert.equal(
                date,
                new Date(firstMs + index * 86_400_000).toISOString().slice(0, 10),
                `date ${index} is contiguous`
            );
        }

        for (const row of rows) {
            // `total` is the denominator of every percentage the chart draws, so
            // a row whose parts do not add up would put a percentage over 100.
            assert.equal(
                row.total,
                row.flaky + row.stable + row.skipped,
                `${row.date} total is the sum of its parts`
            );
            assert.ok(row.flaky >= 0 && row.stable >= 0 && row.skipped >= 0, `${row.date} >= 0`);
        }
    });

    test(`${harness} backfill covers months and names the windows it came from`, async () => {
        const file = await committed(harness);
        // Long enough for the counts chart to earn its third band; that is the
        // point of the file, so it is asserted rather than assumed.
        assert.ok(
            file.days.length >= STABLE_CHART_DAYS,
            `${file.days.length} days is at least ${STABLE_CHART_DAYS}`
        );
        // Each source aggregate contributes at most 21 days, so the number of
        // windows bounds the number of days from below.
        assert.ok(
            file.metadata.sourceWindows.length * BACKFILL_WINDOW_DAYS >= file.days.length,
            'the named windows can account for every day'
        );
        assert.deepEqual(
            file.metadata.sourceWindows,
            [...file.metadata.sourceWindows].sort(),
            'source windows are sorted'
        );
    });
}

test('the two harnesses agree on the window and the threshold they were built with', async () => {
    const [xpcshell, mochitest] = await Promise.all(HARNESSES.map(committed));
    // A page loads one harness at a time, so this is not a correctness
    // requirement — but two files built with different filters would make the
    // two harnesses' charts incomparable, which is a thing readers do.
    assert.equal(xpcshell!.metadata.windowDays, mochitest!.metadata.windowDays);
    assert.equal(
        xpcshell!.metadata.minWindowFailures,
        mochitest!.metadata.minWindowFailures
    );
});

// --- the merge ------------------------------------------------------------

test('a null or empty backfill returns the live series unchanged', () => {
    const live = [day('2026-08-02', 1, 2, 3), day('2026-08-01', 4, 5, 6)];
    for (const backfill of [null, []]) {
        const merged = mergeFlakyBackfill(backfill, live, asDay);
        assert.equal(merged.backfilled, 0);
        assert.equal(merged.overlapping, 0);
        assert.deepEqual(merged.disagreements, []);
        // Sorted even with no backfill: the live series is not trusted to be.
        assert.deepEqual(
            merged.days.map((entry) => entry.date),
            ['2026-08-01', '2026-08-02']
        );
    }
});

test('older backfill days go in front and are renumbered from zero', () => {
    const backfill: FlakyBackfillRow[] = [
        { date: '2026-07-30', flaky: 1, stable: 1, skipped: 1, total: 3 },
        { date: '2026-07-31', flaky: 2, stable: 2, skipped: 2, total: 6 },
    ];
    const live = [day('2026-08-01', 9, 9, 9), day('2026-08-02', 8, 8, 8)];
    const merged = mergeFlakyBackfill(backfill, live, asDay);
    assert.deepEqual(
        merged.days.map((entry) => entry.date),
        ['2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02']
    );
    assert.equal(merged.backfilled, 2);
    assert.equal(merged.overlapping, 0);
    // The backfilled days carry 0 and 1, so the joined axis is oldest-first
    // whatever the live file's own indexes were.
    assert.deepEqual(merged.days.slice(0, 2).map((entry) => entry.day), [0, 1]);
});

test('live wins on a shared date and every differing counter is reported', () => {
    const backfill: FlakyBackfillRow[] = [
        { date: '2026-07-31', flaky: 10, stable: 10, skipped: 10, total: 30 },
        // Same date as live, three of four counters different.
        { date: '2026-08-01', flaky: 5, stable: 90, skipped: 5, total: 100 },
    ];
    const live = [day('2026-08-01', 7, 88, 5)];
    const merged = mergeFlakyBackfill(backfill, live, asDay);

    assert.equal(merged.backfilled, 1);
    assert.equal(merged.overlapping, 1);
    // Live's numbers, not the backfill's.
    const shared = merged.days.find((entry) => entry.date === '2026-08-01')!;
    assert.equal(shared.flaky, 7);
    assert.equal(shared.stable, 88);
    // `total` differs too — 100 against 100? No: 7+88+5 is 100, so only flaky
    // and stable differ. Asserted as a list so a fourth key appearing is a
    // failure rather than a silent extra warning.
    assert.deepEqual(merged.disagreements, [
        { date: '2026-08-01', key: 'flaky', backfill: 5, live: 7 },
        { date: '2026-08-01', key: 'stable', backfill: 90, live: 88 },
    ]);
});

test('a shared date is never counted twice and never summed', () => {
    // The bug `FORMATS.md` records: two encodings of the same days added
    // together. A merge that summed would report 200 tests on a day that had
    // 100.
    const shared: FlakyBackfillRow = {
        date: '2026-08-01',
        flaky: 5,
        stable: 90,
        skipped: 5,
        total: 100,
    };
    const merged = mergeFlakyBackfill([shared], [day('2026-08-01', 5, 90, 5)], asDay);
    assert.equal(merged.days.length, 1, 'one date, one row');
    assert.equal(merged.days[0]!.total, 100, 'not 200');
    assert.deepEqual(merged.disagreements, [], 'identical rows do not disagree');
});

test('a backfill ending after the live window does not invert the axis', () => {
    // The bug this locks down. The committed file is regenerated on its own
    // schedule, so it can end *after* the artifact the page loaded — measured on
    // the real mochitest pair, backfill 2026-01-28..2026-08-08 against a live
    // window ending 2026-07-15, leaving 24 backfilled dates newer than the whole
    // live block. Appending live after "the backfill" then produced an x axis
    // reading `… 07-22, 08-05, 07-05 …`, running backwards in the middle.
    const backfill: FlakyBackfillRow[] = [
        { date: '2026-06-01', flaky: 1, stable: 1, skipped: 1, total: 3 },
        // Shared with live.
        { date: '2026-06-02', flaky: 2, stable: 2, skipped: 2, total: 6 },
        // Newer than every live day.
        { date: '2026-06-04', flaky: 4, stable: 4, skipped: 4, total: 12 },
        { date: '2026-06-05', flaky: 5, stable: 5, skipped: 5, total: 15 },
    ];
    const live = [day('2026-06-02', 9, 9, 9), day('2026-06-03', 9, 9, 9)];
    const merged = mergeFlakyBackfill(backfill, live, asDay);

    const dates = merged.days.map((entry) => entry.date);
    assert.deepEqual(dates, [...dates].sort(), 'the axis never runs backwards');
    assert.deepEqual(dates, [
        '2026-06-01',
        '2026-06-02',
        '2026-06-03',
        '2026-06-04',
        '2026-06-05',
    ]);
    // Live still wins the shared date even though it is not the newest source.
    assert.equal(merged.days[1]!.flaky, 9);
    assert.equal(merged.backfilled, 3);
    assert.equal(merged.overlapping, 1);
    // And `day` is the sorted position, not the position within either source.
    assert.deepEqual(
        merged.days.map((entry) => entry.day),
        [0, 1, 2, 3, 4]
    );
});

test('the joined series is sorted even when neither source is', () => {
    const backfill: FlakyBackfillRow[] = [
        { date: '2026-07-31', flaky: 1, stable: 1, skipped: 1, total: 3 },
        { date: '2026-07-29', flaky: 1, stable: 1, skipped: 1, total: 3 },
        { date: '2026-07-30', flaky: 1, stable: 1, skipped: 1, total: 3 },
    ];
    const live = [day('2026-08-02', 1, 1, 1), day('2026-08-01', 1, 1, 1)];
    const merged = mergeFlakyBackfill(backfill, live, asDay);
    assert.deepEqual(
        merged.days.map((entry) => entry.date),
        ['2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02']
    );
});

// --- the seam -------------------------------------------------------------

/**
 * The step at the join, against the steps everywhere else.
 *
 * The failure mode this whole exercise is guarding against is a *visible*
 * discontinuity: a chart that jumps where the committed file stops and the live
 * artifact starts, because the two classified their days differently. It cannot
 * be asserted as "the two agree" — the noise filter's window genuinely moves —
 * so it is asserted the way a reader would see it: the day-to-day change at the
 * join is within the range of day-to-day changes the series shows anyway.
 *
 * `flaky` is the series checked because it is the one the filter acts on, and
 * therefore the one a seam artefact would appear in first.
 */
function steps(days: readonly FlakyDay[]): number[] {
    const out: number[] = [];
    for (let index = 1; index < days.length; index++) {
        // Only between days that both have tests: 2026-07-11 has 128 xpcshell
        // tests against ~4,600 either side, a real gap in the published data,
        // and the step into and out of it dwarfs everything else.
        const previous = days[index - 1]!;
        const current = days[index]!;
        if (previous.total === 0 || current.total === 0) {
            out.push(0);
            continue;
        }
        out.push(Math.abs(current.flaky / current.total - previous.flaky / previous.total));
    }
    return out;
}

for (const harness of HARNESSES) {
    test(`${harness}: no visible step where the backfill meets the live window`, async () => {
        const file = await committed(harness);
        const rows = file.days;
        // The last 21 days of the committed file stand in for the live artifact:
        // they were produced by the same 21-day-window call the page makes on
        // `{harness}-issues.json`, which is exactly the property the 21-day
        // stride buys. So this measures the seam the page will have.
        const cut = rows.length - BACKFILL_WINDOW_DAYS;
        const older = rows.slice(0, cut);
        const live = rows.slice(cut).map((row, index) => asDay(row, index));

        const merged = mergeFlakyBackfill(older, live, asDay);
        assert.equal(merged.days.length, rows.length);
        assert.equal(merged.backfilled, cut);
        assert.equal(merged.overlapping, 0, 'the cut is clean, so nothing overlaps');

        const movement = steps(merged.days);
        // The step across the join, and the worst step anywhere else.
        const atSeam = movement[cut - 1]!;
        const elsewhere = movement.filter((_unused, index) => index !== cut - 1);
        const worstElsewhere = Math.max(...elsewhere);
        assert.ok(
            atSeam <= worstElsewhere,
            `seam step ${(atSeam * 100).toFixed(2)}pp exceeds the worst ordinary step ` +
                `${(worstElsewhere * 100).toFixed(2)}pp`
        );
    });
}

/**
 * The seam against a **separately generated** live artifact.
 *
 * The test above cuts the committed file in two, which proves the merge joins
 * cleanly but cannot prove the committed numbers match what CI publishes — both
 * halves came from the same tool. This one compares the committed backfill
 * against `artifacts/pinned/data/xpcshell-issues.json`, a real published
 * aggregate captured on 2026-08-04 that overlaps the backfill by 21 dates, and it
 * is the check that would catch a decoding bug in the tool.
 *
 * Measured when written, over those 21 shared dates:
 *
 * | | agreement |
 * | --- | --- |
 * | `total` (the population) | **exact on 20 of 21** |
 * | `flaky`, 19 dates | 0–30 tests, ≤0.63pp |
 * | `flaky`, 2026-07-18 | 30 tests (0.63pp) — the noise window moving |
 * | `flaky`, 2026-08-04 | 81 tests (1.67pp), and `total` 4,805 vs 4,809 |
 *
 * 2026-08-04 is the pinned file's own `endDate`, captured part-way through that
 * day, so the backfill legitimately saw four more tests and 81 more flaky ones.
 * `mergeBackfillStats` documents the identical effect on `index.html` — 44 of its
 * 46 backfill-reads-lower disagreements are on the backfill's final date — and it
 * is why **live wins** is the right rule in both directions. So the bound below
 * excludes the two files' shared end date and holds the rest to 1pp.
 *
 * `artifacts/` is gitignored, so this skips where the pinned data is absent
 * rather than failing. A skip is honest; a test that silently asserted nothing
 * would not be.
 */
test('the committed backfill matches a separately published aggregate', async (t) => {
    const url = new URL('../artifacts/pinned/data/xpcshell-issues.json', import.meta.url);
    let pinned: IssuesFile;
    try {
        pinned = JSON.parse(await readFile(url, 'utf8')) as IssuesFile;
    } catch {
        t.skip('artifacts/pinned/data/xpcshell-issues.json is not present');
        return;
    }

    const live = flakinessOverTime(decodeIssues(pinned), {});
    const file = await committed('xpcshell');
    assert.equal(
        live.minWindowFailures,
        file.metadata.minWindowFailures,
        'the same noise threshold, or the comparison is meaningless'
    );
    const byDate = new Map(file.days.map((row) => [row.date, row]));

    // The pinned file's last day is mid-capture: excluded from the bound and
    // asserted separately, so its exclusion is stated rather than hidden.
    const endDate = live.days.at(-1)!.date;
    let shared = 0;
    for (const liveDay of live.days) {
        const row = byDate.get(liveDay.date);
        if (row === undefined) {
            continue;
        }
        shared++;
        if (liveDay.date === endDate) {
            continue;
        }
        assert.equal(
            row.total,
            liveDay.total,
            `${liveDay.date}: the two sources see a different population`
        );
        const drift = Math.abs(row.flaky / row.total - liveDay.flaky / liveDay.total) * 100;
        assert.ok(
            drift < 1,
            `${liveDay.date}: flaky rate drifts ${drift.toFixed(2)}pp ` +
                `(backfill ${row.flaky}, live ${liveDay.flaky}) — more than the noise ` +
                'window can account for'
        );
    }
    assert.ok(shared >= BACKFILL_WINDOW_DAYS, `${shared} shared dates`);
});

// --- the counts chart's third band ---------------------------------------

test('the counts chart adds stable only once the window is long', () => {
    const build = (count: number): FlakyDay[] =>
        Array.from({ length: count }, (_unused, index) =>
            day(
                new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10),
                10,
                80,
                10
            )
        );
    assert.equal(chartSeries(build(STABLE_CHART_DAYS - 1)).showStable, false);
    assert.equal(chartSeries(build(STABLE_CHART_DAYS)).showStable, true);
    // The 21-day artifact on its own keeps exactly the old chart, which is what
    // makes a failed backfill fetch a shortening rather than a change of shape.
    assert.equal(chartSeries(build(BACKFILL_WINDOW_DAYS)).showStable, false);
});

test('the caption never contradicts what the chart drew', () => {
    const short = { showStable: false, labels: new Array(21).fill('07-15'), thinDays: 0 };
    const long = { showStable: true, labels: new Array(250).fill('2026-07-15'), thinDays: 0 };
    assert.match(countChartNote(short), /left out/);
    assert.doesNotMatch(countChartNote(short), /All three states/);
    assert.match(countChartNote(long), /All three states/);
    assert.doesNotMatch(countChartNote(long), /left out/);
    // Each says how wide the window it is describing is, so a reader comparing
    // two loads can tell which one they are looking at.
    assert.match(countChartNote(short), /21 days/);
    assert.match(countChartNote(long), /250 days/);
    // A gap in the line is only mentioned when there is one, and it agrees in
    // number with what the chart actually left blank.
    assert.doesNotMatch(countChartNote(long), /left blank/);
    // Including the pronoun: the singular case is the one that actually occurs
    // on the committed history, and "1 day … on them" is what shipped first.
    assert.match(countChartNote({ ...long, thinDays: 1 }), /1 day is left blank/);
    assert.match(countChartNote({ ...long, thinDays: 1 }), /ran on it, so its rate/);
    assert.match(countChartNote({ ...long, thinDays: 3 }), /3 days are left blank/);
    assert.match(countChartNote({ ...long, thinDays: 3 }), /ran on them, so their rate/);
});

// --- days the tree barely ran on -----------------------------------------

test('a day with almost no tests becomes a gap, not a zero', () => {
    // Twenty ordinary days around one that ran 2% of the usual population —
    // the shape of 2026-07-11 in the published data.
    const days: FlakyDay[] = [];
    for (let index = 0; index < 21; index++) {
        const date = new Date(Date.UTC(2026, 6, 1) + index * 86_400_000)
            .toISOString()
            .slice(0, 10);
        days.push(index === 10 ? day(date, 0, 100, 0) : day(date, 900, 3100, 800));
    }
    const flagged = thinDays(days);
    // Exactly the one day, found without being told which.
    assert.deepEqual(
        flagged.map((thin, index) => (thin ? index : -1)).filter((index) => index >= 0),
        [10]
    );

    const data = chartSeries(days);
    assert.equal(data.thinDays, 1);
    assert.equal(data.flaky[10], null, 'the count is a gap');
    assert.equal(data.flakyPercent[10], null, 'so is the percentage');
    assert.equal(data.average[10], null, 'and the average makes no claim about it');
    // Its neighbours are untouched, and — the point — their averages are not
    // dragged toward zero by a day that ran 100 tests.
    assert.equal(data.flaky[9], 900);
    assert.ok(data.average[9]! > 15, `neighbour average ${String(data.average[9])} is not pulled down`);
    // The date axis keeps the day: dropping it would draw 07-10 beside 07-12 and
    // silently compress the calendar.
    assert.equal(data.labels.length, 21);
    assert.equal(data.total[10], 100, 'the population is reported, unholed');
});

test('a day with no tests at all keeps its old behaviour, not the gap one', () => {
    // `test/flakiness.test.ts` documents that a day CI did not run gets its
    // neighbours' mean rather than `null`, so a smoothed line is not punched
    // through by a missing push. The thin-day rule must not reverse that as a
    // side effect — it is a separate case, about a day with *some* tests.
    const days = [
        day('2026-08-01', 10, 90, 0),
        day('2026-08-02', 0, 0, 0),
        day('2026-08-03', 30, 70, 0),
    ];
    assert.deepEqual(thinDays(days), [false, false, false], 'total 0 is not "thin"');
    assert.equal(runningAverage(days, 3)[1], 20, "still the neighbours' mean");
});

test('an ordinary quiet day is not treated as a gap', () => {
    // Weekend push volume is a fraction of a weekday's, and those days are real
    // measurements. A threshold that caught them would blank two days a week.
    const days = [
        day('2026-07-01', 900, 3100, 800),
        day('2026-07-02', 900, 3100, 800),
        // 60% of the others: quiet, not missing.
        day('2026-07-03', 540, 1860, 480),
        day('2026-07-04', 900, 3100, 800),
        day('2026-07-05', 900, 3100, 800),
    ];
    assert.deepEqual(thinDays(days), [false, false, false, false, false]);
    assert.equal(chartSeries(days).thinDays, 0);
});

for (const harness of HARNESSES) {
    test(`${harness}: the committed history has exactly one gap day`, async () => {
        const file = await committed(harness);
        const days = file.days.map((row, index) => asDay(row, index));
        const flagged = thinDays(days);
        const gaps = days.filter((_unused, index) => flagged[index] === true);
        // Independently: the median population, recomputed here with a plain
        // sort, and the days under a tenth of it.
        const populations = [...days.map((entry) => entry.total)].sort((a, b) => a - b);
        const median = populations[Math.floor(populations.length / 2)]!;
        assert.deepEqual(
            gaps.map((entry) => entry.date),
            days.filter((entry) => entry.total < median * 0.1).map((entry) => entry.date)
        );
        assert.deepEqual(
            gaps.map((entry) => entry.date),
            ['2026-07-11'],
            'the one published aggregation gap'
        );
        // And the choice is not delicate: nothing else is even close to the
        // threshold. See `THIN_DAY_SHARE`.
        const others = days
            .filter((entry) => entry.date !== '2026-07-11')
            .map((entry) => entry.total / median);
        assert.ok(
            Math.min(...others) > 0.9,
            `next thinnest day is ${(Math.min(...others) * 100).toFixed(1)}% of the median`
        );
    });
}

test('the page says so when the charts cover more days than the table', () => {
    // No backfill: the two spans agree, so there is nothing to reconcile and no
    // sentence. The 21-day page must not gain a line explaining a difference it
    // does not have.
    assert.equal(chartScopeNote(21, 21), null);
    assert.equal(chartScopeNote(1, 21), null);
    const note = chartScopeNote(257, 21)!;
    assert.match(note, /257 days/);
    assert.match(note, /21-day window/);
    // Names the reason, not just the numbers: a reader who is told two figures
    // differ and not why will assume one of them is wrong. That is the exact
    // complaint this page already answered once, for the tiles and the table.
    assert.match(note, /daily counts, not the per-test detail/);
});

test('chart labels carry the year only when the window crosses one', () => {
    const sameYear = [day('2026-07-15', 1, 1, 1), day('2026-07-16', 1, 1, 1)];
    assert.deepEqual(chartSeries(sameYear).labels, ['07-15', '07-16']);
    // A year of history crosses New Year, and `12-31` before `01-01` with no
    // year is ambiguous about direction in a way `MM-DD` inside one window
    // never is.
    const crossing = [day('2025-12-31', 1, 1, 1), day('2026-01-01', 1, 1, 1)];
    assert.deepEqual(chartSeries(crossing).labels, ['2025-12-31', '2026-01-01']);
});

test('the committed files really do cross a year, so the labels matter', async () => {
    const file = await committed('xpcshell');
    const years = new Set(file.days.map((row) => row.date.slice(0, 4)));
    assert.ok(years.size > 1, `xpcshell history spans ${[...years].sort().join(', ')}`);
});
