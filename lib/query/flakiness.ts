/**
 * How flaky the tree is: every test classified **per day**, and by folder.
 *
 * Behind `flaky.html`. Where `issues.ts` ranks the tests that are not clean,
 * this answers a narrower question about the same file — on any given day, what
 * fraction of the tests that ran were flaky — and rolls that up a directory
 * tree.
 *
 * ## Why the classification is per day and not per window
 *
 * The obvious reading of "a test is flaky if it failed at least once" is over
 * the whole file, and on the 21-day aggregate that reading is not useful.
 * Measured on the pinned 2026-07-15..2026-08-04 xpcshell aggregate, which holds
 * ~38.9M runs:
 *
 * | window | flaky | stable | skipped |
 * | --- | --- | --- | --- |
 * | whole 21 days | **4,053** (83.8%) | 551 | 203 |
 * | one day, typical | ~930 (19%) | ~3,120 | ~758 |
 *
 * 84% is not a finding about Firefox, it is a finding about the denominator: a
 * test runs on dozens of configurations dozens of times a day, so over 21 days
 * almost any test has failed somewhere at least once. The per-day figure is the
 * one that moves when the tree gets better or worse, so it is the one plotted.
 *
 * **The per-day split is verified against independent files**, not assumed from
 * the encoding. The aggregate's last day reproduces the standalone daily file
 * for the same date exactly — 928 flaky tests in `xpcshell-2026-08-04.json`,
 * 930 in day 20 of the aggregate, with 928 of 928 the same test paths — and day
 * 19 matches `xpcshell-2026-08-03.json` the same way. Two independently
 * generated aggregates whose windows overlap by 20 days agree on the rate of
 * **every** shared date to 0.1pp.
 *
 * That check also settled a real scare. The oldest day of the pinned file reads
 * 65.7% flaky against ~19% for its neighbours, which looks exactly like a
 * delta-decoding bug landing every group's first entry on day 0. It is not: in
 * the older snapshot, whose window starts a day earlier, the same 65.7% sits on
 * day **1** and day 0 reads 18.7%. The spike tracks the *date* 2026-07-15 and
 * not the edge of the window, so it is a genuinely bad day in the tree and is
 * plotted as one. Mochitest shows no such day. No day is special-cased here.
 *
 * ## The three states
 *
 * A test is classified within one day, over the runs it had that day:
 *
 * - **flaky** — it failed at least once (fail, timeout or crash);
 * - **skipped** — it did not fail, and was skipped on at least one
 *   configuration;
 * - **stable** — it did not fail and was not skipped anywhere: 100% pass.
 *
 * The order matters and is the definition the page states: failing beats being
 * skipped, so a test that failed on Linux and is disabled on Windows is flaky
 * rather than skipped. A test with no runs at all that day is in **no** state
 * and is left out of both numerator and denominator — the tree has ~4,800
 * xpcshell tests but a given day only exercises the ones its pushes scheduled.
 *
 * `run-if` skips are not skips, matching `issues.html` and `lib/query/issues.ts`:
 * a test scoped to another platform is not disabled here. `EXPECTED-FAIL`
 * counts as a pass, because a `fail-if` test that fails did what the manifest
 * told it to.
 *
 * ## The noise filter
 *
 * A test that failed **once** in 21 days is not a flaky test, it is one bad
 * run, and counting it makes the daily rate jitter on single events. So a test
 * whose failures over the whole window total `minWindowFailures` or fewer has
 * those failures read as passes — the runs stay in the denominator, they just
 * stop being failures.
 *
 * This is a window-level decision applied to daily figures deliberately: the
 * question "was this one unlucky run?" cannot be answered from inside a single
 * day. Measured on the pinned xpcshell aggregate, with the default of 1:
 *
 * | threshold | tests neutralised | mean daily flaky% |
 * | --- | --- | --- |
 * | 0 (off) | 0 | 18.19 |
 * | **1** (default) | **186** | **18.00** |
 * | 2 | 1,456 | 17.56 |
 * | 3 | 2,050 | 16.71 |
 *
 * 1 is the default because it is the only threshold that removes single events
 * and nothing else. 2 already neutralises 1,456 tests — a test failing twice in
 * three weeks is a real intermittent — so the filter is exposed as a parameter
 * rather than fixed, and the page says which value it used.
 */

import type { DecodedTimingFile } from '../formats/decode.ts';
import { classifyStatus } from '../model/status.ts';
import { skipReason } from '../model/skips.ts';

/** Which of the three states a test was in on one day. */
export type FlakyState = 'flaky' | 'stable' | 'skipped';

/** How many tests were in each state. */
export interface FlakyCounts {
    flaky: number;
    stable: number;
    skipped: number;
}

/**
 * A folder's counts, where **flaky and skipped overlap**.
 *
 * The charts at the top of the page need three mutually exclusive states so a
 * stacked area and a set of percentages that add to 100 mean something — there,
 * flaky wins over skipped and a test lands in exactly one bucket.
 *
 * The table wants a different thing, and this is it: "how many tests here are
 * skipped somewhere" is a question about skipping, and answering it with only
 * the tests that never failed hides most of them. Measured on the pinned
 * xpcshell window, **800 of 4,807 tests are both flaky and skipped** — so the
 * exclusive reading reports 233 skipped where the honest answer is 1,033, a
 * factor of 4.4.
 *
 * The cost is that `flaky + stable + skipped` no longer equals `total`; it
 * overshoots by `flakyAndSkipped`. That is a property of overlapping categories
 * rather than a bug, so the overlap is **named** here and the page gives the
 * skip percentage its own denominator instead of implying the three are parts of
 * one whole.
 */
export interface OverlappingCounts extends FlakyCounts {
    /** Tests that were flaky **and** skipped. Counted in both columns. */
    flakyAndSkipped: number;
}

/** One day of the window. */
export interface FlakyDay extends FlakyCounts {
    /** Absolute day index within the file, 0 = oldest. */
    day: number;
    /** `YYYY-MM-DD`. */
    date: string;
    /**
     * Tests that ran or were skipped that day — `flaky + stable + skipped`.
     *
     * Named rather than left to the caller because it is the denominator of
     * every percentage on the page, and a caller that reconstructed it from two
     * of the three would get a different number on a day with no skips.
     */
    total: number;
}

