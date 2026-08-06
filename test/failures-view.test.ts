/**
 * `failures.html`'s page-local view model.
 *
 * The shared drill-down is covered by `test/drilldown-view.test.ts`; this file
 * is what is only true of the failures page — the message as the row key, the
 * search-aware expansion map, the Searchfox split, the bug-button guard, and the
 * agreement with `lib/query/failures.ts` that `PARITY.md` §5 asks for.
 *
 * Same rule as the shared tests: **no expected value comes from the thing under
 * test.** The message tallies below are read off the raw fixture by hand, and
 * the Searchfox split is checked against `common-links.js`'s own regex, read out
 * of the shared script rather than retyped.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeIssuesWithTaskIds } from '../lib/formats/issues.ts';
import type { IssuesWithTaskIdsFile } from '../lib/formats/issues.ts';
import { groupFailuresByMessage } from '../lib/query/failures.ts';
import { INITIAL_SORT, NO_FAILURE_MESSAGE, rowsOf } from '../site/drilldown-view.ts';
import type { PathNode, TestNode } from '../site/drilldown-view.ts';
import { buildCrashGroups } from '../site/crashes-view.ts';
import {
    FAILURE_NOUN,
    buildFailureGroups,
    failureList,
    hasBugButton,
    messageLink,
    mostFrequentTestPath,
} from '../site/failures-view.ts';

const file = JSON.parse(
    readFileSync(
        new URL('../test/fixtures/xpcshell-issues-with-taskids.json', import.meta.url),
        'utf8'
    )
) as IssuesWithTaskIdsFile;
const decoded = decodeIssuesWithTaskIds(file);
const startTime = file.metadata.startTime;

/** Message → occurrences and distinct tests, read straight off the raw JSON. */
function tally(): { tests: Map<string, Set<string>>; counts: Map<string, number> } {
    const tests = new Map<string, Set<string>>();
    const counts = new Map<string, number>();
    const failStatusIds = file.tables.statuses
        .map((status, id) => (status.startsWith('FAIL') ? id : -1))
        .filter((id) => id !== -1);

    file.testRuns.forEach((testGroup, testId) => {
        if (!testGroup) {
            return;
        }
        const dirPath = file.tables.testPaths[file.testInfo.testPathIds[testId]!]!;
        const testName = file.tables.testNames[file.testInfo.testNameIds[testId]!]!;

        for (const statusId of failStatusIds) {
            const group = testGroup[statusId] as
                | { messageIds?: (number | null)[]; taskIdIds?: number[][] }
                | null
                | undefined;
            if (!group?.messageIds || !group.taskIdIds) {
                continue;
            }
            group.messageIds.forEach((id, index) => {
                const message =
                    id === null || id === undefined
                        ? NO_FAILURE_MESSAGE
                        : file.tables.messages[id]!;
                counts.set(message, (counts.get(message) ?? 0) + group.taskIdIds![index]!.length);
                const seen = tests.get(message) ?? new Set<string>();
                seen.add(`${dirPath}/${testName}`);
                tests.set(message, seen);
            });
        }
    });
    return { tests, counts };
}

const expected = tally();

test('the fixture exercises this page at all', () => {
    assert.ok(expected.counts.size > 1, 'the fixture must contain several distinct messages');
    assert.ok(expected.counts.has(NO_FAILURE_MESSAGE), 'and the no-message case');
});

test('a row is one failure message, counting its occurrences', () => {
    const { rows } = failureList(buildFailureGroups(decoded, startTime), '', INITIAL_SORT);
    assert.equal(rows.length, expected.counts.size);
    for (const row of rows) {
        assert.equal(row.count, expected.counts.get(row.key), `count of ${row.key}`);
        assert.equal(row.testCount, expected.tests.get(row.key)!.size, `tests of ${row.key}`);
    }
});

test('(no failure message) is a real, rankable row', () => {
    const { rows } = failureList(buildFailureGroups(decoded, startTime), '', INITIAL_SORT);
    const row = rows.find((candidate) => candidate.key === NO_FAILURE_MESSAGE);
    assert.ok(row !== undefined, 'it must appear as a row, not be dropped');
    assert.equal(row.count, expected.counts.get(NO_FAILURE_MESSAGE));
    assert.ok(row.count > 0);
    // And it ranks by the same rule as any other row.
    const above = rows.slice(0, rows.indexOf(row));
    for (const other of above) {
        assert.ok(other.count >= row.count, 'ranking must not special-case it');
    }
});

test('EXPECTED-FAIL, CRASH and TIMEOUT contribute nothing', () => {
    // The universe is `startsWith('FAIL')` and nothing else. Checked against the
    // hand tally, which applies the same rule independently — and against the
    // fixture actually containing the excluded statuses, so this is a real
    // exclusion.
    for (const status of ['EXPECTED-FAIL', 'CRASH', 'TIMEOUT']) {
        assert.ok(file.tables.statuses.includes(status), `fixture must contain ${status}`);
    }
    const { rows } = failureList(buildFailureGroups(decoded, startTime), '', INITIAL_SORT);
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    assert.equal(total, [...expected.counts.values()].reduce((sum, n) => sum + n, 0));
});

