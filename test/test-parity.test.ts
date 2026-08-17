/**
 * New page vs CLI for `test`: `site/test.html?test=<path>` ↔ `fx-tests test <path>`.
 *
 * `PARITY.md` §5, for the second of the three migrated pages. Both sides are
 * driven over the **same bucket fixtures** — `site/test-view.ts`'s
 * `buildTestView` on one side, a real `run()` invocation on the other — and
 * compared on values, order and framing.
 *
 * ## Why this is not `test/framing.test.ts`
 *
 * That file's `test` entry asserts the CLI against a *source audit* of
 * `test.html`: `rowUnit` is "job variant, with platforms as columns" because
 * `old/test.html:2670` says so, cited by line. It cannot run the page, so it can
 * record that the page ranks variants by total runs and the CLI ranks configs
 * by fail rate — but not that the two, executed over the same file, report the
 * same 15,968 runs and the same three issues.
 *
 * This file complements it. It runs both. Where framing.test.ts already
 * declares a divergence (the matrix-vs-list row unit, the rate-vs-runs sort
 * key), it is not restated here; what is added is the measurement those
 * declarations were made without.
 *
 * ## The corpus, and why it is every test rather than one
 *
 * 16 tests across the two bucket fixtures record at least one fail, crash or
 * timeout. All 16 are compared, because a per-test detail page is one test's
 * worth of data and a parity claim from a single test is a claim about a single
 * test. The 16 were selected by walking the fixtures with `computeTestStats`
 * and keeping the ones with an issue — a rule, not a hand-picked list, so a
 * fixture regeneration that changed the population fails the count assertion
 * rather than silently comparing fewer tests.
 *
 * ## The trap this file is written against
 *
 * `test/test-view.test.ts`'s header states it: three of five surviving mutants
 * in the crash-viewer review were tests deriving their expected value from the
 * thing under test. Nothing below compares a value to itself. The two sides
 * genuinely are two computations for most of what is checked — `buildTestView`
 * against `runTest`'s assembly — and where they share a `lib/` function that
 * is said so rather than presented as agreement.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { type BucketFile, decodeBucket } from '../lib/formats/buckets.ts';
import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import type { ConfigStats } from '../lib/query/config-stats.ts';
import type { TestStats } from '../lib/query/test-stats.ts';
import { computeTestStats } from '../lib/query/test-stats.ts';
import { coverageOf } from '../lib/query/coverage.ts';
import {
    type TestView,
    buildTestView,
    cellKey,
    displayPlatformOf,
    displayVariantOf,
} from '../site/test-view.ts';
import {
    type Divergence,
    assertDeclaredDivergences,
    assertSameOrder,
    fixtureJson,
    fixtureSource,
    invoke,
    json,
} from './parity-harness.ts';

// =========================================================================
// The corpus
// =========================================================================

const FIXTURE_NAMES = ['xpcshell-00.json', 'mochitest-00.json'] as const;

interface Candidate {
    fixture: string;
    raw: BucketFile;
    file: DecodedTimingFile;
    testId: number;
    path: string;
    component: string | null;
    stats: TestStats;
}

/**
 * Every test in the fixtures with at least one fail, crash or timeout.
 *
 * A rule rather than a list: a fixture regeneration that dropped one of these
 * fails the count assertion below instead of quietly comparing fewer tests.
 * Tests with no issue at all are excluded because the interesting half of both
 * sides — the issue list, the failing-config table — would be empty for them
 * and the comparison would be of two empty arrays.
 */
function corpus(): Candidate[] {
    const out: Candidate[] = [];
    for (const fixture of FIXTURE_NAMES) {
        const raw = fixtureJson<BucketFile>(fixture);
        const file = decodeBucket(raw);
        for (let testId = 0; testId < file.testCount; testId++) {
            const stats = computeTestStats(file, testId);
            if (stats.failCount + stats.crashCount + stats.timeoutCount === 0) {
                continue;
            }
            const identity = file.testAt(testId);
            out.push({
                fixture,
                raw,
                file,
                testId,
                path: identity.fullPath,
                component: identity.component,
                stats,
            });
        }
    }
    return out;
}

const CORPUS = corpus();

/** One configuration's run counts by kind. */
interface RawCounts {
    pass: number;
    fail: number;
    timeout: number;
    crash: number;
    skip: number;
    expectedFail: number;
}

/**
 * Per-configuration counts read straight off the bucket file's parallel arrays.
 *
 * **Deliberately importing nothing from `lib/` or `site/`.** This is the
 * independent path the cell comparison's expectations come from, and the reason
 * it exists is a defect in the first draft of this file: summing
 * `coverageOf(...).configs` and comparing it to the page's grid *looked* like
 * two implementations agreeing and was one implementation agreeing with itself,
 * because `buildJobTable` reads `coverageOf` too. A mutation adding one to
 * `coverage.ts`'s `failCount` moved both sides and the test stayed green.
 *
 * Three facts about the format are reproduced here rather than borrowed, and
 * each is checked against `coverageOf` on every config in the fixtures by the
 * agreement test below — so a format change breaks that test loudly instead of
 * silently making this reader wrong:
 *
 * 1. the chunk suffix is stripped to get the configuration identity, because
 *    `-1` and `-2` of the same job are one config;
 * 2. a group with `jobNameIds` is per-job and its count comes from whichever of
 *    `counts`, `durations` or `taskIdIds` it carries;
 * 3. a group without one (`CRASH`, `FAIL*`) is per-task, and the job is
 *    resolved through `taskInfo.jobNameIds`.
 */
