/**
 * The drill-down view model shared by `crashes.html` and `failures.html`,
 * against real pinned fixtures.
 *
 * ## Why this imports from `next/`
 *
 * `next/drilldown-view.ts` is **page-local**: it names `path-row`,
 * `single-occurrence`, the `📊` totals row and the collapse rule, so it is the
 * pages', not `lib/`'s. A node test importing it is the point — the seam is the
 * module boundary, not the directory.
 *
 * The import also enforces the DOM-free rule for free. The root tsconfig
 * compiles `test/**` and has **no DOM lib**, so a `document` reach from the view
 * model is a compile error here even though `tsconfig.next.json` would accept
 * it.
 *
 * ## Where the expected values come from
 *
 * This project has shipped four tests whose expected value came from the thing
 * under test; one of them shipped a visibly wrong digit and two pinned bugs as
 * correct. So the rule here is absolute: **every literal below was derived from
 * the fixture by a path that does not call `next/drilldown-view.ts`.**
 *
 * The independent path is `walkFixture()` at the top of this file, which reads
 * the raw JSON the way `crashes.html:225-374` does — by hand, branching on the
 * status-group shape — and is deliberately *not* built on
 * `lib/formats/status-entries.ts` either, since that is what the code under test
 * uses. Two independent readings of the same bytes agreeing is evidence; one
 * reading agreeing with itself is not.
 *
 * The fixtures are `test/fixtures/xpcshell-issues-with-taskids.json` (the 21-day
 * aggregate, `task-ids` shape, 10 tests) and
 * `test/fixtures/xpcshell-2026-08-03.json` (one day, `flat` shape, 11 tests),
 * both cut from the same real snapshot by `tools/make-fixtures.ts`.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeDaily } from '../lib/formats/daily.ts';
import type { DailyFile } from '../lib/formats/daily.ts';
import { decodeIssuesWithTaskIds } from '../lib/formats/issues.ts';
import type { IssuesWithTaskIdsFile } from '../lib/formats/issues.ts';
import {
    type GroupRow,
    type PathNode,
    type SortState,
    type TestNode,
    HISTORICAL_DATE,
    INITIAL_SORT,
    NO_FAILURE_MESSAGE,
    buildGroups,
    crashExtractor,
    expandGroup,
    expandPath,
    failureExtractor,
    filterGroupsByMatch,
    isHistoricalDate,
    nextSort,
    occurrenceRows,
    occurrenceTooltip,
    readUrlState,
    rewriteGroupsBySearch,
    rowsOf,
    sortRows,
    totalsOf,
} from '../next/drilldown-view.ts';

const AGGREGATE = 'test/fixtures/xpcshell-issues-with-taskids.json';
const DAILY = 'test/fixtures/xpcshell-2026-08-03.json';

function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')) as T;
}

const aggregateFile = readJson<IssuesWithTaskIdsFile>(AGGREGATE);
const dailyFile = readJson<DailyFile>(DAILY);

// --- the independent reading ----------------------------------------------

interface RawTally {
    /** key -> dirPath -> testName -> occurrence count. */
    tree: Map<string, Map<string, Map<string, number>>>;
    /** key -> total occurrences. */
    totals: Map<string, number>;
    /** key -> the set of `dirPath/testName` it was seen in. */
    tests: Map<string, Set<string>>;
    /** key -> every `YYYY-MM-DD` its occurrences fell on, in walk order. */
    dates: Map<string, string[]>;
}

/**
 * Reads a raw timing file the way the *old pages* do, by hand.
 *
 * Deliberately duplicated rather than shared with the code under test. It
 * branches on `taskIdIds && days` exactly as `crashes.html:254` does, decodes
 * the day deltas itself, and expands a bucket into one row per task ID. If this
 * and `buildGroups` agree, two independent readings of the same bytes agree.
 */
