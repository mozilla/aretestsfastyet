/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * `next/issues.ts`, the issues page controller, driven end to end in jsdom.
 *
 * ## Why this file exists
 *
 * The controller exports one thing — `start()` — and everything worth covering
 * is module-private behind it: the stat cells and their colour rules, the sort
 * header, component expansion, the per-test issue list, the four checkboxes,
 * the `?try=` short-circuit and, above all, **which file the page loads with no
 * hash**. There is no seam for those, so they are tested the way a reader
 * exercises them: by loading the page and clicking it.
 *
 * The 21-day default is the reason this file matters most. It is a change in
 * what the page *fetches*, and `test/issues-view.test.ts` can only assert the
 * predicate — `isHistoricalDate(undefined) === true`. Only a started page can
 * show that the predicate is wired to a fetch, which is why the request log is
 * asserted here.
 *
 * ## Where the expected values come from
 *
 * Not from the code under test. The component totals are tallied off the raw
 * fixture JSON by `handTally()`, which reads `tables`/`testRuns` directly and
 * imports nothing from `next/` or `lib/query/`. Class names and labels are
 * literals taken from `issues.html`'s own markup and CSS. Numbers rendered
 * into cells are compared against `toLocaleString()` of the hand-tallied
 * value, never against a hardcoded separator — this machine renders 1078 as
 * `1 078` with a narrow no-break space.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupPage, fixture } from './dom-harness.ts';
import type { IssuesFile } from '../lib/formats/issues.ts';

// --- ground truth, read off the raw fixtures ------------------------------

const AGGREGATE = fixture<IssuesFile>('xpcshell-issues.json');
const DAILY = fixture<{ metadata: { jobCount?: number; date?: string } }>(
    'xpcshell-2026-08-03.json'
);
const INDEX = fixture<{ dates: string[] }>('index.json');

interface Group {
    runCount: number;
    skipCount: number;
    failCount: number;
    timeoutCount: number;
    crashCount: number;
    issueCount: number;
    tests: number;
    withIssues: number;
}

/**
 * The component totals in the 21-day fixture, counted without touching
 * `next/` or `lib/query/`.
 *
 * Open-coded against `tables.statuses` and `counts` on purpose: this and the
 * page can only agree by both being right about the file.
 */
function handTally(): Map<string, Group> {
    const groups = new Map<string, Group>();
    for (let testId = 0; testId < AGGREGATE.testRuns.length; testId++) {
        const statusGroups = AGGREGATE.testRuns[testId]!;
        let pass = 0;
        let failCount = 0;
        let timeoutCount = 0;
        let crashCount = 0;
        let skipCount = 0;
        for (let statusId = 0; statusId < statusGroups.length; statusId++) {
            const group = statusGroups[statusId];
            if (!group) {
                continue;
            }
            const status = AGGREGATE.tables.statuses[statusId]!;
            const total = group.counts.reduce((sum, count) => sum + count, 0);
            if (status === 'SKIP') {
                for (let i = 0; i < group.counts.length; i++) {
                    const messageId = group.messageIds?.[i];
                    const message =
                        messageId === null || messageId === undefined
                            ? null
                            : AGGREGATE.tables.messages[messageId];
                    if (message === null || message === undefined || !message.startsWith('run-if')) {
                        skipCount += group.counts[i]!;
                    }
                }
            } else if (status.startsWith('TIMEOUT')) {
                timeoutCount += total;
            } else if (status === 'CRASH') {
                crashCount += total;
            } else if (status.startsWith('PASS') || status === 'EXPECTED-FAIL') {
                // Both land in runCount; the page folds EXPECTED-FAIL into
                // passes and the library names it, and neither is displayed.
                pass += total;
            } else {
                failCount += total;
            }
        }
        const componentId = AGGREGATE.testInfo.componentIds?.[testId];
        const key =
            componentId === null || componentId === undefined
                ? '(no component)'
                : AGGREGATE.tables.components[componentId]!;
        let group = groups.get(key);
        if (group === undefined) {
            group = { runCount: 0, skipCount: 0, failCount: 0, timeoutCount: 0, crashCount: 0, issueCount: 0, tests: 0, withIssues: 0 };
            groups.set(key, group);
        }
        group.runCount += pass + failCount + timeoutCount + crashCount;
        group.skipCount += skipCount;
        group.failCount += failCount;
        group.timeoutCount += timeoutCount;
        group.crashCount += crashCount;
        group.tests += 1;
        if (skipCount + failCount + timeoutCount + crashCount > 0) {
            group.withIssues += 1;
        }
    }
    for (const group of groups.values()) {
        group.issueCount = group.skipCount + group.failCount + group.timeoutCount + group.crashCount;
    }
    return groups;
}

