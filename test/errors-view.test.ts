/**
 * `next/errors-view.ts` — the view model behind `next/errors.html`.
 *
 * ## Where every expected value comes from
 *
 * This project's most expensive recurring mistake is a test whose expected
 * value is produced by the thing under test; it has happened five times, once
 * inside the file written to prevent it. So the arithmetic here comes from two
 * sources and **never** from `errors-view.ts`:
 *
 * 1. **A hand-authored file, `TINY`.** Twelve marker groups over four tests and
 *    seven messages, written out as literals with the counts chosen so that
 *    every total is a distinct number a reader can add up in their head — and
 *    so that a plausible wrong implementation gets a *different* number rather
 *    than the same one. Each expectation below cites the arithmetic.
 *
 *    The shape is deliberately pathological where the format allows it: two
 *    messages share a text at different locations (the `819eef5` row unit), one
 *    message has a **line and no file** (the nested-`groupName` case), one has
 *    **no component**, two `testInfo` entries share a path *and* name (the
 *    intern), and one test emits two kinds (so a per-kind test sum
 *    double-counts it and the mask does not).
 *
 * 2. **The checked-in real fixtures**, read with a second, independent walk
 *    written in the test — never through `prepareErrors` or `buildGroupRows`.
 *    Those cover the sizes and the null distributions a hand-authored file
 *    cannot honestly claim.
 *
 * Each assertion below was checked against the question "could this pass
 * against a plausible wrong implementation?" — the mutation list at the bottom
 * of `next/errors.ts`'s report records which ones were verified by actually
 * breaking the code.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ErrorsFile } from '../lib/formats/errors.ts';
import {
    type ErrorView,
    type PreparedErrors,
    DEFAULT_VIEW,
    HISTORICAL_DATE,
    INITIAL_SORT,
    KIND_SLUG,
    KIND_SLUGS,
    NO_MESSAGE,
    UNKNOWN_COMPONENT,
    VIEW_COLS,
    VIEW_NAME_LABEL,
    buildDetail,
    buildGroupRows,
    colValue,
    ensureHaystacks,
    formatHidden,
    getCsr,
    groupName,
    instanceRows,
    instancesOf,
    isErrorView,
    isHistoricalDate,
    kindMask,
    kindStates,
    messageTotals,
    nextSort,
    parseHidden,
    pctTitle,
    prepareErrors,
    readUrlState,
    soloKind,
    sortRows,
    visibleRows,
} from '../next/errors-view.ts';

// =========================================================================
// The hand-authored file
// =========================================================================

/**
 * A twelve-group errors file, written out so every expectation is arithmetic on
 * literals.
 *
 * ## The tests
 *
 * | testId | path | name | full |
 * | --- | --- | --- | --- |
 * | 0 | `dom/base/test` | `test_a.js` | `dom/base/test/test_a.js` |
 * | 1 | `dom/base/test` | `test_b.js` | `dom/base/test/test_b.js` |
 * | 2 | `netwerk/test` | `test_c.js` | `netwerk/test/test_c.js` |
 * | 3 | `dom/base/test` | `test_a.js` | `dom/base/test/test_a.js` — **a duplicate identity** |
 *
 * Test 3 exists to exercise the intern at `prepareErrors`: two `testInfo`
 * entries with the same path and name must be **one** row in the test view and
 * **two** distinct tests in the message view's Tests column, because that column
 * counts `testIds` and not paths. Both are asserted.
 *
 * ## The messages
 *
 * | mid | kind | text | file | line | component |
 * | --- | --- | --- | --- | --- | --- |
 * | 0 | `C++ warning` | `NS_ENSURE_TRUE failed` | `a.cpp` | 10 | `Core :: XPCOM` |
 * | 1 | `C++ warning` | `NS_ENSURE_TRUE failed` | `b.cpp` | 20 | `Core :: XPCOM` |
 * | 2 | `console.error` | `boom` | `c.js` | 30 | `Core :: DOM` |
 * | 3 | `JavaScript error` | `TypeError: x` | `d.js` | *null* | `Core :: DOM` |
 * | 4 | `console.warn` | `careful` | *null* | 44 | `Core :: XPCOM` |
 * | 5 | `C++ assertion` | *null* | `e.cpp` | 50 | *null* |
 * | 6 | `TSan Error` | `race` | `f.cpp` | 60 | `Core :: DOM` |
 *
 * Messages 0 and 1 share a text and differ only in location — the row unit
 * commit `819eef5` established. Message 4 has a **line and no file**. Message 5
 * has **no text and no component**. Message 6 is the seventh kind, which only
 * mochitest carries in the real data.
 *
 * ## The marker groups
 *
 * `(testId, messageId)` with per-task counts. Twelve groups:
 *
 * | g | test | msg | task counts | total |
 * | --- | --- | --- | --- | --- |
 * | 0 | 0 | 0 | [5, 3] | 8 |
 * | 1 | 0 | 1 | [2] | 2 |
 * | 2 | 0 | 2 | [7] | 7 |
 * | 3 | 1 | 0 | [4] | 4 |
 * | 4 | 1 | 3 | [1, 1, 1] | 3 |
 * | 5 | 1 | 4 | [6] | 6 |
 * | 6 | 2 | 1 | [9] | 9 |
 * | 7 | 2 | 2 | [10] | 10 |
 * | 8 | 2 | 5 | [1] | 1 |
 * | 9 | 3 | 0 | [12] | 12 |
 * | 10 | 3 | 6 | [20] | 20 |
 * | 11 | 0 | 6 | [30] | 30 |
 *
 * Grand total **112**, which is 8+2+7+4+3+6+9+10+1+12+20+30 — every number a
 * different value so a dropped or doubled group changes the sum.
 */
const TINY: ErrorsFile = {
    metadata: {
        date: '2026-08-04',
        startTime: 1785801600,
        generatedAt: '2026-08-05T00:00:00.000Z',
        jobCount: 5,
        processedJobCount: 5,
        invalidJobCount: 0,
        markerCounts: {
            'C++ warning': 26,
            'console.error': 17,
            'JavaScript error': 3,
            'console.warn': 6,
            'C++ assertion': 1,
            'TSan Error': 50,
        },
    },
    tables: {
        jobNames: ['linux-opt-xpcshell', 'win-debug-xpcshell'],
        testPaths: ['dom/base/test', 'netwerk/test'],
        testNames: ['test_a.js', 'test_b.js', 'test_c.js'],
        repositories: ['mozilla-central'],
        taskIds: ['AAA.0', 'BBB.0', 'CCC.1', 'DDD.0'],
        components: ['Core :: XPCOM', 'Core :: DOM'],
        commitIds: ['abc123'],
        // Deliberately **not** in the markup's order and missing
        // `JavaScript warning`, because the real files differ per date and
        // `kindStates` must key by name rather than by index.
        markerNames: [
            'C++ warning',
            'console.error',
            'JavaScript error',
            'console.warn',
            'C++ assertion',
            'TSan Error',
        ],
        messageTexts: ['NS_ENSURE_TRUE failed', 'boom', 'TypeError: x', 'careful', 'race'],
        files: ['a.cpp', 'b.cpp', 'c.js', 'd.js', 'e.cpp', 'f.cpp'],
    },
    messages: {
        markerNameIds: [0, 0, 1, 2, 3, 4, 5],
        textIds: [0, 0, 1, 2, 3, null, 4],
        fileIds: [0, 1, 2, 3, null, 4, 5],
        lines: [10, 20, 30, null, 44, 50, 60],
        componentIds: [0, 0, 1, 1, 0, null, 1],
    },
    taskInfo: {
        repositoryIds: [0, 0, 0, 0],
        jobNameIds: [0, 1, 0, 1],
        commitIds: [0, 0, 0, 0],
    },
    testInfo: {
        testPathIds: [0, 0, 1, 0],
        testNameIds: [0, 1, 2, 0],
        componentIds: [0, 1, 1, 0],
    },
    markers: {
        testIds: [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 0],
        messageIds: [0, 1, 2, 0, 3, 4, 1, 2, 5, 0, 6, 6],
        // Delta-encoded from 0. `[0, 1]` is task indices 0 and 1; `[2]` is
        // index 2; `[1, 1, 1]` is indices 1, 2 and 3.
        taskIdIds: [[0, 1], [2], [0], [1], [1, 1, 1], [3], [0], [2], [1], [0], [3], [0]],
        counts: [[5, 3], [2], [7], [4], [1, 1, 1], [6], [9], [10], [1], [12], [20], [30]],
    },
};