/** Options for `flakinessOverTime` and `flakinessByFolder`. */
export interface FlakinessOptions {
    /**
     * Ignore a test whose failures over the **whole window** total this or
     * fewer, reading them as passes. `0` disables the filter. Default `1`.
     */
    minWindowFailures?: number | undefined;
    /** Only tests whose path starts with this. */
    pathPrefix?: string | undefined;
}

/** The default noise filter: a single failure in the window is one bad run. */
export const DEFAULT_MIN_WINDOW_FAILURES = 1;

/**
 * The shortest window the noise filter is meaningful over, in days.
 *
 * The filter asks "was this one unlucky run over a long period?", and that
 * question cannot be answered from a single day's data: on a one-day file
 * "failed no more than once in the window" means "failed once today", which is
 * what most intermittents look like on most days. Measured on the pinned
 * 2026-08-04 xpcshell pair, both describing the same 4,805 tests:
 *
 * | | filter off | threshold 1 |
 * | --- | --- | --- |
 * | 21-day aggregate, day 20 | 930 flaky | **923** (7 neutralised) |
 * | standalone daily file | 928 flaky | **562** (366 neutralised) |
 *
 * The two agree to 2 tests with the filter off and disagree by 361 with it on,
 * because the daily file's "window" is one day. So the filter is **skipped
 * entirely** on files shorter than this, rather than applied to a window it
 * cannot judge — a caller asking for it on a daily file gets the unfiltered
 * classification and `neutralisedTests: 0`, which is the honest answer.
 */
export const MIN_FILTERABLE_DAYS = 2;

/**
 * One test's day-by-day outcome counts, with the window totals that decide
 * whether the noise filter neutralises it.
 */
interface TestDays {
    /** Failing runs per day, before the noise filter. */
    fail: Int32Array;
    /** Passing runs per day, `EXPECTED-FAIL` included. */
    pass: Int32Array;
    /** Skipped runs per day, `run-if` excluded. */
    skip: Int32Array;
    /** Failing runs over the whole window. */
    windowFailures: number;
}

/**
 * Walks one test's runs into per-day counters.
 *
 * One pass over the entries, three integer arrays out. `PLAN.md` §4's rule
 * about not materializing an object per run applies with force here: the
 * aggregate holds ~38.9M xpcshell runs and ~172M mochitest ones.
 */
function testDays(file: DecodedTimingFile, testId: number, days: number): TestDays {
    const row: TestDays = {
        fail: new Int32Array(days),
        pass: new Int32Array(days),
        skip: new Int32Array(days),
        windowFailures: 0,
    };
    for (const entry of file.runsOfTest(testId)) {
        // A daily file's entries carry no day; everything lands on the single
        // bucket, which is what makes this work unchanged on both shapes.
        const day = entry.day ?? 0;
        if (day < 0 || day >= days) {
            continue;
        }
        // `day` is bounds-checked above, so every read below is in range; the
        // assertions are for `noUncheckedIndexedAccess`, which types a typed
        // array read as possibly `undefined`.
        switch (classifyStatus(entry.status).kind) {
            case 'pass':
            case 'expected-fail':
                row.pass[day] = row.pass[day]! + entry.count;
                break;
            case 'fail':
            case 'timeout':
            case 'crash':
                row.fail[day] = row.fail[day]! + entry.count;
                row.windowFailures += entry.count;
                break;
            case 'skip':
                if (skipReason(entry.message) !== 'run-if') {
                    row.skip[day] = row.skip[day]! + entry.count;
                }
                break;
            case 'unknown':
                break;
        }
    }
    return row;
}

/**
 * Whether the noise filter neutralises this test's failures.
 *
 * `windowFailures > 0` is part of the test so that a threshold of 0 cannot
 * neutralise a clean test — `0 <= 0` is true, and a "neutralised" test with no
 * failures would still be classified as stable, but the count of neutralised
 * tests the page reports would be every clean test in the tree.
 */
function isNoise(row: TestDays, minWindowFailures: number): boolean {
    return row.windowFailures > 0 && row.windowFailures <= minWindowFailures;
}

/**
 * Which state a test was in on one day, or `null` if it had no runs that day.
 *
 * `neutralised` folds the day's failures into its passes rather than dropping
 * them, so a test whose only run that day was the one filtered failure still
 * counts as a test that ran — dropping it instead would shrink the denominator
 * on exactly the days the filter fires.
 */
function stateOn(row: TestDays, day: number, neutralised: boolean): FlakyState | null {
    const failed = neutralised ? 0 : row.fail[day]!;
    const passed = row.pass[day]! + (neutralised ? row.fail[day]! : 0);
    const skipped = row.skip[day]!;
    if (failed > 0) {
        return 'flaky';
    }
    if (skipped > 0) {
        return 'skipped';
    }
    return passed > 0 ? 'stable' : null;
}

/**
 * The one state a test is in across the whole window.
 *
 * The same precedence a single day uses between configurations — flaky beats
 * skipped beats stable — applied between days. A test that failed once in three
 * weeks is flaky; one that never failed but was disabled somewhere is skipped;
 * only a test that was clean every day it ran is stable. `null` when it did not
 * run at all in the window.
 *
 * Counting the test **once** is the point: the alternative, one count per day,
 * lets the same test be both flaky and stable in one row and turns the
 * denominator into test-days. See `FolderOptions.allDays`.
 */
/**
 * Whether a test was skipped anywhere, independently of whether it also failed.
 *
 * The table's skipped column, which is not the exclusive `stateOn`/`windowState`
 * verdict: a test that failed on Linux and is disabled on Windows is flaky *and*
 * skipped, and both facts are worth a column. See `OverlappingCounts`.
 *
 * `day` is a single day, or `null` for every day from `from` to the end — which
 * is the whole window at the default `from` of 0, and the trailing window under
 * `FolderOptions.fromDay`.
 */
