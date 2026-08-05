/**
 * `next/errors.html` against `fx-tests errors` — `PARITY.md` §5.
 *
 * The comparison the migration exists to make: both sides now answer "what is
 * loudest in the logs" from the same file, so a disagreement is a real
 * difference in what one of them decided rather than an artefact of the page's
 * logic being inline and untestable.
 *
 * ## The three classes, and which tests cover which
 *
 * `PARITY.md` §1 names three, and all three are here because four of the six
 * reported defects produced *correct numbers*:
 *
 * 1. **Value parity** — the page's rows and the CLI's rows carry the same
 *    counts and the same test spreads, asserted field by field over the whole
 *    ranking rather than on a spot check.
 * 2. **Order parity** — the full ranked sequence, compared position by
 *    position with `assertSameOrder`, because the sort-key defect produced the
 *    same set in a different order and would pass any set comparison.
 * 3. **Framing parity** — a table of (grouping, sort key, direction, row unit)
 *    derived from the page and asserted against the CLI. This is the check that
 *    was missing when `issues` shipped with the wrong question.
 *
 * ## The data is pinned, and an unpinned request fails loudly
 *
 * The checked-in fixtures, read from disk. No network, no cache, and the errors
 * files exist for only about five of `index.json`'s twenty-one dates — so a
 * test that reached for a date would silently compare nothing.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { type ErrorsFile, decodeErrors } from '../lib/formats/errors.ts';
import { type ErrorGroup, rankErrors } from '../lib/query/error-ranking.ts';
import {
    type PreparedErrors,
    INITIAL_SORT,
    KIND_SLUG,
    VIEW_COLS,
    buildGroupRows,
    ensureHaystacks,
    groupName,
    kindMask,
    kindStates,
    prepareErrors,
    soloKind,
    sortRows,
    visibleRows,
} from '../next/errors-view.ts';
import { type Divergence, assertDeclaredDivergences, assertSameOrder } from './parity-harness.ts';

/**
 * The separator the comparison keys are built with.
 *
 * Written as an escape rather than as a literal control byte, for the reason
 * `lib/query/error-ranking.ts:284` records: a literal one is invisible in a
 * diff, unmatched by a textual search, and impossible to mutation-test. It has
 * to be a byte the data cannot contain, because a message text can hold
 * anything — including colons and numbers — and a printable separator lets two
 * different locations build the same key and silently compare as one.
 */
const KEY_SEPARATOR = '\u001f';

/**
 * The stand-in for an absent field, escaped for the same reason.
 *
 * Load-bearing rather than cosmetic: a message with **no file** and a message
 * from a file named `""` must not build the same key, and `FORMATS.md` measures
 * messages carrying a line with no file — 8 of the 54 in the xpcshell fixture —
 * which the empty string would merge with each other on line number alone.
 * `lib/query/error-ranking.ts` uses the identical byte for the identical
 * reason, which is what makes the two keys comparable at all.
 */
const KEY_ABSENT = '\u0001';

const HARNESSES = ['xpcshell', 'mochitest'] as const;

function load(harness: string): { raw: ErrorsFile; page: PreparedErrors } {
    const raw = JSON.parse(
        readFileSync(
            new URL(`./fixtures/${harness}-2026-08-03-errors.json`, import.meta.url),
            'utf8'
        )
    ) as ErrorsFile;
    return { raw, page: prepareErrors(structuredClone(raw)) };
}

const allOn = (page: PreparedErrors): boolean[] => kindStates(page.markerNames, new Set());

/** The CLI's `--group-by location` ranking, uncapped. */
function cliRows(raw: ErrorsFile, options: Parameters<typeof rankErrors>[1] = {}): ErrorGroup[] {
    return rankErrors(decodeErrors(structuredClone(raw)), {
        grouping: 'location',
        sort: 'occurrences',
        maxTestsPerGroup: Number.MAX_SAFE_INTEGER,
        ...options,
    }).rows;
}

// =========================================================================
// 1. Value parity
// =========================================================================

