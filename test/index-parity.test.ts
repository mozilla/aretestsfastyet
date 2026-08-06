/**
 * `site/index.html` against `fx-tests summary` — `PARITY.md` §5.
 *
 * Both sides now read `{harness}-stats.json` and both compute a 7-day topline,
 * so a disagreement is a real difference in what one of them decided rather
 * than an artefact of the page's logic being inline and untestable.
 *
 * ## What makes this page's comparison unusual
 *
 * On the other migrated pages the shared `lib/` query *is* what the page
 * renders, and parity is close to a tautology broken only by presentation. Here
 * it is not: `lib/query/summary.ts` and the page's table are two independent
 * computations of four rates over the same seven dates. They now agree on all
 * four, and **nothing in the code makes them agree** — no import, no shared
 * helper — so these assertions are the only thing holding them together.
 *
 * | column | both sides compute | note |
 * | --- | --- | --- |
 * | Flaky Test Failures | `failed / total` | agreed from the start |
 * | Flaky Job Failures | `failedJobs / (processed + invalid)` | both sides corrected |
 * | Skip Rate | `skipped / total` | the CLI was corrected |
 * | Invalid Jobs | `invalid / processed` | agreed from the start |
 *
 * Two of the four used to be declared divergences. They are not any more:
 *
 * - the page computed `(failedJobs − invalid) / processed` and the CLI
 *   `failedJobs / processed`, and **both denominators were wrong** —
 *   `failedJobs` is counted over the whole day's non-ignored jobs, which is
 *   `processed + invalid` (`fetch-test-data.js:1821`, `:267-282`);
 * - the CLI divided skips by `total + skipped`, but the generator adds every
 *   run to `totalTestRuns` *before* dispatching on status (`:2733`), so the
 *   skips were counted twice.
 *
 * All four are now asserted to agree to full float precision, so a future
 * divergence in any of them is a failure rather than something appearing
 * quietly.
 *
 * ## The three classes, and which tests cover which
 *
 * 1. **Value parity** — the four rates and the six raw counters, field by
 *    field, on both harnesses.
 * 2. **Order parity** — the full row sequence, compared position by position.
 *    Cheap here because neither side sorts, which is itself the property being
 *    pinned: `PARITY.md` §1 counts a wrong sort key among the defects that
 *    produced correct numbers.
 * 3. **Framing parity** — the row unit, the window, the sort and the file read,
 *    derived from the page and asserted against the CLI.
 *
 * ## The data is pinned, and an unpinned request fails loudly
 *
 * The checked-in fixtures, read from disk, with a source that rejects any name
 * it was not given. `test/framing.test.ts` already asserts the CLI asks for
 * `{harness}-timings/{harness}-stats.json`; this file asserts the *page* reads
 * the same two names under the same two indices, which is the half that would
 * otherwise be assumed.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { StatsFile } from '../lib/formats/stats.ts';
import { DEFAULT_SUMMARY_DAYS, computeSummary } from '../lib/query/summary.ts';
import { timingsIndex } from '../lib/sources/source.ts';
import {
    type MergedStats,
    type SummaryRow,
    MOCHITEST_FLAVORS,
    SUMMARY_DAYS,
    mergeBackfillStats,
    summaryRows,
} from '../site/index-view.ts';
import {
    assertDeclaredDivergences,
    assertSameOrder,
    fixtureSource,
    invoke,
    json,
} from './parity-harness.ts';

const ROOT = new URL('../', import.meta.url);
const FIXTURES = new URL('./fixtures/', import.meta.url);

const HARNESSES = ['xpcshell', 'mochitest'] as const;

function statsFixture(harness: string): StatsFile {
    return JSON.parse(
        readFileSync(new URL(`./${harness}-stats.json`, FIXTURES), 'utf8')
    ) as StatsFile;
}

function backfillFile(): StatsFile {
    return JSON.parse(
        readFileSync(new URL('mochitest-stats-backfill.json', ROOT), 'utf8')
    ) as StatsFile;
}

/**
 * The page's merged view of one harness — what `site/index.ts` renders from.
 *
 * xpcshell has no committed backfill (`ls *-stats-backfill.json` is one entry),
 * so its merge is a no-op and the two sides read the identical dates.
 */
function pageStats(harness: string): MergedStats {
    const live = statsFixture(harness);
    return mergeBackfillStats(harness === 'mochitest' ? backfillFile() : null, live).stats;
}

/** The page's summary rows for one harness on its own. */
function pageRows(harness: string): SummaryRow[] {
    return harness === 'xpcshell'
        ? summaryRows(pageStats('xpcshell'), null)
        : summaryRows(null, pageStats('mochitest'));
}

