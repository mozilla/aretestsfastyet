/**
 * The rate `try.html`'s flakiness column shows, and the tooltip that says which
 * measurement produced it. Shared with `fx-tests try`.
 *
 * `pickHeadlineRate` picks per configuration, prefers each config's recent
 * window, falls back to full history, ranks on a lower confidence bound rather
 * than the raw rate, and falls back to an overall rate when no config shows the
 * same failure. Those four cases give four different numbers from the same
 * counts, so a caller must not state the rate without `flakinessTooltip`.
 *
 * `MIN_RECENT_RUNS` both sizes the window in `computeConfigStats` and sets
 * `lowConfidence` below, so passing a different one to either caveats a rate
 * measured against the other.
 */

import type { ConfigStats } from './config-stats.ts';
import type { TestStats } from './test-stats.ts';

/**
 * How many runs a configuration needs inside the recent window before the page
 * will quote a percentage for it. `old/try.html:2572`.
 *
 * Sized in **runs, not days**, and the comment upstream wrote for it is the
 * reason: push volume varies several-fold over a week, so a fixed number of
 * days would be sparse when measured after a weekend. This is a floor — the
 * window reaches back as far as it needs to hold this many runs, and a
 * configuration that never reaches it gets no recent rate at all.
 *
 * It is also `lib/query/config-stats.ts`'s `minRecentRuns`, passed through. Note
 * that `lib/`'s own default is 20 (`DEFAULT_MIN_RECENT_RUNS`) and this page
 * overrides it to 100: the CLI is answering about one test and can afford a
 * looser threshold, while this page puts the number in a 45px cell with no room
 * to qualify it.
 */
export const MIN_RECENT_RUNS = 100;

/** Fallback day count, for a data file carrying no `metadata.days`. */
export const HISTORY_DAYS = 21;

/** Past a handful the tooltip stops being readable. `old/try.html:2579`. */
export const MAX_TOOLTIP_CONFIGS = 4;

/** One test's 21-day history, as the flakiness worker returns it. */
export interface FlakinessData {
    stats: TestStats;
    /** Whether any config shows this same failure in history. */
    hasMatchingMessage: boolean;
    configs: ConfigStats[];
    totalDays: number;
}

/** The rate the flakiness column shows, and where it came from. */
export interface HeadlineRate {
    rate: number;
    runs: number;
    /** The window's width in days, when the rate came from a recent window. */
    days?: number | undefined;
    /** Whether the rate is the config's recent window or its whole history. */
    recent?: boolean | undefined;
    jobName?: string | undefined;
    /** `config` when a configuration won; `overall` for the fallback. */
    scope: 'config' | 'overall';
    /** The rate rests on fewer runs than a percentage really warrants. */
    lowConfidence?: boolean | undefined;
}

/**
 * The rate to show in the flakiness column. `old/try.html:2766`.
 *
 * The configurations are the ones this test failed on in **this push**, so any
 * of them answers "was this already failing before my push?"; where they
 * disagree, the worst one is the answer that matters. Each config prefers its
 * recent window, which reflects the state of the tree now, and falls back to
 * its full history when it never reached `MIN_RECENT_RUNS` there.
 *
 * ## Why the argmax is on a lower confidence bound
 *
 * `score = rate - 100 / sqrt(runs)` (`old/try.html:2776`). Comparing raw rates lets
 * a config with a hundred runs that happened to land a bit higher beat one with
 * a few hundred, and the tooltip then leads with the noisier number. The
 * penalty is the width of a rough interval: at 100 runs it is 10 points, at
 * 10,000 it is 1. A config with **zero** runs scores 0 rather than `-Infinity`,
 * which is upstream's `r.runs > 0 ? … : 0` and matters because a 0-run config
 * would otherwise be preferred over any config with a genuinely negative score
 * (a low rate over few runs).
 *
 * ## The fallback, and what it changes
 *
 * `if (!best || best.rate === 0)` returns `scope: 'overall'` — the test's whole
 * failure rate across every platform. So a **0% winner is discarded**: when no
 * config in this push's set shows the same failure at all, the column stops
 * answering "does this exact failure pre-exist" and answers "how flaky is this
 * test in general" instead. The tooltip says which, and `hasMatchingMessage`
 * drives the class that colours it.
 *
 * The rate counts failures with the **same message** as the push, which is what
 * makes a failure pre-existing. A test failing often for an unrelated reason
 * says nothing about the failure being triaged, so the all-failure rate is
 * relegated to the tooltip's last line.
 */
