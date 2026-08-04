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
