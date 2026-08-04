/**
 * Pieces shared by more than one file family.
 *
 * These declarations describe the JSON as it is published, not as it would be
 * convenient to consume it — the decoders in `lib/formats/*.ts` are what turn
 * these into plain objects. Every claim here was checked against whole
 * published files by `tools/validate-formats.ts`; the nullable/absent fields
 * are documented in `lib/formats/FORMATS.md`.
 */

/** A `YYYY-MM-DD` date, as used for filenames and in `metadata`. */
export type DateString = string;

/**
 * A task ID as stored in a `tables.taskIds` table: `"<taskId>.<retryId>"`.
 *
 * The timing files (daily, buckets, issues-with-taskids) always carry the
 * `.<retryId>` suffix, including `.0`. The resource files store the bare task
 * ID with no suffix at all — see `ResourcesFile.jobs.taskIds`.
 */
export type SuffixedTaskId = string;

/**
 * An index into a string table, or into a parallel array. Always a
 * non-negative integer, and always in range for the table it indexes; the
 * validator checks both.
 */
export type TableIndex = number;

/**
 * A delta-encoded day index: each entry holds the increment from the previous
 * one, and day 0 is the *oldest* day covered by the file. Present on every
 * status group of the 21-day files (issues, issues-with-taskids, buckets) and
 * absent from the daily files, which cover one day by construction.
 */
export type DeltaDays = number[];

/** Common `metadata` fields on the 21-day aggregates. */
export interface AggregateMetadata {
    startDate: DateString;
    endDate: DateString;
    /** Number of days covered; day indices run 0 … days-1, oldest first. */
    days: number;
    /** Unix seconds for the start of `startDate`. */
    startTime: number;
    generatedAt: string;
    totalTestCount: number;
    testsWithFailures: number;
    /**
     * The per-date files this aggregate was built from, newest first — as
     * *filenames* (`"xpcshell-2026-08-03.json"`), not as dates. The date has
     * to be parsed out of the name if it is wanted.
     */
    aggregatedFrom: string[];
}

/** Common `metadata` fields on the per-date files. */
export interface DailyMetadata {
    date: DateString;
    /** Unix seconds for the start of `date`; run timestamps are offsets from it. */
    startTime: number;
    generatedAt: string;
    jobCount: number;
    processedJobCount: number;
    invalidJobCount: number;
}

/**
 * `taskInfo`, present on every file that has a `tables.taskIds`. Parallel
 * arrays indexed by task-ID index.
 */
export interface TaskInfo {
    repositoryIds: TableIndex[];
    jobNameIds: TableIndex[];
    commitIds: TableIndex[];
    /**
     * Chunk number of the job, `null` for unchunked jobs. Present on the
     * 64-bucket files; absent from the daily and issues-with-taskids files,
     * whose job names carry the chunk suffix in the name instead.
     */
    chunks?: (number | null)[];
}

/** `testInfo`, parallel arrays indexed by test index. */
export interface TestInfo {
    testPathIds: TableIndex[];
    testNameIds: TableIndex[];
    /**
     * Bugzilla component of the test, `null` when unknown. Observed null in
     * the issues files; never null in the daily or bucket files, but the
     * generator makes no such guarantee, so treat it as nullable everywhere.
     */
    componentIds: (TableIndex | null)[];
}