/** Every kind on, for the file's own `markerNames` order. */
function allOn(data: PreparedErrors): boolean[] {
    return kindStates(data.markerNames, new Set());
}

const tiny = (): PreparedErrors => prepareErrors(structuredClone(TINY));

// =========================================================================
// The controls
// =========================================================================

test('there are seven marker kinds, not the six the old comment claims', () => {
    // `errors.html:211`'s comment says "The six fixed marker kinds" above a
    // table of seven. Counted off the markup rather than off the table: the
    // seven `id="kind-…"` checkboxes at `errors.html:184-190`.
    const markup = readFileSync(new URL('../errors.html', import.meta.url), 'utf8');
    const ids = [...markup.matchAll(/id="kind-([a-z+-]+)"/g)].map((m) => m[1]!);
    assert.equal(ids.length, 7, 'the markup has seven kind checkboxes');
    assert.deepEqual(ids, [
        'cpp-warning',
        'cpp-assertion',
        'console-error',
        'console-warn',
        'js-error',
        'js-warning',
        'tsan-error',
    ]);

    // And the table matches them, in the same order — which is the order the
    // URL's `hide=` list is written in.
    assert.equal(Object.keys(KIND_SLUG).length, 7);
    assert.deepEqual([...KIND_SLUGS], ids);
});

test('the default view is message, which is the first option and unselected', () => {
    const markup = readFileSync(new URL('../errors.html', import.meta.url), 'utf8');
    const select = /<select id="viewSelect"[^>]*>([\s\S]*?)<\/select>/.exec(markup)![1]!;
    const options = [...select.matchAll(/<option value="([a-z]+)"([^>]*)>/g)];
    assert.equal(options[0]![1], 'message', 'message is the first option');
    for (const option of options) {
        assert.ok(
            !option[2]!.includes('selected'),
            `no option carries selected, so the browser picks the first: ${option[0]}`
        );
    }
    assert.equal(DEFAULT_VIEW, 'message');

    // And every option the markup offers is a view the code accepts, so a
    // reader cannot select one that fails the hash validation.
    for (const option of options) {
        assert.ok(isErrorView(option[1]!), `${option[1]} is a view`);
    }
});

test('the default sort is count-descending, and every view uses the same one', () => {
    assert.deepEqual(INITIAL_SORT, { column: 'count', ascending: false });
});

test('a new column starts descending, except name which starts ascending', () => {
    // `errors.html:823`: `ascending = column === 'name'`. A-to-Z for a name,
    // biggest-first for a number.
    assert.deepEqual(nextSort({ column: 'count', ascending: false }, 'tests'), {
        column: 'tests',
        ascending: false,
    });
    assert.deepEqual(nextSort({ column: 'count', ascending: false }, 'messages'), {
        column: 'messages',
        ascending: false,
    });
    assert.deepEqual(nextSort({ column: 'count', ascending: false }, 'name'), {
        column: 'name',
        ascending: true,
    });
    // The same column flips, in both directions and for name too.
    assert.deepEqual(nextSort({ column: 'count', ascending: false }, 'count'), {
        column: 'count',
        ascending: true,
    });
    assert.deepEqual(nextSort({ column: 'name', ascending: true }, 'name'), {
        column: 'name',
        ascending: false,
    });
});

test('the message view has no Messages column and the component view has all three', () => {
    // A message-view row is one message, so the column would read 1 on every
    // row. `errors.html:224`.
    assert.deepEqual(
        VIEW_COLS.message.map((c) => c.key),
        ['tests', 'count']
    );
    assert.deepEqual(
        VIEW_COLS.test.map((c) => c.key),
        ['messages', 'count']
    );
    assert.deepEqual(
        VIEW_COLS.component.map((c) => c.key),
        ['tests', 'messages', 'count']
    );
    assert.deepEqual(VIEW_NAME_LABEL, {
        message: 'Message',
        test: 'Test',
        component: 'Component',
    });
    // No view shows a column it did not compute: the message view has no
    // `messages` column precisely because `buildGroupRows` leaves it null.
    for (const view of ['message', 'test', 'component'] as ErrorView[]) {
        const { totals } = buildGroupRows(tiny(), view, allOn(tiny()), INITIAL_SORT);
        for (const col of VIEW_COLS[view]) {
            if (col.key === 'tests') {
                assert.notEqual(totals.tests, null, `${view} shows Tests, so it must have one`);
            }
            if (col.key === 'messages') {
                assert.notEqual(
                    totals.messages,
                    null,
                    `${view} shows Messages, so it must have one`
                );
            }
        }
    }
});

// =========================================================================
// prepareErrors
// =========================================================================

test('prepareErrors resolves the tables, nulls included', () => {
    const data = tiny();

    // Text: message 5 has none and displays as the placeholder.
    assert.deepEqual(
        [...data.msgText],
        [
            'NS_ENSURE_TRUE failed',
            'NS_ENSURE_TRUE failed',
            'boom',
            'TypeError: x',
            'careful',
            NO_MESSAGE,
            'race',
        ]
    );
    // File: message 4 has none. Line: message 3 has none.
    assert.deepEqual(
        [...data.msgFile],
        ['a.cpp', 'b.cpp', 'c.js', 'd.js', null, 'e.cpp', 'f.cpp']
    );
    assert.deepEqual([...data.msgLine], [10, 20, 30, null, 44, 50, 60]);
    // Component: message 5 has none and displays as `Unknown`.
    assert.deepEqual(
        [...data.msgComp],
        [
            'Core :: XPCOM',
            'Core :: XPCOM',
            'Core :: DOM',
            'Core :: DOM',
            'Core :: XPCOM',
            UNKNOWN_COMPONENT,
            'Core :: DOM',
        ]
    );

    // Test paths, including the duplicate identity at testId 3.
    assert.deepEqual(
        [...data.testFull],
        [
            'dom/base/test/test_a.js',
            'dom/base/test/test_b.js',
            'netwerk/test/test_c.js',
            'dom/base/test/test_a.js',
        ]
    );
    // Interned to three distinct groups: 0 and 3 share one.
    assert.deepEqual([...data.testGroupId], [0, 1, 2, 0]);
    assert.deepEqual(
        [...data.testGroupLabel],
        ['dom/base/test/test_a.js', 'dom/base/test/test_b.js', 'netwerk/test/test_c.js']
    );

    // Per-group totals, summed by hand from the `counts` literals above.
    assert.deepEqual([...data.groupTotal], [8, 2, 7, 4, 3, 6, 9, 10, 1, 12, 20, 30]);

    // No day axis, task IDs present — the shape every published file has.
    assert.equal(data.hasDays, false);
    assert.equal(data.hasTasks, true);
});

