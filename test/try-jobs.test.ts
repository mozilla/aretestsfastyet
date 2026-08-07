/**
 * `lib/model/try-jobs.ts` — the job classification and selection both `try`
 * consumers now share.
 *
 * ## What this file is for, and the trap it is written around
 *
 * After an extraction, "the page and the CLI agree" is trivially true and
 * proves nothing: they call one function, so of course they agree. A test that
 * asserts it is a test of `===`. The dominant defect class in this repository
 * is a test whose expected value derives from the thing under test, and an
 * extraction is the easiest place in the world to write one.
 *
 * So every number below is a **literal read off `test/fixtures/try-7d16bff81bb1.json`
 * by code in this file that does not import `lib/model/try-jobs.ts`** — the
 * `rawCount` helper, a substring test written out inline. If the shared module
 * and this file were both wrong in the same way, comparing them to each other
 * would agree and comparing them to the fixture would not. Two of the numbers
 * (46 and 1,538) are the same ones `test/try-view.test.ts` and
 * `test/try-parity.test.ts` already pin, deliberately: they are the two the
 * `--all-jobs` defect turned on.
 *
 * The parity assertion that *is* worth making after the extraction is not
 * "both sides agree" but "both sides go through here at all", and that is not
 * assertable from inside this file. It is a mutation check, recorded at the
 * bottom.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { TreeherderJob } from '../lib/sources/treeherder.ts';
import {
    FAILURE_STATUSES,
    SUPPORTED_HARNESSES,
    baseStatus,
    isFailureStatus,
    isTestJob,
    runKeyOf,
    selectTryJobs,
} from '../lib/model/try-jobs.ts';

// --- the fixture, read without the module under test ----------------------

interface PushFixture {
    jobs: TreeherderJob[];
}

const PUSH: PushFixture = JSON.parse(
    readFileSync(new URL('./fixtures/try-7d16bff81bb1.json', import.meta.url), 'utf8')
) as PushFixture;

/**
 * Counts the fixture's jobs matching a predicate, with the harness test spelled
 * out rather than imported.
 *
 * The duplication of the substring test is the point: this is the independent
 * reading the expectations come from, so it must not call `isTestJob`.
 */
function rawCount(predicate: (job: TreeherderJob) => boolean): number {
    return PUSH.jobs.filter(predicate).length;
}

const rawIsTest = (name: string): boolean =>
    name.includes('mochitest') || name.includes('xpcshell');

// --- the fixture's shape, pinned ------------------------------------------

test('the pinned push is the one these numbers were read off', () => {
    // Every assertion below is a literal, so the fixture being the expected one
    // is itself worth asserting: a regenerated fixture must fail here, loudly
    // and once, rather than in nine places with nine different numbers.
    assert.equal(PUSH.jobs.length, 1731, '1,731 jobs');
    assert.equal(
        rawCount((job) => job.state === 'completed'),
        1731,
        'all of them completed — this push is finished, so nothing here exercises the state gate'
    );
});

// --- isTestJob -------------------------------------------------------------

test('a job is a test job when its name contains a parseable harness', () => {
    // Real names off the fixture, both sides of the line.
    assert.equal(isTestJob('test-linux2404-64/debug-xpcshell-3'), true);
    assert.equal(isTestJob('test-windows11-64-25h2-asan/opt-mochitest-browser-chrome-37'), true);
    assert.equal(isTestJob('build-win32/debug'), false);
    assert.equal(isTestJob('source-test-mozlint-license'), false);
    assert.equal(isTestJob('Gecko Decision Task'), false);

    // The substring rule, stated as a behaviour rather than left implicit: the
    // harness name can appear anywhere, which is what makes a `-swr-` or
    // `-msix-` variant match without being listed.
    assert.equal(isTestJob('test-linux2404-64/opt-mochitest-browser-chrome-swr-9'), true);
    assert.equal(isTestJob('anything-xpcshell-anything'), true);

    // And a harness this tooling cannot parse profiles for is not a test job
    // here, however much of a test it is elsewhere. This is the line that
    // `SUPPORTED_HARNESSES` draws and the reason it is not a taxonomy: a
    // `test-` prefix and a `-2` chunk suffix are not what the rule reads.
    assert.equal(isTestJob('test-linux2404-64/opt-reftest-2'), false);
    assert.equal(isTestJob('test-linux2404-64/opt-web-platform-tests-2'), false);
    assert.deepEqual([...SUPPORTED_HARNESSES], ['mochitest', 'xpcshell']);

    // The looseness cuts the other way too, and on this fixture it decides
    // 127 jobs: every geckoview job on this push is a geckoview-*mochitest*,
    // so the substring rule takes all of them. Named because "geckoview" reads
    // like a different harness and the rule never looks at that part.
    assert.equal(isTestJob('test-android-em-14-x86_64/opt-geckoview-mochitest-plain-xorig-5'), true);
    assert.equal(
        rawCount((job) => job.jobName.includes('geckoview')),
        127
    );
    assert.equal(
        rawCount((job) => job.jobName.includes('geckoview') && !isTestJob(job.jobName)),
        0
    );
});

