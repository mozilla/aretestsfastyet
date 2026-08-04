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
import { TableIndexError, lookup, normalizeTaskId } from './tables.ts';

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

// --- decoding ------------------------------------------------------------

/** One job's resource usage, with the tables and deltas resolved. */
export interface DecodedResourceJob {
    /** Index into the file's parallel arrays. */
    index: number;
    /** The job name as stored, chunk suffix and all. */
    jobName: string;
    /** Chunk number, `null` for an unchunked job. */
    chunk: number | null;
    /**
     * The task ID normalized to `"<taskId>.<retryId>"`, so it joins against a
     * timing file's `tables.taskIds` directly. The raw form is in `rawTaskId`.
     */
    taskId: string;
    /** The task ID exactly as the file stores it: `.0` omitted. */
    rawTaskId: string;
    repository: string;
    /** Absolute Unix seconds, delta-decoded. */
    startTime: number;
    machine: MachineInfo;
    /** Peak resident memory, bytes. */
    maxMemory: number;
    /** Seconds the machine spent idle during the job. */
    idleTime: number;
    /** Seconds of single-core-equivalent CPU time. */
    singleCoreTime: number;
    /** Ten buckets of seconds at 0-10%, 10-20% … 90-100% CPU. */
    cpuBuckets: number[];
}

/**
 * Decodes every job in a resources file.
 *
 * Two things this resolves that a caller should not have to:
 *
 * - `startTimes` are delta-encoded from the start of the file's date, which
 *   the file itself does not record — there is no `metadata` here at all. The
 *   caller passes `dayStartTime`, which is the matching daily file's
 *   `metadata.startTime`. Omitting it yields seconds since midnight of an
 *   unnamed day, which is almost never what anyone wants.
 * - Task IDs come out normalized to the timing files' `"<taskId>.<retryId>"`
 *   form. `FORMATS.md` measured that this file omits `.0` on every entry and
 *   suffixes 0.5-5% of them, so a textual join against a timing file fails on
 *   most rows unless one side is normalized.
 */
export function decodeResourceJobs(
    file: ResourcesFile,
    dayStartTime = 0
): DecodedResourceJob[] {
    const { jobs } = file;
    const count = jobs.taskIds.length;

    // `jobs` is a set of parallel arrays, so a short one is a corrupt file
    // rather than a job with a missing field. Substituting 0 for a missing
    // `maxMemories` entry would report a job that used no memory, which is a
    // plausible-looking wrong answer of exactly the kind the status-group
    // decoder throws on — so this checks up front and throws too.
    const lengths: Record<string, number> = {
        taskIds: count,
        jobNameIds: jobs.jobNameIds.length,
        chunks: jobs.chunks.length,
        repositoryIds: jobs.repositoryIds.length,
        startTimes: jobs.startTimes.length,
        machineInfoIds: jobs.machineInfoIds.length,
        maxMemories: jobs.maxMemories.length,
        idleTimes: jobs.idleTimes.length,
        singleCoreTimes: jobs.singleCoreTimes.length,
        cpuBuckets: jobs.cpuBuckets.length,
    };
    const misaligned = Object.entries(lengths).filter(([, length]) => length !== count);
    if (misaligned.length > 0) {
        throw new Error(
            `resources jobs arrays are misaligned: ${count} task IDs but ` +
                misaligned.map(([key, length]) => `${key}=${length}`).join(', ')
        );
    }

    const out: DecodedResourceJob[] = [];
    let startTime = dayStartTime;
    for (let i = 0; i < count; i++) {
        startTime += jobs.startTimes[i]!;
        const rawTaskId = jobs.taskIds[i]!;
        const cpuBuckets = jobs.cpuBuckets[i]!;
        if (cpuBuckets.length !== CPU_BUCKET_COUNT) {
            throw new Error(
                `job ${i} has ${cpuBuckets.length} CPU buckets, expected ${CPU_BUCKET_COUNT}`
            );
        }
        out.push({
            index: i,
            jobName: lookup(file.jobNames, jobs.jobNameIds[i]!, 'jobNames'),
            // A null chunk is a real value — an unchunked job — so it reads
            // through, unlike the missing slots above.
            chunk: jobs.chunks[i]!,
            taskId: normalizeTaskId(rawTaskId),
            rawTaskId,
            repository: lookup(file.repositories, jobs.repositoryIds[i]!, 'repositories'),
            startTime,
            machine: machineInfoAt(file, jobs.machineInfoIds[i]!),
            maxMemory: jobs.maxMemories[i]!,
            idleTime: jobs.idleTimes[i]!,
            singleCoreTime: jobs.singleCoreTimes[i]!,
            cpuBuckets: cpuBuckets.slice(),
        });
    }
    return out;
}

/** Reads a machine-info entry, throwing on an index the table does not have. */
export function machineInfoAt(file: ResourcesFile, index: number): MachineInfo {
    const info = file.machineInfos[index];
    if (info === undefined) {
        throw new TableIndexError('machineInfos', index, file.machineInfos.length);
    }
    return info;
}

/**
 * Indexes a resources file by normalized task ID, for joining against a timing
 * file.
 *
 * The join this exists for is "how much memory did the job that ran this test
 * use", which needs a timing file for the test and this file for the machine.
 */
export function indexResourceJobsByTaskId(
    file: ResourcesFile,
    dayStartTime = 0
): Map<string, DecodedResourceJob> {
    const byTaskId = new Map<string, DecodedResourceJob>();
    for (const job of decodeResourceJobs(file, dayStartTime)) {
        byTaskId.set(job.taskId, job);
    }
    return byTaskId;
}
