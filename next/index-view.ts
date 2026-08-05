/**
 * `index.html`'s **view model**: the landing page's numbers, with no DOM.
 *
 * The page a visitor sees first, and the one behind `fx-tests summary`. It is
 * 794 lines upstream and reads as a simple table plus four charts, which
 * undersells it: there are **three different time windows on one page**, none
 * of them labelled as differing, and two incompatible job denominators. Naming
 * those is most of what this file is for.
 *
 * | file | contains | tested by |
 * | --- | --- | --- |
 * | `lib/formats/stats.ts` | the file format, shared with the CLI | `test/formats.test.ts` |
 * | `lib/query/summary.ts` | the CLI's 7-day topline over the same file | `test/query.test.ts` |
 * | this file | the page's windows, merge, rows and traces | `test/index-view.test.ts`, no DOM |
 * | `next/index.ts` | the renderer, the lazy charts and the interactions | `test/index-page.test.ts` + the browser run |
 *
 * ## The three windows, and why they are now named
 *
 * Upstream they are three unrelated expressions with no shared vocabulary, and
 * a reader comparing the summary table against the chart above it has no way to
 * know they cover different spans:
 *
 * | what | window | upstream |
 * | --- | --- | --- |
 * | the summary table | **last 7 dates** | `getRecentStats(stats, 7)`, `index.html:524`, `:534`, `:541-544` |
 * | the four Plotly charts | **the entire file**, unsliced | `:632-640`, `:649-668`, `:677-686`, `:695-723` |
 * | the summary's own links | **21 days** | `issues.html?kind=…#date=21days`, `:487` |
 *
 * Measured on the pinned files: the table covers 7 dates and the charts cover
 * **199** (xpcshell) and **198** (mochitest, after the backfill merge) — a
 * 28-fold difference between the number a reader reads and the series they see
 * next to it. `SUMMARY_DAYS` and `chartSeries`'s lack of a window argument are
 * both deliberate and both carry that measurement, so the difference is a
 * stated property rather than an accident of three call sites.
 *
 * The 21-day link window is a third span again, and it is not this page's data
 * at all — it is what `issues.html` will show on arrival. Kept, because
 * changing it would change where the page sends people; recorded in
 * `SUMMARY_LINK_HASH` so it is greppable.
 *
 * ## `lib/query/summary.ts` was considered and is **not** what the table shows
 *
 * The obvious move — the brief's suggestion, and what a reader of `PARITY.md`
 * §5 would expect — is to render the table straight out of `computeSummary`.
 * It cannot be done without changing two of the four numbers on the page, so
 * the table keeps its own arithmetic and `test/index-parity.test.ts` asserts
 * the difference rather than hiding it. Both differences are measured there and
 * enumerated in `next/index.ts`'s header; in one line each:
 *
 * - **the job failure rate** subtracts invalid jobs from the numerator only
 *   (`(failedJobs − invalidJobs) / processedJobCount`, `:476`, `:479`) where
 *   the CLI divides `failedJobs / processedJobCount`;
 * - **the skip rate** divides by `totalTestRuns` (`:480`) where the CLI divides
 *   by `totalTestRuns + skippedTestRuns`.
 *
 * The other two — test failure rate and invalid job rate — agree exactly, and
 * the parity test asserts that they do so a future divergence in *those* is a
 * failure rather than a fourth entry on the list.
 *
 * ## This file must stay DOM-free
 *
 * Enforced indirectly, the same way `next/crashes-view.ts` is:
 * `test/index-view.test.ts` imports it, the root project compiles `test/**`,
 * and the root project has no DOM lib. Nothing here names an element id, a CSS
 * class or a glyph — those are `next/index.ts`'s, per the seam rule.
 */

import type { StatsCounters, StatsFile } from '../lib/formats/stats.ts';

/**
 * The summary table's window, in dates. `index.html:524`, `:534`, `:541-544`.
 *
 * Equal to `lib/query/summary.ts`'s `DEFAULT_SUMMARY_DAYS`, and the two are
 * checked against each other in `test/index-parity.test.ts` rather than one
 * importing the other. Importing would make them the same number by
 * construction, which is the "expected value comes from the thing under test"
 * trap: the page's heading says "Last 7 Days" in prose (`:203`) and the CLI's
 * default is chosen for the weekend-mix reason its module documents, so they
 * agree today for two independent reasons and a test should notice if either
 * moves.
 */
