/**
 * The subtest results of web-platform-tests: `wpt-{date}-subtests.json`, its
 * per-revision twin and the `wpt-subtests-XX.json` buckets. Nearly every subtest
 * only passes, so a subtest keeps counts rather than results. See FORMATS.md.
 */

import type { DailyMetadata, DateString, TableIndex, TaskInfo, TestInfo } from './common.ts';
import { joinTestPath, lookup, lookupOptional } from './tables.ts';

export interface SubtestsTables {
    jobNames: string[];
    testPaths: string[];
    testNames: string[];
    repositories: string[];
    /** Only the tasks of the unexpected results. */
    taskIds: string[];
    components: string[];
    commitIds: string[];
    subtestNames: string[];
    /** `KNOWN-FAIL`, `KNOWN-INTERMITTENT-TIMEOUT`, `FAIL`… Never `PASS`. */
    statuses: string[];
    messages: string[];
}

/** One row per subtest and status the metadata expects, in subtest order. */
export interface SubtestExpectedFailures {
    subtestIds: number[];
    statusIds: TableIndex[];
    /** The jobs that had the failure, and `counts` how many times each. */
    jobNameIds: TableIndex[][];
    counts: number[][];
}

/** One row per subtest and status the metadata does not expect, in subtest order. */
export interface SubtestUnexpected {
    subtestIds: number[];
    statusIds: TableIndex[];
    /** One entry per result. Not delta-encoded. */
    taskIdIds: TableIndex[][];
    /** `null` for a result with no message, eg. a `NOTRUN`. */
    messageIds: (TableIndex | null)[][];
    /** Days since `metadata.startDate`, one per result. Bucket files only. */
    days?: number[][];
}

export interface SubtestsData {
    /** Subtests per test: a test's subtests are consecutive, in test order. */
    countsByTest: number[];
    nameIds: TableIndex[];
    passCounts: number[];
    expectedFailures: SubtestExpectedFailures;
    unexpected: SubtestUnexpected;
}

interface SubtestsCounts {
    subtestCount: number;
    /** Results per status, `PASS` included. */
    resultCounts: Record<string, number>;
}

export type SubtestsDailyMetadata = DailyMetadata & SubtestsCounts;

export type SubtestsRevisionMetadata = Omit<DailyMetadata, 'date'> &
    SubtestsCounts & { project: string; revision: string; pushId: number };

export interface SubtestsBucketMetadata {
    startDate: DateString;
    endDate: DateString;
    days: number;
    startTime: number;
    generatedAt: string;
    totalTestCount: number;
    subtestCount: number;
    totalBuckets: number;
    bucketIndex: number;
    /** Filenames, newest first: `wpt-2026-11-22-subtests.json`. */
    aggregatedFrom: string[];
}

export interface SubtestsFile {
    metadata: SubtestsDailyMetadata | SubtestsRevisionMetadata | SubtestsBucketMetadata;
    tables: SubtestsTables;
    taskInfo: TaskInfo;
    testInfo: TestInfo;
    subtests: SubtestsData;
}

// --- decoding ------------------------------------------------------------

export interface SubtestExpectedFailure {
    status: string;
    count: number;
    jobs: { jobName: string; count: number }[];
}

export interface SubtestUnexpectedResult {
    /** `"<taskId>.<retryId>"`. */
    taskId: string;
    jobName: string;
    /** `null` in a daily file (the chunk is in `jobName`) and for an unchunked job. */
    chunk: number | null;
    repository: string;
    commitId: string | null;
    message: string | null;
    /** Days since the file's first day; `null` in a file that covers one day. */
    day: number | null;
}

export interface SubtestUnexpectedGroup {
    status: string;
    results: SubtestUnexpectedResult[];
}

export interface DecodedSubtest {
    name: string;
    passCount: number;
    expectedFailures: SubtestExpectedFailure[];
    unexpected: SubtestUnexpectedGroup[];
}