function wasSkipped(row: TestDays, days: number, day: number | null, from = 0): boolean {
    if (day !== null) {
        return (row.skip[day] ?? 0) > 0;
    }
    for (let index = from; index < days; index++) {
        if (row.skip[index]! > 0) {
            return true;
        }
    }
    return false;
}

function windowState(
    row: TestDays,
    days: number,
    neutralised: boolean,
    from = 0
): FlakyState | null {
    let sawSkip = false;
    let sawPass = false;
    for (let day = from; day < days; day++) {
        switch (stateOn(row, day, neutralised)) {
            case 'flaky':
                return 'flaky';
            case 'skipped':
                sawSkip = true;
                break;
            case 'stable':
                sawPass = true;
                break;
            case null:
                break;
        }
    }
    if (sawSkip) {
        return 'skipped';
    }
    return sawPass ? 'stable' : null;
}

/** `metadata.startDate` plus `day` days, as `YYYY-MM-DD`. */
export function dateOfDay(startDate: string, day: number): string {
    const start = Date.parse(`${startDate}T00:00:00Z`);
    if (Number.isNaN(start)) {
        return startDate;
    }
    return new Date(start + day * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The window's first date, derived from `endDate` and the number of days.
 *
 * `AggregateMetadata` carries `startDate`, but `DecodedTimingFile` deliberately
 * does not — it is family-independent and the daily files have no window. So
 * the caller passes the decoded file and this reconstructs the first day from
 * the two fields that *are* on it.
 */
export function startDateOf(file: DecodedTimingFile): string {
    const days = file.days ?? 1;
    const end = Date.parse(`${file.endDate}T00:00:00Z`);
    if (Number.isNaN(end)) {
        return file.endDate;
    }
    return new Date(end - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** Every test's per-day rows, plus how many the noise filter neutralised. */
interface Walked {
    rows: TestDays[];
    /** Parallel to `rows`: whether the filter neutralised that test. */
    neutralised: boolean[];
    /** How many tests the filter neutralised. */
    neutralisedCount: number;
    days: number;
    startDate: string;
    /** The threshold actually applied, which is 0 on a too-short window. */
    minWindowFailures: number;
}

/** The one walk over the file both public entry points share. */
function walk(file: DecodedTimingFile, options: FlakinessOptions, testIds?: number[]): Walked {
    const days = file.days ?? 1;
    // The filter needs a window to judge "one unlucky run" against; a one-day
    // file has none, and applying it there neutralises every test that failed
    // once today. See `MIN_FILTERABLE_DAYS`.
    const minWindowFailures =
        days < MIN_FILTERABLE_DAYS
            ? 0
            : (options.minWindowFailures ?? DEFAULT_MIN_WINDOW_FAILURES);
    const rows: TestDays[] = [];
    const neutralised: boolean[] = [];
    let neutralisedCount = 0;

    const ids =
        testIds ?? Array.from({ length: file.testCount }, (_unused, index) => index);
    for (const testId of ids) {
        const row = testDays(file, testId, days);
        const noise = isNoise(row, minWindowFailures);
        rows.push(row);
        neutralised.push(noise);
        if (noise) {
            neutralisedCount++;
        }
    }
    return {
        rows,
        neutralised,
        neutralisedCount,
        days,
        startDate: startDateOf(file),
        minWindowFailures,
    };
}

/** Which tests pass the path filter, as ids. */
function selectTests(file: DecodedTimingFile, pathPrefix: string | undefined): number[] {
    const ids: number[] = [];
    for (let testId = 0; testId < file.testCount; testId++) {
        if (
            pathPrefix !== undefined &&
            !file.testAt(testId).fullPath.startsWith(pathPrefix)
        ) {
            continue;
        }
        ids.push(testId);
    }
    return ids;
}

/** What `flakinessOverTime` returns. */
export interface FlakinessSeries {
    /** One entry per day, oldest first. */
    days: FlakyDay[];
    /** How many tests the noise filter neutralised. */
    neutralisedTests: number;
    /**
     * The threshold actually applied — **0 on a single-day file**, whatever the
     * caller asked for. See `MIN_FILTERABLE_DAYS`. Report this rather than the
     * requested value, so a page cannot claim a filter it did not apply.
     */
    minWindowFailures: number;
}

/**
 * The per-day flaky/stable/skipped counts across the window.
 *
 * The series the page plots. A day with no runs at all — which the aggregates
 * do not contain, but a truncated file could — still gets an entry, with
 * `total: 0`, so the x axis stays a calendar rather than skipping dates.
 */
export function flakinessOverTime(
    file: DecodedTimingFile,
    options: FlakinessOptions = {}
): FlakinessSeries {
    const ids = selectTests(file, options.pathPrefix);
    const { rows, neutralised, neutralisedCount, days, startDate, minWindowFailures } = walk(
        file,
        options,
        ids
    );

    const series: FlakyDay[] = [];
    for (let day = 0; day < days; day++) {
        const counts: FlakyCounts = { flaky: 0, stable: 0, skipped: 0 };
        for (let index = 0; index < rows.length; index++) {
            const state = stateOn(rows[index]!, day, neutralised[index]!);
            if (state !== null) {
                counts[state]++;
            }
        }
        series.push({
            day,
            date: dateOfDay(startDate, day),
            ...counts,
            total: counts.flaky + counts.stable + counts.skipped,
        });
    }

    return { days: series, neutralisedTests: neutralisedCount, minWindowFailures };
}

/**
 * The share of a typical day's population below which a day is a data gap
 * rather than a quiet day.
 *
 * A day with `total: 0` is unambiguous and was always skipped. A day with *some*
 * tests is the hard case, and the published data has one: **2026-07-11**, where
 * an aggregation gap left 128 of ~4,600 xpcshell tests and 45 of ~20,400
 * mochitest ones. Classified normally that day reads 0% flaky, which plotted
 * against its neighbours' 18% is a notch to the axis that looks like a rendering
 * fault and drags the 7-day mean down through a week either side of it.
 *
 * 10% of the median is the threshold, and the data says the choice is not
 * delicate. Over the ~250 committed days per harness, sorted by population as a
 * share of that harness's median:
 *
 * | | xpcshell | mochitest |
 * | --- | --- | --- |
 * | thinnest day (2026-07-11) | **2.8%** | **0.2%** |
 * | next thinnest | 96.9% | 97.9% |
 *
 * There is nothing between 3% and 97%: a day either ran the tree or did not.
 * Any threshold in that gap picks out the same single day, so 10% is a round
 * number in the middle of a chasm rather than a tuned parameter.
 *
 * The median, not the mean, because the mean is what the outlier moves.
 */
export const THIN_DAY_SHARE = 0.1;

/**
 * Which days ran so few tests that their rate is not a measurement.
 *
 * Returns a parallel array of booleans rather than filtering, because the *date*
 * axis has to keep the day — dropping 2026-07-11 from the series would draw
 * 07-10 next to 07-12 and silently compress the calendar. The caller plots a gap
 * instead. See `THIN_DAY_SHARE`.
 *
 * **A day with no tests at all is not "thin" here.** It is `total === 0`, which
 * every caller already handles and which `runningAverage` has always given its
 * neighbours' mean rather than `null` — a documented choice, so that a day CI did
 * not run does not punch a hole through a smoothed line. This function is about
 * the harder case that choice does not cover: a day with *some* tests, few enough
 * that its rate is noise. Folding the two together would reverse the older
 * decision as a side effect, which is how a fix becomes a regression.
 */
export function thinDays(days: readonly FlakyDay[]): boolean[] {
    const populations = days.map((day) => day.total).filter((total) => total > 0);
    if (populations.length === 0) {
        return days.map(() => false);
    }
    populations.sort((a, b) => a - b);
    const median = populations[Math.floor(populations.length / 2)]!;
    const floor = median * THIN_DAY_SHARE;
    return days.map((day) => day.total > 0 && day.total < floor);
}

/**
 * A centred running mean of the flaky percentage.
 *
 * Centred rather than trailing: this is a fixed historical window being read as
 * a shape, not a live signal being smoothed as it arrives, so aligning the mean
 * with the day it describes is what makes a bump sit over the day that caused
 * it. A trailing mean would shift every feature `window / 2` days later.
 *
 * The ends are averaged over whatever days exist rather than left undefined, so
 * the smoothed line spans the same axis as the raw one. That makes the first
 * and last points averages of fewer days — which is why the page draws the raw
 * series too rather than the average alone.
 *
 * Days with no tests at all contribute nothing and are skipped, so a gap in the
 * data does not pull the mean toward zero — and so do days that ran so few that
 * their rate is not a measurement, which is the case `THIN_DAY_SHARE` exists for
 * and the reason this takes a second pass over `days` before averaging. A day
 * that is itself thin gets `null` rather than its neighbours' mean: the average
 * is a statement about that day, and it has no data to make one from.
 */
export function runningAverage(days: readonly FlakyDay[], window = 7): (number | null)[] {
    const half = Math.floor(window / 2);
    const thin = thinDays(days);
    return days.map((_unused, index) => {
        if (thin[index] === true) {
            return null;
        }
        let flaky = 0;
        let total = 0;
        for (let offset = -half; offset <= half; offset++) {
            const day = days[index + offset];
            if (day === undefined || day.total === 0 || thin[index + offset] === true) {
                continue;
            }
            flaky += day.flaky;
            total += day.total;
        }
        return total === 0 ? null : (flaky / total) * 100;
    });
}

/**
 * One test file sitting directly in a folder.
 *
 * The bottom level of the tree. A test is classified in exactly the same three
 * states as a folder, so it carries the same counters — but for a single test
 * on a single day at most one of them is 1 and the rest are 0, which is what
 * makes a leaf row read as a state rather than as a distribution. Over the
 * whole window (`allDays`) all three can be non-zero, and then the counts are
 * how many *days* the test spent in each state.
 */
export interface TestLeaf extends OverlappingCounts {
    /** The full path, e.g. `dom/base/test/test_a.js`. */
    fullPath: string;
    /** The file name alone, for display under its folder. */
    name: string;
    /** `flaky + stable + skipped` — days counted, 1 in single-day mode. */
    total: number;
    /** Failing runs over the whole window, before the noise filter. */
    windowFailures: number;
    /** Whether the noise filter neutralised this test. */
    neutralised: boolean;
}

/** One node of the folder tree. */
export interface FolderNode extends OverlappingCounts {
    /** Full path of this folder, `''` for the root. */
    path: string;
    /** The last segment, for display. `''` for the root. */
    name: string;
    /** `flaky + stable + skipped`, the denominator of the percentages. */
    total: number;
    /** Direct subfolders, ranked by descending flaky count. */
    children: FolderNode[];
    /**
     * The test files directly in this folder, ranked the same way.
     *
     * Only the tests *at* this level, not the subtree's — a test in
     * `dom/base/test` is a leaf of that folder and appears nowhere else, so
     * expanding a folder shows its own files plus its subfolders and nothing is
     * listed twice.
     */
    tests: TestLeaf[];
    /**
     * How many test files are at or below this folder and were counted.
     *
     * Not the same as `total` when a folder's tests were classified on a day
     * they did not all run: `total` counts *classified tests*, this counts the
     * distinct files behind them, which is what a reader compares against
     * Searchfox.
     */
    testCount: number;
}

/** Options for `flakinessByFolder`. */
export interface FolderOptions extends FlakinessOptions {
    /**
     * Which day to classify on, as an absolute day index. Defaults to the most
     * recent day in the file.
     *
     * A single day rather than the window, for the reason at the top of this
     * file: over 21 days 84% of tests have failed at least once, and a table
     * where every folder reads 80-90% ranks nothing.
     */
    day?: number | undefined;
    /**
     * Classify over the whole window instead of one day, still counting each
     * test **once**.
     *
     * A test is flaky if it was flaky on *any* day, skipped if it was never
     * flaky but skipped on at least one day, and stable only if it was stable
     * every day it ran. So the three states stay mutually exclusive and a
     * folder's `total` is a number of test files, exactly as in single-day
     * mode — the two tables measure the same thing over different windows and
     * can be compared directly.
     *
     * **This deliberately replaced a per-test-day count.** The earlier version
     * added one count per day a test ran, which made a single test worth 21
     * rows, let the *same* test be counted as 15 flaky and 6 stable at once,
     * and turned the column into test-days: 4,805 tests read as 100,716. The
     * percentage then answered "what share of test-days were flaky", which is
     * not the question the rest of the page asks, while sharing its column
     * header. See the note on the loose bar below.
     *
     * **The bar is loose over a long window, by construction.** "Failed at
     * least once in 21 days" is close to 84% of xpcshell tests tree-wide, which
     * is the measurement at the top of this file and the reason the *chart* is
     * per-day. It is still the right rule for this table — a folder ranked by
     * how many of its tests have ever been flaky is actionable — but it is why
     * the noise filter matters more here than in single-day mode.
     */
    allDays?: boolean | undefined;
    /**
     * The **oldest** day of an `allDays` verdict, as an absolute day index.
     *
     * Only read when `allDays` is true, and ignored otherwise: it narrows the
     * "flaky on ANY day" verdict from the whole file to a trailing window, using
     * the same `windowState` precedence — flaky beats skipped beats stable — so a
     * test flaky on one of those days and skipped on another is still
     * flaky-and-skipped. Every leaf stays 0 or 1 and `total` stays 1, exactly as
     * with `allDays` alone; the only thing that moves is how many days the verdict
     * looked at.
     *
     * It exists because neither of the two existing shapes is the window the
     * folder ranking uses. The ranking averages `DEFAULT_AVERAGE_DAYS` days of
     * per-day verdicts, and a reader who drills into one of its rows must not
     * cross into a different window: measured on the pinned file for
     * `toolkit/components/telemetry/tests/unit`, one day finds 29 flaky tests
     * where the ranking's 7 days contain 32, so three tests the ranking counted
     * were silently absent from the drill-down.
     *
     * A per-test verdict over 7 days is **not** an approximation of the ranking's
     * mean and cannot be compared to it as a number: the ranking says 26.7 flaky
     * tests on a typical day, this says 32 distinct tests were flaky at least once
     * across those days. Both are correct over the same 7 days. Only the *window*
     * is shared, which is the thing a drill-down has to inherit.
     *
     * The noise filter is unaffected: it is judged over the whole file however
     * narrow this window is, which is the asymmetry `MIN_FILTERABLE_DAYS`
     * documents.
     */
    fromDay?: number | undefined;
}

/**
 * The folder tree, each node carrying the counts of every test beneath it.
 *
 * Built by walking each test's path once and adding its state to every ancestor
 * — so a node's numbers are the subtree's, which is what makes the table
 * drillable: opening a folder shows children that sum to the parent.
 *
 * The root node is returned; its `path` is `''` and its counts are the whole
 * selection's, so the caller does not need a separate total row.
 *
 * Three windows, all giving **one verdict per test**: `day` (or none, meaning the
 * most recent day), `allDays` for the whole file, and `allDays` with `fromDay` for
 * a trailing window of it. See `FolderOptions`.
 */
export function flakinessByFolder(
    file: DecodedTimingFile,
    options: FolderOptions = {}
): FolderNode {
    const ids = selectTests(file, options.pathPrefix);
    const { rows, neutralised, days } = walk(file, options, ids);
    const lastDay = days - 1;
    const day = options.day ?? lastDay;
    // Clamped rather than refused, as `flakinessByFolderAveraged` clamps its own
    // window: asking for the last 7 days of a 3-day file is a reasonable thing to
    // type and the answer is the days that exist. 0 keeps `allDays` meaning the
    // whole file, so an existing caller passing no `fromDay` is unchanged.
    const fromDay = Math.max(0, Math.min(options.fromDay ?? 0, lastDay));

    const root: FolderNode = {
        path: '',
        name: '',
        flaky: 0,
        stable: 0,
        skipped: 0,
        flakyAndSkipped: 0,
        total: 0,
        testCount: 0,
        children: [],
        tests: [],
    };
    // Every node by full path, so an ancestor is found rather than searched for.
    const byPath = new Map<string, FolderNode>([['', root]]);

    for (let index = 0; index < ids.length; index++) {
        const row = rows[index]!;
        const noise = neutralised[index]!;

        // The **exclusive** verdict, which is what `total` counts and what the
        // charts use: over the window it is the worst state the test reached on
        // any day, flaky beating skipped beating stable.
        const state =
            options.allDays === true
                ? windowState(row, days, noise, fromDay)
                : stateOn(row, day, noise);
        if (state === null) {
            continue;
        }
        // ...and separately, whether it was skipped at all. A test can be both,
        // and in the table both facts count — see `OverlappingCounts`. So the
        // skipped column is this, not `state === 'skipped'`. Over the same days
        // the verdict looked at, or the drill-down would report a skip from
        // outside its own window.
        const skipped = wasSkipped(row, days, options.allDays === true ? null : day, fromDay);
        const both = state === 'flaky' && skipped;

        const identity = file.testAt(ids[index]!);
        const { directory } = identity;
        // Each ancestor from the root down, so `dom/base/test` credits `dom`,
        // `dom/base` and `dom/base/test`.
        const segments = directory === '' ? [] : directory.split('/');
        let path = '';
        let node = root;
        /** Adds this test to one node's counters. */
        const credit = (target: FolderNode): void => {
            // `total` follows the exclusive verdict, so it stays a test count.
            target[state]++;
            target.total++;
            // The skipped column double-counts a flaky-and-skipped test on
            // purpose; `state` already added it when it was skipped-only.
            if (both) {
                target.skipped++;
                target.flakyAndSkipped++;
            }
            target.testCount++;
        };
        credit(node);
        for (const segment of segments) {
            path = path === '' ? segment : `${path}/${segment}`;
            let child = byPath.get(path);
            if (child === undefined) {
                child = {
                    path,
                    name: segment,
                    flaky: 0,
                    stable: 0,
                    skipped: 0,
                    flakyAndSkipped: 0,
                    total: 0,
                    testCount: 0,
                    children: [],
                    tests: [],
                };
                byPath.set(path, child);
                node.children.push(child);
            }
            credit(child);
            node = child;
        }

        // The leaf goes on the folder the file actually lives in, which is
        // `node` after the walk — so a test is listed once, under its own
        // directory, and never repeated up the ancestry.
        const leaf: TestLeaf = {
            fullPath: identity.fullPath,
            name: identity.fullPath.slice(identity.fullPath.lastIndexOf('/') + 1),
            flaky: 0,
            stable: 0,
            skipped: 0,
            flakyAndSkipped: both ? 1 : 0,
            // One test, so `total` is 1 — the exclusive verdict's bucket.
            total: 1,
            windowFailures: row.windowFailures,
            neutralised: noise,
        };
        leaf[state]++;
        // A flaky-and-skipped test shows 1 in both columns, which is what makes
        // a leaf row read the same way as the folder row above it.
        if (both) {
            leaf.skipped++;
        }
        node.tests.push(leaf);
    }

    sortTree(root);
    return root;
}

/**
 * Ranks each node's children by flaky count, then by path.
 *
 * By count and not by percentage: a folder holding one test that failed is 100%
 * flaky and is not the folder to look at first. The percentage is what the row
 * is *coloured* by, and the count is what it is *ordered* by, so the two
 * together say "this is big and this is bad" without either being able to lie
 * on its own.
 */
function sortTree(node: FolderNode): void {
    node.children.sort((a, b) => b.flaky - a.flaky || a.path.localeCompare(b.path));
    // Leaves by the same rule, so a folder's worst test is at the top of its
    // list for the same reason its worst subfolder is at the top of the tree.
    node.tests.sort((a, b) => b.flaky - a.flaky || a.fullPath.localeCompare(b.fullPath));
    for (const child of node.children) {
        sortTree(child);
    }
}

/**
 * The days a folder view should average over by default.
 *
 * Seven, and it has to be a whole number of weeks. Push volume drops several-fold
 * at weekends — `FORMATS.md` measures 2.6× on both harnesses, which is why
 * `dateWithWeekday` exists and why `lib/query/summary.ts` compares 7 days against
 * the prior 7 — so a folder ranking taken from *one* day reports the calendar as
 * flakiness. Measured on the pinned xpcshell window, the same folders across four
 * consecutive days:
 *
 * | folder | Sat 08-01 | Sun 08-02 | Mon 08-03 | Tue 08-04 |
 * | --- | --- | --- | --- | --- |
 * | `netwerk/test/unit` | 127 | **76** | 121 | **137** |
 * | `dom/indexedDB/test/unit` | 24 | 24 | **53** | 35 |
 *
 * `netwerk/test/unit` swings 1.8× between Sunday and Tuesday without anything
 * having changed in the tree, and `dom/indexedDB` is 4th on Sunday and 3rd on
 * Monday at more than double the count. A reader who ran the ranking on a Monday
 * would be looking at Sunday's fraction of the runs.
 *
 * Averaging the *per-day classifications* rather than widening the window to 7
 * days is the other half of the choice, and the distinction is the one at the top
 * of this file: "failed at least once in 7 days" inflates toward the same 84% the
 * 21-day reading gives, while the mean of seven daily verdicts stays a daily
 * verdict. `flaky.html`'s headline tiles average the same 7 days for the same
 * reason (`site/flaky-view.ts`'s `AVERAGE_WINDOW`), so the two agree by
 * construction rather than by coincidence.
 */
export const DEFAULT_AVERAGE_DAYS = 7;

/**
 * The folder tree, averaged over the last `days` days of per-day classifications.
 *
 * The weekday-robust version of `flakinessByFolder`, and the one a ranking wants:
 * see `DEFAULT_AVERAGE_DAYS` for the measurement that makes a single day the wrong
 * default. Every count on every node is a **mean per day**, so it is fractional —
 * `187.0` flaky tests is "on a typical day in this window, 187 of this folder's
 * tests were flaky", which is exactly what a burndown estimate wants and is not a
 * number of test files. Callers that need integers round at the edge, once.
 *
 * Built on one `walk` and one tree, accumulating **integer test-days** and dividing
 * the finished tree by the window once — so the file is decoded once however wide
 * the window, and the subtree sums that make the tree drillable still hold.
 *
 * The division order is not a detail. Adding `1 / windowDays` per day instead loses
 * exactness — seven additions of 1/7 do not make 1 — and the error is not
 * cosmetic: a folder whose 131 tests are skipped every day read
 * `130.99999999999997`, and every `subtreeFlaky === selfFlaky` test came out false
 * by ~3.6e-14, which turned a column that should appear on 4 rows of 250 into one
 * that appeared on all of them.
 *
 * `windowDays` reports how many days were actually averaged, which is fewer than
 * asked for on a short file. A caller must print that rather than the request, for
 * the same reason `FlakinessSeries.minWindowFailures` reports the applied
 * threshold: a view claiming a 7-day average of a 3-day file is a wrong label on
 * right numbers.
 */
export interface AveragedFolders {
    root: FolderNode;
    /** How many days were averaged. */
    windowDays: number;
    /** The dates averaged, oldest first. */
    dates: string[];
}

export function flakinessByFolderAveraged(
    file: DecodedTimingFile,
    options: FlakinessOptions & { averageDays?: number | undefined } = {}
): AveragedFolders {
    const ids = selectTests(file, options.pathPrefix);
    const { rows, neutralised, days, startDate } = walk(file, options, ids);
    const wanted = options.averageDays ?? DEFAULT_AVERAGE_DAYS;
    // Clamped rather than refused: asking for a 7-day average of a 3-day file is
    // a reasonable thing to type, and the answer is the 3 days that exist with
    // the label saying so.
    const windowDays = Math.max(1, Math.min(wanted, days));
    const from = days - windowDays;

    const root: FolderNode = {
        path: '',
        name: '',
        flaky: 0,
        stable: 0,
        skipped: 0,
        flakyAndSkipped: 0,
        total: 0,
        testCount: 0,
        children: [],
        tests: [],
    };
    const byPath = new Map<string, FolderNode>([['', root]]);

    for (let index = 0; index < ids.length; index++) {
        const row = rows[index]!;
        const noise = neutralised[index]!;
        const identity = file.testAt(ids[index]!);

        // Integer test-days, credited as integers and divided at the end. See
        // the note on division order above.
        const counts: FlakyCounts = { flaky: 0, stable: 0, skipped: 0 };
        let skippedShare = 0;
        let bothShare = 0;
        let ranAtAll = false;
        for (let day = from; day < days; day++) {
            const state = stateOn(row, day, noise);
            if (state === null) {
                continue;
            }
            ranAtAll = true;
            counts[state]++;
            // The overlapping reading, per day, exactly as the single-day view
            // takes it: "was it skipped somewhere that day", independently of
            // whether it also failed. See `OverlappingCounts`.
            if (wasSkipped(row, days, day)) {
                skippedShare++;
                if (state === 'flaky') {
                    bothShare++;
                }
            }
        }
        if (!ranAtAll) {
            continue;
        }

        const { directory } = identity;
        const segments = directory === '' ? [] : directory.split('/');
        let path = '';
        let node = root;
        const credit = (target: FolderNode): void => {
            target.flaky += counts.flaky;
            target.stable += counts.stable;
            target.total += counts.flaky + counts.stable + counts.skipped;
            // `skipped` is the overlapping column, so it is the per-day "skipped
            // somewhere" count and not `counts.skipped`, which is the exclusive
            // verdict's bucket. The two differ by exactly the overlap.
            target.skipped += skippedShare;
            target.flakyAndSkipped += bothShare;
            // A whole file, once, however many days it ran — the one counter that
            // is **not** divided below, and the number a reader checks against
            // Searchfox.
            target.testCount++;
        };
        credit(node);
        for (const segment of segments) {
            path = path === '' ? segment : `${path}/${segment}`;
            let child = byPath.get(path);
            if (child === undefined) {
                child = {
                    path,
                    name: segment,
                    flaky: 0,
                    stable: 0,
                    skipped: 0,
                    flakyAndSkipped: 0,
                    total: 0,
                    testCount: 0,
                    children: [],
                    tests: [],
                };
                byPath.set(path, child);
                node.children.push(child);
            }
            credit(child);
            node = child;
        }

        node.tests.push({
            fullPath: identity.fullPath,
            name: identity.fullPath.slice(identity.fullPath.lastIndexOf('/') + 1),
            flaky: counts.flaky,
            stable: counts.stable,
            skipped: skippedShare,
            flakyAndSkipped: bothShare,
            total: counts.flaky + counts.stable + counts.skipped,
            windowFailures: row.windowFailures,
            neutralised: noise,
        });
    }

    // One division per counter, on the finished tree. `testCount` is deliberately
    // untouched: it is a number of test files and does not become fractional
    // because the states above it did.
    const average = (node: FolderNode): void => {
        node.flaky /= windowDays;
        node.stable /= windowDays;
        node.skipped /= windowDays;
        node.flakyAndSkipped /= windowDays;
        node.total /= windowDays;
        for (const leaf of node.tests) {
            leaf.flaky /= windowDays;
            leaf.stable /= windowDays;
            leaf.skipped /= windowDays;
            leaf.flakyAndSkipped /= windowDays;
            leaf.total /= windowDays;
        }
        for (const child of node.children) {
            average(child);
        }
    };
    average(root);

    // After the division, so the ranking is on the same numbers a caller reads.
    // The order is unaffected by dividing every value by the same constant, but
    // sorting first would leave the tree sorted on a quantity it no longer holds.
    sortTree(root);
    const dates: string[] = [];
    for (let day = from; day < days; day++) {
        dates.push(dateOfDay(startDate, day));
    }
    return { root, windowDays, dates };
}

/**
 * The per-day flaky/stable/skipped counts for one subtree.
 *
 * What the inline chart under an expanded folder draws, and the reason the page
 * no longer needs a "which day" selector: the history of the folder a reader
 * opened is more useful shown in place than reached by re-reading the whole
 * table on a different date.
 *
 * `pathPrefix` is matched against a test's **directory**, not its full path, and
 * with a trailing separator — so `dom/base` selects `dom/base` and
 * `dom/base/test` but not `dom/baseline`. Passing a full test path selects that
 * one test, which is what the per-test chart uses.
 */
export function flakinessOfPath(
    file: DecodedTimingFile,
    path: string,
    options: FlakinessOptions = {}
): FlakinessSeries {
    const ids: number[] = [];
    for (let testId = 0; testId < file.testCount; testId++) {
        const identity = file.testAt(testId);
        if (
            identity.directory === path ||
            identity.directory.startsWith(`${path}/`) ||
            identity.fullPath === path
        ) {
            ids.push(testId);
        }
    }
    const { rows, neutralised, neutralisedCount, days, startDate, minWindowFailures } = walk(
        file,
        options,
        ids
    );

    const series: FlakyDay[] = [];
    for (let day = 0; day < days; day++) {
        const counts: FlakyCounts = { flaky: 0, stable: 0, skipped: 0 };
        for (let index = 0; index < rows.length; index++) {
            const state = stateOn(rows[index]!, day, neutralised[index]!);
            if (state !== null) {
                counts[state]++;
            }
        }
        series.push({
            day,
            date: dateOfDay(startDate, day),
            ...counts,
            total: counts.flaky + counts.stable + counts.skipped,
        });
    }
    return { days: series, neutralisedTests: neutralisedCount, minWindowFailures };
}

/**
 * Every folder as a flat list, for ranking without the tree.
 *
 * The tree answers "where in the tree is this", and a burndown needs the other
 * question: which single directory has the most flaky tests in it, wherever it
 * sits. Those give different answers, and the difference is the point —
 * `toolkit` tops the tree because it *contains* everything, while the directory
 * actually worth booking a session on is somewhere below it.
 *
 * So this reports **`selfFlaky`** alongside the subtree totals: the tests
 * directly in the folder, excluding its subfolders. A caller ranking by
 * `selfFlaky` gets real, actionable directories; ranking by `flaky` gets the
 * roll-up. Both are on the row so the page can offer either without recomputing.
 *
 * Folders with no tests of their own are dropped — a pure container like
 * `dom/base` with everything in `dom/base/test` is not somewhere work happens.
 */
export interface FolderListRow extends FlakyCounts {
    path: string;
    name: string;
    /** Subtree total: `flaky + stable + skipped`. */
    total: number;
    /** Test files in the subtree. */
    testCount: number;
    /** Flaky tests **directly** in this folder, excluding subfolders. */
    selfFlaky: number;
    /** Classified tests directly in this folder. */
    selfTotal: number;
    /**
     * Tests **directly** in this folder that were skipped somewhere.
     *
     * The `self` counterpart of `skipped`, and the two are not interchangeable
     * even though they usually agree: `skipped` is the subtree's, so on a folder
     * with children it counts tests that are not in the `selfFlaky` numerator.
     * Measured on the pinned xpcshell window, 4 of 250 folders have subfolders
     * at all — but a view whose flaky column is `selfFlaky` and whose skip column
     * is the subtree's is wrong on those 4 and gives a reader no way to tell,
     * which is the kind of "usually right" column this file exists to avoid.
     *
     * Overlaps `selfFlaky` for the same reason `skipped` overlaps `flaky` — see
     * `OverlappingCounts` — with `selfFlakyAndSkipped` naming the overlap.
     */
    selfSkipped: number;
    /** Tests directly in this folder that were flaky **and** skipped. */
    selfFlakyAndSkipped: number;
    /** Test files directly in this folder. */
    selfTestCount: number;
    /** Depth in the tree, 0 for a top-level directory. */
    depth: number;
}

/**
 * Flattens the tree into a ranked list of folders that hold tests.
 *
 * Sorted by `selfFlaky` descending, which is the burndown ranking: the folders
 * where the most flaky test files actually live.
 */
export function folderList(root: FolderNode): FolderListRow[] {
    const rows: FolderListRow[] = [];
    const visit = (node: FolderNode, depth: number): void => {
        if (node.path !== '' && node.tests.length > 0) {
            let selfFlaky = 0;
            let selfTotal = 0;
            let selfSkipped = 0;
            let selfFlakyAndSkipped = 0;
            for (const leaf of node.tests) {
                selfFlaky += leaf.flaky;
                selfTotal += leaf.total;
                selfSkipped += leaf.skipped;
                selfFlakyAndSkipped += leaf.flakyAndSkipped;
            }
            rows.push({
                path: node.path,
                name: node.name,
                flaky: node.flaky,
                stable: node.stable,
                skipped: node.skipped,
                total: node.total,
                testCount: node.testCount,
                selfFlaky,
                selfTotal,
                selfSkipped,
                selfFlakyAndSkipped,
                selfTestCount: node.tests.length,
                depth,
            });
        }
        for (const child of node.children) {
            visit(child, depth + 1);
        }
    };
    visit(root, -1);
    rows.sort((a, b) => b.selfFlaky - a.selfFlaky || a.path.localeCompare(b.path));
    return rows;
}

/** `flaky / total * 100`, or 0 for an empty node. Rounded once, by the caller. */
export function flakyPercentage(counts: FlakyCounts & { total: number }): number {
    return counts.total > 0 ? (counts.flaky / counts.total) * 100 : 0;
}

/**
 * Every test file at or below a node, flattened.
 *
 * `FolderNode.tests` holds only the leaves *at* that level — a test in
 * `dom/base/test` is a leaf of that folder and appears nowhere else, which is
 * what makes the page's drill-down list each file once. A caller that wants "the
 * tests in this folder tree" therefore has to walk, and this is that walk, once,
 * rather than four copies of it.
 *
 * Returned unsorted, in tree order: the two rankings a caller might want
 * (flaky-first for a listing, path order for a diff) are the caller's, and
 * `sortTree` has already put each node's own leaves in flaky order.
 *
 * Additive: `flakinessByFolder` and `flakinessByFolderAveraged` are unchanged
 * and `site/flaky-view.ts` does not use this.
 */
export function subtreeTests(node: FolderNode): TestLeaf[] {
    const leaves: TestLeaf[] = [];
    const visit = (current: FolderNode): void => {
        leaves.push(...current.tests);
        for (const child of current.children) {
            visit(child);
        }
    };
    visit(node);
    return leaves;
}

/**
 * The node at `path`, or `null` when no test in the selection lives there.
 *
 * A lookup rather than a `byPath` map on the tree, because the map is a build
 * artefact of the two constructors and exposing it would make the tree's shape
 * part of the contract. 6-deep paths, so the walk is at most 6 comparisons.
 */
export function folderAt(root: FolderNode, path: string): FolderNode | null {
    if (path === '') {
        return root;
    }
    let node: FolderNode = root;
    for (const segment of path.split('/')) {
        const child: FolderNode | undefined = node.children.find((entry) => entry.name === segment);
        if (child === undefined) {
            return null;
        }
        node = child;
    }
    return node;
}

/**
 * Whether a test file has anything for a reader to act on.
 *
 * A test that passed everywhere on every day it ran is counted in every
 * percentage and listed in none, which is the rule `site/flaky-view.ts` states
 * and measures: clean leaves are **707 of 4,807** over the pinned 21-day view
 * and **3,122 of 4,805** on a single day, so on the day view two rows in three
 * would be padding.
 *
 * Duplicated as an exported predicate rather than imported from `site/`, because
 * `lib/` may not depend on `site/` and the site module's copy is `private`. The
 * two are asserted to agree in `test/flaky-tests-listing.test.ts`.
 */
export function hasSomethingToAct(leaf: TestLeaf): boolean {
    return leaf.flaky > 0 || leaf.skipped > 0;
}
