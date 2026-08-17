/**
 * `try.html`'s flakiness column ↔ `fx-tests try`'s `central` column: the same
 * percentage **and** the same explanation, from the same code.
 *
 * ## The number this file exists to pin
 *
 * `fx-tests try` used to compute its own central rate:
 * `(fails + crashes + timeouts) / runs` over the whole 21-day window, every
 * configuration the test runs on anywhere. It printed that next to a `here`
 * column measured on the configurations the push actually ran, so the two cells
 * were populations that do not overlap and the comparison between them was
 * arithmetic. Measured on push `46c757b692be`:
 * `browser_ext_browserAction_disabled.js` ran on one configuration whose own
 * central rate is 42.0%, and the row read `20/41 · central 5.8%` — which reads
 * as an 8x elevation caused by the push.
 *
 * `try.html` already did this correctly, in a way no one should re-derive:
 * `pickHeadlineRate` picks **per configuration, restricted to the ones the push
 * ran**, prefers each config's recent window, falls back to its full history,
 * ranks on `rate - 100/sqrt(runs)` rather than on the raw rate, and falls back
 * to the whole-test rate when no config shows the same failure. Four cases, four
 * different numbers from the same counts — which is why `flakinessTooltip`
 * travels with the rate and why this file asserts on both. A percentage the
 * reader cannot attribute to a measurement is what made the old column
 * misleading, so "same number" alone would be an incomplete assertion here.
 *
 * ## Why the two sides can still diverge, with the code shared
 *
 * They share `lib/query/flakiness-rate.ts`, so `pickHeadlineRate` cannot
 * disagree with itself — but its *inputs* are assembled independently on each
 * side, and that is where the defect was. `site/try-flakiness-worker.ts` calls
 * `computeConfigStats` with `jobNames` **and** `minRecentRuns: MIN_RECENT_RUNS`;
 * the CLI called it with neither. Either omission silently changes the answer
 * rather than failing:
 *
 * - without `jobNames`, every configuration the test runs on anywhere enters the
 *   argmax, so the winner is a platform the push never ran;
 * - without `minRecentRuns`, `lib/`'s default of 20 sizes a different recent
 *   window, so both the rate and `lowConfidence` are measured over a span the
 *   other side never used.
 *
 * So this file drives the **real CLI** (`invoke`, `--json`) against the page's
 * own assembly — `flakinessOfTest`, imported from
 * `site/try-flakiness-worker.ts` — and compares the results. Not two calls to
 * the shared function, which would prove only that it is deterministic, and not
 * a transcription of the worker's option object either: a copy here would make
 * the assertion a one-way ratchet, catching a CLI-side divergence and missing
 * the identical one introduced in the worker.
 *
 * ## The fixture
 *
 * A synthetic push over `test/fixtures/mochitest-00.json`, rather than the
 * pinned `try-7d16bff81bb1.json`: that push's failing tests are spread over 25
 * bucket files and the one test of it that hashes into bucket `00` is absent
 * from the bucket fixture, so it has no central history at all and every rate
 * would be `n/a`. The two tests used here are chosen for what they exercise:
 *
 * | test | what `pickHeadlineRate` does with it |
 * | --- | --- |
 * | `test_peerConnection_simulcastOffer.html` | `scope: 'config'` off a **recent** window, three configs in the argmax, and the winner is not the highest raw rate |
 * | `test_bug551434.html` | the `scope: 'overall'` fallback: its 42 failures carry no message, so no config shows *this* failure |
 *
 * Both fail with statuses that record no message (`TIMEOUT`, `FAIL` with a null
 * `messageId`), which is why the push side sets `matchAnyTimeout`: a timeout
 * matched on kind is the only way the first row reaches its config branch at
 * all, and it is the same option both front-ends pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { TreeherderJob } from '../lib/sources/treeherder.ts';
import { type BucketFile, decodeBucket } from '../lib/formats/buckets.ts';
import { stripChunkSuffix } from '../lib/model/job-name.ts';
import {
    type HeadlineRate,
    flakinessTooltip,
    pickHeadlineRate,
} from '../lib/query/flakiness-rate.ts';
import { flakinessOfTest } from '../site/try-flakiness-worker.ts';
import {
    type PushFixture,
    type PushTiming,
    fakeTreeherder,
    fixtureJson,
    fixtureSource,
    invoke,
    json,
    pushProfileFetcher,
} from './parity-harness.ts';

const BUCKET = decodeBucket(fixtureJson<BucketFile>('mochitest-00.json'));

/** A test of the bucket fixture, and how the synthetic push fails it. */
interface Subject {
    path: string;
    status: string;
    /** Chunk-stripped, as both front-ends pass them. */
    jobNames: string[];
}

/**
 * The two subjects, with the configurations named as literals.
 *
 * Written out rather than read back from the bucket, so the assertions below
 * compare two computations of the same question instead of one computation with
 * itself. The chunk numbers (`-1`) are on purpose: a push's job names carry them
 * and the aggregates do not, and dropping the strip is the mistake that empties
 * every configuration set and sends every row to the overall fallback.
 */
