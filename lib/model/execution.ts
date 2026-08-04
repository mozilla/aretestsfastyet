/**
 * The two execution axes: parallel vs sequential, and initial vs harness
 * rerun.
 *
 * Neither is expressible as a pass/fail count, and both change what a failure
 * *means*. A test that only fails under parallel load is probably racing with
 * its neighbours rather than broken; a test that failed and then passed when
 * the harness reran it is an intermittent, while one that failed both times is
 * much closer to a real breakage.
 *
 * ## Parallel vs sequential: three states, not two
 *
 * The measured fact that shapes this module: **the `-PARALLEL`/`-SEQUENTIAL`
 * suffixes are xpcshell-only, and on xpcshell plain `PASS` coexists with both
 * in the same file.** `FORMATS.md` is explicit that plain `PASS` is not the
 * sum of `PASS-PARALLEL` and `PASS-SEQUENTIAL` — it is its own bucket, for
 * runs where the mode was not recorded.
 *
 * So the mode axis has three states and not two, and the third is not a
 * default:
 *
 * - `parallel` — recorded as running in parallel.
 * - `sequential` — recorded as running sequentially.
 * - `unrecorded` — the status carried no suffix. On mochitest this is *every*
 *   run, because mochitest has no mode axis at all. On xpcshell it is a real
 *   subset of runs alongside the other two.
 *
 * Treating `unrecorded` as a default of one mode is the error this module
 * exists to prevent, and it is why `modeBreakdown()` returns three counts and
 * `hasModeAxis()` exists to tell a caller when the axis is worth showing at
 * all. `fx-tests test --executions` on a mochitest test has nothing to report
 * here and should say so rather than print a one-row table.
 *
 * ## Initial run vs harness rerun
 *
 * When a test fails, the harness reruns it **within the same job**. This is
 * distinct from a **job-level retry**, the `retryId`/`runs/<n>` axis — two
 * different things that both get called "retry" and that
 * `try.html:1381` keeps apart by keying runs on `${taskId}.${retryId}`.
 * `lib/formats/tables.ts` owns the job-level axis (`parseTaskId`); this module
 * owns the within-job one.
 *
 * The published aggregates do not label a run as initial or rerun. What they
 * carry is a **repeated task ID within one `task-ids` bucket**: the same
 * `${taskId}.${retryId}` appearing twice in the same (day, message) bucket
 * means that job saw the status twice, which within a single job is a harness
 * rerun. That is the only signal in this data, so `countRerunsByTask()` is
 * deliberately narrow: it reports repetition, and does not claim to know which
 * occurrence was the initial one, because the file does not record an order.
 *
 * The richer initial/rerun analysis in `try.html` (`isRetry` at `:1022`) comes
 * from a **profile**, not from these files: it detects whether a test's marker
 * falls inside the harness's rerun phase. That belongs with the try-push code
 * in a later step, and this module is careful not to pretend the aggregates
 * can answer the same question.
 */

import type { StatusEntry } from '../formats/status-entries.ts';
import { type ExecutionMode, splitExecutionMode } from './status.ts';

export type { ExecutionMode };

/**
 * The execution mode of a run, with "not recorded" as a first-class state
 * rather than a missing value.
 */
export type ExecutionModeState = ExecutionMode | 'unrecorded';

/** Counts per mode. The three always sum to the total. */
export interface ModeBreakdown {
    parallel: number;
    sequential: number;
    /**
     * Runs whose status carried no suffix. Every mochitest run, and a real
     * subset of xpcshell runs — not a rounding error and not the two others'
     * remainder.
     */
    unrecorded: number;
}

/** The mode a status string records, or `'unrecorded'` when it records none. */
export function executionModeOf(status: string): ExecutionModeState {
    return splitExecutionMode(status).mode ?? 'unrecorded';
}

/**
 * Whether a set of statuses has a mode axis worth reporting.
 *
 * True when at least one status carries a suffix, which in practice means
 * "this is xpcshell data". A caller should use this rather than checking the
 * harness name: the axis is a property of the data, and hardcoding
 * `harness === 'xpcshell'` would go stale the day mochitest starts recording
 * it.
 */