const TALLY = handTally();
/** The rows the default view must show: most issues first. */
const EXPECTED_ROWS = [...TALLY]
    .map(([key, group]) => ({ key, ...group }))
    .sort((a, b) => b.issueCount - a.issueCount);

test('the fixture exercises what this suite claims to cover', () => {
    // Vacuity guard: every assertion below is conditional on the fixture
    // containing the case, so a future fixture that lost one would leave the
    // test passing with nothing to check.
    assert.ok(EXPECTED_ROWS.length > 1, 'several components, so order means something');
    assert.ok(
        EXPECTED_ROWS.some((row) => row.withIssues < row.tests),
        'a component with a clean test, so "out of M" is reachable'
    );
    assert.ok(
        EXPECTED_ROWS.some((row) => row.withIssues === row.tests),
        'a component where every test has an issue, so the no-"out of" branch is reachable'
    );
    assert.ok(
        EXPECTED_ROWS.some((row) => row.skipCount > 0) &&
            EXPECTED_ROWS.some((row) => row.skipCount === 0),
        'both skipped and unskipped components, so the denominator change is observable'
    );
});

// --- the harness ----------------------------------------------------------

const FILES = {
    'index.json': INDEX,
    'xpcshell-issues.json': AGGREGATE,
    'xpcshell-2026-08-03.json': DAILY,
};

/**
 * A page, started, with no hash — which is the case under test.
 *
 * The controller holds module-level state (the sort, the filters, the expanded
 * set), so it is imported **once** and every test shares it; tests leave the
 * page as they found it.
 */
const harness = setupPage({
    page: 'issues',
    url: 'https://tests.firefox.dev/issues.html',
    files: FILES,
});
const { start } = await import('../next/issues.ts');
await start();

const table = (): HTMLElement => harness.content.querySelector('.tree-table')!;
const componentRows = (): HTMLElement[] => [
    ...table().querySelectorAll<HTMLElement>('.folder-row'),
];
const testRows = (): HTMLElement[] => [...table().querySelectorAll<HTMLElement>('.test-row')];
const searchBox = (): HTMLInputElement =>
    harness.document.getElementById('search-box') as HTMLInputElement;
const checkbox = (id: string): HTMLInputElement =>
    harness.document.getElementById(id) as HTMLInputElement;

/** A row's stat cells as `label -> value`, read out of the rendered DOM. */
function statsOf(row: Element): Map<string, string> {
    const out = new Map<string, string>();
    for (const item of row.querySelectorAll('.stat-item')) {
        const label = item.querySelector('.stat-label')?.textContent ?? '';
        const value = item.querySelector('.stat-value')?.textContent ?? '';
        out.set(label, value);
    }
    return out;
}

/** The class on a row's stat value, for the colour assertions. */
function valueClassOf(row: Element, label: string): string {
    for (const item of row.querySelectorAll('.stat-item')) {
        if ((item.querySelector('.stat-label')?.textContent ?? '') === label) {
            return item.querySelector('.stat-value')?.className ?? '';
        }
    }
    return '';
}

/** Collapses every open component, so the next test starts from a known page. */
function collapseAll(): void {
    for (const row of componentRows()) {
        if (row.classList.contains('expanded')) {
            row.click();
        }
    }
}

/** Restores the four checkboxes to all-on and re-renders. */
function resetFilters(): void {
    for (const id of ['filter-failures', 'filter-timeouts', 'filter-crashes', 'filter-skips']) {
        const box = checkbox(id);
        if (!box.checked) {
            box.checked = true;
            box.dispatchEvent(new harness.window.Event('change'));
        }
    }
}

// =========================================================================
// The 21-day default — the migration's deliberate change
// =========================================================================

