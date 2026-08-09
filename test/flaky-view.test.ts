/**
 * `site/flaky-view.ts` — the page's decisions, with no DOM.
 *
 * The tree these tests run against is built by hand rather than taken from a
 * fixture, because the properties under test are structural (a match three
 * levels down, a folder that is both a match and an ancestor of one) and a
 * fixture supplies them only by luck.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { FolderNode, TestLeaf } from '../lib/query/flakiness.ts';
import {
    type SortState,
    INITIAL_SORT,
    ancestorPaths,
    chartSeries,
    flakyBand,
    findFolder,
    formatPercent,
    inlineChartVisible,
    testsOfFolder,
    headline,
    hiddenCleanTests,
    isHistoricalDate,
    listRows,
    nextSort,
    parseOpen,
    parseTableMode,
    readUrlState,
    testPageUrl,
    tileTooltips,
    visibleRows,
} from '../site/flaky-view.ts';

/** Builds a node, computing `total` from the three counts. */
function node(
    path: string,
    counts: { flaky?: number; stable?: number; skipped?: number },
    children: FolderNode[] = [],
    tests: TestLeaf[] = []
): FolderNode {
    const flaky = counts.flaky ?? 0;
    const stable = counts.stable ?? 0;
    const skipped = counts.skipped ?? 0;
    return {
        path,
        name: path === '' ? '' : path.split('/').at(-1)!,
        flaky,
        stable,
        skipped,
        flakyAndSkipped: 0,
        total: flaky + stable + skipped,
        testCount: flaky + stable + skipped,
        children,
        tests,
    };
}

/** One test leaf, in the state named. */
function leaf(fullPath: string, state: 'flaky' | 'stable' | 'skipped'): TestLeaf {
    return {
        fullPath,
        name: fullPath.slice(fullPath.lastIndexOf('/') + 1),
        flaky: state === 'flaky' ? 1 : 0,
        stable: state === 'stable' ? 1 : 0,
        skipped: state === 'skipped' ? 1 : 0,
        flakyAndSkipped: 0,
        total: 1,
        windowFailures: state === 'flaky' ? 5 : 0,
        neutralised: false,
    };
}

/**
 * root
 *  ├── dom          3 flaky / 7 stable
 *  │    └── base    2 flaky / 3 stable
 *  │         └── test  1 flaky / 1 stable
 *  └── netwerk      6 flaky / 2 stable
 */
function tree(): FolderNode {
    const domBaseTest = node('dom/base/test', { flaky: 1, stable: 1 }, [], [
        leaf('dom/base/test/test_a.js', 'flaky'),
        leaf('dom/base/test/test_b.js', 'stable'),
    ]);
    const domBase = node('dom/base', { flaky: 2, stable: 3 }, [domBaseTest], [
        leaf('dom/base/test_c.js', 'flaky'),
        leaf('dom/base/test_d.js', 'stable'),
        leaf('dom/base/test_e.js', 'stable'),
    ]);
    const dom = node('dom', { flaky: 3, stable: 7 }, [domBase]);
    const netwerk = node('netwerk', { flaky: 6, stable: 2 }, [], [
        leaf('netwerk/test_n.js', 'flaky'),
    ]);
    return node('', { flaky: 9, stable: 9 }, [dom, netwerk]);
}

const NO_SEARCH = new Set<string>();

test('the top level is the root’s children, and the root is not a row', () => {
    const rows = visibleRows(tree(), NO_SEARCH, INITIAL_SORT);
    assert.deepEqual(
        rows.filter((row) => row.kind === "folder").map((row) => row.path),
        ['netwerk', 'dom'],
        'ranked by flaky count descending'
    );
    assert.deepEqual(
        rows.map((row) => row.depth),
        [0, 0]
    );
    assert.ok(rows.every((row) => row.path !== ""));
});

test('expanding a folder reveals its children one level deeper', () => {
    const rows = visibleRows(tree(), new Set(['dom']), INITIAL_SORT);
    assert.deepEqual(
        rows.map((row) => [row.path, row.depth]),
        [
            ['netwerk', 0],
            ['dom', 0],
            ['dom/base', 1],
        ],
        'only the opened level appears; the grandchild stays hidden'
    );
});

test('a folder holding only test files is still expandable', () => {
    // `netwerk` has no subfolders but does have a test file, which is exactly
    // the leaf-directory case: it must open rather than read as a dead end.
    const rows = visibleRows(tree(), NO_SEARCH, INITIAL_SORT);
    assert.equal(rows.find((row) => row.path === 'netwerk')!.expandable, true);
});