test('the page and the CLI agree on every message, count and test count', () => {
    const { rows } = failureList(buildFailureGroups(decoded, startTime), '', INITIAL_SORT);
    const cli = groupFailuresByMessage(decoded);

    // The one representational difference: the CLI keys a missing message as
    // `null`, the page as the display string `(no failure message)`.
    const cliByKey = new Map(
        cli.map((group) => [group.message ?? NO_FAILURE_MESSAGE, group] as const)
    );
    assert.deepEqual(rows.map((row) => row.key).sort(), [...cliByKey.keys()].sort());
    for (const row of rows) {
        const group = cliByKey.get(row.key)!;
        assert.equal(row.count, group.count, `occurrences of ${row.key}`);
        assert.equal(row.testCount, group.testCount, `distinct tests of ${row.key}`);
    }
});

test('the page and the CLI rank identically, as a full sequence', () => {
    // Order parity, whole sequence including ties — both sides sort stably over
    // the same walk order, so a tie resolves the same way. See the equivalent
    // test in `test/crashes-view.test.ts` for why ties are not skipped.
    const { rows } = failureList(buildFailureGroups(decoded, startTime), '', INITIAL_SORT);
    const cli = groupFailuresByMessage(decoded);
    assert.deepEqual(
        rows.map((row) => [row.key, row.count]),
        cli.map((group) => [group.message ?? NO_FAILURE_MESSAGE, group.count])
    );
    assert.ok(rows.length > 1);
});

test('the tooltip noun is the one the page uses', () => {
    assert.equal(FAILURE_NOUN, 'message');
});

// --- the expansion map ----------------------------------------------------

test('the expansion map holds the search-aware subtree of every visible row', () => {
    const groups = buildFailureGroups(decoded, startTime);
    const { rows, expandable } = failureList(groups, '', INITIAL_SORT);
    assert.equal(expandable.size, rows.length);
    for (const row of rows) {
        assert.equal(expandable.get(row.key), row.paths, `${row.key} expands to its own subtree`);
    }
});

test('under a search, a row expands to only what matched', () => {
    // This is the property that makes the failures page's rewritten counts
    // honest: the number on the row is the number of occurrences expanding it
    // reveals. `crashes.html` deliberately does not have it.
    const groups = buildFailureGroups(decoded, startTime);
    const all = rowsOf(groups);
    const spread = all.find((row) => row.testCount > 1 && !row.key.includes('/'));
    assert.ok(spread !== undefined, 'need a message spanning several tests');

    const [firstPath] = [...spread.paths.values()];
    const [firstTest] = [...firstPath!.tests.values()];
    const term = firstTest!.testName.toLowerCase();

    const { rows, expandable } = failureList(groups, term, INITIAL_SORT);
    const row = rows.find((candidate) => candidate.key === spread.key)!;
    const subtree = expandable.get(spread.key)!;

    let visible = 0;
    let tests = 0;
    for (const path of subtree.values()) {
        for (const testNode of path.tests.values()) {
            visible += testNode.totalCount;
            tests++;
        }
    }
    assert.equal(row.count, visible, 'the row counts exactly what it expands to');
    assert.equal(row.testCount, tests);
    assert.ok(visible < spread.count, 'and that is less than the unsearched count');
});

test('a row dropped by the search is not in the expansion map', () => {
    const groups = buildFailureGroups(decoded, startTime);
    const { rows, expandable } = failureList(groups, 'zzzz-no-such-thing', INITIAL_SORT);
    assert.deepEqual(rows, []);
    assert.equal(expandable.size, 0);
});

// --- the Searchfox split --------------------------------------------------

/**
 * `common-links.js`'s own line-number regex, read out of the shared script.
 *
 * Read rather than retyped so that this test compares `site/failures-view.ts`
 * against the *actual* shared behaviour: if `common-links.js` changes its rule,
 * this test starts failing instead of quietly agreeing with a stale copy.
 */
const sharedRegex = (() => {
    const source = readFileSync(new URL('../common-links.js', import.meta.url), 'utf8');
    const match = /message\.match\((\/\^.*?\/)\)/.exec(source);
    assert.ok(match !== null, 'could not find the line-number regex in common-links.js');
    // eslint-disable-next-line no-eval
    return eval(match[1]!) as RegExp;
})();

test('the split follows common-links.js exactly, on every fixture message', () => {
    let linked = 0;
    let plain = 0;
    for (const message of [...file.tables.messages, NO_FAILURE_MESSAGE]) {
        const split = messageLink(message);
        const sharedSaysLink = sharedRegex.test(message);
        assert.equal(
            split !== null,
            sharedSaysLink,
            `disagreement on whether to link ${JSON.stringify(message.slice(0, 60))}`
        );
        if (split === null) {
            plain++;
            continue;
        }
        linked++;
        // The two halves must reassemble the original exactly — a split that
        // loses or duplicates a character would render a corrupted message.
        assert.equal(split.linked + split.rest, message);
        // And the linked half is the bracketed prefix upstream links.
        assert.equal(split.linked, message.slice(0, message.indexOf(']') + 1));
        assert.match(split.linked, /^\[.*\]$/);
    }
    assert.ok(linked > 0, 'the fixture must contain a [file : line] message');
    assert.ok(plain > 0, 'and a plain one');
});

