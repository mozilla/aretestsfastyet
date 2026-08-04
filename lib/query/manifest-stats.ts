/**
 * Per-manifest run times, per configuration.
 *
 * Behind `fx-tests manifests`. The question it answers is narrow and worth
 * stating precisely, because it is easy to expect more from this data than it
 * holds: **a job is timing out — which manifest is eating the budget, and on
 * which configs is it worst?**
 *
 * It does *not* say why a manifest is slow. The file has per-manifest
 * durations, not per-test ones, so "one slow test or a thousand cheap ones" is
 * a question for `fx-tests test --durations` on the tests in that manifest.
 * The manifest view narrows the search to a manifest and a config; the per-test
 * view explains it. Neither substitutes for the other.
 *
 * ## The all-zero-durations rule
 *
 * The rule that is invisible in the format and changes a sixth of the data: **a
 * manifest whose durations are all zero on a config was skipped there, not run
 * instantly** (`manifests.html:415`). `FORMATS.md` measures 71,272 of 433,836
 * runs at zero on 2026-08-03 — 16.4%.
 *
 * Miss it and every skipped config reads as infinitely fast, which inverts the
 * answer to the only question being asked: the configs that look best are the
 * ones that did not run. So a skipped (manifest, config) pair reports **no
 * duration statistics at all** rather than zeros, and is listed separately.
 *
 * The rule is per (manifest, config) pair and it is `every`, not `any`. A pair
 * with some zero and some non-zero durations ran — the zeros there are runs
 * that finished under the timer's resolution — and folding those into "skipped"
 * would drop real runs from the denominator.
 *
 * ## Which job name
 *
 * `runs.jobNameIds` is chunk-stripped and `tasks.jobName` is not, and they
 * differ on 83% of runs (`FORMATS.md`: 360,373 of 433,836). Aggregating per
 * configuration wants the stripped one, so that is what `configuration` keys
 * on. Using the chunked name would split every chunked suite into one row per
 * chunk, which reads as many fast configs instead of one slow one.
 */

import type { DecodedManifestsFile, ManifestRun } from '../formats/manifests.ts';
import { type OperatingSystem, parseJobName } from '../model/job-name.ts';

/** Duration statistics, in milliseconds. */
export interface DurationStats {
    runCount: number;
    min: number;
    median: number;
    p95: number;
    max: number;
    /** Total time across every run — what a budget is actually spent on. */
    total: number;
}

/** One (manifest, configuration) pair. */
export interface ManifestConfigStats {
    configuration: string;
    /** The coarse OS, or `null` when the job name does not parse. */
    os: OperatingSystem | null;
    /** How many runs the pair had, skipped ones included. */
    runCount: number;
    /**
     * True when **every** duration was zero: the manifest was skipped on this
     * config rather than run instantly. `durations` is `null` in that case.
     */
    skipped: boolean;
    /** `null` when `skipped` — there is nothing to report, not zeros. */
    durations: DurationStats | null;
}

/** One manifest, across every configuration it appeared on. */
export interface ManifestStats {
    manifest: string;
    /** Configurations where it actually ran, worst median first. */
    configs: ManifestConfigStats[];
    /** Configurations where it was skipped (all durations zero). */
    skippedOn: string[];
    /** Runs on configs where it ran. Skipped runs are not counted here. */
    runCount: number;
    /**
     * Duration statistics pooled over every config where it ran.
     *
     * `null` when it was skipped everywhere — a manifest that ran nowhere has
     * no runtime, and reporting 0 would rank it as the fastest in the tree.
     */
    durations: DurationStats | null;
    /** Distinct platforms it ran on, with how many configs each. */
    platforms: { platform: string; configCount: number }[];
}

/** Options for `computeManifestStats`. */
export interface ManifestStatsOptions {
    /** Only manifests whose name contains this. */
    manifest?: string | undefined;
    /** Only configurations matching this predicate. `CLI.md`'s `--job`/`--config`. */
    jobFilter?: ((configuration: string) => boolean) | undefined;
    /** Only these coarse platforms. */
    platforms?: readonly string[] | undefined;
    /** Drop manifests whose median is below this, in milliseconds. */
    slowerThanMs?: number | undefined;
}

/** How manifests are ranked. `CLI.md`'s `--sort`. */
export type ManifestSort = 'median' | 'p95' | 'max' | 'runs' | 'total' | 'name';

