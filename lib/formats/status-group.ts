/**
 * The status-group shapes.
 *
 * A `testRuns[testId]` entry is a sparse array indexed by status ID (into
 * `tables.statuses`); a `null` hole means the test never had that status. Each
 * non-null entry is a *status group*, and its shape depends on both the file
 * family and the status. `getCountAtIndex()` in `common-test-data.js:37`
 * exists solely to paper over the differences; `lib/formats/status-group.ts`
 * will replace it with one iterator in step 1.
 *
 * Every group is a set of parallel arrays of the same length. What varies is
 * which arrays are present:
 *
 * | file family | pass-like | skip | fail-like | crash |
 * | --- | --- | --- | --- | --- |
 * | daily | flat `taskIdIds`/`durations`/`timestamps` | + `messageIds` | + `messageIds` | + `crashSignatureIds`/`minidumps` (flat strings) |
 * | issues | `counts` | + `messageIds` | + `messageIds` | + `crashSignatureIds` |
 * | issues-with-taskids | `counts` (**unchanged from issues**) | nested `taskIdIds` + `messageIds` | nested `taskIdIds` + `messageIds` | + `crashSignatureIds`/`minidumps` (nested) |
 * | buckets | nested `durations` + `jobNameIds` | `counts` + `jobNameIds` + `messageIds` | nested `taskIdIds` + `messageIds` | + `crashSignatureIds`/`minidumps` (nested) |
 *
 * Two things that are easy to get wrong and are checked by the validator:
 *
 * - In `issues-with-taskids.json`, the PASS-like groups are **not** upgraded to
 *   task IDs: they keep the `counts` shape from `issues.json`. Only the
 *   non-passing groups (and SKIP, and EXPECTED-FAIL) gain `taskIdIds`. So the
 *   file does not have task IDs for passing runs, despite its name.
 * - `minidumps` is a flat `string` per entry in the daily files, and a
 *   `string[]` per entry everywhere else — the same axis as `taskIdIds`.
 *
 * ## `messageIds` presence follows the *status*, not the shape
 *
 * This is the one that will bite a unified iterator, because it breaks the
 * assumption the shape discriminant is sufficient. Within the single
 * `task-ids` shape, whether `messageIds` exists depends on which status the
 * group belongs to, and it is all-or-nothing per status — never mixed:
 *
 * | status | shape | `messageIds` |
 * | --- | --- | --- |
 * | `FAIL`, `FAIL-PARALLEL`, `FAIL-SEQUENTIAL` | task-ids | **always** |
 * | `SKIP` | task-ids (issues-with-taskids) / skip-counts (buckets) | **always** |
 * | `TIMEOUT`, `TIMEOUT-PARALLEL`, `TIMEOUT-SEQUENTIAL` | task-ids | **never** |
 * | `CRASH` | task-ids | **never** — it carries `crashSignatureIds` instead |
 * | `EXPECTED-FAIL` | task-ids | **never** |
 * | `PASS*` | durations / counts | **never** |
 *
 * Measured over every bucket and both issues files: e.g. in
 * `xpcshell-issues-with-taskids.json`, all 3,689 `FAIL-PARALLEL` groups have
 * `messageIds` and all 767 `TIMEOUT-PARALLEL` groups — same shape — do not.
 *
 * So `formats/status-group.ts`'s iterator must branch on the **status string**
 * as well as the shape. Reading `messageIds` off a `task-ids` group because
 * the shape says it might be there yields `undefined` for every timeout and
 * every crash, which then reads as "failed with no message" rather than "this
 * status does not record messages".
 */

import type { DeltaDays, TableIndex } from './common.ts';

/**
 * Fields carried by every status group regardless of shape.
 *
 * `days` is present on the 21-day files (issues, issues-with-taskids, buckets)
 * and absent from the daily ones. Its presence is what distinguishes the
 * nested shapes from the flat ones, which is why `getCountAtIndex()` tests for
 * it.
 */
interface StatusGroupBase {
    days?: DeltaDays | undefined;
    /** Index into `tables.messages`; `null` when the run recorded no message. */
    messageIds?: (TableIndex | null)[];
    /** Index into `tables.crashSignatures`; only on CRASH groups. */
    crashSignatureIds?: (TableIndex | null)[];
}

/**
 * Daily file: one entry per run, no `days`, no nesting.
 *
 * `timestamps` are delta-encoded seconds from `metadata.startTime`, in run
 * order. `durations` are milliseconds. SKIP entries carry a duration of 0.
 */
export interface FlatStatusGroup extends StatusGroupBase {
    days?: undefined;
    taskIdIds: TableIndex[];
    durations: number[];
    /** Delta-encoded seconds since `metadata.startTime`. */
    timestamps: number[];
    /** One minidump ID per entry; CRASH groups only. */
    minidumps?: string[];
}

/**
 * `issues.json`, and the PASS-like groups of `issues-with-taskids.json`:
 * counts only, bucketed by (day, message, signature). No task or job
 * attribution at all.
 */
export interface CountsStatusGroup extends StatusGroupBase {
    days: DeltaDays;
    counts: number[];
    /** Never present on this shape — attribution is what `counts` gives up. */
    taskIdIds?: undefined;
    jobNameIds?: undefined;
    durations?: undefined;
}

/**
 * The SKIP shape in the 64-bucket files: a count per (day, job, message)
 * bucket. The only shape that carries both `counts` and `jobNameIds`.
 */
export interface SkipCountsStatusGroup extends StatusGroupBase {
    days: DeltaDays;
    counts: number[];
    jobNameIds: TableIndex[];
    messageIds: (TableIndex | null)[];
}

/**
 * The PASS shape in the 64-bucket files: an array of durations (milliseconds)
 * per (day, job) bucket. The bucket's length is the run count — this is what
 * makes per-config pass counts available without task IDs.
 */
export interface DurationsStatusGroup extends StatusGroupBase {
    days: DeltaDays;
    durations: number[][];
    jobNameIds: TableIndex[];
    taskIdIds?: undefined;
    counts?: undefined;
}

/**
 * The failing shapes in the 64-bucket and issues-with-taskids files: an array
 * of task-ID indices per (day, message, signature) bucket. The bucket's length
 * is the run count, and a repeated index means the same job saw the status
 * more than once (a harness rerun within the job).
 */
export interface TaskIdsStatusGroup extends StatusGroupBase {
    days: DeltaDays;
    taskIdIds: TableIndex[][];
    /** One minidump ID per task ID in the parallel bucket; CRASH groups only. */
    minidumps?: string[][];
    counts?: undefined;
    durations?: undefined;
    jobNameIds?: undefined;
}

/** Any status group, in any file family. */
export type StatusGroup =
    | FlatStatusGroup
    | CountsStatusGroup
    | SkipCountsStatusGroup
    | DurationsStatusGroup
    | TaskIdsStatusGroup;

/**
 * A test's runs, indexed by status ID. Sparse: `null` (and, at the tail,
 * simply absent) where the test never had that status.
 */
export type TestRuns = (StatusGroup | null)[];