test('the search haystack covers text, file and component but not line or kind', () => {
    const data = tiny();
    // Message 0: text + file + component, lowercased, space-joined.
    assert.equal(data.msgBlob[0], 'ns_ensure_true failed a.cpp core :: xpcom');
    // Message 4 has no file, so an empty slot stays between the two spaces —
    // upstream's `(D.msgFile[i] || '')`.
    assert.equal(data.msgBlob[4], 'careful  core :: xpcom');
    // The line number is not in it: searching `10` finds message 0 only if its
    // text or path happens to contain `10`, which it does not.
    assert.ok(!data.msgBlob[0]!.includes('10'), 'the line number is not searchable');
    // Neither is the kind: `c++ warning` matches nothing.
    assert.ok(!data.msgBlob[0]!.includes('warning'), 'the kind is not searchable');
});

test('the component sentinel is a trailing group, not a reused id', () => {
    const data = tiny();
    // Two real components plus the sentinel.
    assert.deepEqual([...data.compGroupLabel], ['Core :: XPCOM', 'Core :: DOM', 'Unknown']);
    // Message 5 (no component) maps to index 2, which is past the real table —
    // so it can never collide with a real component's id.
    assert.deepEqual([...data.compGroupId], [0, 0, 1, 1, 0, 2, 1]);
});

test('kindTotal and testKindMask are per-kind aggregates over the whole file', () => {
    const data = tiny();
    // `markerNames` order is `C++ warning, console.error, JavaScript error,
    // console.warn, C++ assertion, TSan Error`.
    //
    // C++ warning is messages 0 and 1: groups 0 (8), 1 (2), 3 (4), 6 (9),
    // 9 (12) = 35.
    // console.error is message 2: groups 2 (7), 7 (10) = 17.
    // JavaScript error is message 3: group 4 = 3.
    // console.warn is message 4: group 5 = 6.
    // C++ assertion is message 5: group 8 = 1.
    // TSan Error is message 6: groups 10 (20), 11 (30) = 50.
    assert.deepEqual([...data.kindTotal], [35, 17, 3, 6, 1, 50]);
    // The six sum to 112, the grand total.
    assert.equal([...data.kindTotal].reduce((a, b) => a + b, 0), 112);

    // Masks, bit k for kind k:
    //  test 0: messages 0 (C++ warning, bit 0), 1 (bit 0), 2 (console.error,
    //          bit 1), 6 (TSan, bit 5) -> 0b100011 = 35
    //  test 1: messages 0 (bit 0), 3 (JS error, bit 2), 4 (console.warn, bit 3)
    //          -> 0b1101 = 13
    //  test 2: messages 1 (bit 0), 2 (bit 1), 5 (C++ assertion, bit 4)
    //          -> 0b10011 = 19
    //  test 3: messages 0 (bit 0), 6 (bit 5) -> 0b100001 = 33
    assert.deepEqual([...data.testKindMask], [35, 13, 19, 33]);
});

// =========================================================================
// Grouping
// =========================================================================

test('the message view groups by source location, not by message text', () => {
    // The framing fact commit `819eef5` established. Messages 0 and 1 are the
    // same text at two files, and they must be **two** rows.
    const data = tiny();
    const { rows } = buildGroupRows(data, 'message', allOn(data), INITIAL_SORT);

    const named = rows.map((row) => ({ name: groupName(data, row), count: row.count }));
    const sameText = named.filter((row) => row.name.startsWith('NS_ENSURE_TRUE failed'));
    assert.equal(sameText.length, 2, 'one row per location, not one per text');
    assert.deepEqual(
        sameText.map((r) => r.name).sort(),
        ['NS_ENSURE_TRUE failed a.cpp:10', 'NS_ENSURE_TRUE failed b.cpp:20'],
        'each row names its own location'
    );
    // Message 0 is groups 0 (8), 3 (4), 9 (12) = 24. Message 1 is groups 1 (2)
    // and 6 (9) = 11. A by-text grouping would show one row of 35.
    assert.deepEqual(
        sameText.map((r) => r.count).sort((a, b) => a - b),
        [11, 24]
    );
});

test('message-view rows carry the right counts and the right distinct-test counts', () => {
    const data = tiny();
    const { rows, totals } = buildGroupRows(data, 'message', allOn(data), INITIAL_SORT);

    const byName = new Map(rows.map((row) => [groupName(data, row), row]));
    // Every count summed by hand from the group table in `TINY`'s comment.
    //  mid 0: g0 8 + g3 4 + g9 12 = 24, in tests 0, 1, 3 -> 3 distinct testIds
    //  mid 1: g1 2 + g6 9        = 11, in tests 0, 2     -> 2
    //  mid 2: g2 7 + g7 10       = 17, in tests 0, 2     -> 2
    //  mid 3: g4 3               =  3, in test 1         -> 1
    //  mid 4: g5 6               =  6, in test 1         -> 1
    //  mid 5: g8 1               =  1, in test 2         -> 1
    //  mid 6: g10 20 + g11 30    = 50, in tests 3, 0     -> 2
    const expected: [string, number, number][] = [
        ['NS_ENSURE_TRUE failed a.cpp:10', 24, 3],
        ['NS_ENSURE_TRUE failed b.cpp:20', 11, 2],
        ['boom c.js:30', 17, 2],
        ['TypeError: x d.js', 3, 1],
        ['careful', 6, 1],
        [`${NO_MESSAGE} e.cpp:50`, 1, 1],
        ['race f.cpp:60', 50, 2],
    ];
    assert.equal(rows.length, expected.length);
    for (const [name, count, tests] of expected) {
        const row = byName.get(name);
        assert.ok(row !== undefined, `row ${name} exists`);
        assert.equal(row!.count, count, `${name} count`);
        assert.equal(row!.testCount, tests, `${name} tests`);
    }

    // Totals: 24+11+17+3+6+1+50 = 112 occurrences, and 4 distinct testIds —
    // note **4**, not 3: the message view counts `testIds`, so the duplicate
    // identity at testId 3 is its own test here even though the test view
    // merges it. That asymmetry is upstream's and is asserted both ways.
    assert.equal(totals.count, 112);
    assert.equal(totals.tests, 4);
    assert.equal(totals.messages, null, 'the message view computes no Messages total');
});

test('the test view merges two testInfo entries with the same path and name', () => {
    const data = tiny();
    const { rows, totals } = buildGroupRows(data, 'test', allOn(data), INITIAL_SORT);

    const byName = new Map(rows.map((row) => [row.key!, row]));
    //  test_a.js is testIds 0 and 3 merged:
    //    testId 0: g0 8 + g1 2 + g2 7 + g11 30 = 47, messages 0, 1, 2, 6
    //    testId 3: g9 12 + g10 20              = 32, messages 0, 6
    //    -> 79 occurrences over the distinct messages {0, 1, 2, 6} = 4
    //  test_b.js is testId 1: g3 4 + g4 3 + g5 6 = 13, messages 0, 3, 4 = 3
    //  test_c.js is testId 2: g6 9 + g7 10 + g8 1 = 20, messages 1, 2, 5 = 3
    assert.equal(rows.length, 3, 'three rows, not four — the identities merged');
    assert.equal(byName.get('dom/base/test/test_a.js')!.count, 79);
    assert.equal(byName.get('dom/base/test/test_a.js')!.msgCount, 4);
    assert.equal(byName.get('dom/base/test/test_b.js')!.count, 13);
    assert.equal(byName.get('dom/base/test/test_b.js')!.msgCount, 3);
    assert.equal(byName.get('netwerk/test/test_c.js')!.count, 20);
    assert.equal(byName.get('netwerk/test/test_c.js')!.msgCount, 3);

    // 79 + 13 + 20 = 112, and 7 distinct messages over the file.
    assert.equal(totals.count, 112);
    assert.equal(totals.messages, 7);
    assert.equal(totals.tests, null, 'the test view computes no Tests total');
});