/**
 * Aggregates a day's runs into per-manifest, per-configuration statistics.
 *
 * One pass to bucket durations by (manifest, configuration), then a sort per
 * bucket. The buckets hold raw numbers rather than objects: 433,836 runs is
 * small enough not to need more care than that, and large enough that an object
 * per run would be wasteful for no gain.
 */
export function computeManifestStats(
    file: DecodedManifestsFile,
    options: ManifestStatsOptions = {}
): ManifestStats[] {
    const needle = options.manifest?.toLowerCase();
    const platforms = options.platforms === undefined ? null : new Set(options.platforms);

    /** manifest -> configuration -> durations */
    const byManifest = new Map<string, Map<string, number[]>>();

    for (const run of file.runs()) {
        if (needle !== undefined && !run.manifest.toLowerCase().includes(needle)) {
            continue;
        }
        // The chunk-stripped name — see the module comment.
        const configuration = run.configuration;
        if (options.jobFilter !== undefined && !options.jobFilter(configuration)) {
            continue;
        }
        if (platforms !== null) {
            const os = parseJobName(configuration).os;
            if (os === null || !platforms.has(os)) {
                continue;
            }
        }
        let configs = byManifest.get(run.manifest);
        if (configs === undefined) {
            configs = new Map();
            byManifest.set(run.manifest, configs);
        }
        const durations = configs.get(configuration);
        if (durations === undefined) {
            configs.set(configuration, [run.duration]);
        } else {
            durations.push(run.duration);
        }
    }

    const out: ManifestStats[] = [];
    for (const [manifest, configs] of byManifest) {
        const configStats: ManifestConfigStats[] = [];
        const skippedOn: string[] = [];
        const pooled: number[] = [];

        for (const [configuration, durations] of configs) {
            // `every`, not `any`: a pair with some non-zero durations ran, and
            // its zeros are runs that finished under the timer's resolution.
            const skipped = durations.every((duration) => duration === 0);
            if (skipped) {
                skippedOn.push(configuration);
                configStats.push({
                    configuration,
                    os: parseJobName(configuration).os,
                    runCount: durations.length,
                    skipped: true,
                    // Not zeros. A skipped config has no runtime to report, and
                    // zeros would make it the fastest row in the table.
                    durations: null,
                });
                continue;
            }
            pooled.push(...durations);
            configStats.push({
                configuration,
                os: parseJobName(configuration).os,
                runCount: durations.length,
                skipped: false,
                durations: summarize(durations),
            });
        }

        const ran = configStats.filter((config) => !config.skipped);
        configStats.sort(compareConfigs);
        skippedOn.sort();

        const platformCounts = new Map<string, number>();
        for (const config of ran) {
            const key = config.os ?? '(unparsed)';
            platformCounts.set(key, (platformCounts.get(key) ?? 0) + 1);
        }

        const stats: ManifestStats = {
            manifest,
            configs: configStats,
            skippedOn,
            runCount: ran.reduce((sum, config) => sum + config.runCount, 0),
            durations: pooled.length === 0 ? null : summarize(pooled),
            platforms: [...platformCounts]
                .map(([platform, configCount]) => ({ platform, configCount }))
                .sort((a, b) => b.configCount - a.configCount || a.platform.localeCompare(b.platform)),
        };

        if (
            options.slowerThanMs !== undefined &&
            (stats.durations === null || stats.durations.median < options.slowerThanMs)
        ) {
            // A manifest skipped everywhere has no median, so it cannot clear a
            // "slower than" bar. Dropping it is right; treating its absent
            // median as 0 and *keeping* it would be the same mistake as before.
            continue;
        }
        out.push(stats);
    }

    return out;
}

/**
 * Sorts configurations worst-first, with skipped ones last.
 *
 * Skipped configs go to the bottom rather than to the top, which is where a
 * zero median would put them. That ordering is the visible half of the
 * all-zero rule: the table's first row is the slowest config that actually ran.
 *
 * The `?? -1` is what implements it, and it is load-bearing rather than
 * defensive. A skipped config has `durations === null`, and every real median
 * is at least 0, so a sentinel below zero sorts it after all of them under the
 * descending comparison — no separate branch needed.
 *
 * This used to open with `if (a.skipped !== b.skipped) return a.skipped ? 1 :
 * -1`, which read as the rule and was not: the sentinel already produced that
 * order, so deleting the branch changed no output on any input. Mutation
 * testing found it — the mutation survived a suite that covers this ordering
 * from three directions — and it is recorded here because "an explicit guard
 * that duplicates a fallback" is the same unreachable-by-effect shape a review
 * already found once in `config-stats.ts`.
 */