export const SUMMARY_DAYS = 7;

/**
 * The hash the summary's test-failure links carry. `index.html:487`.
 *
 * A **third** window, and not this page's: it asks `issues.html` for its 21-day
 * aggregate. Named so the difference from `SUMMARY_DAYS` is greppable rather
 * than being a string buried in a template.
 */
export const SUMMARY_LINK_HASH = '#date=21days';

/**
 * The mochitest flavors the summary sub-rows and the chart traces use, in the
 * order the page lists them. `index.html:288-297`.
 *
 * **This is a hardcoded list and it is kept hardcoded**, which is worth
 * defending because `lib/formats/stats.ts` says flavor names are data and
 * warns against hardcoding them. Two different questions:
 *
 * - *which flavors exist* is data, and `flavorNames()` answers it;
 * - *which flavors this page shows, in what order, in what colour* is a
 *   presentation choice, and there is no order or palette in the file.
 *
 * Upstream iterates this list and skips a flavor the data lacks (`:540`), so a
 * new flavor in the data is silently absent from the page. Measured on the
 * pinned mochitest file: the eight names here and the eight in `flavors` are
 * the same set, so nothing is dropped today. `unlistedFlavors()` exists so the
 * renderer and a test can see when that stops being true, rather than the page
 * quietly shrinking.
 */
export const MOCHITEST_FLAVORS: readonly FlavorSpec[] = [
    { key: 'browser-chrome', name: 'Browser Chrome', color: '#c0392b' },
    { key: 'devtools', name: 'DevTools', color: '#e67e22' },
    { key: 'plain', name: 'Plain', color: '#27ae60' },
    { key: 'chrome', name: 'Chrome', color: '#8e44ad' },
    { key: 'a11y', name: 'A11y', color: '#2980b9' },
    { key: 'media', name: 'Media', color: '#16a085' },
    { key: 'remote', name: 'Remote', color: '#d35400' },
    { key: 'webgl', name: 'WebGL', color: '#2c3e50' },
];

/** One flavor's identity on this page. */
export interface FlavorSpec {
    /** The key in `stats.flavors`. */
    key: string;
    /** The label the row and the legend show. */
    name: string;
    /** The trace colour. */
    color: string;
}

/** The two harnesses' series colours. `index.html:634`, `:639`. */
export const HARNESS_COLORS: Readonly<Record<string, string>> = {
    xpcshell: '#0060df',
    mochitest: '#ff6b6b',
};

/** Flavor names in the data that this page's hardcoded list does not show. */
export function unlistedFlavors(file: StatsFile): string[] {
    const listed = new Set(MOCHITEST_FLAVORS.map((flavor) => flavor.key));
    return Object.keys(file.flavors ?? {}).filter((name) => !listed.has(name));
}

// =========================================================================
// The backfill merge
// =========================================================================

/**
 * A stats file after the merge: every per-day array may carry `null` holes.
 *
 * A separate type from `StatsFile` because the hole is real and the type is
 * how a caller finds out. `lib/formats/stats.ts`'s `statsRows` would throw on
 * one of these — it asserts every series is exactly `dates.length` — which is
 * the correct behaviour for the CLI and is why the page does not use it.
 */
export interface MergedStats {
    metadata: StatsFile['metadata'] & { backfilled?: boolean };
    dates: string[];
    totalTestRuns: (number | null)[];
    failedTestRuns: (number | null)[];
    skippedTestRuns: (number | null)[];
    processedJobCount: (number | null)[];
    failedJobs: (number | null)[];
    invalidJobs: (number | null)[];
    ignoredJobs: (number | null)[];
    flavors?: Record<string, MergedCounters>;
}

/** A flavor's per-day arrays after the merge. No `invalidJobs`: see below. */
export type MergedCounters = Partial<Record<keyof StatsCounters, (number | null)[]>>;

/** One value the backfill and the live artifact disagree about. */
export interface MergeWarning {
    date: string;
    key: string;
    backfill: number;
    live: number;
}

/** What `mergeBackfillStats` produced, and what it noticed on the way. */
export interface MergeResult {
    stats: MergedStats;
    warnings: MergeWarning[];
}

