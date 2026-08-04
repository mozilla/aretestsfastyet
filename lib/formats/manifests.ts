/**
 * `manifests.json` — per-manifest run times, from the `manifest-timings`
 * index (its own index, its own shape). Read by `manifests.html`.
 *
 * **One day, not an aggregate**, despite there being no date in the filename:
 * `metadata.date` names the day it covers, and the index publishes only the
 * latest. There is no `days` axis and no 21-day window here.
 *
 * The rule that is not visible in the format: **a manifest whose durations are
 * all zero on a config was skipped there, not run instantly**
 * (`manifests.html:415`). Zero durations are common — 71,272 of 433,836 runs
 * on 2026-08-03 — so missing this makes every skipped config read as
 * infinitely fast.
 *
 * `runs.jobNameIds[i]` and `tasks.jobName[runs.taskIds[i]]` are **not** the
 * same string, which is easy to assume and wrong: the run's job name has the
 * chunk suffix stripped and the task's keeps it. On 2026-08-03 they differed
 * on 360,373 of 433,836 runs, and agreed on all 433,836 once the trailing
 * `-<chunk>` was stripped from the task's. Both index the same `jobNames`
 * table, which is why the difference is invisible in the shape — pick the one
 * that answers the question: per-config aggregation wants the stripped name,
 * identifying an individual job wants the chunked one.
 */

import type { TableIndex } from './common.ts';

export interface ManifestsMetadata {
    /** The single day this file covers. */
    date: string;
    repository: string;
    generatedAt: string;
    processedJobCount: number;
    failedJobCount: number;
}

/** Parallel arrays, one entry per task. */
export interface ManifestTasks {
    /** Bare task IDs, with **no** `.<retryId>` suffix. */
    id: string[];
    jobName: TableIndex[];
    commitId: TableIndex[];
    /** Index into `prefixes`: the harness family (`mochitest-plain`, `wpt`, …). */
    prefix: TableIndex[];
}

/** Parallel arrays, one entry per (manifest, job, task) run. */
export interface ManifestRuns {
    manifestIds: TableIndex[];
    jobNameIds: TableIndex[];
    /** Index into `tasks`, not into a string table. */
    taskIds: TableIndex[];
    /** Milliseconds. Zero means the manifest was skipped — see above. */
    durations: number[];
}

export interface ManifestsFile {
    metadata: ManifestsMetadata;
    manifests: string[];
    jobNames: string[];
    commits: string[];
    prefixes: string[];
    tasks: ManifestTasks;
    runs: ManifestRuns;
}

// --- decoding ------------------------------------------------------------

/** One run of one manifest, with its tables resolved. */
export interface ManifestRun {
    /** Index into `runs`' parallel arrays. */
    runIndex: number;
    manifestId: number;
    manifest: string;
    /**
     * The **configuration**: the run's own job name, chunk suffix already
     * stripped by the generator.
     *
     * This is the name to aggregate on. See the module comment for why picking
     * `tasks.jobName` instead silently splits configurations.
     */
    configuration: string;
    /**
     * The job name of the individual task, chunk suffix **kept**.
     *
     * The name to use when identifying one job rather than grouping. Differs
     * from `configuration` on 83% of runs.
     */
    jobName: string;
    /** The bare task ID — no `.<retryId>` suffix in this family. */
    taskId: string;
    /** The harness family (`wpt`, `mochitest-browser-chrome`, …). */
    prefix: string;
    /** Milliseconds. Zero is not "instant" — see `skipped` below. */
    duration: number;
}

/** A decoded `manifests.json`. */
export interface DecodedManifestsFile {
    /** The single day this file covers. There is no window here. */
    date: string;
    repository: string;
    generatedAt: string;
    processedJobCount: number;
    failedJobCount: number;
    /** How many (manifest, job, task) runs the file holds. */
    runCount: number;
    /** How many distinct manifests it names. */
    manifestCount: number;
    manifestAt(manifestId: number): string;
    /** Walks every run with its tables resolved. */
    runs(): Generator<ManifestRun>;
}

/**
 * Wraps a parsed `manifests.json`.
 *
 * The one thing this does beyond index lookups is expose **both** job names
 * under names that say which is which, so a caller has to choose rather than
 * reaching for whichever field it saw first. That choice is the trap
 * `FORMATS.md` measures at 360,373 of 433,836 runs.
 */
export function decodeManifests(file: ManifestsFile): DecodedManifestsFile {
    const { runs, tasks, metadata } = file;
    const runCount = runs.manifestIds.length;
    if (
        runs.jobNameIds.length !== runCount ||
        runs.taskIds.length !== runCount ||
        runs.durations.length !== runCount
    ) {
        // A length mismatch misattributes every duration to the wrong manifest
        // or job, so it throws rather than producing a plausible ranking.
        throw new Error(
            'runs arrays are not parallel: ' +
                `manifestIds ${runCount}, jobNameIds ${runs.jobNameIds.length}, ` +
                `taskIds ${runs.taskIds.length}, durations ${runs.durations.length}`
        );
    }

    const at = (table: readonly string[], index: number, name: string): string => {
        const value = table[index];
        if (value === undefined) {
            throw new Error(`index ${index} out of range for ${name} (length ${table.length})`);
        }
        return value;
    };

    return {
        date: metadata.date,
        repository: metadata.repository,
        generatedAt: metadata.generatedAt,
        processedJobCount: metadata.processedJobCount,
        failedJobCount: metadata.failedJobCount,
        runCount,
        manifestCount: file.manifests.length,

        manifestAt(manifestId: number): string {
            return at(file.manifests, manifestId, 'manifests');
        },

        *runs(): Generator<ManifestRun> {
            for (let i = 0; i < runCount; i++) {
                const manifestId = runs.manifestIds[i]!;
                const taskIndex = runs.taskIds[i]!;
                const taskJobNameId = tasks.jobName[taskIndex];
                if (taskJobNameId === undefined) {
                    throw new Error(
                        `runs.taskIds[${i}] = ${taskIndex} is out of range for tasks ` +
                            `(length ${tasks.jobName.length})`
                    );
                }
                yield {
                    runIndex: i,
                    manifestId,
                    manifest: at(file.manifests, manifestId, 'manifests'),
                    configuration: at(file.jobNames, runs.jobNameIds[i]!, 'jobNames'),
                    jobName: at(file.jobNames, taskJobNameId, 'jobNames'),
                    taskId: at(tasks.id, taskIndex, 'tasks.id'),
                    prefix: at(file.prefixes, tasks.prefix[taskIndex]!, 'prefixes'),
                    duration: runs.durations[i]!,
                };
            }
        },
    };
}
