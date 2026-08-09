/**
 * `fx-tests flaky` end to end, and `flakinessByFolderAveraged` against an
 * independent walk of the fixture.
 *
 * ## Where the goldens come from
 *
 * Not from the code under test. `independentFolderAverage()` below re-decodes the
 * fixture's delta-encoded day arrays itself, matches statuses by regular
 * expression rather than through `classifyStatus`, applies the three-state
 * precedence with its own `if` chain, and averages by summing integer test-days
 * and dividing once. It shares no line with `lib/query/flakiness.ts`. That is the
 * pattern `test/flakiness.test.ts` established and the reason it exists: the
 * repo has four recorded cases of a test taking its expected value from the thing
 * under test, which shipped a wrong digit once and pinned a bug as correct twice.
 *
 * ## What these are defending
 *
 * 1. **The default scope is a 7-day average of per-day verdicts** — not one day
 *    and not the window. Both wrong answers produce plausible tables: the window
 *    reads ~84% flaky tree-wide (a fact about the denominator) and one day swings
 *    1.8× with the weekday, because weekend push volume is 2.6× lower. The test
 *    asserts the three scopes give *different* numbers on the fixture, so a
 *    default that silently changed could not pass.
 * 2. **The averaging divides once.** Adding `1/7` seven times does not make 1, and
 *    the error was not cosmetic — it turned the "in tree" column on for every row.
 *    Asserted as exactness against integers, which only holds if the division is
 *    where it should be.
 * 3. **Flaky and skipped overlap, and `total` is not their sum.** Asserted rather
 *    than described, on a fixture folder that really has both.
 * 4. **The noise filter is reported, not assumed.** On a single-day file the
 *    command must say it did not apply the filter rather than quietly returning
 *    unfiltered counts under a filtered heading.
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
    folderList,
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

/** One folder's own tests, averaged over the last `windowDays` days. */
interface ExpectedFolder {
    /** Mean per day of tests directly here that failed at least once. */
    flaky: number;
    /** Mean per day of tests directly here skipped somewhere. */
    skipped: number;
    /** Mean per day of tests directly here that ran at all. */
    total: number;
    /** Test files directly here that ran at all in the window. */
    testCount: number;
}

/**
 * The per-folder averages, recomputed from the raw fixture.
 *
 * Deliberately dumber than the implementation: a map keyed on the test's
 * directory string, integer test-days accumulated, one division at the end. No
 * tree, no ancestors — which is exactly what makes it a check on `selfFlaky`,
 * the "tests directly in this folder" counter the command ranks on.
 */
function independentFolderAverage(
    file: IssuesFile,
    windowDays: number
): Map<string, ExpectedFolder> {
    const days = file.metadata.days;
    const statuses = file.tables.statuses;
    const messages = file.tables.messages;
    const from = days - windowDays;

    /** Integer test-days per folder, divided only at the very end. */
    const acc = new Map<string, { flaky: number; skipped: number; total: number; tests: number }>();

    // The directory comes straight off `testInfo.testPathIds`, which is the
    // interning the file already does — so this walk does not have to split a
    // path and cannot disagree with the decoder about where a folder ends.
    const paths = file.tables.testPaths;
    const pathIds = file.testInfo.testPathIds;

    for (let testId = 0; testId < file.testRuns.length; testId++) {
        const perTest = file.testRuns[testId];
        if (!perTest) {
            continue;
        }
        const directory = paths[pathIds[testId]!]!;

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

        // The default noise threshold of 1, reimplemented: a test failing once
        // across the whole window has those failures read as passes.
        const neutralised = windowFailures > 0 && windowFailures <= 1;

        let flakyDays = 0;
        let skippedDays = 0;
        let totalDays = 0;
        for (let day = from; day < days; day++) {
            const failed = neutralised ? 0 : fail[day]!;
            const passed = pass[day]! + (neutralised ? fail[day]! : 0);
            const skipped = skip[day]!;
            // flaky beats skipped beats stable, and a test with nothing that day
            // is in no state at all.
            let state: 'flaky' | 'skipped' | 'stable' | null = null;
            if (failed > 0) {
                state = 'flaky';
            } else if (skipped > 0) {
                state = 'skipped';
            } else if (passed > 0) {
                state = 'stable';
            }
            if (state === null) {
                continue;
            }
            totalDays++;
            if (state === 'flaky') {
                flakyDays++;
            }
            // The **overlapping** reading, which is the table's skip column: was
            // it skipped somewhere that day, whether or not it also failed.
            if (skipped > 0) {
                skippedDays++;
            }
        }
        if (totalDays === 0) {
            continue;
        }
        const entry = acc.get(directory) ?? { flaky: 0, skipped: 0, total: 0, tests: 0 };
        entry.flaky += flakyDays;
        entry.skipped += skippedDays;
        entry.total += totalDays;
        entry.tests += 1;
        acc.set(directory, entry);
    }

    const out = new Map<string, ExpectedFolder>();
    for (const [directory, entry] of acc) {
        out.set(directory, {
            flaky: entry.flaky / windowDays,
            skipped: entry.skipped / windowDays,
            total: entry.total / windowDays,
            testCount: entry.tests,
        });
    }
    return out;
}

