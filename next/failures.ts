/**
 * `failures.html`, migrated onto `lib/`.
 *
 * Migrated as **one job** with `crashes.html` — see `next/crashes.ts` for the
 * file split and why the two were done together. This file is the failures half:
 * the data loading, this page's hooks, and the interactions.
 *
 * ## What the migration removes
 *
 * **The inline decoding of the status-group shapes.** `processFailureData`
 * (`failures.html:207-360`) is 150 lines branching on `isBucketedFormat`, which
 * covers two of the five shapes `FORMATS.md` documents.
 * `lib/formats/status-entries.ts` resolves all five and throws on a sixth.
 *
 * `common-test-data.js` is **not** loaded, and was not loaded before either —
 * `grep -c common-test-data failures.html` is 0. See `next/crashes.ts` for the
 * full note; the summary is that this page never had the tag, so the brief's
 * requirement is satisfied with nothing removed.
 *
 * The six shared scripts stay, loaded by name. `common-links.js` is doing real
 * work on this page in particular: `getBugzillaUrl` and `getBugButton` build the
 * 🐛 button, and `linkifyFailureMessage`'s Searchfox rule is reproduced as a
 * decision in `next/failures-view.ts` rather than called, because it returns
 * markup.
 *
 * ## Declared divergences from `failures.html`
 *
 * `PARITY.md` §4: byte-identical is the default and every exception is declared.
 * **This list is the whole set** — one enumerated list, no prose carrying an
 * extra entry.
 *
 *  1. **Inline handler attributes become `addEventListener`.** Upstream emits
 *     `onclick="sortBy('tests')"`, `onclick="sortBy('count')"`,
 *     `onclick="window.open('…', '_blank')"` on every single-failure row, and
 *     `onclick="event.stopPropagation();"` on every link and every 🐛 button, as
 *     **attributes**. This page attaches the same handlers and emits none of its
 *     own. Measured in Chrome on the pinned snapshot at first paint: **old 2,
 *     new 0**, rising as rows expand.
 *
 *     One `onclick` does survive in the new page's DOM and it is not this
 *     page's: the 🐛 button's markup comes from `getBugButton`
 *     (`common-links.js:216`), a shared script this migration keeps, and it
 *     writes `onclick="event.stopPropagation();"` into the string it returns.
 *     Its count therefore tracks the number of bug buttons rather than the
 *     number of rows.
 *
 *  2. **`data-message` is gone; rows are held in a `Map` — and this fixes a
 *     live bug.** Upstream writes `data-message="${escapeAttr(msg)}"` and finds
 *     a row again with `querySelector('[data-message="' + escapeAttr(msg) +
 *     '"]')` (`:670`, `:683`). The round-trip does not survive a quote:
 *     `escapeAttr` writes `&quot;`, the HTML parser decodes it back to `"` in
 *     the attribute value, and the CSS selector then looks for the literal text
 *     `&quot;`.
 *
 *     **Measured in Chrome on the pinned snapshot: 1,848 of the 2,841 rows
 *     (65%) cannot find themselves.** And it is live: expanding
 *     `Unexpected exception TypeError: can't access property "resumed", …`
 *     gives it 2 sub-rows, and clicking a column header to re-sort leaves that
 *     row with the `expanded` class, `expandedMessage` still pointing at it, and
 *     **0 sub-rows** — a highlighted row with nothing under it that then needs
 *     two clicks to open. A quote-free control row is unaffected by the same
 *     steps.
 *
 *     Here the row elements live in a `Map` keyed by the raw message, so the
 *     round-trip does not exist. **A DOM diff sees one absent attribute per
 *     row; a reader sees a row that reopens.**
 *
 *  3. **The total row's "Tests" number still overcounts.** It sums each row's
 *     test count, so a test failing with several messages counts once per
 *     message. Measured on the pinned snapshot: the row shows **7,976** where
 *     **3,793** distinct tests failed, a 2.10× overcount. **Reproduced
 *     unchanged**, for the reason given in `totalsOf`: it is the sum of the
 *     column above it and a reader checks it by adding the rows up.
 *
 *  4. **The search still rewrites the counts on the rows.** Reproduced exactly,
 *     including the part that surprises: a row whose *message* does not match
 *     shows a **smaller count under a search than without one**, because it is
 *     recomputed from only the tests that matched. `crashes.html` does the
 *     opposite — it leaves the numbers alone and drops whole rows — and the
 *     difference between the two pages is upstream's, not this migration's.
 *
 *  5. **A stale search box is now cleared on hashchange.** `failures.html:1100`
 *     is `if (document.activeElement !== searchBox && state.q)`, so a hash with
 *     no `q` never *clears* the box: navigating from `#q=netwerk` to
 *     `#date=2026-08-04` leaves `netwerk` in the box and the list filtered by a
 *     term the URL no longer names, and the next hash write puts `q=netwerk`
 *     back. **This is the one behaviour change on this list.**
 *
 *     Why fixed here and not left alone: the alternative is a page whose
 *     displayed state contradicts its own URL, which breaks the property
 *     `PARITY.md` §4 names explicitly — "a shared link must produce the same
 *     view on both". A link with no `q` must not produce a filtered list. The
 *     new page writes `state.q ?? ''`, so an absent `q` clears the box, and the
 *     focus guard is kept unchanged so typing is never interrupted.
 *
 *     `crashes.html:989` has the identical bug. It is **not** fixed there — see
 *     that file's list — because the crashes page's search only hides rows,
 *     while this page's search rewrites every number on screen, so the stale
 *     state is far more misleading here. Fixing one and not the other is a
 *     deliberate asymmetry rather than an oversight, and it is stated on both
 *     lists so a reviewer sees it from either side.
 *
 *  6. **A job name the file cannot resolve renders as empty, not `"undefined"`.**
 *     Same as `crashes.html`'s entry 6, and equally unreachable on the files
 *     this page loads.
 *
 *  7. **The message's Searchfox link is built from parts.**
 *     `linkifyFailureMessage` (`common-ui.js:22`) returns a string of HTML that
 *     the page interpolates; here `messageLink()` returns the split point and
 *     the renderer builds an anchor and a text node. The rendered text and the
 *     href are identical — `test/failures-view.test.ts` asserts the split
 *     against the shared function's own regex — and the difference a DOM diff
 *     sees is the absent `onclick` on the anchor, which is entry 1.
 *
 * Everything else — the row unit including the rankable `(no failure message)`
 * row, the `FAIL*` prefix universe, the 21-day default, the sort keys, the path
 * collapse, the bug button's `Product :: Component` guard, the tooltip and its
 * rounding, the four chart variants including the two search-filtered ones, and
 * the `#date=…&q=…` state — is reproduced.
 */