/** The keys never merged as a per-day array. `index.html:354`. */
const NON_SERIES_KEYS = new Set(['metadata', 'dates', 'flavors']);

/**
 * Merges a committed backfill file into the freshly-fetched live artifact.
 *
 * A port of `index.html:319-385`, rule for rule, and the rules are upstream's:
 * union of dates sorted ascending, live wins wherever both have a date, the
 * backfill fills only what live lacks, and a disagreement over an overlapping
 * date is reported rather than swallowed.
 *
 * ## Why the file exists at all
 *
 * Upstream's comment (`:299-318`): around 2026-06-10 a mozilla-central
 * aggregation job failed without being marked failed, later runs rebuilt
 * history from scratch, and the live artifacts lost everything before a certain
 * date. `mochitest-stats-backfill.json` is the last known-good full-history
 * artifact, committed so the charts keep their history.
 *
 * ## What is measured on the pinned files, because two of these surprised
 *
 * Only mochitest has a backfill file — `ls *-stats-backfill.json` is one entry
 * — so xpcshell's 199 dates are live throughout and this function is a no-op
 * for it (`:319`, the empty-backfill guard).
 *
 * For mochitest, backfill 2026-01-17…2026-06-10 (145 dates) against live
 * 2026-05-29…2026-08-03 (66 dates) merges to **198 dates**, with:
 *
 * - **zero `null` holes in any of the seven counter arrays**, and zero in any
 *   of the eight flavors' six arrays. The two ranges overlap (05-29…06-10), so
 *   there is no uncovered date. The brief's concern about `sumArray` counting a
 *   `null` as 0 in both numerator and denominator is therefore **not reachable
 *   on this data** — see `sumSeries` for the one case where it would bite and
 *   what is done about it.
 * - **446 disagreements** over the 13 overlapping dates (2026-05-29…06-10).
 *   **400 have the backfill reading higher** than live (e.g. `2026-05-29
 *   totalTestRuns: backfill=10418706 live=10184891`), which is the loss the
 *   backfill exists to repair. The other **46 read lower**, and **44 of those
 *   are on 2026-06-10** — the backfill's final date, captured part-way through
 *   the day, so live legitimately has more. Live wins in both directions, per
 *   the rule, which is the right call for exactly that reason.
 * - **one date gap that the merge does not create and cannot fill**:
 *   2026-07-10 → 2026-07-12, missing 07-11. It is absent from both sources, so
 *   the merged `dates` array simply skips it. The charts plot dates as a date
 *   axis, so the gap shows as a wider segment rather than as a hole.
 *
 * ## `markerCounts` is dropped, on purpose, and upstream corrupts it
 *
 * `markerCounts` is a `Record<string, number[]>` — an object of arrays, not an
 * array. Upstream's `topKeys` (`:353-354`) excludes only `metadata`, `dates`
 * and `flavors`, so `markerCounts` goes through `mergeArray`, which indexes it
 * with `backfillArr[bi]` as if it were a series. Measured on the pinned files:
 * the merged mochitest `markerCounts` is **an array of 198 `null`s**, having
 * been an object of 5 named series.
 *
 * That is a live corruption in upstream, and it is invisible there because
 * **this page never reads `markerCounts`** — `grep -c markerCounts index.html`
 * is 0. It matters here because `MergedStats` is handed to nothing that wants
 * it and because the CLI's `markerTotals()` reads exactly that field off the
 * same file. So this port **omits the field from the merged result** rather
 * than reproducing an object-shaped value mangled into nulls: a consumer that
 * asks for it gets `undefined` and can say so, instead of getting 198 nulls
 * that look like a real empty series. Divergence 4 in `next/index.ts`.
 */
