/**
 * `fx-tests flaky --group-by tests` — the per-test drill-down, against an
 * independent walk of the fixture.
 *
 * ## Why this view exists at all
 *
 * There was no way to get the list of flaky tests for a folder. The nearest thing
 * was `fx-tests issues --path <folder> --group-by test`, and it answers a
 * different question badly enough to mislead: it ranks by issue *runs*, and skips
 * are runs. Measured on the pinned window for
 * `toolkit/components/telemetry/tests/unit`, it puts
 * `test_UserInteraction_annotations.js` at #1 with 6,879 issues of which **6,782
 * are skips**, while this classification calls that test skipped and not flaky.
 * The folder ranking's footer used to *point there*. So the thing being defended
 * here is not "the numbers are right" but "a skipped test cannot top a flakiness
 * listing", and that is asserted directly.
 *
 * ## Where the goldens come from
 *
 * Not from the code under test, and not from `test/flaky-command.test.ts`'s walk
 * either. `independentTestDays()` below re-decodes the fixture's delta-encoded day
 * arrays, matches statuses by regular expression rather than through
 * `classifyStatus`, applies the three-state precedence with its own `if` chain,
 * and — the part that matters for this view — counts **days per test** as integers
 * and never divides. That last difference is deliberate: the implementation
 * divides by the window in `flakinessByFolderAveraged` and multiplies back in
 * `days()`, and a walk that did the same round trip could not catch it going
 * wrong. This one never leaves integers.
 *
 * ## What these are defending
 *
 * 1. **Flaky-first ranking**, so the `issues` failure mode cannot recur.
 * 2. **Whole days, not means.** A test's mean can only be 0, 1/7 … 1, so printed
 *    as means every worst row reads `1`; the columns are counts of days.
 * 3. **Clean tests are hidden and counted.** `rowCount + cleanTests` must be
 *    every test that ran, or the listing is silently shorter than the folder row
 *    above it.
 * 4. **The subtree is the default**, and `--here-only` really is narrower.
 * 5. **The same classification as the folder ranking**, so a reader who ranks
 *    folders and drills in does not cross a definition boundary.
 */

import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { type IssuesFile, decodeIssues } from '../lib/formats/issues.ts';
import {
    DEFAULT_AVERAGE_DAYS,
    flakinessByFolderAveraged,
    folderAt,
    hasSomethingToAct,
    subtreeTests,
} from '../lib/query/flakiness.ts';
import { type DataFileName, type DataSource, DataFileNotFoundError } from '../lib/sources/source.ts';
import { ExitCode } from '../cli/errors.ts';
import { captureStreams } from '../cli/context.ts';
import { diskCache } from '../cli/cache.ts';
import { run } from '../cli/main.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

const issuesFixture = JSON.parse(
    await readFile(new URL('xpcshell-issues.json', FIXTURES), 'utf8')
) as IssuesFile;

// --- the independent walk ------------------------------------------------

/** One test file's day counts over the window, as whole days. */
interface ExpectedTest {
    /** Days it failed at least once. */
    flakyDays: number;
    /** Days it was skipped somewhere, whether or not it also failed. */
    skippedDays: number;
    /** Days it was flaky **and** skipped — the overlap, counted in both above. */
    bothDays: number;
    /** Days it was in any state at all. */
    ranDays: number;
    /** Failing runs across the whole file, before the noise filter. */
    windowFailures: number;
}

/**
 * Every test's day counts, recomputed from the raw fixture.
 *
 * Keyed on the full path, which is the row identity the listing prints — so this
 * checks the join between a test and its numbers as well as the numbers.
 *
 * `windowDays` is the trailing window the listing classifies over; the noise
 * filter is judged against the **whole** file, which is the asymmetry
 * `MIN_FILTERABLE_DAYS` documents and the reason `windowFailures` is accumulated
 * outside the windowed loop below.
 */