function rawConfigCounts(raw: BucketFile, testId: number): Map<string, RawCounts> {
    const statuses = raw.tables.statuses;
    const jobNames = raw.tables.jobNames ?? [];
    const taskJobNameIds = raw.taskInfo?.jobNameIds ?? [];
    const out = new Map<string, RawCounts>();

    const identityOf = (jobName: string): string => {
        const slash = jobName.indexOf('/');
        return slash === -1
            ? jobName
            : jobName.slice(0, slash + 1) + jobName.slice(slash + 1).replace(/-\d+$/, '');
    };
    const bump = (jobName: string, kind: keyof RawCounts, amount: number): void => {
        const key = identityOf(jobName);
        const entry = out.get(key) ?? {
            pass: 0,
            fail: 0,
            timeout: 0,
            crash: 0,
            skip: 0,
            expectedFail: 0,
        };
        entry[kind] += amount;
        out.set(key, entry);
    };

    const groups = (raw.testRuns[testId] ?? []) as (Record<string, unknown> | null)[];
    for (const [statusId, group] of groups.entries()) {
        if (group === null || group === undefined) {
            continue;
        }
        const base = (statuses[statusId] ?? '').replace(/-(PARALLEL|SEQUENTIAL)$/, '');
        const kind: keyof RawCounts | null =
            base === 'PASS'
                ? 'pass'
                : base === 'FAIL'
                  ? 'fail'
                  : base === 'TIMEOUT'
                    ? 'timeout'
                    : base === 'CRASH'
                      ? 'crash'
                      : base === 'SKIP'
                        ? 'skip'
                        : base === 'EXPECTED-FAIL'
                          ? 'expectedFail'
                          : null;
        // A status this reader does not know is a format change, and silently
        // dropping it would understate every count it contributes to.
        assert.ok(kind !== null, `rawConfigCounts does not know the status ${statuses[statusId]}`);

        const perJob = group['jobNameIds'] as number[] | undefined;
        if (perJob !== undefined) {
            const counts = group['counts'] as number[] | undefined;
            const durations = group['durations'] as number[][] | undefined;
            const taskIds = group['taskIdIds'] as number[][] | undefined;
            for (const [i, jobNameId] of perJob.entries()) {
                const amount =
                    counts?.[i] ?? durations?.[i]?.length ?? taskIds?.[i]?.length ?? 0;
                bump(jobNames[jobNameId]!, kind, amount);
            }
            continue;
        }
        const perTask = group['taskIdIds'] as number[][] | undefined;
        if (perTask !== undefined) {
            for (const list of perTask) {
                for (const taskIdIndex of list) {
                    bump(jobNames[taskJobNameIds[taskIdIndex]!]!, kind, 1);
                }
            }
        }
    }
    return out;
}

test('the independent raw reader agrees with coverageOf on every config', () => {
    // The reader above is a second implementation of the format, so it has to
    // be checked or it becomes a second place to be wrong. Compared against
    // `coverageOf` over every test in both fixtures — 923 configurations — so a
    // format change that broke the reader fails here, where the message says
    // so, rather than in the cell comparison, where it would read as a page
    // bug.
    //
    // Note the direction of trust: this test establishes that the two agree
    // *today*, on unmutated code. The cell comparison then uses the raw reader,
    // so a later change to `coverageOf` alone breaks both this and that — which
    // is what makes the cell comparison sensitive to a count mutation.
    let checked = 0;
    for (const fixture of FIXTURE_NAMES) {
        const raw = fixtureJson<BucketFile>(fixture);
        const file = decodeBucket(raw);
        for (let testId = 0; testId < file.testCount; testId++) {
            const rawCounts = rawConfigCounts(raw, testId);
            for (const config of coverageOf(file, testId).configs) {
                const counts = rawCounts.get(config.jobName);
                assert.ok(
                    counts !== undefined,
                    `${fixture} test ${testId}: coverageOf reports ${config.jobName} and the raw ` +
                        'walk finds no such configuration'
                );
                assert.deepEqual(
                    {
                        pass: config.passCount,
                        fail: config.failCount,
                        timeout: config.timeoutCount,
                        crash: config.crashCount,
                        skip: config.skipCount,
                        expectedFail: config.expectedFailCount,
                    },
                    counts,
                    `${fixture} test ${testId} ${config.jobName}: coverageOf and the raw arrays ` +
                        'disagree'
                );
                checked++;
            }
        }
    }
    assert.equal(checked, 923, 'the configurations in the fixtures changed');
});

/** The page's view model for one corpus entry, built as `site/test.ts` builds it. */
function pageView(entry: Candidate, harness: string): TestView {
    return buildTestView(entry.file, {
        testId: entry.testId,
        testPath: entry.path,
        component: entry.component,
        harness,
        stats: entry.stats,
        metadata: {
            days: entry.raw.metadata.days,
            startTime: entry.raw.metadata.startTime,
            startDate: entry.raw.metadata.startDate,
            endDate: entry.raw.metadata.endDate,
        },
    });
}

