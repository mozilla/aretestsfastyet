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
     * The `tables.taskIds` indices behind `taskIds`, parallel to it.
     *
     * Exposed because `taskInfo`'s parallel arrays — `jobNameIds`, `chunks`,
     * `commitIds`, `repositoryIds` — are indexed *by* the task-ID index, and
     * resolving a failing run's job name means going through them. The
     * alternative is a caller holding a decoded `taskIds` string and scanning
     * `tables.taskIds` to find where it came from, which is O(n) per entry and
     * discards an index the decoder had in hand.
     *
     * Only the `task-ids` and `flat` shapes have this; `durations` and
     * `skip-counts` carry `jobName` directly and never needed it.
     */
    taskIdIndexes?: number[];
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

/** Thrown when a group's parallel arrays are not all the same length. */
export class MisalignedStatusGroupError extends Error {
    // Written out rather than declared as constructor parameter properties:
    // `node --experimental-strip-types` erases types without emitting code, so
    // a parameter property has nowhere to be assigned and is rejected outright.
    readonly status: string;
    readonly lengths: Record<string, number>;

    constructor(status: string, lengths: Record<string, number>) {
        const described = Object.entries(lengths)
            .map(([key, length]) => `${key}=${length}`)
            .join(', ');
        super(`status group for ${status} has misaligned parallel arrays: ${described}`);
        this.name = 'MisalignedStatusGroupError';
        this.status = status;
        this.lengths = lengths;
    }
}

/** The arrays that are parallel to each other within a status group. */
const PARALLEL_KEYS = [
    'days',
    'counts',
    'taskIdIds',
    'durations',
    'timestamps',
    'jobNameIds',
    'messageIds',
    'crashSignatureIds',
    'minidumps',
] as const;

/**
 * How many entries a group has, checking that every array agrees.
 *
 * Every array in a group is parallel, so any of them gives the answer — which
 * means any *disagreement* between them is a corrupt group, and reading the
 * longest or the first would silently truncate or pad.
 *
 * This used to take `days.length` and trust the rest, on the grounds that
 * `tools/validate/` checks the invariant. It does, but only over files a
 * developer points it at: it is a dev tool that never runs on library input,
 * so citing it here was citing an enforcement that does not exist on this
 * path. The check is cheap — one length read per present array — so the
 * decoder does it itself and throws.
 */
export function entryCount(
    group: StatusGroup,
    shape?: StatusGroupShape,
    status = '(unknown status)'
): number {
    const g = fields(group);
    const lengths: Record<string, number> = {};
    for (const key of PARALLEL_KEYS) {
        const value = g[key];
        if (Array.isArray(value)) {
            lengths[key] = value.length;
        }
    }

    const distinct = new Set(Object.values(lengths));
    if (distinct.size > 1) {
        throw new MisalignedStatusGroupError(status, lengths);
    }

    // `days` is authoritative where it exists, and otherwise the array the
    // shape is named for. They are equal by the check above; naming the source
    // keeps the intent readable rather than depending on iteration order.
    const days = lengths['days'];
    if (days !== undefined) {
        return days;
    }
    switch (shape ?? statusGroupShape(group, status)) {
        case 'flat':
        case 'task-ids':
            return requireArray(g['taskIdIds'], 'taskIdIds', status).length;
        case 'counts':
        case 'skip-counts':
            return requireArray(g['counts'], 'counts', status).length;
        case 'durations':
            return requireArray(g['durations'], 'durations', status).length;
    }
}

/** Reads a required array off a group, throwing if it is missing or not one. */
function requireArray(value: unknown, key: string, status: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new UnknownStatusGroupShapeError(status, [`${key} is ${typeof value}, not an array`]);
    }
    return value;
}

/**
 * Reads entry `i` of a group's array, throwing rather than substituting a
 * default.
 *
 * The whole point of the module. A missing slot cannot be filled in with `0`
 * or `[]`: those are plausible values that flow into a total and make it
 * quietly wrong, which is structurally the same mistake as
 * `getCountAtIndex()`'s `else { return 1; }`. `entryCount()` guarantees every
 * array is the same length, so reaching this throw means the group changed
 * shape underneath that check.
 */
