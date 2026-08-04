/**
 * The one thing the per-family decoders have in common: a file, plus a way to
 * walk any test's runs as uniform entries.
 *
 * The five timing families differ in their metadata, their tables and which
 * status-group shapes they use, and `daily.ts`/`issues.ts`/`buckets.ts` own
 * those differences. What they should *not* each own is the walk itself, which
 * is identical once `status-entries.ts` has resolved the shapes. This is that
 * walk.
 *
 * The interface is deliberately small — find a test, iterate its runs — because
 * that is the whole surface `lib/query/` needs in step 3. Anything more
 * specific belongs to the family that has it: only the daily files have
 * timestamps, only the bucket files have `taskInfo.chunks`.
 */

import {
    type IterateOptions,
    type StatusEntry,
    type StatusGroupTables,
    iterateStatusGroup,
    statusGroupsOfTest,
    totalRuns,
} from './status-entries.ts';
import type { StatusGroup } from './status-group.ts';
import {
    TableIndexError,
    type TestIdentity,
    type TestInfoArrays,
    type TestInfoTables,
    indexTestsByPath,
    lookup,
    readTest,
} from './tables.ts';

/** One test run entry, with the status it happened under. */
export interface RunEntry extends StatusEntry {
    /** The status string, e.g. `FAIL-PARALLEL`. */
    status: string;
    /** Its index in `tables.statuses`. */
    statusId: number;
}

/**
 * A decoded timing file: whatever family it came from, this is what the layers
 * above it see.
 *
 * `days` is `null` for the daily files, which cover one day and whose entries
 * therefore carry a `null` day. Everything else covers 21, with day 0 the
 * oldest — the encoding that makes "the last 3 days" `day >= days - 3`.
 */
export interface DecodedTimingFile {
    /** `'daily' | 'issues' | 'issues-with-taskids' | 'bucket'`. */
    family: TimingFamily;
    /** Number of days covered, or `null` for a single-day file. */
    days: number | null;
    /** The date a daily file covers, or the aggregate's end date. */
    endDate: string;
    /** Every status string in the file, indexed by status ID. */
    statuses: readonly string[];
    /** How many tests the file describes. */
    testCount: number;
    /** Looks a test up by full path, `null` when the file has no such test. */
    findTest(fullPath: string): TestIdentity | null;
    /** Reads a test's identity by index. */
    testAt(testId: number): TestIdentity;
    /** Yields every run entry of a test, across all its statuses. */
    runsOfTest(testId: number): Generator<RunEntry>;
    /**
     * Total runs of a test per status, without decoding the entries.
     *
     * The cheap path for a pass-rate query, which needs the totals and not the
     * attribution. Keyed by status string.
     */
    totalsByStatus(testId: number): Map<string, number>;
    /**
     * The job a task ran, from a `StatusEntry.taskIdIndexes` entry, or `null`
     * when the file has no `taskInfo` to resolve it through.
     *
     * The `task-ids` shape attributes a failure to a task and not to a job, so
     * every per-configuration query has to go from one to the other — that is
     * what `computeConfigStats()` (`common-test-data.js:186`) does inline. The
     * lookup needs `taskInfo.jobNameIds`, which is a per-family field, so
     * without this a caller would have to reach past the decoded file to the
     * raw one and scan `tables.taskIds` for the string it was just given.
     *
     * `null` rather than a throw because `{harness}-issues.json` genuinely has
     * no `taskInfo`: it gave up attribution entirely, and asking it for a job
     * is a reasonable question with the answer "this file cannot say".
     */
    jobNameOfTaskIndex(taskIdIndex: number): string | null;
}

/** Which family a decoded file came from. */
export type TimingFamily = 'daily' | 'issues' | 'issues-with-taskids' | 'bucket';

/** What `decodeTimingFile` needs from a family-specific file. */
export interface TimingFileInput {
    family: TimingFamily;
    days: number | null;
    endDate: string;
    tables: StatusGroupTables & TestInfoTables & { statuses: readonly string[] };
    testInfo: TestInfoArrays;
    testRuns: readonly (StatusGroup | null)[][];
    /**
     * `taskInfo.jobNameIds`, for resolving a task index to the job that ran
     * it. Absent on `{harness}-issues.json`, which has no `taskInfo`.
     */
    taskJobNameIds?: readonly number[] | undefined;
    /** `metadata.startTime`, for the daily files' delta-encoded timestamps. */
    iterateOptions?: IterateOptions | undefined;
}

/**
 * Wraps a parsed timing file in the family-independent interface.
 *
 * Does no work up front beyond what is needed to answer `testCount`: the path
 * index is built lazily, because a query that already knows its test ID should
 * not pay to index 100,000 test paths it will not look at.
 */
export function decodeTimingFile(input: TimingFileInput): DecodedTimingFile {
    const { tables, testInfo, testRuns } = input;
    let byPath: Map<string, number> | undefined;

    return {
        family: input.family,
        days: input.days,
        endDate: input.endDate,
        statuses: tables.statuses,
        testCount: testInfo.testPathIds.length,

        findTest(fullPath: string): TestIdentity | null {
            byPath ??= indexTestsByPath(tables, testInfo);
            const testId = byPath.get(fullPath);
            return testId === undefined ? null : readTest(tables, testInfo, testId);
        },

        testAt(testId: number): TestIdentity {
            return readTest(tables, testInfo, testId);
        },

        *runsOfTest(testId: number): Generator<RunEntry> {
            for (const ref of statusGroupsOfTest(testRuns, tables.statuses, testId)) {
                for (const entry of iterateStatusGroup(
                    ref.group,
                    ref.status,
                    tables,
                    input.iterateOptions ?? {}
                )) {
                    yield { ...entry, status: ref.status, statusId: ref.statusId };
                }
            }
        },

        totalsByStatus(testId: number): Map<string, number> {
            const totals = new Map<string, number>();
            for (const ref of statusGroupsOfTest(testRuns, tables.statuses, testId)) {
                totals.set(
                    ref.status,
                    (totals.get(ref.status) ?? 0) + totalRuns(ref.group, ref.status)
                );
            }
            return totals;
        },

        jobNameOfTaskIndex(taskIdIndex: number): string | null {
            const jobNameIds = input.taskJobNameIds;
            if (jobNameIds === undefined) {
                return null;
            }
            const jobNameId = jobNameIds[taskIdIndex];
            if (jobNameId === undefined) {
                throw new TableIndexError('taskInfo.jobNameIds', taskIdIndex, jobNameIds.length);
            }
            if (tables.jobNames === undefined) {
                throw new Error('tables.jobNames is needed to name a job but was not supplied');
            }
            return lookup(tables.jobNames as string[], jobNameId, 'tables.jobNames');
        },
    };
}