test('expanding a leaf folder lists its test files', () => {
    const rows = visibleRows(tree(), new Set(['netwerk']), INITIAL_SORT);
    assert.deepEqual(
        rows.map((row) => [row.kind, row.path]),
        [
            ['folder', 'netwerk'],
            ['test', 'netwerk/test_n.js'],
            ['folder', 'dom'],
        ]
    );
    const test = rows.find((row) => row.kind === 'test')!;
    assert.equal(test.name, 'test_n.js', 'a test row is labelled with its file name');
    assert.equal(test.expandable, false);
    assert.equal(test.testCount, 1);
    assert.equal(test.flaky, 1);
});

test('an expanded folder lists its subfolders before its own test files', () => {
    const rows = visibleRows(tree(), new Set(['dom', 'dom/base']), INITIAL_SORT);
    const under = rows
        .filter((row) => row.path.startsWith('dom/base'))
        .map((row) => [row.kind, row.path]);
    assert.deepEqual(under, [
        ['folder', 'dom/base'],
        // the subfolder first...
        ['folder', 'dom/base/test'],
        // ...then dom/base's own files, of which only the flaky one is listed:
        // `test_d.js` and `test_e.js` passed everywhere. See `isWorthListing`.
        ['test', 'dom/base/test_c.js'],
    ]);
});

test('a test row is one level deeper than the folder holding it', () => {
    const rows = visibleRows(tree(), new Set(['netwerk']), INITIAL_SORT);
    const folder = rows.find((row) => row.path === 'netwerk')!;
    const test = rows.find((row) => row.path === 'netwerk/test_n.js')!;
    // `depth` already accounts for the nesting — the renderer indents by this
    // number alone and must not add a step of its own for a test row.
    assert.equal(folder.depth, 0);
    assert.equal(test.depth, 1);
    assert.equal(test.kind, 'test');
});

test('a folder’s own files indent level with its subfolders’ rows', () => {
    // `dom/base` is at depth 1; its subfolder `dom/base/test` and its own files
    // are both at depth 2, which is what makes the tree read as one level.
    const rows = visibleRows(tree(), new Set(['dom', 'dom/base']), INITIAL_SORT);
    const byPath = new Map(rows.map((row) => [row.path, row.depth]));
    assert.equal(byPath.get('dom/base'), 1);
    assert.equal(byPath.get('dom/base/test'), 2);
    assert.equal(byPath.get('dom/base/test_c.js'), 2);
});

test('a search does not match test file names', () => {
    // Deliberate: a search answers "which folders", and files are found by
    // opening one. Matching file names made `browser` open 33 folders to reach
    // 12 files five levels down. See `matches`.
    assert.deepEqual(visibleRows(tree(), NO_SEARCH, INITIAL_SORT, 'test_n.js'), []);
    // The folder holding it is still findable, and opening it lists the file.
    const byFolder = visibleRows(tree(), new Set(['netwerk']), INITIAL_SORT, 'netwerk');
    assert.deepEqual(
        byFolder.map((row) => [row.kind, row.path]),
        [
            ['folder', 'netwerk'],
            ['test', 'netwerk/test_n.js'],
        ]
    );
});

test('a test links to test.html', () => {
    assert.equal(testPageUrl('dom/base/test_c.js'), 'test.html?test=dom%2Fbase%2Ftest_c.js');
});

test('the percentages are of the row’s own total', () => {
    const rows = visibleRows(tree(), NO_SEARCH, INITIAL_SORT);
    const netwerk = rows.find((row) => row.path === 'netwerk')!;
    assert.equal(netwerk.flakyPercent, 75);
    assert.equal(netwerk.stablePercent, 25);
    assert.equal(netwerk.skippedPercent, 0);
});

// --- the search -----------------------------------------------------------

test('a search opens the path down to a deep match', () => {
    // Nothing is expanded by the reader; the search must still reveal the match.
    const rows = visibleRows(tree(), NO_SEARCH, INITIAL_SORT, 'dom/base/test');
    assert.deepEqual(
        rows.filter((row) => row.kind === "folder").map((row) => row.path),
        ['dom', 'dom/base', 'dom/base/test'],
        'the ancestors open so the match is reachable'
    );
    // `dom/base/test` is the match, so it is shown **closed** — its own file
    // `test/test_a.js` is not listed until the reader opens it. `dom/base` is
    // only an ancestor, so it is auto-opened and contributes its own listable
    // file. That is the rule working: the deepest row is the answer, and what is
    // above it is the way there.
    assert.deepEqual(
        rows.filter((row) => row.kind === 'test').map((row) => row.path),
        ['dom/base/test_c.js']
    );
    const match = rows.find((row) => row.path === 'dom/base/test')!;
    assert.equal(match.expanded, false, 'the matched folder is not force-opened');
});

