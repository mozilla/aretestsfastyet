/**
 * `site/issues.html` against `fx-tests issues` — `PARITY.md` §5.
 *
 * The comparison this migration was sequenced last to make. Both sides now
 * read the same 21-day aggregate through `lib/query/issues.ts`, so a
 * disagreement is a real difference in what one of them decided rather than an
 * artefact of the page's logic being inline and untestable.
 *
 * ## What changed to make this comparison possible
 *
 * Before the migration the two answered different questions: `issues.html`
 * ranked components over the **single most recent day** and `fx-tests issues`
 * over **21 days**. `test/framing.test.ts` carried that as a declared
 * divergence whose reason said it "closes when the page migrates". It has;
 * `site/issues-view.ts`'s `isHistoricalDate` treats an absent `date` as the
 * aggregate, so the windows agree and the entry is gone.
 *
 * That is why the framing block below asserts agreement rather than recording a
 * gap — and why the one thing it must still check is that both sides really do
 * read the same file, since a page that agreed on the label while loading a
 * different window would pass a label check.
 *
 * ## The three classes, and which tests cover which
 *
 * `PARITY.md` §1 counts six reported defects of which **four produced correct
 * numbers**, so all three classes are here:
 *
 * 1. **Value parity** — the same counters on the same components, asserted
 *    field by field over the whole ranking rather than on a spot check.
 * 2. **Order parity** — the full ranked sequence, position by position. The
 *    sort-key defect produced the same set in a different order and would pass
 *    any set comparison.
 * 3. **Framing parity** — row unit, grouping, sort key, direction and window.
 *    This is the check that was missing when `issues` shipped a flat test list.
 *
 * ## The data is pinned
 *
 * The checked-in `test/fixtures/xpcshell-issues.json`, read from disk on the
 * page side and served to the CLI through `parity-harness`'s fixture source.
 * No network and no cache: an unpinned request throws `DataFileNotFoundError`
 * rather than silently comparing against live CI, which is a failure mode this
 * project has hit three times.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeIssues } from '../lib/formats/issues.ts';
import type { IssuesFile } from '../lib/formats/issues.ts';
import {
    type IssueFilters,
    ALL_FILTERS,
    INITIAL_SORT,
    buildComponentRows,
    sortComponents,
} from '../site/issues-view.ts';
import {
    type Divergence,
    assertDeclaredDivergences,
    assertSameOrder,
    fixtureSource,
    invoke,
} from './parity-harness.ts';

const raw = JSON.parse(
    readFileSync(new URL('./fixtures/xpcshell-issues.json', import.meta.url), 'utf8')
) as IssuesFile;

/** The page's default view: 21-day aggregate, all four types, no search. */
function pageRows(filters: IssueFilters = ALL_FILTERS) {
    const file = decodeIssues(structuredClone(raw));
    return sortComponents(buildComponentRows(file, filters, ''), INITIAL_SORT, filters);
}

interface CliRow {
    key: string;
    testCount: number;
    totalTestCount: number;
    runCount: number;
    failCount: number;
    timeoutCount: number;
    crashCount: number;
    skipCount: number;
    issueCount: number;
    issueRate: number;
}

/**
 * `fx-tests issues --json`, uncapped, against the **same fixture file** the
 * page side reads.
 *
 * The source is pinned to that one file by name. Anything else the command
 * asks for throws `DataFileNotFoundError` rather than falling through to the
 * network — which is the failure this project has hit three times, most
 * recently a 404 pattern that let every request reach live CI and invalidated
 * a whole comparison run.
 */
async function cliRows(
    args: string[] = []
): Promise<{ rows: CliRow[]; result: Record<string, unknown>; requested: string[] }> {
    const source = fixtureSource({
        'xpcshell-timings/xpcshell-issues.json': 'xpcshell-issues.json',
    });
    const { code, stdout, stderr, requested } = await invoke(
        ['issues', '--json', '--limit', '0', ...args],
        { source }
    );
    assert.equal(code, 0, `the command must succeed: ${stderr}`);
    const result = JSON.parse(stdout) as Record<string, unknown>;
    return { rows: result['rows'] as CliRow[], result, requested };
}