/**
 * The page's rows, folded onto the CLI's `location` key.
 *
 * ## The divergence this function exists to bridge, which the comparison found
 *
 * The page's row unit is a **`messageId`**, which the format defines as a
 * distinct **(kind, text, file, line, component)** tuple. `lib/query/
 * error-ranking.ts`'s `location` key is **(kind, text, file, line)** — no
 * component. So one source location that different tests attribute to different
 * Bugzilla components is **several rows on the page and one row on the CLI**.
 *
 * Neither side is wrong and neither is a typo. The page's unit is the file's own
 * interning, so a row is exactly one thing the generator distinguished; the
 * CLI's key is what its module comment says — "the same text from two files is
 * two problems" — and a component is an attribute of the *test* rather than of
 * the source location, so folding it in makes `--group-by location` no longer
 * mean location.
 *
 * **Measured, and it is not a corner case:**
 *
 * | file | messages | location keys | rows the CLI merges away | occurrences in them |
 * | --- | --- | --- | --- | --- |
 * | xpcshell 2026-08-04 (real) | 1,078 | 870 | 208 | 45,175 of 315,376 (14.3%) |
 * | xpcshell 2026-08-03 (real) | 1,066 | 868 | 198 | 29,908 of 225,067 (13.3%) |
 * | xpcshell fixture | 54 | 51 | 3 | 52 of 663 (7.8%) |
 * | mochitest fixture | 60 | 60 | 0 | 0 |
 *
 * Every merged key differed **only** by component — 36 of 36 on the real file —
 * so the component is the whole of the difference and there are no exact
 * duplicate messages.
 *
 * The concrete case in the xpcshell fixture:
 * `NS_ENSURE_TRUE(inst) failed StaticComponents.cpp:14484` is messageId 11
 * (`Toolkit :: Startup and Profile System`, 16 occurrences) and messageId 33
 * (`Firefox :: Address Bar`, 8) — two rows of 16 and 8 on the page, one row of
 * 24 on the CLI.
 *
 * So the value comparison folds the page's rows the CLI's way and then asserts
 * equality, which tests everything *except* the fold. The fold itself is a
 * declared divergence with its own entry, and the per-component rows are
 * asserted separately below.
 */
function pageRowsFoldedToLocation(
    page: PreparedErrors
): Map<string, { count: number; tests: Set<number>; name: string }> {
    const { rows } = buildGroupRows(page, 'message', allOn(page), INITIAL_SORT);
    const folded = new Map<string, { count: number; tests: Set<number>; name: string }>();
    const markers = page.raw.markers;

    for (const row of rows) {
        // The CLI's key, rebuilt from the page's own resolved fields.
        const key = [
            page.msgKindId[row.gid],
            page.msgText[row.gid],
            page.msgFile[row.gid] ?? KEY_ABSENT,
            page.msgLine[row.gid] ?? KEY_ABSENT,
        ].join(KEY_SEPARATOR);
        let entry = folded.get(key);
        if (entry === undefined) {
            entry = { count: 0, tests: new Set(), name: groupName(page, row) };
            folded.set(key, entry);
        }
        entry.count += row.count;
        // The test spread has to be re-unioned rather than summed: two
        // components' rows can name the same test, and adding their counts
        // would overcount it. Walked off the raw markers.
        for (let g = 0; g < markers.messageIds.length; g++) {
            if (markers.messageIds[g] === row.gid) {
                entry.tests.add(markers.testIds[g]!);
            }
        }
    }
    return folded;
}

test('parity: every message row has the same count and test spread on both sides', () => {
    for (const harness of HARNESSES) {
        const { raw, page } = load(harness);

        const cliByKey = new Map<string, ErrorGroup>();
        for (const row of cliRows(raw)) {
            const key = [
                raw.tables.markerNames.indexOf(row.kind!),
                row.text ?? '(no message)',
                row.file ?? KEY_ABSENT,
                row.line ?? KEY_ABSENT,
            ].join(KEY_SEPARATOR);
            assert.ok(!cliByKey.has(key), `${harness}: the CLI's keys are distinct`);
            cliByKey.set(key, row);
        }

        const folded = pageRowsFoldedToLocation(page);
        assert.ok(folded.size > 0, `${harness}: the page produced rows`);
        assert.equal(folded.size, cliByKey.size, `${harness}: the same set of source locations`);

        for (const [key, entry] of folded) {
            const cli = cliByKey.get(key);
            assert.ok(cli !== undefined, `${harness}: the CLI has a row for ${entry.name}`);
            assert.equal(entry.count, cli!.count, `${harness}: ${entry.name} occurrences`);
            assert.equal(
                entry.tests.size,
                cli!.testCount,
                `${harness}: ${entry.name} test spread`
            );
        }

        // And the totals agree, which catches a row present on one side only.
        const pageTotal = [...folded.values()].reduce((sum, row) => sum + row.count, 0);
        const cliTotal = [...cliByKey.values()].reduce((sum, row) => sum + row.count, 0);
        assert.equal(pageTotal, cliTotal, `${harness}: grand totals`);
    }
});