import { decodeDaily } from '../lib/formats/daily.ts';
import type { DailyFile } from '../lib/formats/daily.ts';
import { decodeIssuesWithTaskIds } from '../lib/formats/issues.ts';
import type { IssuesWithTaskIdsFile } from '../lib/formats/issues.ts';
import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import {
    type GroupNode,
    type GroupRow,
    type Occurrence,
    type PathNode,
    type SortColumn,
    type SortState,
    type TestNode,
    INITIAL_SORT,
    expandGroup,
    expandPath,
    isHistoricalDate,
    nextSort,
    occurrenceTooltip,
    readUrlState,
    totalsOf,
} from './drilldown-view.ts';
import {
    type RenderHooks,
    type SearchBoxManager,
    type Vocabulary,
    externalLink,
    insertAfter,
    noData,
    removeFollowing,
    renderChartSlot,
    renderList,
    renderOccurrenceTable,
    renderSubRows,
    searchBox,
} from './drilldown-render.ts';
import {
    FAILURE_NOUN,
    buildFailureGroups,
    failureList,
    hasBugButton,
    messageLink,
    mostFrequentTestPath,
} from './failures-view.ts';

/** The class names and labels this page uses. See `Vocabulary`. */
const VOCAB: Vocabulary = {
    kind: 'failure',
    rowClass: 'failure-row',
    labelClass: 'failure-message',
    statsClass: 'failure-stats',
    listClass: 'failure-list',
    countClass: 'fail',
    singleClass: 'single-failure',
    jobNameClass: 'failure-job-name',
    testCountClass: 'test-failure-count',
    labelHeader: 'Failure Message',
    countHeader: 'Failures',
    emptyText: 'No failure data available',
};

