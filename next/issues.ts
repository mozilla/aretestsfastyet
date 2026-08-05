/**
 * `issues.html`, migrated onto `lib/`.
 *
 * The last and largest of the page migrations, and the only one with a
 * deliberate behaviour change (divergence 1 below).
 *
 * | file | contains | tested by |
 * | --- | --- | --- |
 * | `lib/query/issues.ts` | the per-test counters and the component grouping, shared with the CLI | `test/query.test.ts` |
 * | `next/issues-view.ts` | this page's view model — rows, sort, search, expansion, URL state | `test/issues-view.test.ts`, no DOM |
 * | this file | the renderer and the interactions | `test/issues-page.test.ts` + the browser run |
 *
 * The judgement on whether to reuse `next/drilldown-view.ts`, with the table of
 * shape differences behind it, is at the top of `next/issues-view.ts`. In one
 * line: that drill-down is *key → dirPath → test → occurrence* with a two-number
 * row and a path-collapse rule, and this page is *component → test → issue
 * message → occurrence* with nine numbers a row and no path level at all.
 * `drilldown-render.ts`'s small DOM helpers **are** reused.
 *
 * ## What the migration removes
 *
 * **A second, private `computeTestStats`.** `issues.html:944-1097` is a
 * 150-line fork that is not `common-test-data.js`'s — the page never loads that
 * file (`grep -c common-test-data issues.html` is 0; its `<script>` tags are
 * `:7-10`). The fork and `lib/query/issues.ts` were compared per test and field
 * by field on 4,838 xpcshell tests, 21,016 mochitest tests and two daily files
 * before either was reused: **zero mismatches** on every displayed number. The
 * table and the one non-displayed difference (`EXPECTED-FAIL`, folded into
 * `passCount` by the page and named separately by the library) are documented
 * at the top of `next/issues-view.ts`, together with the Issue% denominator.
 *
 * **The string-concatenation renderer**, and with it the `escapeHtml`/
 * `escapeAttr` calls and the `onclick=` attributes that a global function had to
 * satisfy. Building nodes answers escaping once, at `el()`.
 *
 * The five shared scripts **stay, loaded by name**: `fetch-utils.js`,
 * `dashboards.js`, `common-ui.js`, `common-links.js` and `shared.js`. They are
 * UI plumbing with no `lib/` equivalent and up to 22 unmigrated pages depend on
 * them; `tools/build-pages.ts` copies them next to the built page.
 *
 * ## Declared divergences from `issues.html`
 *
 * `PARITY.md` §4: byte-identical is the default and every exception is
 * declared. **This list is the whole set** — one enumerated list, no prose
 * carrying an extra entry, because that is exactly how an entry went missing on
 * an earlier migration.
 *
 *  1. **The default window is the 21-day aggregate, not the single most recent
 *     day.** The one deliberate behaviour change on this migration, and the
 *     reason this page was sequenced last.
 *
 *     `issues.html` opens on one day: with no hash, `:3709-3712` calls
 *     `loadData()`, which reads the `date-select`'s first option. (The
 *     `isHistoricalMode = false` at `:666` is not itself the cause — it
 *     describes the state before the first load — so the real default lives in
 *     that branch rather than in the initializer.) This page treats an absent
 *     `date` as `21days` and loads `{harness}-issues.json`.
 *
 *     Requested by the owner — *"I always use the issues page with
 *     #date=21days in the url"*, and 21 days being the default *"would be an
 *     improvement"* — and already recorded as this migration's acceptance
 *     criterion by `test/framing.test.ts`, whose `issues`/`window` divergence
 *     said it "closes when the page migrates". That entry has been updated;
 *     see the note under "framing" below.
 *
 *     **Measured on the pinned xpcshell data**, which is what makes this a
 *     change of substance rather than of default:
 *
 *     | | 21-day aggregate | 2026-08-04 alone |
 *     | --- | --- | --- |
 *     | components with an issue | **133** | **87** |
 *     | tests in the file | 4,838 | 4,836 |
 *     | rank 1 | WebExtensions :: General, 584,427 | WebExtensions :: General, 32,349 |
 *     | rank 6 / 7 | Add-ons Manager, then Crash Reporting | **Crash Reporting, then Add-ons Manager** |
 *
 *     The top ten are the same ten components, so the change is not a different
 *     answer — it is a steadier one: 46 components that had a quiet day
 *     reappear, and a component that had one bad night stops out-ranking a
 *     component that is broken every day.
 *
 *     **Both windows still work.** `#date=2026-08-04` selects that day and
 *     loads the daily file, the "Show Single Day" button leaves the aggregate,
 *     and the two shapes are different files with different structures —
 *     `{harness}-issues.json` (counts only, no `taskInfo`) against
 *     `{harness}-<date>.json`. `test/issues-page.test.ts` drives both.
 *
 *  2. **Inline handler attributes become `addEventListener`, and the three in
 *     the markup now throw once each.** The markup is byte-identical, so
 *     `onchange="loadData()"` on the `<select>` (`:611`),
 *     `onclick="toggleHistoricalData()"` on the button (`:614`) and
 *     `onchange="updateIssueFilters()"` on the four checkboxes (`:626-638`) are
 *     still attributes — but a module has no globals, so each attribute handler
 *     is a `ReferenceError` and the listener attached by this file does the
 *     work. This is the arrangement `next/crashes.html`, `next/failures.html`
 *     and `next/errors.html` already ship, and it is listed rather than fixed
 *     because fixing it means editing markup the brief holds byte-identical.
 *
 *     Every handler the page *generates* is gone: `onclick="changeSortOrder(…)"`
 *     on each of the 8 sort buttons (`:1153`, `:1168`),
 *     `onclick="copyTestName(…); event.stopPropagation();"` and
 *     `onclick="event.stopPropagation();"` on each test row's two buttons
 *     (`:844`, `:850`), and `onclick="toggleIssueRuns(this, event)"` on each
 *     issue line (`:3070`).
 *
 *     **Measured in Chrome on the pinned snapshot**, counting `on*` attributes
 *     in the live DOM under `#tree-container`:
 *
 *     | state | old | new |
 *     | --- | --- | --- |
 *     | first paint, 21-day xpcshell, 133 components collapsed | **8** | **0** |
 *     | WebExtensions :: General expanded (393 test rows) | **794** | **0** |
 *     | one test expanded on top of that (7 issue lines) | **801** | **0** |
 *
 *     The 8 at first paint are the sort buttons; the 786 added by one expansion
 *     are two per test row.
 *
 *  3. **`data-path` is no longer how a row is found again.** Upstream writes
 *     `data-path="${escapeHtml(componentName)}"` on each component row
 *     (`:2094`) and the raw test path on each test row (`:2166`), then resolves
 *     a click through `row.dataset.path` into `aggregatedData[path]`
 *     (`:2206`, `:2354`). Here the row elements are held in a `Map` to their
 *     rows, so nothing is resolved through an attribute. The attributes are
 *     still emitted with the same values, because the stylesheet and a reader's
 *     devtools both use them.
 *
 *     Unlike the same change on `failures.html` this fixes nothing measurable:
 *     a component name is `Product :: Component` and a test path is a file
 *     path, and **0 of the 136 component names and 0 of the 4,838 test paths**
 *     on the pinned snapshot contain a quote. It is listed because a reader of
 *     the code sees a different mechanism.
 *
 *  4. **`buildTotalSummaryRow` is not ported, because nothing calls it.**
 *     `issues.html:1833-1875` builds a `📊 Total` row. Verified rather than
 *     assumed, as the brief asked: `grep -n "buildTotalSummaryRow" issues.html`
 *     returns **exactly one line — the definition at `:1833`** and no call
 *     site; and driving the old page in Chrome through first paint, expansion,
 *     search, every checkbox and every column header never produces an element
 *     matching `.total-row`. So the migrated page has no total row, which is
 *     what the old page shows. (Contrast `crashes.html` and `failures.html`,
 *     whose total rows *are* rendered and are ported.)
 *
 *  5. **The lazy platform-breakdown tooltips are not ported.** Upstream
 *     attaches `mouseenter`/`mouseleave` to every `.lazy-tooltip` stat cell
 *     (`:2210-2213`) and builds a per-platform breakdown on hover
 *     (`:1621-1830`), reading `currentData.taskInfo.jobNameIds` to name the
 *     platform of each run.
 *
 *     **They cannot work in the page's own default view, and that is measured
 *     rather than argued.** The breakdown needs `taskIdIds` on the status group
 *     (`:1352`, `:1219`) and `taskInfo` on the file. `{harness}-issues.json` —
 *     the 21-day file, which divergence 1 makes the default — has **neither**:
 *     it is the `counts` shape throughout and carries no `taskInfo` key at all
 *     (`lib/formats/issues.ts` documents this; `Object.keys(file)` on the
 *     pinned file is `metadata, tables, testInfo, testRuns`). Hovering a stat
 *     cell in 21-day mode on the old page therefore produces a tooltip listing
 *     **0 platforms** — an empty dark box — which is what `:1638`'s
 *     `Object.keys(platforms).length === 0` branch renders as
 *     `No platform data available`.
 *
 *     Upstream's answer is `loadDetailedData()` (`:3403`), which fetches
 *     `{harness}-issues-with-taskids.json` in the background when a component
 *     is expanded and swaps its `testRuns` into `currentData` (`:3428-3444`).
 *     That is a 15.7 MB fetch (against 2.8 MB for the file already loaded) to
 *     populate a hover, and it mutates the object every displayed number was
 *     computed from while the reader is looking at it.
 *
 *     Omitted rather than emitted-and-inert, per the rule an earlier migration
 *     learned the hard way: a control that cannot work satisfies a DOM diff and
 *     turns a known gap into a hidden one. The `.lazy-tooltip` class is
 *     therefore **not** emitted either — emitting it would leave a cell that
 *     looks interactive and is not. A reader loses a hover that showed an empty
 *     box by default; the per-test expansion, which shows the same information
 *     as real rows with real counts, is unaffected.
 *
 *  6. **The daily-rate charts are not ported.** Upstream draws three kinds in
 *     21-day mode: a per-component chart (`:2136-2140`, `:2191-2194`), a
 *     per-test chart (`:2957-2961`, `:2364-2367`) and a per-issue-message chart
 *     (`:3095-3098`, `:3133-3136`). All three go through
 *     `calculateDailyFailureRates` and friends (`:2373-2698`), 325 lines that
 *     walk the raw file's `days` arrays.
 *
 *     They are omitted for the same reason as 5 and with the same discipline:
 *     the two that a reader reaches first — the per-component and per-test
 *     charts — need only `counts`/`days` and **would** work on the aggregate,
 *     but the per-issue-message chart needs the same task attribution
 *     `{harness}-issues.json` lacks. Rather than ship two of three and leave
 *     the third drawing an empty canvas, none is emitted and the Chart.js CDN
 *     tag is dropped with them.
 *
 *     **This is the largest omission on the list and it is a real loss**, not a
 *     dead control: the per-component and per-test charts do render on the old
 *     page today. It is called out here rather than buried because a reviewer
 *     comparing the two pages in 21-day mode will see them missing. Restoring
 *     them is a self-contained follow-up — `common-charts.js`'s
 *     `countDailyRunsForTests` and `createRateChart` are still loaded by the
 *     page and are what `next/crashes.ts` uses for the same job.
 *
 *  7. **A test row's Runs cell no longer turns red at zero.**
 *     `generateStatsHtml` (`:815`) passes `'fail'` when `runCount === 0`, and
 *     the component header's equivalent (`:2121`) passes nothing. A test with
 *     zero runs and an issue is a test that was **only** skipped, and colouring
 *     its Runs cell red says "this is broken" about a number that is correctly
 *     zero. Measured on the pinned 21-day xpcshell file: **312 of the 4,256
 *     tests with an issue** have `runCount === 0`, every one of them
 *     skip-only — so this is not a rare cell. The class is dropped and the
 *     Skips cell next to it, which is populated, is what tells the reader what
 *     happened.
 *
 * Everything else — the row unit, the hard-coded components view, the sort
 * fields and their per-column default directions, the four checkboxes changing
 * numerator and denominator rather than visibility, the search's two-level
 * match, the `(N tests with issues, out of M)` header, the issue-line ordering
 * and its two synthetic "not recorded" lines, the `?try=` short-circuit and the
 * `#date=…&q=…` state — is reproduced, and the reasoning for each lives next to
 * the code that does it in `next/issues-view.ts`.
 */