test('parity: the page splits a source location by component and the CLI does not', () => {
    // The divergence found by the comparison above, asserted directly rather
    // than only through the fold — so it fails if either side changes.
    const { raw, page } = load('xpcshell');

    // Messages 11 and 33 are the same (kind, text, file, line) with different
    // components. Read straight off the fixture.
    const sameLocation = [11, 33];
    for (const mid of sameLocation) {
        assert.equal(raw.messages.markerNameIds[mid], raw.messages.markerNameIds[11]);
        assert.equal(raw.messages.textIds[mid], raw.messages.textIds[11]);
        assert.equal(raw.messages.fileIds[mid], raw.messages.fileIds[11]);
        assert.equal(raw.messages.lines[mid], raw.messages.lines[11]);
    }
    assert.notEqual(
        raw.messages.componentIds[11],
        raw.messages.componentIds[33],
        'and the components differ, which is the whole of the difference'
    );

    // The page shows them as two rows with two counts.
    const { rows } = buildGroupRows(page, 'message', allOn(page), INITIAL_SORT);
    const byGid = new Map(rows.map((row) => [row.gid, row]));
    assert.equal(byGid.get(11)!.count, 16);
    assert.equal(byGid.get(33)!.count, 8);
    // With the *same* label, because the component is not in `groupName`.
    assert.equal(groupName(page, byGid.get(11)!), groupName(page, byGid.get(33)!));

    // The CLI shows one row of 24.
    const cli = cliRows(raw).find(
        (row) =>
            row.file === 'StaticComponents.cpp' &&
            row.line === 14484 &&
            (row.text ?? '').startsWith('NS_ENSURE_TRUE(inst)')
    );
    assert.ok(cli !== undefined, 'the CLI has the merged row');
    assert.equal(cli!.count, 24, '16 + 8, merged');
});

test('parity: the test view agrees with `--group-by test`', () => {
    for (const harness of HARNESSES) {
        const { raw, page } = load(harness);

        const cli = new Map(
            rankErrors(decodeErrors(structuredClone(raw)), { grouping: 'test' }).rows.map(
                (row) => [row.key, row]
            )
        );
        const { rows } = buildGroupRows(page, 'test', allOn(page), INITIAL_SORT);

        for (const row of rows) {
            const match = cli.get(row.key!);
            assert.ok(match !== undefined, `${harness}: the CLI has ${row.key}`);
            assert.equal(row.count, match!.count, `${harness}: ${row.key} occurrences`);
        }
        assert.equal(rows.length, cli.size, `${harness}: the same set of tests`);
    }
});

test('parity: the component view agrees with `--group-by component`', () => {
    for (const harness of HARNESSES) {
        const { raw, page } = load(harness);

        const cli = new Map(
            rankErrors(decodeErrors(structuredClone(raw)), { grouping: 'component' }).rows.map(
                // The CLI leaves an absent component `null`; the page renders
                // the sentinel `Unknown`. Normalized here, and declared below.
                (row) => [row.component ?? 'Unknown', row]
            )
        );
        const { rows } = buildGroupRows(page, 'component', allOn(page), INITIAL_SORT);

        for (const row of rows) {
            const match = cli.get(row.key!);
            assert.ok(match !== undefined, `${harness}: the CLI has ${row.key}`);
            assert.equal(row.count, match!.count, `${harness}: ${row.key} occurrences`);
            assert.equal(row.testCount, match!.testCount, `${harness}: ${row.key} tests`);
        }
        assert.equal(rows.length, cli.size, `${harness}: the same set of components`);
    }
});

// =========================================================================
// 2. Order parity
// =========================================================================