/** The CLI's `--json` shape, narrowed to what is compared. */
interface CliTest {
    test: string;
    path: string;
    component: string | null;
    harness: string;
    metadata: { startDate: string; endDate: string; dayCount: number; singleDay: boolean };
    totals: TestStats;
    configs: ConfigStats[];
    reach: {
        configCount: number;
        platforms: { platform: string; configCount: number }[];
        absentPlatforms: string[];
    } | null;
    /**
     * The shared issue list — skips, failures, crashes and timeouts in one
     * sequence. Declared here independently of `cli/commands/test.ts`'s own type,
     * like every other field on this mirror, so the assertion is against the
     * documented JSON shape rather than against whatever the CLI happens to emit.
     */
    issues: { count: number; type: string; message: string }[];
    messages: { message: string; count: number }[];
    crashSignatures: { signature: string; count: number }[];
    skips: { message: string; count: number }[];
    coverage?: {
        configs: { jobName: string; runCount: number; passCount: number; failCount: number; skipCount: number }[];
        platforms: { platform: string; configCount: number }[];
    };
}

/** One `fx-tests test` invocation. */
async function cli(path: string, extra: string[] = []): Promise<CliTest> {
    return json<CliTest>(
        await invoke(['test', path, '--json', ...extra], { source: fixtureSource() })
    );
}

test('the corpus is the population it claims to be', () => {
    // Pinned so a fixture change that shrinks the comparison fails loudly
    // rather than making every assertion below cheaper.
    assert.equal(CORPUS.length, 16, 'the fixtures no longer hold 16 tests with issues');
    assert.equal(CORPUS.filter((entry) => entry.fixture === 'xpcshell-00.json').length, 11);
    assert.equal(CORPUS.filter((entry) => entry.fixture === 'mochitest-00.json').length, 5);
    // And every one of them really has an issue, which is the selection rule.
    for (const entry of CORPUS) {
        assert.ok(entry.stats.failCount + entry.stats.crashCount + entry.stats.timeoutCount > 0);
    }
});

// =========================================================================
// 1. Value parity
// =========================================================================

test('the totals agree on every test in the corpus, field by field', async () => {
    // `TestStats` is `lib/`'s, so both sides call the same function — which
    // makes this a weak assertion on its own and it is not presented as more
    // than that. What it does establish is that neither side re-derives,
    // re-filters or re-windows the totals on the way to its output: the CLI
    // applies a day window and a config filter before computing, and a default
    // invocation must leave both inert.
    for (const entry of CORPUS) {
        const result = await cli(entry.path);
        const view = pageView(entry, result.harness);
        assert.deepEqual(
            result.totals,
            view.stats,
            `${entry.path}: the totals differ. Both read lib/query/test-stats.ts, so a ` +
                'difference here is one side applying a filter or a window the other does not.'
        );
        // Against the fixture too, so "both agree" cannot be both being wrong
        // about which test was looked up.
        assert.equal(result.totals.runCount, entry.stats.runCount);
        assert.equal(result.path, entry.path);
        assert.equal(result.component, view.component);
        assert.equal(result.test, view.testName);
    }
});

test('the page cell grid matches counts read straight off the fixture arrays', async () => {
    // The load-bearing value check, and the one that took two attempts to write
    // correctly — the failure is recorded here because it is the exact trap
    // `PARITY.md` §1 names.
    //
    // The first version summed `coverageOf(...).configs` and compared that to
    // the page's cells. It looked like a two-implementation comparison and was
    // not: `buildJobTable` is *built from* `coverageOf`, so both sides of the
    // assertion came from the same function. A mutation adding one to
    // `coverage.ts`'s `failCount` left it green, because it moved both sides
    // together. That is a test deriving its expected value from the thing under
    // test, and it read like coverage.
    //
    // So the expectation now comes from `rawConfigCounts`, which walks the
    // bucket file's parallel arrays with no `lib/` or `site/` code in the path
    // at all. The same mutation now fails here.
    //
    // Compared per cell rather than as one grand total: a total would net out a
    // config landing in the wrong cell, which is the failure mode a collapse
    // bug actually produces.
    let cellsChecked = 0;
    for (const entry of CORPUS) {
        const result = await cli(entry.path);
        const view = pageView(entry, result.harness);

        const aggregated = new Map<
            string,
            { passes: number; failures: number; timeouts: number; crashes: number; skips: number }
        >();
        for (const [jobName, counts] of rawConfigCounts(entry.raw, entry.testId)) {
            const key = cellKey(
                displayVariantOf(view.mappings, jobName),
                displayPlatformOf(view.mappings, jobName)
            );
            const cell = aggregated.get(key) ?? {
                passes: 0,
                failures: 0,
                timeouts: 0,
                crashes: 0,
                skips: 0,
            };
            // The page folds EXPECTED-FAIL into passes (`outcomesOfConfig`,
            // `site/test-view.ts:607`): an annotation that fired as intended is
            // not an issue. Applied here rather than left out, because omitting
            // it would make every expected-fail look like a mismatch.
            cell.passes += counts.pass + counts.expectedFail;
            cell.failures += counts.fail;
            cell.timeouts += counts.timeout;
            cell.crashes += counts.crash;
            cell.skips += counts.skip;
            aggregated.set(key, cell);
        }

        assert.equal(
            view.jobTable.byCell.size,
            aggregated.size,
            `${entry.path}: the page's grid has ${view.jobTable.byCell.size} cells and the ` +
                `configs roll up into ${aggregated.size}`
        );
        for (const [key, outcomes] of view.jobTable.byCell) {
            const expected = aggregated.get(key);
            assert.ok(expected !== undefined, `${entry.path}: no configs roll up into ${key}`);
            assert.deepEqual(
                {
                    passes: outcomes.passes,
                    failures: outcomes.failures,
                    timeouts: outcomes.timeouts,
                    crashes: outcomes.crashes,
                    skips: outcomes.skips,
                },
                expected,
                `${entry.path} cell ${key}: the grid and the per-config rollup disagree`
            );
            cellsChecked++;
        }
    }
    assert.ok(cellsChecked > 100, `only ${cellsChecked} cells compared`);
});