function independentTestDays(file: IssuesFile, windowDays: number): Map<string, ExpectedTest> {
    const days = file.metadata.days;
    const statuses = file.tables.statuses;
    const messages = file.tables.messages;
    const from = days - windowDays;

    const out = new Map<string, ExpectedTest>();

    const paths = file.tables.testPaths;
    const pathIds = file.testInfo.testPathIds;
    const names = file.tables.testNames;
    const nameIds = file.testInfo.testNameIds;

    for (let testId = 0; testId < file.testRuns.length; testId++) {
        const perTest = file.testRuns[testId];
        if (!perTest) {
            continue;
        }
        const directory = paths[pathIds[testId]!]!;
        const name = names[nameIds[testId]!]!;
        const fullPath = directory === '' ? name : `${directory}/${name}`;

        const fail = new Array<number>(days).fill(0);
        const pass = new Array<number>(days).fill(0);
        const skip = new Array<number>(days).fill(0);
        let windowFailures = 0;

        for (let statusId = 0; statusId < perTest.length; statusId++) {
            const group = perTest[statusId];
            if (!group) {
                continue;
            }
            const status = statuses[statusId]!;
            const raw = group as unknown as {
                days?: number[];
                counts?: number[];
                messageIds?: (number | null)[];
            };
            if (raw.days === undefined || raw.counts === undefined) {
                continue;
            }
            // Prefix matching, not the shared classifier, so a taxonomy change
            // cannot move both sides at once.
            const isSkip = status === 'SKIP';
            const isExpectedFail = status.startsWith('EXPECTED-FAIL');
            const isFail = !isExpectedFail && /^(FAIL|TIMEOUT|CRASH)/.test(status);
            const isPass = isExpectedFail || status.startsWith('PASS');

            let day = 0;
            for (let index = 0; index < raw.days.length; index++) {
                day += raw.days[index]!;
                const count = raw.counts[index]!;
                if (isFail) {
                    fail[day] = fail[day]! + count;
                    windowFailures += count;
                } else if (isPass) {
                    pass[day] = pass[day]! + count;
                } else if (isSkip) {
                    const messageId = raw.messageIds?.[index];
                    const message =
                        messageId === null || messageId === undefined
                            ? null
                            : messages[messageId]!;
                    if (message === null || !message.startsWith('run-if')) {
                        skip[day] = skip[day]! + count;
                    }
                }
            }
        }

        // The default noise threshold of 1, reimplemented against the whole file.
        const neutralised = windowFailures > 0 && windowFailures <= 1;

        let flakyDays = 0;
        let skippedDays = 0;
        let bothDays = 0;
        let ranDays = 0;
        for (let day = from; day < days; day++) {
            const failed = neutralised ? 0 : fail[day]!;
            const passed = pass[day]! + (neutralised ? fail[day]! : 0);
            const skipped = skip[day]!;
            if (failed === 0 && skipped === 0 && passed === 0) {
                continue;
            }
            ranDays++;
            if (failed > 0) {
                flakyDays++;
            }
            if (skipped > 0) {
                skippedDays++;
                if (failed > 0) {
                    bothDays++;
                }
            }
        }
        if (ranDays === 0) {
            continue;
        }
        out.set(fullPath, { flakyDays, skippedDays, bothDays, ranDays, windowFailures });
    }
    return out;
}

/** The tests the listing must show: those with something to act on. */
function expectedListed(expected: Map<string, ExpectedTest>): Map<string, ExpectedTest> {
    const out = new Map<string, ExpectedTest>();
    for (const [path, entry] of expected) {
        if (entry.flakyDays > 0 || entry.skippedDays > 0) {
            out.set(path, entry);
        }
    }
    return out;
}

// --- the command ---------------------------------------------------------

const FILES: Record<string, string> = {
    'xpcshell-timings/index.json': 'index.json',
    'xpcshell-timings/xpcshell-issues.json': 'xpcshell-issues.json',
};

function fixtureSource(): DataSource {
    return {
        name: 'fixtures',
        async fetch(fileName: DataFileName): Promise<Uint8Array> {
            const key = `${fileName.index}/${fileName.filename}`;
            const local = FILES[key];
            if (local === undefined) {
                throw new DataFileNotFoundError(fileName);
            }
            return new Uint8Array(await readFile(new URL(local, FIXTURES)));
        },
    };
}

