/**
 * New page vs CLI for `try`: `site/try.html?rev=…` ↔ `fx-tests try <rev>`.
 *
 * `PARITY.md` §5, and the sequencing step §6.4 asks for "per page, as each
 * lands". Both sides are driven over the **same pinned push**
 * (`test/fixtures/try-7d16bff81bb1.json`) and compared on the three classes
 * §1 names: values, order, framing.
 *
 * ## Why this is not `test/framing.test.ts`
 *
 * That file asserts **CLI vs the old page**, and its page column is a *source
 * audit* — facts read off `try.html` with a `file:line` citation each. It
 * cannot execute the page, so it can say "`try.html:1749` sorts on
 * `instances.length`" but not "the two produce the same 26 rows in the same
 * order".
 *
 * This file complements it rather than extending it, and the reason is that
 * they cannot share a table: framing.test.ts's page side is *read*, this one's
 * is *run*. Merging them would put a literal transcribed from a line number
 * next to a value computed at test time and give the reader no way to tell
 * which kind of claim a failure was. The two do overlap deliberately in one
 * place — the tie-break divergence is declared in both — because it is the one
 * that has to stay declared no matter which side is compared.
 *
 * ## What each side is
 *
 * - **Page**: `site/try-view.ts`'s `aggregateFailures` / `sortTests` /
 *   `splitTables`, driven exactly as `site/try.ts` drives them. Same setup as
 *   `test/try-view.test.ts`, which is why that file's helpers are followed
 *   rather than re-derived.
 * - **CLI**: a real `run()` invocation with a fake Treeherder client and
 *   synthesized profiles (`test/parity-harness.ts`). Offline, no browser.
 *
 * The synthesis is the one construction worth being suspicious of, so it is
 * checked before anything is claimed from it: the first test below re-parses
 * every synthesized profile through the CLI's own `parseTestMarkers` and
 * compares the result to the fixture's timings field by field. 178 of the
 * push's 180 timings come back identical, and the two that do not are the two
 * divergences declared at the bottom of this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { TreeherderJob } from '../lib/sources/treeherder.ts';
import { parseTestMarkers } from '../cli/commands/try.ts';
import {
    type FailingTest,
    type Timing,
    aggregateFailures,
    extractBuildTypes,
    extractPlatform,
    initialSort,
    isTestJob,
    sortTests,
    splitTables,
    tagIntermittent,
} from '../site/try-view.ts';
import {
    type Divergence,
    type PushFixture,
    assertDeclaredDivergences,
    assertSameOrder,
    fakeTreeherder,
    fixtureJson,
    fixtureSource,
    invoke,
    json,
    pushProfileFetcher,
    runKey,
    synthProfile,
    timingsByRun,
} from './parity-harness.ts';

const PUSH = fixtureJson<PushFixture>('try-7d16bff81bb1.json');

// =========================================================================
// The page side, driven as site/try.ts drives it
// =========================================================================

const FAILED_TEST_JOBS = PUSH.jobs.filter(
    (job) => job.state === 'completed' && job.result === 'testfailed' && isTestJob(job.jobName)
);
const SUCCESSFUL_TEST_JOBS = PUSH.jobs.filter(
    (job) => job.state === 'completed' && job.result === 'success' && isTestJob(job.jobName)
);

/** The page's failure aggregation over the pinned push. */
function pageFailures(): ReturnType<typeof aggregateFailures> {
    // `tagIntermittent` mutates, so it gets its own copies.
    const timings = PUSH.timings.map((timing) => ({ ...timing })) as unknown as Timing[];
    tagIntermittent(timings, {
        jobsToProcess: FAILED_TEST_JOBS,
        successfulJobNames: new Set(SUCCESSFUL_TEST_JOBS.map((job) => job.jobName)),
    });

    const globalPlatforms = new Set<string>();
    const globalBuildTypes = new Set<string>();
    for (const job of FAILED_TEST_JOBS) {
        globalPlatforms.add(extractPlatform(job.jobName));
        for (const buildType of extractBuildTypes(job.jobName)) {
            globalBuildTypes.add(buildType);
        }
    }
    const jobRunCounts = new Map<string, number>();
    for (const job of PUSH.jobs) {
        if (job.state === 'completed' && isTestJob(job.jobName)) {
            jobRunCounts.set(job.jobName, (jobRunCounts.get(job.jobName) ?? 0) + 1);
        }
    }
    return aggregateFailures(timings, { globalPlatforms, globalBuildTypes, jobRunCounts });
}

