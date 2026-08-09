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
 * either. Two independent recomputations live below, each re-decoding the
 * fixture's delta-encoded day arrays and matching statuses by regular expression
 * rather than through `classifyStatus`:
 *
 * - `independentTestDays()` counts **days per test** as integers and never
 *   divides, which is what checks the population and the clean-test accounting.
 * - `independentWindowVerdicts()` keeps no counters at all — two booleans per
 *   test, ORed across the window — which is what checks the listing's default
 *   window. Deliberately a second walk rather than `> 0` applied to the first:
 *   the property under test is that the verdict is an OR across days and not
 *   arithmetic, and a walk that counted first could not distinguish the two.
 *
 * ## What these are defending
 *
 * 1. **Flaky-first ranking**, so the `issues` failure mode cannot recur.
 * 2. **0/1 verdicts, not means and not day counts.** A test's mean can only be
 *    0, 1/7 … 1, so printed as means every worst row reads `1`.
 * 3. **Clean tests are hidden and counted.** `rowCount + cleanTests` must be
 *    every test that ran, or the listing is silently shorter than the folder row
 *    above it.
 * 4. **The subtree is the default**, and `--here-only` really is narrower.
 * 5. **The same classification *and the same window* as the folder ranking**, so
 *    a reader who ranks folders and drills in does not cross a boundary of
 *    either. The window half was broken: the listing passed no window option and
 *    inherited `flakinessByFolder`'s single-day default, so a folder the ranking
 *    scored at 32 flaky tests over 7 days drilled into a list of 29.
 */

