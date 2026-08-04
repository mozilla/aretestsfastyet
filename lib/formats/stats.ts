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