const PAGE = pageFailures();

/** The page's default table order: `sortTests` on `initialSort()`. */
const PAGE_ORDER: readonly FailingTest[] = sortTests(PAGE.tests, initialSort(), () => null);

// =========================================================================
// The CLI side, one real invocation
// =========================================================================

/** One row of the CLI's `--json`. */
interface CliFailure {
    path: string;
    jobNames: string[];
    failureCount: number;
    failedRuns: number;
    totalRuns: number;
    everyRunFailed: boolean;
    statuses: string[];
    messages: string[];
}

interface CliTry {
    pushId: number;
    jobCount: number;
    failedJobCount: number;
    unblamedJobCount: number;
    permaFails: CliFailure[];
    knownIntermittents: CliFailure[];
    newIntermittents: CliFailure[];
}

/** Runs `fx-tests try` over the pinned push. Cached: one invocation, many tests. */
let cliResult: CliTry | undefined;
async function cli(): Promise<CliTry> {
    if (cliResult === undefined) {
        cliResult = json<CliTry>(
            await invoke(['try', '7d16bff81bb1', '--json'], {
                treeherder: fakeTreeherder(PUSH.jobs),
                fetchUrl: pushProfileFetcher(PUSH),
                source: fixtureSource(),
            })
        );
    }
    return cliResult;
}

/** Every CLI row, in the order the command emitted them across its sections. */
function cliRows(result: CliTry): CliFailure[] {
    return [...result.permaFails, ...result.knownIntermittents, ...result.newIntermittents];
}

/**
 * The CLI's single ranked sequence, **merged from the emitted order**.
 *
 * The command splits its output into three sections, each already in the order
 * the command produced, so concatenating them is not the whole-population
 * ranking — a low-count perma-fail precedes a high-count intermittent. Merging
 * them is what makes the page's single table comparable.
 *
 * A *merge*, deliberately, and not a re-sort. An earlier draft called
 * `.sort(comparator)` here, and it was wrong for a reason worth recording: a
 * mutation flipping the command's comparator to ascending left this test green,
 * because re-sorting threw away the very sequence under test and replaced it
 * with one this file had computed. That is `PARITY.md` §1's failure mode inside
 * the parity harness itself — the test deriving its expected value from
 * something other than what the command emitted.
 *
 * So each section is taken in its emitted order, asserted to be descending on
 * its own, and the three are then merged by repeatedly taking whichever section
 * head ranks first. The merge preserves each section's order rather than
 * imposing one, so a section emitted backwards comes out backwards and fails.
 */
function cliRanked(result: CliTry): CliFailure[] {
    const sections = [result.permaFails, result.knownIntermittents, result.newIntermittents].map(
        (section) => [...section]
    );
    for (const section of sections) {
        for (let i = 1; i < section.length; i++) {
            assert.ok(
                section[i - 1]!.failureCount >= section[i]!.failureCount,
                `a CLI section is not emitted count-descending: ${section[i - 1]!.path} ` +
                    `(${section[i - 1]!.failureCount}) then ${section[i]!.path} ` +
                    `(${section[i]!.failureCount})`
            );
        }
    }

    const merged: CliFailure[] = [];
    for (;;) {
        let best = -1;
        for (const [index, section] of sections.entries()) {
            const head = section[0];
            if (head === undefined) {
                continue;
            }
            const incumbent = best === -1 ? undefined : sections[best]![0];
            if (
                incumbent === undefined ||
                head.failureCount > incumbent.failureCount ||
                (head.failureCount === incumbent.failureCount &&
                    head.path.localeCompare(incumbent.path) < 0)
            ) {
                best = index;
            }
        }
        if (best === -1) {
            return merged;
        }
        merged.push(sections[best]!.shift()!);
    }
}

