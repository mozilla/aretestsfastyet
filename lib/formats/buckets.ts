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