import { decodeDaily } from '../lib/formats/daily.ts';
import type { DailyFile } from '../lib/formats/daily.ts';
import { decodeIssues } from '../lib/formats/issues.ts';
import type { IssuesFile } from '../lib/formats/issues.ts';
import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import { parseTaskId } from '../lib/formats/tables.ts';
import {
    type ComponentRow,
    type IssueEntry,
    type IssueFilters,
    type IssueRow,
    type SortField,
    type SortState,
    ALL_FILTERS,
    FILTER_IDS,
    HISTORICAL_DATE,
    INITIAL_SORT,
    STAT_COLUMNS,
    buildComponentRows,
    failureTooltip,
    headerCounts,
    isHistoricalDate,
    issueEntries,
    nextSort,
    percentageDisplay,
    readUrlState,
    sortComponents,
    sortTests,
} from './issues-view.ts';
import {
    type SearchBoxManager,
    el,
    externalLink,
    insertAfter,
    removeFollowing,
    searchBox,
} from './drilldown-render.ts';

// Declared here, next to the calls, rather than relied on from another
// `next/` file. `tsconfig.next.json` compiles all of `next/**` as one program,
// so a declaration in `next/test.ts` would cover these calls there and *not*
// in the root project, which pulls in only the files a test imports —
// `test/dom-harness.ts` records the same trap catching `getBugButton`.
declare global {
    /** `common-ui.js:18` — `toLocaleString()`. */
    function formatNumber(value: number): string;
    /** `common-links.js:216` — the 🐛 bug-filing button, as markup. */
    function getBugButton(url: string, title: string): string;
    /** `common-ui.js:22` — turns `[path:123]` in a failure message into a link. */
    function linkifyFailureMessage(message: string, testPath: string): string;
}

