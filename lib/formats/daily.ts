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
import { type DecodedTimingFile, decodeTimingFile } from './decode.ts';

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

// --- decoding ------------------------------------------------------------

/**
 * Wraps a parsed daily file in the family-independent interface.
 *
 * Passes `metadata.startTime` through so the entries' `timestamps` come out as
 * absolute Unix seconds. This is the only family that records when a run
 * happened, and it is the reason to read a 37 MB file rather than a 3.5 MB
 * bucket one.
 *
 * `days` is `null`: the file covers exactly one day, so its status groups have
 * no `days` array and every entry's `day` is `null` rather than 0. A caller
 * that wants "day 0 of a one-day file" is really asking about the date, which
 * is `endDate`.
 */
export function decodeDaily(file: DailyFile): DecodedTimingFile {
    return decodeTimingFile({
        family: 'daily',
        days: null,
        endDate: file.metadata.date,
        tables: file.tables,
        testInfo: file.testInfo,
        testRuns: file.testRuns,
        taskJobNameIds: file.taskInfo.jobNameIds,
        iterateOptions: { startTime: file.metadata.startTime },
    });
}
