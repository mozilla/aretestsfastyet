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
 * `day` is a single day, or `null` for the whole window.
 */
function wasSkipped(row: TestDays, days: number, day: number | null): boolean {
    if (day !== null) {
        return (row.skip[day] ?? 0) > 0;
    }
    for (let index = 0; index < days; index++) {
        if (row.skip[index]! > 0) {
            return true;
        }
    }
    return false;
}

function windowState(row: TestDays, days: number, neutralised: boolean): FlakyState | null {
    let sawSkip = false;
    let sawPass = false;
    for (let day = 0; day < days; day++) {
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
 * data does not pull the mean toward zero.
 */
export function runningAverage(days: readonly FlakyDay[], window = 7): (number | null)[] {
    const half = Math.floor(window / 2);
    return days.map((_unused, index) => {
        let flaky = 0;
        let total = 0;
        for (let offset = -half; offset <= half; offset++) {
            const day = days[index + offset];
            if (day === undefined || day.total === 0) {
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
 */
export function flakinessByFolder(
    file: DecodedTimingFile,
    options: FolderOptions = {}
): FolderNode {
    const ids = selectTests(file, options.pathPrefix);
    const { rows, neutralised, days } = walk(file, options, ids);
    const lastDay = days - 1;
    const day = options.day ?? lastDay;

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
            options.allDays === true ? windowState(row, days, noise) : stateOn(row, day, noise);
        if (state === null) {
            continue;
        }
        // ...and separately, whether it was skipped at all. A test can be both,
        // and in the table both facts count — see `OverlappingCounts`. So the
        // skipped column is this, not `state === 'skipped'`.
        const skipped = wasSkipped(row, days, options.allDays === true ? null : day);
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
            for (const leaf of node.tests) {
                selfFlaky += leaf.flaky;
                selfTotal += leaf.total;
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