const SUBJECTS: Subject[] = [
    {
        path: 'dom/media/webrtc/tests/mochitests/test_peerConnection_simulcastOffer.html',
        status: 'TIMEOUT',
        jobNames: [
            'test-android-em-14-x86_64-lite/opt-geckoview-mochitest-media-nofis-1',
            'test-android-em-14-x86_64-lite/opt-geckoview-mochitest-media-1',
            'test-android-em-14-x86_64-lite/opt-geckoview-mochitest-media-nogpu-1',
        ],
    },
    {
        path: 'layout/base/tests/chrome/test_bug551434.html',
        status: 'FAIL',
        jobNames: ['test-macosx1500-aarch64-vms/opt-mochitest-chrome-1proc-1'],
    },
];

// =========================================================================
// The synthetic push
// =========================================================================

/**
 * One failing execution per (test, configuration), and one job per execution.
 *
 * Deliberately minimal: nothing here is asserted on except that the CLI ends up
 * asking about these paths on these configurations. A test that failed twice, or
 * a rerun, would change `here` and the section the row lands in without changing
 * anything this file measures.
 */
function syntheticPush(): PushFixture {
    const jobs: TreeherderJob[] = [];
    const timings: PushTiming[] = [];
    let index = 0;
    for (const subject of SUBJECTS) {
        for (const jobName of subject.jobNames) {
            index += 1;
            const taskId = `TASK${index}`;
            jobs.push({
                jobId: index,
                jobName,
                taskId,
                retryId: 0,
                state: 'completed',
                result: 'testfailed',
            });
            timings.push({
                path: subject.path,
                duration: 1,
                status: subject.status,
                timestamp: 0,
                allMessages: [],
                jobName,
                taskId,
                retryId: 0,
            });
        }
    }
    return { push: 'fbfbfbfbfbfb', jobs, timings };
}

const PUSH = syntheticPush();

/** What `--json` carries per row, of the fields this file reads. */
interface CliRow {
    path: string;
    jobNames: string[];
    statuses: string[];
    central: {
        failRate: number | null;
        headline: HeadlineRate;
        explanation: string;
        configsInHistory: number;
    } | null;
}

interface CliTry {
    permaFails: CliRow[];
    knownIntermittents: CliRow[];
    newIntermittents: CliRow[];
}

let cliRows: Map<string, CliRow> | undefined;

/** Every row the CLI emitted, keyed by path. One invocation, many tests. */
async function cli(): Promise<Map<string, CliRow>> {
    if (cliRows === undefined) {
        const result = json<CliTry>(
            await invoke(['try', PUSH.push, '--json'], {
                treeherder: fakeTreeherder(PUSH.jobs, {
                    pushId: 9,
                    revision: PUSH.push,
                    repository: 'try',
                }),
                fetchUrl: pushProfileFetcher(PUSH),
                source: fixtureSource(),
            })
        );
        cliRows = new Map(
            [...result.permaFails, ...result.knownIntermittents, ...result.newIntermittents].map(
                (row) => [row.path, row]
            )
        );
    }
    return cliRows;
}

// =========================================================================
// The page side, assembled as site/try-flakiness-worker.ts assembles it
// =========================================================================

/**
 * What `try.html`'s flakiness cell would show for one subject.
 *
 * `flakinessOfTest` is **imported from the worker**, not transcribed: it is the
 * function `self.onmessage` calls per test, so the `computeConfigStats` options
 * and the `hasMatchingMessage` predicate under test here are the page's own and
 * not this file's idea of them. That matters for what the assertions can catch —
 * a hand-copied option object would make this a one-way ratchet, failing on a
 * CLI-side divergence and passing on the identical divergence introduced in the
 * worker, because the copy would still describe the intended behaviour.
 *
 * Only the last two lines are this file's: `pickHeadlineRate` and
 * `flakinessTooltip` are what `site/try-view.ts`'s `flakinessCell` does with the
 * worker's answer, and calling `flakinessCell` instead would drag in the CSS
 * class and the ⚠️-glyph branch, neither of which the CLI has a counterpart for.
 */
function pageCell(subject: Subject): { headline: HeadlineRate; tooltip: string } {
    const result = flakinessOfTest(BUCKET, {
        path: subject.path,
        tryMessages: [],
        hasTimeout: subject.status === 'TIMEOUT',
        hasCrash: subject.status === 'CRASH',
        jobNames: subject.jobNames.map(stripChunkSuffix),
    });
    assert.equal(result.found, true, `${subject.path} must be in the bucket fixture`);
    const headline = pickHeadlineRate(result.stats!, result.configs);
    return {
        headline,
        tooltip: flakinessTooltip(
            result.stats!,
            result.configs,
            headline,
            result.hasMatchingMessage!,
            result.totalDays
        ),
    };
}

// =========================================================================
// The assertions
// =========================================================================