/** A subtests file, decoded one test at a time, when asked. */
export interface DecodedSubtestsFile {
    testCount: number;
    subtestCount: number;
    /** Only the tests with subtests, in the file's order. */
    testPaths(): string[];
    /** In name order. `null` for a test the file does not have, eg. a reftest. */
    subtestsOfTest(testPath: string): DecodedSubtest[] | null;
}

/** Throws when the file's parallel arrays disagree on their length. */
export function decodeSubtests(file: SubtestsFile): DecodedSubtestsFile {
    const { tables, taskInfo, testInfo, subtests } = file;
    const { expectedFailures, unexpected } = subtests;
    const testCount = testInfo.testPathIds.length;
    const subtestCount = subtests.nameIds.length;

    const lengths: [string, number, number][] = [
        ['subtests.countsByTest', subtests.countsByTest.length, testCount],
        ['subtests.passCounts', subtests.passCounts.length, subtestCount],
        ['expectedFailures.statusIds', expectedFailures.statusIds.length, expectedFailures.subtestIds.length],
        ['expectedFailures.jobNameIds', expectedFailures.jobNameIds.length, expectedFailures.subtestIds.length],
        ['expectedFailures.counts', expectedFailures.counts.length, expectedFailures.subtestIds.length],
        ['unexpected.statusIds', unexpected.statusIds.length, unexpected.subtestIds.length],
        ['unexpected.taskIdIds', unexpected.taskIdIds.length, unexpected.subtestIds.length],
        ['unexpected.messageIds', unexpected.messageIds.length, unexpected.subtestIds.length],
    ];
    if (unexpected.days !== undefined) {
        lengths.push(['unexpected.days', unexpected.days.length, unexpected.subtestIds.length]);
    }
    for (const [name, actual, expected] of lengths) {
        if (actual !== expected) {
            throw new Error(`${name} has ${actual} entries where ${expected} are expected`);
        }
    }

    const firstSubtest = new Array<number>(testCount);
    let next = 0;
    for (let testId = 0; testId < testCount; testId++) {
        firstSubtest[testId] = next;
        next += subtests.countsByTest[testId]!;
    }
    if (next !== subtestCount) {
        throw new Error(
            `subtests.countsByTest sums to ${next} where the file has ${subtestCount} subtests`
        );
    }

    const pathOfTest = (testId: number): string =>
        joinTestPath(
            lookup(tables.testPaths, testInfo.testPathIds[testId]!, 'tables.testPaths'),
            lookup(tables.testNames, testInfo.testNameIds[testId]!, 'tables.testNames')
        );

    let testIds: Map<string, number> | undefined;
    const testIdOf = (testPath: string): number | undefined => {
        if (testIds === undefined) {
            testIds = new Map();
            for (let testId = 0; testId < testCount; testId++) {
                testIds.set(pathOfTest(testId), testId);
            }
        }
        return testIds.get(testPath);
    };

    // Rows are sorted by subtest: a test's rows are one range, found by bisection.
    const rowsOf = (subtestIds: readonly number[], from: number, to: number): [number, number] => {
        const lowerBound = (target: number): number => {
            let low = 0;
            let high = subtestIds.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (subtestIds[middle]! < target) {
                    low = middle + 1;
                } else {
                    high = middle;
                }
            }
            return low;
        };
        return [lowerBound(from), lowerBound(to)];
    };

    const resultOf = (row: number, index: number): SubtestUnexpectedResult => {
        const taskIdId = unexpected.taskIdIds[row]![index]!;
        const jobNameId = taskInfo.jobNameIds[taskIdId];
        const repositoryId = taskInfo.repositoryIds[taskIdId];
        if (jobNameId === undefined || repositoryId === undefined) {
            throw new Error(`taskInfo has no entry for task index ${taskIdId}`);
        }
        return {
            taskId: lookup(tables.taskIds, taskIdId, 'tables.taskIds'),
            jobName: lookup(tables.jobNames, jobNameId, 'tables.jobNames'),
            chunk: taskInfo.chunks?.[taskIdId] ?? null,
            repository: lookup(tables.repositories, repositoryId, 'tables.repositories'),
            commitId: lookupOptional(tables.commitIds, taskInfo.commitIds[taskIdId], 'tables.commitIds'),
            message: lookupOptional(tables.messages, unexpected.messageIds[row]![index], 'tables.messages'),
            day: unexpected.days?.[row]?.[index] ?? null,
        };
    };

    return {
        testCount,
        subtestCount,
        testPaths(): string[] {
            return Array.from({ length: testCount }, (_, testId) => pathOfTest(testId));
        },
        subtestsOfTest(testPath: string): DecodedSubtest[] | null {
            const testId = testIdOf(testPath);
            if (testId === undefined) {
                return null;
            }
            const first = firstSubtest[testId]!;
            const end = first + subtests.countsByTest[testId]!;
            const decoded: DecodedSubtest[] = [];
            for (let subtestId = first; subtestId < end; subtestId++) {
                decoded.push({
                    name: lookup(tables.subtestNames, subtests.nameIds[subtestId]!, 'tables.subtestNames'),
                    passCount: subtests.passCounts[subtestId]!,
                    expectedFailures: [],
                    unexpected: [],
                });
            }

            const [expectedFrom, expectedTo] = rowsOf(expectedFailures.subtestIds, first, end);
            for (let row = expectedFrom; row < expectedTo; row++) {
                const jobNameIds = expectedFailures.jobNameIds[row]!;
                const counts = expectedFailures.counts[row]!;
                if (jobNameIds.length !== counts.length) {
                    throw new Error(
                        `expectedFailures row ${row} has ${jobNameIds.length} jobs and ${counts.length} counts`
                    );
                }
                const jobs = jobNameIds.map((jobNameId, index) => ({
                    jobName: lookup(tables.jobNames, jobNameId, 'tables.jobNames'),
                    count: counts[index]!,
                }));
                decoded[expectedFailures.subtestIds[row]! - first]!.expectedFailures.push({
                    status: lookup(tables.statuses, expectedFailures.statusIds[row]!, 'tables.statuses'),
                    count: jobs.reduce((sum, job) => sum + job.count, 0),
                    jobs,
                });
            }

            const [unexpectedFrom, unexpectedTo] = rowsOf(unexpected.subtestIds, first, end);
            for (let row = unexpectedFrom; row < unexpectedTo; row++) {
                const taskIdIds = unexpected.taskIdIds[row]!;
                if (taskIdIds.length !== unexpected.messageIds[row]!.length) {
                    throw new Error(
                        `unexpected row ${row} has ${taskIdIds.length} tasks and ` +
                            `${unexpected.messageIds[row]!.length} messages`
                    );
                }
                decoded[unexpected.subtestIds[row]! - first]!.unexpected.push({
                    status: lookup(tables.statuses, unexpected.statusIds[row]!, 'tables.statuses'),
                    results: taskIdIds.map((_, index) => resultOf(row, index)),
                });
            }
            return decoded;
        },
    };
}

// --- reading a status ----------------------------------------------------

/** `KNOWN-FAIL` is expected; `KNOWN-INTERMITTENT-FAIL` and `FAIL` are not. */
export function isExpectedSubtestStatus(status: string): boolean {
    return status.startsWith('KNOWN-') && !status.startsWith('KNOWN-INTERMITTENT-');
}

export function isKnownIntermittentSubtestStatus(status: string): boolean {
    return status.startsWith('KNOWN-INTERMITTENT-');
}

/** "0a" -> "wpt-subtests-0a.json" */
export function subtestsBucketFileName(bucketSuffix: string): string {
    return `wpt-subtests-${bucketSuffix}.json`;
}
