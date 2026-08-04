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
 * **And not for every date.** `index.json` lists 21 dates and the index task
 * publishes 21 daily and 21 resources files, but only **5** errors files —
 * 2026-07-30 … 2026-08-03 when this was measured, for both harnesses; the
 * other 16 dates 404. So the errors window is its own, shorter window, and a
 * date inside the 21-day one can still have no errors data. A caller must
 * discover which dates exist rather than deriving them from `index.json`.
 * See `FORMATS.md`.
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

import type { TableIndex, TaskInfo, TestInfo } from './common.ts';
import { forEachDelta } from './delta.ts';
import { lookup, lookupOptional, joinTestPath } from './tables.ts';

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
    /**
     * `null` when the message has no text at all — an empty log line. Rare
     * (124 mochitest, 1 xpcshell over the sweep) but real, so anything
     * grouping by text has to cope with it.
     */
    textIds: (TableIndex | null)[];
    /** `null` when the message carries no source file. */
    fileIds: (TableIndex | null)[];
    /**
     * `null` when the message carries no line number. Not the same set as a
     * null `fileIds`: a message can have a line and no file. See `FORMATS.md`.
     */
    lines: (number | null)[];
    /** `null` when the message has no Bugzilla component. */
    componentIds: (TableIndex | null)[];
}

/**
 * `taskInfo` here is the shared shape minus `chunks`, which the errors files
 * never carry — `TaskInfo.chunks` is optional, so the shared type describes
 * this correctly and there is no reason for a parallel declaration.
 */
export type ErrorsTaskInfo = TaskInfo;

/** Identical to the shared `testInfo`, nullable `componentIds` included. */
export type ErrorsTestInfo = TestInfo;

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

// --- decoding ------------------------------------------------------------

/**
 * One distinct (kind, text, file, line) message, resolved against the tables.
 *
 * Every field that the format allows to be null is null here rather than being
 * given a placeholder, because the placeholders are what make two different
 * problems look like one. `FORMATS.md` measures all four: 47,733 mochitest
 * messages with no file, 35,021 with no line — **and they are not the same
 * set**, 22 xpcshell messages having a line and no file — plus 5,207 with no
 * component and 124 with no text at all.
 */
export interface DecodedMessage {
    /** Index into `messages`, so a caller can get back to the raw arrays. */
    messageId: number;
    /** The marker kind, e.g. `C++ warning`. Always present. */
    kind: string;
    /** `null` when the message recorded no text — rare but real. */
    text: string | null;
    /** `null` when the message recorded no source file. */
    file: string | null;
    /** `null` when the message recorded no line. Independent of `file`. */
    line: number | null;
    /** `null` when the message has no Bugzilla component. */
    component: string | null;
}

/** A (test, message) marker group, with its per-task occurrences resolved. */
export interface DecodedMarkerGroup {
    /** Index into `markers`' parallel arrays. */
    groupId: number;
    testId: number;
    messageId: number;
    /** Occurrences of this message in this test, summed over every task. */
    totalCount: number;
    /** How many distinct tasks saw it. */
    taskCount: number;
}

/**
 * A decoded view of one errors file.
 *
 * Deliberately **not** an array of occurrences. A weekday mochitest file holds
 * 103M markers (`PLAN.md` §4), so the only viable shape is the one the file
 * already has: integer-indexed parallel arrays walked once. Everything here
 * either resolves a single index on demand or walks the groups without
 * allocating per occurrence.
 */
export interface DecodedErrorsFile {
    /** The single date this file covers. There is no day axis. */
    date: string;
    generatedAt: string;
    jobCount: number;
    processedJobCount: number;
    invalidJobCount: number;
    /**
     * Per-kind totals over the whole file, straight from
     * `metadata.markerCounts`. The cheap answer to "how noisy is this harness
     * today, and in which category".
     */
    markerCounts: Record<string, number>;
    /**
     * The marker kinds present, from `tables.markerNames`.
     *
     * **Read, never hardcoded.** A TSan build adds `TSan Error` on mochitest
     * only (`FORMATS.md`), so a fixed list is wrong on some files and will be
     * wrong again the next time the generator adds a kind.
     */
    markerNames: readonly string[];
    /** How many distinct (test, message) groups the file holds. */
    groupCount: number;
    /** How many distinct messages the file holds. */
    messageCount: number;
    /** How many tests appear at all. */
    testCount: number;
    /** Resolves one message's tables. */
    messageAt(messageId: number): DecodedMessage;
    /** A test's full path. */
    testPathAt(testId: number): string;
    /** A test's Bugzilla component, or `null`. */
    testComponentAt(testId: number): string | null;
    /** Walks every (test, message) group with its totals. */
    groups(): Generator<DecodedMarkerGroup>;
    /**
     * The `"<taskId>.<retryId>"` strings behind one group.
     *
     * Materialized only when asked for — `--task-ids` — because the delta
     * decoding allocates and the ranking path has no use for it.
     */
    taskIdsOfGroup(groupId: number): string[];
    /** The job name of a task index, for per-config views. */
    jobNameOfTaskIndex(taskIdIndex: number): string;
}