test('the CLI ranked table\'s own numbers come from the fixture, not from itself', async () => {
    // The three numbers a reader takes off `fx-tests test` — fails, runs and
    // the rate between them — anchored to the raw arrays.
    //
    // Separate from the cell comparison and not folded into it, because they
    // come from a *different* query: the grid reads `coverageOf` and the ranked
    // table reads `computeConfigStats`. Checking one says nothing about the
    // other, and a mutation adding one to `config-stats.ts`'s `failCount`
    // survived every other test in this file — including the cell comparison,
    // which does not touch that function. It fails here.
    //
    // `ConfigStats.failCount` is every non-pass verdict, not just FAIL: fails,
    // timeouts and crashes all count. That is the definition being pinned, and
    // it is spelled out from the raw counts rather than taken on trust, because
    // it is the field the framing table calls the sort key.
    let configsChecked = 0;
    for (const entry of CORPUS) {
        const result = await cli(entry.path);
        const rawCounts = rawConfigCounts(entry.raw, entry.testId);
        for (const config of result.configs) {
            const counts = rawCounts.get(config.jobName);
            assert.ok(
                counts !== undefined,
                `${entry.path}: the CLI ranks ${config.jobName}, which the raw walk does not find`
            );
            const nonPass = counts.fail + counts.timeout + counts.crash;
            assert.equal(
                config.failCount,
                nonPass,
                `${entry.path} ${config.jobName}: failCount must be every non-pass verdict ` +
                    `(${counts.fail} fail + ${counts.timeout} timeout + ${counts.crash} crash)`
            );
            // Runs exclude skips and include expected-fails, which is what
            // makes the rate a share of runs that happened.
            assert.equal(
                config.runCount,
                counts.pass + counts.expectedFail + nonPass,
                `${entry.path} ${config.jobName}: runCount`
            );
            assert.equal(
                config.failRate,
                config.runCount > 0 ? (nonPass / config.runCount) * 100 : 0,
                `${entry.path} ${config.jobName}: failRate must be the raw ratio`
            );
            configsChecked++;
        }
    }
    assert.ok(configsChecked > 25, `only ${configsChecked} ranked configs anchored`);
});

test('every failing config the CLI ranks is a cell the page shows as failing', async () => {
    // The other direction, and the one that would catch a CLI listing a config
    // the matrix has no cell for — which is what a chunk-suffix mismatch
    // between `stripChunkSuffix` and `extractVariant` would produce.
    for (const entry of CORPUS) {
        const result = await cli(entry.path);
        const view = pageView(entry, result.harness);
        for (const config of result.configs) {
            const key = cellKey(
                displayVariantOf(view.mappings, config.jobName),
                displayPlatformOf(view.mappings, config.jobName)
            );
            const cell = view.jobTable.byCell.get(key);
            assert.ok(
                cell !== undefined,
                `${entry.path}: the CLI ranks ${config.jobName}, which rolls up into ${key}, ` +
                    'and the page has no such cell'
            );
            // `ConfigStats.failCount` is every non-pass verdict, so the cell's
            // three issue counters are what it must be compared against.
            assert.ok(
                cell.failures + cell.crashes + cell.timeouts > 0,
                `${entry.path}: the CLI ranks ${config.jobName} as failing and the page's ${key} ` +
                    'cell shows no issue at all'
            );
        }
    }
});

