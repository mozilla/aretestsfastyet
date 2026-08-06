/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * `site/drilldown-render.ts`, the shared renderer for `crashes.html` and
 * `failures.html`.
 *
 * Until now nothing imported this file. It was part of the 2,598 lines the
 * migration left uncovered, and the consequence was concrete: **inverting the
 * page branch in `inlineLinksCell` passed both `npm test` and `tsc`**, because
 * only a browser ever built an element from it.
 *
 * ## What these tests are built to fail on
 *
 * The trees here are asserted by *shape and nesting*, not by presence. The two
 * rules that follow from this project's recurring defect — a test that cannot
 * fail for the reason it exists:
 *
 * 1. **No expected value is produced by calling the thing under test.** The
 *    hooks below return marked-up sentinels (`LINK_A`, `SUFFIX`), and the
 *    expected class names are written out as literals rather than read off
 *    `Vocabulary`. A vocabulary whose fields were swapped between the two pages
 *    would still satisfy a test that read them from the record it was passed.
 * 2. **Absence and count are asserted, not just presence.** A `td` that
 *    *contains* a `span.view-links` and a `td` that *is* one both "have"
 *    `.view-links` under a `querySelector`; only the path from the cell
 *    distinguishes them, so that is what is compared.
 *
 * The page-level behaviour — that the crashes page really passes the crashes
 * vocabulary — is in `test/crashes-page.test.ts` and
 * `test/failures-page.test.ts`, which drive the controllers' `start()`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupPage, pathTo, shape, shapes } from './dom-harness.ts';
import type {
    GroupRow,
    Occurrence,
    PathNode,
    SortState,
    SubRow,
    TestNode,
    Totals,
} from '../site/drilldown-view.ts';
import type { RenderHooks, Vocabulary } from '../site/drilldown-render.ts';
import {
    el,
    externalLink,
    insertAfter,
    noData,
    removeFollowing,
    renderChartSlot,
    renderList,
    renderOccurrenceTable,
    renderSubRows,
} from '../site/drilldown-render.ts';

// A page for the whole file: `el()` reaches for the ambient `document`, and
// these tests build detached trees, so one is enough and nothing leaks between
// them.
const harness = setupPage();

// --- the two vocabularies, written out ------------------------------------
//
// Retyped here rather than imported, and that is the point. The controllers'
// `VOCAB` records are module-private (`const VOCAB` in `site/crashes.ts:170`
// and `site/failures.ts:168`), so there is nothing to import — but even if
// there were, importing them would make this file assert that the renderer uses
// whatever names the page gave it, which is true of any pair of records. These
// are the names `common-data-view.css` styles.

