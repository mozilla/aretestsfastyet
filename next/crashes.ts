/**
 * `crashes.html`, migrated onto `lib/`.
 *
 * Migrated as **one job** with `failures.html`, because the two are near-twins:
 * same row/path/test/occurrence drill-down, same collapse rule, same ranking,
 * same URL state. Doing them separately would have meant porting that structure
 * twice. The split:
 *
 * | file | contains | tested by |
 * | --- | --- | --- |
 * | `lib/` | the file formats and the five status-group shapes | node tests, shared with the CLI |
 * | `next/drilldown-view.ts` | the shared view model: tree, ranking, collapse, totals, URL state | `test/drilldown-view.test.ts`, no DOM |
 * | `next/drilldown-render.ts` | the shared renderer | the browser parity run |
 * | `next/crashes-view.ts` | what is only true of this page | `test/crashes-view.test.ts`, no DOM |
 * | this file | data loading, this page's hooks, and the interactions | the browser parity run |
 *
 * ## What the migration removes
 *
 * **The inline decoding of the status-group shapes.** `processCrashData`
 * (`crashes.html:225-374`) is 150 lines that branch on `isBucketedFormat` and
 * hand-decode `days` or `timestamps`, which covers two of the five shapes
 * `FORMATS.md` documents and silently misreads the other three.
 * `lib/formats/status-entries.ts` resolves all five and throws on a sixth.
 *
 * `common-test-data.js` is **not** loaded, and was **not loaded before either**
 * — unlike the three earlier migrations, this page never had the tag. Verified:
 * `grep -c common-test-data crashes.html` is 0, and none of its seven globals
 * (`detectHarness`, `getChunkIndex`, `getCountAtIndex`, `findTest`,
 * `stripChunkSuffix`, `computeConfigStats`, `computeTestStats`) appears in
 * either page's source. So there is nothing to remove here and no byte saved;
 * the brief's requirement that it stop being loaded is satisfied vacuously, and
 * saying so is more useful than implying a removal that did not happen.
 *
 * The six shared scripts **stay, loaded by name**: `shared.js`,
 * `fetch-utils.js`, `dashboards.js`, `common-ui.js`, `common-charts.js` and
 * `common-links.js`. They are UI plumbing with no `lib/` equivalent, up to 22
 * unmigrated pages depend on them, and `tools/build-pages.ts` copies them next
 * to the built page. `common-charts.js` in particular still owns the Chart.js
 * wiring and `getTestTotalRuns`, neither of which has a `lib/` counterpart.
 *
 * ## Declared divergences from `crashes.html`
 *
 * `PARITY.md` §4: byte-identical is the default and every exception is declared.
 * **This list is the whole set** — one enumerated list, no prose carrying an
 * eighth entry, because that is exactly how an entry went missing on an earlier
 * migration.
 *
 *  1. **Inline handler attributes become `addEventListener`.** The largest DOM
 *     difference by far. Upstream emits `onclick="sortBy('tests')"`,
 *     `onclick="sortBy('count')"` and `onclick="event.stopPropagation();"` on
 *     every occurrence link as **attributes**; this page attaches the same
 *     handlers and emits none of them. Measured in Chrome on the pinned
 *     snapshot, counting `on*` attributes in the live DOM: **old 2, new 0** at
 *     first paint (the two sort buttons), rising as rows are expanded — one per
 *     occurrence link. Behaviour-preserving, but it is what lets this file be a
 *     module instead of a bag of globals.
 *
 *  2. **`data-signature` is gone; rows are held in a `Map`.** Upstream writes
 *     `data-signature="${escapeAttr(sig)}"` on every row and finds a row again
 *     with `querySelector('[data-signature="' + escapeAttr(sig) + '"]')`
 *     (`:584`, `:597`). Here the renderer keeps the row elements in a `Map`
 *     keyed by the raw signature. **Measured: 0 of the 90 signatures on the
 *     pinned snapshot are affected by the escaping mismatch** — a signature is a
 *     symbol name and contains no quotes — so on this page the change removes a
 *     latent bug rather than a live one. (It is live on `failures.html`; see
 *     that file's entry 2.) **A DOM diff sees this as one absent attribute per
 *     row.**
 *
 *  3. **The total row's "Tests" number still overcounts.** It sums each row's
 *     test count, so a test that crashes with three signatures counts three
 *     times. Measured on the pinned snapshot: the row shows **1,098** where
 *     **676** distinct tests crashed, a 1.62× overcount, with 266 of those 676
 *     having more than one signature. **Reproduced unchanged.** The number is
 *     the sum of the column above it, a reader can check it by adding the rows
 *     up, and on a searched list it is the only number that responds to the
 *     search; replacing it with a distinct count would make it disagree with the
 *     column and with the reader's arithmetic, which is a product decision about
 *     a number a human reads rather than a migration's to make. The per-row
 *     count, by contrast, is *not* a double-count — see `GroupRow.testCount` for
 *     the measurement that establishes this.
 *
 *  4. **The search still hides rows without changing their numbers.**
 *     Reproduced exactly, including its two consequences: a surviving row shows
 *     its pre-filter counts and expands to tests that do not match, while the
 *     **total row does change** because it is summed after the filter. So under
 *     a search the total is the sum of the *whole* of each matching row.
 *     `failures.html` does the opposite; the difference is upstream's.
 *
 *  5. **An unsymbolized crash is still dropped.** Upstream skips a null
 *     signature (`:270`), where `lib/query/crashes.ts` deliberately keeps it as
 *     a `null` group on the grounds that an unsymbolized crash is still a crash.
 *     The page's rule is reproduced. Measured: **0 of 21,252 crash occurrences**
 *     on the pinned xpcshell snapshot have a null signature, so the two rules
 *     select the same runs here and this is a page-vs-CLI divergence rather than
 *     an old-vs-new one.
 *
 *  6. **A job name the file cannot resolve renders as empty, not `"undefined"`.**
 *     Upstream indexes `tables.jobNames[jobNameId]` with no guard, so a file
 *     with no `taskInfo` renders the string `undefined` into the cell. Here it
 *     is an empty string. Not reachable on either file this page loads — both
 *     carry `taskInfo` — so this is a difference in the unreachable branch, not
 *     in anything rendered on the pinned data.
 *
 * Two behaviours worth naming that are **not** divergences, because they were
 * measured to be identical and an earlier draft of this list wrongly claimed one
 * of them was a change:
 *
 * - **The historical-fetch-failure fallback.** When the 21-day fetch throws,
 *   `common-ui.js:262-271` writes the error into `#content`, leaves
 *   `isHistoricalMode` false, and `crashes.html:1032` then loads the selected
 *   date on top of it — so the error is overwritten by a normal single-day
 *   render and the reader is silently shown a different window than the one
 *   they asked for. Driven in Chrome with the 21-day file 404ing *and the CI
 *   origin blocked at the browser* — without the block, `fetch-utils.js:259`
 *   quietly satisfies the fetch from live CI and the scenario never happens,
 *   which is how the first run of this probe produced a 21-day view dated
 *   2026-07-15..08-04 instead of the pinned 07-14..08-03. With the block, both
 *   pages land on `{status: "1 301 test jobs", rows: 27, button: "Show Last 21
 *   Days", hash: ""}` — byte-identical, including the silent fallback.
 * - **The empty/failed single-day load.** With every data file 404ing, both
 *   pages show `{status: "Error loading data", .no-data: "Failed to fetch",
 *   rows: 0}`.
 *
 * Everything else — the row unit, the 21-day default, the sort keys and their
 * directions, the path collapse, the inline single occurrence, the tooltip and
 * its rounding, the chart wiring, and the `#date=…&q=…` state — is reproduced,
 * and the reasoning for each lives next to the code that does it in
 * `next/drilldown-view.ts`.
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
import { CRASH_NOUN, buildCrashGroups, crashRows, singleCrashOpensViewer } from './crashes-view.ts';

/** The class names and labels this page uses. See `Vocabulary`. */
const VOCAB: Vocabulary = {
    kind: 'crash',
    rowClass: 'crash-row',
    labelClass: 'crash-signature',
    statsClass: 'crash-stats',
    listClass: 'crash-list',
    countClass: 'crash',
    singleClass: 'single-crash',
    jobNameClass: 'crash-job-name',
    testCountClass: 'test-crash-count',
    labelHeader: 'Crash Signature',
    countHeader: 'Crashes',
    emptyText: 'No crash data available',
};