test('isTestJob agrees with the fixture, counted without it', () => {
    assert.equal(
        rawCount((job) => rawIsTest(job.jobName)),
        1683,
        '1,683 of the push\'s jobs name a parseable harness'
    );
    assert.equal(
        PUSH.jobs.filter((job) => isTestJob(job.jobName)).length,
        1683,
        'and the module finds the same 1,683'
    );
    assert.equal(
        rawCount((job) => !rawIsTest(job.jobName)),
        48,
        'the other 48 are builds, lint and the decision task'
    );
});

// --- the status classification --------------------------------------------

test('the failure statuses are the five, and UNEXPECTED-PASS is one of them', () => {
    assert.deepEqual(
        [...FAILURE_STATUSES].sort(),
        ['CRASH', 'ERROR', 'FAIL', 'TIMEOUT', 'UNEXPECTED-PASS'],
        'a fail-if annotation that passed is a thing the push broke'
    );
    // The asymmetry the module comment names, asserted rather than described:
    // an annotation that fired as intended is not a failure.
    assert.equal(isFailureStatus('EXPECTED-FAIL'), false);
    assert.equal(isFailureStatus('PASS'), false);
    assert.equal(isFailureStatus('SKIP'), false);
});

test('the phase suffix is stripped before the verdict is read', () => {
    assert.equal(baseStatus('FAIL-PARALLEL'), 'FAIL');
    assert.equal(baseStatus('TIMEOUT-SEQUENTIAL'), 'TIMEOUT');
    assert.equal(baseStatus('FAIL'), 'FAIL', 'no suffix, unchanged');
    // Anchored at the end, so a status that merely contains the word keeps it.
    assert.equal(baseStatus('FAIL-PARALLEL-EXTRA'), 'FAIL-PARALLEL-EXTRA');

    assert.equal(isFailureStatus('FAIL-PARALLEL'), true);
    assert.equal(isFailureStatus('CRASH-SEQUENTIAL'), true);
    assert.equal(
        isFailureStatus('PASS-PARALLEL'),
        false,
        'stripping a suffix must not turn a pass into a failure'
    );
});

test('a run key pairs the task ID with the job-level retry', () => {
    assert.equal(runKeyOf({ taskId: 'abc', retryId: 0 }), 'abc.0');
    assert.equal(runKeyOf({ taskId: 'abc', retryId: 1 }), 'abc.1');
    // Structural, so a job and a timing key the same way — which is the whole
    // reason the unblamed-jobs pass can match one against the other.
    const job = PUSH.jobs[0]!;
    assert.equal(runKeyOf(job), `${job.taskId}.${job.retryId}`);
});

// --- the selection ---------------------------------------------------------

test('the default universe is the failed test jobs, and nothing else', () => {
    const selection = selectTryJobs(PUSH.jobs, { readPassingJobs: false });

    assert.equal(
        rawCount(
            (job) =>
                job.state === 'completed' &&
                job.result === 'testfailed' &&
                rawIsTest(job.jobName)
        ),
        46,
        'the fixture holds 46 failed test jobs'
    );
    assert.equal(selection.failedTestJobs.length, 46);
    assert.equal(selection.jobsToProcess.length, 46, 'and the default reads exactly those');
    assert.equal(selection.readPassingJobs, false);
});

test('--all-jobs adds the successful test jobs, and only those', () => {
    const widened = selectTryJobs(PUSH.jobs, { readPassingJobs: true });

    assert.equal(
        rawCount(
            (job) =>
                job.state === 'completed' && job.result === 'success' && rawIsTest(job.jobName)
        ),
        1538,
        'the fixture holds 1,538 test jobs that passed'
    );
    assert.equal(widened.successfulTestJobs.length, 1538);
    // Written as the sum rather than as 1,584 so a change to either side of it
    // names which one moved. This is the 34x the flag is opt-in for.
    assert.equal(widened.jobsToProcess.length, 46 + 1538);
    assert.equal(widened.readPassingJobs, true);

    // The order is part of the contract: the jobs that produce rows either way
    // come first, so an interrupted run is still useful.
    assert.deepEqual(
        widened.jobsToProcess.slice(0, 46),
        widened.failedTestJobs,
        'the failed jobs lead'
    );
});