function walkFixture(
    raw: {
        metadata: { startTime: number };
        tables: {
            statuses: string[];
            messages: string[];
            crashSignatures: string[];
            testPaths: string[];
            testNames: string[];
        };
        testInfo: { testPathIds: number[]; testNameIds: number[] };
        testRuns: (Record<string, unknown> | null)[][];
    },
    kind: 'crash' | 'failure'
): RawTally {
    const tree = new Map<string, Map<string, Map<string, number>>>();
    const totals = new Map<string, number>();
    const tests = new Map<string, Set<string>>();
    const dates = new Map<string, string[]>();

    raw.testRuns.forEach((testGroup, testId) => {
        if (!testGroup) {
            return;
        }
        const dirPath = raw.tables.testPaths[raw.testInfo.testPathIds[testId]!]!;
        const testName = raw.tables.testNames[raw.testInfo.testNameIds[testId]!]!;

        testGroup.forEach((statusGroup, statusId) => {
            if (!statusGroup) {
                return;
            }
            const status = raw.tables.statuses[statusId]!;
            if (kind === 'crash' ? status !== 'CRASH' : !status.startsWith('FAIL')) {
                return;
            }
            const ids = (
                kind === 'crash' ? statusGroup['crashSignatureIds'] : statusGroup['messageIds']
            ) as (number | null)[] | undefined;
            if (ids === undefined) {
                return;
            }

            const taskIdIds = statusGroup['taskIdIds'] as number[] | number[][] | undefined;
            const days = statusGroup['days'] as number[] | undefined;
            const timestamps = statusGroup['timestamps'] as number[] | undefined;
            const bucketed = taskIdIds !== undefined && days !== undefined;

            // Day/timestamp decoding, open-coded as the pages do it.
            const when: number[] = [];
            if (bucketed) {
                let cumulative = 0;
                for (const delta of days) {
                    cumulative += delta;
                    when.push(raw.metadata.startTime + cumulative * 86400);
                }
            } else if (timestamps !== undefined) {
                let cumulative = 0;
                for (const delta of timestamps) {
                    cumulative += delta;
                    when.push(raw.metadata.startTime + cumulative);
                }
            }

            ids.forEach((id, index) => {
                let key: string;
                if (kind === 'crash') {
                    if (id === null) {
                        return;
                    }
                    const signature = raw.tables.crashSignatures[id];
                    if (!signature) {
                        return;
                    }
                    key = signature;
                } else {
                    key =
                        id === null || id === undefined
                            ? NO_FAILURE_MESSAGE
                            : raw.tables.messages[id]!;
                }

                const count = bucketed ? (taskIdIds as number[][])[index]!.length : 1;
                const date = new Date(when[index]! * 1000).toISOString().split('T')[0]!;

                totals.set(key, (totals.get(key) ?? 0) + count);
                for (let i = 0; i < count; i++) {
                    const list = dates.get(key) ?? [];
                    list.push(date);
                    dates.set(key, list);
                }

                let byPath = tree.get(key);
                if (byPath === undefined) {
                    byPath = new Map();
                    tree.set(key, byPath);
                }
                let byTest = byPath.get(dirPath);
                if (byTest === undefined) {
                    byTest = new Map();
                    byPath.set(dirPath, byTest);
                }
                byTest.set(testName, (byTest.get(testName) ?? 0) + count);

                const seen = tests.get(key) ?? new Set<string>();
                seen.add(`${dirPath}/${testName}`);
                tests.set(key, seen);
            });
        });
    });

    return { tree, totals, tests, dates };
}

const aggregateCrashes = walkFixture(aggregateFile as never, 'crash');
const aggregateFailures = walkFixture(aggregateFile as never, 'failure');
const dailyCrashes = walkFixture(dailyFile as never, 'crash');

const decodedAggregate = decodeIssuesWithTaskIds(aggregateFile);
const decodedDaily = decodeDaily(dailyFile);
const aggregateStart = aggregateFile.metadata.startTime;
const dailyStart = dailyFile.metadata.startTime;

// --- buildGroups ----------------------------------------------------------

test('buildGroups reproduces the hand-decoded crash tree', () => {
    const groups = buildGroups(decodedAggregate, aggregateStart, crashExtractor);

    assert.equal(groups.size, aggregateCrashes.totals.size);
    assert.ok(groups.size > 0, 'the fixture must contain crashes for this to test anything');

    for (const [key, expectedTotal] of aggregateCrashes.totals) {
        const group = groups.get(key);
        assert.ok(group !== undefined, `missing group ${key}`);
        assert.equal(group.totalCount, expectedTotal, `total for ${key}`);

        const expectedPaths = aggregateCrashes.tree.get(key)!;
        assert.deepEqual(
            [...group.paths.keys()].sort(),
            [...expectedPaths.keys()].sort(),
            `paths of ${key}`
        );
        for (const [dirPath, expectedTests] of expectedPaths) {
            const pathNode: PathNode = group.paths.get(dirPath)!;
            assert.deepEqual(
                [...pathNode.tests.keys()].sort(),
                [...expectedTests.keys()].sort(),
                `tests of ${key} / ${dirPath}`
            );
            let pathTotal = 0;
            for (const [testName, expectedCount] of expectedTests) {
                assert.equal(
                    pathNode.tests.get(testName)!.totalCount,
                    expectedCount,
                    `count of ${key} / ${dirPath} / ${testName}`
                );
                pathTotal += expectedCount;
            }
            assert.equal(pathNode.totalCount, pathTotal, `path total of ${key} / ${dirPath}`);
        }
    }
});