test('a search never puts a test row in the result on its own', () => {
    // Neither a directory fragment nor a file name surfaces a bare test row;
    // only opening a folder does.
    for (const needle of ['base', 'test_c', 'test_c.js']) {
        const rows = visibleRows(tree(), NO_SEARCH, INITIAL_SORT, needle);
        assert.ok(
            !rows.some((row) => row.kind === 'test'),
            `"${needle}" should not produce a test row`
        );
    }
});

test('a search does not open a branch whose own folder matched', () => {
    // Searching `base` matches the folder `dom/base` itself, so it is the
    // answer and is shown closed — the reader opens it. Only `dom`, which does
    // not match and merely contains the match, is opened to reach it.
    const rows = visibleRows(tree(), NO_SEARCH, INITIAL_SORT, 'base');
    const opened = rows.filter((row) => row.kind === 'folder' && row.expanded);
    assert.deepEqual(
        opened.map((row) => row.path),
        ['dom'],
        'the matching folder is not force-opened, only the way to it'
    );
});

test('a deep substring match does not drag the whole ancestry open', () => {
    // The regression this pins: searching `browser` matched
    // `…/xpcshell/test_browser.js` and opened all five ancestors, which drew 33
    // inline charts on the real data. Here `deep/a/b/c` holds the only match.
    const leafDir = node('deep/a/b/c', { flaky: 1 }, [], [leaf('deep/a/b/c/test_x.js', 'flaky')]);
    const b = node('deep/a/b', { flaky: 1 }, [leafDir]);
    const a = node('deep/a', { flaky: 1 }, [b]);
    const deep = node('deep', { flaky: 1 }, [a]);
    const root = node('', { flaky: 1 }, [deep]);

    // A file name matches nothing at all now, so nothing opens.
    assert.deepEqual(visibleRows(root, NO_SEARCH, INITIAL_SORT, 'test_x'), []);

    // And `a/b` names a folder, so the walk stops there rather than continuing.
    const byFolder = visibleRows(root, NO_SEARCH, INITIAL_SORT, 'a/b');
    assert.deepEqual(
        byFolder.filter((row) => row.kind === 'folder' && row.expanded).map((row) => row.path),
        ['deep', 'deep/a'],
        'the matching folder deep/a/b is shown closed'
    );
});

test('a folder that is itself the match is not force-opened', () => {
    const rows = visibleRows(tree(), NO_SEARCH, INITIAL_SORT, 'dom/base');
    // `dom` is an ancestor and opens; `dom/base` matches and keeps its state,
    // so its child is not dragged in behind it.
    assert.deepEqual(
        rows.filter((row) => row.kind === "folder").map((row) => row.path),
        ['dom', 'dom/base']
    );
});

test('a reader’s own expansion still wins inside a search', () => {
    const rows = visibleRows(tree(), new Set(['dom/base']), INITIAL_SORT, 'dom/base');
    assert.deepEqual(
        rows.filter((row) => row.kind === "folder").map((row) => row.path),
        ['dom', 'dom/base', 'dom/base/test'],
        'the match was already open, so it stays open'
    );
});

test('a search drops the branches that contain no match', () => {
    const rows = visibleRows(tree(), NO_SEARCH, INITIAL_SORT, 'netwerk');
    assert.deepEqual(
        rows.filter((row) => row.kind === "folder").map((row) => row.path),
        ['netwerk']
    );
});

test('search is case-insensitive and trimmed', () => {
    const rows = visibleRows(tree(), NO_SEARCH, INITIAL_SORT, '  NETWERK  ');
    assert.deepEqual(
        rows.filter((row) => row.kind === "folder").map((row) => row.path),
        ['netwerk']
    );
});

test('an empty search restores the reader’s tree exactly', () => {
    const expanded = new Set(['dom']);
    const searched = visibleRows(tree(), expanded, INITIAL_SORT, 'netwerk');
    const cleared = visibleRows(tree(), expanded, INITIAL_SORT, '');
    assert.deepEqual(
        searched.filter((row) => row.kind === "folder").map((row) => row.path),
        ['netwerk']
    );
    assert.deepEqual(
        cleared.filter((row) => row.kind === "folder").map((row) => row.path),
        ['netwerk', 'dom', 'dom/base'],
        'clearing the search leaves only what the reader had opened'
    );
    // The search must not have mutated the set it was handed.
    assert.deepEqual([...expanded], ['dom']);
});

