/**
 * `{harness}-{date}-resources.json` — per-job machine resource usage for one
 * day. Read by `resource-use.html` and `job-speed.html`.
 *
 * Top-level string tables rather than a `tables` object, unlike every other
 * family. There is no `metadata` here at all.
 *
 * **The task IDs in this file have no retry suffix.** Everywhere else
 * `tables.taskIds` stores `"<taskId>.<retryId>"`; here `jobs.taskIds` stores
 * the bare ID, and a non-zero retry appears as `"<taskId>.<retryId>"` — that
 * is, `.0` is omitted and other retries are not. Joining against a timing
 * file therefore needs the suffix normalized on one side or the other.
 */

import type { TableIndex } from './common.ts';

export interface MachineInfo {
    logicalCPUs: number;
    physicalCPUs: number;
    /** Bytes. */
    mainMemory: number;
}

/** Parallel arrays, one entry per job. */
export interface ResourceJobs {
    jobNameIds: TableIndex[];
    /** Chunk number, `null` for unchunked jobs. */
    chunks: (number | null)[];
    /** Bare task IDs; `.0` omitted, other retries suffixed. See above. */
    taskIds: string[];
    repositoryIds: TableIndex[];
    /** Delta-encoded seconds; the base is the start of the file's date. */
    startTimes: number[];
    machineInfoIds: TableIndex[];
    /** Peak resident memory, bytes. */
    maxMemories: number[];
    /** Seconds the machine spent idle during the job. */
    idleTimes: number[];
    /** Seconds of single-core-equivalent CPU time. */
    singleCoreTimes: number[];
    /**
     * Ten buckets of time (seconds) spent at 0–10%, 10–20% … 90–100% total CPU
     * utilization. Always exactly ten entries.
     */
    cpuBuckets: number[][];
}

export interface ResourcesFile {
    jobNames: string[];
    repositories: string[];
    machineInfos: MachineInfo[];
    jobs: ResourceJobs;
}

/** Number of CPU-utilization buckets in `cpuBuckets`. */
export const CPU_BUCKET_COUNT = 10;