/** The CLI's `summary --json`, over the pinned stats files. */
async function cliSummary(): Promise<
    {
        harness: string;
        current: Record<string, number | null> & { dayCount: number; endDate: string };
        prior: (Record<string, number | null> & { dayCount: number }) | null;
        delta: Record<string, number | null>;
    }[]
> {
    const source = fixtureSource({
        'xpcshell-timings/xpcshell-stats.json': 'xpcshell-stats.json',
        'mochitest-timings/mochitest-stats.json': 'mochitest-stats.json',
    });
    const result = await invoke(['summary', '--json'], { source });
    return json<{ harnesses: never[] }>(result).harnesses;
}

// =========================================================================
// All four rates must agree
// =========================================================================

test('the test failure rate is identical on both sides', async () => {
    // Not a tautology: the two are computed by different code over different
    // shapes — the page sums a merged series with `sumSeries`, the CLI
    // transposes into rows with `statsRows`. Asserted to full float precision,
    // not to two decimals, so a rounding difference is visible.
    const cli = await cliSummary();
    for (const harness of HARNESSES) {
        const entry = cli.find((row) => row.harness === harness)!;
        const page = pageRows(harness).find((row) => !row.isFlavor)!;
        assert.equal(
            page.testFailureRate,
            entry.current['testFailureRate'],
            `${harness}: the test failure rate must not drift`
        );
    }
});

test('the invalid job rate is identical on both sides', async () => {
    const cli = await cliSummary();
    for (const harness of HARNESSES) {
        const entry = cli.find((row) => row.harness === harness)!;
        const page = pageRows(harness).find((row) => !row.isFlavor)!;
        assert.equal(
            page.invalidJobRate,
            entry.current['invalidJobRate'],
            `${harness}: the invalid job rate must not drift`
        );
    }
});

test('the six raw counters agree, so a rate difference could only be a formula', async () => {
    // The load-bearing check behind the four rate assertions: with the counters
    // pinned equal, any disagreement above is arithmetic and nothing else. If
    // the counters disagreed, one side would be reading a different window and
    // a matching rate could be two errors cancelling.
    const cli = await cliSummary();
    for (const harness of HARNESSES) {
        const entry = cli.find((row) => row.harness === harness)!;
        const page = pageRows(harness).find((row) => !row.isFlavor)!;
        for (const key of [
            'totalTestRuns',
            'failedTestRuns',
            'skippedTestRuns',
            'processedJobCount',
            'failedJobs',
            'invalidJobs',
        ] as const) {
            assert.equal(
                page.totals[key],
                entry.current[key],
                `${harness}: ${key} must be the same number on both sides`
            );
        }
    }
});

// =========================================================================
// The two that used to differ
// =========================================================================

test('the job failure rate is identical on both sides', async () => {
    // Formerly a declared divergence: the page computed
    // `(failedJobs − invalid) / processed` and the CLI `failedJobs / processed`.
    // Both were wrong in the denominator and both were corrected to
    // `failedJobs / (processed + invalid)`. Full float precision, so a
    // divergence too small to survive `toFixed(2)` still fails.
    const cli = await cliSummary();
    for (const harness of HARNESSES) {
        const entry = cli.find((row) => row.harness === harness)!;
        const page = pageRows(harness).find((row) => !row.isFlavor)!;
        assert.equal(
            page.jobFailureRate,
            entry.current['jobFailureRate'],
            `${harness}: the job failure rate must not drift`
        );
    }
});

test('the skip rate is identical on both sides', async () => {
    // Formerly a declared divergence: the CLI divided by
    // `totalTestRuns + skippedTestRuns`, double-counting skips that
    // `totalTestRuns` already contained.
    const cli = await cliSummary();
    for (const harness of HARNESSES) {
        const entry = cli.find((row) => row.harness === harness)!;
        const page = pageRows(harness).find((row) => !row.isFlavor)!;
        assert.equal(
            page.skipRate,
            entry.current['skipRate'],
            `${harness}: the skip rate must not drift`
        );
    }
});

