/**
 * Failing runs grouped by message, across every test in a file.
 *
 * Behind `fx-tests failures` and `CLI.md`'s `fx-tests issues --group-by
 * message` — the "one bug, many tests" view. A single harness change or infra
 * fault shows up as the same message across dozens of tests, and grouping by
 * message turns thirty lines into one.
 *
 * ## The test-spread count is the discriminator
 *
 * Occurrences alone rank the loudest message, which is usually one test failing
 * a lot. The number that separates "a broken test" from "something wrong with
 * the tree" is **how many distinct tests** produced the message. Both are
 * reported, and `CLI.md` sorts on either.
 *
 * ## Messages a status does not record
 *
 * `FORMATS.md`: `TIMEOUT*`, `CRASH` and `EXPECTED-FAIL` groups carry no
 * `messageIds` array at all, while `FAIL*` always does. So a timeout has no
 * message to group by — not a null one, none — and folding timeouts in here
 * would produce a large `(no message)` bucket that reads as a real shared
 * failure mode. Timeouts are counted separately, per test, and crashes belong
 * to `crashes.ts` where the signature is the grouping key.
 */

import type { DecodedTimingFile } from '../formats/decode.ts';
import { classifyStatus } from '../model/status.ts';
import { inDayRange } from './test-stats.ts';
import { jobNameOfEntry } from './test-stats.ts';

/** One failure message, aggregated over every test that produced it. */
export interface FailureGroup {
    /** The message, or `null` for failures that recorded none. */
    message: string | null;
    /** Total failing runs with this message. */
    count: number;
    /** How many distinct tests produced it — the ambient-vs-specific signal. */
    testCount: number;
    /** The tests, most occurrences first. Capped by `maxTestsPerGroup`. */
    tests: { testId: number; fullPath: string; count: number }[];
    /** Configurations it was seen on, where the file attributes them. */
    jobNames: Set<string>;
    /** Task IDs behind it, for `--task-ids`. Capped by `maxTaskIds`. */
    taskIds: string[];
}

/** Options for `groupFailuresByMessage`. */
export interface FailureGroupOptions {
    pathPrefix?: string | undefined;
    component?: string | undefined;
    /** Only messages containing this substring, case-insensitively. */
    message?: string | undefined;
    dayRange?: { from: number; to: number } | undefined;
    jobFilter?: ((jobName: string) => boolean) | undefined;
    /**
     * How many per-test rows to keep per group. A message in 9,367 tests does
     * not need 9,367 rows carried through to a formatter that will print
     * five — and keeping them all is how a tree-wide query gets expensive.
     */
    maxTestsPerGroup?: number | undefined;
    /** How many task IDs to keep per group. Same reasoning. */
    maxTaskIds?: number | undefined;
}

const DEFAULT_MAX_TESTS = 50;
const DEFAULT_MAX_TASK_IDS = 20;

/**
 * Groups every failing run in the file by its message.
 *
 * One pass over every test. `testCount` is exact even when `tests` is capped:
 * the cap drops rows, not the count, so "in 9,367 tests" stays true while only
 * 50 of them are listed.
 */
export function groupFailuresByMessage(
    file: DecodedTimingFile,
    options: FailureGroupOptions = {}
): FailureGroup[] {
    const maxTests = options.maxTestsPerGroup ?? DEFAULT_MAX_TESTS;
    const maxTaskIds = options.maxTaskIds ?? DEFAULT_MAX_TASK_IDS;
    const needle = options.message?.toLowerCase();

    /** message -> group, with per-test counts kept aside until the end. */
    const groups = new Map<string | null, FailureGroup>();
    const perTest = new Map<string | null, Map<number, number>>();

    for (let testId = 0; testId < file.testCount; testId++) {
        const identity = file.testAt(testId);
        if (options.pathPrefix !== undefined && !identity.fullPath.startsWith(options.pathPrefix)) {
            continue;
        }
        if (options.component !== undefined) {
            const component = identity.component;
            if (
                component === null ||
                !component.toLowerCase().includes(options.component.toLowerCase())
            ) {
                continue;
            }
        }

        for (const entry of file.runsOfTest(testId)) {
            if (!inDayRange(entry.day, options.dayRange)) {
                continue;
            }
            if (classifyStatus(entry.status).kind !== 'fail') {
                continue;
            }
            const message = entry.message ?? null;
            if (needle !== undefined && !(message ?? '').toLowerCase().includes(needle)) {
                continue;
            }
            let jobName: string | null = null;
            if (options.jobFilter !== undefined) {
                jobName = jobNameOfEntry(file, entry);
                if (jobName === null || !options.jobFilter(jobName)) {
                    continue;
                }
            }

            let group = groups.get(message);
            if (group === undefined) {
                group = {
                    message,
                    count: 0,
                    testCount: 0,
                    tests: [],
                    jobNames: new Set(),
                    taskIds: [],
                };
                groups.set(message, group);
                perTest.set(message, new Map());
            }
            group.count += entry.count;

            const counts = perTest.get(message)!;
            counts.set(testId, (counts.get(testId) ?? 0) + entry.count);

            const resolved = jobName ?? jobNameOfEntry(file, entry);
            if (resolved !== null) {
                group.jobNames.add(resolved);
            }
            if (entry.taskIds !== undefined && group.taskIds.length < maxTaskIds) {
                for (const taskId of entry.taskIds) {
                    if (group.taskIds.length >= maxTaskIds) {
                        break;
                    }
                    group.taskIds.push(taskId);
                }
            }
        }
    }

    for (const [message, group] of groups) {
        const counts = perTest.get(message)!;
        group.testCount = counts.size;
        group.tests = [...counts]
            .sort((a, b) => b[1] - a[1])
            .slice(0, maxTests)
            .map(([testId, count]) => ({
                testId,
                fullPath: file.testAt(testId).fullPath,
                count,
            }));
    }

    return [...groups.values()].sort((a, b) => b.count - a.count);
}
