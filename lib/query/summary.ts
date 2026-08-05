/**
 * The 7-day topline, from `{harness}-stats.json`.
 *
 * Behind `fx-tests summary`, and the cheapest command in the CLI: `stats.json`
 * is a few hundred kilobytes of flat per-date arrays, so the whole answer costs
 * one small file and no decoding of status groups at all.
 *
 * It is also the **only** file with real history — `FORMATS.md` counts 199
 * dates for xpcshell and 66 for mochitest, against everything else's rolling
 * 21 — which is what makes a period-over-period comparison possible here and
 * nowhere else.
 *
 * ## Why the comparison window is a whole number of weeks
 *
 * Push volume drops several-fold at weekends (`FORMATS.md` measures 2.6× on
 * both harnesses), so a window that is not a multiple of 7 days contains a
 * different number of weekend days than the window before it, and the
 * comparison measures the calendar rather than the tree. Seven days against the
 * prior seven contains exactly one weekend each.
 *
 * This is the same reasoning that makes `config-stats.ts` size its recent
 * window by run count. There the fix is to widen until the runs are there;
 * here the counts are already per-date totals across all jobs, so aligning the
 * windows is enough — but the failure mode is identical and worth naming twice.
 *
 * These are **rates, not counts**, for the same reason: a rate is comparable
 * across a weekend and an absolute count is not.
 */

import type { StatsFile, StatsRow } from '../formats/stats.ts';
import { statsRows } from '../formats/stats.ts';

/** One period's rates, plus the totals they were computed from. */
export interface PeriodSummary {
    /** First and last date in the period, inclusive. */
    startDate: string;
    endDate: string;
    /** How many dates the period actually had data for. */
    dayCount: number;
    totalTestRuns: number;
    failedTestRuns: number;
    skippedTestRuns: number;
    processedJobCount: number;
    failedJobs: number;
    invalidJobs: number;
    /** `failedTestRuns / totalTestRuns * 100`, or `null` when nothing ran. */
    testFailureRate: number | null;
    /**
     * `failedJobs / (processedJobCount + invalidJobs) * 100`, or `null`.
     *
     * The denominator is both branches of the generator's fetch, because the
     * numerator is counted over both: `failedJobs` is
     * `jobs.filter(j => j.state === "failed").length` over every non-ignored
     * job of the day (`fetch-test-data.js:1821`), while `processedJobCount`
     * counts only the jobs whose profile was fetched and `invalidJobs` counts
     * the ones whose fetch failed — disjoint branches of one `if`/`else`
     * (`:267-282`). So `processedJobCount + invalidJobs` is the population
     * `failedJobs` was drawn from, and `processedJobCount` alone is short by
     * the invalid ones.
     */
    jobFailureRate: number | null;
    /**
     * `skippedTestRuns / totalTestRuns * 100`, or `null`.
     *
     * `totalTestRuns` already contains the skips: the generator does
     * `totalTestRuns += runCount` (`fetch-test-data.js:2733`) *before* the
     * status dispatch, and `SKIP` is one of the branches below it. Adding
     * `skippedTestRuns` to the denominator would count them twice.
     *
     * The numerator is narrower than the denominator's skips by one measured
     * category: `run-if` skips are counted in `totalTestRuns` but excluded
     * from `skippedTestRuns` (`:2742-2752`). So this rate means
     * "non-conditional skips as a share of all runs".
     */
    skipRate: number | null;
    /** `invalidJobs / processedJobCount * 100`, or `null`. */
    invalidJobRate: number | null;
}

/** A period, the one before it, and the change between them. */
export interface Summary {
    harness: string;
    current: PeriodSummary;
    /** `null` when the file does not reach back far enough for a full prior period. */
    prior: PeriodSummary | null;
    /**
     * Percentage-point differences, current minus prior. `null` for any rate
     * either period could not compute. Points, not percent-of-percent: a rate
     * going from 0.42% to 0.50% is `+0.08` here.
     */
    delta: {
        testFailureRate: number | null;
        jobFailureRate: number | null;
        skipRate: number | null;
        invalidJobRate: number | null;
    };
}

/** Options for `computeSummary`. */
export interface SummaryOptions {
    /**
     * How many days each period covers. Default 7, and a multiple of 7 is
     * strongly preferred — see the module comment.
     */
    days?: number | undefined;
    /**
     * End the current period at this date instead of at the file's last one.
     * Must be a date the file has; throws otherwise, rather than silently
     * summarizing a different period than the one asked for.
     */
    endDate?: string | undefined;
}

export const DEFAULT_SUMMARY_DAYS = 7;

/**
 * The topline for the most recent `days`, against the `days` before it.
 *
 * Throws when the file has no dates at all, or when `endDate` names a date the
 * file does not have — both are caller errors and both would otherwise produce
 * a confidently wrong number.
 */