test('buildGroups reproduces the hand-decoded failure tree', () => {
    const groups = buildGroups(decodedAggregate, aggregateStart, failureExtractor, {
        withComponent: true,
    });

    assert.equal(groups.size, aggregateFailures.totals.size);
    for (const [key, expectedTotal] of aggregateFailures.totals) {
        assert.equal(groups.get(key)?.totalCount, expectedTotal, `total for ${key}`);
    }
});

test('buildGroups reads the flat daily shape as well as the bucketed one', () => {
    // The two families use different status-group shapes — `flat` against
    // `task-ids` — and the old pages have two hand-written branches for them.
    // Both must produce the same tree from their own file.
    const groups = buildGroups(decodedDaily, dailyStart, crashExtractor);
    assert.equal(groups.size, dailyCrashes.totals.size);
    assert.ok(groups.size > 0, 'the daily fixture must contain crashes');
    for (const [key, expectedTotal] of dailyCrashes.totals) {
        assert.equal(groups.get(key)?.totalCount, expectedTotal, `daily total for ${key}`);
    }
});

test('an occurrence carries the date the hand-decoder computed', () => {
    const groups = buildGroups(decodedAggregate, aggregateStart, crashExtractor);
    for (const [key, expectedDates] of aggregateCrashes.dates) {
        const actual: string[] = [];
        for (const path of groups.get(key)!.paths.values()) {
            for (const testNode of path.tests.values()) {
                for (const occurrence of testNode.occurrences) {
                    actual.push(occurrence.date);
                }
            }
        }
        // Order differs — the hand-decoder walks status groups, the code walks
        // tests — so compare as multisets.
        assert.deepEqual(actual.sort(), [...expectedDates].sort(), `dates of ${key}`);
    }
});

test('the daily file yields real per-run timestamps, not the window start', () => {
    // The flat shape carries its own delta-encoded timestamps, and using the
    // caller-supplied `startTime` for them instead would give every occurrence
    // the same date. This asserts the entry's timestamp wins.
    const groups = buildGroups(decodedDaily, dailyStart, crashExtractor);
    const dates = new Set<string>();
    for (const group of groups.values()) {
        for (const path of group.paths.values()) {
            for (const testNode of path.tests.values()) {
                for (const occurrence of testNode.occurrences) {
                    dates.add(occurrence.date);
                }
            }
        }
    }
    assert.deepEqual([...dates], [dailyFile.metadata.date], 'a daily file covers exactly one day');
});

test('an occurrence carries a resolvable task and job', () => {
    const groups = buildGroups(decodedAggregate, aggregateStart, crashExtractor);
    const known = new Set(aggregateFile.tables.taskIds);
    const knownJobs = new Set(aggregateFile.tables.jobNames);
    let checked = 0;
    for (const group of groups.values()) {
        for (const path of group.paths.values()) {
            for (const testNode of path.tests.values()) {
                for (const occurrence of testNode.occurrences) {
                    assert.ok(
                        known.has(`${occurrence.taskId}.${occurrence.retryId}`),
                        `task ${occurrence.taskId}.${occurrence.retryId} is not in tables.taskIds`
                    );
                    assert.ok(knownJobs.has(occurrence.jobName), `job ${occurrence.jobName}`);
                    checked++;
                }
            }
        }
    }
    assert.ok(checked > 0, 'the fixture must have attributable occurrences');
});

// --- the extractors -------------------------------------------------------

test('the crash extractor takes CRASH only, and drops a null signature', () => {
    assert.equal(crashExtractor.keyOf({ status: 'CRASH', crashSignature: '@ foo' } as never), '@ foo');
    assert.equal(crashExtractor.keyOf({ status: 'CRASH', crashSignature: null } as never), null);
    assert.equal(crashExtractor.keyOf({ status: 'CRASH' } as never), null);
    // Not a crash: every other status the fixture actually contains.
    for (const status of aggregateFile.tables.statuses) {
        if (status === 'CRASH') {
            continue;
        }
        assert.equal(
            crashExtractor.keyOf({ status, crashSignature: '@ foo' } as never),
            null,
            `${status} must not be a crash`
        );
    }
});

test('the failure extractor takes every FAIL* status and names a missing message', () => {
    const failing = aggregateFile.tables.statuses.filter((s) => s.startsWith('FAIL'));
    assert.ok(failing.length >= 2, 'the fixture must have more than one FAIL status');
    for (const status of failing) {
        assert.equal(failureExtractor.keyOf({ status, message: 'boom' } as never), 'boom');
        assert.equal(
            failureExtractor.keyOf({ status, message: null } as never),
            NO_FAILURE_MESSAGE
        );
        assert.equal(failureExtractor.keyOf({ status } as never), NO_FAILURE_MESSAGE);
    }
    // EXPECTED-FAIL does not start with FAIL and is excluded. The fixture has
    // it, so this is a real exclusion rather than a hypothetical one.
    assert.ok(aggregateFile.tables.statuses.includes('EXPECTED-FAIL'));
    assert.equal(failureExtractor.keyOf({ status: 'EXPECTED-FAIL', message: 'x' } as never), null);
    assert.equal(failureExtractor.keyOf({ status: 'CRASH' } as never), null);
    assert.equal(failureExtractor.keyOf({ status: 'TIMEOUT' } as never), null);
});