test('a search matching nothing yields no rows', () => {
    assert.deepEqual(visibleRows(tree(), NO_SEARCH, INITIAL_SORT, 'nothinghere'), []);
});

// --- sorting --------------------------------------------------------------

test('sorting by percent ranks a small bad folder above a big mediocre one', () => {
    const sort: SortState = { field: 'percent', ascending: false };
    const rows = visibleRows(tree(), NO_SEARCH, sort);
    // netwerk 75%, dom 30%.
    assert.deepEqual(
        rows.filter((row) => row.kind === "folder").map((row) => row.path),
        ['netwerk', 'dom']
    );
});

test('sorting by name is ascending and by count is descending, by default', () => {
    assert.deepEqual(nextSort(INITIAL_SORT, 'name'), { field: 'name', ascending: true });
    assert.deepEqual(nextSort(INITIAL_SORT, 'total'), { field: 'total', ascending: false });
    assert.deepEqual(nextSort(INITIAL_SORT, 'percent'), { field: 'percent', ascending: false });
});

test('clicking the active column reverses it', () => {
    const once = nextSort(INITIAL_SORT, 'flaky');
    assert.deepEqual(once, { field: 'flaky', ascending: true });
    assert.deepEqual(nextSort(once, 'flaky'), { field: 'flaky', ascending: false });
});

test('sorting by name orders alphabetically', () => {
    const rows = visibleRows(tree(), NO_SEARCH, { field: 'name', ascending: true });
    assert.deepEqual(
        rows.filter((row) => row.kind === "folder").map((row) => row.name),
        ['dom', 'netwerk']
    );
});

test('the initial sort is flaky count, descending', () => {
    assert.deepEqual(INITIAL_SORT, { field: 'flaky', ascending: false });
});

// --- colour bands and formatting ------------------------------------------

test('the colour bands split at 0, 10, 25 and 50 percent', () => {
    assert.equal(flakyBand(0), 'none');
    assert.equal(flakyBand(0.1), 'low');
    assert.equal(flakyBand(9.99), 'low');
    assert.equal(flakyBand(10), 'medium');
    assert.equal(flakyBand(24.9), 'medium');
    assert.equal(flakyBand(25), 'high');
    assert.equal(flakyBand(49.9), 'high');
    assert.equal(flakyBand(50), 'severe');
    assert.equal(flakyBand(100), 'severe');
});

test('a percentage is rounded once, with a decimal only below 10%', () => {
    assert.equal(formatPercent(0), '0%');
    assert.equal(formatPercent(3.24), '3.2%');
    assert.equal(formatPercent(9.96), '10.0%');
    assert.equal(formatPercent(19.21), '19%');
    assert.equal(formatPercent(66.666), '67%');
});

// --- the chart series -----------------------------------------------------

test('chartSeries labels with MM-DD and carries all four series', () => {
    const days = [
        { day: 0, date: '2026-07-15', flaky: 10, stable: 80, skipped: 10, total: 100 },
        { day: 1, date: '2026-07-16', flaky: 20, stable: 70, skipped: 10, total: 100 },
    ];
    const data = chartSeries(days);
    assert.deepEqual(data.labels, ['07-15', '07-16']);
    assert.deepEqual(data.flaky, [10, 20]);
    assert.deepEqual(data.stable, [80, 70]);
    assert.deepEqual(data.skipped, [10, 10]);
    assert.deepEqual(data.flakyPercent, [10, 20]);
    assert.equal(data.average.length, 2);
});

// --- the headline ---------------------------------------------------------

test('the headline reports the most recent day with tests', () => {
    const summary = headline([
        { day: 0, date: '2026-07-15', flaky: 10, stable: 90, skipped: 0, total: 100 },
        { day: 1, date: '2026-07-16', flaky: 25, stable: 75, skipped: 0, total: 100 },
        // A trailing day CI did not run must not become "today".
        { day: 2, date: '2026-07-17', flaky: 0, stable: 0, skipped: 0, total: 0 },
    ]);
    assert.equal(summary.latest?.date, '2026-07-16');
    assert.equal(summary.flakyPercent, 25);
});

