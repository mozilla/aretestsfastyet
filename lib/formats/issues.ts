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