// =========================================================================
// The synthesis is what it claims to be
// =========================================================================

test('the synthesized profiles re-parse to the pinned push, bar the two divergences', async () => {
    // Checked before any parity claim rests on it. The fixture holds the page
    // worker's *output*; `synthProfile` rebuilds a marker stream from it and
    // this re-parses that stream with the CLI's parser. If the reconstruction
    // drifted — a message landing on the wrong marker, a retry range covering
    // the wrong executions — every comparison below would be of two things
    // neither side would produce, and this is what says it did not.
    const byRun = timingsByRun(PUSH);
    const jobByRun = new Map<string, TreeherderJob>(PUSH.jobs.map((job) => [runKey(job), job]));

    const reparsed: { path: string; status: string; run: string; rerun: boolean; message: string }[] =
        [];
    for (const [key, timings] of byRun) {
        const job = jobByRun.get(key);
        assert.ok(job !== undefined, `no job for run ${key}`);
        for (const timing of parseTestMarkers(synthProfile(timings), job)) {
            reparsed.push({
                path: timing.path,
                status: timing.status,
                run: runKey(timing),
                rerun: timing.isRerun,
                message: timing.message ?? '',
            });
        }
    }

    // The page side, read straight off the fixture — not through
    // `site/try-view.ts`, so the two paths are genuinely independent.
    const pageSide = PUSH.timings.map((timing) => ({
        path: timing.path,
        status: timing.status,
        run: runKey(timing),
        rerun: timing.isRetry === true,
        message: timing.allMessages[0]?.message ?? timing.message ?? '',
    }));

    const encode = (entry: { path: string; status: string; run: string; rerun: boolean; message: string }): string =>
        `${entry.path}|${entry.status}|${entry.run}|${entry.rerun}|${entry.message}`;
    const remaining = new Map<string, number>();
    for (const entry of pageSide) {
        const key = encode(entry);
        remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    const cliOnly: string[] = [];
    for (const entry of reparsed) {
        const key = encode(entry);
        const count = remaining.get(key) ?? 0;
        if (count > 0) {
            remaining.set(key, count - 1);
        } else {
            cliOnly.push(key);
        }
    }
    const pageOnly = [...remaining].filter(([, count]) => count > 0).map(([key]) => key);

    // Measured on this push: 180 page timings, 178 CLI ones, and the symmetric
    // difference is four entries — two paired rows for the claimed-crash
    // message and two manifest rows the CLI drops. Both are declared below.
    assert.equal(PUSH.timings.length, 180, 'the pinned push changed');
    assert.equal(reparsed.length, 178);
    assert.equal(
        cliOnly.length,
        2,
        `unexpected CLI-only timings, so the synthesis no longer round-trips:\n  ${cliOnly.join('\n  ')}`
    );
    assert.equal(
        pageOnly.length,
        4,
        `unexpected page-only timings:\n  ${pageOnly.join('\n  ')}`
    );
    // The two CLI-only rows are the claimed-crash pair, differing only in the
    // message — so each has a page-only twin with the same path and run.
    for (const key of cliOnly) {
        const [path, status, run] = key.split('|');
        assert.equal(status, 'CRASH');
        assert.ok(
            pageOnly.some((other) => other.startsWith(`${path}|${status}|${run}|`)),
            `${key} has no page twin, so it is a new difference rather than the declared one`
        );
    }
});

test('the pinned push carries no execution-mode suffix, which the synthesis relies on', () => {
    // `synthProfile` emits no `parallel` Text marker. Both parsers append
    // `-PARALLEL`/`-SEQUENTIAL` to a FAIL/TIMEOUT/CRASH/PASS **only when such a
    // range exists**, so emitting one would rewrite every status in the push
    // and the comparison would be of statuses neither side's real data has.
    // Skipping it is only safe while the fixture has none, so that is asserted
    // rather than assumed.
    for (const timing of PUSH.timings) {
        assert.doesNotMatch(
            timing.status,
            /-(PARALLEL|SEQUENTIAL)$/,
            'the pinned push now contains an execution-mode suffix; synthProfile must emit a ' +
                'parallel range or this comparison is against rewritten statuses'
        );
    }
});

// =========================================================================
// 1. Value parity
// =========================================================================

test('the two sides produce the same row set, bar the manifest pseudo-tests', async () => {
    const result = await cli();
    const pagePaths = new Set(PAGE.tests.map((row) => row.path));
    const cliPaths = new Set(cliRows(result).map((row) => row.path));

    assert.deepEqual(
        [...cliPaths].filter((path) => !pagePaths.has(path)),
        [],
        'the CLI invented a row the page does not have'
    );
    // The page's extra rows are the declared manifest divergence and nothing
    // else. Asserted as the exact set, so a *third* page-only row fails here
    // rather than being absorbed by a "the CLI has fewer rows" allowance.
    assert.deepEqual(
        [...pagePaths].filter((path) => !cliPaths.has(path)).sort(),
        [
            'devtools/client/debugger/test/mochitest/sourcemaps/browser.toml',
            'toolkit/components/ml/tests/browser/browser.toml',
        ]
    );
    assert.equal(PAGE.tests.length, 28);
    assert.equal(cliPaths.size, 26);
});

test('every shared row agrees field by field', async () => {
    // The value-parity check `PARITY.md` §5 asks for: "asserted field by
    // field", over all 26 shared rows rather than a spot check.
    //
    // Both sides are on `lib/`… except that they are not, for `try`: the push
    // is parsed by `site/try.ts`'s worker on one side and
    // `cli/commands/try.ts`'s `parseTestMarkers` on the other, and the
    // aggregation is `site/try-view.ts`'s `aggregateFailures` against the
    // command's own inline accumulation. So this is a genuine two-implementation
    // comparison and not a tautology — which is why 0 differences over 26 rows
    // and four fields is worth asserting.
    const result = await cli();
    const cliByPath = new Map(cliRows(result).map((row) => [row.path, row]));

    let compared = 0;
    for (const row of PAGE.tests) {
        const other = cliByPath.get(row.path);
        if (other === undefined) {
            continue; // the declared manifest divergence, asserted above
        }
        compared++;
        assert.equal(
            other.failureCount,
            row.instances.length,
            `${row.path}: failing executions differ — the page's # column is ` +
                `instances.length (try.html:1749) and the CLI's failureCount must be the same ` +
                'quantity'
        );
        assert.equal(
            other.totalRuns,
            row.totalJobs,
            `${row.path}: the run denominator differs. Both count only the configs the test ` +
                'FAILED on (try.html:1563), so a difference means one side folded in a clean config'
        );
        assert.deepEqual(
            [...other.jobNames].sort(),
            [...row.jobs].sort(),
            `${row.path}: the affected configurations differ`
        );
        assert.deepEqual(
            [...other.statuses].sort(),
            [...row.statuses].sort(),
            `${row.path}: the status set differs`
        );
    }
    assert.equal(compared, 26, 'all 26 shared rows must be compared, or this is a spot check');
});

test('the push-level totals agree', async () => {
    const result = await cli();
    // Read off the fixture directly, not from either side's report.
    assert.equal(result.jobCount, PUSH.jobs.length);
    assert.equal(result.failedJobCount, FAILED_TEST_JOBS.length);
    assert.equal(FAILED_TEST_JOBS.length, 46);
    // 46 failed test jobs, 33 of which yielded timings: the other 13 had no
    // readable profile. The page counts the same population as "not analyzed".
    const runsWithTimings = timingsByRun(PUSH).size;
    assert.equal(runsWithTimings, 33);
    assert.equal(result.unblamedJobCount, FAILED_TEST_JOBS.length - runsWithTimings + 2);
});

// =========================================================================
// 2. Order parity — the full ranked sequence
// =========================================================================

/** Groups of adjacent equal-count entries, each sorted, so ties compare equal. */
function normalizeTies(paths: readonly string[], countOf: (path: string) => number): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < paths.length) {
        let j = i;
        while (j < paths.length && countOf(paths[j]!) === countOf(paths[i]!)) {
            j++;
        }
        out.push(...paths.slice(i, j).sort());
        i = j;
    }
    return out;
}