/**
 * Wraps a parsed errors file.
 *
 * The `taskIdIds` delta decoding is the one piece of real decoding here, and
 * `forEachDelta` does it without allocating: a group's task IDs are only ever
 * needed as a *count* on the ranking path, and the count is the array length.
 */
export function decodeErrors(file: ErrorsFile): DecodedErrorsFile {
    const { tables, messages, markers, testInfo, taskInfo, metadata } = file;

    const groupCount = markers.testIds.length;
    if (
        markers.messageIds.length !== groupCount ||
        markers.taskIdIds.length !== groupCount ||
        markers.counts.length !== groupCount
    ) {
        // A length mismatch means the parallel arrays no longer describe the
        // same groups, and every number derived from them would be silently
        // misattributed. `PLAN.md` §4: throw rather than emit a plausible
        // wrong number.
        throw new Error(
            'markers arrays are not parallel: ' +
                `testIds ${groupCount}, messageIds ${markers.messageIds.length}, ` +
                `taskIdIds ${markers.taskIdIds.length}, counts ${markers.counts.length}`
        );
    }

    return {
        date: metadata.date,
        generatedAt: metadata.generatedAt,
        jobCount: metadata.jobCount,
        processedJobCount: metadata.processedJobCount,
        invalidJobCount: metadata.invalidJobCount,
        markerCounts: metadata.markerCounts,
        markerNames: tables.markerNames,
        groupCount,
        messageCount: messages.markerNameIds.length,
        testCount: testInfo.testPathIds.length,

        messageAt(messageId: number): DecodedMessage {
            const kindId = messages.markerNameIds[messageId];
            if (kindId === undefined) {
                throw new Error(
                    `index ${messageId} out of range for messages (length ${messages.markerNameIds.length})`
                );
            }
            return {
                messageId,
                kind: lookup(tables.markerNames, kindId, 'tables.markerNames'),
                text: lookupOptional(
                    tables.messageTexts,
                    messages.textIds[messageId],
                    'tables.messageTexts'
                ),
                file: lookupOptional(tables.files, messages.fileIds[messageId], 'tables.files'),
                line: messages.lines[messageId] ?? null,
                component: lookupOptional(
                    tables.components,
                    messages.componentIds[messageId],
                    'tables.components'
                ),
            };
        },

        testPathAt(testId: number): string {
            const pathId = testInfo.testPathIds[testId];
            const nameId = testInfo.testNameIds[testId];
            if (pathId === undefined || nameId === undefined) {
                throw new Error(
                    `index ${testId} out of range for testInfo (length ${testInfo.testPathIds.length})`
                );
            }
            return joinTestPath(
                lookup(tables.testPaths, pathId, 'tables.testPaths'),
                lookup(tables.testNames, nameId, 'tables.testNames')
            );
        },

        testComponentAt(testId: number): string | null {
            return lookupOptional(
                tables.components,
                testInfo.componentIds?.[testId],
                'tables.components'
            );
        },

        *groups(): Generator<DecodedMarkerGroup> {
            for (let groupId = 0; groupId < groupCount; groupId++) {
                const counts = markers.counts[groupId]!;
                let totalCount = 0;
                for (let i = 0; i < counts.length; i++) {
                    totalCount += counts[i]!;
                }
                yield {
                    groupId,
                    testId: markers.testIds[groupId]!,
                    messageId: markers.messageIds[groupId]!,
                    totalCount,
                    // The task IDs are delta-encoded but their *count* is just
                    // the array length, so the ranking path never decodes them.
                    taskCount: markers.taskIdIds[groupId]!.length,
                };
            }
        },

        taskIdsOfGroup(groupId: number): string[] {
            const deltas = markers.taskIdIds[groupId];
            if (deltas === undefined) {
                throw new Error(
                    `index ${groupId} out of range for markers (length ${groupCount})`
                );
            }
            const out: string[] = [];
            // Delta-encoded per group, from a base of 0 — see `delta.ts`.
            forEachDelta(deltas, 0, (taskIdIndex) => {
                out.push(lookup(tables.taskIds, taskIdIndex, 'tables.taskIds'));
            });
            return out;
        },

        jobNameOfTaskIndex(taskIdIndex: number): string {
            const jobNameId = taskInfo.jobNameIds[taskIdIndex];
            if (jobNameId === undefined) {
                throw new Error(
                    `index ${taskIdIndex} out of range for taskInfo.jobNameIds ` +
                        `(length ${taskInfo.jobNameIds.length})`
                );
            }
            return lookup(tables.jobNames, jobNameId, 'tables.jobNames');
        },
    };
}