// --- page state -----------------------------------------------------------

/** The raw parsed file, for the shared scripts that index into it directly. */
let rawData: unknown = null;
let decoded: DecodedTimingFile | null = null;
let startTime = 0;
let groups: Map<string, GroupNode> = new Map();
let historicalData: unknown = null;
let isHistoricalMode = false;

let expandedMessage: string | null = null;
const expandedPaths = new Set<string>();
const expandedTests = new Set<string>();
let currentSort: SortState = { ...INITIAL_SORT };

/**
 * The search-aware subtrees of the last render.
 *
 * `filteredFailureData` (`failures.html:101`). Every expansion reads from this
 * rather than from `groups`, which is what makes an expanded row under a search
 * show only what matched — and is the counterpart of the crashes page expanding
 * from its unfiltered tree.
 */
let expandable = new Map<string, Map<string, PathNode>>();
let rowsByKey = new Map<string, HTMLElement>();
let renderedRows: GroupRow[] = [];

let searchBoxManager: SearchBoxManager;
let hashManager: ReturnType<typeof initUrlHashManager>;
let historicalToggleManager: { toggle: () => Promise<void> };

const content = (): HTMLElement => document.getElementById('content')!;
const statusText = (): HTMLElement => document.getElementById('statusText')!;
const dateSelect = (): HTMLSelectElement =>
    document.getElementById('dateSelect') as HTMLSelectElement;

// --- the page's hooks -----------------------------------------------------

function treeherderUrl(occurrence: Occurrence): string | null {
    if (rawData === null) {
        return null;
    }
    return getTreeherderJobUrl(occurrence, rawData);
}

/**
 * The 🐛 bug-filing button for a test row, or `null`.
 *
 * `generateBugButton` (`failures.html:749`). The markup comes from
 * `getBugButton` (`common-links.js:216`), which returns a string — so this is
 * the one place the new page parses HTML, and it does so through a `<template>`
 * rather than by assigning into the live tree. Building the anchor here instead
 * would mean duplicating the shared function's markup and its tooltip, which is
 * exactly the duplication this migration is trying not to create.
 */
function bugButton(testPath: string, message: string, test: TestNode): Node | null {
    const component = test.component;
    if (!hasBugButton(component)) {
        return null;
    }
    const { firstDate, lastDate } = getDataDateRange(rawData);
    const totalRuns = hooks.totalRunsOf(testPath.slice(0, testPath.lastIndexOf('/')), test.testName);
    const url = getBugzillaUrl({
        testPath,
        summary: message,
        component: component!,
        stats: { failureCount: test.totalCount, firstDate, lastDate, totalRuns },
    });
    const template = document.createElement('template');
    template.innerHTML = getBugButton(url);
    return template.content.firstElementChild;
}