test('the two independently-written coarse-OS rules agree on every job name', async () => {
    // `lib/query/coverage.ts:394`'s `operatingSystemOf` and
    // `site/test-view.ts:280`'s `extractPlatform` are two separate
    // implementations of "which OS is this", and the CLI's "Runs on N configs
    // across …" line and the page's column grouping are each built on one of
    // them. They are not the *same* function, so their agreement is a real
    // check rather than a tautology — and a divergence would put a config on
    // one platform in the summary and another in the matrix.
    //
    // Driven off `reach`, which is emitted output, rather than off either
    // rule's source.
    const seen = new Set<string>();
    for (const entry of CORPUS) {
        const result = await cli(entry.path, ['--coverage']);
        assert.ok(result.reach !== null && result.coverage !== undefined);
        const view = pageView(entry, result.harness);

        // The CLI's per-platform config counts, rebuilt from the page's rule.
        //
        // Only configs that ran, matching what `coverage.platforms` counts
        // (`platformsCovered`, `lib/query/coverage.ts:384`). A config scheduled
        // and only ever skipped is in the matrix and not in this rollup; the
        // ran-vs-scheduled distinction is asserted separately, and mixing it in
        // here would make a platform-classification failure and a
        // did-it-run failure indistinguishable.
        const byPageRule = new Map<string, number>();
        for (const config of result.coverage.configs) {
            seen.add(config.jobName);
            if (config.runCount === 0) {
                continue;
            }
            const platform = coarsePlatformOf(displayPlatformOf(view.mappings, config.jobName));
            byPageRule.set(platform, (byPageRule.get(platform) ?? 0) + 1);
        }
        const byCliRule = new Map(
            result.coverage.platforms.map((row) => [row.platform, row.configCount] as const)
        );
        const asRows = (map: ReadonlyMap<string, number>): [string, number][] =>
            [...map].sort((a, b) => a[0].localeCompare(b[0]));
        assert.deepEqual(
            asRows(byPageRule),
            asRows(byCliRule),
            `${entry.path}: the page's platform grouping and the CLI's disagree`
        );
    }
    // Pinned rather than bounded: the value of this test is the breadth, and a
    // fixture change that halved it should be noticed rather than silently
    // narrowing what "the two rules agree" covers.
    assert.equal(seen.size, 300, 'the distinct job names in the corpus changed');
});

/**
 * The base OS behind a display platform key.
 *
 * The page's columns are *detailed* (`mac-64`, `windows-32`) and collapse to
 * the base when a group has one member, so `linux` and `linux-64` can both
 * appear across the corpus. The CLI reports the coarse OS. Stripping the
 * bitness suffix is the only reconciliation, and it is written out here rather
 * than imported so the comparison does not go through either side's rule.
 */
function coarsePlatformOf(displayPlatform: string): string {
    return displayPlatform.replace(/-(?:32|64|aarch64)$/, '');
}

test('the failure messages and crash signatures agree, text and count', async () => {
    // The values a reader copies out of either side into a bug. Compared as
    // (count, text) pairs over the whole corpus rather than as totals, because
    // a total would net out one message's count moving to another's.
    let pairs = 0;
    for (const entry of CORPUS) {
        const result = await cli(entry.path);
        const view = pageView(entry, result.harness);

        const pageOf = (type: string): [number, string][] =>
            view.issues
                .filter((issue) => issue.type === type)
                .map((issue) => [issue.count, issue.message] as [number, string])
                .sort();

        // Failures: the page's synthetic no-message row and the CLI's
        // `(no message recorded)` are the same population under two labels —
        // a declared divergence — so both are normalized to a common token
        // before comparison, and the *label* difference is asserted separately.
        const normalize = (text: string): string =>
            text === '(no message recorded)' || text === FAILURE_NO_MESSAGE_TEXT
                ? '<unrecorded>'
                : text;
        const cliFailures = result.messages
            .map((row) => [row.count, normalize(row.message)] as [number, string])
            .sort();
        assert.deepEqual(
            pageOf('FAIL').map(([count, text]) => [count, normalize(text)]).sort(),
            cliFailures,
            `${entry.path}: the failure messages differ`
        );
        pairs += cliFailures.length;

        assert.deepEqual(
            pageOf('CRASH'),
            result.crashSignatures
                .map((row) => [row.count, row.signature] as [number, string])
                .sort(),
            `${entry.path}: the crash signatures differ`
        );
        pairs += result.crashSignatures.length;
    }
    assert.ok(pairs > 20, `only ${pairs} message/signature pairs compared`);
});

/** The page's label for a failure that recorded no message. `test-view.ts:1098`. */
const FAILURE_NO_MESSAGE_TEXT =
    'Failure details not recorded (likely Android or platform logging issue)';

test('the skip conditions agree exactly, with no prefix to account for', async () => {
    // This used to strip `skip-if: ` off the CLI side before comparing, because
    // the CLI rendered the raw string and the page stripped it — a declared
    // divergence. Since both sides render `buildTestIssues`, which strips via
    // `displaySkipMessage`, there is nothing to account for and the comparison is
    // exact. The prefix survives only on the legacy `--json` `skips[]` key,
    // asserted separately below so that key's shape stays pinned too.
    for (const entry of CORPUS) {
        const result = await cli(entry.path);
        const view = pageView(entry, result.harness);
        const pageSkips = view.issues
            .filter((issue) => issue.type === 'SKIP')
            .map((issue) => [issue.count, issue.message] as [number, string])
            .sort();
        const cliSkips = result.issues
            .filter((row) => row.type === 'SKIP')
            .map((row) => [row.count, row.message] as [number, string])
            .sort();
        assert.deepEqual(pageSkips, cliSkips, `${entry.path}: the skip conditions differ`);
        for (const [, message] of cliSkips) {
            assert.doesNotMatch(
                message,
                /^skip-if:/,
                `${entry.path}: the rendered skip condition still carries the prefix`
            );
        }
    }
});

test('the legacy skips[] JSON key still carries the raw manifest prefix', async () => {
    // `CLI.md` documents this key and consumers read it, so item 10 left it
    // alone. Asserted on real output rather than assumed: at least one corpus
    // test must show the prefix, or this key has silently changed shape.
    let withPrefix = 0;
    for (const entry of CORPUS) {
        const result = await cli(entry.path);
        for (const row of result.skips) {
            if (/^skip-if:/.test(row.message)) {
                withPrefix++;
            }
        }
    }
    assert.ok(withPrefix > 0, 'no skips[] row carried `skip-if: `, so the key changed shape');
});