export function hasModeAxis(statuses: Iterable<string>): boolean {
    for (const status of statuses) {
        if (splitExecutionMode(status).mode !== null) {
            return true;
        }
    }
    return false;
}

/** An empty breakdown, for accumulating into. */
export function emptyModeBreakdown(): ModeBreakdown {
    return { parallel: 0, sequential: 0, unrecorded: 0 };
}

/** Adds `count` runs of `status` into a breakdown. */
export function addToModeBreakdown(
    breakdown: ModeBreakdown,
    status: string,
    count: number
): void {
    breakdown[executionModeOf(status)] += count;
}

/**
 * Totals runs per execution mode over (status, count) pairs.
 *
 * The pairs are what a caller already has after iterating status groups; this
 * does not take the groups themselves so that a caller can filter by day,
 * job or kind first, which every real query does.
 */
export function modeBreakdown(runs: Iterable<readonly [string, number]>): ModeBreakdown {
    const breakdown = emptyModeBreakdown();
    for (const [status, count] of runs) {
        addToModeBreakdown(breakdown, status, count);
    }
    return breakdown;
}

// --- harness reruns ------------------------------------------------------

/** What repetition of a task ID within one bucket says about reruns. */
export interface RerunCounts {
    /** Distinct `${taskId}.${retryId}` values that saw this status. */
    jobs: number;
    /** Total occurrences, so `runs - jobs` is the number of extra attempts. */
    runs: number;
    /** Jobs that saw the status more than once — a rerun within the job. */
    jobsWithRerun: number;
}

/**
 * Counts repeated task IDs across a set of entries.
 *
 * A repeated `${taskId}.${retryId}` means one job saw the status more than
 * once, which within a job is a harness rerun. Entries with no `taskIds` —
 * every `counts`, `skip-counts` and `durations` group — contribute nothing,
 * because those shapes discarded the attribution this needs.
 *
 * Deliberately reports counts rather than labelling individual runs "initial"
 * or "rerun": the files record no order within a bucket, so any such label
 * would be invented. What the counts *do* support is the question that
 * matters — "did this fail once per job, or repeatedly within a job?"
 */
export function countRerunsByTask(entries: Iterable<StatusEntry>): RerunCounts {
    const perTask = new Map<string, number>();
    let runs = 0;
    for (const entry of entries) {
        if (entry.taskIds === undefined) {
            continue;
        }
        for (const taskId of entry.taskIds) {
            perTask.set(taskId, (perTask.get(taskId) ?? 0) + 1);
            runs += 1;
        }
    }
    let jobsWithRerun = 0;
    for (const count of perTask.values()) {
        if (count > 1) {
            jobsWithRerun += 1;
        }
    }
    return { jobs: perTask.size, runs, jobsWithRerun };
}

/**
 * The jobs that both failed and passed the same test, given the task IDs seen
 * under each.
 *
 * Within one job a fail and a pass for the same test means the harness reran
 * it and it passed the second time — the "passed on rerun" signal
 * (`try.html:1408`), and the strongest available evidence for an intermittent.
 * A pass with no fail is just a pass; a fail with no pass is a job where every
 * attempt failed.
 *
 * Only usable where both statuses carry task IDs, which in the published
 * aggregates means the `issues-with-taskids` and bucket files' failing groups
 * — and there the *passing* groups have no task IDs at all (`FORMATS.md`), so
 * in practice this answers the question for try-push data rather than for the
 * aggregates. It lives here rather than in the try code because the concept is
 * the same one, and the caller supplying the sets is what varies.
 */
export function passedOnRerun(
    failedTaskIds: Iterable<string>,
    passedTaskIds: Iterable<string>
): Set<string> {
    const failed = new Set(failedTaskIds);
    const both = new Set<string>();
    for (const taskId of passedTaskIds) {
        if (failed.has(taskId)) {
            both.add(taskId);
        }
    }
    return both;
}