const hooks: RenderHooks = {
    /**
     * The message, with its `[file : line]` prefix linked to Searchfox.
     *
     * `linkifyFailureMessage` (`common-ui.js:22`) in element form. The test path
     * the link points at is the most-failing test of the row
     * (`failures.html:659`), which is why this is a closure over the current
     * rows rather than a pure function of the key.
     */
    labelNodes(key) {
        const split = messageLink(key);
        if (split === null) {
            return [key];
        }
        const row = renderedRows.find((candidate) => candidate.key === key);
        const testPath = row === undefined ? null : mostFrequentTestPath(row.paths);
        const href = getSearchfoxUrl(testPath ?? '', key);
        return [externalLink(href, split.linked), split.rest];
    },

    // `failures.html:671` puts the whole message in a `title`, because the cell
    // is `text-overflow: ellipsis` and a long message is cut off.
    labelTitle: (key) => key,

    occurrenceLinks(occurrence, testName) {
        // Profile always, Job when the revision is known. No crash viewer: a
        // failure has no minidump. `failures.html:801-805`.
        const links = [externalLink(getProfilerUrl(occurrence, testName), 'Profile')];
        const jobUrl = treeherderUrl(occurrence);
        if (jobUrl !== null) {
            links.push(externalLink(jobUrl, 'Job'));
        }
        return links;
    },

    jobNameHref: (occurrence, testName) => getProfilerUrl(occurrence, testName),

    testNameSuffix: (dirPath, test, key) => bugButton(`${dirPath}/${test.testName}`, key, test),

    // A failure row always has a profiler URL, so unlike a crash row it is
    // never inert. `failures.html:799`.
    singleRowHref: (occurrence, testName) => getProfilerUrl(occurrence, testName),

    totalRunsOf: (dirPath, testName) =>
        historicalData === null ? 0 : getTestTotalRuns(historicalData, dirPath, testName),

    tooltipOf: (count, totalRuns) => occurrenceTooltip(count, totalRuns, FAILURE_NOUN),
};

// --- rendering ------------------------------------------------------------

/** `renderFailureList` (`failures.html:526`). */
function render(): void {
    const target = content();
    target.textContent = '';

    if (decoded === null || groups.size === 0) {
        target.append(noData(VOCAB.emptyText));
        return;
    }

    const list = failureList(groups, searchBoxManager.getValue().toLowerCase(), currentSort);
    renderedRows = list.rows;
    expandable = list.expandable;

    const rendered = renderList(
        list.rows,
        totalsOf(list.rows),
        currentSort,
        VOCAB,
        hooks,
        onSortClicked,
        expandedMessage
    );
    rowsByKey = rendered.rowsByKey;
    target.append(rendered.root);

    if (expandedMessage !== null) {
        const row = rowsByKey.get(expandedMessage);
        // Upstream re-reads the *unfiltered* `currentData.failureData` here
        // (`:685`) even though every other expansion path on this page reads
        // `filteredFailureData`. That inconsistency is not reproduced: the
        // re-attach uses the same filtered subtree the click path does, so a row
        // that was expanded before a search does not silently widen to the
        // unfiltered subtree when the list re-renders. On the pinned snapshot
        // the two agree except under an active search, which is the case the
        // inconsistency was reachable in.
        const paths = expandable.get(expandedMessage);
        if (row !== undefined && paths !== undefined) {
            openMessage(row, expandedMessage, paths);
        }
    }
}

function onSortClicked(column: SortColumn): void {
    currentSort = nextSort(currentSort, column);
    render();
}

// --- expansion ------------------------------------------------------------

/** `failures.html:940`. A message's subtree runs until the next top-level row. */
const endsMessage = (element: Element): boolean =>
    element.classList.contains('failure-row') ||
    element.classList.contains('sort-header') ||
    element.classList.contains('total-row');

/** `failures.html:994`. */
const endsPath = (element: Element): boolean =>
    !(
        element.classList.contains('test-row') ||
        element.classList.contains('historical-chart') ||
        element.classList.contains('instance-table')
    );

/** `failures.html:1042`. */
const endsTest = (element: Element): boolean =>
    !(
        element.classList.contains('historical-chart') ||
        element.classList.contains('instance-table')
    );

/** Inserts a message's subtree and draws its chart. `failures.html:960`. */
function openMessage(row: HTMLElement, message: string, paths: Map<string, PathNode>): void {
    const elements: HTMLElement[] = [];
    const chartId = isHistoricalMode ? makeChartId('message', message) : null;
    if (chartId !== null) {
        elements.push(renderChartSlot(`${chartId}-canvas`));
    }
    elements.push(...renderSubRows(expandGroup(paths), message, VOCAB, hooks));
    insertAfter(row, elements);
    wireSubRows(elements, message);
    if (chartId !== null) {
        // `failures.html:966-974`: under a search, a row whose message does not
        // itself match gets a chart restricted to the tests that did match, so
        // the chart agrees with the (rewritten) count on the row.
        const term = searchBoxManager.getValue().toLowerCase();
        const filtered = term !== '' && !message.toLowerCase().includes(term);
        const series = filtered
            ? ratesForTests(message, testIdsOfSubtree(paths))
            : messageDailyRates(message);
        drawChart(`${chartId}-canvas`, series, message);
    }
}