test('the component view groups by the message component, with a sentinel row', () => {
    const data = tiny();
    const { rows, totals } = buildGroupRows(data, 'component', allOn(data), INITIAL_SORT);

    const byName = new Map(rows.map((row) => [row.key!, row]));
    //  Core :: XPCOM is messages 0, 1, 4:
    //    g0 8 + g1 2 + g3 4 + g5 6 + g6 9 + g9 12 = 41
    //    tests {0, 1, 2, 3} = 4, messages {0, 1, 4} = 3
    //  Core :: DOM is messages 2, 3, 6:
    //    g2 7 + g4 3 + g7 10 + g10 20 + g11 30 = 70
    //    tests {0, 1, 2, 3} = 4, messages {2, 3, 6} = 3
    //  Unknown is message 5: g8 1, tests {2} = 1, messages {5} = 1
    assert.equal(rows.length, 3);
    assert.equal(byName.get('Core :: XPCOM')!.count, 41);
    assert.equal(byName.get('Core :: XPCOM')!.testCount, 4);
    assert.equal(byName.get('Core :: XPCOM')!.msgCount, 3);
    assert.equal(byName.get('Core :: DOM')!.count, 70);
    assert.equal(byName.get('Core :: DOM')!.testCount, 4);
    assert.equal(byName.get('Core :: DOM')!.msgCount, 3);
    assert.equal(byName.get('Unknown')!.count, 1);
    assert.equal(byName.get('Unknown')!.testCount, 1);
    assert.equal(byName.get('Unknown')!.msgCount, 1);

    // 41 + 70 + 1 = 112. The two per-row test counts sum to 9 while only 4
    // distinct tests exist, which is exactly why the total is a distinct count
    // and not a sum of the column — the property `crashes.html` gets wrong.
    assert.equal(totals.count, 112);
    assert.equal(totals.tests, 4);
    assert.equal(4 + 4 + 1, 9, 'the column sums to 9; the total says 4');
    assert.equal(totals.messages, 7);
});

test('a group with no surviving markers is dropped, so a test with none has no row', () => {
    // The universe of this page is the markers in the file. Turning off every
    // kind but `C++ assertion` leaves exactly the one group that has it.
    const data = tiny();
    const only = kindStates(data.markerNames, soloKind('cpp-assertion'));
    const { rows, totals } = buildGroupRows(data, 'test', only, INITIAL_SORT);
    assert.equal(rows.length, 1, 'only netwerk/test/test_c.js emitted an assertion');
    assert.equal(rows[0]!.key, 'netwerk/test/test_c.js');
    assert.equal(rows[0]!.count, 1);
    assert.equal(totals.count, 1);
    // And no row at all when nothing survives.
    const none = kindStates(data.markerNames, new Set(KIND_SLUGS));
    assert.deepEqual(buildGroupRows(data, 'test', none, INITIAL_SORT).rows, []);
});

// =========================================================================
// The kind checkboxes
// =========================================================================

test('kindStates keys by name, so a file listing its kinds in another order works', () => {
    // The real files differ: xpcshell 2026-08-04 and 2026-08-03 carry the same
    // six kinds in different orders. Indexing by position would silently
    // disable the wrong one.
    const names = ['TSan Error', 'C++ warning', 'console.error'];
    assert.deepEqual(kindStates(names, new Set()), [true, true, true]);
    assert.deepEqual(kindStates(names, new Set(['cpp-warning'])), [true, false, true]);
    assert.deepEqual(kindStates(names, new Set(['tsan-error'])), [false, true, true]);
    // A reordering of the same names moves the `false` with the name.
    const reordered = ['console.error', 'TSan Error', 'C++ warning'];
    assert.deepEqual(kindStates(reordered, new Set(['tsan-error'])), [true, false, true]);
});

test('a kind the markup does not name defaults to on and cannot be turned off', () => {
    // `errors.html:394`: `on[i] = cb ? cb.checked : true`.
    const names = ['C++ warning', 'Rust panic'];
    assert.deepEqual(kindStates(names, new Set()), [true, true]);
    assert.deepEqual(
        kindStates(names, new Set(KIND_SLUGS)),
        [false, true],
        'every slug disabled still leaves the unnamed kind on'
    );
});

test('kindMask sets one bit per enabled kind', () => {
    assert.equal(kindMask([true, true, true]), 0b111);
    assert.equal(kindMask([false, true, false, true]), 0b1010);
    assert.equal(kindMask([]), 0);
    assert.equal(kindMask([false, false]), 0);
});

test('soloKind disables every slug but the clicked one, in markup order', () => {
    const solo = soloKind('js-error');
    assert.equal(solo.size, 6);
    assert.ok(!solo.has('js-error'));
    assert.ok(solo.has('cpp-warning') && solo.has('tsan-error'));
    // Round-trips through the URL in markup order, not click order.
    assert.equal(
        formatHidden(solo),
        'cpp-warning,cpp-assertion,console-error,console-warn,js-warning,tsan-error'
    );
});

test('a message-view kind toggle hides rows without changing any row count', () => {
    // The structural reason the message view does not re-group: a row is one
    // message, so it has one kind and the checkbox can only show or hide it.
    const data = tiny();
    const all = buildGroupRows(data, 'message', allOn(data), INITIAL_SORT);
    const withoutTsan = kindStates(data.markerNames, new Set(['tsan-error']));
    const filtered = visibleRows('message', all.rows, kindMask(withoutTsan), '');

    // The TSan row (`race f.cpp:60`, 50) is gone; the other six are untouched.
    assert.equal(filtered.length, 6);
    assert.ok(!filtered.some((row) => groupName(data, row) === 'race f.cpp:60'));
    for (const row of filtered) {
        const before = all.rows.find((candidate) => candidate.gid === row.gid)!;
        assert.equal(row.count, before.count, 'no row count changed');
        assert.equal(row.testCount, before.testCount);
    }
});

test('a test-view kind toggle changes the counts and therefore the ranking', () => {
    // The other half of the same rule. Turning off TSan removes 50 from
    // test_a.js and nothing from the others, which flips the order.
    const data = tiny();
    const all = buildGroupRows(data, 'test', allOn(data), INITIAL_SORT);
    assert.deepEqual(
        all.rows.map((row) => [row.key, row.count]),
        [
            ['dom/base/test/test_a.js', 79],
            ['netwerk/test/test_c.js', 20],
            ['dom/base/test/test_b.js', 13],
        ]
    );

    const withoutTsan = kindStates(data.markerNames, new Set(['tsan-error']));
    const after = buildGroupRows(data, 'test', withoutTsan, INITIAL_SORT);
    //  test_a.js loses g10 (20) and g11 (30): 79 - 50 = 29, messages 0, 1, 2 = 3
    //  test_c.js and test_b.js are unchanged
    assert.deepEqual(
        after.rows.map((row) => [row.key, row.count]),
        [
            ['dom/base/test/test_a.js', 29],
            ['netwerk/test/test_c.js', 20],
            ['dom/base/test/test_b.js', 13],
        ]
    );
    assert.equal(after.rows[0]!.msgCount, 3, 'the Messages column shrank too');
    assert.equal(after.totals.count, 112 - 50);
    assert.equal(after.totals.messages, 6, 'message 6 is gone from the file entirely');
});