test('a message with no line prefix is left alone', () => {
    assert.equal(messageLink('NS_ERROR_FILE_CORRUPTED: something'), null);
    assert.equal(messageLink(NO_FAILURE_MESSAGE), null);
    assert.equal(messageLink(''), null);
    // A bracket with no line number does not link.
    assert.equal(messageLink('[not a line] text'), null);
});

test('a message with a line prefix splits after the bracket', () => {
    assert.deepEqual(messageLink('[test_foo : 42] 1 == 2'), {
        linked: '[test_foo : 42]',
        rest: ' 1 == 2',
    });
});

// --- the most-failing test ------------------------------------------------

function pathNode(dirPath: string, tests: [string, number][]): PathNode {
    const map = new Map<string, TestNode>();
    let total = 0;
    for (const [testName, count] of tests) {
        map.set(testName, { testName, occurrences: [], totalCount: count });
        total += count;
    }
    return { dirPath, tests: map, totalCount: total };
}

test('the Searchfox link points at the most-failing test of the row', () => {
    const paths = new Map<string, PathNode>([
        ['a/b', pathNode('a/b', [['one.js', 3], ['two.js', 9]])],
        ['c/d', pathNode('c/d', [['three.js', 5]])],
    ]);
    assert.equal(mostFrequentTestPath(paths), 'a/b/two.js');
});

test('a tie goes to the first test the walk found', () => {
    // Upstream compares with a strict `>` (`old/failures.html:663`), so the first
    // of equal counts wins. Reproduced.
    const paths = new Map<string, PathNode>([
        ['a', pathNode('a', [['first.js', 4], ['second.js', 4]])],
    ]);
    assert.equal(mostFrequentTestPath(paths), 'a/first.js');
});

test('a row with no tests has no link target', () => {
    assert.equal(mostFrequentTestPath(new Map()), null);
});

test('every real row has a link target', () => {
    const { rows } = failureList(buildFailureGroups(decoded, startTime), '', INITIAL_SORT);
    for (const row of rows) {
        const target = mostFrequentTestPath(row.paths);
        assert.ok(target !== null, `${row.key} has no test to link to`);
        assert.match(target, /\S/);
    }
});

// --- the bug button -------------------------------------------------------

test('the bug button needs a Product :: Component', () => {
    assert.equal(hasBugButton('Core :: Networking'), true);
    assert.equal(hasBugButton('Toolkit :: Add-ons Manager'), true);
    // Anything that cannot be split into the two Bugzilla fields.
    assert.equal(hasBugButton('Core'), false);
    assert.equal(hasBugButton(''), false);
    assert.equal(hasBugButton(null), false);
    assert.equal(hasBugButton(undefined), false);
    // The separator is exactly ' :: ', spaces included — `getBugzillaUrl`
    // splits on that string (`common-links.js:132`).
    assert.equal(hasBugButton('Core::Networking'), false);
});

test('the components in the fixture are the ones that get a button', () => {
    // Driven from real data rather than from literals: whatever components the
    // fixture records, the guard must agree with a plain `includes(' :: ')` over
    // them, and at least one must qualify or the button is never tested.
    const components = (file.tables.components ?? []) as string[];
    assert.ok(components.length > 0, 'the fixture must record components');
    let qualifying = 0;
    for (const component of components) {
        assert.equal(hasBugButton(component), component.includes(' :: '), component);
        if (hasBugButton(component)) {
            qualifying++;
        }
    }
    assert.ok(qualifying > 0, 'at least one component must produce a button');
});

test('a test node carries the component only when the page asked for it', () => {
    // `crashes.html` never reads one, so `buildCrashGroups` does not pay for it.
    //
    // Both halves are asserted. An earlier version of this test checked only
    // the failures side, so the "only" in its name was unbacked: turning
    // `withComponent` on for crashes changed nothing it could see.
    const countComponents = (groups: Map<string, { paths: Map<string, PathNode> }>): number => {
        let seen = 0;
        for (const group of groups.values()) {
            for (const path of group.paths.values()) {
                for (const testNode of path.tests.values()) {
                    if (testNode.component !== undefined && testNode.component !== null) {
                        seen++;
                    }
                }
            }
        }
        return seen;
    };

    assert.ok(
        countComponents(buildFailureGroups(decoded, startTime)) > 0,
        'the failures page must see components'
    );
    assert.equal(
        countComponents(buildCrashGroups(decoded, startTime)),
        0,
        'the crashes page reads no component, so building one is work nothing consumes'
    );
});
