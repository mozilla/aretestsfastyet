/**
 * THE status taxonomy. One definition.
 *
 * The pass/fail/skip/timeout/crash classification is reimplemented eight times
 * across the dashboards and the copies do not agree (`PLAN.md` §1 has the
 * table). This module is the one definition they should all have been, and
 * every decision that the eight variants made differently is made here, once,
 * with the reasoning written down and a test asserting it.
 *
 * ## The decisions
 *
 * **`CRASH` is its own kind, not a failure.** This was the one live
 * disagreement: `issues.html:1350` and `xpcshell-timings.html:656` fold
 * crashes into failures, everything else counts them separately. The library
 * reports `crash` and lets the caller aggregate — `isFailureLike()` is
 * provided for callers that want the union, so neither side has to reimplement
 * it. Reporting the union and letting the caller *disaggregate* is not
 * possible, which is why this direction is the right one.
 *
 * **`UNKNOWN` is its own kind and is never folded into pass or fail.** A job
 * without structured logging did not report an outcome, so putting its runs in
 * either bucket invents information. Two pages currently guess such runs into
 * passes, which inflates a pass rate rather than a failure count.
 * `FORMATS.md`'s census found zero occurrences across 854,914,907 runs on 21
 * days of both harnesses, so this costs one enum member and buys visibility if
 * the status ever returns.
 *
 * **No duration heuristics.** `xpcshell-timings.html:684`, `:1213` and
 * `issues.html:1024` guess an outcome from a runtime (`<100ms` → skip,
 * `>300s` → timeout, else pass). They exist only to give `UNKNOWN` runs an
 * outcome, they are dead now that `UNKNOWN` does not occur, and guessing an
 * outcome from a runtime does not belong in a tested library. Not ported.
 *
 * **`EXPECTED-FAIL` is its own kind.** A test annotated `fail-if` that fails
 * did what it was told; counting it as a failure inflates failure counts and
 * counting it as a pass hides an annotation that may be stale.
 * `common-test-data.js:155` treats it as a pass and `computeTestStats()`
 * excludes it from `isFail` without giving it a home, so both effectively
 * count it as a pass. Naming it separately is what lets a caller decide.
 *
 * **Classification is by prefix, not by a hardcoded list.** The eight variants
 * each carry their own list of status strings, which is why a new suffix goes
 * stale in eight places. The suffixes are an orthogonal axis
 * (`lib/model/execution.ts`), so the kind comes from the part before the
 * suffix.
 */

/**
 * What happened to a test run.
 *
 * Deliberately not an aggregate: `fail` does not include `timeout` or `crash`,
 * because a caller that wants the union can compute it and a caller that wants
 * the parts cannot recover them.
 */
export type StatusKind =
    | 'pass'
    | 'fail'
    | 'timeout'
    | 'crash'
    | 'skip'
    | 'expected-fail'
    | 'unknown';

/**
 * The result of classifying a status string.
 *
 * `mode` is the execution-mode axis, and is `null` when the status carried no
 * suffix — see `lib/model/execution.ts` for why "not recorded" has to be a
 * distinct state rather than defaulting to one of the two modes.
 */
export interface ClassifiedStatus {
    kind: StatusKind;
    /** `'parallel'`, `'sequential'`, or `null` when the status records no mode. */
    mode: ExecutionMode | null;
    /** The status string as it appeared, unchanged. */
    raw: string;
}

/** The xpcshell execution-mode suffix, when a status carries one. */
export type ExecutionMode = 'parallel' | 'sequential';

/**
 * Every status string observed in the sweep, for reference.
 *
 * **Not used for classification** — `classifyStatus()` works by prefix so an
 * unseen status is classified rather than rejected. This list exists so a test
 * can assert the classifier's answer for each of the twelve, and so a reader
 * can see what the data actually contains without opening `FORMATS.md`.
 *
 * The `-PARALLEL`/`-SEQUENTIAL` variants are xpcshell-only; mochitest emits
 * only the six unsuffixed ones.
 */
export const OBSERVED_STATUSES = [
    'PASS',
    'PASS-PARALLEL',
    'PASS-SEQUENTIAL',
    'FAIL',
    'FAIL-PARALLEL',
    'FAIL-SEQUENTIAL',
    'TIMEOUT',
    'TIMEOUT-PARALLEL',
    'TIMEOUT-SEQUENTIAL',
    'CRASH',
    'SKIP',
    'EXPECTED-FAIL',
] as const;