// --- page state -----------------------------------------------------------

/** The decoded file every number is computed from. */
let decoded: DecodedTimingFile | null = null;
/** The raw parsed file, which `getDataDateRange` indexes itself. */
let rawData: unknown = null;
let isHistoricalMode = false;

let filters: IssueFilters = { ...ALL_FILTERS };
let currentSort: SortState = { ...INITIAL_SORT };
/** Which component rows are open. Keyed by component name. `issues.html:662`. */
const expandedComponents = new Set<string>();

/** The rows of the last render, for the parity seam. */
let renderedRows: ComponentRow[] = [];
/** The component row elements of the last render, keyed by component name. */
let rowsByKey = new Map<string, HTMLElement>();

let searchBoxManager: SearchBoxManager;
let hashManager: ReturnType<typeof initUrlHashManager>;
let historicalToggleManager: { toggle: () => Promise<void> };

const treeTable = (): HTMLElement => document.getElementById('tree-table')!;
const treeContainer = (): HTMLElement => document.getElementById('tree-container')!;
const noDataBox = (): HTMLElement => document.getElementById('no-data')!;
const errorBox = (): HTMLElement => document.getElementById('error')!;
const statusText = (): HTMLElement => document.getElementById('status-text')!;
const dateSelect = (): HTMLSelectElement =>
    document.getElementById('date-select') as HTMLSelectElement;

/** `showError` (`issues.html:865`). */
function showError(message: string, showNoData = false): void {
    const box = errorBox();
    box.style.display = 'block';
    box.textContent = message;
    if (showNoData) {
        noDataBox().style.display = 'block';
    }
}

/** `hideError` (`issues.html:875`). */
function hideError(): void {
    errorBox().style.display = 'none';
    noDataBox().style.display = 'none';
}

/** `setStatusText` (`issues.html:881`). */
function setStatusText(text: string): void {
    statusText().textContent = text;
}

// --- the stat cells -------------------------------------------------------

/**
 * One `<div class="stat-item">` with its label and value.
 *
 * `generateStatItem` (`issues.html:805-810`) in element form. The `hideable-zero`
 * container class is what fades a zero to 15% opacity until the row is hovered
 * (`:62-70`), which is how seven columns stay readable on a row where five of
 * them are zero.
 */
function statItem(
    label: string,
    value: string,
    valueClass = '',
    containerClass = ''
): HTMLElement {
    return el('div', {
        class: containerClass === '' ? 'stat-item' : `stat-item ${containerClass}`,
        children: [
            el('span', { class: 'stat-label', text: label }),
            el('span', {
                class: valueClass === '' ? 'stat-value' : `stat-value ${valueClass}`,
                text: value,
            }),
        ],
    });
}