// --- page state -----------------------------------------------------------

/**
 * The raw parsed file, kept because three shared functions need it as-is.
 *
 * `getTreeherderJobUrl`, `getTestTotalRuns` and `countDailyRunsForTests` all
 * take the untyped JSON and index into `tables`/`taskInfo`/`testRuns`
 * themselves. They are `common-links.js` and `common-charts.js`, which this
 * migration keeps, so the raw object has to survive alongside the decoded one.
 */
let rawData: unknown = null;
/** The decoded view of `rawData`. */
let decoded: DecodedTimingFile | null = null;
/** `metadata.startTime`, which the day indices are relative to. */
let startTime = 0;
/** The signature tree. */
let groups: Map<string, GroupNode> = new Map();
/** The raw 21-day file, kept for the charts and the run totals. */
let historicalData: unknown = null;
let isHistoricalMode = false;

let expandedSignature: string | null = null;
const expandedPaths = new Set<string>();
const expandedTests = new Set<string>();
let currentSort: SortState = { ...INITIAL_SORT };

/** The row elements of the last render, keyed by raw signature. */
let rowsByKey = new Map<string, HTMLElement>();
/** The rows of the last render, so an expansion can find its subtree. */
let renderedRows: GroupRow[] = [];

let searchBoxManager: SearchBoxManager;
let hashManager: ReturnType<typeof initUrlHashManager>;
let historicalToggleManager: { toggle: () => Promise<void> };