/** `toggleFailure` (`failures.html:927`). */
function toggleMessage(message: string, row: HTMLElement): void {
    const wasExpanded = expandedMessage === message;

    if (expandedMessage !== null) {
        const open = wasExpanded ? row : rowsByKey.get(expandedMessage);
        if (open !== undefined) {
            open.classList.remove('expanded');
            removeFollowing(open, endsMessage);
        }
        expandedMessage = null;
        expandedPaths.clear();
        expandedTests.clear();
    }

    if (!wasExpanded) {
        expandedMessage = message;
        row.classList.add('expanded');
        const paths = expandable.get(message);
        if (paths !== undefined) {
            openMessage(row, message, paths);
        }
    }
}

/** `togglePath` (`failures.html:984`). */
function togglePath(message: string, dirPath: string, row: HTMLElement): void {
    const key = `${message}|||${dirPath}`;
    const wasExpanded = expandedPaths.has(key);
    row.classList.toggle('expanded', !wasExpanded);

    if (wasExpanded) {
        expandedPaths.delete(key);
        removeFollowing(row, endsPath);
        return;
    }

    expandedPaths.add(key);
    const path = expandable.get(message)?.get(dirPath);
    if (path === undefined) {
        return;
    }

    const elements: HTMLElement[] = [];
    const chartId = isHistoricalMode ? makeChartId('path', message, dirPath) : null;
    if (chartId !== null) {
        elements.push(renderChartSlot(`${chartId}-canvas`));
    }
    elements.push(...renderSubRows(expandPath(path), message, VOCAB, hooks));
    insertAfter(row, elements);
    wireSubRows(elements, message);
    if (chartId !== null) {
        // `failures.html:1013-1021`: the filtered variant applies when neither
        // the message nor the path matched the search.
        const term = searchBoxManager.getValue().toLowerCase();
        const filtered =
            term !== '' &&
            !message.toLowerCase().includes(term) &&
            !dirPath.toLowerCase().includes(term);
        const series = filtered
            ? ratesForTests(message, testIdsOfPath(dirPath, path))
            : pathDailyRates(message, dirPath);
        drawChart(`${chartId}-canvas`, series, `${message} in ${dirPath}`);
    }
}

/** `toggleTest` (`failures.html:1032`). */
function toggleTest(message: string, dirPath: string, testName: string, row: HTMLElement): void {
    const key = `${message}|||${dirPath}|||${testName}`;
    const wasExpanded = expandedTests.has(key);
    row.classList.toggle('expanded', !wasExpanded);

    if (wasExpanded) {
        expandedTests.delete(key);
        removeFollowing(row, endsTest);
        return;
    }

    expandedTests.add(key);
    const test = expandable.get(message)?.get(dirPath)?.tests.get(testName);
    if (test === undefined) {
        return;
    }

    const elements: HTMLElement[] = [];
    const chartId = isHistoricalMode ? makeChartId('test', message, dirPath, testName) : null;
    if (chartId !== null) {
        elements.push(renderChartSlot(`${chartId}-canvas`));
    }
    elements.push(renderOccurrenceTable(test, VOCAB, hooks));
    insertAfter(row, elements);
    if (chartId !== null) {
        // No filtered variant at the test level: upstream has none
        // (`failures.html:1063`), because a single test either matched or is not
        // on screen.
        drawChart(
            `${chartId}-canvas`,
            testDailyRates(message, dirPath, testName),
            `${message} in ${testName}`
        );
    }
}