test('with no hash the page loads the 21-day aggregate, not a single day', () => {
    // The whole point of sequencing this page last. `issues.html:3709-3712`
    // called `loadData()`, which fetches `{harness}-<date>.json`; this must
    // fetch `{harness}-issues.json` instead.
    //
    // Asserted on the **request log**, which is the only place the difference
    // is visible: both files decode into the same interface, so a page that
    // loaded the wrong one would still render a plausible table.
    assert.ok(
        harness.requested.includes('xpcshell-issues.json'),
        `the 21-day aggregate must be fetched; asked for ${harness.requested.join(', ')}`
    );
    assert.ok(
        !harness.requested.includes('xpcshell-2026-08-03.json'),
        'and the daily file must not be, or the page did the old thing as well'
    );
});

test('the status text names the 21-day window', () => {
    // What a reader sees, rather than what was fetched. `issues.html:3584`
    // formats it as `N days (start to end)`.
    const status = harness.document.getElementById('status-text')!.textContent ?? '';
    assert.match(status, /^21 days \(2026-07-14 to 2026-08-03\)$/, `status text was "${status}"`);
});

test('the hash records the 21-day window, so the URL is shareable', () => {
    assert.match(harness.window.location.hash, /date=21days/);
});

// =========================================================================
// The default render
// =========================================================================

test('rows are components, ranked by issue count descending', () => {
    // The framing assertion: the row unit and the ranking, against the hand
    // tally rather than against the page's own ordering.
    const names = componentRows().map(
        (row) => row.querySelector('strong')?.textContent ?? ''
    );
    assert.deepEqual(names, EXPECTED_ROWS.map((row) => row.key));
    assert.equal(names[0], 'WebExtensions :: General');
});

test('a component row shows the seven stat columns with the tallied numbers', () => {
    const row = componentRows()[0]!;
    const stats = statsOf(row);
    const expected = TALLY.get('WebExtensions :: General')!;

    assert.deepEqual(
        [...stats.keys()],
        ['Runs', 'Issue %', 'Issues', 'Skips', 'Failures', 'Timeouts', 'Crashes'],
        'the seven columns, in the order issues.html:2121-2127 emits them'
    );
    // Built with `toLocaleString()`, never a hardcoded separator.
    assert.equal(stats.get('Runs'), expected.runCount.toLocaleString());
    assert.equal(stats.get('Issues'), expected.issueCount.toLocaleString());
    assert.equal(stats.get('Skips'), expected.skipCount.toLocaleString());
    assert.equal(stats.get('Failures'), expected.failCount.toLocaleString());
    assert.equal(stats.get('Timeouts'), expected.timeoutCount.toLocaleString());
    assert.equal(stats.get('Crashes'), expected.crashCount.toLocaleString());
    // 14,222 / (97,473 + 10,713) = 13.145…%, which rounds to 13.
    assert.equal(stats.get('Issue %'), '13%');
});

test('the header says how many tests have issues, out of how many', () => {
    // `issues.html:2106`. WebExtensions has 7 tests, 6 with an issue.
    const row = componentRows()[0]!;
    const expected = TALLY.get('WebExtensions :: General')!;
    const text = row.querySelector('.tree-name')?.textContent ?? '';
    assert.ok(
        text.includes(`(${expected.withIssues} tests with issues, out of ${expected.tests})`),
        `header read "${text}"`
    );
    assert.equal(expected.withIssues, 6);
    assert.equal(expected.tests, 7);

    // And the other branch: a component where every test has an issue omits
    // the "out of", because `1 of 1` tells a reader nothing.
    const xpconnect = componentRows().find(
        (candidate) => candidate.querySelector('strong')?.textContent === 'Core :: XPConnect'
    )!;
    const xpText = xpconnect.querySelector('.tree-name')?.textContent ?? '';
    assert.ok(xpText.includes('(1 test with issues)'), `header read "${xpText}"`);
    assert.ok(!xpText.includes('out of'), 'no "out of" when every test has an issue');
});