test('the no-message row is real and rankable in the fixture', () => {
    const groups = buildGroups(decodedAggregate, aggregateStart, failureExtractor);
    const group = groups.get(NO_FAILURE_MESSAGE);
    assert.ok(group !== undefined, 'the fixture must exercise the no-message case');
    assert.equal(group.totalCount, aggregateFailures.totals.get(NO_FAILURE_MESSAGE));
    assert.ok(group.totalCount > 0);
});

// --- rows, sorting, totals ------------------------------------------------

test('testCount is the distinct test count, not a double count', () => {
    // The loop under test sums `tests.size` across paths, which is the shape of
    // a double count. It is not one, because a `(path, name)` pair belongs to
    // exactly one test ID — asserted here on the fixture, and separately
    // measured on the full 4,838-test file.
    const pairs = new Set(
        aggregateFile.testInfo.testPathIds.map(
            (pathId, i) =>
                `${aggregateFile.tables.testPaths[pathId]} ${
                    aggregateFile.tables.testNames[aggregateFile.testInfo.testNameIds[i]!]
                }`
        )
    );
    assert.equal(pairs.size, aggregateFile.testInfo.testPathIds.length, 'pairs must be unique');

    const rows = rowsOf(buildGroups(decodedAggregate, aggregateStart, crashExtractor));
    for (const row of rows) {
        assert.equal(
            row.testCount,
            aggregateCrashes.tests.get(row.key)!.size,
            `testCount of ${row.key}`
        );
    }
});

test('the total row sums the rows, and overcounts tests on purpose', () => {
    const rows = rowsOf(buildGroups(decodedAggregate, aggregateStart, failureExtractor));
    const totals = totalsOf(rows);

    assert.equal(
        totals.count,
        [...aggregateFailures.totals.values()].reduce((sum, n) => sum + n, 0)
    );
    assert.equal(
        totals.tests,
        [...aggregateFailures.tests.values()].reduce((sum, set) => sum + set.size, 0)
    );

    // And it is genuinely larger than the distinct count, so the divergence
    // entry describing it is not describing a hypothetical.
    const distinct = new Set<string>();
    for (const set of aggregateFailures.tests.values()) {
        for (const testPath of set) {
            distinct.add(testPath);
        }
    }
    assert.ok(
        totals.tests > distinct.size,
        `expected the total (${totals.tests}) to exceed the distinct count (${distinct.size})`
    );
});

test('the initial sort is most occurrences first', () => {
    assert.deepEqual(INITIAL_SORT, { column: 'count', ascending: false });
    const rows = sortRows(
        rowsOf(buildGroups(decodedAggregate, aggregateStart, crashExtractor)),
        INITIAL_SORT
    );
    const counts = rows.map((row) => row.count);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
});

test('sorting by tests ranks on testCount, in both directions', () => {
    const rows = rowsOf(buildGroups(decodedAggregate, aggregateStart, failureExtractor));
    const descending = sortRows(rows, { column: 'tests', ascending: false }).map((r) => r.testCount);
    const ascending = sortRows(rows, { column: 'tests', ascending: true }).map((r) => r.testCount);
    assert.deepEqual(descending, [...descending].sort((a, b) => b - a));
    assert.deepEqual(ascending, [...ascending].sort((a, b) => a - b));
});

test('the two columns really do produce different orders', () => {
    // Added because a mutation survived: making the `tests` column sort on
    // `count` anyway passed every other test here, since a monotone-in-both
    // fixture makes the two orders identical. Asserting the *sequence of keys*
    // differs is what kills it — and it is a property of real data rather than
    // of the comparator, so it is checked on both extractors.
    for (const [name, extractor] of [
        ['crashes', crashExtractor],
        ['failures', failureExtractor],
    ] as const) {
        const rows = rowsOf(buildGroups(decodedAggregate, aggregateStart, extractor));
        const byCount = sortRows(rows, { column: 'count', ascending: false }).map((r) => r.key);
        const byTests = sortRows(rows, { column: 'tests', ascending: false }).map((r) => r.key);
        assert.notDeepEqual(
            byTests,
            byCount,
            `${name}: the Tests column must not reproduce the count order`
        );
    }
});