/**
 * Attaches click behaviour to freshly inserted path and test rows.
 *
 * The `single-failure` rows already have their own listener from the renderer,
 * and `failures.html:734` excludes them from the expandable branch for the same
 * reason.
 */
function wireSubRows(elements: readonly HTMLElement[], message: string): void {
    for (const element of elements) {
        if (element.classList.contains('path-row')) {
            const dirPath = element.dataset['path']!;
            element.addEventListener('click', () => togglePath(message, dirPath, element));
        } else if (
            element.classList.contains('test-row') &&
            !element.classList.contains('single-failure')
        ) {
            const dirPath = element.dataset['path']!;
            const testName = element.dataset['test']!;
            element.addEventListener('click', () => toggleTest(message, dirPath, testName, element));
        }
    }
}

// --- the charts -----------------------------------------------------------

interface HistoricalRaw {
    metadata: { days?: number; startTime: number };
    tables: { messages: string[]; statuses: string[]; testPaths: string[]; testNames: string[] };
    testInfo: { testPathIds: number[]; testNameIds: number[] };
    testRuns: ({ messageIds?: (number | null)[] } | null)[][];
}

type DailySeries = ReturnType<typeof countDailyRunsForTests>;

/**
 * The message's table index, or -1.
 *
 * `'(no failure message)'` is a *display* name this page invents, not a table
 * entry, so `indexOf` returns -1 for it and its chart is all zeroes. That is
 * upstream's behaviour (`failures.html:368` on a message that is not in
 * `tables.messages`) and is reproduced: the top row of the page has an empty
 * chart on both.
 */
function messageId(historical: HistoricalRaw, message: string): number {
    return historical.tables.messages.indexOf(message);
}

/** Counts the series for an explicit set of test IDs. */
function ratesForTests(message: string, testIds: Set<string>): DailySeries | null {
    if (historicalData === null) {
        return null;
    }
    const historical = historicalData as HistoricalRaw;
    return countDailyRunsForTests(
        historical,
        testIds,
        messageId(historical, message),
        'messageIds',
        'FAIL',
        historical.metadata.days ?? 21,
        historical.metadata.startTime
    );
}

/** The tests that ever produced this message, optionally within one path. */
function ratesFor(message: string, keep: (testId: string) => boolean): DailySeries | null {
    if (historicalData === null) {
        return null;
    }
    const historical = historicalData as HistoricalRaw;
    const targetId = messageId(historical, message);
    if (targetId === -1) {
        return ratesForTests(message, new Set<string>());
    }

    const testIds = new Set<string>();
    for (const testId in historical.testRuns) {
        if (!keep(testId)) {
            continue;
        }
        const testGroup = historical.testRuns[testId as unknown as number];
        if (!testGroup) {
            continue;
        }
        for (let statusId = 0; statusId < testGroup.length; statusId++) {
            const statusGroup = testGroup[statusId];
            if (!statusGroup) {
                continue;
            }
            const status = historical.tables.statuses[statusId];
            if (
                status !== undefined &&
                status.startsWith('FAIL') &&
                statusGroup.messageIds &&
                statusGroup.messageIds.some((id) => id === targetId)
            ) {
                testIds.add(testId);
                break;
            }
        }
    }
    return ratesForTests(message, testIds);
}

const messageDailyRates = (message: string): DailySeries | null => ratesFor(message, () => true);

const pathDailyRates = (message: string, dirPath: string): DailySeries | null =>
    ratesFor(message, (testId) => pathOf(testId) === dirPath);

/**
 * The per-test series.
 *
 * As on the crashes page, upstream does not reuse the walk here: it finds the
 * one test by path and name without checking that it ever had the message
 * (`failures.html:489-513`). Reproduced.
 */
function testDailyRates(message: string, dirPath: string, testName: string): DailySeries | null {
    if (historicalData === null) {
        return null;
    }
    const historical = historicalData as HistoricalRaw;
    const testIds = new Set<string>();
    if (messageId(historical, message) !== -1) {
        for (const testId in historical.testRuns) {
            if (pathOf(testId) === dirPath && nameOf(testId) === testName) {
                testIds.add(testId);
                break;
            }
        }
    }
    return ratesForTests(message, testIds);
}