/**
 * The seven stat cells shared by a component row and a test row.
 *
 * `generateStatsHtml` (`issues.html:813-840`) and the component header's own
 * copy (`:2121-2127`) unified — they emit the same seven cells in the same
 * order with the same colour rules, and the two differences are parameters:
 *
 * - A component header passes no `fail` class on a zero `runCount`; a test row
 *   does (`:815`). That difference is **dropped** — see divergence 7.
 * - Upstream's test rows carry `lazy-tooltip` and `data-tooltip-type` on the
 *   Skips, Failures and Timeouts cells; those are not emitted — see
 *   divergence 5.
 */
function statCells(stats: {
    runCount: number;
    issueCount: number;
    skipCount: number;
    failCount: number;
    timeoutCount: number;
    crashCount: number;
}): HTMLElement[] {
    const percentage = percentageDisplay(stats, filters);
    return [
        statItem('Runs', formatNumber(stats.runCount)),
        statItem('Issue %', percentage.displayValue, percentage.cssClass),
        statItem(
            'Issues',
            formatNumber(stats.issueCount),
            stats.issueCount > 0 ? 'fail' : 'zero',
            stats.issueCount === 0 ? 'hideable-zero' : ''
        ),
        statItem(
            'Skips',
            formatNumber(stats.skipCount),
            'skip',
            stats.skipCount === 0 ? 'hideable-zero' : ''
        ),
        statItem(
            'Failures',
            formatNumber(stats.failCount),
            stats.failCount > 0 ? 'fail' : 'zero',
            stats.failCount === 0 ? 'hideable-zero' : ''
        ),
        statItem(
            'Timeouts',
            formatNumber(stats.timeoutCount),
            stats.timeoutCount > 0 ? 'timeout' : 'zero',
            stats.timeoutCount === 0 ? 'hideable-zero' : ''
        ),
        statItem(
            'Crashes',
            formatNumber(stats.crashCount),
            stats.crashCount > 0 ? 'fail' : 'zero',
            stats.crashCount === 0 ? 'hideable-zero' : ''
        ),
    ];
}

// --- the sort header ------------------------------------------------------

/**
 * The header row of eight sort buttons.
 *
 * `buildSortHeader` (`issues.html:1148-1184`). The arrow is `↑`/`↓` on the
 * active column and a **space** on every other (`:1151`) — a space rather than
 * an empty string so the label does not shift by the arrow's width when the
 * sort moves, which is why it is reproduced exactly rather than omitted.
 */
function sortHeader(): HTMLElement {
    const button = (field: SortField, label: string, leftAlign: boolean): HTMLElement => {
        const isActive = currentSort.field === field;
        const arrow = isActive ? (currentSort.direction === 'asc' ? '↑' : '↓') : ' ';
        const node = el('button', {
            class: isActive ? 'sort-button active' : 'sort-button',
            attrs: { 'data-field': field },
            children: [el('span', { class: 'sort-arrow', text: arrow }), label],
        });
        if (leftAlign) {
            node.style.justifyContent = 'flex-start';
        }
        node.addEventListener('click', () => {
            currentSort = nextSort(currentSort, field);
            render();
        });
        return node;
    };

    return el('div', {
        class: 'sort-header',
        children: [
            el('div', {
                class: 'tree-name',
                children: [button('name', 'Component / Test', true)],
            }),
            el('div', {
                class: 'tree-stats',
                children: STAT_COLUMNS.map(([field, label]) =>
                    el('div', { class: 'stat-item', children: [button(field, label, false)] })
                ),
            }),
        ],
    });
}

// --- rendering ------------------------------------------------------------

/** `renderComponentsView` (`issues.html:1933`). */
function render(): void {
    if (decoded === null) {
        noDataBox().style.display = 'block';
        treeContainer().style.display = 'none';
        return;
    }
    noDataBox().style.display = 'none';
    treeContainer().style.display = 'block';

    const searchTerm = searchBoxManager.getValue().toLowerCase().trim();
    const rows = sortComponents(
        buildComponentRows(decoded, filters, searchTerm),
        currentSort,
        filters
    );
    renderedRows = rows;
    rowsByKey = new Map();

    const table = el('div', { class: 'tree-table' });
    table.append(sortHeader());

    for (const row of rows) {
        const isExpanded = expandedComponents.has(row.key);
        const hasIssues = row.tests.length > 0;
        const header = componentHeader(row, searchTerm, isExpanded, hasIssues);
        rowsByKey.set(row.key, header);
        table.append(header);

        if (isExpanded) {
            for (const element of testRows(row)) {
                table.append(element);
            }
        }
    }

    const target = treeTable();
    target.textContent = '';
    target.append(table);
}

/** One component header row. `issues.html:2094-2130`. */
function componentHeader(
    row: ComponentRow,
    searchTerm: string,
    isExpanded: boolean,
    hasIssues: boolean
): HTMLElement {
    const counts = headerCounts(row, searchTerm);
    // `(N tests with issues, out of M)`, `(N tests with issues)` or
    // `(M tests)` — the three cases at `:2098-2113`.
    let label: string;
    if (counts.withIssues === 0) {
        const total = counts.outOf ?? 0;
        label = ` (${total} test${total !== 1 ? 's' : ''})`;
    } else {
        const plural = counts.withIssues !== 1 ? 's' : '';
        label =
            counts.outOf === null
                ? ` (${counts.withIssues} test${plural} with issues)`
                : ` (${counts.withIssues} test${plural} with issues, out of ${counts.outOf})`;
    }

    const note = el('span', { text: label });
    note.style.color = '#888';

    const element = el('div', {
        class: hasIssues ? 'tree-row folder-row' : 'tree-row folder-row non-clickable',
        attrs: { 'data-path': row.key },
        children: [
            el('div', {
                class: 'tree-name',
                children: [
                    el('span', { class: isExpanded ? 'folder-icon expanded' : 'folder-icon' }),
                    el('strong', { text: row.key }),
                    note,
                ],
            }),
            el('div', { class: 'tree-stats', children: statCells(row.stats) }),
        ],
    });

    if (hasIssues) {
        element.addEventListener('click', () => toggleComponent(row.key));
    }
    return element;
}

