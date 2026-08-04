/**
 * `{harness}-{date}.json` — every run of every test on one day.
 *
 * The biggest of the timing files (~37 MB for a weekday of xpcshell) and the
 * only one with per-run timestamps and task IDs for *passing* runs. Everything
 * else the 64-bucket files also answer, more cheaply, so this file is worth
 * fetching only for those two things.
 */

import type { DailyMetadata, TableIndex, TaskInfo, TestInfo } from './common.ts';
import type { FlatStatusGroup } from './status-group.ts';

export interface DailyTables {
    jobNames: string[];
    testPaths: string[];
    testNames: string[];
    repositories: string[];
    /** `"<taskId>.<retryId>"`, always with the suffix, including `.0`. */
    taskIds: string[];
    components: string[];
    /** Revision hashes, indexed by `taskInfo.commitIds`. */
    commitIds: string[];
    statuses: string[];
    messages: string[];
    crashSignatures: string[];
}

export interface DailyFile {
    metadata: DailyMetadata;
    tables: DailyTables;
    taskInfo: TaskInfo;
    testInfo: TestInfo;
    /** Indexed by test ID; inner array indexed by status ID. */
    testRuns: (FlatStatusGroup | null)[][];
}

/** Convenience alias for the one index type these tables share. */
export type DailyTableIndex = TableIndex;