test('the widening does not touch the other three sets', () => {
    const byDefault = selectTryJobs(PUSH.jobs, { readPassingJobs: false });
    const widened = selectTryJobs(PUSH.jobs, { readPassingJobs: true });

    // `--all-jobs` changes what is READ. Everything derived from the push as a
    // whole has to be invariant under it, and the run counts are the one that
    // would do real damage: a test that failed every run it was read in must
    // not become a perma-fail because the passing runs went unread.
    assert.deepEqual(byDefault.failedTestJobs, widened.failedTestJobs);
    assert.deepEqual(byDefault.successfulTestJobs, widened.successfulTestJobs);
    assert.deepEqual(byDefault.otherFailedJobs, widened.otherFailedJobs);
    assert.deepEqual(byDefault.successfulJobNames, widened.successfulJobNames);
    assert.deepEqual(byDefault.runsPerJobName, widened.runsPerJobName);
});

test('a failed test job is not an "other" failure, and a failed build is', () => {
    const selection = selectTryJobs(PUSH.jobs, { readPassingJobs: false });

    // The fixture has none, and that is worth pinning rather than working
    // around: every one of its 48 non-test jobs succeeded, so `otherFailedJobs`
    // being empty here is a property of the push and not of the rule.
    assert.equal(
        rawCount((job) => !rawIsTest(job.jobName) && job.result !== 'success'),
        0,
        'every non-test job on this push passed'
    );
    assert.equal(selection.otherFailedJobs.length, 0);

    // So the rule itself is exercised on a constructed push, where each of the
    // three failed results is present on both sides of the harness line.
    const job = (jobName: string, result: string, state = 'completed'): TreeherderJob => ({
        jobId: 1,
        jobName,
        taskId: `${jobName}-${result}`,
        retryId: 0,
        state,
        result,
    });
    const built = selectTryJobs(
        [
            job('build-linux64/opt', 'busted'),
            job('source-test-mozlint-eslint', 'testfailed'),
            job('test-linux2404-64/opt-reftest-2', 'exception'),
            job('build-win64/opt', 'success'),
            job('build-win32/debug', 'retry'),
            job('test-linux2404-64/debug-xpcshell-3', 'busted'),
        ],
        { readPassingJobs: false }
    );
    assert.deepEqual(
        built.otherFailedJobs.map((j) => j.jobName),
        ['build-linux64/opt', 'source-test-mozlint-eslint', 'test-linux2404-64/opt-reftest-2'],
        'busted, testfailed and exception, on jobs running no parseable harness'
    );
    assert.equal(
        built.otherFailedJobs.some((j) => j.result === 'retry'),
        false,
        'a retried job was superseded by another run of the same task, not a failure'
    );
    assert.equal(
        built.otherFailedJobs.some((j) => j.jobName.includes('xpcshell')),
        false,
        'a busted TEST job is not an "other" failure — it is a test job with no profile'
    );
    assert.equal(built.failedTestJobs.length, 0, 'nor is it a failed test job: it is not testfailed');
    assert.equal(
        built.runsPerJobName.get('test-linux2404-64/debug-xpcshell-3'),
        1,
        'but it did run, so it counts as a run of its configuration'
    );
});

test('run counts cover every completed test job, whatever its result', () => {
    const selection = selectTryJobs(PUSH.jobs, { readPassingJobs: false });

    let total = 0;
    for (const runs of selection.runsPerJobName.values()) {
        total += runs;
    }
    assert.equal(total, 1683, 'the same 1,683 completed test jobs');
    assert.equal(selection.runsPerJobName.size, 1595, 'across 1,595 distinct configurations');

    // The 1,683 is not 46 + 1,538: 83 test jobs ended `exception` and 16
    // `retry`, and they are in neither profile set but ARE runs of their
    // configuration. Counting the denominator off the two arrays instead would
    // lose 99 runs and inflate every "failed 3 of 3 runs" that touches them.
    assert.equal(
        rawCount(
            (job) =>
                job.state === 'completed' && job.result === 'exception' && rawIsTest(job.jobName)
        ),
        83
    );
    assert.equal(
        rawCount(
            (job) =>
                job.state === 'completed' && job.result === 'retry' && rawIsTest(job.jobName)
        ),
        16
    );
    assert.equal(46 + 1538 + 83 + 16, 1683, 'which is where the other 99 went');

    // The configuration that ran most, read off the fixture by hand.
    assert.equal(
        selection.runsPerJobName.get(
            'test-windows11-64-25h2-asan/opt-mochitest-browser-chrome-37'
        ),
        6
    );
});

