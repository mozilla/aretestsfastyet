/**
 * One iterator over all five status-group shapes.
 *
 * `status-group.ts` declares what the five shapes *are*; this file is the
 * abstraction that lets everything above `lib/formats/` stop caring which one
 * it is holding. It is `getCountAtIndex()` (`common-test-data.js:37`)
 * generalized: instead of a count that the caller then has to attribute by
 * reaching back into the raw group and branching on shape a second time, an
 * entry carries everything the group recorded about that bucket, with the
 * shape differences already resolved.
 *
 * Two rules govern the implementation, and both are measured facts rather than
 * design preferences:
 *
 * **The shape decides how to count; the status decides what is there.** Which
 * optional arrays a group carries is determined by the status string, not by
 * the shape discriminant. Within the `task-ids` shape, `FAIL*` carries
 * `messageIds` while `TIMEOUT*`, `CRASH` and `EXPECTED-FAIL` do not — absent
 * from the group, not null within it — and only `CRASH` carries
 * `crashSignatureIds`/`minidumps`. So the iterator reads whichever arrays are
 * actually present rather than deciding from the shape alone.
 *
 * **An unrecognized shape throws.** `getCountAtIndex()` ends in
 * `else { return 1; }`, which turns a sixth shape into a plausible wrong
 * number rather than an error. `PLAN.md` §4 calls eliminating that out by
 * name, so `statusGroupShape()` throws instead.
 */

import type { StatusGroup } from './status-group.ts';
import { TableIndexError, lookupRequiredTable } from './tables.ts';

/**
 * One decoded entry from a status group, in any of the five shapes.
 *
 * What "an entry" means differs by shape, and the difference is not cosmetic:
 *
 * - Flat (daily): one entry per **run**, so `count` is always 1.
 * - `counts` (issues, and the pass-like groups of issues-with-taskids): one
 *   entry per (day, message, signature) bucket. No attribution at all.
 * - `skip-counts` (bucket files' SKIP): one entry per (day, job, message).
 * - `durations` (bucket files' pass-like): one entry per (day, job) bucket,
 *   `count` is the number of durations, which is the number of runs.
 * - `task-ids`: one entry per (day, message, signature) bucket, `count` is the
 *   number of task IDs in it. A repeated task ID within a bucket means the
 *   same job saw the status more than once — a harness rerun.
 *
 * So `count` is the run count in every shape, and `taskIds`/`durations` are
 * `count` long in the shapes that carry them. Fields absent from the shape are
 * `undefined` rather than a default, so a caller can tell "not recorded" from
 * "recorded as nothing".
 */
export interface StatusEntry {
    /**
     * The absolute day index, 0 = the **oldest** day the file covers, or
     * `null` for the daily files, which cover exactly one day and have no
     * `days` array to be relative to.
     */
    day: number | null;
    /** How many runs this entry accounts for. Counted, never guessed. */
    count: number;
    /** The index of this entry within the group's parallel arrays. */
    index: number;
    /** Job name, when the shape attributes to a job directly. */
    jobName?: string;
    /**
     * Task IDs (`"<taskId>.<retryId>"`), when the shape attributes to tasks.
     * Length equals `count`; the flat shape yields exactly one.
     */
    taskIds?: string[];
    /**
     * Per-run durations in milliseconds, when recorded. The flat shape yields
     * one; the `durations` shape yields `count` of them; the others yield
     * nothing, because they recorded none.
     */
    durations?: number[];
    /**
     * Absolute timestamps, Unix seconds, already delta-decoded from
     * `metadata.startTime`. Daily files only — they are the only family that
     * records when a run happened.
     */
    timestamps?: number[];
    /**
     * The failure or skip message. `undefined` when the group carried no
     * `messageIds` array at all, `null` when it did and this entry's was null.
     *
     * The distinction matters and is the reason this is not simply
     * `string | null`: a `TIMEOUT` group has no `messageIds` field, so
     * `undefined` means "this status never records a message" while `null`
     * means "this run recorded none". A caller filtering skips on their
     * message needs to tell those apart — see `lib/model/skips.ts`.
     */
    message?: string | null;
    /** Crash signature; CRASH groups only, `null` when unsymbolized. */
    crashSignature?: string | null;
    /**
     * Minidump IDs for this entry, CRASH groups only. `null` for a crash whose
     * dump was not uploaded — `FORMATS.md` counts 58 of those, always the same
     * entries as the null signatures.
     */
    minidumps?: (string | null)[];
}

/** Thrown when a status group matches none of the five declared shapes. */
export class UnknownStatusGroupShapeError extends Error {
    // Written out rather than declared as constructor parameter properties:
    // `node --experimental-strip-types` erases types without emitting code, so
    // a parameter property has nowhere to be assigned and is rejected outright.
    readonly status: string;
    readonly keys: string[];

    constructor(status: string, keys: string[]) {
        super(
            `status group for ${status} matches no known shape; ` +
                `keys: ${keys.length > 0 ? keys.join(', ') : '(none)'}`
        );
        this.name = 'UnknownStatusGroupShapeError';
        this.status = status;
        this.keys = keys;
    }
}