export function mergeBackfillStats(
    backfill: StatsFile | null,
    live: StatsFile | null
): MergeResult {
    if (backfill === null || backfill.dates.length === 0) {
        if (live === null) {
            throw new Error('mergeBackfillStats needs at least one of backfill and live');
        }
        return { stats: asMerged(live), warnings: [] };
    }
    if (live === null || live.dates.length === 0) {
        return { stats: asMerged(backfill), warnings: [] };
    }

    // The one `.sort()` on this page, and it is lexicographic on `YYYY-MM-DD`,
    // which is chronological for that format. `index.html:323-324`.
    const dates = [...new Set([...backfill.dates, ...live.dates])].sort();
    const backfillAt = new Map(backfill.dates.map((date, i) => [date, i]));
    const liveAt = new Map(live.dates.map((date, i) => [date, i]));
    const warnings: MergeWarning[] = [];

    const mergeSeries = (
        key: string,
        backfillValues: readonly number[] | undefined,
        liveValues: readonly number[] | undefined
    ): (number | null)[] =>
        dates.map((date) => {
            const bi = backfillAt.get(date);
            const li = liveAt.get(date);
            const fromBackfill = bi !== undefined && backfillValues ? backfillValues[bi] : undefined;
            const fromLive = li !== undefined && liveValues ? liveValues[li] : undefined;
            if (fromBackfill !== undefined && fromLive !== undefined && fromBackfill !== fromLive) {
                warnings.push({ date, key, backfill: fromBackfill, live: fromLive });
            }
            return fromLive ?? fromBackfill ?? null;
        });

    // Every top-level per-day array in either source, minus the three that are
    // not series and minus `markerCounts` — see the header.
    const seriesKeys = [...new Set([...Object.keys(backfill), ...Object.keys(live)])].filter(
        (key) => !NON_SERIES_KEYS.has(key) && key !== 'markerCounts'
    );
    const merged = {
        metadata: { ...backfill.metadata, ...live.metadata, backfilled: true },
        dates,
    } as MergedStats;
    for (const key of seriesKeys) {
        (merged as unknown as Record<string, (number | null)[]>)[key] = mergeSeries(
            key,
            (backfill as unknown as Record<string, number[] | undefined>)[key],
            (live as unknown as Record<string, number[] | undefined>)[key]
        );
    }

    if (backfill.flavors || live.flavors) {
        merged.flavors = {};
        const names = new Set([
            ...Object.keys(backfill.flavors ?? {}),
            ...Object.keys(live.flavors ?? {}),
        ]);
        for (const flavor of names) {
            const fromBackfill = (backfill.flavors?.[flavor] ?? {}) as Record<string, number[]>;
            const fromLive = (live.flavors?.[flavor] ?? {}) as Record<string, number[]>;
            const keys = new Set([...Object.keys(fromBackfill), ...Object.keys(fromLive)]);
            const out: Record<string, (number | null)[]> = {};
            for (const key of keys) {
                out[key] = mergeSeries(
                    `flavors.${flavor}.${key}`,
                    fromBackfill[key],
                    fromLive[key]
                );
            }
            merged.flavors[flavor] = out as MergedCounters;
        }
    }

    return { stats: merged, warnings };
}

/** A live-only file in merged clothing. No copying of the arrays. */
function asMerged(file: StatsFile): MergedStats {
    return {
        metadata: file.metadata,
        dates: file.dates,
        totalTestRuns: file.totalTestRuns,
        failedTestRuns: file.failedTestRuns,
        skippedTestRuns: file.skippedTestRuns,
        processedJobCount: file.processedJobCount,
        failedJobs: file.failedJobs,
        invalidJobs: file.invalidJobs,
        ignoredJobs: file.ignoredJobs,
        ...(file.flavors === undefined ? {} : { flavors: file.flavors as Record<string, MergedCounters> }),
    };
}

// =========================================================================
// The summary table
// =========================================================================

/**
 * The counters one summary row is computed from, over the row's window.
 *
 * A flavor has no `invalidJobs` in the data — measured: none of the eight
 * flavors in the pinned mochitest file carries the key — which is why the
 * column is a dash on a flavor row rather than a zero.
 */
export interface WindowTotals {
    /** The dates actually covered, oldest first. */
    dates: string[];
    totalTestRuns: number;
    failedTestRuns: number;
    skippedTestRuns: number;
    processedJobCount: number;
    failedJobs: number;
    invalidJobs: number;
}