/** The test rows under an expanded component. `issues.html:2144-2177`. */
function testRows(row: ComponentRow): HTMLElement[] {
    return sortTests(row.tests, currentSort).map((test) => testRow(test));
}

/** One test row. `issues.html:2166-2176`. */
function testRow(test: IssueRow): HTMLElement {
    const indent = el('span', { class: 'tree-indent' });
    indent.style.width = '20px';

    const name = el('span', { text: test.fullPath });
    if (test.component !== null) {
        name.title = `Component: ${test.component}`;
    }

    const element = el('div', {
        class: 'tree-row test-row list-row',
        attrs: { 'data-path': test.fullPath, 'data-level': '1' },
        children: [
            el('div', {
                class: 'tree-name',
                children: [
                    indent,
                    el('span', { class: 'test-icon' }),
                    name,
                    copyButton(test.fullPath),
                    searchfoxButton(test.fullPath),
                ],
            }),
            el('div', { class: 'tree-stats', children: statCells(test) }),
        ],
    });
    element.addEventListener('click', () => toggleTestDetails(element, test));
    return element;
}

/** The 📋 copy button. `generateCopyButton` (`issues.html:843-845`). */
function copyButton(testPath: string): HTMLElement {
    const button = el('button', {
        class: 'action-button',
        text: '📋',
        title: 'Copy test path',
    });
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        void copyTestPath(testPath, button);
    });
    return button;
}

/** The 🔍 Searchfox link. `generateSearchfoxButton` (`issues.html:848-851`). */
function searchfoxButton(testPath: string): HTMLElement {
    const link = externalLink(
        `https://searchfox.org/mozilla-central/source/${testPath}`,
        '🔍',
        'action-button'
    );
    link.title = 'Open in Searchfox';
    return link;
}

/**
 * Copies a test path and flashes the button.
 *
 * `copyTestName` (`issues.html:3300-3316`) and `showCopySuccess` (`:3289`).
 * Upstream reaches for the implicit global `event` to find the button; here the
 * listener has it. The `document.execCommand` fallback for non-HTTPS origins
 * (`:3318-3341`) is kept, because the dashboards are opened from `file://` and
 * from plain-HTTP mirrors where `navigator.clipboard` is undefined.
 */
async function copyTestPath(testPath: string, button: HTMLElement): Promise<void> {
    const flash = (): void => {
        const original = button.textContent;
        button.textContent = '✓';
        setTimeout(() => {
            button.textContent = original;
        }, 1000);
    };
    try {
        if (navigator.clipboard !== undefined) {
            await navigator.clipboard.writeText(testPath);
            flash();
            return;
        }
    } catch {
        // Falls through to the textarea path below.
    }
    const textarea = document.createElement('textarea');
    textarea.value = testPath;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
        flash();
    } finally {
        textarea.remove();
    }
}

// --- expansion ------------------------------------------------------------

/**
 * Opens or closes a component. `toggleFolder` (`issues.html:2317-2339`).
 *
 * Upstream re-renders the whole table and then restores `window.scrollY`,
 * because its renderer is one `innerHTML` assignment. Here the rows are
 * elements, so an expansion inserts or removes only its own test rows and the
 * scroll position never moves — there is nothing to restore. The
 * `loadDetailedData()` call upstream makes here (`:2330-2332`) has no
 * counterpart; see divergence 5.
 */
function toggleComponent(key: string): void {
    const row = rowsByKey.get(key);
    const model = renderedRows.find((candidate) => candidate.key === key);
    if (row === undefined || model === undefined) {
        return;
    }
    if (expandedComponents.has(key)) {
        expandedComponents.delete(key);
        row.classList.remove('expanded');
        row.querySelector('.folder-icon')?.classList.remove('expanded');
        // Everything down to the next component row belongs to this one.
        removeFollowing(row, (element) => element.classList.contains('folder-row'));
        return;
    }
    expandedComponents.add(key);
    row.classList.add('expanded');
    row.querySelector('.folder-icon')?.classList.add('expanded');
    insertAfter(row, testRows(model));
}

/**
 * Opens or closes one test's issue list.
 *
 * `toggleIssueDetails` (`issues.html:2342-2370`), including its two rules:
 * clicking an open test closes it, and opening one **closes every other**
 * (`:2349-2351`) — so at most one test is expanded at a time, unlike the
 * components, of which any number can be open.
 */
function toggleTestDetails(row: HTMLElement, test: IssueRow): void {
    const next = row.nextElementSibling;
    if (next !== null && next.classList.contains('issue-details-row')) {
        next.remove();
        return;
    }
    for (const open of document.querySelectorAll('.issue-details-row')) {
        open.remove();
    }
    if (decoded === null) {
        return;
    }
    insertAfter(row, [issueDetails(test)]);
}

/**
 * One test's expanded issue list.
 *
 * `generateIssueDetailsHtml` (`issues.html:2951-3108`) minus the charts
 * (divergence 6). The two "nothing to show" messages are upstream's and are
 * distinct on purpose: a test with no issues at all reads differently from one
 * whose issues are all of unchecked types (`:3034` and `:3049`).
 */