test('the reported window is the same on both sides', async () => {
    for (const entry of CORPUS) {
        const result = await cli(entry.path);
        const view = pageView(entry, result.harness);
        // The page renders one string; the CLI three fields. Composed here
        // rather than compared loosely, so a day count that drifted by one
        // fails.
        assert.equal(
            view.dateRangeText,
            `${result.metadata.dayCount} days (${result.metadata.startDate} to ${result.metadata.endDate})`,
            `${entry.path}: the window differs`
        );
        assert.equal(result.metadata.singleDay, false);
    }
});

test('the harness is resolved the same way, including the mochitest case', async () => {
    for (const entry of CORPUS) {
        const result = await cli(entry.path);
        const expected = entry.fixture === 'xpcshell-00.json' ? 'xpcshell' : 'mochitest';
        assert.equal(
            result.harness,
            expected,
            `${entry.path}: the CLI found it under ${result.harness}, and it is in the ` +
                `${expected} fixture`
        );
        assert.equal(pageView(entry, result.harness).harness, expected);
    }
    // Both harnesses are exercised, or the assertion above only proves one
    // branch. `detectHarness` has a documented hole — a mochitest-plain
    // `test_*.js` is classified xpcshell — and both sides retry the other
    // harness, so a corpus of one family would not show the retry working.
    assert.ok(CORPUS.some((entry) => entry.fixture === 'mochitest-00.json'));
    assert.ok(CORPUS.some((entry) => entry.fixture === 'xpcshell-00.json'));
});

// =========================================================================
// 2. Order parity
// =========================================================================

test('the CLI ranks failing configs by rate descending, over the full sequence', async () => {
    // §5's "full ranked sequence, not a spot check". `test` is the page with no
    // ranking to match — the matrix has a fixed layout order, declared in
    // framing.test.ts — so what order parity means here is that the CLI's list
    // is a total order on the key it claims, over every row, and that the key
    // is not the one it is easiest to confuse it with.
    let ranked = 0;
    for (const entry of CORPUS) {
        const result = await cli(entry.path);
        if (result.configs.length < 2) {
            continue;
        }
        ranked++;
        for (let i = 1; i < result.configs.length; i++) {
            assert.ok(
                result.configs[i - 1]!.failRate >= result.configs[i]!.failRate,
                `${entry.path}: not descending by failRate at ${i}`
            );
        }
        // Recomputed from the counts, not read off `failRate`: a `failRate`
        // field that was itself wrong would sort consistently with itself.
        const fromCounts = result.configs.map((config) =>
            config.runCount > 0 ? (config.failCount / config.runCount) * 100 : 0
        );
        for (let i = 0; i < fromCounts.length; i++) {
            assert.equal(
                fromCounts[i],
                result.configs[i]!.failRate,
                `${entry.path}: failRate is not failCount/runCount for ${result.configs[i]!.jobName}`
            );
        }
        for (let i = 1; i < fromCounts.length; i++) {
            assert.ok(fromCounts[i - 1]! >= fromCounts[i]!);
        }
    }
    assert.ok(ranked >= 5, `only ${ranked} tests have more than one failing config`);
});

test('rate and count give different orders somewhere in the corpus', async () => {
    // Without this the assertion above is satisfied by a count ranking too, and
    // the declared rate-vs-count divergence would be untested. Measured: at
    // least one test in the corpus orders differently under the two keys.
    let discriminating = 0;
    for (const entry of CORPUS) {
        const result = await cli(entry.path);
        if (result.configs.length < 2) {
            continue;
        }
        const byCount = [...result.configs].sort((a, b) => b.failCount - a.failCount);
        if (
            JSON.stringify(byCount.map((config) => config.jobName)) !==
            JSON.stringify(result.configs.map((config) => config.jobName))
        ) {
            discriminating++;
        }
    }
    assert.ok(
        discriminating > 0,
        'no test in the corpus orders differently by count and by rate, so the rate assertion ' +
            'above cannot distinguish the two keys'
    );
});

