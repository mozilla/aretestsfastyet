/**
 * `{harness}-{date}-errors.json` — the errors and warnings emitted in test
 * logs on one day.
 *
 * **Per-date only.** No multi-day aggregate is published;
 * `{harness}-errors-with-taskids.json` 404s, and the branches in
 * `errors.html:1098` that would read one are dead. So there is no `days` axis
 * here, and "was this error present when the test passed?" is answered by
 * comparing two files, not by joining inside one.
 *
 * **Coverage differs by harness.** xpcshell runs its tests in parallel and can
 * only replay a test's stdout when it fails, so the xpcshell file is limited
 * to failing tests' output — a biased population, not a small sample. Mochitest
 * has no such restriction. Do not total the two together.
 *
 * Two levels of interning:
 *
 *  1. `messages[i]` is a distinct (marker kind, text, file, line) tuple.
 *  2. `markers` is a list of (test, message) groups, each with a
 *     **delta-encoded** `taskIdIds` array and a parallel `counts` array giving
 *     the occurrence count in that task.
 *
 * The delta encoding on `taskIdIds` is per-group and starts from 0, so the
 * first element is an absolute index and later ones are increments.
 */

import type { TableIndex } from './common.ts';

export interface ErrorsMetadata {
    date: string;
    /** Unix seconds for the start of `date`. */
    startTime: number;
    generatedAt: string;
    jobCount: number;
    processedJobCount: number;
    invalidJobCount: number;
    /**
     * Total occurrences per marker kind, over the whole file. Kind names are
     * data — mochitest carries `TSan Error` on instrumented builds, xpcshell
     * does not — so read the keys rather than hardcoding a list.
     */
    markerCounts: Record<string, number>;
}

export interface ErrorsTables {
    jobNames: string[];
    testPaths: string[];
    testNames: string[];
    repositories: string[];
    /** `"<taskId>.<retryId>"`, suffix always present. */
    taskIds: string[];
    components: string[];
    commitIds: string[];
    /** The marker kinds; same names as the keys of `metadata.markerCounts`. */
    markerNames: string[];
    messageTexts: string[];
    /** Source files a message was emitted from. */
    files: string[];
}

/**
 * The distinct messages, as parallel arrays. Grouping is by source location as
 * well as text: the same text from two files is two entries, which is the
 * change `errors.html` made to group by location rather than message alone.
 */
export interface ErrorsMessages {
    markerNameIds: TableIndex[];
    textIds: TableIndex[];
    /** `null` when the message carries no source file. */
    fileIds: (TableIndex | null)[];
    /** `null` when the message carries no line number. */
    lines: (number | null)[];
    componentIds: TableIndex[];
}

export interface ErrorsTaskInfo {
    repositoryIds: TableIndex[];
    jobNameIds: TableIndex[];
    commitIds: TableIndex[];
}

export interface ErrorsTestInfo {
    testPathIds: TableIndex[];
    testNameIds: TableIndex[];
    componentIds: TableIndex[];
}

/**
 * The (test, message) groups. All four arrays have the same length; within a
 * group, `taskIdIds[i]` and `counts[i]` are parallel.
 */
export interface ErrorsMarkers {
    testIds: TableIndex[];
    messageIds: TableIndex[];
    /** Delta-encoded indices into `tables.taskIds`, ascending within a group. */
    taskIdIds: number[][];
    /** Occurrences of this message in this test in that task. */
    counts: number[][];
}

export interface ErrorsFile {
    metadata: ErrorsMetadata;
    tables: ErrorsTables;
    messages: ErrorsMessages;
    taskInfo: ErrorsTaskInfo;
    testInfo: ErrorsTestInfo;
    markers: ErrorsMarkers;
}