test('the full ranked sequence matches, with ties normalized', async () => {
    // §5: "as a full ranked sequence — not a spot check. The sort-key bug
    // produced the same set in a different order and would pass any set
    // comparison." So this compares all 26 positions.
    //
    // Ties are normalized because the page's tie order is genuinely
    // non-deterministic — `allTimings` is pushed in worker-completion order, so
    // across four pinned reloads of this push the old page disagreed with
    // itself at 104-166 of 431 positions. Comparing raw tie order would be
    // comparing against a coin flip. What is *not* normalized away is any pair
    // with unequal counts: that is the next test.
    const result = await cli();
    const cliPaths = new Set(cliRows(result).map((row) => row.path));
    const cliByPath = new Map(cliRows(result).map((row) => [row.path, row]));
    const pageByPath = new Map(PAGE.tests.map((row) => [row.path, row]));

    const pageSequence = PAGE_ORDER.map((row) => row.path).filter((path) => cliPaths.has(path));
    const cliSequence = cliRanked(result).map((row) => row.path);

    assert.equal(pageSequence.length, 26);
    assertSameOrder(
        normalizeTies(pageSequence, (path) => pageByPath.get(path)!.instances.length),
        normalizeTies(cliSequence, (path) => cliByPath.get(path)!.failureCount),
        'the ranked sequences differ at a position ties cannot explain'
    );
});