test('both sides match a third computation read straight off the fixture', async () => {
    // Neither side is the oracle here. The expected values come from summing
    // the raw JSON arrays in this file, so "the page and the CLI agree" cannot
    // be satisfied by two copies of the same wrong formula — which is exactly
    // what the job failure rate was before, on both sides at once.
    const cli = await cliSummary();
    for (const harness of HARNESSES) {
        const raw = JSON.parse(
            readFileSync(new URL(`fixtures/${harness}-stats.json`, import.meta.url), 'utf8')
        ) as Record<string, (number | null)[]>;
        const last7 = (key: string): number =>
            raw[key]!.slice(-SUMMARY_DAYS).reduce<number>((sum, v) => sum + (v ?? 0), 0);

        const totalTestRuns = last7('totalTestRuns');
        const failedTestRuns = last7('failedTestRuns');
        const skippedTestRuns = last7('skippedTestRuns');
        const processedJobCount = last7('processedJobCount');
        const failedJobs = last7('failedJobs');
        const invalidJobs = last7('invalidJobs');

        const expected = {
            testFailureRate: (failedTestRuns / totalTestRuns) * 100,
            jobFailureRate: (failedJobs / (processedJobCount + invalidJobs)) * 100,
            skipRate: (skippedTestRuns / totalTestRuns) * 100,
            invalidJobRate: (invalidJobs / processedJobCount) * 100,
        };

        const entry = cli.find((row) => row.harness === harness)!;
        const page = pageRows(harness).find((row) => !row.isFlavor)!;
        for (const [key, value] of Object.entries(expected)) {
            assert.equal(page[key as keyof typeof expected], value, `${harness}: page ${key}`);
            assert.equal(entry.current[key], value, `${harness}: CLI ${key}`);
        }
    }
});

test('the corrected job denominator is strictly wider than the old one', async () => {
    // A direction check, so a regression that reverted only the denominator
    // fails here even if both sides reverted together and stayed equal: the
    // window has invalid jobs, so `processed + invalid` is a bigger number and
    // the rate must be *below* `failedJobs / processed`.
    const cli = await cliSummary();
    for (const harness of HARNESSES) {
        const entry = cli.find((row) => row.harness === harness)!;
        const page = pageRows(harness).find((row) => !row.isFlavor)!;
        assert.ok(page.totals.invalidJobs > 0, `${harness}: the window must have invalid jobs`);
        assert.equal(
            page.jobPopulation,
            page.totals.processedJobCount + page.totals.invalidJobs
        );
        const old = (page.totals.failedJobs / page.totals.processedJobCount) * 100;
        assert.ok(page.jobFailureRate! < old, `${harness}: page rate must be below the old form`);
        assert.ok(
            entry.current['jobFailureRate']! < old,
            `${harness}: CLI rate must be below the old form`
        );
        // And above the page's older still `(failed − invalid) / processed`.
        const older =
            ((page.totals.failedJobs - page.totals.invalidJobs) /
                page.totals.processedJobCount) *
            100;
        assert.ok(page.jobFailureRate! > older, `${harness}: and above the subtracting form`);
    }
});

// =========================================================================
// Window parity
// =========================================================================

test('both sides use the same 7-day window, over the same dates', async () => {
    const cli = await cliSummary();
    for (const harness of HARNESSES) {
        const entry = cli.find((row) => row.harness === harness)!;
        const page = pageRows(harness).find((row) => !row.isFlavor)!;
        assert.equal(entry.current.dayCount, SUMMARY_DAYS);
        assert.equal(page.totals.dates.length, SUMMARY_DAYS);
        assert.equal(
            page.totals.dates[page.totals.dates.length - 1],
            entry.current.endDate,
            `${harness}: both periods must end on the same date`
        );
    }
});

test('the page constant and the CLI default agree, for independent reasons', () => {
    // Not imported from each other, deliberately: the page's 7 comes from its
    // heading and `getRecentStats(stats, 7)`, and the CLI's comes from the
    // weekend-mix argument in `lib/query/summary.ts`. They agree today for two
    // separate reasons, and this notices if either moves.
    assert.equal(SUMMARY_DAYS, DEFAULT_SUMMARY_DAYS);
});

test('the backfill merge does not move the summary window', () => {
    // The page renders the *merged* file and the CLI reads the *live* one, so
    // the two would silently disagree if the merge touched any of the last
    // seven dates. It does not — the backfill ends 2026-06-10 and live runs to
    // 2026-08-03 — and this is what makes the counter comparison above valid.
    const live = statsFixture('mochitest');
    const merged = pageStats('mochitest');
    const liveRows = summaryRows(null, mergeBackfillStats(null, live).stats);
    const mergedRows = summaryRows(null, merged);
    assert.deepEqual(
        mergedRows.find((row) => !row.isFlavor)!.totals,
        liveRows.find((row) => !row.isFlavor)!.totals,
        'the merge only adds dates older than the summary window'
    );
    // And it really did add dates, or the assertion above proves nothing.
    assert.ok(merged.dates.length > live.dates.length);
    assert.equal(merged.dates.length, 198);
    assert.equal(live.dates.length, 66);
});

// =========================================================================
// Framing parity
// =========================================================================