async function invoke(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const streams = captureStreams();
    const code = await run({
        argv,
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
    });
    return { code, stdout: streams.stdout, stderr: streams.stderr };
}

function json(stdout: string): Record<string, unknown> {
    return JSON.parse(stdout) as Record<string, unknown>;
}

interface Row {
    path: string;
    verdict: string;
    flaky: number;
    skipped: number;
    flakyAndSkipped: number;
    total: number;
    flakyPercent: number;
    windowFailures: number;
    neutralised: boolean;
}

async function listing(extra: string[] = []): Promise<Record<string, unknown>> {
    const { code, stdout } = await invoke([
        'flaky',
        '--group-by',
        'tests',
        '--json',
        '--quiet',
        '--limit',
        '0',
        ...extra,
    ]);
    assert.equal(code, ExitCode.Success);
    return json(stdout);
}

// --- the numbers ---------------------------------------------------------

test('every listed row matches an independent walk of the fixture', async () => {
    const result = await listing();
    const rows = result['rows'] as Row[];
    const expected = independentTestDays(issuesFixture, DEFAULT_AVERAGE_DAYS);
    const shouldList = expectedListed(expected);

    // The **set** first: a missing row is as wrong as a wrong number, and
    // checking only the rows that exist would not catch a test dropped by the
    // subtree walk.
    assert.deepEqual(
        new Set(rows.map((row) => row.path)),
        new Set(shouldList.keys()),
        'the listed tests must be exactly those with a flaky or a skipped day'
    );
    assert.ok(rows.length > 0, 'the fixture must produce rows');

    for (const row of rows) {
        const want = shouldList.get(row.path)!;
        // Exact integers, not a tolerance: these are counts of days, and a
        // tolerance here would be admitting they might be means. See `days()`.
        assert.equal(row.flaky, want.flakyDays, `${row.path} flaky days`);
        assert.equal(row.skipped, want.skippedDays, `${row.path} skipped days`);
        assert.equal(row.flakyAndSkipped, want.bothDays, `${row.path} flaky+skipped days`);
        assert.equal(row.total, want.ranDays, `${row.path} days it ran`);
        assert.equal(
            row.windowFailures,
            want.windowFailures,
            `${row.path} failing runs over the whole file`
        );
        // Rounded once from the raw ratio of the two day counts.
        const wantPercent = want.ranDays > 0 ? (want.flakyDays / want.ranDays) * 100 : 0;
        assert.ok(
            Math.abs(row.flakyPercent - wantPercent) < 1e-4,
            `${row.path} flaky%: got ${row.flakyPercent}, the independent walk says ${wantPercent}`
        );
    }
});

test('the counts are whole days, and can reach the width of the window', async () => {
    // The bug this pins. `flakinessByFolderAveraged` divides every leaf counter by
    // the window, so a test flaky on every day it ran has a *mean* of 1 and one
    // flaky on two of seven days has 0.2857…. Printed as means, every worst row in
    // the table reads `1` and the ranking column carries a decimal that is a
    // fraction of a single test rather than of a population. `days()` multiplies
    // back, and this asserts the result is integral and reaches past 1.
    const rows = (await listing())['rows'] as Row[];
    for (const row of rows) {
        for (const [key, value] of [
            ['flaky', row.flaky],
            ['skipped', row.skipped],
            ['flakyAndSkipped', row.flakyAndSkipped],
            ['total', row.total],
        ] as const) {
            assert.ok(
                Number.isInteger(value),
                `${row.path}.${key} = ${value} must be a whole number of days`
            );
            assert.ok(
                value <= DEFAULT_AVERAGE_DAYS,
                `${row.path}.${key} = ${value} cannot exceed the ${DEFAULT_AVERAGE_DAYS}-day window`
            );
        }
    }
    assert.ok(
        rows.some((row) => row.flaky > 1),
        'at least one test must be flaky on more than one day, or the day scaling is untested'
    );
});

// --- the ranking, which is the whole point -------------------------------