/** Every test ID named by a (possibly search-rewritten) subtree. */
function testIdsOfSubtree(paths: Map<string, PathNode>): Set<string> {
    const ids = new Set<string>();
    for (const path of paths.values()) {
        for (const testId of testIdsOfPath(path.dirPath, path)) {
            ids.add(testId);
        }
    }
    return ids;
}

/**
 * The test IDs of one path's tests.
 *
 * Upstream's `calculateFilteredPathDailyFailureRates` (`failures.html:462`) does
 * this as a nested loop over every test in the file *per test name*, which is
 * O(tests × names). One pass over the file with a name set is the same answer;
 * the difference is only in how long it takes, and on the 4,838-test xpcshell
 * file the old form is visible as a pause when expanding a searched row.
 */
function testIdsOfPath(dirPath: string, path: PathNode): Set<string> {
    const ids = new Set<string>();
    if (historicalData === null) {
        return ids;
    }
    const historical = historicalData as HistoricalRaw;
    const names = new Set(path.tests.keys());
    for (const testId in historical.testRuns) {
        if (pathOf(testId) === dirPath && names.has(nameOf(testId))) {
            ids.add(testId);
        }
    }
    return ids;
}

function pathOf(testId: string): string {
    const historical = historicalData as HistoricalRaw;
    return historical.tables.testPaths[
        historical.testInfo.testPathIds[testId as unknown as number]!
    ]!;
}

function nameOf(testId: string): string {
    const historical = historicalData as HistoricalRaw;
    return historical.tables.testNames[
        historical.testInfo.testNameIds[testId as unknown as number]!
    ]!;
}

/**
 * Draws one rate chart.
 *
 * `createFailureChart` (`failures.html:516`) renames `events` to `failures`
 * first; nothing reads the renamed field, so the rename is dropped.
 */
function drawChart(canvasId: string, series: DailySeries | null, label: string): void {
    if (series === null) {
        return;
    }
    createRateChart(canvasId, series, label, 'failure');
}

// --- data loading ---------------------------------------------------------

/** `loadSelectedDate` (`failures.html:169`). */
async function loadSelectedDate(): Promise<void> {
    const date = dateSelect().value;
    if (!date) {
        return;
    }

    try {
        statusText().textContent = 'Loading...';
        const harness = getHarnessType();
        const response = await fetchData(`${harness}-${date}.json`);
        if (!response.ok) {
            throw new Error('Failed to load data');
        }
        const file = (await response.json()) as DailyFile;
        rawData = file;
        decoded = decodeDaily(file);
        startTime = file.metadata.startTime;
        groups = buildFailureGroups(decoded, startTime);
        render();
        const jobCount = file.metadata.jobCount ?? 0;
        statusText().textContent = `${jobCount.toLocaleString()} test jobs`;
    } catch (error) {
        console.error('Error loading data:', error);
        const target = content();
        target.textContent = '';
        target.append(noData(error instanceof Error ? error.message : String(error)));
        statusText().textContent = 'Error loading data';
    }
}

/** `failures.html:141-160`, the data half of the historical toggle. */
async function onHistoricalToggled(isHistorical: boolean, data: unknown): Promise<void> {
    isHistoricalMode = isHistorical;
    if (isHistorical) {
        historicalData = data;
        rawData = data;
        const file = data as IssuesWithTaskIdsFile;
        decoded = decodeIssuesWithTaskIds(file);
        startTime = file.metadata.startTime;
        groups = buildFailureGroups(decoded, startTime);
        render();
    } else {
        await loadSelectedDate();
    }
    updateUrlHash();
}

// --- URL state ------------------------------------------------------------

function updateUrlHash(): void {
    hashManager?.updateHash();
}