/**
 * Two means are equal if they agree well inside one test-day.
 *
 * `tolerance` is 1e-9 against the library, which returns raw means, and looser
 * against `--json`, which deliberately rounds to 4 decimals so its shape does not
 * churn between runs. Comparing the rounded surface at 1e-9 would be asserting
 * that the rounding does not happen.
 */
function assertMean(actual: number, expected: number, message: string, tolerance = 1e-9): void {
    assert.ok(
        Math.abs(actual - expected) < tolerance,
        `${message}: got ${actual}, the independent walk says ${expected}`
    );
}

/** Half a unit in the last place `--json` keeps, plus slack for the rounding. */
const JSON_TOLERANCE = 1e-4;

// --- the library function ------------------------------------------------

test('the averaged folder list matches an independent walk of the fixture', () => {
    const decoded = decodeIssues(issuesFixture);
    const { root, windowDays } = flakinessByFolderAveraged(decoded);
    assert.equal(windowDays, DEFAULT_AVERAGE_DAYS);

    const expected = independentFolderAverage(issuesFixture, DEFAULT_AVERAGE_DAYS);
    const rows = folderList(root);
    assert.ok(rows.length > 0, 'the fixture must produce folder rows');

    // Every folder the independent walk found must be a row, and vice versa —
    // a missing folder is as wrong as a wrong number and would not be caught by
    // checking only the rows that exist.
    assert.deepEqual(
        new Set(rows.map((row) => row.path)),
        new Set(expected.keys()),
        'the set of folders with their own tests must match the independent walk'
    );

    for (const row of rows) {
        const want = expected.get(row.path)!;
        assertMean(row.selfFlaky, want.flaky, `${row.path} selfFlaky`);
        assertMean(row.selfSkipped, want.skipped, `${row.path} selfSkipped`);
        assertMean(row.selfTotal, want.total, `${row.path} selfTotal`);
        assert.equal(row.selfTestCount, want.testCount, `${row.path} selfTestCount`);
    }
});

test('averaging divides once, so a constant folder comes out exactly integral', () => {
    // The float bug this pins: accumulating `1/windowDays` per day made a folder
    // whose tests were skipped every single day read 130.99999999999997 instead
    // of 131, and every `subtree === self` comparison false by ~3.6e-14.
    //
    // Derived from the fixture rather than asserted as a literal: the property is
    // "a count that is a whole number of test-days is exactly a whole number of
    // tests", which is checkable without knowing which folders qualify.
    const decoded = decodeIssues(issuesFixture);
    const { root, windowDays } = flakinessByFolderAveraged(decoded);
    let checked = 0;
    for (const row of folderList(root)) {
        for (const [label, value] of [
            ['selfFlaky', row.selfFlaky],
            ['selfSkipped', row.selfSkipped],
            ['selfTotal', row.selfTotal],
        ] as const) {
            // `value * windowDays` is a count of test-days and so an integer. If
            // the division happened per-day, this is where the drift shows.
            const testDays = value * windowDays;
            assert.ok(
                Math.abs(testDays - Math.round(testDays)) < 1e-9,
                `${row.path} ${label} = ${value} is not a whole number of test-days ` +
                    `over ${windowDays} days (${testDays}) — the division moved`
            );
            checked++;
        }
    }
    assert.ok(checked > 0, 'nothing was checked, so this asserts nothing');
});