test('a skipped-only test can never outrank a flaky one', async () => {
    // The `issues --group-by test` failure mode, asserted away. On the pinned
    // window that command puts test_UserInteraction_annotations.js first on 6,879
    // issues of which 6,782 are skips, and this classification calls it skipped.
    const rows = (await listing())['rows'] as Row[];
    const lastFlaky = rows.reduce(
        (best, row, index) => (row.flaky > 0 ? index : best),
        -1
    );
    const firstSkippedOnly = rows.findIndex((row) => row.flaky === 0);
    if (lastFlaky >= 0 && firstSkippedOnly >= 0) {
        assert.ok(
            firstSkippedOnly > lastFlaky,
            `row ${firstSkippedOnly} is skipped-only and sits above row ${lastFlaky}, which is ` +
                'flaky — the listing must rank flaky-first'
        );
    }
    for (let i = 1; i < rows.length; i++) {
        assert.ok(
            rows[i - 1]!.flaky >= rows[i]!.flaky,
            `flaky days must be descending: row ${i - 1} has ${rows[i - 1]!.flaky} and row ${i} ` +
                `has ${rows[i]!.flaky}`
        );
    }
});

test('the verdict column names the overlap rather than picking a side', async () => {
    const rows = (await listing())['rows'] as Row[];
    for (const row of rows) {
        const want =
            row.flakyAndSkipped > 0 ? 'flaky+skipped' : row.flaky > 0 ? 'flaky' : 'skipped';
        assert.equal(row.verdict, want, `${row.path} verdict`);
        // Every listed row has something to act on, by construction.
        assert.ok(row.flaky > 0 || row.skipped > 0, `${row.path} is listed but is clean`);
    }
    assert.ok(
        new Set(rows.map((row) => row.verdict)).size > 1,
        'the fixture must exercise more than one verdict, or the column is untested'
    );
});

// --- the hidden clean tests ----------------------------------------------

test('clean tests are counted and not listed, and the two add up', async () => {
    const result = await listing();
    const rows = result['rows'] as Row[];
    const expected = independentTestDays(issuesFixture, DEFAULT_AVERAGE_DAYS);
    const shouldList = expectedListed(expected);

    assert.equal(
        result['consideredTests'],
        expected.size,
        'every test that ran in the window must be considered'
    );
    assert.equal(result['cleanTests'], expected.size - shouldList.size);
    assert.equal(
        (result['rowCount'] as number) + (result['cleanTests'] as number),
        result['consideredTests'],
        'rows + hidden clean must be everything, or the listing is silently short'
    );
    assert.ok((result['cleanTests'] as number) > 0, 'the fixture must have a clean test to hide');
    // And a clean test is really absent, named rather than inferred from a count.
    const clean = [...expected.keys()].filter((path) => !shouldList.has(path));
    for (const path of clean) {
        assert.ok(
            !rows.some((row) => row.path === path),
            `${path} passed everywhere it ran and must not be listed`
        );
    }
});

test('the text output says how many it hid, and what to run next', async () => {
    // Tree-wide, because on this fixture the clean tests are the two outside
    // `toolkit` — a listing scoped to a folder with none must not print the note,
    // which the second half asserts.
    const { stdout } = await invoke(['flaky', '--group-by', 'tests', '--quiet', '--limit', '0']);
    assert.match(stdout, /2 of 9 tests here passed everywhere they ran and are not listed/);
    assert.match(
        stdout,
        /still in every count above/,
        'hiding a row must not appear to move a number'
    );
    // The deep dive, named against a real row so it is copy-pasteable — and it is
    // `fx-tests test`, the one command that can break a single test down by
    // configuration, which `issues.json` cannot.
    assert.match(stdout, /fx-tests test toolkit\/.*\.js/);

    const scoped = await invoke([
        'flaky',
        'toolkit/components/extensions/test/xpcshell',
        '--quiet',
        '--limit',
        '0',
    ]);
    assert.doesNotMatch(
        scoped.stdout,
        /passed everywhere they ran/,
        'a folder with nothing to hide must not print a note about hiding nothing'
    );
});

// --- the subtree, and --here-only ----------------------------------------