test('sorting is stable, so ties keep walk order', () => {
    const rows = rowsOf(buildGroups(decodedAggregate, aggregateStart, failureExtractor));
    // Every row with the same count must keep its relative input order.
    const sorted = sortRows(rows, { column: 'count', ascending: false });
    const byCount = new Map<number, string[]>();
    for (const row of rows) {
        byCount.set(row.count, [...(byCount.get(row.count) ?? []), row.key]);
    }
    const sortedByCount = new Map<number, string[]>();
    for (const row of sorted) {
        sortedByCount.set(row.count, [...(sortedByCount.get(row.count) ?? []), row.key]);
    }
    for (const [count, keys] of byCount) {
        assert.deepEqual(sortedByCount.get(count), keys, `tie order for count ${count}`);
    }
});

test('clicking a column flips it, and a new column starts descending', () => {
    const start: SortState = { column: 'count', ascending: false };
    assert.deepEqual(nextSort(start, 'count'), { column: 'count', ascending: true });
    assert.deepEqual(nextSort({ column: 'count', ascending: true }, 'count'), {
        column: 'count',
        ascending: false,
    });
    assert.deepEqual(nextSort(start, 'tests'), { column: 'tests', ascending: false });
    assert.deepEqual(nextSort({ column: 'tests', ascending: true }, 'count'), {
        column: 'count',
        ascending: false,
    });
});

// --- the two searches -----------------------------------------------------

/** A directory path and a test name that really are in the fixture. */
const somePath = aggregateFile.tables.testPaths[0]!;
const someTestName = aggregateFile.tables.testNames[0]!;

test('the crashes search keeps whole rows and never changes a number', () => {
    const rows = rowsOf(buildGroups(decodedAggregate, aggregateStart, crashExtractor));
    const term = somePath.slice(0, 8).toLowerCase();
    const filtered = filterGroupsByMatch(rows, term);

    assert.ok(filtered.length > 0, `nothing matched ${term}`);
    assert.ok(filtered.length <= rows.length);
    for (const row of filtered) {
        const original = rows.find((r) => r.key === row.key)!;
        assert.equal(row.count, original.count, `${row.key} kept its count`);
        assert.equal(row.testCount, original.testCount, `${row.key} kept its testCount`);
        assert.equal(row.paths, original.paths, `${row.key} kept its whole subtree`);
    }
});

test('the crashes search still changes the total, because it drops rows', () => {
    const rows = rowsOf(buildGroups(decodedAggregate, aggregateStart, failureExtractor));
    const before = totalsOf(rows);
    // A term that matches some rows but not all.
    const term = someTestName.slice(0, 10).toLowerCase();
    const after = totalsOf(filterGroupsByMatch(rows, term));
    assert.ok(after.count < before.count, 'the total must narrow under a search');
});

test('an empty search term is the identity', () => {
    const rows = rowsOf(buildGroups(decodedAggregate, aggregateStart, crashExtractor));
    assert.equal(filterGroupsByMatch(rows, ''), rows);
    assert.equal(rewriteGroupsBySearch(rows, ''), rows);
});

test('a search that matches nothing yields no rows on either page', () => {
    const rows = rowsOf(buildGroups(decodedAggregate, aggregateStart, failureExtractor));
    const nonsense = 'zzzz-no-such-thing-zzzz';
    assert.deepEqual(filterGroupsByMatch(rows, nonsense), []);
    assert.deepEqual(rewriteGroupsBySearch(rows, nonsense), []);
    assert.deepEqual(totalsOf([]), { tests: 0, count: 0 });
});

test('the failures search rewrites the counts on a row that did not match by message', () => {
    const rows = rowsOf(buildGroups(decodedAggregate, aggregateStart, failureExtractor));
    // Pick a row spanning more than one test, and search for exactly one of its
    // test names — so the rewrite has something to remove.
    const spread = rows.find((row) => row.testCount > 1 && !row.key.includes('/'));
    assert.ok(spread !== undefined, 'need a row spanning several tests');

    const [firstPath] = [...spread.paths.values()];
    const [firstTest] = [...firstPath!.tests.values()];
    const term = firstTest!.testName.toLowerCase();

    const rewritten = rewriteGroupsBySearch(rows, term).find((row) => row.key === spread.key);
    assert.ok(rewritten !== undefined, 'the row must survive a search for one of its tests');
    assert.ok(
        rewritten.count < spread.count,
        `expected the count to shrink from ${spread.count}, got ${rewritten.count}`
    );
    assert.ok(rewritten.testCount < spread.testCount);
    // And the count it shows is the count of what expanding it reveals.
    let visible = 0;
    for (const path of rewritten.paths.values()) {
        for (const testNode of path.tests.values()) {
            visible += testNode.totalCount;
        }
    }
    assert.equal(rewritten.count, visible, 'the row must count exactly what it expands to');
});