test('a zero stat is faded and a populated one is not', () => {
    // The `hideable-zero` rule (`issues.html:62-70`), which is what keeps a
    // seven-column row readable. Core :: Networking has 0 crashes.
    const networking = componentRows().find(
        (row) => row.querySelector('strong')?.textContent === 'Core :: Networking'
    )!;
    const crashItem = [...networking.querySelectorAll('.stat-item')].find(
        (item) => item.querySelector('.stat-label')?.textContent === 'Crashes'
    )!;
    assert.ok(crashItem.classList.contains('hideable-zero'), 'a zero crash count is faded');
    assert.equal(valueClassOf(networking, 'Crashes'), 'stat-value zero');

    const failItem = [...networking.querySelectorAll('.stat-item')].find(
        (item) => item.querySelector('.stat-label')?.textContent === 'Failures'
    )!;
    assert.ok(!failItem.classList.contains('hideable-zero'), '8 failures is not faded');
    assert.equal(valueClassOf(networking, 'Failures'), 'stat-value fail');

    // Driven over every column of every row rather than one cell, because a
    // mutation that dropped the class from the *Issues* column alone survived
    // the two assertions above: no component on this fixture has a zero issue
    // count in the default view, so that branch is only reachable through the
    // other columns and through the filters-off state exercised below.
    const faded = (row: Element, label: string): boolean =>
        [...row.querySelectorAll('.stat-item')].some(
            (item) =>
                item.querySelector('.stat-label')?.textContent === label &&
                item.classList.contains('hideable-zero')
        );
    for (const row of componentRows()) {
        const stats = statsOf(row);
        for (const label of ['Issues', 'Skips', 'Failures', 'Timeouts', 'Crashes']) {
            const isZero = stats.get(label) === '0';
            assert.equal(
                faded(row, label),
                isZero,
                `${row.querySelector('strong')?.textContent} ${label}=${stats.get(label)}: a ` +
                    'zero must be faded and a non-zero must not be'
            );
        }
    }
    // The Issues column really does reach zero once nothing is counted, which
    // is the state that makes the loop above cover it.
    for (const id of ['filter-failures', 'filter-timeouts', 'filter-crashes', 'filter-skips']) {
        const box = checkbox(id);
        box.checked = false;
        box.dispatchEvent(new harness.window.Event('change'));
    }
    for (const row of componentRows()) {
        assert.equal(statsOf(row).get('Issues'), '0');
        assert.ok(faded(row, 'Issues'), 'a zero Issues cell is faded too');
    }
    resetFilters();
});

test('there is no total row, because the old page never rendered one', () => {
    // `buildTotalSummaryRow` (`issues.html:1833`) is defined and never called
    // — divergence 4. Asserted so that "we did not port it" cannot quietly
    // become "we forgot it and nobody noticed".
    assert.equal(table().querySelectorAll('.total-row').length, 0);
});

// =========================================================================
// Sorting
// =========================================================================

test('clicking a column header re-ranks the rows by that column', () => {
    // Crashes is the discriminating column on this fixture: its order differs
    // from the default issueCount order, so a header that did nothing — or
    // that always sorted by the default — fails here.
    const byCrashes = [...TALLY]
        .map(([key, group]) => ({ key, crashCount: group.crashCount }))
        .sort((a, b) => b.crashCount - a.crashCount)
        .map((row) => row.key);
    assert.notDeepEqual(
        byCrashes,
        EXPECTED_ROWS.map((row) => row.key),
        'the two orders must differ, or this test cannot tell them apart'
    );

    // Re-queried after every click rather than held: a render rebuilds the
    // header, so the element that was clicked is detached by the time the
    // assertion runs. Holding the reference reported `active: false` on a page
    // that was behaving correctly.
    const header = (): HTMLElement =>
        table().querySelector<HTMLElement>('.sort-button[data-field="crashCount"]')!;

    header().click();
    assert.deepEqual(
        componentRows().map((row) => row.querySelector('strong')?.textContent),
        byCrashes
    );
    assert.ok(header().classList.contains('active'), 'the clicked column is marked active');
    assert.equal(header().querySelector('.sort-arrow')?.textContent, '↓', 'descending first');
    assert.ok(
        !table()
            .querySelector('.sort-button[data-field="issueCount"]')!
            .classList.contains('active'),
        'and the previous column is no longer active'
    );

    // Clicking again flips it.
    header().click();
    assert.deepEqual(
        componentRows().map((row) => row.querySelector('strong')?.textContent),
        [...byCrashes].reverse()
    );
    assert.equal(harness.document.querySelector('.sort-button[data-field="crashCount"] .sort-arrow')?.textContent, '↑');

    // Back to the default for the tests that follow.
    table().querySelector<HTMLElement>('.sort-button[data-field="issueCount"]')!.click();
    assert.deepEqual(
        componentRows().map((row) => row.querySelector('strong')?.textContent),
        EXPECTED_ROWS.map((row) => row.key)
    );
});