test('the CLI reads the pinned fixture and nothing else', async () => {
    // The snapshot-identity assertion. Both sides must be looking at the same
    // bytes, or every number below is comparing two different windows.
    const { requested } = await cliRows();
    assert.ok(
        requested.includes('xpcshell-timings/xpcshell-issues.json'),
        `expected the pinned aggregate, got ${requested.join(', ')}`
    );
    for (const name of requested) {
        assert.match(
            name,
            /^xpcshell-timings\/(index|xpcshell-issues)\.json$/,
            `unpinned request: ${name}`
        );
    }
});

// =========================================================================
// 1. Value parity
// =========================================================================

test('every component the CLI reports carries the page\'s numbers', async () => {
    const { rows: cli } = await cliRows();
    const page = pageRows();
    const byKey = new Map(page.map((row) => [row.key, row]));

    assert.ok(cli.length > 0, 'the fixture must produce rows');
    for (const row of cli) {
        const mine = byKey.get(row.key);
        assert.ok(mine !== undefined, `the page has no row for ${row.key}`);
        // Field by field, and every field — a subset check would let a
        // counter drift unnoticed, which is how "right numbers, wrong
        // question" got through before.
        assert.equal(mine.stats.runCount, row.runCount, `${row.key} runCount`);
        assert.equal(mine.stats.failCount, row.failCount, `${row.key} failCount`);
        assert.equal(mine.stats.timeoutCount, row.timeoutCount, `${row.key} timeoutCount`);
        assert.equal(mine.stats.crashCount, row.crashCount, `${row.key} crashCount`);
        assert.equal(mine.stats.skipCount, row.skipCount, `${row.key} skipCount`);
        assert.equal(mine.stats.issueCount, row.issueCount, `${row.key} issueCount`);
        assert.equal(mine.stats.issueRate, row.issueRate, `${row.key} issueRate`);
        // The two test counts, which mean different things and must both
        // agree: "N with issues, out of M".
        assert.equal(mine.tests.length, row.testCount, `${row.key} tests with issues`);
        assert.equal(mine.totalTestCount, row.totalTestCount, `${row.key} total tests`);
    }
});

test('the Issue% denominator is the same on both sides', async () => {
    // The number the brief singled out. Asserted as the *identity* rather than
    // by comparing two rates: a page and a CLI that both divided by the wrong
    // thing would agree with each other, so the denominator is reconstructed
    // here from the counters and checked against the reported rate.
    const { rows: cli } = await cliRows();
    for (const row of cli) {
        const denominator = row.runCount + row.skipCount; // skips are enabled
        const expected = denominator > 0 ? (row.issueCount / denominator) * 100 : 0;
        assert.equal(
            row.issueRate,
            expected,
            `${row.key}: the rate must be issueCount / (runCount + skipCount) — runCount ` +
                'excludes skips, so they are added back exactly because they are in the numerator'
        );
    }
    // And the discriminating case: a component with skips, where the two
    // candidate denominators differ.
    const withSkips = cli.find((row) => row.skipCount > 0)!;
    assert.notEqual(
        withSkips.issueRate,
        (withSkips.issueCount / withSkips.runCount) * 100,
        'dividing by runCount alone would be a different number, so this is not vacuous'
    );
});

test('a component total covers its clean tests on both sides', async () => {
    // The `keepClean` property. A CLI that summed only the failing tests would
    // report a higher rate from the same data — measured at
    // `lib/query/issues.ts:99-106` as 8.7% becoming 8.8%.
    const { rows: cli } = await cliRows();
    const page = pageRows();
    const byKey = new Map(page.map((row) => [row.key, row]));

    assert.ok(
        cli.some((row) => row.totalTestCount > row.testCount),
        'the fixture must have a component with a clean test, or this asserts nothing'
    );
    for (const row of cli) {
        const mine = byKey.get(row.key)!;
        const listedRuns = mine.tests.reduce((sum, testRow) => sum + testRow.runCount, 0);
        assert.ok(
            mine.stats.runCount >= listedRuns,
            `${row.key}: the component total cannot be smaller than the tests it lists`
        );
        if (row.totalTestCount > row.testCount) {
            assert.ok(
                mine.stats.runCount > listedRuns,
                `${row.key}: a clean test's runs must be inside the component total`
            );
        }
    }
});

