/** The wpt status rule, case by case, as the generator's `wptRunStatus` decides it. */

import type { WptTestMarker } from '../lib/model/wpt-status.ts';

export interface WptSubtestMarkerCase {
    name: string;
    color?: string;
    /** What the metadata expects first, when it is not this result. */
    expected?: string;
    subtest: string;
    message?: string;
}

export interface WptScenario {
    label: string;
    test: WptTestMarker;
    subtests: WptSubtestMarkerCase[];
    status: string;
    message: string | null;
}

const FAIL: WptSubtestMarkerCase = { name: 'FAIL', color: 'orange', subtest: 's1', message: 'assert_true' };
const UNEXPECTED_PASS: WptSubtestMarkerCase = { name: 'UNEXPECTED-PASS', color: 'orange', subtest: 's2' };

export const WPT_SCENARIOS: WptScenario[] = [
    // The test did what its metadata says.
    { label: 'OK, nothing unexpected', test: { status: 'OK', color: 'green' }, subtests: [], status: 'PASS', message: null },
    { label: 'a reftest PASS', test: { status: 'PASS', color: 'green' }, subtests: [], status: 'PASS', message: null },
    { label: 'an expected ERROR', test: { status: 'ERROR', color: 'red' }, subtests: [], status: 'EXPECTED-FAIL', message: null },
    { label: 'an expected reftest FAIL', test: { status: 'FAIL', color: 'green' }, subtests: [], status: 'EXPECTED-FAIL', message: null },
    { label: 'an expected TIMEOUT', test: { status: 'TIMEOUT', color: 'yellow', message: 'timed out' }, subtests: [], status: 'EXPECTED-FAIL', message: null },
    { label: 'SKIP', test: { status: 'SKIP', color: 'yellow', message: 'disabled' }, subtests: [], status: 'SKIP', message: 'disabled' },
    {
        label: 'OK with an expected subtest failure',
        test: { status: 'OK', color: 'green' },
        subtests: [{ name: 'KNOWN-FAIL', color: 'yellow', subtest: 's1' }],
        status: 'PASS',
        message: null,
    },
    {
        label: 'OK with a known intermittent subtest pass',
        test: { status: 'OK', color: 'yellow' },
        subtests: [{ name: 'KNOWN-INTERMITTENT-PASS', color: 'yellow', subtest: 's1' }],
        status: 'PASS',
        message: null,
    },
    { label: 'a known intermittent OK', test: { status: 'OK', expected: 'TIMEOUT', color: 'yellow' }, subtests: [], status: 'PASS', message: null },

    // The test's own result is not the expected one.
    { label: 'an unexpected ERROR', test: { status: 'ERROR', expected: 'OK', color: 'red', message: 'e' }, subtests: [], status: 'FAIL', message: 'e' },
    { label: 'an unexpected PRECONDITION_FAILED', test: { status: 'PRECONDITION_FAILED', expected: 'OK', color: 'orange' }, subtests: [], status: 'FAIL', message: null },
    { label: 'an unexpected CRASH', test: { status: 'CRASH', expected: 'OK', color: 'red' }, subtests: [], status: 'CRASH', message: null },
    {
        label: 'an unexpected TIMEOUT wins over a failing subtest',
        test: { status: 'TIMEOUT', expected: 'OK', color: 'yellow', message: 't' },
        subtests: [FAIL],
        status: 'TIMEOUT',
        message: 't',
    },
    { label: 'an unexpected OK', test: { status: 'OK', expected: 'ERROR', color: 'orange' }, subtests: [], status: 'UNEXPECTED-PASS', message: null },

    // A known intermittent result of the test itself: a failure when a pass is expected first.
    {
        label: '[PASS, FAIL] that failed',
        test: { status: 'FAIL', expected: 'PASS', known_intermittent: 'FAIL', color: 'yellow', message: 'm' },
        subtests: [],
        status: 'FAIL',
        message: 'm',
    },
    {
        label: '[OK, TIMEOUT] that timed out',
        test: { status: 'TIMEOUT', expected: 'OK', known_intermittent: 'TIMEOUT', color: 'yellow', message: 't' },
        subtests: [],
        status: 'TIMEOUT',
        message: 't',
    },
    {
        label: '[TIMEOUT, FAIL] that failed',
        test: { status: 'FAIL', expected: 'TIMEOUT', known_intermittent: 'FAIL', color: 'yellow', message: 'm' },
        subtests: [],
        status: 'EXPECTED-FAIL',
        message: null,
    },
    {
        label: '[TIMEOUT, FAIL] that failed, in an older profile',
        test: { status: 'FAIL', expected: 'TIMEOUT', color: 'yellow', message: 'm' },
        subtests: [],
        status: 'EXPECTED-FAIL',
        message: null,
    },
    {
        label: '[FAIL, TIMEOUT] that timed out',
        test: { status: 'TIMEOUT', expected: 'FAIL', known_intermittent: 'TIMEOUT', color: 'yellow', message: 't' },
        subtests: [],
        status: 'EXPECTED-FAIL',
        message: null,
    },
    {
        label: 'a TIMEOUT where only FAIL is expected',
        test: { status: 'TIMEOUT', expected: 'FAIL', color: 'yellow', message: 't' },
        subtests: [],
        status: 'TIMEOUT',
        message: 't',
    },
    {
        label: 'a FAIL where only TIMEOUT is expected',
        test: { status: 'FAIL', expected: 'TIMEOUT', color: 'orange', message: 'm' },
        subtests: [],
        status: 'FAIL',
        message: 'm',
    },
    {
        label: '[TIMEOUT, FAIL] that failed, with an unexpected subtest failure',
        test: { status: 'FAIL', expected: 'TIMEOUT', known_intermittent: 'FAIL', color: 'orange', unexpected_subtests: 1 },
        subtests: [FAIL],
        status: 'FAIL',
        message: 'FAIL | s1 - assert_true',
    },

    // The subtests decide.
    {
        label: 'OK with an unexpected subtest failure',
        test: { status: 'OK', color: 'orange', unexpected_subtests: 1 },
        subtests: [FAIL],
        status: 'FAIL',
        message: 'FAIL | s1 - assert_true',
    },
    {
        label: 'OK with a flaky subtest: [PASS, FAIL] that failed',
        test: { status: 'OK', color: 'yellow' },
        subtests: [{ name: 'KNOWN-INTERMITTENT-FAIL', color: 'yellow', expected: 'PASS', subtest: 's1' }],
        status: 'FAIL',
        message: 'KNOWN-INTERMITTENT-FAIL | s1',
    },
    {
        label: 'OK with a subtest failing another way: [TIMEOUT, NOTRUN] that did not run',
        test: { status: 'OK', color: 'yellow' },
        subtests: [{ name: 'KNOWN-INTERMITTENT-NOTRUN', color: 'yellow', expected: 'TIMEOUT', subtest: 's1' }],
        status: 'PASS',
        message: null,
    },
    {
        label: 'OK with a known intermittent subtest failure, in an older profile',
        test: { status: 'OK', color: 'yellow' },
        subtests: [{ name: 'KNOWN-INTERMITTENT-FAIL', color: 'yellow', subtest: 's1' }],
        status: 'PASS',
        message: null,
    },
    {
        label: 'a flaky subtest, and a failure reported after the test ended',
        test: { status: 'OK', color: 'orange', unexpected_subtests: 1, message: 'leak' },
        subtests: [{ name: 'KNOWN-INTERMITTENT-FAIL', color: 'yellow', expected: 'PASS', subtest: 's1' }],
        status: 'FAIL',
        message: 'KNOWN-INTERMITTENT-FAIL | s1',
    },
    {
        label: 'an expected TIMEOUT with an unexpected subtest failure',
        test: { status: 'TIMEOUT', color: 'yellow', unexpected_subtests: 1, message: 'timed out' },
        subtests: [FAIL],
        status: 'FAIL',
        message: 'FAIL | s1 - assert_true',
    },
    {
        label: 'an expected ERROR with an unexpected subtest failure',
        test: { status: 'ERROR', color: 'red', unexpected_subtests: 1 },
        subtests: [FAIL],
        status: 'FAIL',
        message: 'FAIL | s1 - assert_true',
    },
    {
        label: 'OK with only an unexpected subtest pass',
        test: { status: 'OK', color: 'orange', unexpected_subtests: 1 },
        subtests: [UNEXPECTED_PASS],
        status: 'UNEXPECTED-PASS',
        message: 'UNEXPECTED-PASS | s2',
    },
    {
        label: 'an expected TIMEOUT with only an unexpected subtest pass',
        test: { status: 'TIMEOUT', color: 'yellow', unexpected_subtests: 1 },
        subtests: [UNEXPECTED_PASS],
        status: 'UNEXPECTED-PASS',
        message: 'UNEXPECTED-PASS | s2',
    },
    {
        label: 'a failure wins over an unexpected pass logged before it',
        test: { status: 'OK', color: 'orange', unexpected_subtests: 2 },
        subtests: [UNEXPECTED_PASS, FAIL],
        status: 'FAIL',
        message: 'FAIL | s1 - assert_true',
    },
    {
        label: 'a failure counted with no subtest marker, reported after the test ended',
        test: { status: 'OK', color: 'orange', unexpected_subtests: 1, message: 'leak' },
        subtests: [],
        status: 'FAIL',
        message: 'leak',
    },
    {
        label: 'more unexpected results than the markers explain',
        test: { status: 'OK', color: 'orange', unexpected_subtests: 2 },
        subtests: [UNEXPECTED_PASS],
        status: 'FAIL',
        message: null,
    },

    // Not a result at all.
    { label: 'a marker with no status', test: {}, subtests: [], status: 'UNKNOWN', message: null },
];