test('the rate column sorts ascending first, unlike the counts', () => {
    // `changeSortOrder` (`:1193-1197`) — the one exception, and exactly the
    // kind of detail a rewrite drops.
    const button = table().querySelector<HTMLElement>('.sort-button[data-field="issuePercentage"]')!;
    button.click();
    assert.equal(
        harness.document.querySelector('.sort-button[data-field="issuePercentage"] .sort-arrow')
            ?.textContent,
        '↑',
        'a rate column opens ascending'
    );
    // XPConnect's 0.068% is the smallest, so it comes first.
    assert.equal(componentRows()[0]!.querySelector('strong')?.textContent, 'Core :: XPConnect');

    table().querySelector<HTMLElement>('.sort-button[data-field="issueCount"]')!.click();
    assert.equal(
        harness.document.querySelector('.sort-button[data-field="issueCount"] .sort-arrow')
            ?.textContent,
        '↓',
        'a count column opens descending'
    );
});

// =========================================================================
// Expansion
// =========================================================================

test('clicking a component lists its tests with issues, and only those', () => {
    collapseAll();
    assert.equal(testRows().length, 0, 'nothing is expanded to begin with');

    const row = componentRows()[0]!;
    row.click();

    const expected = TALLY.get('WebExtensions :: General')!;
    assert.equal(testRows().length, expected.withIssues, 'one row per test with an issue');
    const paths = testRows().map((test) => test.dataset['path']);
    assert.ok(
        !paths.some((path) => path?.endsWith('test_ext_always_green.js')),
        'the clean test is not listed'
    );
    assert.ok(paths.some((path) => path?.endsWith('test_ext_dnr_dynamic_rules.js')));
    assert.ok(row.classList.contains('expanded'));

    // Clicking again closes it.
    row.click();
    assert.equal(testRows().length, 0);
    assert.ok(!row.classList.contains('expanded'));
});

test('two components can be open at once', () => {
    // Unlike the per-test details, which close each other. The distinction is
    // upstream's (`expandedRows` is a Set at `:662`) and a reader relies on it
    // to compare two components side by side.
    collapseAll();
    componentRows()[0]!.click();
    const afterFirst = testRows().length;
    componentRows()[1]!.click();
    assert.ok(testRows().length > afterFirst, 'the second expansion adds rows rather than replacing');
    assert.equal(
        componentRows().filter((row) => row.classList.contains('expanded')).length,
        2
    );
    collapseAll();
});

test('a component with no tests to show is not clickable', () => {
    // `issues.html:2094` marks it `non-clickable`, and `:2200` attaches the
    // listener only to rows without that class. Reached by turning every
    // filter off.
    for (const id of ['filter-failures', 'filter-timeouts', 'filter-crashes', 'filter-skips']) {
        const box = checkbox(id);
        box.checked = false;
        box.dispatchEvent(new harness.window.Event('change'));
    }
    const rows = componentRows();
    assert.ok(rows.length > 0, 'the components are still listed');
    for (const row of rows) {
        assert.ok(row.classList.contains('non-clickable'), 'no issues, so nothing to expand');
    }
    rows[0]!.click();
    assert.equal(testRows().length, 0, 'clicking does nothing');

    resetFilters();
    assert.ok(!componentRows()[0]!.classList.contains('non-clickable'));
});