test('the CLI and the page report the same central rate for every row', async () => {
    const rows = await cli();
    assert.equal(rows.size, SUBJECTS.length, 'every subject produced a row');
    for (const subject of SUBJECTS) {
        const row = rows.get(subject.path);
        assert.notEqual(row, undefined, `${subject.path} has a CLI row`);
        assert.notEqual(row!.central, null, `${subject.path} has central history`);
        // The rate as a number, not as its rendering: the columns round to one
        // decimal and two different measurements can round to the same string.
        assert.equal(
            row!.central!.headline.rate,
            pageCell(subject).headline.rate,
            `${subject.path}: rate`
        );
    }
});

test('and the same explanation of which measurement produced it', async () => {
    const rows = await cli();
    for (const subject of SUBJECTS) {
        // Character for character. The tooltip is the CLI's source for these
        // lines rather than something it paraphrases, so any drift is a second
        // implementation appearing.
        assert.equal(
            rows.get(subject.path)!.central!.explanation,
            pageCell(subject).tooltip,
            `${subject.path}: explanation`
        );
    }
});

test('and the same scope, configuration and run count behind it', async () => {
    const rows = await cli();
    for (const subject of SUBJECTS) {
        // `rate` alone is not the whole answer: `scope` says whether the number
        // is about a configuration or about the test, `jobName` says which
        // configuration, `runs` is its denominator, and `lowConfidence` is the
        // caveat `MIN_RECENT_RUNS` decides. A side that agreed on the percentage
        // and not on these would be measuring something else and rounding to
        // the same place.
        assert.deepEqual(
            rows.get(subject.path)!.central!.headline,
            pageCell(subject).headline,
            `${subject.path}: headline`
        );
    }
});

/**
 * The two branches are both live, and the row that used to be wrong is named.
 *
 * Without this, both subjects could take the overall fallback — which is what
 * happens the moment `jobNames` stops being chunk-stripped — and the three tests
 * above would still pass, comparing two identical wrong answers. So the shape of
 * each answer is pinned as a literal, and the old formula's number is pinned
 * beside the new one for the row where they differ.
 */
test('the config branch and the overall fallback are both exercised', async () => {
    const rows = await cli();
    const [simulcast, bug551434] = SUBJECTS;

    const perConfig = rows.get(simulcast!.path)!.central!;
    assert.equal(perConfig.headline.scope, 'config');
    assert.equal(
        perConfig.headline.jobName,
        'test-android-em-14-x86_64-lite/opt-geckoview-mochitest-media',
        'the argmax winner, chunk-stripped'
    );
    // The three configs' recent same-message rates are 1.0%, 0.96% and 0% over
    // 100, 104 and 105 runs. The winner is the second, not the first: the
    // penalty `100/sqrt(runs)` is larger for the 100-run config than the 0.04
    // points of rate that separate them. That is the lower-bound argmax being
    // load-bearing on real counts rather than on a constructed pair.
    assert.equal(perConfig.headline.runs, 104);
    assert.equal(perConfig.headline.recent, true);
    assert.equal(perConfig.headline.days, 8);
    assert.equal(perConfig.headline.lowConfidence, false);
    // And what the old formula said for the same row. Three timeouts across
    // 8,876 runs, all platforms — 0.03%, which prints as `0.0%` and reads as
    // "central has never seen this". The configuration the push ran fails this
    // way 1.0% of the time.
    assert.equal(perConfig.failRate, (3 / 8876) * 100);
    assert.ok(
        perConfig.headline.rate > perConfig.failRate * 25,
        'the shared logic and the formula it replaced disagree by more than rounding'
    );

    const overall = rows.get(bug551434!.path)!.central!;
    // 42 failures on the one configuration the push ran, and every one of them
    // recorded with no message — so no config shows *this* failure, the 0%
    // winner is discarded, and the column switches to answering "how flaky is
    // this test at all". The tooltip is what says so.
    assert.equal(overall.headline.scope, 'overall');
    assert.equal(overall.configsInHistory, 1);
    assert.match(
        rows.get(bug551434!.path)!.central!.explanation,
        /This exact failure was never seen in history/
    );
});

/**
 * `configsInHistory` is the CLI's own line, and it is a fact rather than a
 * rewording.
 *
 * The tooltip's verdict sentence is asked of the configurations the push ran, so
 * when central never ran the test on any of them the sentence is about an empty
 * population — and printed under a section headed "also fail on central" it
 * reads as a contradiction. `browser_ext_windows_update.js` on push
 * `46c757b692be` is that case: five `test-linux2404-64/*` configurations here,
 * 26 configurations on central, all windows and mac. Both subjects of this file
 * do have their configuration in history, so this asserts the counter is real
 * rather than always zero.
 */
test('the CLI reports how many of the push configurations central has history for', async () => {
    const rows = await cli();
    const [simulcast, bug551434] = SUBJECTS;
    // One per configuration the push ran, because central runs both tests on
    // all of them. Literals: a count derived from the same call it is checking
    // would pass on an empty set as readily as on the right one.
    assert.equal(rows.get(simulcast!.path)!.central!.configsInHistory, 3);
    assert.equal(rows.get(bug551434!.path)!.central!.configsInHistory, 1);
});