/** Which of the five shapes a group is in. */
export type StatusGroupShape = 'flat' | 'counts' | 'skip-counts' | 'durations' | 'task-ids';

/** The tables an entry's strings are resolved against. */
export interface StatusGroupTables {
    jobNames?: readonly string[] | undefined;
    taskIds?: readonly string[] | undefined;
    messages?: readonly string[] | undefined;
    crashSignatures?: readonly string[] | undefined;
}

/** Options for `iterateStatusGroup`. */
export interface IterateOptions {
    /**
     * The daily files' `metadata.startTime`, which their `timestamps` are
     * delta-encoded from. Omitting it yields timestamps relative to the start
     * of the day, which is rarely wanted, so `daily.ts` always passes it.
     */
    startTime?: number | undefined;
}

/** Reads a group's fields without the declared union narrowing every access. */
type RawGroup = Record<string, unknown>;

/**
 * Views a group as a bag of optional fields.
 *
 * The declared union is right for callers, who want a `TaskIdsStatusGroup` to
 * be visibly different from a `CountsStatusGroup`. Inside this file the whole
 * job is to *discover* which one it is by looking at which fields exist, and
 * the union actively gets in the way of that — narrowing before the
 * discriminant has been read is backwards. So this is where the union is
 * dropped, once, rather than at every access.
 */
function fields(group: StatusGroup): RawGroup {
    return group as unknown as RawGroup;
}

/**
 * Identifies which shape a group is in, throwing if it is none of them.
 *
 * The discriminant is the one `getCountAtIndex()` uses — `days` present or
 * not, then which of `counts`/`durations`/`taskIdIds` is there — minus the
 * silent fallback.
 */
export function statusGroupShape(
    group: StatusGroup,
    status = '(unknown status)'
): StatusGroupShape {
    const g = fields(group);
    if (g['days'] === undefined) {
        // The daily files. Every flat group carries all three arrays; a group
        // with no `days` and no flat `taskIdIds` is not a shape we know.
        if (Array.isArray(g['taskIdIds']) && Array.isArray(g['durations'])) {
            return 'flat';
        }
        throw new UnknownStatusGroupShapeError(status, Object.keys(g));
    }
    if (g['counts'] !== undefined) {
        return g['jobNameIds'] !== undefined ? 'skip-counts' : 'counts';
    }
    if (g['durations'] !== undefined) {
        return 'durations';
    }
    if (g['taskIdIds'] !== undefined) {
        return 'task-ids';
    }
    throw new UnknownStatusGroupShapeError(status, Object.keys(g));
}

/**
 * How many entries a group has.
 *
 * Every array in a group is parallel, so any of them gives the answer; which
 * one is present is what the shape determines. `days` is authoritative when it
 * exists — the validator checks that all the others match it.
 */
export function entryCount(group: StatusGroup, shape?: StatusGroupShape): number {
    const g = fields(group);
    const days = g['days'];
    if (Array.isArray(days)) {
        return days.length;
    }
    switch (shape ?? statusGroupShape(group)) {
        case 'flat':
        case 'task-ids':
            return (g['taskIdIds'] as unknown[]).length;
        case 'counts':
        case 'skip-counts':
            return (g['counts'] as unknown[]).length;
        case 'durations':
            return (g['durations'] as unknown[]).length;
    }
}

/**
 * The total number of runs in a status group.
 *
 * This is what `computeTestStats()` (`common-test-data.js:263`) open-codes as
 * a four-branch `if`, with the same silent fallback. Throws on an
 * unrecognized shape.
 */
export function totalRuns(group: StatusGroup, status = '(unknown status)'): number {
    const g = fields(group);
    switch (statusGroupShape(group, status)) {
        case 'flat':
            return (g['taskIdIds'] as unknown[]).length;
        case 'counts':
        case 'skip-counts':
            return (g['counts'] as number[]).reduce((sum, n) => sum + n, 0);
        case 'durations':
            return (g['durations'] as number[][]).reduce((sum, b) => sum + b.length, 0);
        case 'task-ids':
            return (g['taskIdIds'] as number[][]).reduce((sum, b) => sum + b.length, 0);
    }
}

/**
 * Yields one uniform `StatusEntry` per entry of a status group, whatever shape
 * it is in.
 *
 * `status` is passed for more than the error message: see the module comment
 * on why the arrays present depend on it. Throws
 * `UnknownStatusGroupShapeError` on a shape it does not recognize.
 */