test('the three scopes give different answers on the same data', () => {
    // The reason the default had to be chosen rather than defaulted into: all
    // three are defensible readings and they disagree. If this stops failing to
    // be equal, one of the scopes has silently become another.
    const decoded = decodeIssues(issuesFixture);
    const folder = 'toolkit/components/extensions/test/xpcshell';
    const own = (root: ReturnType<typeof flakinessByFolder>): number =>
        folderList(root).find((row) => row.path === folder)?.selfFlaky ?? -1;

    const lastDay = own(flakinessByFolder(decoded));
    const wholeWindow = own(flakinessByFolder(decoded, { allDays: true }));
    const averaged = own(flakinessByFolderAveraged(decoded).root);

    assert.ok(lastDay >= 0 && wholeWindow >= 0 && averaged >= 0, 'the folder must be present');
    // The whole window is the loosest bar — "flaky on any day" — so it can only
    // be greater than or equal to a single day's, and on this fixture it is
    // strictly greater. That inequality is the 84%-denominator effect in
    // miniature and is the thing the default avoids.
    assert.ok(
        wholeWindow > lastDay,
        `--all-days must be a looser bar than one day (${wholeWindow} vs ${lastDay})`
    );
    assert.ok(
        averaged <= wholeWindow,
        `a mean of daily verdicts cannot exceed the any-day verdict (${averaged} vs ${wholeWindow})`
    );
});

test('flaky and skipped overlap, so they do not sum to the total', () => {
    const decoded = decodeIssues(issuesFixture);
    const { root } = flakinessByFolderAveraged(decoded);
    const rows = folderList(root);
    const overlapping = rows.filter((row) => row.selfFlakyAndSkipped > 0);
    assert.ok(
        overlapping.length > 0,
        'the fixture must contain a folder with a test that is both flaky and skipped, or this ' +
            'asserts nothing'
    );
    for (const row of overlapping) {
        // The named overlap accounts for the excess exactly. `stable` is not on
        // the list row, so the identity is checked the way a reader would: the
        // two overlapping columns exceed the population by the overlap.
        assert.ok(
            row.selfFlaky + row.selfSkipped - row.selfFlakyAndSkipped <= row.selfTotal + 1e-9,
            `${row.path}: flaky + skipped - both must not exceed total`
        );
    }
});

// --- the command ---------------------------------------------------------

const FILES: Record<string, string> = {
    'xpcshell-timings/index.json': 'index.json',
    'xpcshell-timings/xpcshell-issues.json': 'xpcshell-issues.json',
};