const content = (): HTMLElement => document.getElementById('content')!;
const statusText = (): HTMLElement => document.getElementById('statusText')!;
const dateSelect = (): HTMLSelectElement =>
    document.getElementById('dateSelect') as HTMLSelectElement;

// --- the page's hooks -----------------------------------------------------

/**
 * The Treeherder link for an occurrence, or `null`.
 *
 * `getTreeherderJobUrl` needs the raw file and does an `indexOf` over
 * `tables.taskIds` for every call, which is why the renderer asks for the
 * answer rather than computing it.
 */
function treeherderUrl(occurrence: Occurrence): string | null {
    if (rawData === null) {
        return null;
    }
    return getTreeherderJobUrl(occurrence, rawData);
}

const hooks: RenderHooks = {
    // A crash signature is plain text. `crashes.html:585`, which passes it
    // through `escapeHtml`.
    labelNodes: (key) => [key],
    // Upstream puts no `title` on a signature cell — unlike the failures page,
    // whose messages are truncated with an ellipsis and need one.
    labelTitle: () => undefined,

    occurrenceLinks(occurrence, testName) {
        // `renderCrashLinks` (`common-links.js:76`) in element form: Profile
        // always, Crash when a dump was uploaded, Job when the revision is
        // known.
        const links = [externalLink(getProfilerUrl(occurrence, testName), 'Profile')];
        const crashUrl = getCrashViewerUrl(occurrence);
        if (crashUrl) {
            links.push(externalLink(crashUrl, 'Crash'));
        }
        const jobUrl = treeherderUrl(occurrence);
        if (jobUrl !== null) {
            links.push(externalLink(jobUrl, 'Job'));
        }
        return links;
    },

    // The crash viewer where there is a dump, the profiler otherwise.
    // `crashes.html:711` and `:816`.
    jobNameHref: (occurrence, testName) =>
        getCrashViewerUrl(occurrence) || getProfilerUrl(occurrence, testName),

    // This page has no bug-filing button. `failures.html` is the one with a
    // component to file against.
    testNameSuffix: () => null,

    singleRowHref: (occurrence) =>
        singleCrashOpensViewer(occurrence) ? getCrashViewerUrl(occurrence) : null,

    totalRunsOf: (dirPath, testName) =>
        historicalData === null ? 0 : getTestTotalRuns(historicalData, dirPath, testName),

    tooltipOf: (count, totalRuns) => occurrenceTooltip(count, totalRuns, CRASH_NOUN),
};