const CRASH_VOCAB: Vocabulary = {
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

const FAILURE_VOCAB: Vocabulary = {
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

// --- hooks that answer with sentinels -------------------------------------
//
// Every hook returns something a test can recognise on sight, so an assertion
// can tell "the renderer called `labelNodes`" apart from "the renderer
// stringified the key itself".

function occurrence(over: Partial<Occurrence> = {}): Occurrence {
    return {
        jobName: 'test-linux1804-64/opt-xpcshell-1',
        date: '2026-08-03',
        taskId: 'TASK',
        retryId: '0',
        ...over,
    };
}

function testNode(over: Partial<TestNode> = {}): TestNode {
    return { testName: 'test_a.js', occurrences: [], totalCount: 1, ...over };
}

interface HookLog {
    labelNodes: string[];
    labelTitle: string[];
    occurrenceLinks: string[];
    jobNameHref: string[];
    testNameSuffix: string[];
    singleRowHref: string[];
    totalRunsOf: string[];
    tooltipOf: string[];
}

function hooksWithLog(options: { suffix?: boolean; inertSingle?: boolean } = {}): {
    hooks: RenderHooks;
    log: HookLog;
} {
    const log: HookLog = {
        labelNodes: [],
        labelTitle: [],
        occurrenceLinks: [],
        jobNameHref: [],
        testNameSuffix: [],
        singleRowHref: [],
        totalRunsOf: [],
        tooltipOf: [],
    };
    const hooks: RenderHooks = {
        labelNodes(key) {
            log.labelNodes.push(key);
            return [el('b', { class: 'sentinel-label', text: `L:${key}` })];
        },
        labelTitle(key) {
            log.labelTitle.push(key);
            return `T:${key}`;
        },
        occurrenceLinks(occ, testName) {
            log.occurrenceLinks.push(`${occ.taskId}|${testName}`);
            return [
                el('a', { class: 'sentinel-link-a', text: 'LINK_A' }),
                el('a', { class: 'sentinel-link-b', text: 'LINK_B' }),
            ];
        },
        jobNameHref(occ, testName) {
            log.jobNameHref.push(`${occ.taskId}|${testName}`);
            return `https://example.invalid/job/${occ.taskId}`;
        },
        testNameSuffix(dirPath, testNodeArg, key) {
            log.testNameSuffix.push(`${dirPath}|${testNodeArg.testName}|${key}`);
            return options.suffix === true
                ? el('span', { class: 'sentinel-suffix', text: 'SUFFIX' })
                : null;
        },
        singleRowHref(occ, testName) {
            log.singleRowHref.push(`${occ.taskId}|${testName}`);
            return options.inertSingle === true
                ? null
                : `https://example.invalid/single/${occ.taskId}`;
        },
        totalRunsOf(dirPath, testName) {
            log.totalRunsOf.push(`${dirPath}|${testName}`);
            return 400;
        },
        tooltipOf(count, totalRuns) {
            log.tooltipOf.push(`${count}|${totalRuns}`);
            return `TOOLTIP ${count}/${totalRuns}`;
        },
    };
    return { hooks, log };
}

// =========================================================================
// 1. The page-identity branch — the known hole
// =========================================================================

/**
 * The two trees `inlineLinksCell` produces, written out from the two upstream
 * pages rather than from the function.
 *
 * `crashes.html:713` drops `renderCrashLinks`'s `<span class="view-links">`
 * into a bare `<td>`; `failures.html:809` puts the links straight into a
 * `<td class="view-links">` with no span. So the class sits on a different
 * element on each page, and that is a difference in *shape* — the one thing the
 * `Vocabulary` record cannot express, and the one branch in the renderer that
 * reads `vocab.kind`.
 */
function singleRowOf(vocab: Vocabulary): HTMLElement {
    const occ = occurrence();
    const subRow: SubRow = {
        kind: 'single',
        dirPath: 'netwerk/test/unit',
        test: testNode({ occurrences: [occ], totalCount: 1 }),
        occurrence: occ,
        direct: false,
    };
    const { hooks } = hooksWithLog();
    return renderSubRows([subRow], 'KEY', vocab, hooks)[0]!;
}

test('a crash single-occurrence row nests its links in a span inside a bare td', () => {
    const row = singleRowOf(CRASH_VOCAB);
    const cells = [...row.querySelectorAll('td')];
    assert.equal(cells.length, 3, 'date, job name, links');

    const linksCell = cells[2]!;
    // The cell itself carries no class at all — upstream's `<td>` is bare.
    assert.equal(linksCell.className, '', 'the crashes links cell is a bare td');
    assert.equal(
        linksCell.classList.contains('view-links'),
        false,
        'the class must NOT be on the cell on the crashes page'
    );

    // …and the class is one level down, on a span that is the cell's only
    // element child.
    const span = linksCell.firstElementChild;
    assert.ok(span !== null, 'the crashes cell wraps its links in an element');
    assert.equal(shape(span), 'span.view-links');
    assert.equal(linksCell.children.length, 1, 'exactly one wrapper, not a list of links');

    // The nesting, stated as a path, is what an inverted branch changes.
    const [firstLink] = [...row.querySelectorAll('.sentinel-link-a')];
    assert.equal(
        pathTo(row, firstLink!),
        'table.inline-instance > tbody > tr > td > span.view-links > a.sentinel-link-a'
    );
});

test('a failure single-occurrence row puts view-links on the td and has no span', () => {
    const row = singleRowOf(FAILURE_VOCAB);
    const cells = [...row.querySelectorAll('td')];
    assert.equal(cells.length, 3);

    const linksCell = cells[2]!;
    assert.equal(shape(linksCell), 'td.view-links', 'the class is on the cell itself');

    // The absent half. A `querySelector('.view-links')` is satisfied by either
    // page's tree; only "there is no span" separates them.
    assert.equal(
        linksCell.querySelector('span.view-links'),
        null,
        'the failures page must not wrap its links in a span'
    );
    assert.equal(
        row.querySelectorAll('span').length,
        0,
        'no span anywhere in a failures single row'
    );

    const [firstLink] = [...row.querySelectorAll('.sentinel-link-a')];
    assert.equal(
        pathTo(row, firstLink!),
        'table.inline-instance > tbody > tr > td.view-links > a.sentinel-link-a'
    );
});

test('the two pages differ in element count at exactly this cell', () => {
    // Stated as a difference rather than as two independent facts, so that a
    // change making the pages agree fails here as well as above. Upstream's
    // trees differ by one element and only by one element.
    const crash = singleRowOf(CRASH_VOCAB);
    const failure = singleRowOf(FAILURE_VOCAB);

    const countAll = (root: Element): number => root.querySelectorAll('*').length;
    assert.equal(
        countAll(crash) - countAll(failure),
        1,
        'the crashes tree has exactly one more element: the span'
    );

    // And the class lives on a different tag on each.
    assert.equal(crash.querySelector('.view-links')!.tagName, 'SPAN');
    assert.equal(failure.querySelector('.view-links')!.tagName, 'TD');
});

test('both pages label the links cell "View: " before the first link', () => {
    for (const vocab of [CRASH_VOCAB, FAILURE_VOCAB]) {
        const row = singleRowOf(vocab);
        const holder = row.querySelector('.view-links')!;
        assert.equal(holder.firstChild!.nodeType, 3, `${vocab.kind}: leading text node`);
        assert.equal(holder.firstChild!.textContent, 'View: ', `${vocab.kind}: the label`);
        // The links are separated by a single space, as `links.join(' ')` was.
        assert.equal(holder.textContent, 'View: LINK_A LINK_B', `${vocab.kind}: spacing`);
    }
});

test('the expanded occurrence table uses td.view-links on BOTH pages', () => {
    // The counterpart fact, and the reason `inlineLinksCell` is the *only*
    // `vocab.kind` branch: `crashes.html:820` and `failures.html:919` agree
    // here. A renderer that applied the crashes nesting everywhere would fail
    // this while passing the two tests above.
    const { hooks } = hooksWithLog();
    for (const vocab of [CRASH_VOCAB, FAILURE_VOCAB]) {
        const table = renderOccurrenceTable(
            testNode({ occurrences: [occurrence()], totalCount: 1 }),
            vocab,
            hooks
        );
        const cells = [...table.querySelectorAll('td')];
        assert.equal(shape(cells[2]!), 'td.view-links', `${vocab.kind}: class on the cell`);
        assert.equal(
            table.querySelectorAll('span').length,
            0,
            `${vocab.kind}: no span in the expanded table`
        );
    }
});

// =========================================================================
// 2. The live-tree helpers
// =========================================================================

/** A parent holding `<i>` elements with the given classes, in order. */
function tree(...classes: string[]): { parent: HTMLElement; children: HTMLElement[] } {
    const parent = el('div');
    const children = classes.map((className) => el('i', { class: className }));
    for (const child of children) {
        parent.append(child);
    }
    return { parent, children };
}

/** The classes of `parent`'s element children, in order. */
const classesOf = (parent: Element): string[] =>
    [...parent.children].map((child) => child.className);

test('removeFollowing deletes the run after a row and stops at the first stop', () => {
    const { parent, children } = tree('anchor', 'sub', 'sub', 'sub', 'stop', 'sub', 'tail');
    removeFollowing(children[0]!, (element) => element.classList.contains('stop'));

    // The whole sequence, not a count and not a spot check: a stop condition
    // that fired one element early or late changes this list.
    assert.deepEqual(classesOf(parent), ['anchor', 'stop', 'sub', 'tail']);
    // The stopping element survives, and so does everything after it.
    assert.equal(parent.children.length, 4);
});

test('removeFollowing removes nothing when the very next element stops it', () => {
    const { parent, children } = tree('anchor', 'stop', 'sub');
    removeFollowing(children[0]!, (element) => element.classList.contains('stop'));
    assert.deepEqual(classesOf(parent), ['anchor', 'stop', 'sub'], 'nothing removed');
});

test('removeFollowing removes to the end when nothing stops it', () => {
    const { parent, children } = tree('anchor', 'a', 'b', 'c');
    removeFollowing(children[0]!, () => false);
    assert.deepEqual(classesOf(parent), ['anchor']);
    // The removed nodes are detached, not merely hidden.
    for (const child of children.slice(1)) {
        assert.equal(child.parentNode, null);
    }
});

test('removeFollowing is safe when the row is last, and never touches the row', () => {
    const { parent, children } = tree('a', 'anchor');
    removeFollowing(children[1]!, () => false);
    assert.deepEqual(classesOf(parent), ['a', 'anchor'], 'the row itself is kept');
});

test('removeFollowing walks siblings live, so removing does not skip the next one', () => {
    // The bug this shape catches: reading `nextElementSibling` *after*
    // `remove()` returns null, and reading it from the removed node's old
    // position is exactly what a naive loop does. Every element after the
    // anchor must go, including the even-indexed ones.
    const { parent, children } = tree('anchor', 's1', 's2', 's3', 's4', 's5');
    removeFollowing(children[0]!, () => false);
    assert.deepEqual(classesOf(parent), ['anchor'], 'no element survived by being skipped');
});

test('removeFollowing ignores non-element siblings and stops only on elements', () => {
    const parent = el('div');
    const anchor = el('i', { class: 'anchor' });
    const stop = el('i', { class: 'stop' });
    parent.append(anchor);
    parent.append('text between');
    parent.append(el('i', { class: 'sub' }));
    parent.append(stop);
    const seen: string[] = [];
    removeFollowing(anchor, (element) => {
        seen.push(element.className);
        return element.classList.contains('stop');
    });
    assert.deepEqual(seen, ['sub', 'stop'], 'the text node was never offered to the predicate');
    assert.deepEqual(classesOf(parent), ['anchor', 'stop']);
});

test('insertAfter puts elements immediately after the row, in the order given', () => {
    const { parent, children } = tree('anchor', 'tail');
    const inserted = [el('u', { class: 'i1' }), el('u', { class: 'i2' }), el('u', { class: 'i3' })];
    insertAfter(children[0]!, inserted);
    // Order is the point: an implementation that inserted each element after
    // the *row* rather than after the previous insert gives i3, i2, i1.
    assert.deepEqual(classesOf(parent), ['anchor', 'i1', 'i2', 'i3', 'tail']);
});

test('insertAfter with a single element, and with none, leaves the rest alone', () => {
    const { parent, children } = tree('anchor', 'tail');
    insertAfter(children[0]!, [el('u', { class: 'only' })]);
    assert.deepEqual(classesOf(parent), ['anchor', 'only', 'tail']);

    const empty = tree('anchor', 'tail');
    insertAfter(empty.children[0]!, []);
    assert.deepEqual(classesOf(empty.parent), ['anchor', 'tail']);
});

test('insertAfter and removeFollowing round-trip the rows an expansion adds', () => {
    // The pair as the pages use them: open a row, then close it and get the
    // list back byte for byte. `crashes.html:863` against `:841`.
    const { parent, children } = tree('row', 'next-row', 'after');
    const before = classesOf(parent);
    insertAfter(children[0]!, [
        el('u', { class: 'historical-chart' }),
        el('u', { class: 'test-row' }),
        el('u', { class: 'test-row' }),
    ]);
    assert.equal(parent.children.length, 6, 'three rows were inserted');
    removeFollowing(children[0]!, (element) => element.classList.contains('next-row'));
    assert.deepEqual(classesOf(parent), before, 'closing restores the original list exactly');
});

// =========================================================================
// 3. `el` and `externalLink`
// =========================================================================

test('el sets tag, class, text, id, href and arbitrary attributes', () => {
    const node = el('a', {
        class: 'one two',
        text: 'label',
        id: 'the-id',
        href: '/target',
        attrs: { 'data-x': '1', rel: 'noopener' },
    });
    assert.equal(node.tagName, 'A');
    assert.equal(node.className, 'one two');
    assert.equal(node.textContent, 'label');
    assert.equal(node.id, 'the-id');
    assert.equal(node.getAttribute('href'), '/target');
    assert.equal(node.getAttribute('data-x'), '1');
    assert.equal(node.getAttribute('rel'), 'noopener');
});

test('el omits an empty or absent class rather than writing class=""', () => {
    assert.equal(el('div').hasAttribute('class'), false, 'absent');
    assert.equal(el('div', { class: '' }).hasAttribute('class'), false, 'empty string');
    assert.equal(el('div', { class: 'x' }).getAttribute('class'), 'x');
});

test('el writes text as text, so a message containing markup is not parsed', () => {
    // The whole reason the renderer builds nodes: both old pages concatenate
    // HTML and need `escapeHtml` at every interpolation. A failure message
    // legitimately contains `<` and `&`.
    const hostile = `<img src=x onerror=BOOM> & "quoted" 'single' &amp;`;
    const node = el('div', { text: hostile });
    assert.equal(node.textContent, hostile, 'the text survives verbatim');
    assert.equal(node.children.length, 0, 'and produced no elements');
    assert.equal(node.querySelector('img'), null);
    assert.equal(node.innerHTML.includes('&lt;img'), true, 'it is escaped in the serialization');
});

test('el normalizes CR and CRLF in a title, matching what the HTML parser does', () => {
    // `site/drilldown-render.ts:256`. The old pages write the title into a
    // string and let the parser build the attribute, and the parser turns a
    // literal CR or CRLF into a single LF. Assigning `.title` does not, so
    // without the normalization the two pages disagree on the tooltip of any
    // message containing a CR — measured at 1 of 2,263 mochitest messages.
    assert.equal(el('div', { title: 'a\r\nb' }).title, 'a\nb', 'CRLF');
    assert.equal(el('div', { title: 'a\rb' }).title, 'a\nb', 'bare CR');
    assert.equal(el('div', { title: 'a\nb' }).title, 'a\nb', 'LF is left alone');
    assert.equal(el('div', { title: 'a\r\n\rb' }).title, 'a\n\nb', 'both, in sequence');
    // Only the title is normalized — the text of a row is not an attribute.
    assert.equal(el('div', { text: 'a\r\nb' }).textContent, 'a\r\nb');
});

test('el appends children in order, accepts strings, and skips nulls', () => {
    const node = el('div', {
        children: [el('i', { class: 'first' }), 'plain', null, el('b', { class: 'second' })],
    });
    assert.deepEqual(shapes(node.children), ['i.first', 'b.second'], 'two elements, in order');
    assert.equal(node.childNodes.length, 3, 'the null contributed no node at all');
    assert.equal(node.textContent, 'plain');
});

test('externalLink opens in a new tab and stops the click reaching the row', () => {
    const link = externalLink('https://example.invalid/x', 'Profile');
    assert.equal(link.tagName, 'A');
    assert.equal(link.getAttribute('href'), 'https://example.invalid/x');
    assert.equal(link.textContent, 'Profile');
    assert.equal(link.target, '_blank');
    assert.equal(link.hasAttribute('class'), false, 'no class unless one was asked for');
    assert.equal(link.hasAttribute('onclick'), false, 'a listener, not an attribute');

    // The stopPropagation, observed rather than assumed: the old pages write
    // `onclick="event.stopPropagation();"` for this, and on the crashes page
    // the row underneath opens the crash viewer.
    const row = el('div');
    row.append(link);
    let rowSawClick = false;
    row.addEventListener('click', () => {
        rowSawClick = true;
    });
    link.dispatchEvent(new harness.window.Event('click', { bubbles: true }));
    assert.equal(rowSawClick, false, 'the row must not see the link click');

    // Control: a plain anchor in the same position does reach the row, so the
    // assertion above is about `externalLink` and not about jsdom.
    const plain = el('a', { href: '#' });
    row.append(plain);
    plain.dispatchEvent(new harness.window.Event('click', { bubbles: true }));
    assert.equal(rowSawClick, true, 'without the handler the click does bubble');
});

test('externalLink takes an optional class', () => {
    assert.equal(externalLink('/x', 'y', 'action-button').className, 'action-button');
});

// =========================================================================
// 4. `renderList`
// =========================================================================

/**
 * A row for `renderList`, with an empty subtree.
 *
 * Empty rather than populated on purpose: `renderList` renders the *list*, and
 * a row's `paths` is only read when the row is expanded — which is
 * `renderSubRows`' job and is fixtured separately above. Handing it a subtree
 * here would suggest the renderer consults one.
 */
function groupRow(key: string, testCount: number, count: number): GroupRow {
    return { key, testCount, count, paths: new Map<string, PathNode>() };
}

const ROWS: GroupRow[] = [
    groupRow('@ first::signature', 3, 40),
    groupRow('@ second::signature', 2, 25),
    groupRow('@ third::signature', 1, 7),
];
// Written out, not summed by the code under test: 3+2+1 and 40+25+7.
const TOTALS: Totals = { tests: 6, count: 72 };
const SORT_COUNT_DESC: SortState = { column: 'count', ascending: false };

test('renderList emits a header, a total row, and one row per group in order', () => {
    const { hooks } = hooksWithLog();
    const { root } = renderList(ROWS, TOTALS, SORT_COUNT_DESC, CRASH_VOCAB, hooks, () => {}, null);

    assert.equal(shape(root), 'div.crash-list');
    assert.deepEqual(shapes(root.children), [
        'div.sort-header',
        'div.crash-row.total-row',
        'div.crash-row',
        'div.crash-row',
        'div.crash-row',
    ]);
    // The keys, in the order given. A renderer that sorted, deduplicated or
    // reversed them fails here; a length check alone would not.
    assert.deepEqual(
        [...root.children].slice(2).map((row) => row.querySelector('.crash-signature')!.textContent),
        ['L:@ first::signature', 'L:@ second::signature', 'L:@ third::signature']
    );
});

test('renderList puts each row"s two numbers in the right columns', () => {
    const { hooks } = hooksWithLog();
    const { root } = renderList(ROWS, TOTALS, SORT_COUNT_DESC, CRASH_VOCAB, hooks, () => {}, null);
    const dataRows = [...root.children].slice(2);

    assert.deepEqual(
        dataRows.map((row) => [...row.querySelectorAll('.stat-value')].map((s) => s.textContent)),
        [
            ['3', '40'],
            ['2', '25'],
            ['1', '7'],
        ],
        'tests first, then the count'
    );
    // The count column carries the page"s modifier and the tests column does
    // not — `common-data-view.css` colours `.stat-value.crash` red.
    for (const row of dataRows) {
        const values = [...row.querySelectorAll('.stat-value')];
        assert.equal(values[0]!.className, 'stat-value', 'the tests column is unmodified');
        assert.equal(values[1]!.className, 'stat-value crash', 'the count column is modified');
    }
});

test('renderList"s total row shows the totals it was passed, with the 📊 label', () => {
    const { hooks } = hooksWithLog();
    const { root } = renderList(ROWS, TOTALS, SORT_COUNT_DESC, CRASH_VOCAB, hooks, () => {}, null);
    const totalRow = root.children[1]!;

    assert.equal(totalRow.querySelector('.crash-signature')!.textContent, '📊 Total');
    assert.deepEqual(
        [...totalRow.querySelectorAll('.stat-value')].map((s) => s.textContent),
        ['6', '72']
    );
    // The total row is not in `rowsByKey` and is excluded from the row set by
    // its class — both controllers' click handlers test for `total-row`.
    assert.equal(totalRow.classList.contains('total-row'), true);
    assert.equal(
        totalRow.querySelector('.sentinel-label'),
        null,
        'the total row does not go through labelNodes'
    );
});

test('renderList returns every row keyed by its raw key, and nothing else', () => {
    const { hooks } = hooksWithLog();
    const { root, rowsByKey } = renderList(
        ROWS,
        TOTALS,
        SORT_COUNT_DESC,
        CRASH_VOCAB,
        hooks,
        () => {},
        null
    );

    assert.deepEqual([...rowsByKey.keys()], ROWS.map((row) => row.key));
    assert.equal(rowsByKey.size, 3, 'the header and total row are not in the map');
    // Identity, not equality: the map must hold the elements that are in the
    // tree, since the controller re-finds an expanded row through it.
    const dataRows = [...root.children].slice(2);
    for (const [index, row] of ROWS.entries()) {
        assert.equal(rowsByKey.get(row.key), dataRows[index], `${row.key} is the element rendered`);
    }
});

test('renderList keeps a key containing a quote, which the old attribute round-trip lost', () => {
    // `site/drilldown-render.ts:49-78`: upstream writes the key into
    // `data-message` with `escapeAttr` and finds the row again with a selector
    // built by the same function, which cannot match once the parser has
    // decoded `&quot;` — measured at 1,848 of 2,841 failures rows. The Map is
    // the fix, so the fixture here has to contain the case.
    const quoted = `Unexpected exception TypeError: can't access property "resumed", x is null`;
    assert.ok(quoted.includes('"'), 'the fixture must contain a quote for this to test anything');

    const rows = [groupRow(quoted, 1, 2), groupRow('plain', 1, 1)];
    const { hooks } = hooksWithLog();
    const { root, rowsByKey } = renderList(
        rows,
        { tests: 2, count: 3 },
        SORT_COUNT_DESC,
        FAILURE_VOCAB,
        hooks,
        () => {},
        null
    );

    const element = rowsByKey.get(quoted);
    assert.ok(element !== undefined, 'the quoted key finds its row');
    assert.equal(element.isConnected || root.contains(element), true, 'and it is the one in the tree');
    // And no attribute carries the key, so there is nothing to round-trip.
    assert.equal(root.querySelector('[data-message]'), null);
    assert.equal(root.querySelector('[data-signature]'), null);
});

test('renderList marks only the expanded key, and marks it even when it is not first', () => {
    const { hooks } = hooksWithLog();
    const { root } = renderList(
        ROWS,
        TOTALS,
        SORT_COUNT_DESC,
        CRASH_VOCAB,
        hooks,
        () => {},
        '@ second::signature'
    );
    const dataRows = [...root.children].slice(2);
    assert.deepEqual(
        dataRows.map((row) => row.classList.contains('expanded')),
        [false, true, false]
    );
    assert.equal(root.querySelectorAll('.expanded').length, 1, 'exactly one');
});

test('renderList marks nothing when no key is expanded', () => {
    const { hooks } = hooksWithLog();
    const { root } = renderList(ROWS, TOTALS, SORT_COUNT_DESC, CRASH_VOCAB, hooks, () => {}, null);
    assert.equal(root.querySelectorAll('.expanded').length, 0);
});

test('renderList asks the hooks for the label and its title, once per row', () => {
    const { hooks, log } = hooksWithLog();
    const { root } = renderList(ROWS, TOTALS, SORT_COUNT_DESC, CRASH_VOCAB, hooks, () => {}, null);

    assert.deepEqual(log.labelNodes, ROWS.map((row) => row.key), 'every key, in order');
    // The nodes the hook returned are in the tree, so a renderer that
    // stringified the key itself fails.
    assert.equal(root.querySelectorAll('b.sentinel-label').length, 3);
    assert.deepEqual(
        [...root.querySelectorAll('.crash-signature')]
            .slice(1) // the header's label cell carries the column name
            .map((cell) => cell.getAttribute('title')),
        [null, 'T:@ first::signature', 'T:@ second::signature', 'T:@ third::signature'],
        'the total row has no title, the data rows have the hook"s'
    );
});

test('renderList omits the title attribute entirely when the hook returns undefined', () => {
    // The crashes page's `labelTitle` is `() => undefined`
    // (`site/crashes.ts:247`) and upstream puts no `title` on a signature cell.
    // `title=""` would be a different DOM, and a DOM diff sees it.
    const { hooks } = hooksWithLog();
    const noTitle: RenderHooks = { ...hooks, labelTitle: () => undefined };
    const { root } = renderList(ROWS, TOTALS, SORT_COUNT_DESC, CRASH_VOCAB, noTitle, () => {}, null);
    for (const cell of [...root.querySelectorAll('.crash-signature')].slice(1)) {
        assert.equal(cell.hasAttribute('title'), false);
    }
});

test('renderList renders an empty list as a header and a total row and no rows', () => {
    const { hooks } = hooksWithLog();
    const { root, rowsByKey } = renderList(
        [],
        { tests: 0, count: 0 },
        SORT_COUNT_DESC,
        CRASH_VOCAB,
        hooks,
        () => {},
        null
    );
    assert.deepEqual(shapes(root.children), ['div.sort-header', 'div.crash-row.total-row']);
    assert.equal(rowsByKey.size, 0);
});

test('renderList uses the failures vocabulary when it is given one', () => {
    // The same call with the other record. Every class differs, which is what
    // makes a page-identity mistake in a controller's `VOCAB` visible.
    const { hooks } = hooksWithLog();
    const { root } = renderList(ROWS, TOTALS, SORT_COUNT_DESC, FAILURE_VOCAB, hooks, () => {}, null);

    assert.equal(shape(root), 'div.failure-list');
    assert.deepEqual(shapes(root.children).slice(0, 3), [
        'div.sort-header',
        'div.failure-row.total-row',
        'div.failure-row',
    ]);
    assert.equal(root.querySelectorAll('.failure-message').length, 5, 'header, total, 3 rows');
    assert.equal(root.querySelectorAll('.failure-stats').length, 5);
    assert.equal(
        root.querySelectorAll('.stat-value.fail').length,
        4,
        'the total row and each data row carry the fail modifier'
    );
    // And none of the crashes names appear.
    for (const name of ['crash-list', 'crash-row', 'crash-signature', 'crash-stats']) {
        assert.equal(root.querySelector(`.${name}`), null, `no .${name} on a failures list`);
    }
    assert.equal(root.querySelector('.stat-value.crash'), null);
});

// --- the sort header ------------------------------------------------------

test('the sort header names the two columns from the vocabulary', () => {
    // The label is the button's *last* child; the first is the sort arrow,
    // which the active column fills. Reading `textContent` would fold the two
    // together and make this test pass on a page whose column was mislabelled
    // as long as the arrow differed.
    const labelsOf = (header: Element): string[] =>
        [...header.querySelectorAll('button')].map((button) => button.lastChild!.textContent!);

    const { hooks } = hooksWithLog();
    const crash = renderList(ROWS, TOTALS, SORT_COUNT_DESC, CRASH_VOCAB, hooks, () => {}, null);
    const header = crash.root.children[0]!;
    assert.equal(header.querySelector('.crash-signature')!.textContent, 'Crash Signature');
    assert.deepEqual(labelsOf(header), ['Tests', 'Crashes']);

    const failure = renderList(ROWS, TOTALS, SORT_COUNT_DESC, FAILURE_VOCAB, hooks, () => {}, null);
    const failureHeader = failure.root.children[0]!;
    assert.equal(failureHeader.querySelector('.failure-message')!.textContent, 'Failure Message');
    assert.deepEqual(labelsOf(failureHeader), ['Tests', 'Failures']);

    // The two pages' count columns are named differently, which is the thing a
    // swapped vocabulary would get wrong.
    assert.notEqual(labelsOf(header)[1], labelsOf(failureHeader)[1]);
});

test('only the active column is marked, and the arrow follows the direction', () => {
    const { hooks } = hooksWithLog();
    const arrowsFor = (sort: SortState): { active: boolean[]; arrows: string[] } => {
        const { root } = renderList(ROWS, TOTALS, sort, CRASH_VOCAB, hooks, () => {}, null);
        const buttons = [...root.children[0]!.querySelectorAll('button')];
        return {
            active: buttons.map((b) => b.classList.contains('active')),
            arrows: buttons.map((b) => b.querySelector('.sort-arrow')!.textContent!),
        };
    };

    assert.deepEqual(arrowsFor({ column: 'count', ascending: false }), {
        active: [false, true],
        arrows: ['', '▼'],
    });
    assert.deepEqual(arrowsFor({ column: 'count', ascending: true }), {
        active: [false, true],
        arrows: ['', '▲'],
    });
    assert.deepEqual(arrowsFor({ column: 'tests', ascending: false }), {
        active: [true, false],
        arrows: ['▼', ''],
    });
    assert.deepEqual(arrowsFor({ column: 'tests', ascending: true }), {
        active: [true, false],
        arrows: ['▲', ''],
    });
});

test('the inactive column keeps an empty sort-arrow span, which sets the width', () => {
    // `crashes.html:559` emits the span either way. Dropping it when inactive
    // would render the same text and change the column width, so the assertion
    // is that the element exists and is empty.
    const { hooks } = hooksWithLog();
    const { root } = renderList(ROWS, TOTALS, SORT_COUNT_DESC, CRASH_VOCAB, hooks, () => {}, null);
    const arrows = [...root.children[0]!.querySelectorAll('.sort-arrow')];
    assert.equal(arrows.length, 2, 'both columns have one');
    assert.equal(arrows[0]!.textContent, '', 'the inactive one is present and empty');
});

test('clicking a sort header calls back with that column, and only on click', () => {
    const { hooks } = hooksWithLog();
    const seen: string[] = [];
    const { root } = renderList(
        ROWS,
        TOTALS,
        SORT_COUNT_DESC,
        CRASH_VOCAB,
        hooks,
        (column) => seen.push(column),
        null
    );
    assert.deepEqual(seen, [], 'rendering alone calls nothing');

    const buttons = [...root.children[0]!.querySelectorAll('button')];
    buttons[1]!.click();
    buttons[0]!.click();
    buttons[1]!.click();
    // The order and the identity of each column, not just "something fired".
    assert.deepEqual(seen, ['count', 'tests', 'count']);
    assert.equal(
        root.querySelector('[onclick]'),
        null,
        'the handler is a listener, not an attribute — divergence 1 on both pages'
    );
});

// =========================================================================
// 5. `renderSubRows`
// =========================================================================

test('renderSubRows renders a path row with its two counts and its data-path', () => {
    const { hooks } = hooksWithLog();
    const [row] = renderSubRows(
        [{ kind: 'path', dirPath: 'netwerk/test/unit', testCount: 4, count: 12 }],
        'KEY',
        CRASH_VOCAB,
        hooks
    );
    assert.equal(shape(row!), 'div.path-row');
    assert.equal(row!.dataset['path'], 'netwerk/test/unit');
    assert.equal(row!.querySelector('.crash-signature')!.textContent, 'netwerk/test/unit');
    assert.deepEqual(
        [...row!.querySelectorAll('.stat-value')].map((s) => s.textContent),
        ['4', '12']
    );
    assert.equal(row!.querySelector('.stat-value.crash')!.textContent, '12');
});

test('a path row for the repository root displays "(root)" but keeps the empty path', () => {
    const { hooks } = hooksWithLog();
    const [row] = renderSubRows(
        [{ kind: 'path', dirPath: '', testCount: 1, count: 1 }],
        'KEY',
        CRASH_VOCAB,
        hooks
    );
    assert.equal(row!.querySelector('.crash-signature')!.textContent, '(root)');
    assert.equal(row!.dataset['path'], '', 'the data attribute is the real path, not the label');
});

test('an expandable test row carries its path and name, its count and its tooltip', () => {
    const { hooks, log } = hooksWithLog();
    const [row] = renderSubRows(
        [
            {
                kind: 'test',
                dirPath: 'netwerk/test/unit',
                test: testNode({ testName: 'test_a.js', totalCount: 9 }),
                direct: false,
            },
        ],
        'KEY',
        CRASH_VOCAB,
        hooks
    );

    assert.equal(shape(row!), 'div.test-row', 'no direct-child class');
    assert.equal(row!.dataset['path'], 'netwerk/test/unit');
    assert.equal(row!.dataset['test'], 'test_a.js');
    // A row under a path row shows only the file name. `crashes.html:781`.
    assert.equal(row!.querySelector('.test-name')!.textContent, 'test_a.js');

    const countCell = row!.querySelector('.test-crash-count')!;
    assert.equal(countCell.textContent, '9');
    assert.equal(countCell.getAttribute('title'), 'TOOLTIP 9/400');
    // The tooltip is built from the row's own count and the hook's run total,
    // in that order — swapping the arguments gives `TOOLTIP 400/9`.
    assert.deepEqual(log.tooltipOf, ['9|400']);
    assert.deepEqual(log.totalRunsOf, ['netwerk/test/unit|test_a.js']);

    // The first stat cell is an empty spacer: the tests column has no number on
    // a test row. `crashes.html:725`.
    const stats = row!.querySelector('.crash-stats')!;
    assert.equal(stats.children.length, 2);
    assert.equal(stats.children[0]!.textContent, '');
    assert.equal(shape(stats.children[0]!), 'div.stat-item');
});

test('a direct-child test row shows its full path, an indented one does not', () => {
    // The collapse rule made visible: `crashes.html:724` against `:781`.
    const { hooks } = hooksWithLog();
    const [direct, indented] = renderSubRows(
        [
            {
                kind: 'test',
                dirPath: 'a/b',
                test: testNode({ testName: 'test_a.js', totalCount: 2 }),
                direct: true,
            },
            {
                kind: 'test',
                dirPath: 'a/b',
                test: testNode({ testName: 'test_b.js', totalCount: 2 }),
                direct: false,
            },
        ],
        'KEY',
        CRASH_VOCAB,
        hooks
    );
    assert.equal(shape(direct!), 'div.direct-child.test-row');
    assert.equal(direct!.querySelector('.test-name')!.textContent, 'a/b/test_a.js');
    assert.equal(shape(indented!), 'div.test-row');
    assert.equal(indented!.querySelector('.test-name')!.textContent, 'test_b.js');
});

test('the test-name suffix hook is appended after the label, or omitted', () => {
    const withSuffix = hooksWithLog({ suffix: true });
    const [row] = renderSubRows(
        [{ kind: 'test', dirPath: 'a/b', test: testNode({ totalCount: 2 }), direct: false }],
        'THE-KEY',
        FAILURE_VOCAB,
        withSuffix.hooks
    );
    const name = row!.querySelector('.test-name')!;
    assert.equal(name.textContent, 'test_a.jsSUFFIX', 'after the name, not before');
    assert.equal(shape(name.lastElementChild!), 'span.sentinel-suffix');
    // The hook is told which row it is decorating: the failures page needs the
    // message for the bug summary.
    assert.deepEqual(withSuffix.log.testNameSuffix, ['a/b|test_a.js|THE-KEY']);

    const without = hooksWithLog({ suffix: false });
    const [plain] = renderSubRows(
        [{ kind: 'test', dirPath: 'a/b', test: testNode({ totalCount: 2 }), direct: false }],
        'THE-KEY',
        CRASH_VOCAB,
        without.hooks
    );
    const plainName = plain!.querySelector('.test-name')!;
    assert.equal(plainName.textContent, 'test_a.js');
    assert.equal(plainName.children.length, 0, 'a null suffix contributes no element');
    assert.equal(plainName.childNodes.length, 1, 'and no node at all');
});

test('a single-occurrence row is a test-row carrying the page"s single class', () => {
    const occ = occurrence({ date: '2026-07-30', taskId: 'ONE' });
    const single: SubRow = {
        kind: 'single',
        dirPath: 'a/b',
        test: testNode({ occurrences: [occ], totalCount: 1 }),
        occurrence: occ,
        direct: false,
    };
    const { hooks, log } = hooksWithLog();

    const crash = renderSubRows([single], 'KEY', CRASH_VOCAB, hooks)[0]!;
    assert.equal(shape(crash), 'div.single-crash.test-row');
    const failure = renderSubRows([single], 'KEY', FAILURE_VOCAB, hooks)[0]!;
    assert.equal(shape(failure), 'div.single-failure.test-row');
    // The two names are not interchangeable: `common-data-view.css` styles
    // `.single-crash` and `.single-failure` separately.
    assert.equal(crash.classList.contains('single-failure'), false);
    assert.equal(failure.classList.contains('single-crash'), false);

    // The inline table's three cells, in order, with the job cell named by the
    // page's vocabulary.
    assert.deepEqual(shapes(crash.querySelectorAll('td')), [
        'td.run-date',
        'td.crash-job-name',
        'td',
    ]);
    assert.deepEqual(shapes(failure.querySelectorAll('td')), [
        'td.run-date',
        'td.failure-job-name',
        'td.view-links',
    ]);
    assert.equal(crash.querySelector('.run-date')!.textContent, '2026-07-30');

    // The job-name anchor is an `externalLink` here — it must not also toggle
    // the row underneath. `crashes.html:712`.
    const anchor = crash.querySelector('.crash-job-name a') as HTMLAnchorElement;
    assert.equal(anchor.getAttribute('href'), 'https://example.invalid/job/ONE');
    assert.equal(anchor.textContent, 'test-linux1804-64/opt-xpcshell-1');
    assert.equal(anchor.target, '_blank');
    assert.ok(log.jobNameHref.includes('ONE|test_a.js'));
});

test('a single-occurrence row with a href opens it on click, and an inert one does not', () => {
    const occ = occurrence({ taskId: 'CLICKY' });
    const single: SubRow = {
        kind: 'single',
        dirPath: 'a/b',
        test: testNode({ occurrences: [occ], totalCount: 1 }),
        occurrence: occ,
        direct: false,
    };

    const opened: [string, string][] = [];
    const realOpen = harness.window.open;
    (harness.window as unknown as { open: unknown }).open = (url: string, target: string) => {
        opened.push([url, target]);
        return null;
    };
    try {
        const live = renderSubRows([single], 'KEY', CRASH_VOCAB, hooksWithLog().hooks)[0]!;
        live.click();
        assert.deepEqual(opened, [['https://example.invalid/single/CLICKY', '_blank']]);

        // A crash with no minidump: `singleRowHref` returns null and the row is
        // inert. Upstream writes `data-crash-url=""` and its handler's
        // `if (crashUrl)` does nothing. The row still *looks* clickable.
        const inert = renderSubRows(
            [single],
            'KEY',
            CRASH_VOCAB,
            hooksWithLog({ inertSingle: true }).hooks
        )[0]!;
        inert.click();
        assert.equal(opened.length, 1, 'the inert row opened nothing');
        assert.equal(inert.hasAttribute('data-crash-url'), false, 'and carries no empty attribute');
    } finally {
        (harness.window as unknown as { open: unknown }).open = realOpen;
    }
});

test('a single-occurrence row carries no data-path or data-test, unlike an expandable one', () => {
    // The difference both controllers' `wireSubRows` relies on. An expandable
    // test row is wired by reading `element.dataset['path']!` and
    // `['test']` (`site/crashes.ts:495`); a `single-*` row is excluded from
    // that branch because it already has the renderer's own click listener.
    //
    // Asserted because it is what makes the exclusion safe rather than merely
    // tidy — and because a mutation removing the `!classList.contains(
    // 'single-crash')` clause survives the page suites. It survives correctly:
    // with no dataset the wired handler would look up `undefined/undefined`,
    // find no test, and return. This pins the property that makes that true, so
    // a renderer that started emitting the attributes would surface the
    // now-unguarded double-wire instead of quietly enabling it.
    const occ = occurrence();
    const { hooks } = hooksWithLog();
    const [expandable, single] = renderSubRows(
        [
            { kind: 'test', dirPath: 'a/b', test: testNode({ totalCount: 4 }), direct: false },
            {
                kind: 'single',
                dirPath: 'a/b',
                test: testNode({ occurrences: [occ], totalCount: 1 }),
                occurrence: occ,
                direct: false,
            },
        ],
        'KEY',
        CRASH_VOCAB,
        hooks
    );

    assert.equal(expandable!.dataset['path'], 'a/b');
    assert.equal(expandable!.dataset['test'], 'test_a.js');
    assert.equal(single!.dataset['path'], undefined, 'a single row carries no path');
    assert.equal(single!.dataset['test'], undefined, 'and no test name');
    // Both are `test-row`s, which is why the class check alone is not enough to
    // tell them apart.
    assert.equal(expandable!.classList.contains('test-row'), true);
    assert.equal(single!.classList.contains('test-row'), true);
    assert.equal(single!.classList.contains('single-crash'), true);
});

test('renderSubRows returns one element per sub-row, in the order given', () => {
    const occ = occurrence();
    const { hooks } = hooksWithLog();
    const rows = renderSubRows(
        [
            { kind: 'path', dirPath: 'p1', testCount: 2, count: 5 },
            { kind: 'test', dirPath: 'p2', test: testNode({ totalCount: 3 }), direct: false },
            {
                kind: 'single',
                dirPath: 'p3',
                test: testNode({ testName: 'test_c.js', occurrences: [occ], totalCount: 1 }),
                occurrence: occ,
                direct: true,
            },
        ],
        'KEY',
        CRASH_VOCAB,
        hooks
    );
    assert.deepEqual(shapes(rows), [
        'div.path-row',
        'div.test-row',
        'div.direct-child.single-crash.test-row',
    ]);
});

// =========================================================================
// 6. `renderOccurrenceTable`
// =========================================================================

test('the occurrence table is a table > tbody > tr, as the HTML parser would build', () => {
    // `site/drilldown-render.ts:751-765`. The old pages build the table as a
    // string and let the parser synthesize a `<tbody>`; `createElement` plus
    // `append` does not, and the parity diff reported 24 node differences on
    // one expanded row because of it.
    const { hooks } = hooksWithLog();
    const table = renderOccurrenceTable(
        testNode({ occurrences: [occurrence()], totalCount: 1 }),
        CRASH_VOCAB,
        hooks
    );
    assert.equal(shape(table), 'table.instance-table');
    assert.deepEqual(shapes(table.children), ['tbody'], 'exactly one child, a tbody');
    assert.equal(table.querySelectorAll(':scope > tr').length, 0, 'no tr directly under the table');
    assert.equal(table.querySelectorAll('tbody > tr').length, 1);
});

test('the occurrence table has one row per occurrence, newest first', () => {
    const { hooks } = hooksWithLog();
    const table = renderOccurrenceTable(
        testNode({
            testName: 'test_x.js',
            totalCount: 3,
            occurrences: [
                occurrence({ date: '2026-07-20', taskId: 'OLD' }),
                occurrence({ date: '2026-08-01', taskId: 'NEW' }),
                occurrence({ date: '2026-07-25', taskId: 'MID' }),
            ],
        }),
        CRASH_VOCAB,
        hooks
    );
    const rows = [...table.querySelectorAll('tr')];
    assert.equal(rows.length, 3);
    assert.deepEqual(
        rows.map((row) => row.querySelector('.run-date')!.textContent),
        ['2026-08-01', '2026-07-25', '2026-07-20'],
        'descending by date'
    );
    // The class is the page's kind, not the vocabulary's row class.
    assert.deepEqual(shapes(rows), [
        'tr.crash-instance-row',
        'tr.crash-instance-row',
        'tr.crash-instance-row',
    ]);
});

test('the occurrence table shows a date once per day', () => {
    const { hooks } = hooksWithLog();
    const table = renderOccurrenceTable(
        testNode({
            totalCount: 4,
            occurrences: [
                occurrence({ date: '2026-08-01', taskId: 'A' }),
                occurrence({ date: '2026-08-01', taskId: 'B' }),
                occurrence({ date: '2026-07-30', taskId: 'C' }),
                occurrence({ date: '2026-07-30', taskId: 'D' }),
            ],
        }),
        CRASH_VOCAB,
        hooks
    );
    assert.deepEqual(
        [...table.querySelectorAll('.run-date')].map((cell) => cell.textContent),
        ['2026-08-01', '', '2026-07-30', ''],
        'the repeat rows have an empty date cell, not a missing one'
    );
    // The cell is always present: four rows, four date cells.
    assert.equal(table.querySelectorAll('.run-date').length, 4);
});

test('the job-name anchor in the occurrence table does NOT stop propagation', () => {
    // Deliberate, and observable: `crashes.html:819` has no
    // `onclick="event.stopPropagation()"` where `:712` does, and the crashes
    // row underneath is clickable — so clicking the job name there both follows
    // the link and opens the crash viewer. Reproduced rather than tidied, so
    // this asserts the *absence* of the handler `externalLink` would add.
    const { hooks } = hooksWithLog();
    const table = renderOccurrenceTable(
        testNode({ occurrences: [occurrence()], totalCount: 1 }),
        CRASH_VOCAB,
        hooks
    );
    const anchor = table.querySelector('.crash-job-name a') as HTMLAnchorElement;
    assert.equal(anchor.target, '_blank');

    const row = el('div');
    row.append(table);
    let bubbled = false;
    row.addEventListener('click', () => {
        bubbled = true;
    });
    anchor.dispatchEvent(new harness.window.Event('click', { bubbles: true }));
    assert.equal(bubbled, true, 'the click reaches the row, unlike the inline single row');

    // The control that makes this a real distinction: the *inline* single row's
    // job anchor is an externalLink and does stop.
    const occ = occurrence();
    const single = renderSubRows(
        [
            {
                kind: 'single',
                dirPath: 'a',
                test: testNode({ occurrences: [occ], totalCount: 1 }),
                occurrence: occ,
                direct: false,
            },
        ],
        'KEY',
        CRASH_VOCAB,
        hooks
    )[0]!;
    const inlineHolder = el('div');
    inlineHolder.append(single);
    let inlineBubbled = false;
    inlineHolder.addEventListener('click', () => {
        inlineBubbled = true;
    });
    (single.querySelector('.crash-job-name a') as HTMLAnchorElement).dispatchEvent(
        new harness.window.Event('click', { bubbles: true })
    );
    assert.equal(inlineBubbled, false, 'the inline row"s job anchor does stop');
});

test('the occurrence table renders no rows for a test with no occurrences', () => {
    const { hooks } = hooksWithLog();
    const table = renderOccurrenceTable(testNode({ occurrences: [], totalCount: 5 }), CRASH_VOCAB, hooks);
    assert.equal(shape(table), 'table.instance-table');
    assert.deepEqual(shapes(table.children), ['tbody']);
    assert.equal(table.querySelectorAll('tr').length, 0);
});

// =========================================================================
// 7. `renderChartSlot` and `noData`
// =========================================================================

test('renderChartSlot wraps a canvas with the id the controller will draw into', () => {
    const slot = renderChartSlot('signature-abc-canvas');
    assert.equal(shape(slot), 'div.historical-chart');
    assert.deepEqual(shapes(slot.children), ['canvas.historical-chart-canvas']);
    assert.equal(slot.children[0]!.id, 'signature-abc-canvas');
    // The id goes on the canvas, not the wrapper — `createRateChart` looks it
    // up by id and needs a canvas.
    assert.equal(slot.id, '');
});

test('noData is the div both pages use for empty and for error', () => {
    const node = noData('No crash data available');
    assert.equal(shape(node), 'div.no-data');
    assert.equal(node.textContent, 'No crash data available');
    assert.equal(node.children.length, 0);
    // Text, not markup: the error path puts an exception message in here.
    const hostile = noData('<b>Failed</b> to fetch');
    assert.equal(hostile.querySelector('b'), null);
    assert.equal(hostile.textContent, '<b>Failed</b> to fetch');
});