test('--type narrows both sides the same way', async () => {
    // The checkboxes map to repeatable `--type`, which `PARITY.md` §5 asks to
    // be driven as a matrix rather than assumed.
    const cases: [string[], IssueFilters][] = [
        [['--type', 'fail'], { failures: true, timeouts: false, crashes: false, skips: false }],
        [
            ['--type', 'fail', '--type', 'timeout'],
            { failures: true, timeouts: true, crashes: false, skips: false },
        ],
        [
            ['--type', 'fail', '--type', 'timeout', '--type', 'crash'],
            { failures: true, timeouts: true, crashes: true, skips: false },
        ],
        [['--type', 'skip'], { failures: false, timeouts: false, crashes: false, skips: true }],
    ];
    for (const [args, filters] of cases) {
        const { rows: cli } = await cliRows(args);
        const byKey = new Map(pageRows(filters).map((row) => [row.key, row]));
        assert.ok(cli.length > 0, `${args.join(' ')} produced no rows`);
        for (const row of cli) {
            const mine = byKey.get(row.key);
            assert.ok(mine !== undefined, `${args.join(' ')}: no page row for ${row.key}`);
            assert.equal(mine.stats.issueCount, row.issueCount, `${args.join(' ')} ${row.key} issues`);
            assert.equal(mine.stats.issueRate, row.issueRate, `${args.join(' ')} ${row.key} rate`);
        }
    }
});

// =========================================================================
// 2. Order parity
// =========================================================================

test('the ranked sequence is the same, position by position', async () => {
    // Not a set comparison. The sort-key defect produced the same set in a
    // different order, so the whole sequence is compared.
    const { rows: cli } = await cliRows();
    const page = pageRows().filter((row) => row.tests.length > 0);

    assertSameOrder(
        page.map((row) => row.key),
        cli.map((row) => row.key),
        'issues: the component ranking'
    );
    // And it really is descending by issue count, on both sides — an order
    // that matched while both were wrong would pass the check above.
    for (let i = 1; i < cli.length; i++) {
        assert.ok(cli[i - 1]!.issueCount >= cli[i]!.issueCount, 'CLI descending');
    }
    for (let i = 1; i < page.length; i++) {
        assert.ok(page[i - 1]!.stats.issueCount >= page[i]!.stats.issueCount, 'page descending');
    }
});

// =========================================================================
// 3. Framing parity
// =========================================================================

test('both sides group by component over the same 21-day window', async () => {
    const { result } = await cliRows();
    assert.equal(result['groupBy'], 'component');
    assert.equal(result['sort'], 'issues');

    const header = result['header'] as { dayCount: number; singleDay: boolean; harness: string };
    assert.equal(header.singleDay, false, 'the CLI covers the whole window');
    assert.equal(header.dayCount, 21);
    assert.equal(header.harness, 'xpcshell');

    // The page side: the same window, and — the load-bearing half — the same
    // *file*. Both are read off the source rather than restated, because a
    // page that agreed on the label while fetching a daily file would pass any
    // assertion written against the label alone.
    const { isHistoricalDate } = await import('../site/issues-view.ts');
    assert.equal(isHistoricalDate(undefined), true, 'no hash means the aggregate');
    const controller = readFileSync(new URL('../site/issues.ts', import.meta.url), 'utf8');
    assert.match(
        controller,
        /historicalDataFile: `\$\{harness\}-issues\.json`/,
        'and the aggregate is `{harness}-issues.json`, the file the CLI reads'
    );

    // The row unit really is a component on both sides, not just labelled one.
    for (const row of (result['rows'] as CliRow[]).slice(0, 20)) {
        assert.match(row.key, / :: |^\(no component\)$/, `${row.key} is not a component`);
    }
});

test('both sides count all four issue types by default', async () => {
    const { result } = await cliRows();
    assert.deepEqual([...(result['types'] as string[])].sort(), ['crash', 'fail', 'skip', 'timeout']);
    // The page's four checkboxes are all `checked` in the markup this
    // migration kept byte-identical, so the page default is read off the page.
    const markup = readFileSync(new URL('../site/issues.html', import.meta.url), 'utf8');
    for (const id of ['filter-failures', 'filter-timeouts', 'filter-crashes', 'filter-skips']) {
        const pattern = new RegExp(`id="${id}"[^>]*\\bchecked\\b`);
        assert.match(markup, pattern, `${id} must be checked by default`);
    }
});

