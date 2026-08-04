/**
 * `{harness}-issues.json` and `{harness}-issues-with-taskids.json` — the
 * 21-day aggregates, every test in the tree.
 *
 * The two files carry the same tests, statuses, messages and day buckets. What
 * `-with-taskids` adds is task attribution on the *non-passing* groups; the
 * PASS-like groups keep the `counts` shape, so despite the name the file has
 * no task IDs for passing runs. It costs about 5× the bytes for that
 * (xpcshell: 2.8 MB vs 15.7 MB).
 */

import type { AggregateMetadata, TaskInfo, TestInfo } from './common.ts';
import type { CountsStatusGroup, TaskIdsStatusGroup } from './status-group.ts';
import { type DecodedTimingFile, decodeTimingFile } from './decode.ts';

export interface IssuesTables {
    testPaths: string[];
    testNames: string[];
    statuses: string[];
    messages: string[];
    crashSignatures: string[];
    components: string[];
}

/** `{harness}-issues.json`: counts only, no `taskInfo`, no job names. */
export interface IssuesFile {
    metadata: AggregateMetadata;
    tables: IssuesTables;
    testInfo: TestInfo;
    testRuns: (CountsStatusGroup | null)[][];
}

export interface IssuesWithTaskIdsTables extends IssuesTables {
    /**
     * Job names with the chunk suffix already stripped, unlike the daily
     * files — `stripChunkSuffix()` (`common-test-data.js:80`) is a no-op here.
     */
    jobNames: string[];
    repositories: string[];
    taskIds: string[];
    commitIds: string[];
}

/**
 * `{harness}-issues-with-taskids.json`: the same aggregate with `taskIdIds` on
 * the non-passing groups. Pass-like groups remain `CountsStatusGroup`.
 */
export interface IssuesWithTaskIdsFile {
    metadata: AggregateMetadata;
    tables: IssuesWithTaskIdsTables;
    taskInfo: TaskInfo;
    testInfo: TestInfo;
    testRuns: (CountsStatusGroup | TaskIdsStatusGroup | null)[][];
}

// --- decoding ------------------------------------------------------------

/**
 * Wraps a parsed `{harness}-issues.json` in the family-independent interface.
 *
 * Every entry has a `count` and a `day` and nothing else: this file gave up
 * all attribution in exchange for being 2.8 MB. A query that needs to know
 * *which* job or task saw a failure has to read `-with-taskids` or a bucket
 * file, and `entry.jobName === undefined` is how it finds that out.
 */
export function decodeIssues(file: IssuesFile): DecodedTimingFile {
    return decodeTimingFile({
        family: 'issues',
        days: file.metadata.days,
        endDate: file.metadata.endDate,
        tables: file.tables,
        testInfo: file.testInfo,
        testRuns: file.testRuns,
    });
}

/**
 * Wraps a parsed `{harness}-issues-with-taskids.json`.
 *
 * The pass-like groups keep the `counts` shape, so this file still has no task
 * IDs for passing runs despite its name — `FORMATS.md` confirms it across the
 * whole file. What it adds is task attribution on the non-passing groups, at
 * about 5× the bytes.
 */
export function decodeIssuesWithTaskIds(file: IssuesWithTaskIdsFile): DecodedTimingFile {
    return decodeTimingFile({
        family: 'issues-with-taskids',
        days: file.metadata.days,
        endDate: file.metadata.endDate,
        tables: file.tables,
        testInfo: file.testInfo,
        testRuns: file.testRuns,
        taskJobNameIds: file.taskInfo.jobNameIds,
    });
}
