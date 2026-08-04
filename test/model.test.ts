/**
 * The classification layer, tested decision by decision.
 *
 * `PLAN.md` §3 asks that "every question the eight ad-hoc variants answered
 * differently should now be one documented, tested decision". That is what the
 * first group of tests is: each one names the sites that disagreed and asserts
 * the answer this library gives, so changing the answer means editing a test
 * that says why the answer is what it is.
 */

import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeBucket } from '../lib/formats/buckets.ts';
import { decodeDaily } from '../lib/formats/daily.ts';
import { decodeIssues } from '../lib/formats/issues.ts';
import { decodeDeltas, encodeDeltas, forEachDelta } from '../lib/formats/delta.ts';
import type { BucketFile } from '../lib/formats/buckets.ts';
import type { DailyFile } from '../lib/formats/daily.ts';
import type { IssuesFile } from '../lib/formats/issues.ts';
import {
    OBSERVED_STATUSES,
    classifyStatus,
    countsAsRun,
    isFail,
    isFailureLike,
    isPass,
    isSkip,
    passRateNumerator,
    splitExecutionMode,
} from '../lib/model/status.ts';
import {
    countRerunsByTask,
    executionModeOf,
    hasModeAxis,
    modeBreakdown,
    passedOnRerun,
} from '../lib/model/execution.ts';
import {
    chunkNumber,
    operatingSystem,
    parseJobName,
    sameConfiguration,
    stripChunkSuffix,
} from '../lib/model/job-name.ts';
import {
    countSkips,
    countsAsSkip,
    displaySkipMessage,
    skipMessageCounts,
    skipReason,
} from '../lib/model/skips.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

async function fixture<T>(name: string): Promise<T> {
    return JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8')) as T;
}

const xpcshellBucket = await fixture<BucketFile>('xpcshell-00.json');
const mochitestBucket = await fixture<BucketFile>('mochitest-00.json');
const xpcshellIssues = await fixture<IssuesFile>('xpcshell-issues.json');
const xpcshellDaily = await fixture<DailyFile>('xpcshell-2026-08-03.json');

// --- the taxonomy's decisions -------------------------------------------

test('every observed status classifies to exactly one kind and mode', () => {
    // The twelve strings `FORMATS.md` found across 854,914,907 runs. Written
    // out rather than derived, so that a change to the classifier has to
    // change a table someone can read.
    const expected: Record<string, [string, string | null]> = {
        PASS: ['pass', null],
        'PASS-PARALLEL': ['pass', 'parallel'],
        'PASS-SEQUENTIAL': ['pass', 'sequential'],
        FAIL: ['fail', null],
        'FAIL-PARALLEL': ['fail', 'parallel'],
        'FAIL-SEQUENTIAL': ['fail', 'sequential'],
        TIMEOUT: ['timeout', null],
        'TIMEOUT-PARALLEL': ['timeout', 'parallel'],
        'TIMEOUT-SEQUENTIAL': ['timeout', 'sequential'],
        CRASH: ['crash', null],
        SKIP: ['skip', null],
        'EXPECTED-FAIL': ['expected-fail', null],
    };
    assert.deepEqual(OBSERVED_STATUSES.slice().sort(), Object.keys(expected).sort());
    for (const [status, [kind, mode]] of Object.entries(expected)) {
        const classified = classifyStatus(status);
        assert.equal(classified.kind, kind, `${status} kind`);
        assert.equal(classified.mode, mode, `${status} mode`);
        assert.equal(classified.raw, status);
    }
});