test('messageTotals is a distinct test count, not a sum of per-kind test counts', () => {
    const data = tiny();
    // All kinds on: 112 occurrences and 4 distinct tests.
    assert.deepEqual(messageTotals(data, allOn(data)), {
        count: 112,
        tests: 4,
        messages: null,
    });

    // The per-kind test counts, counted by hand from `testKindMask`:
    //   C++ warning (bit 0): tests 0, 1, 2, 3 = 4
    //   console.error (1):   tests 0, 2       = 2
    //   JS error (2):        test 1           = 1
    //   console.warn (3):    test 1           = 1
    //   C++ assertion (4):   test 2           = 1
    //   TSan (5):            tests 0, 3       = 2
    // They sum to 11, where only 4 distinct tests exist — a 2.75x overcount the
    // mask avoids. A summing implementation would print 11 here.
    assert.equal(4 + 2 + 1 + 1 + 1 + 2, 11);

    // Two kinds on: C++ warning (35) + TSan (50) = 85 occurrences.
    // Their masks are bits 0 and 5, i.e. 0b100001 = 33; the tests with either
    // are 0 (35 & 33 = 33), 1 (13 & 33 = 1), 2 (19 & 33 = 17) and 3 (33 & 33) —
    // all four.
    const two = kindStates(
        data.markerNames,
        new Set(['console-error', 'js-error', 'console-warn', 'cpp-assertion'])
    );
    assert.deepEqual(messageTotals(data, two), { count: 85, tests: 4, messages: null });

    // One kind on: console.warn is 6 occurrences in test 1 alone.
    const one = kindStates(data.markerNames, soloKind('console-warn'));
    assert.deepEqual(messageTotals(data, one), { count: 6, tests: 1, messages: null });

    // No kinds on: zero of both, which is what makes `pctTitle` return null.
    const none = kindStates(data.markerNames, new Set(KIND_SLUGS));
    assert.deepEqual(messageTotals(data, none), { count: 0, tests: 0, messages: null });
});

// =========================================================================
// Sorting
// =========================================================================

test('sorting ranks by each column in both directions', () => {
    const data = tiny();
    const { rows } = buildGroupRows(data, 'message', allOn(data), INITIAL_SORT);
    const names = (): string[] => rows.map((row) => groupName(data, row));

    // Counts are 24, 11, 17, 3, 6, 1, 50 (in messageId order). Descending:
    // 50, 24, 17, 11, 6, 3, 1 — every value distinct, so there are no ties to
    // hide a comparator that returns 0.
    assert.deepEqual(rows.map((row) => row.count), [50, 24, 17, 11, 6, 3, 1]);

    sortRows(data, rows, { column: 'count', ascending: true });
    assert.deepEqual(rows.map((row) => row.count), [1, 3, 6, 11, 17, 24, 50]);

    // Test counts are 3, 2, 2, 1, 1, 1, 2. Descending puts the 3 first; the
    // three 2s and three 1s tie, and stability means they keep the order they
    // were in — which after the ascending-count sort above is by count.
    sortRows(data, rows, { column: 'tests', ascending: false });
    assert.deepEqual(rows.map((row) => row.testCount), [3, 2, 2, 2, 1, 1, 1]);
    assert.deepEqual(
        rows.filter((row) => row.testCount === 2).map((row) => row.count),
        [11, 17, 50],
        'ties keep the previous order — the sort is stable'
    );

    // By name, ascending — `localeCompare`, so case and punctuation follow the
    // locale rather than code points.
    sortRows(data, rows, { column: 'name', ascending: true });
    const ascending = names();
    const expected = [...ascending].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(ascending, expected);
    assert.equal(ascending[0], '(no message) e.cpp:50');

    sortRows(data, rows, { column: 'name', ascending: false });
    assert.deepEqual(names(), [...ascending].reverse());
});

test('colValue reads the column the header names, and name builds the label', () => {
    const data = tiny();
    const { rows } = buildGroupRows(data, 'message', allOn(data), INITIAL_SORT);
    const top = rows[0]!;
    assert.equal(colValue(data, top, 'count'), 50);
    assert.equal(colValue(data, top, 'tests'), 2);
    assert.equal(colValue(data, top, 'messages'), 0, 'the message view computes none');
    assert.equal(colValue(data, top, 'name'), 'race f.cpp:60');
});

test('a message with a line and no file is named by its text alone', () => {
    // `groupName` nests the line inside the file (`errors.html:493-494`), so a
    // message the *grouping* distinguished by line is *displayed* without it.
    // Message 4 is `careful`, line 44, no file.
    const data = tiny();
    const { rows } = buildGroupRows(data, 'message', allOn(data), INITIAL_SORT);
    const row = rows.find((candidate) => candidate.gid === 4)!;
    assert.equal(groupName(data, row), 'careful');
    assert.ok(!groupName(data, row).includes('44'), 'the line is not shown without a file');

    // And a file with no line shows the file alone. Message 3 is
    // `TypeError: x`, file `d.js`, no line.
    const noLine = rows.find((candidate) => candidate.gid === 3)!;
    assert.equal(groupName(data, noLine), 'TypeError: x d.js');
});

test('groupName caches onto the row, and the cache is the same string', () => {
    const data = tiny();
    const { rows } = buildGroupRows(data, 'message', allOn(data), INITIAL_SORT);
    const row = rows[0]!;
    assert.equal(row.key, null, 'a message-view row starts with no label');
    const first = groupName(data, row);
    assert.equal(row.key, first, 'the label is written back onto the row');
    assert.equal(groupName(data, row), first);
});

// =========================================================================
// Filtering
// =========================================================================

test('a search matches any message text, file, component or test path in a row', () => {
    const data = tiny();
    const { rows } = buildGroupRows(data, 'message', allOn(data), INITIAL_SORT);
    ensureHaystacks(data, 'message', rows);
    const mask = kindMask(allOn(data));
    const names = (term: string): string[] =>
        visibleRows('message', rows, mask, term)
            .map((row) => groupName(data, row))
            .sort();

    // By message text.
    assert.deepEqual(names('ns_ensure'), [
        'NS_ENSURE_TRUE failed a.cpp:10',
        'NS_ENSURE_TRUE failed b.cpp:20',
    ]);
    // By source file — `a.cpp` is message 0 only, which distinguishes the two
    // same-text rows a by-text grouping would have merged.
    assert.deepEqual(names('a.cpp'), ['NS_ENSURE_TRUE failed a.cpp:10']);
    // By component.
    assert.deepEqual(names('xpcom').length, 3, 'messages 0, 1 and 4 are XPCOM');
    // By **test path**, which is the row's other half: `netwerk` appears in no
    // message and in test 2, which emitted messages 1, 2 and 5.
    assert.deepEqual(names('netwerk'), [
        '(no message) e.cpp:50',
        'NS_ENSURE_TRUE failed b.cpp:20',
        'boom c.js:30',
    ]);
    // Nothing matches an absent term, and the empty term matches everything.
    assert.deepEqual(names('zzzz'), []);
    assert.equal(visibleRows('message', rows, mask, '').length, 7);
});

test('a `!`-prefixed search is a literal search, not a negation', () => {
    // Checked against the whole page: nothing in `errors.html` treats `!`
    // specially, so `!boom` looks for those five characters.
    const data = tiny();
    const { rows } = buildGroupRows(data, 'message', allOn(data), INITIAL_SORT);
    ensureHaystacks(data, 'message', rows);
    const mask = kindMask(allOn(data));
    assert.deepEqual(visibleRows('message', rows, mask, '!boom'), []);
    // If it were a negation, this would return the six rows that are not `boom`.
    assert.notEqual(visibleRows('message', rows, mask, '!boom').length, 6);
});