test('no pair with unequal counts is ever out of order between the two sides', async () => {
    // The assertion the tie normalization must not be allowed to weaken. A sort
    // key that changed — the exact defect `PARITY.md` §1 records as invisible
    // to a value diff — reorders pairs with *different* counts, and no amount
    // of tie normalization hides that. Checked over every pair, not adjacent
    // ones: a key change can move a row past several others at once.
    const result = await cli();
    const cliSequence = cliRanked(result).map((row) => row.path);
    const cliRank = new Map(cliSequence.map((path, index) => [path, index]));
    const cliByPath = new Map(cliRows(result).map((row) => [row.path, row]));
    const pageByPath = new Map(PAGE.tests.map((row) => [row.path, row]));
    const pageSequence = PAGE_ORDER.map((row) => row.path).filter((path) => cliRank.has(path));

    let unequalPairs = 0;
    for (let i = 0; i < pageSequence.length; i++) {
        for (let j = i + 1; j < pageSequence.length; j++) {
            const earlier = pageSequence[i]!;
            const later = pageSequence[j]!;
            if (
                pageByPath.get(earlier)!.instances.length ===
                pageByPath.get(later)!.instances.length
            ) {
                continue;
            }
            unequalPairs++;
            assert.ok(
                cliRank.get(earlier)! < cliRank.get(later)!,
                `${earlier} (${pageByPath.get(earlier)!.instances.length} executions) precedes ` +
                    `${later} (${pageByPath.get(later)!.instances.length}) on the page but ` +
                    `follows it in the CLI, where they are ` +
                    `${cliByPath.get(earlier)!.failureCount} and ` +
                    `${cliByPath.get(later)!.failureCount}. Ties are normalized elsewhere; an ` +
                    'unequal-count inversion is a sort-key difference.'
            );
        }
    }
    // The fixture has to contain unequal pairs or the loop above proves
    // nothing. 26 rows over five distinct counts leaves plenty.
    assert.ok(unequalPairs > 200, `only ${unequalPairs} unequal-count pairs to check`);
});