// =========================================================================
// The declared divergences
// =========================================================================

test('the page and the CLI differ only where declared', async () => {
    const { rows: cli } = await cliRows();
    const page = pageRows();

    const cliKeys = new Set(cli.map((row) => row.key));
    const pageOnly = page.filter((row) => !cliKeys.has(row.key));

    // The clean-component divergence needs a component whose every test is
    // clean, and the checked-in fixture has none — all three of its components
    // have at least one test with an issue. Rather than assert the difference
    // from the larger file (which this suite does not read) or state it
    // without exercising it, it is reached the way a reader reaches it: with
    // `--type crash`, on which two of the three components have no issue at
    // all. The page keeps them as `(N tests)` rows and the CLI drops them.
    const crashOnly: IssueFilters = {
        failures: false,
        timeouts: false,
        crashes: true,
        skips: false,
    };
    const { rows: cliCrash } = await cliRows(['--type', 'crash']);
    const pageCrash = pageRows(crashOnly);
    const cleanOnPage = pageCrash.filter((row) => row.tests.length === 0);
    assert.ok(
        cleanOnPage.length > 0,
        'the --type crash view must contain an all-clean component, or the divergence below is ' +
            'declared without being exercised'
    );

    const divergences: Divergence[] = [
        {
            what: 'a component whose every test is clean',
            reason:
                'The page renders it as a `(N tests)` row that cannot be expanded ' +
                '(`issues.html:2111-2112`, marked `non-clickable` at `:2094`); the CLI drops it ' +
                '(`lib/query/issues.ts:329`, "a group whose every test is clean is not a triage ' +
                'row"). Both are right for what they are: the page is a browsable inventory of ' +
                'the tree, so a component with nothing wrong is a useful thing to see and to ' +
                'search for, while a terminal triage list of components with no issues is noise ' +
                'the reader has to scroll past. Measured on the full pinned 21-day xpcshell ' +
                'file: 3 of 136 components — Firefox :: Sharing (5 tests), Core :: Widget: ' +
                'Cocoa (1) and Core :: Layout (1). Exercised here through `--type crash`, on ' +
                'which the checked-in fixture has all-clean components too.',
            page: pageCrash.length,
            cli: cliCrash.length,
        },
        {
            what: 'the tie-break between two components with equal issue counts',
            reason:
                'The CLI adds a `localeCompare` on the component name ' +
                '(`lib/query/issues.ts:339`); the page leaves equal counts in the order the ' +
                'walk first saw them (`issues.html:2081` returns `valueB - valueA` and relies ' +
                "on `Array.prototype.sort` being stable). A command whose output is diffed and " +
                'pasted into bugs cannot be non-deterministic, and the page has no such ' +
                'requirement — a reader re-sorts by clicking. Same population and same ranking ' +
                'quantity, so this only reorders rows that display the same number.',
            page: 'insertion order',
            cli: 'component name',
        },
    ];

    assertDeclaredDivergences('issues page vs CLI', divergences);

    // The declared divergence is the *only* difference in the row set: every
    // page-only row must be a clean component, and there must be no CLI-only
    // row at all.
    for (const row of pageOnly) {
        assert.equal(
            row.tests.length,
            0,
            `${row.key} is on the page and not in the CLI, and it is not a clean component — ` +
                'that is an undeclared divergence'
        );
    }
    const pageKeys = new Set(page.map((row) => row.key));
    for (const row of cli) {
        assert.ok(pageKeys.has(row.key), `${row.key} is in the CLI and not on the page`);
    }

    // And the things that must *not* diverge, asserted positively so that a
    // change making one of them differ fails rather than joining the list.
    const cliTotal = cli.reduce((sum, row) => sum + row.issueCount, 0);
    const pageTotal = page.reduce((sum, row) => sum + row.stats.issueCount, 0);
    assert.equal(cliTotal, pageTotal, 'the grand total of issues is not a divergence');
    assert.equal(
        cli.reduce((sum, row) => sum + row.runCount, 0),
        page.reduce((sum, row) => sum + row.stats.runCount, 0),
        'nor is the grand total of runs'
    );
});