test('a matching path keeps every test under it, matching name or not', () => {
    // The asymmetry inside `rewriteGroupsBySearch`'s second branch, which is
    // upstream's (`failures.html:569`: `if (pathMatches || testMatches)`). A
    // mutation dropping the `pathMatches ||` survived every other search test
    // here, because they all searched for a *test name*; this one searches for a
    // directory.
    const rows = rowsOf(buildGroups(decodedAggregate, aggregateStart, failureExtractor));
    const term = 'toolkit/components/extensions/test/xpcshell';
    assert.ok(
        aggregateFile.tables.testPaths.includes(term),
        'the term must be a real directory in the fixture'
    );

    let checked = 0;
    for (const row of rewriteGroupsBySearch(rows, term)) {
        const original = rows.find((candidate) => candidate.key === row.key)!;
        if (original.key.toLowerCase().includes(term)) {
            continue;
        }
        const path = row.paths.get(term);
        if (path === undefined) {
            continue;
        }
        const before = original.paths.get(term)!;
        // Every test under the matching path survives, including the ones whose
        // own names contain nothing like the term.
        assert.deepEqual([...path.tests.keys()], [...before.tests.keys()], `tests under ${term}`);
        const nonMatching = [...before.tests.keys()].filter(
            (name) => !name.toLowerCase().includes(term)
        );
        if (nonMatching.length > 0) {
            checked++;
        }
    }
    assert.ok(checked > 0, 'no row had a test whose name did not also match the path');
});

test('a row whose message matches passes through the failures search untouched', () => {
    const rows = rowsOf(buildGroups(decodedAggregate, aggregateStart, failureExtractor));
    const target = rows.find((row) => row.key.length > 12 && row.key !== NO_FAILURE_MESSAGE)!;
    const term = target.key.slice(0, 12).toLowerCase();
    const rewritten = rewriteGroupsBySearch(rows, term).find((row) => row.key === target.key)!;
    assert.equal(rewritten.count, target.count);
    assert.equal(rewritten.paths, target.paths, 'the subtree is the same object, not a copy');
});

test('the two searches genuinely differ on the same input', () => {
    // The reason they are two functions and not one with a flag: given a term
    // that matches a test name rather than a key, they produce different
    // numbers for the same surviving row.
    const rows = rowsOf(buildGroups(decodedAggregate, aggregateStart, failureExtractor));
    const spread = rows.find((row) => row.testCount > 1 && !row.key.includes('/'))!;
    const [firstPath] = [...spread.paths.values()];
    const [firstTest] = [...firstPath!.tests.values()];
    const term = firstTest!.testName.toLowerCase();

    const kept = filterGroupsByMatch(rows, term).find((r) => r.key === spread.key)!;
    const rewritten = rewriteGroupsBySearch(rows, term).find((r) => r.key === spread.key)!;
    assert.equal(kept.count, spread.count, 'crashes-style keeps the full count');
    assert.notEqual(rewritten.count, kept.count, 'failures-style does not');
});

// --- the expanded subtree -------------------------------------------------

test('a path with one test collapses; a path with several does not', () => {
    const groups = buildGroups(decodedAggregate, aggregateStart, failureExtractor);
    let sawCollapsed = false;
    let sawPathRow = false;

    for (const group of groups.values()) {
        const rows = expandGroup(group.paths);
        assert.equal(rows.length, group.paths.size, 'one row per path either way');

        for (const row of rows) {
            const pathNode: PathNode = group.paths.get(row.dirPath)!;
            if (pathNode.tests.size === 1) {
                assert.notEqual(row.kind, 'path', `${row.dirPath} should have collapsed`);
                // Narrowed rather than asserted through: `direct` exists on the
                // two test-row variants and not on a path row, and letting tsc
                // check that is the point of the discriminated union.
                assert.ok(row.kind !== 'path');
                assert.equal(row.direct, true, 'a collapsed path yields a direct child');
                sawCollapsed = true;
            } else {
                assert.equal(row.kind, 'path', `${row.dirPath} should have stayed a path row`);
                sawPathRow = true;
            }
        }
    }
    assert.ok(sawCollapsed, 'the fixture must exercise the collapse');
    assert.ok(sawPathRow, 'the fixture must exercise the non-collapsed case');
});