test('both sides read the same two files, under the same two indices', async () => {
    // The page's half of what `framing.test.ts` asserts for the CLI. Confirmed
    // from `fetch-utils.js:212-222` rather than guessed: it derives the harness
    // from the filename prefix and asks `test-info-{harness}-timings`, which is
    // exactly what `timingsIndex()` builds for the CLI.
    const source = fixtureSource({
        'xpcshell-timings/xpcshell-stats.json': 'xpcshell-stats.json',
        'mochitest-timings/mochitest-stats.json': 'mochitest-stats.json',
    });
    await invoke(['summary', '--json'], { source });
    assert.deepEqual(
        [...source.requested].sort(),
        HARNESSES.map((harness) => `${timingsIndex(harness)}/${harness}-stats.json`).sort()
    );

    // And the page asks `fetchData` for the bare filenames, which `fetch-utils`
    // resolves to those same two indices. Asserted against the controller's
    // recorded requests in `test/index-page.test.ts`; named here so the
    // index-resolution rule is written down in one place.
    assert.equal(timingsIndex('xpcshell'), 'xpcshell-timings');
    assert.equal(timingsIndex('mochitest'), 'mochitest-timings');
});

test('neither side sorts: the row order is identical and it is source order', async () => {
    // Order parity. The sort-key defect produced the same set in a different
    // order and would pass any set comparison, so the sequence is compared
    // position by position.
    const cli = await cliSummary();
    assertSameOrder(
        cli.map((entry) => entry.harness),
        ['xpcshell', 'mochitest'],
        'the CLI lists harnesses in source order'
    );
    const pageAll = summaryRows(pageStats('xpcshell'), pageStats('mochitest'));
    assertSameOrder(
        pageAll.filter((row) => !row.isFlavor).map((row) => row.kind),
        ['xpcshell', 'mochitest'],
        'the page lists harnesses in the same source order'
    );
});

test('the page adds a flavor breakdown the CLI does not have', async () => {
    // A framing difference in the *row unit*, declared. This is the one that a
    // value comparison cannot see at all: both sides agree on every harness
    // number and the page simply shows eight more rows.
    const cli = await cliSummary();
    const pageAll = summaryRows(pageStats('xpcshell'), pageStats('mochitest'));

    assertDeclaredDivergences('index vs summary: row unit', [
        {
            what: 'row unit below the harness level',
            reason:
                'The page indents one sub-row per mochitest flavor under the Mochitest row ' +
                '(old/index.html:536-551), which the CLI has no equivalent of — `fx-tests summary` ' +
                'is one block per harness. The flavors are not a filter or a sort of the ' +
                'harness rows but an extra level, and they do not sum to the aggregate above ' +
                'them: measured, the eight flavors account for 60,101,543 of the 60,119,846 ' +
                'mochitest test runs in the window, an 18,303 shortfall. A CLI flag for them ' +
                'would be a new feature, not parity.',
            page: pageAll.map((row) => row.name),
            cli: cli.map((entry) => entry.harness),
        },
    ]);

    // The flavor rows are the difference, and they are exactly the eight listed.
    assert.deepEqual(
        pageAll.filter((row) => row.isFlavor).map((row) => row.name),
        MOCHITEST_FLAVORS.map((flavor) => flavor.name)
    );
    assert.equal(cli.length, 2);
});

test('the prior-period comparison the page borrows is the CLI\'s own', async () => {
    // Divergence 6 in `site/index.ts`. The page's tooltip quotes
    // `computeSummary`, so this asserts the two produce the same comparison
    // rather than the page having grown a second implementation of it.
    const cli = await cliSummary();
    for (const harness of HARNESSES) {
        const entry = cli.find((row) => row.harness === harness)!;
        const local = computeSummary(statsFixture(harness));
        assert.equal(local.current.testFailureRate, entry.current['testFailureRate']);
        assert.equal(local.prior?.dayCount, entry.prior?.dayCount);
        assert.equal(local.delta.testFailureRate, entry.delta['testFailureRate']);
        assert.equal(local.prior?.dayCount, SUMMARY_DAYS, 'a full prior period exists');
    }
});

test('the CLI reports no negative rate on the pinned data, and neither does the page', async () => {
    // The page's job-failure numerator can go negative and the CLI's cannot.
    // Both are checked, because the interesting claim is that the *page* is
    // non-negative here — the CLI is non-negative by construction.
    const cli = await cliSummary();
    for (const entry of cli) {
        for (const key of ['jobFailureRate', 'invalidJobRate', 'skipRate', 'testFailureRate']) {
            assert.ok((entry.current[key] ?? 0) >= 0, `cli ${entry.harness} ${key}`);
        }
    }
    for (const row of summaryRows(pageStats('xpcshell'), pageStats('mochitest'))) {
        assert.ok(
            (row.jobFailureRate ?? 0) >= 0,
            `${row.name}: the page's subtraction stayed positive`
        );
    }
});