function issueDetails(test: IssueRow): HTMLElement {
    const entries = issueEntries(decoded!, test, filters);
    const content = el('div', { class: 'issue-details-content' });

    if (entries.length === 0) {
        // Distinguishing the two needs the unfiltered list: if it is empty the
        // test has no issues, and if it is not, the filters hid them all.
        const unfiltered = issueEntries(decoded!, test, ALL_FILTERS);
        content.append(
            el('div', {
                class: 'issue-section',
                children: [
                    el('p', {
                        text:
                            unfiltered.length === 0
                                ? 'No issues found for this test.'
                                : 'No issues of the selected types found for this test.',
                    }),
                ],
            })
        );
    } else {
        const section = el('div', { class: 'issue-section' });
        for (const entry of entries) {
            section.append(issueLine(test, entry));
        }
        content.append(section);
    }

    return el('div', { class: 'issue-details-row', children: [content] });
}

/** The badge class for an issue type. `issues.html:3054-3056`. */
const BADGE_CLASS: Record<IssueEntry['type'], string> = {
    SKIP: 'badge-skip',
    FAIL: 'badge-fail',
    CRASH: 'badge-crash',
    TIMEOUT: 'badge-timeout',
};

/**
 * One issue line: a count, a type badge and the message.
 *
 * `issues.html:3070-3093`. Two details are upstream's:
 *
 * - **Only a FAIL line's count carries a tooltip** (`:3063`), and its
 *   denominator is `runCount` rather than the Issue% denominator — see
 *   `failureTooltip`.
 * - **Only a FAIL message is linkified** (`:3073`); every other type's text is
 *   inserted as text. `linkifyFailureMessage` returns a string of HTML, which
 *   is why this is the one place the renderer assigns `innerHTML` — it is
 *   `common-ui.js`'s output, and the alternative is re-implementing its
 *   `[path:line]` parsing here.
 */
function issueLine(test: IssueRow, entry: IssueEntry): HTMLElement {
    const count = el('span', { class: 'issue-count', text: String(entry.count) });
    if (entry.type === 'FAIL') {
        const tooltip = failureTooltip(entry.count, test.runCount);
        if (tooltip !== '') {
            count.title = tooltip;
        }
    }

    const message = el('span', { class: 'issue-message' });
    if (entry.type === 'FAIL') {
        message.innerHTML = linkifyFailureMessage(entry.message, test.fullPath);
    } else {
        message.textContent = entry.message;
    }

    // The 🐛 button, on FAIL lines whose test has a real component. `:3075-3091`.
    if (entry.type === 'FAIL' && test.component !== null && test.component.includes(' :: ')) {
        const { firstDate, lastDate } = getDataDateRange(rawData);
        const url = getBugzillaUrl({
            testPath: test.fullPath,
            summary: entry.message,
            component: test.component,
            stats: {
                failureCount: entry.count,
                totalRuns: test.runCount,
                firstDate,
                lastDate,
            },
        });
        // `getBugButton` returns markup, like `linkifyFailureMessage`.
        const holder = el('span');
        holder.innerHTML = getBugButton(url, 'File bug for this failure');
        const button = holder.firstElementChild;
        if (button !== null) {
            button.addEventListener('click', (event) => event.stopPropagation());
            message.append(button);
        }
    }

    const line = el('div', {
        class: 'issue-item',
        attrs: {
            'data-test-path': test.fullPath,
            'data-test-id': String(test.testId),
            'data-issue-type': entry.type,
            'data-issue-message': entry.message,
        },
        children: [
            count,
            el('span', { class: `issue-badge ${BADGE_CLASS[entry.type]}`, text: entry.type }),
            message,
        ],
    });

    const runs = el('div', { class: 'issue-runs' });
    runs.style.display = 'none';

    line.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleIssueRuns(runs, test, entry);
    });

    const wrapper = el('div');
    wrapper.append(line, runs);
    return wrapper;
}

/**
 * Opens or closes the per-run table under one issue line.
 *
 * `toggleIssueRuns` (`issues.html:3111-3145`) and `getIssueRuns` (`:3148`).
 *
 * **This is empty on the default view, and the page says so rather than
 * showing nothing.** A run row needs a task ID, and `{harness}-issues.json`
 * carries none — it is the `counts` shape throughout. Upstream renders
 * `<span>No run data available</span>` in that case (`:3150`), and reaching a
 * populated table requires the 15.7 MB `-with-taskids` file that divergence 5
 * explains is not fetched. The same message is shown here, which is upstream's
 * own text for upstream's own condition.
 */
function toggleIssueRuns(runs: HTMLElement, test: IssueRow, entry: IssueEntry): void {
    if (runs.style.display !== 'none') {
        runs.style.display = 'none';
        return;
    }
    runs.textContent = '';
    const rows = runRows(test, entry);
    if (rows.length === 0) {
        runs.append(el('span', { text: 'No run data available' }));
    } else {
        const table = el('table');
        for (const row of rows) {
            table.append(row);
        }
        runs.append(table);
    }
    runs.style.display = 'block';
}

/**
 * The per-run rows for one issue line, where the file attributes them.
 *
 * `getIssueRuns` (`issues.html:3148-3261`) reduced to what the shapes this page
 * loads can answer. A daily file has task IDs, so a single-day view can show
 * real rows; the 21-day aggregate has none and yields an empty list, which the
 * caller turns into upstream's own "No run data available".
 */
