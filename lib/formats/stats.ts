/**
 * `{harness}-stats.json` and `index.json` — the small ones.
 *
 * `stats.json` is the only file that reaches back beyond the 21-day window:
 * it is a flat per-date series and keeps growing (199 dates for xpcshell, 66
 * for mochitest, as of 2026-08-04 — mochitest data started later). Everything
 * else is limited to the dates in `index.json`.
 */

/** A per-date series. Every array in a stats file has the same length. */
export type DateSeries = number[];

export interface StatsMetadata {
    generatedAt: string;
    harness: string;
}

/** The counters that both the top level and each mochitest flavor carry. */
export interface StatsCounters {
    totalTestRuns: DateSeries;
    failedTestRuns: DateSeries;
    skippedTestRuns: DateSeries;
    processedJobCount: DateSeries;
    failedJobs: DateSeries;
    ignoredJobs: DateSeries;
}

export interface StatsFile extends StatsCounters {
    metadata: StatsMetadata;
    /** Oldest first, unlike `index.json`. */
    dates: string[];
    /** Absent from the per-flavor breakdowns, present at the top level. */
    invalidJobs: DateSeries;
    /**
     * Mochitest only: the same counters per flavor (`plain`, `browser-chrome`,
     * `devtools`, `a11y`, `chrome`, `media`, `remote`, `webgl`). Absent from
     * `xpcshell-stats.json`. Flavor names are data — do not hardcode them.
     */
    flavors?: Record<string, StatsCounters>;
    /**
     * Per-marker-kind daily totals. Kind names are data and differ by harness:
     * mochitest carries `TSan Error`, xpcshell does not. Do not hardcode.
     */
    markerCounts: Record<string, DateSeries>;
}

/** `index.json`: which dates have published per-date files. Newest first. */
export interface IndexFile {
    dates: string[];
}

// --- decoding ------------------------------------------------------------

/** One date's row of a stats file, with the parallel arrays transposed. */
export interface StatsRow {
    date: string;
    totalTestRuns: number;
    failedTestRuns: number;
    skippedTestRuns: number;
    processedJobCount: number;
    failedJobs: number;
    ignoredJobs: number;
    invalidJobs: number;
    /** Per-marker-kind totals for this date. Kind names are data. */
    markerCounts: Record<string, number>;
}

/**
 * Transposes a stats file into one row per date, oldest first.
 *
 * The file is stored as parallel arrays because that is compact; almost every
 * consumer wants rows. Doing the transpose once here is cheaper than every
 * caller indexing six arrays by the same `i` and getting one of them wrong.
 *
 * A missing entry in any series is read as 0 rather than skipped: the series
 * are declared parallel and the validator checks it, so a short array is a
 * generator bug, and reporting a 0 keeps the date in the series where dropping
 * it would silently shorten a chart's x-axis.
 */
export function statsRows(file: StatsFile): StatsRow[] {
    const kinds = Object.keys(file.markerCounts);
    return file.dates.map((date, i) => ({
        date,
        totalTestRuns: file.totalTestRuns[i] ?? 0,
        failedTestRuns: file.failedTestRuns[i] ?? 0,
        skippedTestRuns: file.skippedTestRuns[i] ?? 0,
        processedJobCount: file.processedJobCount[i] ?? 0,
        failedJobs: file.failedJobs[i] ?? 0,
        ignoredJobs: file.ignoredJobs[i] ?? 0,
        invalidJobs: file.invalidJobs[i] ?? 0,
        markerCounts: Object.fromEntries(
            kinds.map((kind) => [kind, file.markerCounts[kind]?.[i] ?? 0])
        ),
    }));
}

/**
 * The row for one date, or `null` when the file does not cover it.
 *
 * `stats.json` is the only file reaching back beyond the 21-day window — 199
 * dates for xpcshell, 66 for mochitest — so "not covered" is a real answer
 * here and not necessarily a mistake by the caller.
 */
export function statsRowForDate(file: StatsFile, date: string): StatsRow | null {
    const i = file.dates.indexOf(date);
    return i === -1 ? null : (statsRows(file)[i] ?? null);
}

/**
 * The flavor names a stats file breaks down by, empty when it has none.
 *
 * Flavors are mochitest-only and their names are data — `FORMATS.md` observed
 * eight, and hardcoding that list is how a new flavor goes missing.
 */
export function flavorNames(file: StatsFile): string[] {
    return file.flavors ? Object.keys(file.flavors) : [];
}

/**
 * The marker kinds a stats file reports, in the order the file lists them.
 *
 * Also data: mochitest carries `TSan Error` from instrumented builds and
 * xpcshell does not.
 */
export function markerKinds(file: StatsFile): string[] {
    return Object.keys(file.markerCounts);
}