export function computeSummary(file: StatsFile, options: SummaryOptions = {}): Summary {
    const days = options.days ?? DEFAULT_SUMMARY_DAYS;
    if (days < 1) {
        throw new Error(`summary period must be at least one day, got ${days}`);
    }
    const rows = statsRows(file);
    if (rows.length === 0) {
        throw new Error('stats file covers no dates');
    }

    // `stats.json` is oldest first, so the current period is the tail.
    let end = rows.length - 1;
    if (options.endDate !== undefined) {
        end = rows.findIndex((row) => row.date === options.endDate);
        if (end === -1) {
            throw new Error(
                `stats file has no date ${options.endDate} ` +
                    `(covers ${rows[0]!.date} … ${rows[rows.length - 1]!.date})`
            );
        }
    }

    const currentStart = Math.max(0, end - days + 1);
    const current = summarizeRows(rows.slice(currentStart, end + 1));

    // The prior period only counts if it is *complete*: a partial window has
    // fewer days and, worse, a different weekday mix, so comparing against it
    // would report the calendar as a trend.
    const priorEnd = currentStart - 1;
    const priorStart = priorEnd - days + 1;
    const prior =
        priorStart >= 0 && priorEnd >= priorStart
            ? summarizeRows(rows.slice(priorStart, priorEnd + 1))
            : null;

    return {
        harness: file.metadata.harness,
        current,
        prior,
        delta: {
            testFailureRate: difference(current.testFailureRate, prior?.testFailureRate),
            jobFailureRate: difference(current.jobFailureRate, prior?.jobFailureRate),
            skipRate: difference(current.skipRate, prior?.skipRate),
            invalidJobRate: difference(current.invalidJobRate, prior?.invalidJobRate),
        },
    };
}

/** Totals a run of rows into one period. */
function summarizeRows(rows: readonly StatsRow[]): PeriodSummary {
    const period: PeriodSummary = {
        startDate: rows[0]?.date ?? '',
        endDate: rows[rows.length - 1]?.date ?? '',
        dayCount: rows.length,
        totalTestRuns: 0,
        failedTestRuns: 0,
        skippedTestRuns: 0,
        processedJobCount: 0,
        failedJobs: 0,
        invalidJobs: 0,
        testFailureRate: null,
        jobFailureRate: null,
        skipRate: null,
        invalidJobRate: null,
    };
    for (const row of rows) {
        period.totalTestRuns += row.totalTestRuns;
        period.failedTestRuns += row.failedTestRuns;
        period.skippedTestRuns += row.skippedTestRuns;
        period.processedJobCount += row.processedJobCount;
        period.failedJobs += row.failedJobs;
        period.invalidJobs += row.invalidJobs;
    }
    period.testFailureRate = rate(period.failedTestRuns, period.totalTestRuns);
    // `processedJobCount + invalidJobs`, not `processedJobCount`: the two are
    // the two disjoint branches the day's jobs are split into, and `failedJobs`
    // is counted over both. See `PeriodSummary.jobFailureRate`.
    period.jobFailureRate = rate(
        period.failedJobs,
        period.processedJobCount + period.invalidJobs
    );
    // `totalTestRuns` already includes the skips; adding them would double-count.
    // See `PeriodSummary.skipRate` for the `run-if` asymmetry.
    period.skipRate = rate(period.skippedTestRuns, period.totalTestRuns);
    period.invalidJobRate = rate(period.invalidJobs, period.processedJobCount);
    return period;
}

/** A percentage, or `null` when the denominator is zero. */
function rate(numerator: number, denominator: number): number | null {
    return denominator > 0 ? (numerator / denominator) * 100 : null;
}

/** The difference in percentage points, or `null` if either side is unknown. */
function difference(current: number | null, prior: number | null | undefined): number | null {
    return current === null || prior === null || prior === undefined ? null : current - prior;
}

/**
 * Per-marker-kind totals over a period, newest `days` dates.
 *
 * The second line of `CLI.md`'s `fx-tests errors` header, available here
 * because `stats.json` carries `markerCounts` per date — so "how noisy is this
 * harness, and in which category" costs the small file rather than the 97 MB
 * errors one.
 *
 * Kind names are read from the data: mochitest carries `TSan Error` from
 * instrumented builds and xpcshell does not, and `FORMATS.md` warns against
 * hardcoding the list.
 */
export function markerTotals(
    file: StatsFile,
    options: SummaryOptions = {}
): Map<string, number> {
    const days = options.days ?? DEFAULT_SUMMARY_DAYS;
    const rows = statsRows(file);
    let end = rows.length - 1;
    if (options.endDate !== undefined) {
        end = rows.findIndex((row) => row.date === options.endDate);
        if (end === -1) {
            throw new Error(`stats file has no date ${options.endDate}`);
        }
    }
    const totals = new Map<string, number>();
    for (const row of rows.slice(Math.max(0, end - days + 1), end + 1)) {
        for (const [kind, count] of Object.entries(row.markerCounts)) {
            totals.set(kind, (totals.get(kind) ?? 0) + count);
        }
    }
    return new Map([...totals].sort((a, b) => b[1] - a[1]));
}