/**
 * Sums a series, treating a `null` as **absent from the numerator but present
 * in the count of days**. A port of `sumArray`, `index.html:459-467`.
 *
 * Upstream's loop skips a `null` when adding, and every caller then divides one
 * such sum by another — so a date the merge could not fill contributes 0 to
 * both sides of a rate. That is the brief's concern, and it is real arithmetic:
 * a hole depresses a rate towards the rate of the days around it rather than
 * being excluded.
 *
 * **It is not reachable on the pinned data.** Measured above: the merge
 * produces zero holes, because the backfill and live ranges overlap. So the
 * behaviour is reproduced exactly rather than "fixed", and `holeCount` exists
 * so a caller can *say* when it stops being unreachable instead of a future
 * hole silently biasing a headline number. `next/index.ts` logs a console
 * warning when `holeCount` is non-zero over the summary window, which is the
 * cheapest thing that turns a silent bias into a visible one.
 *
 * ## The `null` guard is redundant, and is kept for the reader
 *
 * Found by the mutation campaign, which is the honest way to report it: four
 * separate mutants of this loop all survived, and each turned out to be a
 * **no-op rewrite** rather than a hole in the tests.
 *
 * | mutant | why it survives |
 * | --- | --- |
 * | `sum += value ?? 0` | adding 0 is adding nothing |
 * | `values.filter(v => v !== null).reduce(…)` | same set summed |
 * | `sum += value as number` | the cast is erased; `null` coerces to **0** under `+=`, measured — not `NaN` |
 * | `void 0;` inserted in the body | dead statement |
 *
 * So the guard cannot be observed by any test, because JavaScript's `+=`
 * already does what it does. It stays because deleting it would make the
 * function's behaviour on a hole a fact about numeric coercion rather than a
 * stated decision, and this is the exact line the brief asked to be examined.
 * `undefined` *would* poison the sum to `NaN`, which is why the type is
 * `(number | null)[]` and not `(number | undefined)[]`.
 */
export function sumSeries(values: readonly (number | null)[]): number {
    let sum = 0;
    for (const value of values) {
        if (value !== null) {
            sum += value;
        }
    }
    return sum;
}

/** How many entries of a series are `null`. See `sumSeries`. */
export function holeCount(values: readonly (number | null)[]): number {
    return values.reduce<number>((count, value) => (value === null ? count + 1 : count), 0);
}

/**
 * The last `days` dates of a merged file. A port of `getRecentStats`,
 * `index.html:442-457`.
 *
 * **Two upstream behaviours preserved, both worth naming:**
 *
 * 1. **A short file silently narrows the window** while the heading still says
 *    "Last 7 Days" (`:445`, `Math.min`). Reproduced — a page that showed 5 days
 *    of data under a 7-day heading is a real defect, but the honest fix is to
 *    label the window, and `next/index.ts` does exactly that: it reads
 *    `dayCount` back off this result and rewrites the heading when it is not
 *    `SUMMARY_DAYS`. So the arithmetic is unchanged and the *label* stops
 *    lying. Divergence 3.
 *
 *    Not reachable on the pinned files (199 and 198 dates), which is precisely
 *    why it needs a test rather than a browser check: `test/index-view.test.ts`
 *    drives it with a 3-date file.
 *
 * 2. **A missing array degrades to zeros, not to "no data"** (`:452-455`), so a
 *    metric the file lacks reads `0.00%` rather than blank. Reproduced, because
 *    the three arrays it guards (`processedJobCount`, `failedJobs`,
 *    `invalidJobs`) are exactly the ones a *flavor* lacks, and a flavor row
 *    genuinely has no invalid jobs to report. `totalTestRuns`,
 *    `failedTestRuns` and `skippedTestRuns` are **not** guarded upstream and
 *    are not guarded here: a file missing one of those throws, which is better
 *    than a landing page confidently reading 0.00%.
 */
export function recentWindow(
    stats: Pick<MergedStats, 'dates'> & MergedCounters & { invalidJobs?: (number | null)[] },
    days: number = SUMMARY_DAYS
): WindowTotals {
    const count = Math.min(days, stats.dates.length);
    const tail = <T>(values: readonly T[] | undefined): (T | null)[] =>
        values === undefined ? new Array<null>(count).fill(null) : values.slice(-count);
    const required = (
        values: readonly (number | null)[] | undefined,
        name: string
    ): (number | null)[] => {
        if (values === undefined) {
            throw new Error(`stats file has no ${name} series`);
        }
        return values.slice(-count);
    };

    return {
        dates: stats.dates.slice(-count),
        totalTestRuns: sumSeries(required(stats.totalTestRuns, 'totalTestRuns')),
        failedTestRuns: sumSeries(required(stats.failedTestRuns, 'failedTestRuns')),
        skippedTestRuns: sumSeries(required(stats.skippedTestRuns, 'skippedTestRuns')),
        // Upstream's `zeros` fallback: a `null` from `tail` sums as 0, which is
        // the same number `new Array(count).fill(0)` would have produced.
        processedJobCount: sumSeries(tail(stats.processedJobCount)),
        failedJobs: sumSeries(tail(stats.failedJobs)),
        invalidJobs: sumSeries(tail(stats.invalidJobs)),
    };
}