test('the raw tie order really does differ, so the normalization is not decorative', async () => {
    // The other half: if the two sides happened to agree on ties, normalizing
    // them would be dead code and the declared divergence stale. Measured on
    // this push — 11 of 26 positions differ before normalization — so the
    // normalization is load-bearing and the divergence is live.
    const result = await cli();
    const cliSequence = cliRanked(result).map((row) => row.path);
    const cliPaths = new Set(cliSequence);
    const pageSequence = PAGE_ORDER.map((row) => row.path).filter((path) => cliPaths.has(path));

    let differing = 0;
    for (let i = 0; i < pageSequence.length; i++) {
        if (pageSequence[i] !== cliSequence[i]) {
            differing++;
        }
    }
    assert.equal(
        differing,
        11,
        'the raw tie order between the page and the CLI changed. 11 of 26 positions is what ' +
            'this push measures; if it became 0 the path tiebreak has been adopted by the page ' +
            'and the divergence below must be deleted.'
    );
});

// =========================================================================
// 3. Framing parity — grouping, sort key, direction
// =========================================================================

test('both sides rank on failing executions, descending', async () => {
    // Direction asserted on the emitted sequence rather than on a flag: a
    // command reporting `sort: "count"` while emitting ascending order would
    // pass a label check. And executions rather than distinct job runs, which
    // is the pair `PARITY.md` §1 says a value diff cannot separate.
    const result = await cli();
    const cliSequence = cliRanked(result);
    for (let i = 1; i < cliSequence.length; i++) {
        assert.ok(
            cliSequence[i - 1]!.failureCount >= cliSequence[i]!.failureCount,
            `the CLI is not descending at ${i}`
        );
    }
    const pageCounts = PAGE_ORDER.map((row) => row.instances.length);
    for (let i = 1; i < pageCounts.length; i++) {
        assert.ok(pageCounts[i - 1]! >= pageCounts[i]!, `the page is not descending at ${i}`);
    }

    // Executions, not job runs — shown by the two disagreeing on this push. A
    // ranking on distinct failing job runs produces a *different sequence*, and
    // both sides reject it.
    const failingRuns = (path: string): number => {
        const runs = new Set<string>();
        for (const timing of PUSH.timings) {
            if (timing.path === path && isFailureStatusRaw(timing.status)) {
                runs.add(runKey(timing));
            }
        }
        return runs.size;
    };
    const byJobRuns = [...cliSequence].sort(
        (a, b) => failingRuns(b.path) - failingRuns(a.path) || a.path.localeCompare(b.path)
    );
    assert.notDeepEqual(
        byJobRuns.map((row) => row.path),
        cliSequence.map((row) => row.path),
        'ranking by distinct job runs gives the same order on this push, so neither side is ' +
            'shown to rank on executions'
    );
});

/** The failure statuses, spelled out here rather than imported from either side. */
function isFailureStatusRaw(status: string): boolean {
    const bare = status.replace(/-(PARALLEL|SEQUENTIAL)$/, '');
    return ['FAIL', 'TIMEOUT', 'CRASH', 'ERROR', 'UNEXPECTED-PASS'].includes(bare);
}

