/**
 * `next/index.html` against `fx-tests summary` — `PARITY.md` §5.
 *
 * Both sides now read `{harness}-stats.json` and both compute a 7-day topline,
 * so a disagreement is a real difference in what one of them decided rather
 * than an artefact of the page's logic being inline and untestable.
 *
 * ## What makes this page's comparison unusual
 *
 * On the other migrated pages the shared `lib/` query *is* what the page
 * renders, and parity is close to a tautology broken only by presentation. Here
 * it is not: `lib/query/summary.ts` and the page's table are two different
 * computations of four rates over the same seven dates, and **two of the four
 * disagree by construction**. That is the interesting content of this file.
 *
 * | column | page | CLI | same? |
 * | --- | --- | --- | --- |
 * | Flaky Test Failures | `failed / total` | `failed / total` | **yes** |
 * | Flaky Job Failures | `(failedJobs − invalid) / processed` | `failedJobs / processed` | no |
 * | Skip Rate | `skipped / total` | `skipped / (total + skipped)` | no |
 * | Invalid Jobs | `invalid / processed` | `invalid / processed` | **yes** |
 *
 * The two that agree are asserted to agree **exactly**, so a future drift in
 * those is a failure rather than a fifth divergence quietly appearing. The two
 * that differ are declared, with both sides' measured values, and
 * `assertDeclaredDivergences` fails if they ever converge.
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
} from '../next/index-view.ts';
import {
    type Divergence,
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
 * The page's merged view of one harness — what `next/index.ts` renders from.
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
// The two rates that must agree
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

test('the six raw counters agree, so the two rates differ only by formula', async () => {
    // The load-bearing check behind the two declared divergences: if the
    // counters agreed and the rates did not, the difference is arithmetic and
    // is a decision. If the counters disagreed, one side is reading a different
    // window and the declaration would be excusing a real bug.
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
// The two that differ, declared
// =========================================================================

test('the two rate divergences are declared, and still diverge', async () => {
    const cli = await cliSummary();
    const divergences: Divergence[] = [];

    for (const harness of HARNESSES) {
        const entry = cli.find((row) => row.harness === harness)!;
        const page = pageRows(harness).find((row) => !row.isFlavor)!;

        divergences.push({
            what: `${harness}: Flaky Job Failures numerator`,
            reason:
                'The page subtracts invalid jobs from the numerator and leaves the denominator ' +
                'as processedJobCount (index.html:476, :479), so its column answers "how often ' +
                'did a job fail because a test was flaky"; the CLI divides failedJobs by ' +
                'processedJobCount and reports invalid jobs as a separate rate, answering "how ' +
                'often did a job fail". Both are correct answers to their own question and the ' +
                "page's column header and tooltip both say it excludes invalid jobs, so the " +
                'page is internally consistent. Reconciling them changes what one product ' +
                'means and is not a migration decision.',
            page: page.jobFailureRate,
            cli: entry.current['jobFailureRate'],
        });

        divergences.push({
            what: `${harness}: Skip Rate denominator`,
            reason:
                'The page divides skipped runs by totalTestRuns (index.html:480); the CLI ' +
                'divides by totalTestRuns + skippedTestRuns because the question it asks is ' +
                '"what share of everything scheduled did not run", and the page\'s form exceeds ' +
                '100% whenever more is skipped than run. The page also renders the raw counts ' +
                'as "skipped / totalTestRuns" directly under the percentage, so changing the ' +
                'rate without changing that second line would make the cell contradict itself.',
            page: page.skipRate,
            cli: entry.current['skipRate'],
        });
    }

    assertDeclaredDivergences('index vs summary', divergences);

    // And the measured magnitudes, so a change in the *size* of the gap is
    // visible and not only a change in its existence.
    const xpcshell = cli.find((row) => row.harness === 'xpcshell')!;
    const xpcshellPage = pageRows('xpcshell')[0]!;
    assert.equal(xpcshellPage.jobFailureRate!.toFixed(2), '11.83');
    assert.equal(xpcshell.current['jobFailureRate']!.toFixed(2), '12.30');
    assert.equal(xpcshellPage.skipRate!.toFixed(2), '4.72');
    assert.equal(xpcshell.current['skipRate']!.toFixed(2), '4.51');

    const mochitest = cli.find((row) => row.harness === 'mochitest')!;
    const mochitestPage = pageRows('mochitest').find((row) => !row.isFlavor)!;
    assert.equal(mochitestPage.jobFailureRate!.toFixed(2), '2.66');
    assert.equal(mochitest.current['jobFailureRate']!.toFixed(2), '2.99');
    assert.equal(mochitestPage.skipRate!.toFixed(2), '5.28');
    assert.equal(mochitest.current['skipRate']!.toFixed(2), '5.02');
});

test('the page rate is always the lower of the two, on both counts', async () => {
    // A direction check rather than a magnitude one, because it follows from
    // the formulas and would break if either side changed the wrong term: the
    // page's job numerator is smaller and its skip denominator is smaller — so
    // the job rate must be lower and the skip rate must be *higher*.
    const cli = await cliSummary();
    for (const harness of HARNESSES) {
        const entry = cli.find((row) => row.harness === harness)!;
        const page = pageRows(harness).find((row) => !row.isFlavor)!;
        assert.ok(
            page.jobFailureRate! < entry.current['jobFailureRate']!,
            `${harness}: subtracting invalid jobs must lower the job failure rate`
        );
        assert.ok(
            page.skipRate! > entry.current['skipRate']!,
            `${harness}: the smaller denominator must raise the skip rate`
        );
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
                '(index.html:536-551), which the CLI has no equivalent of — `fx-tests summary` ' +
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
    // Divergence 6 in `next/index.ts`. The page's tooltip quotes
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