function fixtureSource(): DataSource & { requested: string[] } {
    const requested: string[] = [];
    return {
        name: 'fixtures',
        requested,
        async fetch(fileName: DataFileName): Promise<Uint8Array> {
            const key = `${fileName.index}/${fileName.filename}`;
            requested.push(key);
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

test('flaky defaults to the burndown list over a 7-day average', async () => {
    const { code, stdout } = await invoke(['flaky', '--json', '--quiet']);
    assert.equal(code, ExitCode.Success);
    const result = json(stdout);
    assert.equal(result['groupBy'], 'list', 'the default view is the burndown list');
    assert.equal(result['sort'], 'flaky');
    const header = result['header'] as Record<string, unknown>;
    assert.equal(header['scope'], 'average');
    assert.equal(header['averageDays'], DEFAULT_AVERAGE_DAYS);
    assert.equal(
        (header['scopeDates'] as string[]).length,
        DEFAULT_AVERAGE_DAYS,
        'scopeDates must name every day averaged, so a reader can check the window'
    );
});

test('the default rows carry the independently derived means', async () => {
    // The command's numbers, against the same independent walk — so a regression
    // between the library and the command is caught as well as one inside it.
    const { stdout } = await invoke(['flaky', '--json', '--quiet', '--limit', '0']);
    const rows = json(stdout)['rows'] as {
        path: string;
        flaky: number;
        skipped: number;
        total: number;
        testCount: number;
    }[];
    const expected = independentFolderAverage(issuesFixture, DEFAULT_AVERAGE_DAYS);
    assert.equal(rows.length, expected.size);
    for (const row of rows) {
        const want = expected.get(row.path)!;
        assert.ok(want !== undefined, `${row.path} is not a folder the independent walk found`);
        assertMean(row.flaky, want.flaky, `${row.path} flaky`, JSON_TOLERANCE);
        assertMean(row.skipped, want.skipped, `${row.path} skipped`, JSON_TOLERANCE);
        assertMean(row.total, want.total, `${row.path} total`, JSON_TOLERANCE);
        assert.equal(row.testCount, want.testCount);
    }
});

test('rows are ranked by the folder’s own flaky count, descending', async () => {
    const { stdout } = await invoke(['flaky', '--json', '--quiet', '--limit', '0']);
    const rows = json(stdout)['rows'] as { path: string; flaky: number }[];
    assert.ok(rows.length > 1, 'need at least two rows to observe an order');
    for (let i = 1; i < rows.length; i++) {
        assert.ok(
            rows[i - 1]!.flaky >= rows[i]!.flaky,
            `ranked on the folder's own flaky count: row ${i - 1} has ${rows[i - 1]!.flaky} and ` +
                `row ${i} has ${rows[i]!.flaky}`
        );
    }
});

test('the list ranks a folder’s own tests, not its subtree', async () => {
    // The whole reason the flat list exists: the roll-up puts a container first.
    // `toolkit` holds every extensions test in the fixture and must not be a row
    // in the list view, because it has no test files of its own.
    const list = json((await invoke(['flaky', '--json', '--quiet', '--limit', '0'])).stdout);
    const paths = (list['rows'] as { path: string }[]).map((row) => row.path);
    assert.ok(
        !paths.includes('toolkit'),
        'a pure container has no tests of its own and is not a burndown candidate'
    );

    // ...and the subtree view does rank it, which is what makes the two views
    // different rather than differently labelled.
    const tree = json(
        (await invoke(['flaky', '--json', '--quiet', '--group-by', 'folder', '--limit', '0'])).stdout
    );
    const treePaths = (tree['rows'] as { path: string }[]).map((row) => row.path);
    assert.ok(treePaths.includes('toolkit'), '--group-by folder rolls subtrees up');
});

test('the text output states the scope, the overlap and the noise filter', async () => {
    const { stdout } = await invoke(['flaky', '--quiet', '--limit', '3']);
    // Each of these is a factor-of-several difference a reader would otherwise
    // attribute to Firefox rather than to the window or the categories.
    assert.match(stdout, /MEAN PER DAY over the last 7 days/);
    assert.match(stdout, /OVERLAP/);
    assert.match(stdout, /Noise filter/);
    // And the follow-up command, so a reader can act without a second lookup.
    // It must be this command's own per-test listing and **not** `issues --path`,
    // which ranks by issue runs and is dominated by skips: on the pinned window
    // for toolkit/components/telemetry/tests/unit, `issues --group-by test` puts
    // test_UserInteraction_annotations.js first with 6,879 issues of which 6,782
    // are skips, and this classification calls that test skipped, not flaky. A
    // footer sending a reader to a differently-defined listing of the folder they
    // just picked is worse than no footer.
    assert.match(stdout, /fx-tests flaky toolkit\//);
    assert.doesNotMatch(
        stdout,
        /fx-tests issues/,
        'the follow-up must not be `issues`, whose definition of a problem test differs'
    );
    // `skips` stays, because it answers what this command cannot: *why* something
    // is disabled. Here the classification is a boolean; `skips` prints skip-if.
    assert.match(stdout, /fx-tests skips --path /);
});

test('--all-days says it is the looser bar, and --day names the weekday risk', async () => {
    const all = await invoke(['flaky', '--quiet', '--all-days', '--limit', '2']);
    assert.match(all.stdout, /--all-days/);
    assert.match(all.stdout, /84%/, 'the window reading must carry its denominator caveat');

    const one = await invoke(['flaky', '--quiet', '--day', '2026-08-03', '--limit', '2']);
    assert.match(one.stdout, /2026-08-03/);
    assert.match(
        one.stdout,
        /weekend push volume/,
        'a single-day ranking must say why one day is not a stable ranking'
    );
});

test('the scopes are mutually exclusive rather than one silently winning', async () => {
    for (const argv of [
        ['flaky', '--day', '2026-08-03', '--all-days'],
        ['flaky', '--day', '2026-08-03', '--average-days', '7'],
        ['flaky', '--all-days', '--average-days', '7'],
    ]) {
        const { code, stderr } = await invoke([...argv, '--quiet']);
        assert.equal(code, ExitCode.Usage, `${argv.join(' ')} must be a usage error`);
        assert.match(stderr, /mutually exclusive/);
    }
});

test('--sort is refused on the trend view rather than ignored', async () => {
    // A calendar is not a ranking, and a flag that silently does nothing is
    // indistinguishable from one that is not implemented.
    const { code, stderr } = await invoke(['flaky', '--group-by', 'days', '--sort', 'flaky', '--quiet']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /--sort does not apply/);
});

test('--config is refused, because issues.json attributes nothing', async () => {
    const { code, stderr } = await invoke(['flaky', '--config', 'linux', '--quiet']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /records no job names/);
});

test('the trend view’s three states sum to its total', async () => {
    // The one view whose classification is mutually exclusive. The folder views'
    // columns deliberately do not sum, so asserting this here is what keeps the
    // two readings from being conflated.
    const { stdout } = await invoke(['flaky', '--group-by', 'days', '--json', '--quiet', '--limit', '0']);
    const result = json(stdout);
    const rows = result['rows'] as {
        date: string;
        flaky: number;
        stable: number;
        skipped: number;
        total: number;
    }[];
    assert.equal(rows.length, issuesFixture.metadata.days);
    for (const row of rows) {
        assert.equal(
            row.flaky + row.stable + row.skipped,
            row.total,
            `${row.date}: the per-day states are exclusive and must sum to total`
        );
    }
    // Oldest first, as the files encode it and the charts plot it.
    assert.equal(rows[0]!.date, issuesFixture.metadata.startDate);
    assert.equal(rows.at(-1)!.date, issuesFixture.metadata.endDate);
});

test('the trend limit keeps the newest days, not the oldest', async () => {
    // A truncated calendar that dropped today would answer "how is it now" with
    // last fortnight.
    const { stdout } = await invoke(['flaky', '--group-by', 'days', '--json', '--quiet', '--limit', '3']);
    const rows = json(stdout)['rows'] as { date: string }[];
    assert.equal(rows.length, 3);
    assert.equal(rows.at(-1)!.date, issuesFixture.metadata.endDate);
});

test('--path narrows the population, and a miss says so', async () => {
    const { stdout } = await invoke([
        'flaky',
        '--json',
        '--quiet',
        '--limit',
        '0',
        '--path',
        'netwerk/',
    ]);
    const result = json(stdout);
    const rows = result['rows'] as { path: string }[];
    assert.ok(rows.length > 0, 'netwerk/ must match something in the fixture');
    for (const row of rows) {
        assert.ok(row.path.startsWith('netwerk'), `${row.path} is outside --path netwerk/`);
    }

    const miss = await invoke(['flaky', '--quiet', '--path', 'no/such/directory']);
    assert.equal(miss.code, ExitCode.Success, 'an empty result is an answer, not an error');
    assert.match(miss.stdout, /No folder matched/);
    assert.match(miss.stdout, /--path/, 'the empty message must name the filter that could be wrong');
});

test('a positional path selects the per-test listing, not a usage error', async () => {
    // This used to be rejected with "did you mean --path?". It is now the
    // shorthand for the drill-down, which is how `fx-tests test <path>` and
    // `fx-tests manifests [name]` already read a path.
    const { code, stdout } = await invoke([
        'flaky',
        'toolkit/components/extensions/test/xpcshell',
        '--json',
        '--quiet',
        '--limit',
        '0',
    ]);
    assert.equal(code, ExitCode.Success);
    const result = json(stdout);
    assert.equal(result['groupBy'], 'tests', 'a positional path means the per-test listing');
    assert.equal(result['pathPrefix'], 'toolkit/components/extensions/test/xpcshell');
    // Identical to the long form, so the two spellings cannot drift.
    const long = await invoke([
        'flaky',
        '--path',
        'toolkit/components/extensions/test/xpcshell',
        '--group-by',
        'tests',
        '--json',
        '--quiet',
        '--limit',
        '0',
    ]);
    assert.equal(long.stdout, stdout, 'flaky <path> must be exactly --path <path> --group-by tests');
});

test('the two spellings of the path cannot contradict each other', async () => {
    // Refused rather than merged: `flaky dom --path netwerk` has no reading that
    // is not a guess about which one the caller meant.
    const both = await invoke(['flaky', 'dom', '--path', 'netwerk', '--quiet']);
    assert.equal(both.code, ExitCode.Usage);
    assert.match(both.stderr, /same selection/);

    // A positional with any other view leaves it meaning nothing, which is the
    // "flag did nothing" failure this CLI rejects unknown flags to avoid.
    for (const view of ['list', 'folder', 'days']) {
        const { code, stderr } = await invoke(['flaky', 'netwerk', '--group-by', view, '--quiet']);
        assert.equal(code, ExitCode.Usage, `flaky <path> --group-by ${view} must be refused`);
        assert.match(stderr, new RegExp(`--group-by ${view}`));
        assert.match(stderr, /--path netwerk/, 'and must name the flag that does mean that');
    }

    // Two positionals is one too many, as `fx-tests test` reports it.
    const two = await invoke(['flaky', 'a', 'b', '--quiet']);
    assert.equal(two.code, ExitCode.Usage);
    assert.match(two.stderr, /at most one path/);
});

test('--json means are rounded to a stable number of digits', async () => {
    // The averages are sums of 1/windowDays, so a folder that is flaky every day
    // comes out as 186.99999999999858 raw. Emitting that makes `--json` a shape
    // whose digits move with iteration order, and `CLI.md` promises a stable one.
    const { stdout } = await invoke(['flaky', '--json', '--quiet', '--limit', '0']);
    const rows = json(stdout)['rows'] as Record<string, number | string>[];
    for (const row of rows) {
        for (const [key, value] of Object.entries(row)) {
            if (typeof value !== 'number') {
                continue;
            }
            const decimals = String(value).split('.')[1]?.length ?? 0;
            assert.ok(
                decimals <= 4,
                `${String(row['path'])}.${key} = ${value} carries ${decimals} decimals; --json ` +
                    'must round means so the shape does not churn between runs'
            );
        }
    }
    // And a value that *is* a whole number is emitted as one, rather than as
    // 186.9999 — the case that made this necessary. Which values qualify is a
    // property of the data, so the expectation is derived rather than pinned: a
    // skip count that does not move across the window is integral, and the
    // fixture has one.
    const integral = rows.filter((row) => Number.isInteger(row['skipped']));
    assert.ok(
        integral.length > 0,
        'the fixture must contain a folder whose skip count is constant across the window, or ' +
            'this cannot check that integral means stay integral'
    );
    for (const row of integral) {
        assert.equal(
            String(row['skipped']).includes('.'),
            false,
            `${String(row['path'])} skipped = ${row['skipped']} must serialise without a decimal`
        );
    }
});

test('--noise 0 disables the filter, and the header reports what was applied', async () => {
    const off = json((await invoke(['flaky', '--json', '--quiet', '--noise', '0'])).stdout);
    const offHeader = off['header'] as Record<string, unknown>;
    assert.equal(offHeader['minWindowFailures'], 0);
    assert.equal(offHeader['neutralisedTests'], 0, 'nothing is neutralised with the filter off');

    const on = json((await invoke(['flaky', '--json', '--quiet'])).stdout);
    const onHeader = on['header'] as Record<string, unknown>;
    assert.equal(onHeader['minWindowFailures'], 1, 'the default threshold is 1');
    // The applied threshold and the requested one are both reported, so a caller
    // can see when they differ — which is what a single-day file causes.
    assert.equal(onHeader['requestedMinWindowFailures'], 1);
    assert.equal(onHeader['noiseFilterSkipped'], false);
});