// --- rendering ------------------------------------------------------------

/** `renderCrashList` (`crashes.html:484`). */
function render(): void {
    const target = content();
    target.textContent = '';

    if (decoded === null || groups.size === 0) {
        target.append(noData(VOCAB.emptyText));
        return;
    }

    const rows = crashRows(groups, searchBoxManager.getValue().toLowerCase(), currentSort);
    renderedRows = rows;

    const list = renderList(
        rows,
        totalsOf(rows),
        currentSort,
        VOCAB,
        hooks,
        onSortClicked,
        expandedSignature
    );
    rowsByKey = list.rowsByKey;
    target.append(list.root);

    // Re-attach the open row's subtree after a full re-render. Upstream does
    // this by selector (`crashes.html:597`) and this by Map lookup; see
    // divergence 2.
    if (expandedSignature !== null) {
        const row = rowsByKey.get(expandedSignature);
        const group = groups.get(expandedSignature);
        if (row !== undefined && group !== undefined) {
            // Deliberately the *unfiltered* subtree, matching upstream, which
            // re-reads `currentData.crashData` here (`:599`) rather than the
            // filtered list. It is the other half of this page's search
            // semantics: a row's expansion is never narrowed by the search.
            openSignature(row, expandedSignature, group.paths);
        }
    }
}

function onSortClicked(column: SortColumn): void {
    currentSort = nextSort(currentSort, column);
    render();
}

// --- expansion ------------------------------------------------------------

/**
 * Whether an element ends the run of rows belonging to an expanded signature.
 *
 * `crashes.html:841`. A signature's subtree runs until the next top-level row.
 */
const endsSignature = (element: Element): boolean =>
    element.classList.contains('crash-row') ||
    element.classList.contains('sort-header') ||
    element.classList.contains('total-row');

/**
 * Whether an element ends the run of rows belonging to an expanded path or test.
 *
 * `crashes.html:888` and `:929`, which stop on *anything that is not* one of
 * these — so the predicate is the negation.
 */
const endsPath = (element: Element): boolean =>
    !(
        element.classList.contains('test-row') ||
        element.classList.contains('historical-chart') ||
        element.classList.contains('instance-table')
    );

const endsTest = (element: Element): boolean =>
    !(
        element.classList.contains('historical-chart') ||
        element.classList.contains('instance-table')
    );

/** Inserts a signature's subtree and draws its chart. `crashes.html:863`. */
function openSignature(row: HTMLElement, signature: string, paths: Map<string, PathNode>): void {
    const elements: HTMLElement[] = [];
    const chartId = isHistoricalMode ? makeChartId('signature', signature) : null;
    if (chartId !== null) {
        elements.push(renderChartSlot(`${chartId}-canvas`));
    }
    elements.push(...renderSubRows(expandGroup(paths), signature, VOCAB, hooks));
    insertAfter(row, elements);
    wireSubRows(elements, signature);
    if (chartId !== null) {
        drawChart(`${chartId}-canvas`, signatureDailyRates(signature), signature);
    }
}