test('CRASH is its own kind, and aggregating it into failures is the caller’s', () => {
    // The one live disagreement (`PLAN.md` §1): `issues.html:1350` and
    // `xpcshell-timings.html:656` fold crashes into failures, the other six
    // sites count them separately. The library reports the parts, because a
    // caller can take the union and cannot take it apart.
    assert.equal(classifyStatus('CRASH').kind, 'crash');
    assert.equal(isFail('crash'), false, 'crash is not fail');
    assert.equal(isFailureLike('crash'), true, 'but it is failure-like');
    assert.equal(isFailureLike('fail'), true);
    assert.equal(isFailureLike('timeout'), true);
    // Not failure-like: the test behaved as annotated, and no outcome at all.
    assert.equal(isFailureLike('expected-fail'), false);
    assert.equal(isFailureLike('unknown'), false);
    assert.equal(isFailureLike('pass'), false);
    assert.equal(isFailureLike('skip'), false);
});

test('UNKNOWN is its own kind and is never folded into pass or fail', () => {
    // `issues.html:1024` and `xpcshell-timings.html:684` guess an UNKNOWN run
    // into a pass from its duration, which inflates a pass rate.
    // `common-test-data.js:323` ignores it. `test.html:1897` skips it. This
    // library counts it, separately, so a returning UNKNOWN becomes visible.
    const classified = classifyStatus('UNKNOWN');
    assert.equal(classified.kind, 'unknown');
    assert.equal(isPass('unknown'), false);
    assert.equal(isFail('unknown'), false);
    assert.equal(isFailureLike('unknown'), false);
    // And it stays out of a pass rate's denominator, so it cannot depress a
    // rate it can never contribute to.
    assert.equal(countsAsRun('unknown'), false);
    assert.equal(passRateNumerator('unknown'), false);
});

test('an unrecognized status classifies as unknown rather than throwing', () => {
    // A shape this library does not understand is a decoding failure and must
    // throw. A *status* it does not understand is one run whose outcome is not
    // understood, and taking a whole query down over it would be worse than
    // reporting it.
    for (const status of ['NOTARUN', 'PASS-TRIPLE', '', 'pass']) {
        assert.equal(classifyStatus(status).kind, 'unknown', status);
        assert.equal(classifyStatus(status).raw, status);
    }
    // Case matters: the files are uppercase, and quietly accepting lowercase
    // would hide a caller passing a display string.
    assert.equal(classifyStatus('pass').kind, 'unknown');
});

test('EXPECTED-FAIL is neither a pass nor a failure', () => {
    // `common-test-data.js:155` treats it as a pass and `computeTestStats()`
    // excludes it from `isFail` without giving it anywhere else to go, so both
    // effectively count it as a pass. Naming it is what lets a caller choose.
    assert.equal(classifyStatus('EXPECTED-FAIL').kind, 'expected-fail');
    assert.equal(isPass('expected-fail'), false);
    assert.equal(isFail('expected-fail'), false);
    assert.equal(isFailureLike('expected-fail'), false);
    // It did run and it behaved as annotated, so it is in both halves of a
    // "did CI behave as expected" rate.
    assert.equal(countsAsRun('expected-fail'), true);
    assert.equal(passRateNumerator('expected-fail'), true);
});

test('skips are excluded from a pass rate’s denominator', () => {
    assert.equal(isSkip('skip'), true);
    assert.equal(countsAsRun('skip'), false);
    assert.equal(countsAsRun('pass'), true);
    assert.equal(countsAsRun('fail'), true);
    assert.equal(countsAsRun('timeout'), true);
    assert.equal(countsAsRun('crash'), true);
});

test('the execution-mode suffix splits without eating EXPECTED-FAIL’s dash', () => {
    // The reason this cannot be "split on the last dash": `EXPECTED-FAIL`
    // contains one, and only the two known suffixes are suffixes.
    assert.deepEqual(splitExecutionMode('EXPECTED-FAIL'), {
        base: 'EXPECTED-FAIL',
        mode: null,
    });
    assert.deepEqual(splitExecutionMode('FAIL-PARALLEL'), { base: 'FAIL', mode: 'parallel' });
    assert.deepEqual(splitExecutionMode('TIMEOUT-SEQUENTIAL'), {
        base: 'TIMEOUT',
        mode: 'sequential',
    });
    assert.deepEqual(splitExecutionMode('CRASH'), { base: 'CRASH', mode: null });
});