test('parity: the full ranked sequence is identical, not just the set', () => {
    // The sort-key defect produced the same set in a different order, so this
    // compares position by position over the whole ranking rather than as sets.
    //
    // The page's rows are folded onto the CLI's key first, for the reason
    // `pageRowsFoldedToLocation` documents — comparing an unfolded page ranking
    // against the CLI's would report the component split as an ordering
    // difference at every position after the first merged row, which is a real
    // divergence but not *this* one, and would drown it.
    for (const harness of HARNESSES) {
        const { raw, page } = load(harness);

        const pageRanked = [...pageRowsFoldedToLocation(page).values()].sort(
            (a, b) => b.count - a.count
        );
        const cliRanked = cliRows(raw);

        // Both sides rank by occurrences descending, and both break ties — the
        // CLI on `testCount`, the page on CSR order. A tie is not a
        // disagreement, so the comparison runs over the count values that occur
        // exactly once, where the ranking is fully determined by the key.
        const countOf = new Map<number, number>();
        for (const row of pageRanked) {
            countOf.set(row.count, (countOf.get(row.count) ?? 0) + 1);
        }
        const unique = new Set([...countOf].filter(([, n]) => n === 1).map(([c]) => c));
        assert.ok(unique.size > 5, `${harness}: enough untied rows to compare (${unique.size})`);

        assertSameOrder(
            pageRanked.filter((row) => unique.has(row.count)).map((row) => String(row.count)),
            cliRanked.filter((row) => unique.has(row.count)).map((row) => String(row.count)),
            `${harness}: the untied rows rank in the same order`
        );

        // The loudest row is the same one on both, which is the answer the
        // command exists to give — and it is compared by *name*, not by count,
        // so two different rows that happen to share a count cannot pass it.
        const cliTop = cliRanked[0]!;
        const cliTopName = cliTop.file
            ? `${cliTop.text ?? '(no message)'} ${cliTop.file}${cliTop.line != null ? `:${cliTop.line}` : ''}`
            : (cliTop.text ?? '(no message)');
        assert.equal(pageRanked[0]!.name, cliTopName, `${harness}: the loudest row`);
        assert.equal(pageRanked[0]!.count, cliTop.count, `${harness}: and its count`);
    }
});

test('parity: sorting by tests produces the same test-count sequence on both sides', () => {
    // Clicking the `Tests` header against `--sort tests`. Folded for the same
    // reason as the occurrences ranking.
    //
    // ## What this can and cannot check, on these fixtures
    //
    // The trimmed fixtures have **2 and 1 tests** respectively, so every row's
    // test count is 1 or 2 and there is not a single untied value — the
    // unique-value technique the occurrences ranking uses has nothing to select
    // here. Rather than assert something weaker and call it order parity, this
    // asserts the two things that *are* checkable on this data and says so:
    //
    //  - the **sequence of test counts** is identical, which catches an
    //    ascending/descending flip and a wrong key;
    //  - the page's comparator **actually reorders**, which is the check that
    //    would otherwise pass against a `sortRows` that ignored its column.
    //
    // Full position-by-position order parity for this key needs a fixture with
    // a spread of test counts; the occurrences ranking above has one and is
    // where the ordering discipline is really exercised.
    for (const harness of HARNESSES) {
        const { raw, page } = load(harness);

        const pageRanked = [...pageRowsFoldedToLocation(page).values()].sort(
            (a, b) => b.tests.size - a.tests.size
        );
        const cli = cliRows(raw, { sort: 'tests' });

        assertSameOrder(
            pageRanked.map((row) => String(row.tests.size)),
            cli.map((row) => String(row.testCount)),
            `${harness}: --sort tests produces the same sequence of test counts`
        );
        assert.deepEqual(
            pageRanked.map((row) => row.tests.size),
            [...pageRanked.map((row) => row.tests.size)].sort((a, b) => b - a),
            `${harness}: and it really is descending`
        );

        const { rows } = buildGroupRows(page, 'message', allOn(page), INITIAL_SORT);
        const distinct = new Set(rows.map((row) => row.testCount));

        // The page's comparator changes the order for real — but only where the
        // data has more than one test count to order by. **The mochitest
        // fixture holds exactly one test**, so every row's count is 1 and no
        // comparator on earth can reorder them; asserting a change there would
        // be asserting a property of the trimming rather than of the code. The
        // xpcshell fixture has counts of 1 and 2 and does exercise it.
        if (distinct.size > 1) {
            const byCount = rows.map((row) => row.gid);
            sortRows(page, rows, { column: 'tests', ascending: false });
            assert.notDeepEqual(
                rows.map((row) => row.gid),
                byCount,
                `${harness}: sorting by tests changed the order`
            );
        } else {
            assert.equal(
                new Set(page.raw.markers.testIds).size,
                1,
                `${harness}: every row has one test only because the file has one test`
            );
            sortRows(page, rows, { column: 'tests', ascending: false });
        }

        // Ascending is the reverse of descending on the counts, which catches a
        // comparator that ignores its direction flag. True even when every
        // count is equal, so this runs on both fixtures.
        const descending = rows.map((row) => row.testCount);
        sortRows(page, rows, { column: 'tests', ascending: true });
        assert.deepEqual(
            rows.map((row) => row.testCount),
            [...descending].reverse(),
            `${harness}: ascending is the reverse`
        );
    }
});