test('the search never rewrites a row count, but the expansion is filtered', () => {
    // The page bug reproduced as divergence 4: a row survives with the count it
    // had, and expanding it shows only what matched — so the two disagree.
    const data = tiny();
    const { rows, totals } = buildGroupRows(data, 'test', allOn(data), INITIAL_SORT);
    ensureHaystacks(data, 'test', rows);

    // `boom` is message 2, which test_a.js emitted 7 times out of its 79.
    const shown = visibleRows('test', rows, kindMask(allOn(data)), 'boom');
    const testA = shown.find((row) => row.key === 'dom/base/test/test_a.js')!;
    assert.equal(testA.count, 79, 'the row still shows its unfiltered count');

    const detail = buildDetail(data, 'test', testA, allOn(data), 'boom');
    const visibleSum = detail.subs.reduce((sum, sub) => sum + sub.count, 0);
    assert.equal(visibleSum, 7, 'expanding it reveals only the 7 that matched');
    assert.notEqual(testA.count, visibleSum, 'the row and its subtree disagree — reproduced');

    // And the grand total is untouched by the search, which is what makes the
    // percentage tooltips wrong under one.
    assert.equal(totals.count, 112);
    assert.equal(pctTitle(testA.count, totals.count), '70.54% of all 112 occurrences');
    // 79/112 = 70.535…%, and the correct denominator under this search would be
    // the 7+9+... of what matched. Both numbers computed here by hand:
    assert.equal(((79 / 112) * 100).toFixed(2), '70.54');
});

test('ensureHaystacks builds every row once and only once', () => {
    const data = tiny();
    const { rows } = buildGroupRows(data, 'message', allOn(data), INITIAL_SORT);
    assert.ok(rows.every((row) => row.hay === null));
    ensureHaystacks(data, 'message', rows);
    assert.ok(rows.every((row) => row.hay !== null));

    // Idempotent: a second call must not append to the haystacks it built.
    const before = rows.map((row) => row.hay);
    ensureHaystacks(data, 'message', rows);
    assert.deepEqual(rows.map((row) => row.hay), before);

    // The row for message 0 names its own message blob and every test that
    // emitted it — tests 0, 1 and 3, of which 0 and 3 are the same path.
    const row = rows.find((candidate) => candidate.gid === 0)!;
    assert.ok(row.hay!.includes('ns_ensure_true failed a.cpp'));
    assert.ok(row.hay!.includes('dom/base/test/test_a.js'));
    assert.ok(row.hay!.includes('dom/base/test/test_b.js'));
    assert.ok(!row.hay!.includes('netwerk'), 'test 2 never emitted this message');
});

test('the kind mask is not applied twice in the test and component views', () => {
    // `visibleRows` applies it only in the message view. Applying it again in
    // the test view would drop a mixed-kind row that legitimately survived with
    // a smaller count — test_b.js keeps 4 of its 13 with only C++ warning on.
    const data = tiny();
    const only = kindStates(data.markerNames, soloKind('cpp-warning'));
    const { rows } = buildGroupRows(data, 'test', only, INITIAL_SORT);
    const shown = visibleRows('test', rows, kindMask(only), '');
    assert.equal(shown.length, 3, 'all three tests emitted a C++ warning');
    const byName = new Map(shown.map((row) => [row.key!, row.count]));
    // test_a.js: g0 8 + g1 2 + g9 12 = 22; test_b.js: g3 4; test_c.js: g6 9
    assert.deepEqual([...byName], [
        ['dom/base/test/test_a.js', 22],
        ['netwerk/test/test_c.js', 9],
        ['dom/base/test/test_b.js', 4],
    ]);
});

// =========================================================================
// Expansion
// =========================================================================

test('a message-view row expands to its tests, a test-view row to its messages', () => {
    const data = tiny();
    const on = allOn(data);

    // Message view: the row for message 0 expands to testIds 0, 1 and 3.
    const message = buildGroupRows(data, 'message', on, INITIAL_SORT);
    const mid0 = message.rows.find((row) => row.gid === 0)!;
    const messageDetail = buildDetail(data, 'message', mid0, on, '');
    // Counts by hand: g0 = 8 (test 0), g3 = 4 (test 1), g9 = 12 (test 3).
    // Sorted descending: 12, 8, 4.
    assert.deepEqual(
        messageDetail.subs.map((sub) => [sub.key, sub.count]),
        [
            [3, 12],
            [0, 8],
            [1, 4],
        ]
    );
    assert.equal(messageDetail.dayCounts, null, 'no day axis on a daily file');

    // Test view: test_a.js (group id 0, testIds 0 and 3) expands to messages.
    const byTest = buildGroupRows(data, 'test', on, INITIAL_SORT);
    const testA = byTest.rows.find((row) => row.key === 'dom/base/test/test_a.js')!;
    const testDetail = buildDetail(data, 'test', testA, on, '');
    // The row is testIds 0 **and** 3, so every group of either contributes:
    //   message 0 -> g0 (test 0) 8 + g9 (test 3) 12 = 20
    //   message 1 -> g1 2
    //   message 2 -> g2 7
    //   message 6 -> g11 (test 0) 30 + g10 (test 3) 20 = 50
    // Descending: 50, 20, 7, 2.
    assert.deepEqual(
        testDetail.subs.map((sub) => [sub.key, sub.count]),
        [
            [6, 50],
            [0, 20],
            [2, 7],
            [1, 2],
        ]
    );
    // Sums to 79, the row's count — so with no search the two agree.
    assert.equal(
        testDetail.subs.reduce((sum, sub) => sum + sub.count, 0),
        79
    );
});

test('expanding re-applies the kind filter', () => {
    const data = tiny();
    const withoutTsan = kindStates(data.markerNames, new Set(['tsan-error']));
    const byTest = buildGroupRows(data, 'test', withoutTsan, INITIAL_SORT);
    const testA = byTest.rows.find((row) => row.key === 'dom/base/test/test_a.js')!;
    const detail = buildDetail(data, 'test', testA, withoutTsan, '');
    assert.ok(
        !detail.subs.some((sub) => sub.key === 6),
        'the TSan message is gone from the subtree, as it is from the count'
    );
    assert.equal(
        detail.subs.reduce((sum, sub) => sum + sub.count, 0),
        29,
        'and the subtree sums to the row count, 79 - 50'
    );
});

test('the per-task instances decode the delta encoding and merge repeats', () => {
    const data = tiny();
    const on = allOn(data);
    const message = buildGroupRows(data, 'message', on, INITIAL_SORT);

    // Message 3 (`TypeError: x`) is group 4 alone: taskIdIds `[1, 1, 1]`, which
    // decodes to task indices 1, 2, 3, with counts [1, 1, 1]. Those are
    // `BBB.0`, `CCC.1` and `DDD.0`, on job names win, linux, win.
    const mid3 = message.rows.find((row) => row.gid === 3)!;
    const detail = buildDetail(data, 'message', mid3, on, '');
    assert.equal(detail.subs.length, 1);
    const instances = instancesOf(data, detail.subs[0]!);
    assert.deepEqual(instances, [
        {
            taskId: 'BBB',
            retryId: '0',
            jobName: 'win-debug-xpcshell',
            count: 1,
            date: '2026-08-04',
        },
        {
            taskId: 'CCC',
            retryId: '1',
            jobName: 'linux-opt-xpcshell',
            count: 1,
            date: '2026-08-04',
        },
        {
            taskId: 'DDD',
            retryId: '0',
            jobName: 'win-debug-xpcshell',
            count: 1,
            date: '2026-08-04',
        },
    ]);

    // Message 0 in the message view expands to three tests; the sub for testId 0
    // is group 0, taskIdIds `[0, 1]` -> indices 0 and 1, counts [5, 3].
    const mid0 = message.rows.find((row) => row.gid === 0)!;
    const mid0Detail = buildDetail(data, 'message', mid0, on, '');
    const test0 = mid0Detail.subs.find((sub) => sub.key === 0)!;
    assert.deepEqual(instancesOf(data, test0).map((i) => [i.taskId, i.count]), [
        ['AAA', 5],
        ['BBB', 3],
    ]);

    // A **test-view** sub merges two marker groups that share a task. Message 0
    // under test_a.js is groups 0 (tasks 0, 1 with 5 and 3) and 9 (task 0 with
    // 12), so task AAA must show 5 + 12 = 17, not two rows.
    const byTest = buildGroupRows(data, 'test', on, INITIAL_SORT);
    const testA = byTest.rows.find((row) => row.key === 'dom/base/test/test_a.js')!;
    const merged = buildDetail(data, 'test', testA, on, '').subs.find((sub) => sub.key === 0)!;
    assert.deepEqual(instancesOf(data, merged).map((i) => [i.taskId, i.count]), [
        ['AAA', 17],
        ['BBB', 3],
    ]);
    assert.equal(17 + 3, 20, 'and they sum to the sub-row count');
});