/**
 * Splits the execution-mode suffix off a status string.
 *
 * Returns the base status and the mode, or `null` for a status with no
 * suffix. `EXPECTED-FAIL` is the reason this cannot simply split on the last
 * `-`: its own name contains one, and only the two known suffixes are
 * suffixes.
 */
export function splitExecutionMode(status: string): { base: string; mode: ExecutionMode | null } {
    if (status.endsWith('-PARALLEL')) {
        return { base: status.slice(0, -'-PARALLEL'.length), mode: 'parallel' };
    }
    if (status.endsWith('-SEQUENTIAL')) {
        return { base: status.slice(0, -'-SEQUENTIAL'.length), mode: 'sequential' };
    }
    return { base: status, mode: null };
}

/**
 * Classifies a status string into a kind and an execution mode.
 *
 * Unrecognized statuses are classified `unknown` rather than throwing: an
 * unrecognized *shape* is a decoding failure and must throw (`PLAN.md` §4),
 * but an unrecognized status is a run whose outcome this library does not
 * understand, and reporting it as such is exactly what the `unknown` kind is
 * for. Throwing here would take a whole query down over one run.
 */
export function classifyStatus(status: string): ClassifiedStatus {
    const { base, mode } = splitExecutionMode(status);
    return { kind: classifyBase(base), mode, raw: status };
}

/** The kind of a status with any execution-mode suffix already removed. */
function classifyBase(base: string): StatusKind {
    switch (base) {
        case 'PASS':
        // The harness's own name for a passing xpcshell test. Not observed in
        // the published files, but `common-test-data.js:155` treats it as a
        // pass and the cost of agreeing is a line.
        case 'OK':
            return 'pass';
        case 'FAIL':
            return 'fail';
        case 'TIMEOUT':
            return 'timeout';
        case 'CRASH':
            return 'crash';
        case 'SKIP':
            return 'skip';
        case 'EXPECTED-FAIL':
            return 'expected-fail';
        case 'UNKNOWN':
            return 'unknown';
        default:
            return 'unknown';
    }
}

// --- predicates ----------------------------------------------------------
//
// Named so a call site reads as the question it is asking. Each is one line;
// the value is that there is one of each rather than eight.

/** The test ran and passed. */
export function isPass(kind: StatusKind): boolean {
    return kind === 'pass';
}

/** The test ran and did not pass in the way it was supposed to. */
export function isFail(kind: StatusKind): boolean {
    return kind === 'fail';
}

/**
 * The test did not produce a passing result, by any means: failure, timeout or
 * crash.
 *
 * This is the aggregate the `CRASH` disagreement was about. `expected-fail` is
 * **not** included — the test failed as annotated, which is not the same claim
 * — and neither is `unknown`, which reports no outcome at all.
 */
export function isFailureLike(kind: StatusKind): boolean {
    return kind === 'fail' || kind === 'timeout' || kind === 'crash';
}

/** The test did not run. */
export function isSkip(kind: StatusKind): boolean {
    return kind === 'skip';
}

/**
 * The run counts towards a pass rate's denominator.
 *
 * Skips are excluded because the test did not run, and `unknown` is excluded
 * because no outcome was reported — including it would put a run in the
 * denominator that can never be in the numerator, which silently depresses the
 * rate. `expected-fail` counts as a run that behaved as annotated, so it is in
 * the denominator; `passRateNumerator` decides whether it is in the numerator.
 */
export function countsAsRun(kind: StatusKind): boolean {
    return kind !== 'skip' && kind !== 'unknown';
}

/**
 * Whether a kind counts towards the numerator of a pass rate.
 *
 * `expected-fail` counts: the run did what the annotation said it would, so a
 * "did CI behave as expected" rate should count it, and that is the rate the
 * dashboards report. A caller wanting "did the test pass" instead should use
 * `isPass` directly — which is the distinction the current pages blur by
 * having only one rate.
 */
export function passRateNumerator(kind: StatusKind): boolean {
    return kind === 'pass' || kind === 'expected-fail';
}