test('expanding a test lists its issues, badged and count-ordered', () => {
    collapseAll();
    componentRows()[0]!.click();
    const testRow = testRows().find((row) =>
        row.dataset['path']?.endsWith('test_ext_background_early_shutdown.js')
    )!;
    testRow.click();

    const details = testRow.nextElementSibling!;
    assert.ok(details.classList.contains('issue-details-row'));
    const items = [...details.querySelectorAll('.issue-item')];
    assert.ok(items.length > 0);

    const counts = items.map((item) => Number(item.querySelector('.issue-count')?.textContent));
    for (let i = 1; i < counts.length; i++) {
        assert.ok(counts[i - 1]! >= counts[i]!, 'count descending');
    }
    // The badges are the four types, with the classes the stylesheet styles.
    for (const item of items) {
        const badge = item.querySelector('.issue-badge')!;
        const type = badge.textContent ?? '';
        assert.ok(['SKIP', 'FAIL', 'CRASH', 'TIMEOUT'].includes(type));
        assert.ok(
            badge.classList.contains(
                type === 'SKIP' ? 'badge-skip'
                    : type === 'FAIL' ? 'badge-fail'
                    : type === 'CRASH' ? 'badge-crash'
                    : 'badge-timeout'
            ),
            `${type} carries its own badge class`
        );
    }

    // The lines sum to the columns above them — the property the two synthetic
    // "not recorded" lines exist to preserve.
    const sum = (type: string): number =>
        items
            .filter((item) => item.querySelector('.issue-badge')?.textContent === type)
            .reduce((total, item) => total + Number(item.querySelector('.issue-count')?.textContent), 0);
    const stats = statsOf(testRow);
    assert.equal(sum('FAIL').toLocaleString(), stats.get('Failures'));
    assert.equal(sum('SKIP').toLocaleString(), stats.get('Skips'));
    assert.equal(sum('CRASH').toLocaleString(), stats.get('Crashes'));
    assert.equal(sum('TIMEOUT').toLocaleString(), stats.get('Timeouts'));

    testRow.click();
    assert.equal(harness.document.querySelectorAll('.issue-details-row').length, 0);
    collapseAll();
});

test('opening one test closes any other', () => {
    // `issues.html:2349-2351`, and the opposite of the component behaviour.
    collapseAll();
    componentRows()[0]!.click();
    const rows = testRows();
    rows[0]!.click();
    assert.equal(harness.document.querySelectorAll('.issue-details-row').length, 1);
    rows[1]!.click();
    assert.equal(
        harness.document.querySelectorAll('.issue-details-row').length,
        1,
        'the first one closed'
    );
    assert.ok(rows[1]!.nextElementSibling?.classList.contains('issue-details-row'));
    rows[1]!.click();
    collapseAll();
});

// =========================================================================
// The four checkboxes
// =========================================================================

test('unchecking skips changes the numbers without hiding the component', () => {
    // The property the page turns on: the boxes are not row filters. Both the
    // count and the *rate* are checked, because a denominator that kept the
    // skips would still produce a smaller-looking number.
    const before = statsOf(componentRows()[0]!);
    const expected = TALLY.get('WebExtensions :: General')!;
    assert.equal(before.get('Issues'), expected.issueCount.toLocaleString());

    const box = checkbox('filter-skips');
    box.checked = false;
    box.dispatchEvent(new harness.window.Event('change'));

    const web = componentRows().find(
        (row) => row.querySelector('strong')?.textContent === 'WebExtensions :: General'
    )!;
    const after = statsOf(web);
    const withoutSkips =
        expected.failCount + expected.timeoutCount + expected.crashCount;
    assert.equal(after.get('Issues'), withoutSkips.toLocaleString(), 'skips leave the numerator');
    assert.equal(
        after.get('Skips'),
        expected.skipCount.toLocaleString(),
        'but the Skips column still reports them'
    );
    // 3,509 / 97,473 = 3.60% → 4%. With the skips left in the denominator it
    // would be 3,509 / 108,186 = 3.24% → 3%, so the band distinguishes them.
    assert.equal(after.get('Issue %'), '4%', 'the skipped runs leave the denominator too');

    resetFilters();
    assert.equal(statsOf(componentRows()[0]!).get('Issue %'), '13%');
});

test('unchecking a type drops the tests whose only issues were of that type', () => {
    // A test needs an issue of an *enabled* type to be listed (`:2016`).
    collapseAll();
    const box = checkbox('filter-failures');

    // With everything on, geckoProfiler_control (skips + crashes, no failures)
    // is listed.
    componentRows()[0]!.click();
    assert.ok(
        testRows().some((row) => row.dataset['path']?.endsWith('test_ext_geckoProfiler_control.js'))
    );
    collapseAll();

    // With only failures counted, it is not.
    for (const id of ['filter-timeouts', 'filter-crashes', 'filter-skips']) {
        const other = checkbox(id);
        other.checked = false;
        other.dispatchEvent(new harness.window.Event('change'));
    }
    assert.ok(box.checked, 'failures stay on');
    componentRows()[0]!.click();
    const paths = testRows().map((row) => row.dataset['path']);
    assert.ok(
        !paths.some((path) => path?.endsWith('test_ext_geckoProfiler_control.js')),
        'a skip-and-crash-only test is not an issue when only failures count'
    );
    assert.ok(paths.some((path) => path?.endsWith('test_ext_dnr_dynamic_rules.js')));

    collapseAll();
    resetFilters();
});

