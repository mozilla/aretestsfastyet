/**
 * The outcome of a wpt run, from the markers of a job's profile. A port of
 * `wptRunStatus` in mozilla-central's `testing/timings/profile-worker.js`, which
 * decides; the worker of `site/try.ts` has a third copy.
 */

/** The fields of a wpt `Test` marker the outcome depends on. */
export interface WptTestMarker {
    status?: string | undefined;
    /** The status the metadata expects, present only when it is not `status`. */
    expected?: string | undefined;
    /** The statuses the metadata lists, present only when `status` is one of them. */
    known_intermittent?: string | undefined;
    color?: string | undefined;
    /** Unexpected subtest results, those reported after the test ended included. */
    unexpected_subtests?: number | undefined;
    message?: string | null | undefined;
}

export interface WptUnexpectedSubtest {
    /** The marker's name: `FAIL`, `KNOWN-INTERMITTENT-TIMEOUT`, `UNEXPECTED-PASS`… */
    status: string;
    subtest: string;
    message: string | null;
    /** A pass where a failure is expected, as opposed to a failure. */
    isPass: boolean;
}

const isWptPass = (status: string | undefined): boolean => status === 'OK' || status === 'PASS';

/**
 * How a subtest's `TestStatus` marker counts: `null` when the metadata expects it.
 * A known intermittent failure only counts when a pass is expected: `[TIMEOUT, NOTRUN]`
 * is two ways of failing. Older markers have no `expected`.
 */
export function classifyWptSubtestMarker(
    name: string,
    color: string | undefined,
    expected?: string
): 'failure' | 'pass' | null {
    if (name.startsWith('KNOWN-INTERMITTENT-')) {
        return name !== 'KNOWN-INTERMITTENT-PASS' && expected === 'PASS' ? 'failure' : null;
    }
    // Any other unexpected result is orange.
    if (color !== 'orange') {
        return null;
    }
    return name === 'UNEXPECTED-PASS' ? 'pass' : 'failure';
}

/** A subtest result as a failure message: `FAIL | <subtest> - <message>`. */
export function wptSubtestMessage(subtest: WptUnexpectedSubtest): string {
    return `${subtest.status} | ${subtest.subtest}${subtest.message ? ` - ${subtest.message}` : ''}`;
}

/** `unexpectedSubtests` are those inside the run's time range, in log order. */
export function wptRunStatus(
    marker: WptTestMarker,
    unexpectedSubtests: readonly WptUnexpectedSubtest[]
): { status: string; message: string | null } {
    const { status, expected } = marker;
    const ownMessage = marker.message ?? null;
    if (!status) {
        return { status: 'UNKNOWN', message: null };
    }
    if (status === 'SKIP') {
        return { status, message: ownMessage };
    }

    const isPass = isWptPass(status);
    // Another failure than the expected one, eg. a FAIL with `[TIMEOUT, FAIL]`, is
    // still expected. Older markers only show it as a yellow FAIL.
    const isListedFailure =
        !isWptPass(expected) &&
        (marker.known_intermittent !== undefined || (marker.color === 'yellow' && status !== 'TIMEOUT'));
    // The test's own unexpected failure wins over its subtests.
    if (!isPass && expected !== undefined && !isListedFailure) {
        return {
            status: status === 'TIMEOUT' || status === 'CRASH' ? status : 'FAIL',
            message: ownMessage,
        };
    }

    const failure = unexpectedSubtests.find((subtest) => !subtest.isPass);
    if (failure !== undefined) {
        return { status: 'FAIL', message: wptSubtestMessage(failure) };
    }
    // A failure reported after the test ended, eg. a leak at shutdown.
    const unexpectedCount = unexpectedSubtests.filter(
        (subtest) => !subtest.status.startsWith('KNOWN-INTERMITTENT-')
    ).length;
    if ((marker.unexpected_subtests ?? 0) > unexpectedCount) {
        return { status: 'FAIL', message: ownMessage };
    }
    const unexpectedPass = unexpectedSubtests[0];
    if (unexpectedPass !== undefined) {
        return { status: 'UNEXPECTED-PASS', message: wptSubtestMessage(unexpectedPass) };
    }
    // A yellow marker on a pass is a known intermittent pass.
    if (isPass && expected !== undefined && marker.color !== 'yellow') {
        return { status: 'UNEXPECTED-PASS', message: ownMessage };
    }
    return { status: isPass ? 'PASS' : 'EXPECTED-FAIL', message: null };
}