// --- execution modes -----------------------------------------------------

test('plain PASS is its own bucket, not the sum of the two modes', () => {
    // The measured fact that forces three states: on xpcshell, plain `PASS`
    // coexists with `PASS-PARALLEL` and `PASS-SEQUENTIAL` in the same file.
    // The bucket fixture has 2,196 plain, 120,814 parallel and 9,218
    // sequential, and 2196 is not 120814 + 9218 — so a decomposition that
    // treated "no suffix" as a default of one mode would double-count.
    const file = decodeBucket(xpcshellBucket);
    const runs: [string, number][] = [];
    for (let testId = 0; testId < file.testCount; testId++) {
        for (const [status, count] of file.totalsByStatus(testId)) {
            if (classifyStatus(status).kind === 'pass') {
                runs.push([status, count]);
            }
        }
    }
    const breakdown = modeBreakdown(runs);
    assert.deepEqual(breakdown, { parallel: 120814, sequential: 9218, unrecorded: 2196 });
    assert.notEqual(
        breakdown.unrecorded,
        breakdown.parallel + breakdown.sequential,
        'plain PASS is not the sum of the two suffixed ones'
    );
});

test('mochitest has no mode axis at all, and that is detectable', () => {
    // `fx-tests test --executions` on a mochitest test should say the axis
    // does not apply rather than print a one-row table. `hasModeAxis()` reads
    // that off the data instead of hardcoding `harness === 'xpcshell'`, which
    // would go stale if mochitest ever started recording it.
    assert.equal(hasModeAxis(mochitestBucket.tables.statuses), false);
    assert.equal(hasModeAxis(xpcshellBucket.tables.statuses), true);
    assert.equal(hasModeAxis(xpcshellIssues.tables.statuses), true);

    const file = decodeBucket(mochitestBucket);
    const runs: [string, number][] = [];
    for (let testId = 0; testId < file.testCount; testId++) {
        runs.push(...file.totalsByStatus(testId));
    }
    const breakdown = modeBreakdown(runs);
    assert.equal(breakdown.parallel, 0);
    assert.equal(breakdown.sequential, 0);
    // Everything mochitest records lands in `unrecorded`, which is right: the
    // mode was not recorded, rather than being one value throughout.
    assert.ok(breakdown.unrecorded > 0);
});

test('"mode not recorded" is a state, not a missing value', () => {
    assert.equal(executionModeOf('PASS'), 'unrecorded');
    assert.equal(executionModeOf('PASS-PARALLEL'), 'parallel');
    assert.equal(executionModeOf('PASS-SEQUENTIAL'), 'sequential');
    assert.equal(executionModeOf('CRASH'), 'unrecorded');
    // The three always sum to the total, which is the property that makes
    // `unrecorded` safe to display alongside the other two.
    const breakdown = modeBreakdown([
        ['PASS', 5],
        ['PASS-PARALLEL', 3],
        ['PASS-SEQUENTIAL', 2],
    ]);
    assert.equal(breakdown.parallel + breakdown.sequential + breakdown.unrecorded, 10);
});

test('a repeated task ID within one bucket is a harness rerun', () => {
    // The only rerun signal the published aggregates carry: the same
    // `${taskId}.${retryId}` twice in one (day, message) bucket means that job
    // saw the status twice, which within a job is a rerun.
    const counts = countRerunsByTask([
        { day: 0, count: 3, index: 0, taskIds: ['A.0', 'A.0', 'B.0'] },
        { day: 1, count: 1, index: 1, taskIds: ['C.0'] },
    ]);
    assert.deepEqual(counts, { jobs: 3, runs: 4, jobsWithRerun: 1 });

    // Shapes that discarded attribution contribute nothing rather than
    // guessing. This is the distinction between "no reruns" and "cannot tell",
    // and the caller sees it as `jobs === 0`.
    assert.deepEqual(countRerunsByTask([{ day: 0, count: 9, index: 0 }]), {
        jobs: 0,
        runs: 0,
        jobsWithRerun: 0,
    });
});

