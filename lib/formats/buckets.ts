/**
 * `{harness}-00.json` … `{harness}-3f.json` — the 21-day aggregate, split into
 * 64 buckets by a hash of the test's full path (`getChunkIndex()`,
 * `common-test-data.js:26`).
 *
 * This is the file a single-test query should read: ~3.5 MB against the daily
 * file's ~37 MB, and it carries the whole 21 days. Every status group has a
 * delta-encoded `days` array — passes, skips and failures alike — so a
 * single-day or day-range view is a filter over this file, not a reason to
 * fetch a daily one.
 */

import type { AggregateMetadata, TaskInfo, TestInfo } from './common.ts';
import type {
    DurationsStatusGroup,
    SkipCountsStatusGroup,
    TaskIdsStatusGroup,
} from './status-group.ts';
import { type DecodedTimingFile, decodeTimingFile } from './decode.ts';
import { lookup } from './tables.ts';

export interface BucketMetadata extends AggregateMetadata {
    /** Always 64 in the published files. */
    totalBuckets: number;
    /** 0 … totalBuckets-1; matches the `NN` in the filename, in hex. */
    bucketIndex: number;
}

export interface BucketTables {
    /** Chunk suffix already stripped, as in the issues files. */
    jobNames: string[];
    testPaths: string[];
    testNames: string[];
    repositories: string[];
    statuses: string[];
    taskIds: string[];
    messages: string[];
    crashSignatures: string[];
    components: string[];
    commitIds: string[];
}

export interface BucketFile {
    metadata: BucketMetadata;
    tables: BucketTables;
    /** `taskInfo.chunks` is present here and absent from the other families. */
    taskInfo: TaskInfo;
    testInfo: TestInfo;
    testRuns: (
        | DurationsStatusGroup
        | SkipCountsStatusGroup
        | TaskIdsStatusGroup
        | null
    )[][];
}

/** The bucket index for a test path, as the generator computes it. */
export const BUCKET_COUNT = 64;

// --- decoding ------------------------------------------------------------

/**
 * Wraps a parsed bucket file in the family-independent interface.
 *
 * The file to prefer for a single-test query: 21 days of history for ~3.5 MB
 * and a 125-195 MB heap peak, against a daily file's 37 MB and 235-746 MB
 * (`FORMATS.md`). Every status group carries `days`, so a single-day or
 * day-range view is a **filter on this file**, not a reason to fetch a daily
 * one.
 */
export function decodeBucket(file: BucketFile): DecodedTimingFile {
    return decodeTimingFile({
        family: 'bucket',
        days: file.metadata.days,
        endDate: file.metadata.endDate,
        tables: file.tables,
        testInfo: file.testInfo,
        testRuns: file.testRuns,
        taskJobNameIds: file.taskInfo.jobNameIds,
    });
}

/**
 * Which bucket file holds a test, from its full path.
 *
 * The generator's hash, ported from `getChunkIndex()`
 * (`common-test-data.js:26`): a 32-bit `hash * 31 + c` fold, then a modulo
 * corrected for JavaScript's signed remainder. The `| 0` is load-bearing — it
 * is what keeps the intermediate 32-bit, and without it the hash diverges from
 * the generator's for long paths and the query reads the wrong file.
 */
export function bucketIndexForPath(fullPath: string, totalBuckets = BUCKET_COUNT): number {
    let hash = 0;
    for (let i = 0; i < fullPath.length; i++) {
        hash = ((hash << 5) - hash + fullPath.charCodeAt(i)) | 0;
    }
    return ((hash % totalBuckets) + totalBuckets) % totalBuckets;
}

/** The two-hex-digit name a bucket index has in its filename. */
export function bucketFileSuffix(bucketIndex: number): string {
    return bucketIndex.toString(16).padStart(2, '0');
}

/**
 * The chunk numbers a job ran a test under, from `taskInfo.chunks`.
 *
 * Bucket files are the only family carrying `chunks`, because they are the
 * only one whose `tables.jobNames` is chunk-stripped *and* which keeps task
 * attribution — the chunk has to live somewhere, and here it is a parallel
 * array on `taskInfo` rather than a suffix on the name. `null` means the job
 * is unchunked, which `FORMATS.md` counts 74,699 of on xpcshell.
 */
export function chunkOfTask(file: BucketFile, taskIdIndex: number): number | null {
    return file.taskInfo.chunks?.[taskIdIndex] ?? null;
}

/** The job name a task ran under, resolved through `taskInfo`. */
export function jobNameOfTask(file: BucketFile, taskIdIndex: number): string {
    const jobNameId = file.taskInfo.jobNameIds[taskIdIndex];
    if (jobNameId === undefined) {
        throw new Error(`taskInfo has no entry for task index ${taskIdIndex}`);
    }
    return lookup(file.tables.jobNames, jobNameId, 'tables.jobNames');
}