test('the tiles average the last few days, not the most recent one', () => {
    // Ten days at 10% flaky, then one at 100%. The tiles must not read 100%.
    const days = [
        ...Array.from({ length: 10 }, (_unused, index) => ({
            day: index,
            date: dateOfDayLocal(index),
            flaky: 10,
            stable: 90,
            skipped: 0,
            total: 100,
        })),
        { day: 10, date: dateOfDayLocal(10), flaky: 100, stable: 0, skipped: 0, total: 100 },
    ];
    const summary = headline(days);
    assert.equal(summary.average?.days, 7, 'the window is AVERAGE_WINDOW days');
    // Six days at 10 and one at 100 => mean 22.9, rounded to 23.
    assert.equal(summary.average?.flaky, 23);
    assert.notEqual(summary.average?.flaky, 100, 'a single bad day is not the headline');
    // And the latest day is still reported separately, unaveraged.
    assert.equal(summary.flakyPercent, 100);
});

test('the tile counts sum to the tile total', () => {
    // Rounding each part independently could make the three disagree with the
    // total; the total is summed from the rounded parts to prevent that.
    const days = Array.from({ length: 7 }, (_unused, index) => ({
        day: index,
        date: dateOfDayLocal(index),
        flaky: index,
        stable: 100 - index * 2,
        skipped: index,
        total: 100,
    }));
    const summary = headline(days);
    const average = summary.average!;
    assert.equal(average.flaky + average.stable + average.skipped, average.total);
});

test('the tile average uses fewer days when the file is shorter', () => {
    const summary = headline([
        { day: 0, date: '2026-08-03', flaky: 10, stable: 90, skipped: 0, total: 100 },
        { day: 1, date: '2026-08-04', flaky: 20, stable: 80, skipped: 0, total: 100 },
    ]);
    assert.equal(summary.average?.days, 2, 'so the heading can say "2 days" truthfully');
    assert.equal(summary.average?.flaky, 15);
});

test('the tile average skips days on which nothing ran', () => {
    const summary = headline([
        { day: 0, date: '2026-08-03', flaky: 10, stable: 90, skipped: 0, total: 100 },
        { day: 1, date: '2026-08-04', flaky: 0, stable: 0, skipped: 0, total: 0 },
    ]);
    assert.equal(summary.average?.days, 1, 'a day with no tests is not part of the mean');
    assert.equal(summary.average?.flaky, 10);
});

test('an empty window has no tile average', () => {
    assert.equal(headline([]).average, null);
});

/** `2026-08-01` plus `offset` days, for the headline fixtures. */
function dateOfDayLocal(offset: number): string {
    return new Date(Date.parse('2026-08-01T00:00:00Z') + offset * 86_400_000)
        .toISOString()
        .slice(0, 10);
}

test('the headline trend uses the average, so one bad day is not a trend', () => {
    // A single 65% spike at the start, flat 10% afterwards: the raw first-to-last
    // difference would read -55 points, the averaged one is far smaller.
    const days = [
        { day: 0, date: '2026-07-15', flaky: 65, stable: 35, skipped: 0, total: 100 },
        ...Array.from({ length: 10 }, (_unused, index) => ({
            day: index + 1,
            date: `2026-07-${String(16 + index).padStart(2, '0')}`,
            flaky: 10,
            stable: 90,
            skipped: 0,
            total: 100,
        })),
    ];
    const summary = headline(days);
    assert.ok(summary.trend !== null);
    assert.ok(
        Math.abs(summary.trend!) < 55,
        `the averaged trend (${summary.trend}) should be gentler than the raw -55`
    );
    assert.ok(summary.trend! < 0, 'the tree did get better across the window');
});

test('an empty window has no headline day and no trend', () => {
    const summary = headline([]);
    assert.equal(summary.latest, null);
    assert.equal(summary.flakyPercent, 0);
    assert.equal(summary.trend, null);
});

// --- URL state ------------------------------------------------------------

test('an absent date means the 21-day window', () => {
    assert.equal(isHistoricalDate(undefined), true);
    assert.equal(isHistoricalDate(''), true);
    assert.equal(isHistoricalDate('21days'), true);
    assert.equal(isHistoricalDate('2026-08-04'), false);
});

test('readUrlState treats an empty parameter as absent', () => {
    const state = readUrlState(new URLSearchParams('date=&q=dom&open=a,b&noise=3'));
    assert.equal(state.date, undefined);
    assert.equal(state.q, 'dom');
    assert.equal(state.open, 'a,b');
    assert.equal(state.noise, '3');
});

test('parseOpen round-trips a folder set and ignores empties', () => {
    assert.deepEqual([...parseOpen('dom,dom/base')], ['dom', 'dom/base']);
    assert.deepEqual([...parseOpen('')], []);
    assert.deepEqual([...parseOpen(undefined)], []);
    assert.deepEqual([...parseOpen('dom,,')], ['dom']);
});