export function* iterateStatusGroup(
    group: StatusGroup,
    status: string,
    tables: StatusGroupTables,
    options: IterateOptions = {}
): Generator<StatusEntry> {
    const shape = statusGroupShape(group, status);
    const g = fields(group);

    const rawDays = g['days'] as number[] | undefined;
    const messageIds = g['messageIds'] as (number | null)[] | undefined;
    const crashSignatureIds = g['crashSignatureIds'] as (number | null)[] | undefined;
    const rawMinidumps = g['minidumps'] as (string | null)[] | (string | null)[][] | undefined;
    const jobNameIds = g['jobNameIds'] as number[] | undefined;

    /**
     * Reads the optional per-entry strings, which are keyed off the arrays'
     * presence rather than off the shape.
     */
    const decorate = (entry: StatusEntry, i: number): StatusEntry => {
        if (messageIds !== undefined) {
            const id = messageIds[i];
            entry.message =
                id === null || id === undefined
                    ? null
                    : lookupRequiredTable(tables.messages, id, 'tables.messages');
        }
        if (crashSignatureIds !== undefined) {
            const id = crashSignatureIds[i];
            entry.crashSignature =
                id === null || id === undefined
                    ? null
                    : lookupRequiredTable(
                          tables.crashSignatures,
                          id,
                          'tables.crashSignatures'
                      );
        }
        return entry;
    };

    /** Resolves a job-name index, which only two shapes have. */
    const jobNameAt = (i: number): string => {
        const id = jobNameIds?.[i];
        if (id === undefined) {
            throw new TableIndexError('jobNameIds', i, jobNameIds?.length ?? 0);
        }
        return lookupRequiredTable(tables.jobNames, id, 'tables.jobNames');
    };

    let day = 0;
    // The daily files' timestamps are delta-encoded across the whole group, so
    // the running total lives outside the loop body.
    let timestamp = options.startTime ?? 0;
    const length = entryCount(group, shape);

    for (let i = 0; i < length; i++) {
        if (rawDays !== undefined) {
            day += rawDays[i] ?? 0;
        }
        const dayValue = rawDays !== undefined ? day : null;

        switch (shape) {
            case 'flat': {
                const taskIdIds = g['taskIdIds'] as number[];
                const durations = g['durations'] as number[];
                const timestamps = g['timestamps'] as number[] | undefined;
                const entry: StatusEntry = {
                    day: dayValue,
                    count: 1,
                    index: i,
                    taskIds: [
                        lookupRequiredTable(tables.taskIds, taskIdIds[i]!, 'tables.taskIds'),
                    ],
                    durations: [durations[i] ?? 0],
                };
                if (timestamps !== undefined) {
                    timestamp += timestamps[i] ?? 0;
                    entry.timestamps = [timestamp];
                }
                if (rawMinidumps !== undefined) {
                    // Flat: one minidump ID per entry, not an array of them.
                    const dump = (rawMinidumps as (string | null)[])[i];
                    entry.minidumps = [dump === undefined ? null : dump];
                }
                yield decorate(entry, i);
                break;
            }
            case 'counts': {
                const counts = g['counts'] as number[];
                yield decorate({ day: dayValue, count: counts[i] ?? 0, index: i }, i);
                break;
            }
            case 'skip-counts': {
                const counts = g['counts'] as number[];
                yield decorate(
                    { day: dayValue, count: counts[i] ?? 0, index: i, jobName: jobNameAt(i) },
                    i
                );
                break;
            }
            case 'durations': {
                const bucket = (g['durations'] as number[][])[i] ?? [];
                yield decorate(
                    {
                        day: dayValue,
                        count: bucket.length,
                        index: i,
                        jobName: jobNameAt(i),
                        durations: bucket.slice(),
                    },
                    i
                );
                break;
            }
            case 'task-ids': {
                const bucket = (g['taskIdIds'] as number[][])[i] ?? [];
                const entry: StatusEntry = {
                    day: dayValue,
                    count: bucket.length,
                    index: i,
                    taskIds: bucket.map((id) =>
                        lookupRequiredTable(tables.taskIds, id, 'tables.taskIds')
                    ),
                };
                if (rawMinidumps !== undefined) {
                    const nested = (rawMinidumps as (string | null)[][])[i];
                    entry.minidumps = nested === undefined ? [] : nested.slice();
                }
                yield decorate(entry, i);
                break;
            }
        }
    }
}

/** A test's status groups, paired with the status string each one is under. */
export interface StatusGroupRef {
    statusId: number;
    status: string;
    group: StatusGroup;
}

/**
 * Yields a test's non-empty status groups with their status strings resolved.
 *
 * `testRuns[testId]` is sparse — `null` where the test never had that status,
 * and simply short where it never had any of the trailing ones — so every
 * caller that walks it repeats the same two guards. This is that loop, once.
 */
export function* statusGroupsOfTest(
    testRuns: readonly (StatusGroup | null)[][],
    statuses: readonly string[],
    testId: number
): Generator<StatusGroupRef> {
    const perTest = testRuns[testId];
    if (!perTest) {
        return;
    }
    for (let statusId = 0; statusId < perTest.length; statusId++) {
        const group = perTest[statusId];
        if (!group) {
            continue;
        }
        const status = statuses[statusId];
        if (status === undefined) {
            throw new TableIndexError('tables.statuses', statusId, statuses.length);
        }
        yield { statusId, status, group };
    }
}