test('reruns are counted on real data without claiming an order', () => {
    const file = decodeBucket(xpcshellBucket);
    const failures = [];
    for (let testId = 0; testId < file.testCount; testId++) {
        for (const entry of file.runsOfTest(testId)) {
            if (classifyStatus(entry.status).kind === 'fail') {
                failures.push(entry);
            }
        }
    }
    const counts = countRerunsByTask(failures);
    assert.equal(counts.runs, 36, 'the bucket fixture has 27+7+2 failing runs');
    assert.ok(counts.jobs <= counts.runs);
    assert.ok(counts.jobsWithRerun <= counts.jobs);
});

test('passing and failing in the same job is the passed-on-rerun signal', () => {
    assert.deepEqual([...passedOnRerun(['A.0', 'B.0'], ['A.0', 'C.0'])], ['A.0']);
    assert.deepEqual([...passedOnRerun(['A.0'], ['B.1'])], []);
    // The job-level retry axis is kept distinct: `A.0` and `A.1` are two
    // different jobs, not one job rerunning a test.
    assert.deepEqual([...passedOnRerun(['A.0'], ['A.1'])], []);
});

// --- job names -----------------------------------------------------------

test('chunk stripping is anchored after the build-type separator', () => {
    assert.equal(
        stripChunkSuffix('test-linux2404-64-ccov/opt-xpcshell-23'),
        'test-linux2404-64-ccov/opt-xpcshell'
    );
    // Variant suffixes that are not numbers name real configurations and stay.
    assert.equal(
        stripChunkSuffix('test-linux2404-64-asan/opt-mochitest-plain-nofis'),
        'test-linux2404-64-asan/opt-mochitest-plain-nofis'
    );
    assert.equal(
        stripChunkSuffix('test-linux2404-64-ccov/opt-xpcshell-nofis-3'),
        'test-linux2404-64-ccov/opt-xpcshell-nofis'
    );
    // The reason for anchoring after the `/`: a platform can end in digits,
    // and `common-test-data.js:80`'s unanchored `/-\d+$/` would eat part of
    // one if a name ever lacked the suite half.
    assert.equal(stripChunkSuffix('test-windows11-32-25h2'), 'test-windows11-32-25h2');
    assert.equal(stripChunkSuffix('test-linux2404-64'), 'test-linux2404-64');
});

test('the two chunk-stripping rules agree on every job name in the fixtures', () => {
    // Measured, so the claim above is a narrowing of when the rule applies and
    // not a change of answer: on all 414 distinct job names the fixtures carry,
    // the anchored rule and `common-test-data.js:80`'s unanchored one produce
    // the same string.
    const names = new Set<string>();
    for (const file of [xpcshellBucket, mochitestBucket, xpcshellDaily]) {
        for (const name of file.tables.jobNames) {
            names.add(name);
        }
    }
    assert.ok(names.size > 100, `only ${names.size} distinct job names`);
    for (const name of names) {
        assert.equal(
            stripChunkSuffix(name),
            name.replace(/-\d+$/, ''),
            `the two rules disagree on ${name}`
        );
    }
});

test('chunk numbers come back out', () => {
    assert.equal(chunkNumber('test-linux2404-64-ccov/opt-xpcshell-23'), 23);
    assert.equal(chunkNumber('test-linux2404-64-ccov/opt-xpcshell'), null);
    assert.equal(chunkNumber('test-linux2404-64'), null);
});