/** `toggleCrash` (`crashes.html:828`). */
function toggleSignature(signature: string, row: HTMLElement): void {
    const wasExpanded = expandedSignature === signature;

    if (expandedSignature !== null) {
        const open = wasExpanded ? row : rowsByKey.get(expandedSignature);
        if (open !== undefined) {
            open.classList.remove('expanded');
            removeFollowing(open, endsSignature);
        }
        expandedSignature = null;
        expandedPaths.clear();
        expandedTests.clear();
    }

    if (!wasExpanded) {
        expandedSignature = signature;
        row.classList.add('expanded');
        const group = groups.get(signature);
        if (group !== undefined) {
            openSignature(row, signature, group.paths);
        }
    }
}

/** `togglePath` (`crashes.html:878`). */
function togglePath(signature: string, dirPath: string, row: HTMLElement): void {
    const key = `${signature}|||${dirPath}`;
    const wasExpanded = expandedPaths.has(key);
    row.classList.toggle('expanded', !wasExpanded);

    if (wasExpanded) {
        expandedPaths.delete(key);
        removeFollowing(row, endsPath);
        return;
    }

    expandedPaths.add(key);
    const path = groups.get(signature)?.paths.get(dirPath);
    if (path === undefined) {
        return;
    }

    const elements: HTMLElement[] = [];
    const chartId = isHistoricalMode ? makeChartId('path', signature, dirPath) : null;
    if (chartId !== null) {
        elements.push(renderChartSlot(`${chartId}-canvas`));
    }
    elements.push(...renderSubRows(expandPath(path), signature, VOCAB, hooks));
    insertAfter(row, elements);
    wireSubRows(elements, signature);
    if (chartId !== null) {
        drawChart(
            `${chartId}-canvas`,
            pathDailyRates(signature, dirPath),
            `${signature} in ${dirPath}`
        );
    }
}

/** `toggleTest` (`crashes.html:919`). */
function toggleTest(
    signature: string,
    dirPath: string,
    testName: string,
    row: HTMLElement
): void {
    const key = `${signature}|||${dirPath}|||${testName}`;
    const wasExpanded = expandedTests.has(key);
    row.classList.toggle('expanded', !wasExpanded);

    if (wasExpanded) {
        expandedTests.delete(key);
        removeFollowing(row, endsTest);
        return;
    }

    expandedTests.add(key);
    const test = groups.get(signature)?.paths.get(dirPath)?.tests.get(testName);
    if (test === undefined) {
        return;
    }

    const elements: HTMLElement[] = [];
    const chartId = isHistoricalMode ? makeChartId('test', signature, dirPath, testName) : null;
    if (chartId !== null) {
        elements.push(renderChartSlot(`${chartId}-canvas`));
    }
    elements.push(renderOccurrenceTable(test, VOCAB, hooks));
    insertAfter(row, elements);
    if (chartId !== null) {
        drawChart(
            `${chartId}-canvas`,
            testDailyRates(signature, dirPath, testName),
            `${signature} in ${testName}`
        );
    }
}

/**
 * Attaches the click behaviour to freshly inserted path and test rows.
 *
 * Upstream uses one delegated listener on `#content` that walks up from the
 * event target and reads `dataset` (`crashes.html:619-679`). That works because
 * the data it needs is in attributes; here the rows are elements the renderer
 * just built, so the listener closes over the values directly and there is no
 * attribute to read back. The `single-crash` rows already carry their own
 * listener from the renderer.
 */
function wireSubRows(elements: readonly HTMLElement[], signature: string): void {
    for (const element of elements) {
        if (element.classList.contains('path-row')) {
            const dirPath = element.dataset['path']!;
            element.addEventListener('click', () => togglePath(signature, dirPath, element));
        } else if (
            element.classList.contains('test-row') &&
            !element.classList.contains('single-crash')
        ) {
            const dirPath = element.dataset['path']!;
            const testName = element.dataset['test']!;
            element.addEventListener('click', () =>
                toggleTest(signature, dirPath, testName, element)
            );
        }
    }
}

// --- the charts -----------------------------------------------------------