/**
 * One row of the summary table: four rates, each with the counts behind it.
 *
 * A rate is `null` when its denominator is zero. Upstream renders `'0.00'` in
 * that case (`:478-481`) — the renderer reproduces that, but the view model
 * keeps the distinction, because "no jobs ran" and "no jobs failed" are
 * different answers and only one of them is 0.00%.
 */
export interface SummaryRow {
    /** The label in the first column. */
    name: string;
    /** `xpcshell` or `mochitest`; a flavor row carries its parent's. */
    kind: string;
    /** Whether this is an indented per-flavor sub-row. */
    isFlavor: boolean;
    /** The window this row was computed over. */
    totals: WindowTotals;
    /** `failedTestRuns / totalTestRuns`, as a percentage. */
    testFailureRate: number | null;
    /** `(failedJobs − invalidJobs) / processedJobCount`. See below. */
    jobFailureRate: number | null;
    /** `skippedTestRuns / totalTestRuns`. **Not** the CLI's denominator. */
    skipRate: number | null;
    /** `invalidJobs / processedJobCount`. `null` on a flavor row. */
    invalidJobRate: number | null;
    /** `failedJobs − invalidJobs`, the job-failure numerator. */
    testFailedJobs: number;
}

/**
 * A percentage, or `null` when the denominator is zero.
 *
 * **Returns the raw ratio, unrounded.** The rounding happens once, in the
 * renderer, from this number. A `toFixed` here and another at the call site is
 * the double-round that shipped `14.37%` where the page showed `14.38%`.
 */
function rate(numerator: number, denominator: number): number | null {
    return denominator > 0 ? (numerator / denominator) * 100 : null;
}

/**
 * Builds one summary row. A port of `renderSummaryRow`'s arithmetic,
 * `index.html:470-481`.
 *
 * ## The job-failure numerator can go negative, and nothing guards it
 *
 * `testFailedJobs = failedJobs − invalidJobs` (`:476`) subtracts invalid jobs
 * from the numerator while the denominator stays `processedJobCount` (`:479`).
 * Whether that is even the right *set* is a question this port does not
 * reopen — the CLI reads the rate as plain `failedJobs / processedJobCount`,
 * which is divergence 1 — but the arithmetic admits a negative result whenever
 * a period has more invalid jobs than failed ones, and the page would render
 * `-0.42%` with a straight face.
 *
 * **Measured, because "unreachable" is not a thing to assert without one.**
 * Over every date in the pinned files — 199 xpcshell, 198 merged mochitest —
 * the count of days where `failedJobs < invalidJobs` is **0 and 0**. Over every
 * trailing 7-day window, the *minimum* value of `failedJobs − invalidJobs` is
 * **+241** (xpcshell, week ending 2026-02-05) and **+2,791** (mochitest, week
 * ending 2026-07-09). So it is comfortably positive throughout ~400 days of
 * real history and is not a live defect.
 *
 * It is reproduced rather than clamped, and the reason is that clamping would
 * be the worse failure: a `Math.max(0, …)` turns "this arithmetic produced
 * something impossible" into "0.00%", which is indistinguishable from a clean
 * week. If the invariant ever breaks, a negative percentage on the landing page
 * is the signal. `test/index-view.test.ts` pins the negative case with a
 * synthetic file so the behaviour is a decision with a test, not an oversight.
 */
export function summaryRow(
    totals: WindowTotals,
    name: string,
    kind: string,
    isFlavor: boolean
): SummaryRow {
    const testFailedJobs = totals.failedJobs - totals.invalidJobs;
    return {
        name,
        kind,
        isFlavor,
        totals,
        testFailedJobs,
        testFailureRate: rate(totals.failedTestRuns, totals.totalTestRuns),
        jobFailureRate: rate(testFailedJobs, totals.processedJobCount),
        // `totalTestRuns`, not `totalTestRuns + skippedTestRuns`. Divergence 2.
        skipRate: rate(totals.skippedTestRuns, totals.totalTestRuns),
        // A flavor has no `invalidJobs` series at all, so the column is a dash
        // rather than a 0.00% that would read as "no infrastructure problems".
        invalidJobRate: isFlavor ? null : rate(totals.invalidJobs, totals.processedJobCount),
    };
}