// =========================================================================
// 3. Framing parity
// =========================================================================

test('parity: the framing table matches — same question, same grouping, same direction', () => {
    // `PARITY.md` §1 class 3, the one that has never been tested here and where
    // the two worst reports landed. Read off the page's constants and the CLI's
    // defaults, and asserted rather than described.
    const framing = {
        page: {
            // The first `<option>`, no `selected` attribute.
            grouping: 'message-by-source-location',
            sortKey: INITIAL_SORT.column,
            descending: !INITIAL_SORT.ascending,
            // Two columns, and no rate: the page has no run-count denominator.
            columns: VIEW_COLS.message.map((c) => c.key),
        },
        cli: {
            grouping: 'location',
            sortKey: 'occurrences',
            descending: true,
            columns: ['tests', 'count'],
        },
    };

    // The grouping names differ in spelling and mean the same thing: both key
    // on (kind, text, file, line). Asserted by behaviour rather than by name in
    // the value-parity test above; here the *direction* and the *key* are what
    // is being pinned.
    assert.equal(framing.page.sortKey, 'count');
    assert.equal(framing.cli.sortKey, 'occurrences');
    assert.equal(framing.page.descending, framing.cli.descending, 'both rank loudest first');
    assert.deepEqual(framing.page.columns, framing.cli.columns, 'the same two numbers');

    // And the default grouping really is by location on both. The CLI's default
    // is read from `rankErrors` with no `grouping`, and it must not be
    // `message` — the by-text grouping the page abandoned in `819eef5`.
    const { raw } = load('xpcshell');
    const decoded = decodeErrors(structuredClone(raw));
    const byDefault = rankErrors(decoded, {}).rows;
    const byLocation = rankErrors(decoded, { grouping: 'location' }).rows;
    const byText = rankErrors(decoded, { grouping: 'message' }).rows;
    assert.equal(byDefault.length, byLocation.length, 'the CLI defaults to location');
    assert.ok(
        byText.length < byLocation.length,
        `grouping by text really is coarser (${byText.length} vs ${byLocation.length}) — ` +
            'so defaulting to it would answer a different question'
    );
});

test('parity: every kind checkbox has a `--kind` analogue that selects the same rows', () => {
    // `PARITY.md` §5: "every checkbox has a CLI analogue". Driven through the
    // whole matrix rather than spot-checked.
    for (const harness of HARNESSES) {
        const { raw, page } = load(harness);
        const decoded = decodeErrors(structuredClone(raw));

        for (const kindName of raw.tables.markerNames) {
            const slug = KIND_SLUG[kindName];
            assert.ok(
                slug !== undefined,
                `${harness}: the markup has a checkbox for the kind ${kindName}`
            );

            // The page: solo this kind in the test view, where the checkbox
            // changes the counts (in the message view it only hides rows).
            const on = kindStates(page.markerNames, soloKind(slug!));
            const pageTotal = buildGroupRows(page, 'test', on, INITIAL_SORT).totals.count;

            // The CLI: `--kind <name>`.
            const cliTotal = rankErrors(decoded, { kind: kindName }).totals.matchedCount;
            assert.equal(pageTotal, cliTotal, `${harness}: --kind ${kindName}`);
        }
    }
});

test('parity: the search box and `--message` select the same rows for a message term', () => {
    // The page's search is one box over four fields; the CLI has one flag per
    // field. Where they overlap they must agree — checked on a term that only
    // ever appears in message text, so the page's wider haystack cannot make
    // the comparison vacuous.
    const { raw, page } = load('xpcshell');
    const decoded = decodeErrors(structuredClone(raw));

    // A term drawn from the data rather than invented: the first message text's
    // first word, lowercased.
    const term = raw.tables.messageTexts[0]!.split(/\s+/)[0]!.toLowerCase();
    assert.ok(term.length > 3, `the probe term is specific enough: ${term}`);

    const { rows } = buildGroupRows(page, 'message', allOn(page), INITIAL_SORT);
    ensureHaystacks(page, 'message', rows);
    const shown = visibleRows('message', rows, kindMask(allOn(page)), term);

    const cli = rankErrors(decoded, { grouping: 'location', message: term }).rows;

    // The page's row set is a **superset**: its haystack also covers the test
    // paths, the source files and the components, so a term matching a test
    // path pulls in rows whose text does not contain it. Declared below; the
    // assertion is that every CLI row is on the page.
    const pageNames = new Set(shown.map((row) => groupName(page, row)));
    for (const row of cli) {
        const text = row.text ?? '(no message)';
        const name = row.file
            ? `${text} ${row.file}${row.line != null ? `:${row.line}` : ''}`
            : text;
        assert.ok(pageNames.has(name), `the page shows the CLI's row ${JSON.stringify(name)}`);
    }
    assert.ok(cli.length > 0, 'the probe term matched something on the CLI side');
});