test('paths and tests are ranked by occurrence count, descending', () => {
    // Both extractors, because the fixture's multi-path groups are crashes: a
    // mutation reversing the *path* ranking survived a failures-only version of
    // this test, since all 25 failure groups have exactly one path and a
    // one-element sequence is sorted either way. `ranked` below counts the
    // groups that actually constrain the order, and the test asserts there is at
    // least one — otherwise it is asserting nothing.
    let ranked = 0;
    for (const extractor of [crashExtractor, failureExtractor]) {
        const groups = buildGroups(decodedAggregate, aggregateStart, extractor);
        for (const group of groups.values()) {
            const counts = expandGroup(group.paths).map((row) =>
                row.kind === 'path' ? row.count : row.test.totalCount
            );
            // A collapsed row carries its single test's count, which equals the
            // path's, so the whole sequence is the path counts in order.
            assert.deepEqual(counts, [...counts].sort((a, b) => b - a), `paths of ${group.key}`);
            if (new Set(counts).size > 1) {
                ranked++;
            }

            for (const path of group.paths.values()) {
                const testCounts = expandPath(path).map((row) =>
                    row.kind === 'path' ? row.count : row.test.totalCount
                );
                assert.deepEqual(testCounts, [...testCounts].sort((a, b) => b - a));
            }
        }
    }
    assert.ok(ranked > 0, 'no group had two paths with different counts, so nothing was ranked');
});

test('a test with exactly one occurrence is rendered inline', () => {
    const groups = buildGroups(decodedAggregate, aggregateStart, failureExtractor);
    let sawSingle = false;
    let sawExpandable = false;
    for (const group of groups.values()) {
        for (const path of group.paths.values()) {
            for (const row of expandPath(path)) {
                if (row.kind === 'path') {
                    continue;
                }
                const expected =
                    row.test.totalCount === 1 && row.test.occurrences.length > 0
                        ? 'single'
                        : 'test';
                assert.equal(row.kind, expected, `${row.test.testName}`);
                if (row.kind === 'single') {
                    assert.equal(row.occurrence, row.test.occurrences[0]);
                    sawSingle = true;
                } else {
                    sawExpandable = true;
                }
            }
        }
    }
    assert.ok(sawSingle, 'the fixture must exercise the inline single occurrence');
    assert.ok(sawExpandable, 'the fixture must exercise the expandable case');
});

test('a count of 1 with no occurrence in hand is not rendered inline', () => {
    // The second half of the guard, which only matters on a file with no task
    // attribution. Built by hand because the fixtures all have `taskInfo`.
    const test1: TestNode = { testName: 'a.js', occurrences: [], totalCount: 1 };
    const path: PathNode = {
        dirPath: 'd',
        tests: new Map([['a.js', test1]]),
        totalCount: 1,
    };
    const [row] = expandPath(path);
    assert.equal(row!.kind, 'test', 'no occurrence means no inline row');
});

test('occurrences are newest first, with the date shown once per day', () => {
    const groups = buildGroups(decodedAggregate, aggregateStart, failureExtractor);
    let checked = 0;
    for (const group of groups.values()) {
        for (const path of group.paths.values()) {
            for (const testNode of path.tests.values()) {
                if (testNode.occurrences.length < 2) {
                    continue;
                }
                const rows = occurrenceRows(testNode);
                assert.equal(rows.length, testNode.occurrences.length);

                const dates = rows.map((row) => row.occurrence.date);
                assert.deepEqual(dates, [...dates].sort((a, b) => b.localeCompare(a)));

                // `showDate` is true exactly on the first row of each date.
                let previous: string | null = null;
                for (const row of rows) {
                    assert.equal(
                        row.showDate,
                        row.occurrence.date !== previous,
                        `showDate for ${row.occurrence.date}`
                    );
                    previous = row.occurrence.date;
                }
                checked++;
            }
        }
    }
    assert.ok(checked > 0, 'the fixture must have a test with several occurrences');
});

test('occurrenceRows does not mutate the test it reads', () => {
    // The shared `prepareRunsForDisplay` sorts in place and stamps `dateHtml`
    // onto every run. Reimplementing it was partly to stop that.
    //
    // The test node has to be one whose walk order actually DIFFERS from
    // newest-first, or an in-place sort is unobservable — an earlier version
    // took the first test in the fixture, which has one occurrence, and a
    // mutation replacing the defensive copy with an in-place sort survived it.
    // 19 of the fixture's tests qualify.
    const groups = buildGroups(decodedAggregate, aggregateStart, failureExtractor);
    let checked = 0;
    for (const group of groups.values()) {
        for (const path of group.paths.values()) {
            for (const testNode of path.tests.values()) {
                const before = testNode.occurrences.map((occurrence) => occurrence.date);
                const newestFirst = [...before].sort((a, b) => b.localeCompare(a));
                if (JSON.stringify(before) === JSON.stringify(newestFirst)) {
                    continue;
                }
                const rows = occurrenceRows(testNode);
                assert.deepEqual(
                    testNode.occurrences.map((occurrence) => occurrence.date),
                    before,
                    `${testNode.testName}: the walk order must survive`
                );
                // And the returned rows really are re-ordered, so the copy is
                // not hiding a sort that never happened.
                assert.deepEqual(rows.map((row) => row.occurrence.date), newestFirst);
                for (const occurrence of testNode.occurrences) {
                    assert.ok(!('dateHtml' in occurrence), 'no markup is stamped onto the model');
                }
                checked++;
            }
        }
    }
    assert.ok(checked > 0, 'no test had an out-of-order walk, so nothing was checked');
});