test('all four boxes off leaves every component at zero issues', () => {
    for (const id of ['filter-failures', 'filter-timeouts', 'filter-crashes', 'filter-skips']) {
        const box = checkbox(id);
        box.checked = false;
        box.dispatchEvent(new harness.window.Event('change'));
    }
    for (const row of componentRows()) {
        assert.equal(statsOf(row).get('Issues'), '0');
        assert.equal(statsOf(row).get('Issue %'), '0%');
        // But the run totals survive, because they do not depend on the types.
        assert.notEqual(statsOf(row).get('Runs'), '0');
    }
    resetFilters();
});

// =========================================================================
// The search
// =========================================================================

test('a search on a component name keeps it and drops the others', async () => {
    // Both directions in one test: what survives *and* what disappears. An
    // earlier test in this repo asserted only that a search "keeps rows whole"
    // and never that non-matching rows go away, so the filter could have been
    // deleted with the suite still green.
    assert.ok(componentRows().length > 1, 'more than one row to narrow from');

    searchBox().value = 'networking';
    searchBox().dispatchEvent(new harness.window.Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));

    const names = componentRows().map((row) => row.querySelector('strong')?.textContent);
    assert.deepEqual(names, ['Core :: Networking'], 'only the matching component survives');

    searchBox().value = '';
    searchBox().dispatchEvent(new harness.window.Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(componentRows().length, EXPECTED_ROWS.length, 'clearing restores every row');
});

test('a search on a test path narrows the component to that test', async () => {
    searchBox().value = 'test_socks';
    searchBox().dispatchEvent(new harness.window.Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));

    const rows = componentRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.querySelector('strong')?.textContent, 'Core :: Networking');
    // The row's numbers are recomputed over the kept test: 12,840 runs, not
    // the component's whole 18,612.
    assert.equal(statsOf(rows[0]!).get('Runs'), (12840).toLocaleString());

    rows[0]!.click();
    assert.deepEqual(
        testRows().map((row) => row.dataset['path']),
        ['netwerk/test/unit/test_socks.js']
    );
    collapseAll();

    searchBox().value = '';
    searchBox().dispatchEvent(new harness.window.Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
});

test('a search matching nothing empties the list', async () => {
    searchBox().value = 'zzz-no-such-thing';
    searchBox().dispatchEvent(new harness.window.Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(componentRows().length, 0);

    searchBox().value = '';
    searchBox().dispatchEvent(new harness.window.Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(componentRows().length, EXPECTED_ROWS.length);
});

// =========================================================================
// A named day still works
// =========================================================================

test('#date=<a day> loads that day, not the aggregate', async () => {
    // The other half of the default change: a bookmarked day has to keep
    // working, and it reads a **different file with a different shape**.
    const day = setupPage({
        page: 'issues',
        url: 'https://tests.firefox.dev/issues.html#date=2026-08-03',
        files: FILES,
    });
    try {
        const module = await import(`../next/issues.ts?day=${Date.now()}`);
        await (module as { start: () => Promise<void> }).start();

        assert.ok(
            day.requested.includes('xpcshell-2026-08-03.json'),
            `the daily file must be fetched; asked for ${day.requested.join(', ')}`
        );
        const status = day.document.getElementById('status-text')?.textContent ?? '';
        assert.match(status, /test jobs$/, `a daily load reports a job count, got "${status}"`);
        assert.ok(
            !/^21 days/.test(status),
            'and must not report the 21-day window it was not asked for'
        );

        // The table really rendered from that file.
        const rows = day.document.querySelectorAll('.folder-row');
        assert.ok(rows.length > 0, 'the day renders component rows');
    } finally {
        day.restore();
    }
});