function at<T>(array: readonly T[], i: number, key: string, status: string): T {
    const value = array[i];
    if (value === undefined) {
        throw new MisalignedStatusGroupError(status, { [key]: array.length, index: i });
    }
    return value;
}

/**
 * Reads a *nested* entry — one whose slot is itself an array — and checks that
 * it is one.
 *
 * The length check in `entryCount()` cannot catch a nested array that has been
 * flattened, because flattening a group whose buckets all hold one element
 * leaves the length unchanged: `[[7]]` and `[7]` are both length 1. The
 * difference only shows in the element type, and it matters — the nested form
 * means "one bucket holding one run" and the flat form would be read as a
 * bucket that is a number, whose `.length` is `undefined`.
 *
 * Without this the decoder reached `indexes.slice is not a function`, which is
 * a `TypeError` from three frames deep rather than a statement about the data.
 */
function nestedAt(array: readonly unknown[], i: number, key: string, status: string): unknown[] {
    const value = at(array, i, key, status);
    if (!Array.isArray(value)) {
        throw new UnknownStatusGroupShapeError(status, [
            `${key}[${i}] is ${typeof value}, expected an array of per-run values`,
        ]);
    }
    return value;
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
    const length = entryCount(group, shape, status);

    for (let i = 0; i < length; i++) {
        if (rawDays !== undefined) {
            day += at(rawDays, i, 'days', status);
        }
        const dayValue = rawDays !== undefined ? day : null;

        switch (shape) {
            case 'flat': {
                const taskIdIds = g['taskIdIds'] as number[];
                const durations = g['durations'] as number[];
                const timestamps = g['timestamps'] as number[] | undefined;
                const taskIdIndex = at(taskIdIds, i, 'taskIdIds', status);
                const entry: StatusEntry = {
                    day: dayValue,
                    count: 1,
                    index: i,
                    taskIdIndexes: [taskIdIndex],
                    taskIds: [
                        lookupRequiredTable(tables.taskIds, taskIdIndex, 'tables.taskIds'),
                    ],
                    durations: [at(durations, i, 'durations', status)],
                };
                if (timestamps !== undefined) {
                    timestamp += at(timestamps, i, 'timestamps', status);
                    entry.timestamps = [timestamp];
                }
                if (rawMinidumps !== undefined) {
                    // Flat: one minidump ID per entry, not an array of them.
                    // `null` is a real value here — a crash whose dump was not
                    // uploaded — so it is read through, and only a *missing*
                    // slot throws.
                    entry.minidumps = [
                        at(rawMinidumps as (string | null)[], i, 'minidumps', status),
                    ];
                }
                yield decorate(entry, i);
                break;
            }
            case 'counts': {
                const counts = g['counts'] as number[];
                yield decorate(
                    { day: dayValue, count: at(counts, i, 'counts', status), index: i },
                    i
                );
                break;
            }
            case 'skip-counts': {
                const counts = g['counts'] as number[];
                yield decorate(
                    {
                        day: dayValue,
                        count: at(counts, i, 'counts', status),
                        index: i,
                        jobName: jobNameAt(i),
                    },
                    i
                );
                break;
            }
            case 'durations': {
                const bucket = nestedAt(
                    g['durations'] as number[][],
                    i,
                    'durations',
                    status
                ) as number[];
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
                const indexes = nestedAt(
                    g['taskIdIds'] as number[][],
                    i,
                    'taskIdIds',
                    status
                ) as number[];
                const entry: StatusEntry = {
                    day: dayValue,
                    count: indexes.length,
                    index: i,
                    taskIdIndexes: indexes.slice(),
                    taskIds: indexes.map((id) =>
                        lookupRequiredTable(tables.taskIds, id, 'tables.taskIds')
                    ),
                };
                if (rawMinidumps !== undefined) {
                    entry.minidumps = nestedAt(
                        rawMinidumps as (string | null)[][],
                        i,
                        'minidumps',
                        status
                    ).slice() as (string | null)[];
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