/**
 * Every row of the summary table, in the order the page renders them.
 *
 * **There is no sort.** Source order throughout: XPCShell, then Mochitest, then
 * the flavors in `MOCHITEST_FLAVORS` order. Upstream builds it exactly this way
 * — the two harness rows hardcoded and the flavors looped (`:517-556`) — and
 * the only `.sort()` anywhere in the file is `mergedDates.sort()` in the
 * backfill merge. Stated because "no sort" is a framing property that a value
 * comparison cannot see, and `PARITY.md` §1 counts a wrong sort key among the
 * defects that produced correct numbers.
 *
 * **Two implicit row-hiders**, both reproduced, neither changing a denominator:
 *
 * - a flavor absent from `stats.flavors` is skipped (`:540`);
 * - a flavor with **zero test runs in the window** is skipped (`:545`), even
 *   though it may have run jobs.
 *
 * Neither affects the Mochitest aggregate row above them, which is computed
 * from the top-level arrays and not by summing the flavors. Measured on the
 * pinned file: all eight flavors clear both bars, and their `totalTestRuns`
 * sum to 60,101,543 against the aggregate row's 60,119,846 — a 18,303 shortfall
 * (0.03%), so the aggregate is genuinely not the sum of the visible sub-rows.
 */
export function summaryRows(
    xpcshell: MergedStats | null,
    mochitest: MergedStats | null,
    days: number = SUMMARY_DAYS
): SummaryRow[] {
    const rows: SummaryRow[] = [];
    if (xpcshell !== null) {
        rows.push(summaryRow(recentWindow(xpcshell, days), 'XPCShell', 'xpcshell', false));
    }
    if (mochitest !== null) {
        rows.push(summaryRow(recentWindow(mochitest, days), 'Mochitest', 'mochitest', false));
        for (const flavor of MOCHITEST_FLAVORS) {
            const counters = mochitest.flavors?.[flavor.key];
            if (counters === undefined) {
                continue;
            }
            const totals = recentWindow({ dates: mochitest.dates, ...counters }, days);
            if (totals.totalTestRuns > 0) {
                rows.push(summaryRow(totals, flavor.name, 'mochitest', true));
            }
        }
    }
    return rows;
}

// =========================================================================
// The charts
// =========================================================================

/**
 * One point of a rate series: the ratio and both counts behind it.
 *
 * The percentage is carried **unrounded**; the renderer rounds it once for the
 * hover template. Same rule as `SummaryRow`.
 */
export interface RatePoint {
    date: string;
    numerator: number;
    denominator: number;
    /** `numerator / denominator * 100`, unrounded. */
    percentage: number;
}

/**
 * A rate series over the **whole file**. A port of `createPercentageTrace`'s
 * data half, `index.html:558-591`.
 *
 * No window argument, deliberately: this is the second of the page's three
 * windows and it is "everything". See the header table — the charts show 199
 * and 198 dates against the summary table's 7.
 *
 * A date is **dropped entirely** when either side is `null` or the denominator
 * is not positive (`:564`), which is upstream's rule and is the right one for a
 * line chart: plotting 0% for a day with no jobs would draw a spike to the axis
 * that reads as a perfect day. The dropped dates are reported by
 * `droppedDates()` rather than being silently absent.
 */
export function rateSeries(
    dates: readonly string[],
    numerator: readonly (number | null)[] | undefined,
    denominator: readonly (number | null)[] | undefined
): RatePoint[] {
    const points: RatePoint[] = [];
    for (const [i, date] of dates.entries()) {
        const top = numerator?.[i] ?? null;
        const bottom = denominator?.[i] ?? null;
        if (top === null || bottom === null || bottom <= 0) {
            continue;
        }
        points.push({ date, numerator: top, denominator: bottom, percentage: (top / bottom) * 100 });
    }
    return points;
}

/** How many of `dates` `rateSeries` dropped. */
export function droppedDates(
    dates: readonly string[],
    numerator: readonly (number | null)[] | undefined,
    denominator: readonly (number | null)[] | undefined
): number {
    return dates.length - rateSeries(dates, numerator, denominator).length;
}

