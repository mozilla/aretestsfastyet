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
 * A series shorter than `dates` throws rather than being padded with zeros. An
 * earlier version padded, on the grounds that `tools/validate/` checks the
 * arrays are parallel — but that is a dev tool which never runs on library
 * input, so the argument justified inventing a 0 with an enforcement that does
 * not exist on this path. A padded 0 in a stats series is a day that reads as
 * "nothing ran", which is indistinguishable from a real quiet day and would be
 * charted as one.
 */
export function statsRows(file: StatsFile): StatsRow[] {
    const count = file.dates.length;
    const series: Record<string, readonly number[]> = {
        totalTestRuns: file.totalTestRuns,
        failedTestRuns: file.failedTestRuns,
        skippedTestRuns: file.skippedTestRuns,
        processedJobCount: file.processedJobCount,
        failedJobs: file.failedJobs,
        ignoredJobs: file.ignoredJobs,
        invalidJobs: file.invalidJobs,
        ...file.markerCounts,
    };
    const misaligned = Object.entries(series).filter(([, values]) => values.length !== count);
    if (misaligned.length > 0) {
        throw new Error(
            `stats series are misaligned: ${count} dates but ` +
                misaligned.map(([key, values]) => `${key}=${values.length}`).join(', ')
        );
    }

    const kinds = Object.keys(file.markerCounts);
    return file.dates.map((date, i) => ({
        date,
        totalTestRuns: file.totalTestRuns[i]!,
        failedTestRuns: file.failedTestRuns[i]!,
        skippedTestRuns: file.skippedTestRuns[i]!,
        processedJobCount: file.processedJobCount[i]!,
        failedJobs: file.failedJobs[i]!,
        ignoredJobs: file.ignoredJobs[i]!,
        invalidJobs: file.invalidJobs[i]!,
        markerCounts: Object.fromEntries(kinds.map((kind) => [kind, file.markerCounts[kind]![i]!])),
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