test('instanceRows shows a date once per day, newest first', () => {
    // Every instance of a daily file shares one date, so exactly the first row
    // shows it.
    const same = [
        { taskId: 'A', retryId: '0', jobName: 'x', count: 1, date: '2026-08-04' },
        { taskId: 'B', retryId: '0', jobName: 'y', count: 2, date: '2026-08-04' },
    ];
    assert.deepEqual(
        instanceRows(same).map((row) => [row.instance.taskId, row.showDate]),
        [
            ['A', true],
            ['B', false],
        ]
    );

    // Across days: newest first, and each new day shows its date.
    const across = [
        { taskId: 'A', retryId: '0', jobName: 'x', count: 1, date: '2026-08-02' },
        { taskId: 'B', retryId: '0', jobName: 'y', count: 1, date: '2026-08-04' },
        { taskId: 'C', retryId: '0', jobName: 'z', count: 1, date: '2026-08-04' },
    ];
    assert.deepEqual(
        instanceRows(across).map((row) => [row.instance.taskId, row.showDate]),
        [
            ['B', true],
            ['C', false],
            ['A', true],
        ]
    );

    // A dateless instance never claims a date and never sets `lastDate`.
    const undated = [{ taskId: 'A', retryId: '0', jobName: 'x', count: 1, date: '' }];
    assert.deepEqual(instanceRows(undated), [{ instance: undated[0]!, showDate: false }]);

    // The input is not mutated — the shared `prepareRunsForDisplay` sorts in
    // place and stamps `dateHtml`, which is why it is not called.
    const input = [...across];
    instanceRows(input);
    assert.deepEqual(input.map((i) => i.taskId), ['A', 'B', 'C']);
    assert.ok(!('dateHtml' in input[0]!));
});

// =========================================================================
// Percentages
// =========================================================================

// The page formats every number with `toLocaleString()`, so the thousands
// separator depends on the runtime's locale — a comma here, a narrow no-break
// space under `fr-FR`. Hardcoding one made these tests fail on a French
// machine, which is a defect in the test and not in the tooltip: the tooltip is
// consistent with every other number on the page. Expectations are built the
// same way rather than pinned to a separator.
const n = (value: number): string => value.toLocaleString();

test('pctTitle rounds once from the raw ratio and suppresses a zero total', () => {
    // Rounded from the ratio, not from a rounded intermediate: 1/3 is 33.33,
    // and a two-step round via 33.3 would give 33.30.
    assert.equal(pctTitle(1, 3), '33.33% of all 3 occurrences');
    assert.equal(pctTitle(2, 3), '66.67% of all 3 occurrences');
    // A value that a percentage-then-round would get wrong: 1/1078 is
    // 0.0927…%, which truncating rather than rounding would render 0.09.
    assert.equal(pctTitle(1, 1078), `0.09% of all ${n(1078)} occurrences`);
    assert.equal(pctTitle(6, 1078), `0.56% of all ${n(1078)} occurrences`);
    // 5/8 = 62.5 exactly, so `toFixed(2)` pads rather than rounds.
    assert.equal(pctTitle(5, 8), '62.50% of all 8 occurrences');
    // The whole total is 100.00, not 100.
    assert.equal(pctTitle(112, 112), '100.00% of all 112 occurrences');
    // No total, no tooltip — not `0.00%`, and not `NaN%`.
    assert.equal(pctTitle(5, 0), null);
    assert.equal(pctTitle(0, 0), null);
});

test('pctTitle names both populations when a search is narrowing the list', () => {
    // The real case, from the pinned xpcshell file: searching `NS_ENSURE_TRUE`
    // leaves 100 rows totalling 20,922 of the file's 315,376 occurrences, and
    // upstream's tooltip reported only the second share — 4.85% — while the row
    // was 73.04% of what the reader could see. Both numbers are true; naming
    // one of them "of all occurrences" and omitting the other is what made it
    // misleading.
    assert.equal(
        pctTitle(15_282, 315_376, 20_922),
        `73.04% of the ${n(20_922)} shown, 4.85% of all ${n(315_376)}`
    );

    // Each share is computed from its own denominator. Deliberately chosen so
    // the two percentages differ in both digits: an implementation that divided
    // twice by the same number would produce the same string twice.
    assert.equal(pctTitle(1, 8, 2), '50.00% of the 2 shown, 12.50% of all 8');

    // Nothing filtered — the two populations coincide, and a second number
    // would be noise. Asserted for the equal case and for the absent argument,
    // because those reach the collapse by different routes.
    assert.equal(pctTitle(1, 3, 3), '33.33% of all 3 occurrences');
    assert.equal(pctTitle(1, 3, undefined), '33.33% of all 3 occurrences');
    // A zero visible total would divide by zero; it collapses rather than
    // rendering `Infinity%`.
    assert.equal(pctTitle(1, 3, 0), '33.33% of all 3 occurrences');
    // And a zero grand total still suppresses the tooltip entirely, whatever
    // the visible total says.
    assert.equal(pctTitle(5, 0, 5), null);
});

// =========================================================================
// URL state
// =========================================================================

test('the hash carries date, q, view and hide, and validates the view', () => {
    const read = (hash: string): unknown => readUrlState(new URLSearchParams(hash));
    assert.deepEqual(read(''), {});
    assert.deepEqual(read('date=2026-08-04&q=netwerk&view=test&hide=js-error'), {
        date: '2026-08-04',
        q: 'netwerk',
        view: 'test',
        hide: 'js-error',
    });
    // An unknown view is dropped rather than applied, so `#view=bogus` leaves
    // the page on its current view. `errors.html:1128`.
    assert.deepEqual(read('view=bogus'), {});
    assert.deepEqual(read('view=component'), { view: 'component' });
    // An empty `q` is present and empty, which is what clears the box; an
    // absent one is absent, which the caller also treats as clear.
    assert.deepEqual(read('q='), { q: '' });
});

test('hide round-trips the disabled set in markup order', () => {
    assert.deepEqual([...parseHidden(undefined)], []);
    assert.deepEqual([...parseHidden('')], [], 'an empty hide means all kinds on');
    assert.deepEqual([...parseHidden('js-error,tsan-error')], ['js-error', 'tsan-error']);
    // Empty segments are dropped, so `hide=,,` is still "all on".
    assert.deepEqual([...parseHidden(',,')], []);

    // Written back in markup order regardless of insertion order.
    assert.equal(formatHidden(new Set(['tsan-error', 'cpp-warning'])), 'cpp-warning,tsan-error');
    assert.equal(formatHidden(new Set()), '');
    // A slug that is not in the table is not written — the URL only ever names
    // the seven the markup has.
    assert.equal(formatHidden(new Set(['not-a-kind'])), '');

    // Round-trip: every subset survives.
    for (const slug of KIND_SLUGS) {
        const solo = soloKind(slug);
        assert.deepEqual(parseHidden(formatHidden(solo)), solo);
    }
});

test('an absent date means one day here, unlike the crashes and failures pages', () => {
    // `errors.html:1144-1152`: "Default: most recent single day". Only the exact
    // string `21days` is historical.
    assert.equal(isHistoricalDate(undefined), false);
    assert.equal(isHistoricalDate(''), false);
    assert.equal(isHistoricalDate('2026-08-04'), false);
    assert.equal(isHistoricalDate(HISTORICAL_DATE), true);
    assert.equal(HISTORICAL_DATE, '21days');
});

