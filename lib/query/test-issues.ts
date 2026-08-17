/**
 * One test's issues — everything that went wrong, not just what left a message.
 *
 * `test.html`'s Issue Details list, hoisted out of `site/test-view.ts` so
 * `fx-tests test` renders the same rows. A status carrying no message needs a
 * synthesised label or it gets no row at all, which is how a test's timeouts
 * stayed invisible beside its far rarer failures.
 *
 * The assembly order (skips, failures, crashes, timeouts) is load-bearing: the
 * sort is on count alone and is stable, so that order decides ties.
 */

import { type DecodedTimingFile, type RunEntry } from '../formats/decode.ts';
import { displaySkipMessage, skipReason } from '../model/skips.ts';
import { classifyStatus } from '../model/status.ts';
import {
    type TestStats,
    type TestStatsOptions,
    inDayRange,
    jobNameOfEntry,
} from './test-stats.ts';

/** The placeholder for a failure that recorded no message. */
export const FAILURE_NO_MESSAGE =
    'Failure details not recorded (likely Android or platform logging issue)';

/** The placeholder for a crash with no symbolized signature. */
export const CRASH_NO_SIGNATURE = 'Crash signature not recorded';

/** The one line every TIMEOUT issue shows; timeouts record no message. */
export const TIMEOUT_MESSAGE = 'Test exceeded time limit';

export type IssueType = 'SKIP' | 'FAIL' | 'CRASH' | 'TIMEOUT';

/** One row of the issue list, before either front-end decorates it. */
export interface TestIssue {
    count: number;
    type: IssueType;
    /** The message, signature, skip condition, or a synthesised label. */
    message: string;
}

/**
 * Every issue of one test, ordered by count descending.
 *
 * `options` carries the CLI's `--day`/`--since`/`--config` filters; the page
 * passes none.
 */
export function buildTestIssues(
    file: DecodedTimingFile,
    testId: number,
    stats: TestStats,
    options: TestStatsOptions = {}
): TestIssue[] {
    const issues: TestIssue[] = [];

    // Skips, by message, `run-if` excluded and the `skip-if: ` prefix stripped.
    for (const [message, count] of sortedByCountDesc(skipCountsByMessage(file, testId, options))) {
        issues.push({ count, type: 'SKIP', message });
    }

    // Failures, by message.
    let namedFailures = 0;
    for (const [message, count] of sortedByCountDesc(
        failureCountsByMessage(file, testId, options)
    )) {
        issues.push({ count, type: 'FAIL', message });
        namedFailures += count;
    }
    if (stats.failCount > namedFailures) {
        issues.push({
            count: stats.failCount - namedFailures,
            type: 'FAIL',
            message: FAILURE_NO_MESSAGE,
        });
    }

    // Crashes, by signature.
    let namedCrashes = 0;
    for (const [signature, count] of sortedByCountDesc(
        crashCountsBySignature(file, testId, options)
    )) {
        issues.push({ count, type: 'CRASH', message: signature });
        namedCrashes += count;
    }
    if (stats.crashCount > namedCrashes) {
        issues.push({
            count: stats.crashCount - namedCrashes,
            type: 'CRASH',
            message: CRASH_NO_SIGNATURE,
        });
    }

    // One row, not one per message: `TIMEOUT*` groups carry no `messageIds`.
    if (stats.timeoutCount > 0) {
        issues.push({ count: stats.timeoutCount, type: 'TIMEOUT', message: TIMEOUT_MESSAGE });
    }

    // Count alone; the assembly order above decides ties. See the module comment.
    issues.sort((a, b) => b.count - a.count);
    return issues;
}

/** `[message, count]` pairs, highest count first. */
function sortedByCountDesc(counts: Map<string, number>): [string, number][] {
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Whether an entry is inside the requested window and configuration set. */
function included(
    file: DecodedTimingFile,
    entry: RunEntry,
    options: TestStatsOptions
): boolean {
    if (!inDayRange(entry.day, options.dayRange)) {
        return false;
    }
    if (options.jobFilter === undefined) {
        return true;
    }
    const jobName = jobNameOfEntry(file, entry);
    return jobName === null ? false : options.jobFilter(jobName);
}

/**
 * Skip counts by display message, `run-if` and message-less skips excluded.
 *
 * `computeTestStats` counts a message-less skip and this does not, so the SKIP
 * rows can total less than the summary bar's skip figure.
 */
function skipCountsByMessage(
    file: DecodedTimingFile,
    testId: number,
    options: TestStatsOptions
): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of file.runsOfTest(testId)) {
        if (classifyStatus(entry.status).kind !== 'skip') {
            continue;
        }
        if (!included(file, entry, options)) {
            continue;
        }
        // `undefined`/`null` are both "no message"; upstream skips those.
        if (entry.message === undefined || entry.message === null) {
            continue;
        }
        if (skipReason(entry.message) === 'run-if') {
            continue;
        }
        const message = displaySkipMessage(entry.message);
        counts.set(message, (counts.get(message) ?? 0) + entry.count);
    }
    return counts;
}

/** Failure counts by message; the message-less ones are the synthetic row's. */
function failureCountsByMessage(
    file: DecodedTimingFile,
    testId: number,
    options: TestStatsOptions
): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of file.runsOfTest(testId)) {
        if (classifyStatus(entry.status).kind !== 'fail') {
            continue;
        }
        if (!included(file, entry, options)) {
            continue;
        }
        if (entry.message === undefined || entry.message === null) {
            continue;
        }
        counts.set(entry.message, (counts.get(entry.message) ?? 0) + entry.count);
    }
    return counts;
}

/** Crash counts by signature. */
function crashCountsBySignature(
    file: DecodedTimingFile,
    testId: number,
    options: TestStatsOptions
): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of file.runsOfTest(testId)) {
        if (classifyStatus(entry.status).kind !== 'crash') {
            continue;
        }
        if (!included(file, entry, options)) {
            continue;
        }
        if (entry.crashSignature === undefined || entry.crashSignature === null) {
            continue;
        }
        counts.set(entry.crashSignature, (counts.get(entry.crashSignature) ?? 0) + entry.count);
    }
    return counts;
}