test('the perma-fail grouping picks out the same tests on both sides', async () => {
    // The grouping dimension. The two sides compute it *differently*: the page
    // splits on `intermittentCount !== instances.length` — a test with any
    // non-intermittent execution — and the CLI on `everyRunFailed`, a
    // per-configuration "failed in every run and the rerun never passed". Two
    // rules, and they must select the same three tests or one of them is
    // answering a different question.
    const result = await cli();
    const { permanent } = splitTables(PAGE.tests);
    assert.deepEqual(
        [...permanent.map((row) => row.path)].sort(),
        [...result.permaFails.map((row) => row.path)].sort(),
        'the page\'s "Permanent failures" table and the CLI\'s PERMA-FAILS section must hold ' +
            'the same tests; the two rules that produce them are not the same rule'
    );
    // Three, and the section is not empty — an empty one on both sides would
    // make the assertion vacuous.
    assert.equal(result.permaFails.length, 3);
    // And the CLI's other two sections partition the rest, so no row is lost or
    // counted twice between the groupings.
    const rest = new Set([
        ...result.knownIntermittents.map((row) => row.path),
        ...result.newIntermittents.map((row) => row.path),
    ]);
    assert.equal(rest.size, 23);
    for (const row of result.permaFails) {
        assert.ok(!rest.has(row.path), `${row.path} is in two sections`);
    }
});

test('the CLI splits intermittents by central history where the page does not', async () => {
    // A grouping the page has no counterpart for, and it is not a divergence
    // in the values: `knownIntermittents ∪ newIntermittents` is exactly the
    // page's intermittent table. Asserted because a future change that started
    // *filtering* on central rather than splitting on it would shrink the
    // population, which is the defect the CLI already had once (`try.ts:379`
    // records it reporting 0 perma-fails where the dashboard reported 3).
    const result = await cli();
    const { intermittent } = splitTables(PAGE.tests);
    const cliPaths = new Set(cliRows(result).map((row) => row.path));
    const pageIntermittent = intermittent.map((row) => row.path).filter((path) => cliPaths.has(path));
    assert.deepEqual(
        [...pageIntermittent].sort(),
        [
            ...result.knownIntermittents.map((row) => row.path),
            ...result.newIntermittents.map((row) => row.path),
        ].sort()
    );
    // No central data is served to this invocation, so everything lands in
    // `newIntermittents`. Stated so the empty `knownIntermittents` reads as a
    // property of the fixture rather than of the split.
    assert.equal(result.knownIntermittents.length, 0);
});

// =========================================================================
// Declared divergences
// =========================================================================

/**
 * Where the page and the CLI differ on purpose.
 *
 * Same discipline as `test/framing.test.ts`: both sides' measured values are
 * recorded, and an entry whose sides have converged fails. The values here are
 * the ones the tests above observed, not descriptions of them.
 */