test('ancestorPaths lists every folder on the way down, inclusive', () => {
    assert.deepEqual(ancestorPaths('dom/base/test'), ['dom', 'dom/base', 'dom/base/test']);
    assert.deepEqual(ancestorPaths('dom'), ['dom']);
});

// --- the tile tooltips ----------------------------------------------------

test('the tile tooltips describe the threshold in force', () => {
    const tips = tileTooltips(1, 21);
    // "Stable" must not claim "passed every time" while one failure is forgiven.
    assert.match(tips.stable, /passed every time/i);
    assert.match(tips.stable, /no more than once/i);
    assert.match(tips.stable, /21 days/);
    // Flaky at threshold 1 means two or more failures.
    assert.match(tips.flaky, /at least twice/i);
    assert.match(tips.flaky, /timeouts and crashes/i);
    assert.match(tips.skipped, /skipped on at least one configuration/i);
});

test('with the filter off the tooltips say "at least once"', () => {
    const tips = tileTooltips(0, 21);
    assert.match(tips.flaky, /at least once/i);
    assert.doesNotMatch(tips.flaky, /twice/i);
    assert.match(tips.stable, /passed every time/i);
    assert.doesNotMatch(tips.stable, /no more than/i);
});

test('a single-day view’s tooltips do not talk about a window', () => {
    const tips = tileTooltips(0, 1);
    assert.match(tips.flaky, /on this day/);
    assert.doesNotMatch(tips.flaky, /days/);
});

test('a higher threshold is reflected in both directions', () => {
    const tips = tileTooltips(3, 21);
    assert.match(tips.stable, /no more than 3 times/i);
    assert.match(tips.flaky, /at least 4 times/i);
});

test('parseTableMode defaults to the tree', () => {
    assert.equal(parseTableMode(undefined), 'tree');
    assert.equal(parseTableMode(''), 'tree');
    assert.equal(parseTableMode('tree'), 'tree');
    assert.equal(parseTableMode('list'), 'list');
    assert.equal(parseTableMode('nonsense'), 'tree');
});

// --- the flat folder list -------------------------------------------------

test('the flat list ranks by a folder’s own flaky tests, not its subtree', () => {
    const rows = listRows(tree(), INITIAL_SORT);
    // `dom` has 3 flaky in its subtree but no test files of its own, so it is
    // not a place work happens and is absent. The folders that hold tests are.
    assert.deepEqual(
        rows.map((row) => [row.path, row.selfFlaky]),
        [
            ['dom/base', 1],
            ['dom/base/test', 1],
            ['netwerk', 1],
        ]
    );
    assert.ok(
        !rows.some((row) => row.path === 'dom'),
        'a pure container with no test files of its own is not a burndown target'
    );
});

test('the flat list keeps the subtree total alongside the folder’s own', () => {
    const rows = listRows(tree(), INITIAL_SORT);
    const domBase = rows.find((row) => row.path === 'dom/base')!;
    // Its own files: 3, of which 1 flaky. Its subtree: 5 classified, 2 flaky.
    assert.equal(domBase.selfTestCount, 3);
    assert.equal(domBase.selfTotal, 3);
    assert.equal(domBase.selfFlaky, 1);
    assert.equal(domBase.flaky, 2, 'the subtree roll-up is still reported');
    assert.equal(domBase.total, 5);
});

test('the flat list has no depth nesting and no duplicates', () => {
    const rows = listRows(tree(), INITIAL_SORT);
    assert.equal(new Set(rows.map((row) => row.path)).size, rows.length);
});

test('the flat list is searchable by path', () => {
    const rows = listRows(tree(), INITIAL_SORT, 'netwerk');
    assert.deepEqual(
        rows.map((row) => row.path),
        ['netwerk']
    );
});

test('the flat list sorts by the skip columns too', () => {
    const withSkips = node(
        '',
        { flaky: 2, stable: 2, skipped: 4 },
        [
            node('a', { flaky: 1, stable: 1, skipped: 3 }, [], [
                leaf('a/t1.js', 'flaky'),
                leaf('a/t2.js', 'skipped'),
            ]),
            node('b', { flaky: 1, stable: 1, skipped: 1 }, [], [
                leaf('b/t3.js', 'flaky'),
                leaf('b/t4.js', 'stable'),
            ]),
        ]
    );
    const bySkips = listRows(withSkips, { field: 'skipped', ascending: false });
    assert.deepEqual(
        bySkips.map((row) => row.path),
        ['a', 'b'],
        'the folder with more skipped tests ranks first'
    );
    const ascending = listRows(withSkips, { field: 'skipped', ascending: true });
    assert.deepEqual(
        ascending.map((row) => row.path),
        ['b', 'a']
    );
});