test('the page issue list is count-descending, and so is the CLI within each channel', async () => {
    // The one ordering both sides do have. The page sorts the whole issue list
    // on count (`old/test.html:2551`); the CLI sorts each of its three channels
    // separately. Merging the CLI's channels and re-sorting must reproduce the
    // page's sequence, modulo the two rows the CLI has no channel for.
    for (const entry of CORPUS) {
        const result = await cli(entry.path);
        const view = pageView(entry, result.harness);

        for (let i = 1; i < view.issues.length; i++) {
            assert.ok(
                view.issues[i - 1]!.count >= view.issues[i]!.count,
                `${entry.path}: the page issue list is not count-descending at ${i}`
            );
        }
        for (const channel of [result.messages, result.crashSignatures, result.skips]) {
            for (let i = 1; i < channel.length; i++) {
                assert.ok(
                    channel[i - 1]!.count >= channel[i]!.count,
                    `${entry.path}: a CLI issue channel is not count-descending`
                );
            }
        }

        // The full sequence, compared as (count, kind) rather than as text so
        // the label divergences do not mask an ordering difference. Timeouts
        // used to be dropped from the page side here, because the CLI's three
        // message channels are all keyed on a recorded string and a `TIMEOUT*`
        // group records none — the divergence that made 444 timeouts invisible
        // beside 62 failures (`FX_TESTS_SUMMARY.md` item 10). Both sides now
        // call `buildTestIssues`, so nothing is filtered out.
        const pageSequence = view.issues.map((issue) => `${issue.count}|${issue.type}`);
        const cliSequence = result.issues.map((row) => `${row.count}|${row.type}`);
        assertSameOrder(
            pageSequence,
            cliSequence,
            `${entry.path}: the issue sequences differ`
        );

        // And the same rows, not merely the same shape — including the message
        // text, which the three legacy channels could not match (the page strips
        // the `skip-if: ` prefix and labels an unrecorded failure differently;
        // those two divergences are declared below and are *about the channels*,
        // which is why they do not apply to this list). One shared assembly means
        // one answer, so this is a deep equality rather than an ordering check.
        assert.deepEqual(
            result.issues.map((row) => ({
                count: row.count,
                type: row.type,
                message: row.message,
            })),
            view.issues.map((issue) => ({
                count: issue.count,
                type: issue.type,
                message: issue.message,
            })),
            `${entry.path}: the CLI and the page disagree about the issue list`
        );

        // The list reconciles with the summary bar, which is the property the
        // synthetic difference rows exist to guarantee and the reason a reader
        // can trust the two together. Skips are excluded from the comparison:
        // `buildTestIssues` drops a skip with no message at all rather than
        // inventing a label for it, so the SKIP rows can legitimately total less
        // than `skipCount` (`lib/model/skips.ts` says why every site does this).
        const byType = (type: string): number =>
            result.issues
                .filter((row) => row.type === type)
                .reduce((sum, row) => sum + row.count, 0);
        assert.equal(byType('FAIL'), result.totals.failCount, `${entry.path}: FAIL total`);
        assert.equal(byType('CRASH'), result.totals.crashCount, `${entry.path}: CRASH total`);
        assert.equal(
            byType('TIMEOUT'),
            result.totals.timeoutCount,
            `${entry.path}: TIMEOUT total — the row item 10 is about`
        );
    }
});

// =========================================================================
// 3. Framing parity
// =========================================================================

test('the default CLI view lists only failing configs, and says where the test runs', async () => {
    // The declared narrowing (framing.test.ts's `filters` divergence),
    // measured here rather than read off `CLI.md`: every row in the default
    // view has a failure, `--coverage` has strictly more rows, and the page's
    // matrix is the full population that `--coverage` matches.
    let skippedOnlySeen = 0;
    for (const entry of CORPUS) {
        const result = await cli(entry.path);
        for (const config of result.configs) {
            assert.ok(config.failCount > 0, `${entry.path}: ${config.jobName} has no failures`);
        }
        const full = await cli(entry.path, ['--coverage']);
        assert.ok(full.coverage !== undefined);
        assert.ok(
            full.coverage.configs.length > result.configs.length,
            `${entry.path}: --coverage adds nothing, so the default is not a narrowing`
        );
        // And the narrowing is stated: `reach` covers every config the test
        // *ran* on, so the default cannot be read as "runs nowhere else".
        //
        // Configs that *ran*, not every config in `--coverage`: a config
        // scheduled and only ever skipped is in the coverage matrix and not in
        // reach (`cli/commands/test.ts:654` filters on `runCount > 0`). The
        // distinction is measured on this corpus — 5 of the 16 tests have
        // skipped-only configs, so the two numbers genuinely differ — and it is
        // the right one: "runs on N configs" must not count a config where it
        // never ran.
        assert.ok(result.reach !== null);
        const ranOn = full.coverage.configs.filter((config) => config.runCount > 0).length;
        assert.equal(
            result.reach.configCount,
            ranOn,
            `${entry.path}: reach must count the configs the test ran on`
        );
        assert.ok(
            result.reach.configCount >= result.configs.length,
            `${entry.path}: reach cannot be smaller than the failing-config list`
        );
        if (ranOn < full.coverage.configs.length) {
            skippedOnlySeen++;
        }
    }
    // Or the ran-vs-scheduled distinction above is untested.
    assert.equal(
        skippedOnlySeen,
        5,
        'the number of corpus tests with a scheduled-but-never-run config changed; re-measure ' +
            'rather than relaxing the assertion, because at 0 the reach check stops ' +
            'distinguishing "ran on" from "scheduled on"'
    );
});

test('the page shows every cell where the CLI shows the failing rows', async () => {
    // The other half of the same divergence, from the page's side: the matrix
    // is the full population, so it has strictly more cells with data than the
    // CLI has default rows. Asserting this is what makes "the CLI narrows"
    // a fact about both sides rather than about the CLI alone.
    for (const entry of CORPUS) {
        const result = await cli(entry.path);
        const view = pageView(entry, result.harness);
        const cellsWithRuns = [...view.jobTable.byCell.values()].filter(
            (outcomes) => outcomes.passes + outcomes.failures + outcomes.crashes + outcomes.timeouts > 0
        ).length;
        assert.ok(
            cellsWithRuns >= result.configs.length,
            `${entry.path}: the CLI lists ${result.configs.length} failing configs and the ` +
                `matrix has only ${cellsWithRuns} cells with runs`
        );
    }
});