test('the subtree is the default and --here-only is narrower', async () => {
    // `toolkit` holds every extensions test in the fixture and has none of its
    // own, which is what makes it the case worth testing: the two answers differ.
    const subtree = await listing(['--path', 'toolkit']);
    const here = await listing(['--path', 'toolkit', '--here-only']);

    assert.equal(subtree['hereOnly'], false);
    assert.equal(here['hereOnly'], true);
    assert.ok(
        (subtree['rowCount'] as number) > (here['rowCount'] as number),
        'the subtree must find more than the folder alone on a container folder: got ' +
            `${String(subtree['rowCount'])} and ${String(here['rowCount'])}`
    );
    assert.equal(here['rowCount'], 0, 'toolkit itself holds no test files in the fixture');

    // Every subtree row really is under the path, and none of them is at the top.
    for (const row of subtree['rows'] as Row[]) {
        assert.ok(row.path.startsWith('toolkit/'), `${row.path} is outside toolkit`);
    }

    // Whereas a leaf folder gives the same answer both ways, which is the case
    // that makes the default safe to be the recursive one.
    const leaf = 'toolkit/components/extensions/test/xpcshell';
    const leafSubtree = await listing(['--path', leaf]);
    const leafHere = await listing(['--path', leaf, '--here-only']);
    assert.deepEqual(
        (leafSubtree['rows'] as Row[]).map((row) => row.path),
        (leafHere['rows'] as Row[]).map((row) => row.path),
        'a folder with no subfolders must list the same tests either way'
    );
});

test('--here-only needs a path, and applies only to this view', async () => {
    // With no path it means the tree root, no test file lives there, and the
    // listing came out empty — a flag that silently produces no rows.
    const bare = await invoke(['flaky', '--group-by', 'tests', '--here-only', '--quiet']);
    assert.equal(bare.code, ExitCode.Usage);
    assert.match(bare.stderr, /--here-only needs a path/);

    for (const view of ['list', 'folder', 'days']) {
        const { code, stderr } = await invoke([
            'flaky',
            '--group-by',
            view,
            '--here-only',
            '--quiet',
        ]);
        assert.equal(code, ExitCode.Usage, `--here-only must be refused on --group-by ${view}`);
        assert.match(stderr, /only applies to --group-by tests/);
    }
});

// --- the window, shared with the folder ranking ---------------------------

test('the three scopes give different readings, and the header names which ran', async () => {
    const average = await listing();
    const allDays = await listing(['--all-days']);
    const oneDay = await listing(['--day', '2026-08-03']);

    for (const [name, result] of [
        ['average', average],
        ['all-days', allDays],
        ['day', oneDay],
    ] as const) {
        assert.equal((result['header'] as Record<string, unknown>)['scope'], name);
    }

    // The looser bar must list at least as many tests as the mean of 7 days,
    // because "flaky on ANY of 21 days" cannot be false where "flaky on one of
    // the last 7" is true. On the fixture, 21 days finds strictly more.
    assert.ok(
        (allDays['rowCount'] as number) >= (average['rowCount'] as number),
        `--all-days (${String(allDays['rowCount'])}) cannot list fewer than the 7-day average ` +
            `(${String(average['rowCount'])})`
    );
    // And the three readings are not the same table, which is what makes naming
    // the scope in the header load-bearing rather than decorative. On this
    // 10-test fixture the difference shows in the row set — `--all-days` finds 8
    // where the 7-day average finds 7 — rather than in the counts, which is
    // enough: a scope flag that changed nothing could not produce it.
    assert.ok(
        (allDays['rowCount'] as number) > (average['rowCount'] as number),
        '--all-days is the looser bar and must list strictly more on this fixture: got ' +
            `${String(allDays['rowCount'])} against ${String(average['rowCount'])}`
    );
    // The day counts have different ceilings under the three, which is the other
    // half of the same fact: 7 under the average, 1 under a single day.
    const maxOf = (result: Record<string, unknown>): number =>
        Math.max(0, ...(result['rows'] as Row[]).map((row) => row.total));
    assert.equal(maxOf(oneDay), 1, '--day classifies one day, so a test ran on at most 1');
    assert.equal(
        maxOf(average),
        DEFAULT_AVERAGE_DAYS,
        'the average classifies each of 7 days separately'
    );

    const { stdout } = await invoke(['flaky', 'toolkit', '--quiet', '--limit', '3']);
    assert.match(stdout, /Each test is classified separately on each of the last 7 days/);
    assert.match(stdout, /Test files under toolkit and its subfolders/);
});