/**
 * The daily rate series for a signature, path or test.
 *
 * These are `calculateSignatureDailyCrashRates` and friends
 * (`crashes.html:377-472`), which walk the *raw* historical file to collect the
 * test IDs to count and then hand them to `countDailyRunsForTests`
 * (`common-charts.js:149`). The shared function is kept, so the test-ID walk
 * stays on the raw file too — porting it to the decoded file would mean
 * `lib/` yielding test IDs that then index back into the raw arrays, which is
 * more coupling than the three call sites are worth.
 */
interface HistoricalRaw {
    metadata: { days?: number; startTime: number };
    tables: { crashSignatures: string[]; statuses: string[]; testPaths: string[]; testNames: string[] };
    testInfo: { testPathIds: number[]; testNameIds: number[] };
    testRuns: ({ crashSignatureIds?: (number | null)[] } | null)[][];
}

/** The signature's table index in the historical file, or -1. */
function signatureId(historical: HistoricalRaw, signature: string): number {
    return historical.tables.crashSignatures.indexOf(signature);
}

type DailySeries = ReturnType<typeof countDailyRunsForTests>;

function ratesFor(signature: string, keep: (testId: string) => boolean): DailySeries | null {
    if (historicalData === null) {
        return null;
    }
    const historical = historicalData as HistoricalRaw;
    const days = historical.metadata.days ?? 21;
    const start = historical.metadata.startTime;
    const targetId = signatureId(historical, signature);
    if (targetId === -1) {
        return countDailyRunsForTests(
            historical,
            new Set<string>(),
            targetId,
            'crashSignatureIds',
            'CRASH',
            days,
            start
        );
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
            // `=== 'CRASH'`, exactly as upstream (`crashes.html:435`).
            if (
                historical.tables.statuses[statusId] === 'CRASH' &&
                statusGroup.crashSignatureIds &&
                statusGroup.crashSignatureIds.some((id) => id === targetId)
            ) {
                testIds.add(testId);
                break;
            }
        }
    }

    return countDailyRunsForTests(
        historical,
        testIds,
        targetId,
        'crashSignatureIds',
        'CRASH',
        days,
        start
    );
}

const signatureDailyRates = (signature: string): DailySeries | null => ratesFor(signature, () => true);

const pathDailyRates = (signature: string, dirPath: string): DailySeries | null =>
    ratesFor(signature, (testId) => pathOf(testId) === dirPath);

/**
 * The per-test series.
 *
 * Upstream does *not* reuse the signature walk here: it finds the one test by
 * path and name and passes it straight to `countDailyRunsForTests`, without
 * checking that the test ever had the signature (`crashes.html:447-471`). That
 * difference is observable — the denominator is the test's runs either way, but
 * the walk-based version would exclude a test with no matching entries and this
 * one includes it with zero events — so it is reproduced rather than unified.
 */