// --- the tooltip ----------------------------------------------------------

test('the tooltip rounds once, from the raw ratio', () => {
    // The trap this guards is rounding an already-rounded intermediate, which
    // this project shipped once as `14.37%` where the page showed `14.38%`. So
    // the percentage is asserted exactly and the run total only loosely: the
    // separator comes from `toLocaleString()` and is machine-dependent — this
    // machine is fr-FR and produces a narrow no-break space, CI would produce a
    // comma, and pinning either would be a test that fails on the other.
    assert.match(
        occurrenceTooltip(1437, 10000, 'message'),
        /^1437 occurrences of this message out of 10.?000 runs \(14\.37%\)$/
    );
    // One occurrence more, and the second decimal must move — which it only
    // does if the ratio was rounded once, at the end.
    assert.match(
        occurrenceTooltip(1438, 10000, 'message'),
        /^1438 occurrences of this message out of 10.?000 runs \(14\.38%\)$/
    );
    // A repeating ratio, where truncating early and rounding late differ.
    assert.equal(
        occurrenceTooltip(1, 3, 'signature'),
        '1 occurrence of this signature out of 3 runs (33.33%)'
    );
    assert.equal(
        occurrenceTooltip(2, 3, 'signature'),
        '2 occurrences of this signature out of 3 runs (66.67%)'
    );

    // Ratios that are only correct when the raw value is rounded ONCE. Rounding
    // to three decimals first and then to two — the classic double-round —
    // moves the last digit on each of these, and a mutation doing exactly that
    // survived the cases above, which happen to be stable under it. Chosen by
    // enumerating every count/total pair up to 6,000 runs and taking ones where
    // the two disagree.
    assert.match(occurrenceTooltip(11, 13, 'message'), /\(84\.62%\)$/);
    assert.match(occurrenceTooltip(2, 17, 'message'), /\(11\.76%\)$/);
    assert.match(occurrenceTooltip(8, 19, 'message'), /\(42\.11%\)$/);
    assert.match(occurrenceTooltip(11, 19, 'message'), /\(57\.89%\)$/);
});

test('the tooltip is empty when the run total is unknown', () => {
    // Which is every tooltip in single-day mode, because `getTestTotalRuns` is
    // called with a null historical file there.
    assert.equal(occurrenceTooltip(5, 0, 'signature'), '');
    assert.equal(occurrenceTooltip(5, -1, 'signature'), '');
});

test('the tooltip says occurrence or occurrences, and names the page noun', () => {
    assert.match(occurrenceTooltip(1, 10, 'signature'), /^1 occurrence of this signature /);
    assert.match(occurrenceTooltip(2, 10, 'message'), /^2 occurrences of this message /);
});

// --- URL state ------------------------------------------------------------

test('no date, an empty date and 21days all mean the historical view', () => {
    assert.equal(isHistoricalDate(undefined), true);
    assert.equal(isHistoricalDate(''), true);
    assert.equal(isHistoricalDate(HISTORICAL_DATE), true);
    assert.equal(isHistoricalDate('2026-08-03'), false);
});

test('readUrlState reads date and q, and distinguishes absent from empty', () => {
    assert.deepEqual(readUrlState(new URLSearchParams('')), {});
    assert.deepEqual(readUrlState(new URLSearchParams('date=21days&q=netwerk')), {
        date: '21days',
        q: 'netwerk',
    });
    // An empty `q` is present-and-empty, which is what clears the box.
    assert.deepEqual(readUrlState(new URLSearchParams('q=')), { q: '' });
    // Anything else in the hash is ignored.
    assert.deepEqual(readUrlState(new URLSearchParams('date=x&other=y')), { date: 'x' });
});

test('a row is a plain value a comparison can assert on', () => {
    // The seam `PARITY.md` §2 asks for: no DOM anywhere in the result.
    const rows: GroupRow[] = sortRows(
        rowsOf(buildGroups(decodedAggregate, aggregateStart, crashExtractor)),
        INITIAL_SORT
    );
    for (const row of rows) {
        assert.equal(typeof row.key, 'string');
        assert.equal(typeof row.count, 'number');
        assert.equal(typeof row.testCount, 'number');
    }
});