function runRows(test: IssueRow, entry: IssueEntry): HTMLElement[] {
    if (decoded === null) {
        return [];
    }
    const rows: HTMLElement[] = [];
    for (const run of decoded.runsOfTest(test.testId)) {
        if (!matchesEntry(run, entry)) {
            continue;
        }
        const taskIds = run.taskIds;
        if (taskIds === undefined) {
            continue;
        }
        for (let index = 0; index < taskIds.length; index++) {
            const raw = taskIds[index];
            if (raw === undefined) {
                continue;
            }
            const { taskId, retryId } = parseTaskId(raw);
            const taskIdIndex = run.taskIdIndexes?.[index];
            const jobName =
                taskIdIndex === undefined
                    ? ''
                    : (decoded.jobNameOfTaskIndex(taskIdIndex) ?? '');
            const links = el('td', { class: 'view-links' });
            links.append(
                externalLink(
                    getProfilerUrl({ taskId, retryId: String(retryId), jobName }, test.fullPath),
                    'Profile'
                )
            );
            const jobUrl = getTreeherderJobUrl({ taskId, retryId: String(retryId) }, rawData);
            if (jobUrl !== null) {
                links.append(externalLink(jobUrl, 'Job'));
            }
            rows.push(el('tr', { children: [el('td', { text: jobName }), links] }));
        }
    }
    return rows;
}

/** Whether one decoded run belongs to an issue line. */
function matchesEntry(
    run: {
        status: string;
        message?: string | null | undefined;
        crashSignature?: string | null | undefined;
    },
    entry: IssueEntry
): boolean {
    switch (entry.type) {
        case 'SKIP':
            return (
                run.status === 'SKIP' &&
                (run.message ?? '').replace(/^skip-if:\s*/, '') === entry.message
            );
        case 'FAIL':
            return run.status.startsWith('FAIL') && (run.message ?? '') === entry.message;
        case 'CRASH':
            return run.status === 'CRASH' && (run.crashSignature ?? '') === entry.message;
        case 'TIMEOUT':
            return run.status.startsWith('TIMEOUT');
    }
}

// --- the issue-type checkboxes -------------------------------------------

/**
 * Re-reads the four checkboxes and re-renders.
 *
 * `updateIssueFilters` (`issues.html:3455-3472`). Upstream also deletes every
 * cached `stats` object (`:3462-3466`) because it memoizes them onto
 * `aggregatedData`; here `buildComponentRows` recomputes from the decoded file
 * each time, so there is no cache to invalidate — which is what makes it
 * impossible for a stale number to survive a filter change.
 */
function updateIssueFilters(): void {
    for (const [key, id] of FILTER_IDS) {
        const box = document.getElementById(id) as HTMLInputElement | null;
        if (box !== null) {
            filters[key] = box.checked;
        }
    }
    if (decoded !== null) {
        render();
    }
}

// --- data loading ---------------------------------------------------------

/** `loadData` (`issues.html:3475-3513`). */
async function loadSelectedDate(): Promise<void> {
    setStatusText('Loading data...');
    hideError();
    try {
        const date = dateSelect().value;
        if (!date) {
            throw new Error('No date selected');
        }
        const harness = getHarnessType();
        const response = await fetchData(`${harness}-${date}.json`);
        if (!response.ok) {
            throw new Error('No data available');
        }
        const file = (await response.json()) as DailyFile;
        rawData = file;
        decoded = decodeDaily(file);
        expandedComponents.clear();
        render();
        const jobCount = file.metadata.jobCount ?? 0;
        setStatusText(`${jobCount.toLocaleString()} test jobs`);
    } catch (error) {
        showError(`Error loading data: ${error instanceof Error ? error.message : String(error)}`, true);
    }
}

/**
 * Enters or leaves the 21-day view.
 *
 * The button, the date selector's disabled state and the status text are
 * `common-ui.js`'s `initHistoricalToggle`; this is the data half of the
 * callback. `issues.html:3516-3598`.
 *
 * Note which file this is: `{harness}-issues.json`, the counts-only aggregate
 * (`:3555`) — a **different file with a different shape** from the daily
 * `{harness}-<date>.json`, and different again from the `-with-taskids`
 * variant `crashes.html` loads. `lib/formats/issues.ts` and
 * `lib/formats/daily.ts` decode them into the same interface, which is what
 * lets everything above this line be shape-independent.
 */
async function onHistoricalToggled(isHistorical: boolean, data: unknown): Promise<void> {
    isHistoricalMode = isHistorical;
    if (isHistorical) {
        rawData = data;
        decoded = decodeIssues(data as IssuesFile);
        expandedComponents.clear();
        hideError();
        render();
        const metadata = (data as IssuesFile).metadata;
        const days = metadata.days ?? 21;
        setStatusText(`${days} days (${metadata.startDate} to ${metadata.endDate})`);
    } else {
        await loadSelectedDate();
    }
    hashManager?.updateHash();
}

/**
 * `?try=<rev>`, which short-circuits everything else.
 *
 * `loadTryRevision` (`issues.html:3359-3400`), reached from the startup branch
 * at `:3699-3701` before the date selector is even populated. The file is a
 * daily-shaped one, so it decodes the same way.
 */
async function loadTryRevision(revision: string): Promise<void> {
    setStatusText('Loading try revision...');
    hideError();
    try {
        const harness = getHarnessType();
        const response = await fetchData(`${harness}-try-${revision}.json`);
        if (!response.ok) {
            throw new Error(
                `Try revision data not found. Run: node fetch-test-data.js --harness ${harness} --try ${revision}`
            );
        }
        const file = (await response.json()) as DailyFile;
        rawData = file;
        decoded = decodeDaily(file);
        dateSelect().value = '';
        const jobCount = file.metadata.jobCount ?? 0;
        setStatusText(`Try: ${revision.substring(0, 12)} (${jobCount.toLocaleString()} jobs)`);
        const url = new URL(window.location.href);
        url.searchParams.set('try', revision);
        window.history.replaceState({}, '', url);
        render();
    } catch (error) {
        showError(error instanceof Error ? error.message : String(error));
        setStatusText('');
    }
}