test('the listing classifies the same way as the folder ranking above it', async () => {
    // The join that must not break: a reader ranks folders, picks one, drills in.
    // If the two used different definitions the drill-down would be the `issues`
    // bug one level down. So the folder's own flaky *mean* must be the mean of
    // its listed tests' flaky *days* — the same numbers, divided once.
    const folder = 'toolkit/components/extensions/test/xpcshell';
    const ranking = json(
        (await invoke(['flaky', '--json', '--quiet', '--limit', '0'])).stdout
    );
    const row = (ranking['rows'] as { path: string; flaky: number; testCount: number }[]).find(
        (entry) => entry.path === folder
    );
    assert.ok(row !== undefined, `${folder} must be a row of the ranking`);

    const drill = await listing(['--path', folder, '--here-only']);
    let flakyDays = 0;
    for (const test of drill['rows'] as Row[]) {
        flakyDays += test.flaky;
    }
    assert.ok(
        Math.abs(row.flaky - flakyDays / DEFAULT_AVERAGE_DAYS) < 1e-4,
        `${folder}: the ranking says ${row.flaky} flaky per day, the listing's ` +
            `${flakyDays} flaky days over ${DEFAULT_AVERAGE_DAYS} days is ` +
            `${flakyDays / DEFAULT_AVERAGE_DAYS}`
    );
    // Clean tests are hidden from the listing but stay in the folder's count.
    assert.equal(
        row.testCount,
        drill['consideredTests'],
        "the folder row's test count must be the listing's population, clean ones included"
    );
});

// --- the library helpers -------------------------------------------------

test('subtreeTests lists every leaf once, and folderAt finds the node', () => {
    const { root } = flakinessByFolderAveraged(decodeIssues(issuesFixture));
    const all = subtreeTests(root);
    const paths = all.map((leaf) => leaf.fullPath);
    assert.equal(new Set(paths).size, paths.length, 'a test must appear in exactly one leaf');

    // Against the independent walk, so the flattening is checked against the raw
    // fixture rather than against the tree it was built from.
    const expected = independentTestDays(issuesFixture, DEFAULT_AVERAGE_DAYS);
    assert.deepEqual(
        new Set(paths),
        new Set(expected.keys()),
        'the flattened subtree must be every test that ran in the window'
    );

    const node = folderAt(root, 'toolkit/components/extensions/test/xpcshell');
    assert.ok(node !== null, 'folderAt must find a folder that holds tests');
    assert.equal(node.path, 'toolkit/components/extensions/test/xpcshell');
    assert.deepEqual(
        subtreeTests(node).map((leaf) => leaf.fullPath).sort(),
        node.tests.map((leaf) => leaf.fullPath).sort(),
        'a folder with no subfolders is its own subtree'
    );
    assert.equal(folderAt(root, 'toolkit/nope'), null, 'a missing folder is null, not the root');
    assert.equal(folderAt(root, ''), root, 'the empty path is the root');
});

test('hasSomethingToAct agrees with the page’s own rule', async () => {
    // The page's copy is module-private, so the agreement is asserted through the
    // one thing both sides export: the count of leaves each rule hides.
    const { hiddenCleanTests } = await import('../site/flaky-view.ts');
    const { root } = flakinessByFolderAveraged(decodeIssues(issuesFixture));
    const node = folderAt(root, 'toolkit/components/extensions/test/xpcshell');
    assert.ok(node !== null);
    assert.equal(
        node.tests.filter((leaf) => !hasSomethingToAct(leaf)).length,
        hiddenCleanTests(node),
        'lib/query/flakiness.ts:hasSomethingToAct must hide exactly what ' +
            'site/flaky-view.ts:isWorthListing hides — the CLI and the page list the same rows'
    );
});