const DIVERGENCES: Divergence[] = [
    {
        what: 'manifest-path pseudo-tests',
        reason:
            'A crash during manifest teardown is recorded against the `.toml`, with no running ' +
            'test to attribute it to. The page emits it as a synthetic row keyed on that path ' +
            "(`site/try.ts:565-580` keeps `c.testPath` unconditionally), so a manifest appears " +
            "in a table of tests. The CLI re-checks the test extension and drops it " +
            '(`cli/commands/try.ts:828`): the path cannot be joined against the central ' +
            'aggregates, so every per-test column the command would print for it — flakiness, ' +
            'pre-existing rate, run counts — is unanswerable, and a row of blanks reads as ' +
            '"never fails on central" rather than "not a test". Measured on this push: 2 rows.',
        page: [
            'devtools/client/debugger/test/mochitest/sourcemaps/browser.toml',
            'toolkit/components/ml/tests/browser/browser.toml',
        ],
        cli: [],
    },
    {
        what: 'tie order among rows with equal failure counts',
        reason:
            'The CLI breaks ties on the path (`cli/commands/try.ts:1034`); the page leaves them ' +
            'in insertion order, which is the order eight web workers finished parsing profiles ' +
            'fetched 64 at a time. That is a network race, and it is measured rather than ' +
            'assumed: across four pinned reloads of 717fc67feaa071 the old page disagreed with ' +
            'itself at 104-166 of 431 positions, every unstable index an adjacent pair with ' +
            'equal counts. A command whose output is diffed and pasted into bugs cannot be ' +
            'non-deterministic. On this push the two orders differ at 11 of 26 positions, all ' +
            'within tie groups — asserted above, along with the fact that no unequal-count pair ' +
            'is ever inverted.',
        page: 'insertion order (worker completion)',
        cli: 'path, ascending',
    },
    {
        what: "the message on a crash the profile attributed to a running test",
        reason:
            'FOUND BY THIS FILE, and not previously declared. When a `Crash` marker falls inside ' +
            "a test's execution range, the CLI sets `message ??= signature` " +
            '(`cli/commands/try.ts:797`) while the page records the signature only in ' +
            "`crashSignature` and leaves `message` unset (`site/try.ts:552-556`), so " +
            '`messagesOf` returns nothing for it. Both do set the message for an *unclaimed* ' +
            'crash, so the two branches disagree with each other as well as across the sides. ' +
            'Measured on this push: 2 of the 4 crash timings, on ' +
            '`test_suspend_media_by_inactive_docshell.html` and ' +
            '`test_nsIEditorSpellCheck_ReplaceWord.html`. Recorded rather than fixed because ' +
            'the fix is in `site/` or `cli/`, outside this change\'s scope, and because which ' +
            'side is right is a real question: the signature is the only description a crash ' +
            'has, and the CLI\'s `messageComparable` (`try.ts:1015`) already treats a CRASH as ' +
            'comparable without one. It changes no count above — the row set, the execution ' +
            'counts and the ranking are unaffected — but it changes what the same-message ' +
            'comparison against central is given to match on.',
        page: 0,
        cli: 2,
    },
];

test('every declared divergence still diverges', () => {
    assertDeclaredDivergences('try', DIVERGENCES);
});

test('the claimed-crash message divergence is exactly as large as declared', async () => {
    // The allow-list entry above says "2 of the 4 crash timings". An entry
    // carrying a number that nothing checks is a comment; this is what makes it
    // an assertion, and what makes a *third* affected crash fail rather than
    // being absorbed.
    const byRun = timingsByRun(PUSH);
    const jobByRun = new Map<string, TreeherderJob>(PUSH.jobs.map((job) => [runKey(job), job]));

    const cliMessages = new Map<string, string | null>();
    for (const [key, timings] of byRun) {
        for (const timing of parseTestMarkers(synthProfile(timings), jobByRun.get(key)!)) {
            if (timing.status.startsWith('CRASH')) {
                cliMessages.set(`${timing.path}|${runKey(timing)}`, timing.message);
            }
        }
    }

    const crashes = PUSH.timings.filter((timing) => timing.status === 'CRASH');
    assert.equal(crashes.length, 4, 'the pinned push has four crash timings');

    let claimedWithoutPageMessage = 0;
    for (const crash of crashes) {
        const pageMessage = crash.allMessages[0]?.message ?? crash.message ?? null;
        const cliMessage = cliMessages.get(`${crash.path}|${runKey(crash)}`) ?? null;
        if (pageMessage === null && cliMessage !== null) {
            claimedWithoutPageMessage++;
            // And it is the signature, not some other string — which is what
            // identifies the difference as this one rather than a new one.
            assert.equal(cliMessage, crash.crashSignature);
        }
    }
    assert.equal(
        claimedWithoutPageMessage,
        2,
        'the claimed-crash message divergence changed size. Re-measure it and update the entry ' +
            'in DIVERGENCES, or delete the entry if it is gone.'
    );

    const declared = DIVERGENCES.find((entry) => entry.what.includes('crash the profile'));
    assert.ok(declared !== undefined);
    assert.equal(declared.cli, claimedWithoutPageMessage);
});