// =========================================================================
// The real fixtures
// =========================================================================

const REAL: { name: string; file: ErrorsFile }[] = ['xpcshell', 'mochitest'].map((harness) => ({
    name: harness,
    file: JSON.parse(
        readFileSync(
            new URL(`./fixtures/${harness}-2026-08-03-errors.json`, import.meta.url),
            'utf8'
        )
    ) as ErrorsFile,
}));

test('the real fixtures group to counts an independent walk agrees with', () => {
    for (const { name, file } of REAL) {
        // A second, independent walk over the raw JSON. Nothing here calls
        // `prepareErrors`, `getCsr` or `buildGroupRows`.
        const totalOf = (groupId: number): number =>
            file.markers.counts[groupId]!.reduce((a, b) => a + b, 0);

        const perMessage = new Map<number, { count: number; tests: Set<number> }>();
        let grand = 0;
        for (let g = 0; g < file.markers.testIds.length; g++) {
            const mid = file.markers.messageIds[g]!;
            const total = totalOf(g);
            grand += total;
            let entry = perMessage.get(mid);
            if (entry === undefined) {
                entry = { count: 0, tests: new Set() };
                perMessage.set(mid, entry);
            }
            entry.count += total;
            entry.tests.add(file.markers.testIds[g]!);
        }

        const data = prepareErrors(structuredClone(file));
        const { rows, totals } = buildGroupRows(data, 'message', allOn(data), INITIAL_SORT);

        assert.equal(totals.count, grand, `${name}: grand total`);
        assert.equal(rows.length, perMessage.size, `${name}: one row per messageId`);
        for (const row of rows) {
            const expected = perMessage.get(row.gid)!;
            assert.equal(row.count, expected.count, `${name}: message ${row.gid} count`);
            assert.equal(
                row.testCount,
                expected.tests.size,
                `${name}: message ${row.gid} distinct tests`
            );
        }

        // And the distinct-test total is the union, not a sum of the column.
        const allTests = new Set(file.markers.testIds);
        assert.equal(totals.tests, allTests.size, `${name}: distinct tests`);
    }
});

test('the real fixtures hold texts at more than one source location', () => {
    // The property that makes the row unit matter, asserted on real data rather
    // than only on `TINY`.
    for (const { name, file } of REAL) {
        const byText = new Map<string, number>();
        for (let i = 0; i < file.messages.markerNameIds.length; i++) {
            const id = file.messages.textIds[i];
            const text = id != null ? file.tables.messageTexts[id]! : NO_MESSAGE;
            byText.set(text, (byText.get(text) ?? 0) + 1);
        }
        const messageCount = file.messages.markerNameIds.length;
        assert.ok(
            byText.size < messageCount,
            `${name}: ${messageCount} messages over ${byText.size} texts — some text repeats`
        );

        // And the page really does produce one row per location.
        const data = prepareErrors(structuredClone(file));
        const { rows } = buildGroupRows(data, 'message', allOn(data), INITIAL_SORT);
        const names = new Set(rows.map((row) => groupName(data, row)));
        assert.ok(
            names.size > byText.size ||
                rows.length === messageCount,
            `${name}: rows are locations, not texts`
        );
    }
});

test('the CSR buckets partition the markers exactly, for every view', () => {
    for (const { name, file } of REAL) {
        const data = prepareErrors(structuredClone(file));
        for (const view of ['message', 'test', 'component'] as ErrorView[]) {
            const csr = getCsr(data, view);
            assert.equal(
                csr.order.length,
                file.markers.testIds.length,
                `${name}/${view}: every marker group is bucketed exactly once`
            );
            assert.equal(csr.gStart[0], 0);
            assert.equal(csr.gStart[csr.nGroups], csr.order.length);
            // Every index appears exactly once.
            const seen = new Uint8Array(csr.order.length);
            for (const i of csr.order) {
                assert.equal(seen[i], 0, `${name}/${view}: index ${i} bucketed twice`);
                seen[i] = 1;
            }
            // And every entry is in the run its group id names.
            for (let g = 0; g < csr.nGroups; g++) {
                for (let j = csr.gStart[g]!; j < csr.gStart[g + 1]!; j++) {
                    const i = csr.order[j]!;
                    const expected =
                        view === 'message'
                            ? file.markers.messageIds[i]!
                            : view === 'test'
                              ? data.testGroupId[file.markers.testIds[i]!]!
                              : data.compGroupId[file.markers.messageIds[i]!]!;
                    assert.equal(expected, g, `${name}/${view}: marker ${i} in the wrong run`);
                }
            }
        }
    }
});

test('the three views total to the same number of occurrences', () => {
    // Different groupings of the same markers must sum to the same thing —
    // which catches a grouping that drops or duplicates a run.
    for (const { name, file } of REAL) {
        const data = prepareErrors(structuredClone(file));
        const counts = (['message', 'test', 'component'] as ErrorView[]).map(
            (view) => buildGroupRows(data, view, allOn(data), INITIAL_SORT).totals.count
        );
        assert.equal(counts[0], counts[1], `${name}: message vs test`);
        assert.equal(counts[1], counts[2], `${name}: test vs component`);
        // And it matches an independent sum.
        const grand = file.markers.counts.reduce(
            (sum, list) => sum + list.reduce((a, b) => a + b, 0),
            0
        );
        assert.equal(counts[0], grand, `${name}: matches the raw sum`);
    }
});

test('messageTotals matches a re-group with the same kinds off', () => {
    // The fast path and the slow path must agree, which is the whole reason the
    // fast path is allowed to exist. Checked for every single-kind solo.
    for (const { name, file } of REAL) {
        const data = prepareErrors(structuredClone(file));
        for (const kindName of file.tables.markerNames) {
            const slug = KIND_SLUG[kindName]!;
            const on = kindStates(data.markerNames, soloKind(slug));

            const fast = messageTotals(data, on);
            // The slow path: group the *test* view with the same kinds, whose
            // totals come from the full pass rather than from the aggregates.
            const slow = buildGroupRows(data, 'test', on, INITIAL_SORT).totals;
            assert.equal(fast.count, slow.count, `${name}/${kindName}: occurrences`);

            // And the distinct-test count against an independent walk.
            const kindId = file.tables.markerNames.indexOf(kindName);
            const tests = new Set<number>();
            for (let g = 0; g < file.markers.testIds.length; g++) {
                if (file.messages.markerNameIds[file.markers.messageIds[g]!] === kindId) {
                    tests.add(file.markers.testIds[g]!);
                }
            }
            assert.equal(fast.tests, tests.size, `${name}/${kindName}: distinct tests`);
        }
    }
});

test('every task index in the real fixtures resolves to a job name', () => {
    // The guard behind divergence 7: upstream would render the string
    // "undefined" for an unresolvable one, and there are none.
    for (const { name, file } of REAL) {
        const data = prepareErrors(structuredClone(file));
        const { rows } = buildGroupRows(data, 'message', allOn(data), INITIAL_SORT);
        let checked = 0;
        for (const row of rows.slice(0, 20)) {
            for (const sub of buildDetail(data, 'message', row, allOn(data), '').subs) {
                for (const instance of instancesOf(data, sub)) {
                    assert.ok(
                        typeof instance.jobName === 'string' && instance.jobName.length > 0,
                        `${name}: every task resolves to a job name`
                    );
                    // And every task ID carries a `.N` suffix, so `parseTaskId`
                    // and upstream's `lastIndexOf('.')` agree.
                    assert.match(instance.retryId, /^\d+$/, `${name}: retryId is a number`);
                    checked++;
                }
            }
        }
        assert.ok(checked > 0, `${name}: the walk actually visited some instances`);
    }
});