test('job names split into platform, build type and suite', () => {
    assert.deepEqual(parseJobName('test-linux2404-64-ccov/opt-xpcshell-23'), {
        raw: 'test-linux2404-64-ccov/opt-xpcshell-23',
        configuration: 'test-linux2404-64-ccov/opt-xpcshell',
        kind: 'test',
        platform: 'linux2404-64-ccov',
        os: 'linux',
        buildType: 'opt',
        suite: 'xpcshell',
        chunk: 23,
    });
    assert.deepEqual(parseJobName('test-android-em-14-x86_64/debug-geckoview-xpcshell-3'), {
        raw: 'test-android-em-14-x86_64/debug-geckoview-xpcshell-3',
        configuration: 'test-android-em-14-x86_64/debug-geckoview-xpcshell',
        kind: 'test',
        platform: 'android-em-14-x86_64',
        os: 'android',
        buildType: 'debug',
        suite: 'geckoview-xpcshell',
        chunk: 3,
    });
});

test('an unparseable job name reports nulls rather than the word "unknown"', () => {
    // `shared.js:71` returns the literal string `'unknown'`, which then shows
    // up in output as though it were a platform. A null is a value a caller
    // has to decide what to do with, which is the point.
    const parsed = parseJobName('something-odd');
    assert.equal(parsed.platform, null);
    assert.equal(parsed.os, null);
    assert.equal(parsed.buildType, null);
    assert.equal(parsed.suite, null);
    assert.equal(parsed.configuration, 'something-odd');
});

test('operating systems are recognized from real platform strings', () => {
    assert.equal(operatingSystem('linux2404-64-ccov'), 'linux');
    assert.equal(operatingSystem('windows11-64-25h2'), 'windows');
    assert.equal(operatingSystem('windows11-32-25h2-shippable'), 'windows');
    assert.equal(operatingSystem('macosx1500-aarch64'), 'mac');
    assert.equal(operatingSystem('macosx1015-64-qr'), 'mac');
    // Android is checked before the others because its platform strings do not
    // name an OS the other branches would recognize.
    assert.equal(operatingSystem('android-em-14-x86_64-lite'), 'android');
    assert.equal(operatingSystem('android-hw-a55-14-0-aarch64'), 'android');
    assert.equal(operatingSystem('something-else'), null);
});

test('every job name in the fixtures parses to a known OS', () => {
    // If this fails, either the platform naming changed or the OS detection is
    // wrong — both worth knowing, and neither visible from unit tests on
    // hand-written strings.
    for (const file of [xpcshellBucket, mochitestBucket, xpcshellDaily]) {
        for (const name of file.tables.jobNames) {
            const parsed = parseJobName(name);
            assert.notEqual(parsed.os, null, `${name} has no recognized OS`);
            assert.ok(
                parsed.buildType === 'opt' || parsed.buildType === 'debug',
                `${name} has build type ${parsed.buildType}`
            );
        }
    }
});

test('chunks of one configuration compare equal', () => {
    assert.equal(
        sameConfiguration(
            'test-linux2404-64-ccov/opt-xpcshell-1',
            'test-linux2404-64-ccov/opt-xpcshell-23'
        ),
        true
    );
    assert.equal(
        sameConfiguration(
            'test-linux2404-64-ccov/opt-xpcshell-1',
            'test-linux2404-64-ccov/opt-xpcshell-nofis-1'
        ),
        false
    );
});

// --- skips ---------------------------------------------------------------

test('run-if is not a skip, skip-if is, and no message counts', () => {
    // The behaviour all eight sites share, made explicit. `msg?.startsWith` is
    // `undefined` for a null message, which is falsy, so every site counts a
    // no-message skip by falling through rather than by deciding to.
    assert.equal(skipReason("run-if: os == 'android'"), 'run-if');
    assert.equal(skipReason('skip-if: tsan'), 'skip-if');
    assert.equal(skipReason(null), 'unrecorded');
    assert.equal(skipReason(undefined), 'unrecorded');
    assert.equal(skipReason('disabled for bug 1234'), 'other');

    assert.equal(countsAsSkip("run-if: os == 'android'"), false);
    assert.equal(countsAsSkip('skip-if: tsan'), true);
    assert.equal(countsAsSkip(null), true, 'a skip with no reason is still a skip');
    assert.equal(countsAsSkip(undefined), true);
    assert.equal(countsAsSkip('disabled for bug 1234'), true);
});