// --- expanding a row in the flat list -------------------------------------

test('a flat-list row can be opened to its own test files', () => {
    const root = tree();
    // `dom/base` holds three files directly and one subfolder. Opening it lists
    // its own files and not the subfolder's — and only the ones worth acting on,
    // so `test_d.js` and `test_e.js` (clean) are absent.
    const tests = testsOfFolder(root, 'dom/base', INITIAL_SORT);
    assert.deepEqual(
        tests.map((row) => row.path),
        ['dom/base/test_c.js']
    );
    assert.ok(tests.every((row) => row.kind === 'test'));
});

test('the tests under a flat-list row account for its own flaky count', () => {
    const root = tree();
    for (const path of ['dom/base', 'dom/base/test', 'netwerk']) {
        const tests = testsOfFolder(root, path, INITIAL_SORT);
        const listed = listRows(root, INITIAL_SORT).find((row) => row.path === path)!;
        // Every flaky test is listed, so the listed rows still add up to the
        // row's flaky count — that reconciliation is what must not break.
        assert.equal(
            tests.reduce((sum, row) => sum + row.flaky, 0),
            listed.selfFlaky,
            `${path}: the flaky rows under the row must add up to it`
        );
        // The clean ones are counted but not listed, and the gap is nameable.
        assert.equal(
            tests.length + hiddenCleanTests(findFolder(root, path)!),
            listed.selfTestCount,
            `${path}: listed + hidden must equal the folder's own population`
        );
    }
});

test('the worst test is first under an opened flat-list row', () => {
    const tests = testsOfFolder(tree(), 'dom/base', INITIAL_SORT);
    assert.equal(tests[0]!.path, 'dom/base/test_c.js', 'the flaky one leads');
    assert.equal(tests[0]!.flaky, 1);
});

test('an unknown path yields no tests rather than throwing', () => {
    assert.deepEqual(testsOfFolder(tree(), 'no/such/folder', INITIAL_SORT), []);
});

test('findFolder locates a node by path and returns null otherwise', () => {
    const root = tree();
    assert.equal(findFolder(root, 'dom/base/test')?.path, 'dom/base/test');
    assert.equal(findFolder(root, '')?.path, '');
    assert.equal(findFolder(root, 'dom/baseline'), null, 'a prefix is not a match');
    assert.equal(findFolder(root, 'nope'), null);
});

// --- clean tests are counted but not listed -------------------------------

test('a test that passed everywhere is not listed', () => {
    // `dom/base` holds one flaky file and two clean ones.
    const tests = testsOfFolder(tree(), 'dom/base', INITIAL_SORT);
    assert.deepEqual(
        tests.map((row) => row.path),
        ['dom/base/test_c.js'],
        'only the flaky file is worth a row'
    );
});

test('a skipped test is still listed', () => {
    // Skipped is actionable — the test is disabled somewhere — so it stays.
    const root = node('', { skipped: 1, stable: 1 }, [
        node('a', { skipped: 1, stable: 1 }, [], [
            leaf('a/skipped.js', 'skipped'),
            leaf('a/clean.js', 'stable'),
        ]),
    ]);
    assert.deepEqual(
        testsOfFolder(root, 'a', INITIAL_SORT).map((row) => row.path),
        ['a/skipped.js']
    );
});

test('hiding clean tests does not change any count', () => {
    const root = tree();
    const rows = visibleRows(root, new Set(['dom', 'dom/base']), INITIAL_SORT);
    const folder = rows.find((row) => row.path === 'dom/base')!;
    // The folder still reports its whole population, listed or not.
    assert.equal(folder.total, 5);
    assert.equal(folder.testCount, 5);
    assert.equal(folder.flaky, 2);
    // But only one of its three own files appears.
    const listed = rows.filter((row) => row.kind === 'test' && row.node.path === 'dom/base');
    assert.equal(listed.length, 1);
    assert.equal(hiddenCleanTests(findFolder(root, 'dom/base')!), 2);
});

test('the tree lists only the flaky and skipped files of a folder', () => {
    const rows = visibleRows(tree(), new Set(['dom', 'dom/base', 'dom/base/test']), INITIAL_SORT);
    assert.deepEqual(
        rows.map((row) => [row.kind, row.path]),
        [
            ['folder', 'netwerk'],
            ['folder', 'dom'],
            ['folder', 'dom/base'],
            ['folder', 'dom/base/test'],
            // dom/base/test has one flaky and one clean file
            ['test', 'dom/base/test/test_a.js'],
            // then dom/base's own: one flaky of three
            ['test', 'dom/base/test_c.js'],
        ]
    );
});