import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { type IssuesFile, decodeIssues } from '../lib/formats/issues.ts';
import {
    DEFAULT_AVERAGE_DAYS,
    flakinessByFolder,
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

/** One test file's single verdict over the window: two booleans and nothing else. */
interface ExpectedVerdict {
    /** It failed at least once on at least one day of the window. */
    flaky: boolean;
    /** It was skipped somewhere on at least one day of it. */
    skipped: boolean;
}

/**
 * Every test's **single verdict** over the trailing `windowDays` days.
 *
 * The listing's default window, recomputed the dumb way. Deliberately *not*
 * `independentTestDays` with a `> 0` applied afterwards: that would derive both
 * the day counts and the verdict from one walk, and the thing being checked here
 * is precisely that the verdict is an OR across days rather than something with
 * arithmetic in it. So this keeps no counters at all — two booleans per test, set
 * once and never cleared — which is the shape a 0/1 verdict has and the shape a
 * day count does not.
 *
 * A test that did not run at all in the window is absent, as it is from the tree.
 * The noise filter is judged against the **whole** file however narrow the window
 * is, which is the asymmetry `MIN_FILTERABLE_DAYS` documents.
 */
function independentWindowVerdicts(
    file: IssuesFile,
    windowDays: number
): Map<string, ExpectedVerdict> {
    const days = file.metadata.days;
    const statuses = file.tables.statuses;
    const messages = file.tables.messages;
    const from = days - windowDays;

    const out = new Map<string, ExpectedVerdict>();

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

        let anyFlaky = false;
        let anySkipped = false;
        let ran = false;
        for (let day = from; day < days; day++) {
            const failed = neutralised ? 0 : fail[day]!;
            const passed = pass[day]! + (neutralised ? fail[day]! : 0);
            const skipped = skip[day]!;
            if (failed === 0 && skipped === 0 && passed === 0) {
                continue;
            }
            ran = true;
            if (failed > 0) {
                anyFlaky = true;
            }
            if (skipped > 0) {
                anySkipped = true;
            }
        }
        if (!ran) {
            continue;
        }
        out.set(fullPath, { flaky: anyFlaky, skipped: anySkipped });
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

test('every listed row is the page’s own verdict for that test, on the listing’s window', async () => {
    // ## Why this replaced an independent day-count walk
    //
    // The listing used to print how many of the last 7 days each test was flaky
    // on, and this test recomputed those day counts. Both were wrong at the root:
    // the 7-day mean is a *folder* quantity — "126.7 of this folder's tests were
    // flaky on a typical day" is real — and a single test's mean can only be 0,
    // 1/7 … 1, so it was multiplied back out into "flaky on 6 of the 7 days" and
    // the table read `7  100.0%  7  7` to say "always".
    //
    // `flaky.html` never did that: its test rows come from `flakinessByFolder`,
    // one verdict over the window, whose leaves are 0 or 1. The listing now reads
    // the same function, so the check that matters is no longer "are these day
    // counts right" but **"does the CLI say what the page says"** — the two
    // disagreeing about whether a test is flaky is the failure worth pinning, and
    // it is the same reasoning as the `hasSomethingToAct` agreement below.
    const rows = (await listing())['rows'] as Row[];

    // The page's derivation, called directly. Not a reimplementation: agreeing
    // with a copy of the logic would prove nothing about agreeing with the page.
    //
    // `fromDay` because the listing's default window is now the folder ranking's
    // — see `listingTree` — so the page function has to be asked the same
    // question. Asking it its own default (the most recent day) would be
    // re-asserting the bug: on the pinned file that reads 29 flaky tests in
    // `toolkit/components/telemetry/tests/unit` where the ranking scored 32.
    const decoded = decodeIssues(issuesFixture);
    const leaves = subtreeTests(
        flakinessByFolder(decoded, {
            minWindowFailures: 1,
            allDays: true,
            fromDay: (decoded.days ?? 1) - DEFAULT_AVERAGE_DAYS,
        })
    );
    const want = new Map(leaves.filter(hasSomethingToAct).map((leaf) => [leaf.fullPath, leaf]));

    // The **set** first: a missing row is as wrong as a wrong number, and checking
    // only the rows that exist would not catch a test the subtree walk dropped.
    assert.deepEqual(
        new Set(rows.map((row) => row.path)),
        new Set(want.keys()),
        'the listed tests must be exactly the page’s worth-listing leaves'
    );
    assert.ok(rows.length > 0, 'the fixture must produce rows');

    for (const row of rows) {
        const leaf = want.get(row.path)!;
        assert.equal(row.flaky, leaf.flaky, `${row.path} flaky verdict`);
        assert.equal(row.skipped, leaf.skipped, `${row.path} skipped verdict`);
        assert.equal(row.flakyAndSkipped, leaf.flakyAndSkipped, `${row.path} overlap`);
        assert.equal(row.total, leaf.total, `${row.path} total`);
        assert.equal(
            row.windowFailures,
            leaf.windowFailures,
            `${row.path} failing runs over the whole file`
        );
    }
});

test('the verdicts are 0 or 1, as the page’s table shows them', async () => {
    // The encoding, pinned. A test either was flaky in the window or it was not;
    // there is no rate to express and nothing to multiply by a day count. Measured
    // on the pinned file, `flakinessByFolder`'s 4,807 leaves take exactly two
    // distinct values in each of `flaky`, `skipped` and `stable`, with `total`
    // always 1 — this asserts the CLI's rows have the same shape rather than
    // reintroducing the arithmetic that produced `7 of 7`.
    const rows = (await listing())['rows'] as Row[];
    for (const row of rows) {
        for (const [key, value] of [
            ['flaky', row.flaky],
            ['skipped', row.skipped],
            ['flakyAndSkipped', row.flakyAndSkipped],
        ] as const) {
            assert.ok(
                value === 0 || value === 1,
                `${row.path}.${key} = ${value} must be a 0/1 verdict, not a day count`
            );
        }
        assert.equal(row.total, 1, `${row.path}.total must be 1 — one test, one verdict`);
    }
    // And the one column that does carry magnitude still does, or the listing has
    // nothing left to rank ties by.
    assert.ok(
        rows.some((row) => row.windowFailures > 1),
        'failing-run counts must survive as the only high-resolution column'
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
    // **The default here is the folder ranking's 7 days**, and the header says so.
    // It used to be one day — not by choice but by omission: `listingTree` passed
    // no window option, so `flakinessByFolder` fell through to its own default of
    // the most recent day, a default written for the folder table. Measured on the
    // pinned file, that made the drill-down of a folder the ranking had scored at
    // 32 flaky tests over 7 days show only 29.
    //
    // The listing still does not *average* — a single test's mean can only be 0,
    // 1/7 … 1 — so it takes one verdict per test over those days, flaky if flaky
    // on any of them. `listingHeader` reports that as `scope: "window"` with
    // `averageDays: null`, because `--json` claiming `scope: "average"` over a
    // table of 0/1 verdicts is exactly the tiles-say-one-thing mismatch
    // `flaky.html` had to fix.
    const byDefault = await listing();
    const allDays = await listing(['--all-days']);
    const oneDay = await listing(['--day', '2026-08-03']);

    const headerOf = (result: Record<string, unknown>): Record<string, unknown> =>
        result['header'] as Record<string, unknown>;
    assert.equal(
        headerOf(byDefault)['scope'],
        'window',
        'the listing classifies the ranking’s window by default'
    );
    assert.equal(headerOf(byDefault)['averageDays'], null, 'and averages nothing');
    assert.equal(
        (headerOf(byDefault)['scopeDates'] as string[]).length,
        DEFAULT_AVERAGE_DAYS,
        'over exactly the days the ranking averages, named so a reader can check them'
    );
    assert.equal(headerOf(allDays)['scope'], 'all-days');
    assert.equal(headerOf(oneDay)['scope'], 'day');

    // The default's window was not asked for, and the suggested follow-up commands
    // read that flag so they do not print a scope flag the reader never typed.
    assert.equal(headerOf(byDefault)['scopeRequested'], false);
    assert.equal(headerOf(oneDay)['scopeRequested'], true);

    // The three are ordered by how loose the bar is, and each step must be strict —
    // a scope flag that changed nothing could not produce this. "Flaky on ANY of 21
    // days" ⊇ "ANY of the last 7" ⊇ "on one named day".
    assert.ok(
        (allDays['rowCount'] as number) > (byDefault['rowCount'] as number),
        '--all-days must list strictly more than the 7-day default: got ' +
            `${String(allDays['rowCount'])} against ${String(byDefault['rowCount'])}`
    );
    // Against the *flaky* rows rather than every row, because a skipped-only test
    // is skipped on most days and so is listed under either window: on this
    // 10-test fixture both windows list 7 rows and the difference is entirely in
    // the verdicts. Six tests are flaky somewhere in the 7 days against five on the
    // last day alone, which is the containment being checked.
    const flakyRows = (result: Record<string, unknown>): number =>
        (result['rows'] as Row[]).filter((row) => row.flaky > 0).length;
    assert.ok(
        flakyRows(byDefault) > flakyRows(oneDay),
        'the 7-day default must find strictly more flaky tests than one day: got ' +
            `${flakyRows(byDefault)} against ${flakyRows(oneDay)}`
    );
    // Containment, not just a bigger number: the looser window must be a superset,
    // or the two are answering different questions rather than the same one wider.
    const flakyPaths = (result: Record<string, unknown>): Set<string> =>
        new Set((result['rows'] as Row[]).filter((row) => row.flaky > 0).map((row) => row.path));
    for (const path of flakyPaths(oneDay)) {
        assert.ok(
            flakyPaths(byDefault).has(path),
            `${path} is flaky on 2026-08-03, which is inside the default window, so the default ` +
                'must call it flaky too'
        );
    }

    // Every scope yields one verdict per test, so `total` is 1 throughout — the
    // day-count ceilings this used to assert were an artefact of the averaging.
    for (const [name, result] of [
        ['default', byDefault],
        ['--all-days', allDays],
        ['--day', oneDay],
    ] as const) {
        for (const row of result['rows'] as Row[]) {
            assert.equal(row.total, 1, `${name}: ${row.path} must carry one verdict, not days`);
        }
    }

    const { stdout } = await invoke(['flaky', 'toolkit', '--quiet', '--limit', '3']);
    // Whitespace-normalised: the caveat is one sentence wrapped for the terminal,
    // so the phrase straddles two lines. This checks the prose is present, not how
    // it is folded.
    const flat = stdout.replace(/\s+/g, ' ');
    assert.match(flat, /Window: the ranking's 7 days 2026-07-28 … 2026-08-03, one verdict per test/);
    assert.match(flat, /flaky if flaky on ANY of them/);
    assert.match(stdout, /Test files under toolkit and its subfolders/);

    // And the two other windows still name themselves as they did before the
    // default moved, which is what makes this a change to one scope and not three.
    const namedDay = await invoke([
        'flaky', 'toolkit', '--quiet', '--limit', '3', '--day', '2026-08-03',
    ]);
    assert.match(namedDay.stdout, /Window: 2026-08-03 \(Mon\) alone, one verdict per test/);
    const whole = await invoke(['flaky', 'toolkit', '--quiet', '--limit', '3', '--all-days']);
    assert.match(whole.stdout, /Window: --all-days — one verdict over all 21 days/);
});

test('the listing’s default window is exactly the folder ranking’s, by an independent walk', async () => {
    // The bug this closes: the ranking scored 7 days and the listing classified 1,
    // so drilling into a ranked row silently changed the question. Measured on the
    // pinned file for `toolkit/components/telemetry/tests/unit`, the ranking's 7
    // days hold **32** flaky tests and the listing printed **29** — three tests the
    // reader had just been shown a count of, absent from the list of them.
    //
    // The expectation comes from `independentWindowVerdicts` below: a second,
    // deliberately dumber recomputation that re-decodes the fixture's delta-encoded
    // days, matches statuses by regular expression, and ORs across the window with
    // its own `if` chain. It calls nothing in `lib/query/flakiness.ts`, so it
    // cannot move with the code under test.
    //
    // The **set** is what is asserted, not a count: a listing that got the total
    // right by swapping one test for another would be exactly as broken, and the
    // three missing tests in the measurement above are why.
    const result = await listing();
    const rows = result['rows'] as Row[];
    const expected = independentWindowVerdicts(issuesFixture, DEFAULT_AVERAGE_DAYS);

    const shouldList = new Map([...expected].filter(([, v]) => v.flaky || v.skipped));
    assert.ok(shouldList.size > 0, 'the fixture must produce rows, or this asserts nothing');
    assert.deepEqual(
        new Set(rows.map((row) => row.path)),
        new Set(shouldList.keys()),
        'the listed tests must be exactly those flaky or skipped on ANY of the ranking’s days'
    );

    for (const row of rows) {
        const want = shouldList.get(row.path)!;
        assert.equal(row.flaky, want.flaky ? 1 : 0, `${row.path}: flaky on any day of the window`);
        assert.equal(row.skipped, want.skipped ? 1 : 0, `${row.path}: skipped on any of them`);
        // The overlap keeps its name across a multi-day window: a test flaky on one
        // day and skipped on another is both, which is `windowState`'s precedence
        // applied between days rather than a second classifier.
        assert.equal(
            row.flakyAndSkipped,
            want.flaky && want.skipped ? 1 : 0,
            `${row.path}: flakyAndSkipped must name the overlap over the whole window`
        );
        assert.equal(row.total, 1, `${row.path}: still one verdict, not a day count`);
    }

    // And the drill-down is a refinement of the row above it: every test the
    // ranking counted as flaky in that folder is a flaky row here. Asserted as an
    // equal **set** rather than as equal numbers, because the ranking's figure is a
    // mean per day and this is a count of distinct tests — on the pinned data 26.7
    // and 32 are both right over the same 7 days, and forcing them equal would be
    // wrong.
    const folder = 'toolkit/components/extensions/test/xpcshell';
    const scoped = await listing(['--path', folder, '--here-only']);
    const listedFlaky = new Set(
        (scoped['rows'] as Row[]).filter((row) => row.flaky > 0).map((row) => row.path)
    );
    const wantFlaky = new Set(
        [...expected]
            .filter(([path, v]) => v.flaky && path.startsWith(`${folder}/`))
            .map(([path]) => path)
    );
    assert.ok(wantFlaky.size > 0, `${folder} must have flaky tests in the window`);
    assert.deepEqual(listedFlaky, wantFlaky, `${folder}: the drill-down must list the same tests`);
});

test('the listing agrees with the folder ranking on the same window', async () => {
    // The join that must not break: a reader ranks folders, picks one, drills in.
    // If the two used different *classifications* the drill-down would be the
    // `issues` bug one level down.
    //
    // They no longer use the same **window**, deliberately: the ranking averages
    // seven days because a folder mean over a population is meaningful, and the
    // listing takes one verdict per test because a single test's mean is not. So
    // the equality is asserted where the two windows coincide — `--day`, where the
    // ranking classifies that one day too — and the count of flaky tests the
    // ranking reports for the folder must be the number of flaky rows the listing
    // shows for it.
    const folder = 'toolkit/components/extensions/test/xpcshell';
    const day = '2026-08-03';
    const ranking = json(
        (await invoke(['flaky', '--json', '--quiet', '--limit', '0', '--day', day])).stdout
    );
    const row = (ranking['rows'] as { path: string; flaky: number; testCount: number }[]).find(
        (entry) => entry.path === folder
    );
    assert.ok(row !== undefined, `${folder} must be a row of the ranking`);

    const drill = await listing(['--path', folder, '--here-only', '--day', day]);
    const flakyRows = (drill['rows'] as Row[]).filter((test) => test.flaky > 0).length;
    assert.equal(
        flakyRows,
        row.flaky,
        `${folder}: the ranking counts ${row.flaky} flaky tests on ${day}, the listing shows ` +
            `${flakyRows} flaky rows — the two must classify identically`
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