// =========================================================================
// The allow-list
// =========================================================================

test('parity: the declared page-vs-CLI divergences all still diverge', () => {
    const { raw, page } = load('xpcshell');
    const decoded = decodeErrors(structuredClone(raw));

    const cliLocation = rankErrors(decoded, { grouping: 'location' }).rows;

    // The page's search term over the whole haystack, against `--message`.
    const { rows } = buildGroupRows(page, 'message', allOn(page), INITIAL_SORT);
    ensureHaystacks(page, 'message', rows);
    // A term that appears in a **test path** and in no message text, so the
    // page matches rows the CLI's `--message` cannot.
    const pathTerm = page.testFull[0]!.split('/')[0]!.toLowerCase();
    const pageByPath = visibleRows('message', rows, kindMask(allOn(page)), pathTerm).length;
    const cliByMessage = rankErrors(decoded, { grouping: 'location', message: pathTerm }).rows
        .length;

    const divergences: Divergence[] = [
        {
            what: 'the row unit: one source location, or one per component of it',
            reason:
                'The page groups by messageId, which the format defines as ' +
                '(kind, text, file, line, component); the CLI groups by (kind, text, file, ' +
                'line) and leaves the component out. So one source location that different ' +
                'tests attribute to different Bugzilla components is several rows on the page ' +
                'and one on the CLI. Neither is a mistake: the page shows exactly what the ' +
                'generator interned, which is what lets a reader filter by component; the ' +
                "CLI's key is what --group-by location has to mean, since a component is an " +
                'attribute of the test rather than of the source line, and folding it in ' +
                'would make the flag name false. Measured on the pinned xpcshell 2026-08-04 ' +
                'file: 1,078 messages over 870 location keys, so 208 rows differ, holding ' +
                '45,175 of 315,376 occurrences (14.3%). Every merged key differed only by ' +
                'component — 36 of 36 — so there are no exact duplicate messages.',
            page: rows.length,
            cli: cliLocation.length,
        },
        {
            what: 'what the free-text box searches',
            reason:
                'The page has one box that matches message text, source file, component and ' +
                'test path at once, because a reader typing "netwerk" means "anything to do ' +
                'with netwerk" and does not know which field will hold it. The CLI has four ' +
                'separate flags because a script asking for a component must not silently ' +
                'match a test path that happens to contain the same word. So the page selects ' +
                'a superset for any term that appears outside message text.',
            page: pageByPath,
            cli: cliByMessage,
        },
        {
            what: 'how many tests a row lists',
            reason:
                'The CLI caps the per-row test list at 20 (--limit territory: a terminal row ' +
                'cannot usefully show two thousand paths) while keeping testCount exact, so ' +
                '"in 9,367 tests" stays true beside a list of twenty. The page expands a row ' +
                'into a scrollable subtree with no cap, because the reader asked for that one ' +
                'row and the browser can hold it. The cap is a presentation limit, not a ' +
                'difference in what either side measured.',
            page: 'uncapped',
            cli: 20,
        },
        {
            what: 'the grouping key of a message with a line and no file',
            reason:
                'Both group by (kind, text, file, line) and agree on the row set — but the ' +
                'page then *displays* such a row by its text alone, because groupName nests ' +
                'the line inside the file (errors.html:493). The CLI prints the line in its ' +
                'own column, so two rows the page shows with identical labels are ' +
                'distinguishable on the CLI. Measured: 8 of the 54 xpcshell fixture messages ' +
                'have a line and no file.',
            page: 'text only',
            cli: 'text plus the line',
        },
    ];

    assertDeclaredDivergences('errors page vs CLI', divergences);

    // And the things that must *not* diverge, asserted positively so a future
    // change that makes one of them differ fails rather than joining the list.
    assert.equal(
        cliLocation.reduce((sum, row) => sum + row.count, 0),
        buildGroupRows(page, 'message', allOn(page), INITIAL_SORT).totals.count,
        'the grand total is not a divergence'
    );
});
