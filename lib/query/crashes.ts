/**
 * Crashing runs grouped by signature, across every test in a file.
 *
 * Behind `fx-tests crashes`. Structurally the twin of `failures.ts` — group,
 * count occurrences, count distinct tests — with two differences that come
 * from what a `CRASH` group actually carries.
 *
 * **The key is the signature, not the message.** `FORMATS.md`: `CRASH` groups
 * carry `crashSignatureIds` and *no* `messageIds`. Grouping crashes by message
 * would put every one of them in a single `(no message)` bucket.
 *
 * **The signature can be null, and that is data.** 58 mochitest entries in the
 * sweep had a null signature — a crash whose minidump was not symbolized. They
 * are kept as a `null` key rather than dropped, because a crash that could not
 * be symbolized is still a crash and dropping it understates the count.
 *
 * ## Minidumps are what makes this actionable
 *
 * A signature says what crashed; the minidump ID is what `fx-tests crash` reads
 * to say *where*. The same 58 entries with null signatures also have null
 * minidumps — the dump was never uploaded — so a group can legitimately have
 * occurrences and nothing to fetch. `minidumps` holds only the non-null ones,
 * and an empty array with a non-zero count is the "nothing to fetch" case
 * rather than a bug.
 */

import type { DecodedTimingFile } from '../formats/decode.ts';
import { parseTaskId } from '../formats/tables.ts';
import { classifyStatus } from '../model/status.ts';
import { inDayRange } from './test-stats.ts';
import { jobNameOfEntry } from './test-stats.ts';

/** A minidump, with the task run it can be fetched from. */
export interface MinidumpRef {
    /** The bare task ID. */
    taskId: string;
    /** The job-level retry — the `runs/<n>` in the artifact URL. */
    retryId: number;
    /** The dump's ID; `lib/links.ts` turns it into a URL. */
    minidumpId: string;
}

/** One crash signature, aggregated over every test that produced it. */
export interface CrashGroup {
    /** The signature, or `null` when the crash was not symbolized. */
    signature: string | null;
    /** Total crashing runs with this signature. */
    count: number;
    /** How many distinct tests crashed this way. */
    testCount: number;
    /** The tests, most occurrences first. Capped. */
    tests: { testId: number; fullPath: string; count: number }[];
    /** Configurations it was seen on, where the file attributes them. */
    jobNames: Set<string>;
    /**
     * Dumps that can actually be fetched. May be empty for a group with a
     * non-zero count — see the module comment.
     */
    minidumps: MinidumpRef[];
}

/** Options for `groupCrashesBySignature`. */
export interface CrashGroupOptions {
    pathPrefix?: string | undefined;
    component?: string | undefined;
    /** Only signatures containing this substring, case-insensitively. */
    signature?: string | undefined;
    dayRange?: { from: number; to: number } | undefined;
    jobFilter?: ((jobName: string) => boolean) | undefined;
    maxTestsPerGroup?: number | undefined;
    maxMinidumps?: number | undefined;
}

const DEFAULT_MAX_TESTS = 50;
const DEFAULT_MAX_MINIDUMPS = 20;

/**
 * Groups every crashing run in the file by its signature.
 *
 * The minidump-to-task pairing relies on `minidumps` being **parallel to
 * `taskIds`** within an entry, which is how the format stores it: one dump per
 * task ID in the same bucket, in the same order. Zipping them by index is
 * therefore the join, and a length mismatch means the group was misaligned —
 * `status-entries.ts` throws on that before it reaches here.
 */
export function groupCrashesBySignature(
    file: DecodedTimingFile,
    options: CrashGroupOptions = {}
): CrashGroup[] {
    const maxTests = options.maxTestsPerGroup ?? DEFAULT_MAX_TESTS;
    const maxMinidumps = options.maxMinidumps ?? DEFAULT_MAX_MINIDUMPS;
    const needle = options.signature?.toLowerCase();

    const groups = new Map<string | null, CrashGroup>();
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
            if (classifyStatus(entry.status).kind !== 'crash') {
                continue;
            }
            const signature = entry.crashSignature ?? null;
            if (needle !== undefined && !(signature ?? '').toLowerCase().includes(needle)) {
                continue;
            }
            let jobName: string | null = null;
            if (options.jobFilter !== undefined) {
                jobName = jobNameOfEntry(file, entry);
                if (jobName === null || !options.jobFilter(jobName)) {
                    continue;
                }
            }

            let group = groups.get(signature);
            if (group === undefined) {
                group = {
                    signature,
                    count: 0,
                    testCount: 0,
                    tests: [],
                    jobNames: new Set(),
                    minidumps: [],
                };
                groups.set(signature, group);
                perTest.set(signature, new Map());
            }
            group.count += entry.count;

            const counts = perTest.get(signature)!;
            counts.set(testId, (counts.get(testId) ?? 0) + entry.count);

            const resolved = jobName ?? jobNameOfEntry(file, entry);
            if (resolved !== null) {
                group.jobNames.add(resolved);
            }

            // `minidumps[i]` belongs to `taskIds[i]`: same bucket, same order.
            if (entry.minidumps !== undefined && entry.taskIds !== undefined) {
                for (let i = 0; i < entry.minidumps.length; i++) {
                    if (group.minidumps.length >= maxMinidumps) {
                        break;
                    }
                    const minidumpId = entry.minidumps[i];
                    const rawTaskId = entry.taskIds[i];
                    // A null dump was never uploaded; there is nothing to
                    // fetch, so it contributes to `count` and not here.
                    if (!minidumpId || rawTaskId === undefined) {
                        continue;
                    }
                    const { taskId, retryId } = parseTaskId(rawTaskId);
                    group.minidumps.push({ taskId, retryId, minidumpId });
                }
            }
        }
    }

    for (const [signature, group] of groups) {
        const counts = perTest.get(signature)!;
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