/**
 * The per-day test-failure-job counts a job chart plots.
 * `index.html:651-652`, `:695-696`.
 *
 * `failedJobs − invalidJobs` per day, and a day where either is `null` keeps
 * the raw `failedJobs` — which is upstream's expression exactly, including the
 * asymmetry: the guard tests both arrays but the fallback uses only one. On the
 * pinned files no day is `null`, so the fallback is not taken.
 */
export function testFailedJobSeries(stats: MergedStats): (number | null)[] {
    return stats.failedJobs.map((failed, i) => {
        const invalid = stats.invalidJobs[i] ?? null;
        return failed !== null && invalid !== null ? failed - invalid : failed;
    });
}

/**
 * One point of the stacked failure-breakdown chart.
 * A port of `makeStackTrace`'s data half, `index.html:698-710`.
 *
 * **This chart uses the other job denominator**, and that is the point of
 * giving it its own function: `processedJobCount + invalidJobs + ignoredJobs`
 * (`:701`), where the summary table's Flaky Job Failures column divides by
 * `processedJobCount` alone. Two incompatible denominators for two numbers a
 * reader will read as the same quantity, on one page, neither labelled.
 *
 * Measured over the pinned files' last 7 dates, so the two are directly
 * comparable with the table above them:
 *
 * | | xpcshell | mochitest |
 * | --- | --- | --- |
 * | `processedJobCount` (table) | 7,464 | 169,142 |
 * | `+ invalid + ignored` (chart) | 7,568 | 172,209 |
 * | ratio | 1.0139× | 1.0181× |
 *
 * So the chart's "Intermittent" band sits 1.4% (xpcshell) and 1.8%
 * (mochitest) lower than the table's Flaky Job Failures figure for the same
 * days and the same numerator. Both are
 * reproduced; the difference is stated here and in `next/index.ts`'s header
 * because a reader comparing the two has no other way to learn it.
 *
 * Unlike `rateSeries`, this **keeps every date** — a day with no jobs yields a
 * `null` percentage, which Plotly renders as a gap in the stack rather than
 * dropping the x value. Upstream does the same (`:702-704`), and it has to: the
 * three traces are stacked and must share an x array.
 */
export interface BreakdownPoint {
    date: string;
    /** `null` when the day's total is zero or the value is missing. */
    percentage: number | null;
    /** The raw count, `null` when the day has none. */
    count: number | null;
    /** `processedJobCount + invalidJobs + ignoredJobs` for the day. */
    total: number;
}

/** The breakdown chart's per-day totals. See `BreakdownPoint`. */
export function breakdownTotals(stats: MergedStats): number[] {
    return stats.dates.map(
        (_, i) =>
            (stats.processedJobCount[i] ?? 0) +
            (stats.invalidJobs[i] ?? 0) +
            (stats.ignoredJobs[i] ?? 0)
    );
}

/** One stacked band of the breakdown chart. */
export function breakdownSeries(
    stats: MergedStats,
    values: readonly (number | null)[]
): BreakdownPoint[] {
    const totals = breakdownTotals(stats);
    return stats.dates.map((date, i) => {
        const total = totals[i]!;
        const count = values[i] ?? null;
        return {
            date,
            count,
            total,
            percentage: total > 0 && count !== null ? (count / total) * 100 : null,
        };
    });
}

/**
 * Which display mode the charts are in. `index.html:286`.
 *
 * Affects **the charts only**: the summary table always shows both a percentage
 * and a raw `n / N`, so the toggle does nothing to it. Upstream's
 * `updateDisplay` calls `updateStatsSummary()` on every toggle anyway (`:767`),
 * re-rendering the table to the identical markup — worth knowing when reading a
 * DOM diff, since the table's nodes are replaced without changing.
 */
export type DisplayMode = 'percentage' | 'count';

/** The mode the page starts in. `index.html:286`, `#btnPercentage` is `active` at `:192`. */
export const INITIAL_DISPLAY_MODE: DisplayMode = 'percentage';

/** The y value a rate point contributes in each mode. `index.html:566`. */
export function displayValue(point: RatePoint, mode: DisplayMode): number {
    return mode === 'percentage' ? point.percentage : point.numerator;
}