test('a job that has not completed is in nothing at all', () => {
    // Not exercisable on the fixture — every one of its 1,731 jobs completed —
    // so it is exercised on a constructed push. Without the gate a pending job
    // would be counted as a run of its configuration, which is a denominator
    // for runs that have not happened.
    const running: TreeherderJob = {
        jobId: 1,
        jobName: 'test-linux2404-64/debug-xpcshell-3',
        taskId: 'RUNNING',
        retryId: 0,
        state: 'running',
        result: 'unknown',
    };
    const pending: TreeherderJob = { ...running, taskId: 'PENDING', state: 'pending' };
    const selection = selectTryJobs([running, pending], { readPassingJobs: true });

    assert.equal(selection.failedTestJobs.length, 0);
    assert.equal(selection.successfulTestJobs.length, 0);
    assert.equal(selection.otherFailedJobs.length, 0);
    assert.equal(selection.jobsToProcess.length, 0);
    assert.equal(selection.runsPerJobName.size, 0, 'no denominator from a job that has not run');
});

test('successfulJobNames is the distinct names, not the jobs', () => {
    const selection = selectTryJobs(PUSH.jobs, { readPassingJobs: false });
    assert.equal(selection.successfulTestJobs.length, 1538);
    assert.equal(
        selection.successfulJobNames.size,
        new Set(
            PUSH.jobs
                .filter(
                    (job) =>
                        job.state === 'completed' &&
                        job.result === 'success' &&
                        rawIsTest(job.jobName)
                )
                .map((job) => job.jobName)
        ).size
    );
    assert.equal(selection.successfulJobNames.size, 1507, '1,507 distinct names');
    // Which is the point of the set: 31 of the 1,538 share a name with another
    // successful run, and the intermittency rule asks "did this configuration
    // ever pass", not "how often".
    assert.equal(1538 - 1507, 31);
});

test('the caller keeps its own job objects', () => {
    // The page's `Job` carries a `cleanedSummary` its unblamed-jobs pass
    // attaches afterwards, so the returned arrays have to hold the caller's
    // objects rather than copies of the `TreeherderJob` fields.
    const job = { ...PUSH.jobs.find((j) => j.result === 'testfailed')!, extra: 'kept' };
    const selection = selectTryJobs([job], { readPassingJobs: false });
    assert.equal(selection.failedTestJobs[0], job, 'the same object, by identity');
    assert.equal(selection.failedTestJobs[0]!.extra, 'kept');
});

/**
 * ## The mutation check
 *
 * Both consumers reaching this module is the property the extraction exists
 * for, and it cannot be asserted from inside this file — a test here would only
 * ever prove that this file imports it. It was checked by breaking the module
 * and counting the failures each side's own tests produce. "Page" is
 * `test/try-view.test.ts`, which never invokes the CLI; "CLI" is
 * `test/cli.test.ts` plus `test/framing.test.ts`, neither of which imports
 * anything from `site/`.
 *
 * | mutation | page fails | CLI fails |
 * | --- | --- | --- |
 * | `isTestJob` returns `false` | 4 of 74 | 42 of 178 |
 * | `isTestJob` returns `true` | 1 of 74 | 3 of 178 |
 * | `isFailureStatus` returns `false` | 25 of 74 | 38 of 178 |
 * | `selectTryJobs` ignores `readPassingJobs` | 1 of 74 | 3 of 178 |
 *
 * The last row is the one that found something. Both sides were red on the
 * first three immediately, and the page was **green** on the fourth: nothing in
 * `test/try-view.test.ts` observed the widening. The fixture holds profiles for
 * the failed jobs only, so a wider universe adds no row to assert on, and the
 * test that exists for the checkbox measured the two job sets with its own
 * filters without ever asking the selection for them. It now asserts
 * `jobsToProcess` against those independently-read counts, which is what turns
 * that cell red — the same defect one level down from the one `cde2ebd` fixed,
 * and the reason a mutation check is worth more here than another parity
 * assertion.
 */