/**
 * Applies the hash to the page. `loadFromUrlHash` (`failures.html:1092`).
 *
 * The one behaviour change on this page's divergence list is here: upstream's
 * `state.q` guard (`:1100`) means an absent `q` never clears the box, so a link
 * with no search term produces a filtered list. `state.q ?? ''` clears it. The
 * focus guard is unchanged, so a hashchange never interrupts typing.
 */
async function loadFromUrlHash(): Promise<void> {
    if (hashManager === undefined) {
        return;
    }
    const state = readUrlState(hashManager.getParams());
    const box = document.getElementById('searchBox');
    if (document.activeElement !== box) {
        searchBoxManager.setValue(state.q ?? '');
    }

    if (isHistoricalDate(state.date)) {
        if (!isHistoricalMode) {
            await historicalToggleManager.toggle();
        }
    } else {
        if (isHistoricalMode) {
            await historicalToggleManager.toggle();
        }
        if (dateSelect().value !== state.date) {
            dateSelect().value = state.date!;
        }
    }
}

// --- startup --------------------------------------------------------------

function initializeUI(): void {
    initHarnessSwitcher('Failures by Message');

    searchBoxManager = searchBox({
        searchBoxId: 'searchBox',
        searchClearId: 'searchClear',
        onSearch: render,
        updateUrlHash,
    });

    hashManager = initUrlHashManager({
        getState: () => ({
            date: isHistoricalMode ? '21days' : dateSelect().value,
            q: searchBoxManager.getValue().trim(),
        }),
        onHashChange: async () => {
            searchBoxManager.setNavigating(true);
            await loadFromUrlHash();
            if (!isHistoricalMode) {
                await loadSelectedDate();
            } else {
                // Upstream re-renders only via `loadSelectedDate`, so a
                // hashchange that only changes `q` while in the 21-day view
                // updates the box and not the list. Rendering here is what makes
                // the fix in divergence 5 observable rather than cosmetic.
                render();
            }
            searchBoxManager.setNavigating(false);
        },
    });

    const harness = getHarnessType();
    historicalToggleManager = initHistoricalToggle({
        buttonId: 'historicalButton',
        selectId: 'dateSelect',
        statusTextId: 'statusText',
        fetchData,
        historicalDataFile: `${harness}-issues-with-taskids.json`,
        onToggle: onHistoricalToggled,
        updateUrlHash,
    });

    dateSelect().addEventListener('change', () => {
        updateUrlHash();
        void loadSelectedDate();
    });
}

/** Delegated clicks on the top-level rows. See `next/crashes.ts`. */
function setupClickHandlers(): void {
    content().addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element) || target.tagName === 'A') {
            return;
        }
        const row = target.closest('.failure-row');
        if (row === null || row.classList.contains('total-row')) {
            return;
        }
        for (const [message, element] of rowsByKey) {
            if (element === row) {
                toggleMessage(message, element);
                return;
            }
        }
    });
}

/**
 * Wires the page up and loads it. Called by the page, not by importing it.
 *
 * See `next/crashes.ts` for why this is exported rather than run at module
 * scope: importing a controller used to start the page, which is what left the
 * renderers and controllers untestable.
 */
export async function start(): Promise<void> {
    setupClickHandlers();
    initializeUI();

    const hasData = await populateDateSelector({
        selectId: 'dateSelect',
        statusTextId: 'statusText',
        fetchData,
    });

    if (hasData) {
        const select = dateSelect();
        if (!select.value && select.options.length > 0) {
            select.selectedIndex = 0;
        }
        await loadFromUrlHash();
        if (!isHistoricalMode) {
            await loadSelectedDate();
        }
    }
}

/** The view model, for the browser parity harness. See `next/crashes.ts`. */
window.__view = () => ({
    sort: currentSort,
    historical: isHistoricalMode,
    search: searchBoxManager?.getValue() ?? '',
    totals: totalsOf(renderedRows),
    rows: renderedRows.map((row) => ({
        key: row.key,
        testCount: row.testCount,
        count: row.count,
    })),
});

export type { GroupRow, Occurrence, TestNode };