test('skips are counted in runs, not in entries', () => {
    // The structural divergence `PLAN.md` §1 identifies:
    // `common-test-data.js:303` and `xpcshell-timings.html:666` add 1 per
    // `messageIds` entry, while `perma-fails.html:504` and `test.html:2637`
    // add `getCountAtIndex(...)`. They agree only when every count is 1.
    //
    // An entry in a `counts` group is a *bucket* of runs, so counting it as
    // one answers "how many distinct (day, job, message) buckets" while
    // claiming to answer "how many runs were skipped". This library counts
    // runs, which is what the label says.
    const counts = countSkips([
        { day: 0, count: 100, index: 0, message: 'skip-if: tsan' },
        { day: 1, count: 50, index: 1, message: null },
        { day: 2, count: 25, index: 2, message: "run-if: os == 'android'" },
    ]);
    assert.deepEqual(counts, { skipped: 150, runIf: 25, unrecorded: 50 });
    // The per-entry rule would have said 2 here, against 150.
});

test('the two skip-counting rules differ by 94x on a real file', () => {
    // Not a hypothetical. `xpcshell-issues.json` has 189 SKIP entries
    // totalling 17,787 runs, so the per-entry rule undercounts by 94x. The
    // bucket file is 1,538 entries against 11,444 runs.
    for (const [file, entries, runs] of [
        [decodeIssues(xpcshellIssues), 189, 17787],
        [decodeBucket(xpcshellBucket), 1538, 11444],
    ] as const) {
        let entryCount = 0;
        let runCount = 0;
        for (let testId = 0; testId < file.testCount; testId++) {
            for (const entry of file.runsOfTest(testId)) {
                if (entry.status !== 'SKIP') {
                    continue;
                }
                entryCount += 1;
                runCount += entry.count;
            }
        }
        assert.equal(entryCount, entries);
        assert.equal(runCount, runs);
    }
});

test('run-if skips are excluded from the daily file’s reportable count', () => {
    // The aggregates have this filter applied upstream; a daily file does not,
    // so this is where the filter earns its keep. 2,912 raw skips become 765.
    const file = decodeDaily(xpcshellDaily);
    const entries = [];
    for (let testId = 0; testId < file.testCount; testId++) {
        for (const entry of file.runsOfTest(testId)) {
            if (entry.status === 'SKIP') {
                entries.push(entry);
            }
        }
    }
    const counts = countSkips(entries);
    assert.equal(counts.skipped, 765);
    assert.equal(counts.runIf, 2147);
    assert.equal(counts.skipped + counts.runIf, 2912, 'and nothing is lost between them');
});

test('skip messages are grouped by their display form', () => {
    const byMessage = skipMessageCounts([
        { day: 0, count: 10, index: 0, message: 'skip-if: tsan' },
        { day: 1, count: 5, index: 1, message: 'skip-if:  tsan' },
        { day: 2, count: 3, index: 2, message: null },
        { day: 3, count: 7, index: 3, message: 'run-if: os == "linux"' },
    ]);
    // The two `skip-if` forms differ only in whitespace after the prefix, so
    // they are the same reason and group together.
    assert.equal(byMessage.get('tsan'), 15);
    // No message is grouped under `null` rather than under an invented label.
    assert.equal(byMessage.get(null), 3);
    assert.equal(byMessage.has('os == "linux"'), false, 'run-if is excluded');
});

test('the skip-if prefix is stripped for display', () => {
    assert.equal(displaySkipMessage('skip-if: os == "win"'), 'os == "win"');
    assert.equal(displaySkipMessage('skip-if:os == "win"'), 'os == "win"');
    assert.equal(displaySkipMessage('disabled for bug 1234'), 'disabled for bug 1234');
});