// =========================================================================
// Declared divergences
// =========================================================================

const DIVERGENCES: Divergence[] = [
    {
        what: 'the label for a failure that recorded no message',
        reason:
            'The same population under two labels. The page says "Failure details not recorded ' +
            '(likely Android or platform logging issue)" — upstream\'s wording, which names the ' +
            'usual cause; the CLI says "(no message recorded)". The counts are asserted equal ' +
            'above after normalizing both to one token, so this is presentation and the ' +
            'population is verified identical. Left as it is because the page\'s sentence is too ' +
            'long for a terminal column and the CLI\'s parenthesis is the convention it uses for ' +
            'every unrecorded value.',
        page: 'Failure details not recorded (likely Android or platform logging issue)',
        cli: '(no message recorded)',
    },
    {
        what: 'platform granularity in the default view',
        reason:
            'The page groups columns by *detailed* platform (`mac-64`, `mac-aarch64`, ' +
            '`windows-32`) and collapses a single-member group to the base; the CLI\'s "Runs on ' +
            'N configs across …" line reports the coarse OS. Two separate implementations — ' +
            '`site/test-view.ts:280` and `lib/query/coverage.ts:394` — and their agreement on ' +
            'the coarse level is asserted above over 300 distinct job names, so the difference ' +
            'is granularity and not classification. Correct on both sides: a matrix has room for ' +
            'six columns and a one-line summary does not, and splitting `mac` into two in a ' +
            'terminal sentence would cost more than it says.',
        page: ['mac-64', 'mac-aarch64', 'windows-32', 'windows-64'],
        cli: ['mac', 'windows'],
    },
];

test('every declared divergence still diverges', () => {
    assertDeclaredDivergences('test', DIVERGENCES);
});

test('every test with timeouts gets a timeout row on BOTH sides', async () => {
    // This test used to assert the opposite — that no CLI channel carried the
    // timeout row — and pinned the size of that divergence at 7 of 16. The
    // divergence is item 10 and is now fixed, so the assertion is inverted rather
    // than deleted: the population it measured is exactly the population that
    // must now agree, and 7 is still the number of corpus tests that have
    // timeouts at all. Checked on the CLI's rendered `Issues` list, not on the
    // legacy channels, because that is the output a reader sees.
    let affected = 0;
    for (const entry of CORPUS) {
        const result = await cli(entry.path);
        const view = pageView(entry, result.harness);
        const pageTimeouts = view.issues.filter((issue) => issue.type === 'TIMEOUT');
        const cliTimeouts = result.issues.filter((row) => row.type === 'TIMEOUT');
        if (entry.stats.timeoutCount === 0) {
            assert.equal(pageTimeouts.length, 0, `${entry.path}: page row with no timeouts`);
            assert.equal(cliTimeouts.length, 0, `${entry.path}: CLI row with no timeouts`);
            continue;
        }
        affected++;
        // One row per side, carrying the whole count: a `TIMEOUT*` group records
        // no `messageIds`, so there is nothing to break it down by.
        assert.equal(pageTimeouts.length, 1, `${entry.path}: the page emits one TIMEOUT row`);
        assert.equal(cliTimeouts.length, 1, `${entry.path}: the CLI emits one TIMEOUT row`);
        assert.equal(
            cliTimeouts[0]!.count,
            entry.stats.timeoutCount,
            `${entry.path}: the CLI TIMEOUT row must carry the whole timeout count`
        );
        assert.equal(
            cliTimeouts[0]!.count,
            pageTimeouts[0]!.count,
            `${entry.path}: the two sides disagree about the timeout count`
        );
        assert.equal(
            cliTimeouts[0]!.message,
            pageTimeouts[0]!.message,
            `${entry.path}: the two sides label the timeout row differently`
        );
    }
    assert.equal(
        affected,
        7,
        'the number of corpus tests with timeouts changed. This is the population ' +
            'item 10 was about, so re-check that the row is still present on both sides.'
    );
});

test('the unexercised skip branches are named rather than claimed as parity', async () => {
    // Honesty about the corpus. Two skip branches differ between the sides on
    // paper and neither fixture exercises them, so nothing above can claim they
    // agree:
    //
    //   - the page drops `run-if` skips from its issue list
    //     (`site/test-view.ts:1255`) and the CLI's `collectSkips` does not;
    //   - the page drops a skip with no message at all and the CLI labels it
    //     `(no reason recorded)`.
    //
    // Asserted as absence, so the day a fixture gains one of these the test
    // fails and someone has to decide what the right answer is instead of the
    // gap staying invisible.
    let runIf = 0;
    let unrecorded = 0;
    for (const entry of CORPUS) {
        runIf += entry.stats.runIfSkipCount;
        const result = await cli(entry.path);
        unrecorded += result.skips.filter((row) => row.message === '(no reason recorded)').length;
    }
    assert.equal(
        runIf,
        0,
        'a fixture now contains a run-if skip. The page excludes it from the issue list and the ' +
            'CLI does not, so the skip comparison above will fail — resolve which side is right ' +
            'rather than widening the normalization.'
    );
    assert.equal(
        unrecorded,
        0,
        'a fixture now contains a skip with no message. The page omits it and the CLI labels it, ' +
            'so the skip comparison above will fail.'
    );
});