test('a folder whose every test is clean is not expandable', () => {
    const root = node('', { stable: 2 }, [
        node('clean', { stable: 2 }, [], [
            leaf('clean/a.js', 'stable'),
            leaf('clean/b.js', 'stable'),
        ]),
    ]);
    const rows = visibleRows(root, NO_SEARCH, INITIAL_SORT);
    assert.equal(
        rows.find((row) => row.path === 'clean')!.expandable,
        false,
        'a triangle that opens onto nothing is worse than no triangle'
    );
    assert.equal(hiddenCleanTests(findFolder(root, 'clean')!), 2);
});

test('hiddenCleanTests counts only the folder’s own clean files', () => {
    const root = tree();
    // dom/base: 3 own files, 2 clean. Its subfolder's clean file is not counted.
    assert.equal(hiddenCleanTests(findFolder(root, 'dom/base')!), 2);
    assert.equal(hiddenCleanTests(findFolder(root, 'dom/base/test')!), 1);
    assert.equal(hiddenCleanTests(findFolder(root, 'netwerk')!), 0);
});

// --- the inline chart -----------------------------------------------------

test('an inline chart needs more than one day of data', () => {
    const oneDay = [{ day: 0, date: '2026-08-04', flaky: 1, stable: 1, skipped: 0, total: 2 }];
    assert.equal(inlineChartVisible(oneDay), false, 'one point is not a history');

    const twoDays = [
        { day: 0, date: '2026-08-03', flaky: 1, stable: 1, skipped: 0, total: 2 },
        { day: 1, date: '2026-08-04', flaky: 0, stable: 2, skipped: 0, total: 2 },
    ];
    assert.equal(inlineChartVisible(twoDays), true);
});

test('an inline chart is hidden when no test ran on any day', () => {
    const empty = [
        { day: 0, date: '2026-08-03', flaky: 0, stable: 0, skipped: 0, total: 0 },
        { day: 1, date: '2026-08-04', flaky: 0, stable: 0, skipped: 0, total: 0 },
    ];
    assert.equal(inlineChartVisible(empty), false);
});

// --- the skip columns -----------------------------------------------------

test('the tree sorts by skip count and skip percentage', () => {
    const root = node(
        '',
        { flaky: 0, stable: 4, skipped: 6 },
        [
            // 2 of 10 skipped = 20%
            node('big', { stable: 8, skipped: 2 }),
            // 4 of 5 skipped = 80%
            node('small', { stable: 1, skipped: 4 }),
        ]
    );
    assert.deepEqual(
        visibleRows(root, NO_SEARCH, { field: 'skipped', ascending: false }).map(
            (row) => row.path
        ),
        ['small', 'big'],
        'by count: 4 beats 2'
    );
    assert.deepEqual(
        visibleRows(root, NO_SEARCH, { field: 'skipPercent', ascending: false }).map(
            (row) => row.path
        ),
        ['small', 'big'],
        'by share: 80% beats 20%'
    );
    // And a case where count and share disagree, so the two columns are proven
    // to be different orderings rather than the same one twice.
    const disagree = node(
        '',
        { stable: 0, skipped: 0 },
        [
            node('many', { stable: 90, skipped: 10 }), // 10 skips, 10%
            node('few', { stable: 1, skipped: 4 }), // 4 skips, 80%
        ]
    );
    assert.deepEqual(
        visibleRows(disagree, NO_SEARCH, { field: 'skipped', ascending: false }).map(
            (row) => row.path
        ),
        ['many', 'few']
    );
    assert.deepEqual(
        visibleRows(disagree, NO_SEARCH, { field: 'skipPercent', ascending: false }).map(
            (row) => row.path
        ),
        ['few', 'many']
    );
});

// --- the chart series, after the stable series was dropped ----------------

test('the chart carries skipped percentages and keeps stable for the tooltip', () => {
    const data = chartSeries([
        { day: 0, date: '2026-07-15', flaky: 20, stable: 70, skipped: 10, total: 100 },
    ]);
    assert.deepEqual(data.flakyPercent, [20]);
    assert.deepEqual(data.skippedPercent, [10]);
    assert.deepEqual(data.stable, [70], 'still available, just not plotted');
    assert.deepEqual(data.total, [100]);
});