// --- delta round-tripping ------------------------------------------------

test('delta decoding round-trips, for any base and any values', () => {
    // `PLAN.md` §3 asks for a property test on delta round-tripping. A small
    // deterministic PRNG rather than a dependency: reproducible, and a failing
    // seed is printed with the failure.
    let seed = 0x2026_0803;
    const random = (n: number): number => {
        // xorshift32, so a failure is reproducible from the seed above.
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        seed |= 0;
        return Math.abs(seed) % n;
    };

    for (let trial = 0; trial < 500; trial++) {
        const length = random(40);
        const base = random(2000) - 1000;
        const values: number[] = [];
        let current = base;
        for (let i = 0; i < length; i++) {
            // Non-decreasing, as every delta-encoded field in these files is:
            // days count up, timestamps count up, start times count up.
            current += random(100);
            values.push(current);
        }
        const deltas = encodeDeltas(values, base);
        assert.deepEqual(decodeDeltas(deltas, base), values, `trial ${trial}`);
        assert.ok(
            deltas.every((d) => d >= 0),
            'a non-decreasing series encodes to non-negative deltas'
        );
    }
});

test('delta decoding handles the edges', () => {
    assert.deepEqual(decodeDeltas([], 0), []);
    assert.deepEqual(decodeDeltas([], 99), []);
    assert.deepEqual(encodeDeltas([], 0), []);
    // Day arrays start at day 0 with a leading delta of 0, which is the most
    // common single case in the files.
    assert.deepEqual(decodeDeltas([0, 0, 1, 0]), [0, 0, 1, 1]);
    // A base offsets the whole series, which is how timestamps work.
    assert.deepEqual(decodeDeltas([5, 10], 1000), [1005, 1015]);
    assert.deepEqual(encodeDeltas([1005, 1015], 1000), [5, 10]);
});

test('forEachDelta agrees with decodeDeltas', () => {
    // The two exist because one allocates and one does not; if they ever
    // disagreed, the fast path would be silently wrong wherever it is used.
    const deltas = [0, 3, 0, 7, 1];
    for (const base of [0, -5, 1_783_987_200]) {
        const seen: number[] = [];
        forEachDelta(deltas, base, (value) => seen.push(value));
        assert.deepEqual(seen, decodeDeltas(deltas, base));
    }
});

test('the fixtures’ day arrays decode inside their declared range', () => {
    // The encoding's real invariant, checked against real data rather than
    // generated data: every decoded day is in `0..days-1`, and the arrays are
    // non-decreasing because the deltas are non-negative.
    for (const [name, file] of [
        ['xpcshell-00.json', decodeBucket(xpcshellBucket)],
        ['mochitest-00.json', decodeBucket(mochitestBucket)],
        ['xpcshell-issues.json', decodeIssues(xpcshellIssues)],
    ] as const) {
        const days = file.days!;
        assert.equal(days, 21);
        const seen = new Set<number>();
        for (let testId = 0; testId < file.testCount; testId++) {
            let previous = -1;
            let previousStatus = '';
            for (const entry of file.runsOfTest(testId)) {
                if (entry.status !== previousStatus) {
                    previousStatus = entry.status;
                    previous = -1;
                }
                assert.ok(entry.day !== null);
                assert.ok(entry.day >= 0 && entry.day < days, `${name}: day ${entry.day}`);
                assert.ok(entry.day >= previous, `${name}: days went backwards`);
                previous = entry.day;
                seen.add(entry.day);
            }
        }
        // Day 0 is the oldest and day 20 the newest, so both ends being
        // present is what shows the accumulation runs the right way.
        assert.ok(seen.has(0), `${name} covers day 0`);
        assert.ok(seen.has(days - 1), `${name} covers day ${days - 1}`);
    }
});