// --- URL state ------------------------------------------------------------

function updateUrlHash(): void {
    hashManager?.updateHash();
}

/**
 * Applies the hash to the page. `loadFromUrlHash` (`issues.html:3747-3777`).
 *
 * The one behavioural change is here: `isHistoricalDate` treats an **absent**
 * `date` as the 21-day view, where upstream treats it as "use the date select".
 * See divergence 1.
 *
 * The `q` handling is upstream's, including that a hash with no `q` **clears**
 * the box (`:3774`, `search || ''`) — unlike `crashes.html`, which only writes
 * a truthy value and leaves a stale term behind. This page is the one that gets
 * it right, so there is nothing to reproduce-as-a-bug here.
 */
async function loadFromUrlHash(): Promise<void> {
    if (hashManager === undefined) {
        return;
    }
    const state = readUrlState(hashManager.getParams());
    const box = document.getElementById('search-box');
    if (document.activeElement !== box) {
        searchBoxManager.setValue(state.q ?? '');
    }

    if (isHistoricalDate(state.date)) {
        if (!isHistoricalMode) {
            await historicalToggleManager.toggle();
        }
        return;
    }
    if (isHistoricalMode) {
        await historicalToggleManager.toggle();
    }
    if (state.date !== undefined && dateSelect().value !== state.date) {
        dateSelect().value = state.date;
    }
}

// --- startup --------------------------------------------------------------

function initializeUI(): void {
    initHarnessSwitcher('Issues');

    // `:3686-3689` — re-read rather than trusted, because a browser restores
    // checkbox state across a reload and the JS mirror at `:672-677` would
    // otherwise disagree with what the reader can see.
    updateIssueFilters();
    for (const [, id] of FILTER_IDS) {
        document.getElementById(id)?.addEventListener('change', updateIssueFilters);
    }

    searchBoxManager = searchBox({
        searchBoxId: 'search-box',
        searchClearId: 'search-clear',
        onSearch: render,
        updateUrlHash,
    });

    hashManager = initUrlHashManager({
        getState: () => ({
            date: isHistoricalMode ? HISTORICAL_DATE : dateSelect().value,
            q: searchBoxManager.getValue().trim(),
        }),
        onHashChange: async () => {
            searchBoxManager.setNavigating(true);
            const wasHistorical = isHistoricalMode;
            const previousDate = dateSelect().value;
            await loadFromUrlHash();
            if (!isHistoricalMode) {
                if (dateSelect().value !== previousDate || wasHistorical !== isHistoricalMode) {
                    await loadSelectedDate();
                } else {
                    render();
                }
            }
            searchBoxManager.setNavigating(false);
        },
    });

    const harness = getHarnessType();
    historicalToggleManager = initHistoricalToggle({
        buttonId: 'historical-button',
        selectId: 'date-select',
        statusTextId: 'status-text',
        fetchData,
        historicalDataFile: `${harness}-issues.json`,
        onToggle: onHistoricalToggled,
        updateUrlHash,
    });

    dateSelect().addEventListener('change', () => {
        updateUrlHash();
        void loadSelectedDate();
    });
}

/**
 * Wires the page up and loads it. Called by the page, not by importing it.
 *
 * Exporting the entry point rather than running at module scope is what lets
 * `test/issues-page.test.ts` exist: importing this file declares things and
 * fetches nothing. `next/crashes-main.ts` records why that mattered — three
 * files and 2,598 lines of an earlier migration had no test importing them
 * because importing a controller started the page.
 */
export async function start(): Promise<void> {
    initializeUI();

    const revision = new URLSearchParams(window.location.search).get('try');
    if (revision !== null && revision !== '') {
        await loadTryRevision(revision);
        return;
    }

    const hasData = await populateDateSelector({
        selectId: 'date-select',
        statusTextId: 'status-text',
        fetchData,
    });
    if (!hasData) {
        showError('No data available. Please run: node fetch-xpcshell-data.js', true);
        return;
    }

    const select = dateSelect();
    if (!select.value && select.options.length > 0) {
        select.selectedIndex = 0;
    }

    // The 21-day default. `loadFromUrlHash` toggles into historical mode when
    // the hash names no date, which is divergence 1.
    await loadFromUrlHash();
    if (!isHistoricalMode) {
        await loadSelectedDate();
    }
    updateUrlHash();
}

/**
 * The view model, for the browser parity harness.
 *
 * `PARITY.md` §2: a page that builds strings has no seam to compare against.
 * This is the seam — the ranked rows and their numbers as plain values, so the
 * old-vs-new comparison can assert on decisions rather than on pixels.
 */
declare global {
    interface Window {
        __view?: () => unknown;
    }
}
window.__view = () => ({
    sort: currentSort,
    historical: isHistoricalMode,
    filters: { ...filters },
    search: searchBoxManager?.getValue() ?? '',
    expanded: [...expandedComponents],
    rows: renderedRows.map((row) => ({
        key: row.key,
        runCount: row.stats.runCount,
        issueCount: row.stats.issueCount,
        issueRate: row.stats.issueRate,
        skipCount: row.stats.skipCount,
        failCount: row.stats.failCount,
        timeoutCount: row.stats.timeoutCount,
        crashCount: row.stats.crashCount,
        testsWithIssues: row.tests.length,
        totalTestCount: row.totalTestCount,
    })),
});

export type { ComponentRow, IssueEntry, IssueRow };