export function pickHeadlineRate(
    stats: TestStats,
    configs: readonly ConfigStats[] | undefined
): HeadlineRate {
    const overall = overallRate(stats);
    const rateOf = (config: ConfigStats): HeadlineRate =>
        config.recentSameMsgFailRate !== null
            ? {
                  rate: config.recentSameMsgFailRate,
                  runs: config.recentRunCount,
                  days: config.recentDays,
                  recent: true,
                  scope: 'config',
              }
            : {
                  rate: config.sameMsgFailRate,
                  runs: config.runCount,
                  recent: false,
                  scope: 'config',
              };

    const score = (rate: HeadlineRate): number =>
        rate.runs > 0 ? rate.rate - 100 / Math.sqrt(rate.runs) : 0;

    let best: HeadlineRate | null = null;
    let bestScore = -Infinity;
    for (const config of configs ?? []) {
        const rate = rateOf(config);
        const current = score(rate);
        if (best === null || current > bestScore) {
            best = { ...rate, jobName: config.jobName };
            bestScore = current;
        }
    }
    if (best === null || best.rate === 0) {
        return { rate: overall, runs: stats.runCount, scope: 'overall' };
    }
    return { ...best, scope: 'config', lowConfidence: best.runs < MIN_RECENT_RUNS };
}

/**
 * The test's overall failure rate over the whole window, every platform.
 *
 * `(failCount + crashCount + timeoutCount) / runCount * 100` (`old/try.html:2767`).
 * Note what is **not** in the numerator: `expectedFailCount`. `lib/`'s
 * `TestStats` splits that out where `common-test-data.js` folded it into
 * `passCount`, and both agree that an annotation firing as intended is not a
 * failure — so the arithmetic is identical and the split only makes it explicit.
 */
function overallRate(stats: TestStats): number {
    return stats.runCount > 0
        ? ((stats.failCount + stats.crashCount + stats.timeoutCount) / stats.runCount) * 100
        : 0;
}

/** A percentage as the column and the tooltip write it. `old/try.html:2751`. */
export function formatFailRate(rate: number): string {
    return `${rate.toFixed(1)}%`;
}

/** `the last day` / `the last 7 days`. `old/try.html:2844`. */
export function dayCount(days: number | undefined): string {
    return days === 1 ? 'the last day' : `the last ${days} days`;
}

/**
 * The flakiness cell's tooltip. `old/try.html:2793`.
 *
 * Four sections, and the order is the argument it makes:
 *
 * 1. **The verdict.** Whether history shows this same failure at all is what
 *    decides if the push is to blame, so it leads.
 * 2. **The headline rate**, with the configuration on its own line — the only
 *    part long enough to need the room.
 * 3. **Per configuration**, most-failing first, capped at
 *    `MAX_TOOLTIP_CONFIGS`. Only configs that *show* this failure appear; the
 *    rest would be a list of zeroes under a "same failure" heading. Note the
 *    section header quotes `shown[0].recentDays` — the top config's window —
 *    which is safe because `computeConfigStats` gives every config the same
 *    `recentDays` by construction.
 * 4. **The all-failure rate**, always, as the floor of the argument.
 *
 * The final `filter` drops a blank line that follows another blank line, so a
 * section adding its own leading blank does not double up when the section
 * above it was absent.
 */
export function flakinessTooltip(
    stats: TestStats,
    configs: readonly ConfigStats[] | undefined,
    headline: HeadlineRate,
    hasMatchingMessage: boolean,
    totalDays: number | undefined
): string {
    const overall = overallRate(stats);
    const all = totalDays || HISTORY_DAYS;
    const lines: string[] = [];

    lines.push(
        hasMatchingMessage
            ? 'This failure already happens without your changes.'
            : 'This exact failure was never seen in history — it looks new.',
        ''
    );
    if (headline.scope === 'config') {
        const span = headline.recent === true ? dayCount(headline.days) : `${all} days`;
        lines.push(
            `It fails this way ${formatFailRate(headline.rate)} of the time over ${span} on` +
                (headline.lowConfidence === true
                    ? ` (only ${headline.runs} runs, so approximate)`
                    : ''),
            `${headline.jobName}`
        );
    }

    const rateFor = (config: ConfigStats): { rate: number; runs: number } =>
        config.recentSameMsgFailRate !== null
            ? { rate: config.recentSameMsgFailRate, runs: config.recentRunCount }
            : { rate: config.sameMsgFailRate, runs: config.runCount };
    const shown = (configs ?? [])
        .map((config) => ({
            ...rateFor(config),
            jobName: config.jobName,
            recentDays: config.recentDays,
        }))
        .filter((config) => config.rate > 0)
        .sort((a, b) => b.rate - a.rate);
    if (shown.length > 0) {
        lines.push('', `Same failure over ${dayCount(shown[0]!.recentDays)}, by configuration:`);
        for (const config of shown.slice(0, MAX_TOOLTIP_CONFIGS)) {
            // Tooltips render in a proportional font, so columns cannot be
            // aligned with padding. Leading with the rate reads down the list
            // without needing to line up.
            lines.push(`  ${formatFailRate(config.rate)} of ${config.runs} runs — ${config.jobName}`);
        }
        const hidden = shown.length - MAX_TOOLTIP_CONFIGS;
        if (hidden > 0) {
            lines.push(`  and ${hidden} more configuration${hidden === 1 ? '' : 's'}`);
        }
    }

    lines.push(
        '',
        `Any failure, all platforms, ${all} days: ${formatFailRate(overall)} of ${stats.runCount} runs.`
    );
    return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n');
}