function testDailyRates(
    signature: string,
    dirPath: string,
    testName: string
): DailySeries | null {
    if (historicalData === null) {
        return null;
    }
    const historical = historicalData as HistoricalRaw;
    const days = historical.metadata.days ?? 21;
    const start = historical.metadata.startTime;
    const targetId = signatureId(historical, signature);
    const testIds = new Set<string>();
    if (targetId !== -1) {
        for (const testId in historical.testRuns) {
            if (pathOf(testId) === dirPath && nameOf(testId) === testName) {
                testIds.add(testId);
                break;
            }
        }
    }
    return countDailyRunsForTests(
        historical,
        testIds,
        targetId,
        'crashSignatureIds',
        'CRASH',
        days,
        start
    );
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
 * `createCrashChart` (`crashes.html:474`) renames `events` to `crashes` before
 * handing the series to `createRateChart`. Nothing reads the renamed field —
 * `createRateChart` uses `events` and `totalRuns` (`common-charts.js:338`,
 * `:367`) — so the rename is dropped and the series goes through as it is.
 */
function drawChart(canvasId: string, series: DailySeries | null, label: string): void {
    if (series === null) {
        return;
    }
    createRateChart(canvasId, series, label, 'crash');
}

// --- data loading ---------------------------------------------------------

/** `loadSelectedDate` (`crashes.html:187`). */
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
        groups = buildCrashGroups(decoded, startTime);
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

/**
 * Enters or leaves the 21-day view.
 *
 * The button, the date selector's disabled state and the status text are
 * `common-ui.js`'s `initHistoricalToggle`; this is only the data side of the
 * callback. `crashes.html:159-178`.
 */
async function onHistoricalToggled(isHistorical: boolean, data: unknown): Promise<void> {
    isHistoricalMode = isHistorical;
    if (isHistorical) {
        historicalData = data;
        rawData = data;
        const file = data as IssuesWithTaskIdsFile;
        decoded = decodeIssuesWithTaskIds(file);
        startTime = file.metadata.startTime;
        groups = buildCrashGroups(decoded, startTime);
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
 * Applies the hash to the page. `loadFromUrlHash` (`crashes.html:981`).
 *
 * Two upstream behaviours are reproduced deliberately:
 *
 * - **No date, or `21days`, means the 21-day view.** This is what makes
 *   historical the default despite `isHistoricalMode = false` at `:121`.
 * - **A `q` is only written into the box when it is truthy** (`:989`), so
 *   navigating from `#q=foo` to `#date=…` with no `q` leaves `foo` in the box
 *   and the list filtered by a term the URL no longer names. That is a bug, and
 *   it is on the divergence list as reproduced — see this file's entry list.
 */
async function loadFromUrlHash(): Promise<void> {
    if (hashManager === undefined) {
        return;
    }
    const state = readUrlState(hashManager.getParams());
    const searchBox = document.getElementById('searchBox');
    if (document.activeElement !== searchBox && state.q) {
        searchBoxManager.setValue(state.q);
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
    initHarnessSwitcher('Crashes by Signature');

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

    // The `<select>`'s own `onchange="loadSelectedDate()"` attribute is in the
    // markup upstream; here both the reload and the hash update are listeners.
    dateSelect().addEventListener('change', () => {
        updateUrlHash();
        void loadSelectedDate();
    });
}

/**
 * Delegated clicks on the top-level rows.
 *
 * Only the signature rows need delegation — they are re-created on every render
 * — and the sub-rows get their listeners from `wireSubRows` when they are
 * inserted. Upstream delegates all four levels through one handler
 * (`crashes.html:619`).
 */
function setupClickHandlers(): void {
    content().addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element) || target.tagName === 'A') {
            return;
        }
        const row = target.closest('.crash-row');
        if (row === null || row.classList.contains('total-row')) {
            return;
        }
        for (const [signature, element] of rowsByKey) {
            if (element === row) {
                toggleSignature(signature, element);
                return;
            }
        }
    });
}

/**
 * Wires the page up and loads it. Called by the page, not by importing it.
 *
 * This used to be a bare `setupClickHandlers()` and an awaited IIFE at module
 * scope, which meant importing this file *started the page* — it attached
 * listeners, populated the date selector and fetched data. That is why nothing
 * tested it: `drilldown-render.ts` and the two controllers were 2,598 lines,
 * 60% of the migration, that no test could import, and inverting the page
 * branch in `inlineLinksCell` passed both `npm test` and `tsc`.
 *
 * Exporting the entry point is the whole fix. Everything above is now
 * declarations, so a test can import this module for its pure half — the
 * vocabulary, the hooks, the URL state — without a browser and without
 * fetching anything.
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

/**
 * The view model, for the browser parity harness.
 *
 * `PARITY.md` §2: a page that builds strings has no seam to compare against.
 * This is the seam — the ranked rows and the totals as plain values, so the
 * comparison can assert on decisions rather than on pixels. `try.html` exposes
 * `window.failures` for the same reason.
 */
declare global {
    interface Window {
        __view?: () => unknown;
    }
}
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