function compareConfigs(a: ManifestConfigStats, b: ManifestConfigStats): number {
    const aMedian = a.durations?.median ?? -1;
    const bMedian = b.durations?.median ?? -1;
    return bMedian - aMedian || a.configuration.localeCompare(b.configuration);
}

/** Sorts manifests by the requested key, worst first (except `name`). */
export function sortManifests(rows: ManifestStats[], by: ManifestSort): ManifestStats[] {
    const sorted = [...rows];
    if (by === 'name') {
        sorted.sort((a, b) => a.manifest.localeCompare(b.manifest));
        return sorted;
    }
    if (by === 'runs') {
        sorted.sort((a, b) => b.runCount - a.runCount || a.manifest.localeCompare(b.manifest));
        return sorted;
    }
    // A manifest skipped everywhere sorts last rather than first: its absent
    // statistics must not read as the smallest number.
    const value = (row: ManifestStats): number => {
        if (row.durations === null) {
            return -1;
        }
        return by === 'median'
            ? row.durations.median
            : by === 'p95'
              ? row.durations.p95
              : by === 'max'
                ? row.durations.max
                : row.durations.total;
    };
    sorted.sort((a, b) => value(b) - value(a) || a.manifest.localeCompare(b.manifest));
    return sorted;
}

/**
 * Duration statistics from an unsorted array.
 *
 * Copies before sorting: the caller's array is the accumulator and sorting it
 * in place would reorder a bucket that is still being pooled.
 */
export function summarize(durations: readonly number[]): DurationStats {
    if (durations.length === 0) {
        throw new Error('cannot summarize an empty duration list');
    }
    const sorted = [...durations].sort((a, b) => a - b);
    let total = 0;
    for (const duration of sorted) {
        total += duration;
    }
    return {
        runCount: sorted.length,
        min: sorted[0]!,
        median: quantile(sorted, 0.5),
        p95: quantile(sorted, 0.95),
        max: sorted[sorted.length - 1]!,
        total,
    };
}

/** The nearest-rank quantile of a sorted array. */
function quantile(sorted: readonly number[], q: number): number {
    const rank = Math.ceil(q * sorted.length);
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

/**
 * How many runs in the file had a zero duration, and how many pairs that makes
 * skipped.
 *
 * Reported by the command as a one-line note, because the share is large —
 * 16.4% of runs on 2026-08-03 — and someone reading a manifest table should
 * know how much of the data is "did not run here" rather than "ran fast".
 */
export function zeroDurationCensus(file: DecodedManifestsFile): {
    zeroRuns: number;
    totalRuns: number;
    skippedPairs: number;
    totalPairs: number;
} {
    let zeroRuns = 0;
    let totalRuns = 0;
    /** (manifest, configuration) -> whether every duration so far was zero. */
    const pairs = new Map<string, boolean>();
    for (const run of file.runs()) {
        totalRuns += 1;
        if (run.duration === 0) {
            zeroRuns += 1;
        }
        const key = `${run.manifestId} ${run.configuration}`;
        const allZeroSoFar = pairs.get(key);
        pairs.set(key, (allZeroSoFar ?? true) && run.duration === 0);
    }
    let skippedPairs = 0;
    for (const allZero of pairs.values()) {
        if (allZero) {
            skippedPairs += 1;
        }
    }
    return { zeroRuns, totalRuns, skippedPairs, totalPairs: pairs.size };
}

/** A `ManifestRun` predicate built from `--config` / `--exclude-config`. */
export function configurationFilter(
    include: readonly string[],
    exclude: readonly string[]
): (configuration: string) => boolean {
    return (configuration: string): boolean => {
        if (include.length > 0 && !include.some((needle) => configuration.includes(needle))) {
            return false;
        }
        return !exclude.some((needle) => configuration.includes(needle));
    };
}

/** Re-exported so the command can name the type without a second import. */
export type { ManifestRun };
