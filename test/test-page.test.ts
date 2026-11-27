/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** `site/test.ts`, the Test Info page, started in jsdom on a web-platform-test. */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { type Harness, fixture, setupPage } from './dom-harness.ts';
import type { BucketFile } from '../lib/formats/buckets.ts';
import type { SubtestsFile } from '../lib/formats/subtests.ts';
import { start } from '../site/test.ts';
import { testPageUrl } from '../site/test-link.ts';

const WPT = fixture<BucketFile>('wpt-00.json');
const WPT_SUBTESTS = fixture<SubtestsFile>('wpt-subtests-00.json');

const COOP_TEST = 'testing/web-platform/tests/html/cross-origin-opener-policy/resource-popup.https.html';
const MOVING_TEST =
    'testing/web-platform/tests/html/semantics/scripting-1/the-script-element/' +
    'moving-between-documents/after-prepare-createHTMLDocument-parse-error-external-classic.html';
/** In the timing bucket and not in the subtests file: it is disabled. */
const WITHOUT_SUBTESTS = 'testing/web-platform/tests/webusb/usb.serviceworker.https.html';

const ORIGIN = 'https://tests.firefox.dev/';

interface Logged {
    errors: unknown[][];
    warnings: unknown[][];
}

/** Starts the page at a URL, recording `console.error` and `console.warn` meanwhile. */
async function load(
    url: string,
    files: Record<string, unknown>
): Promise<{ page: Harness; logged: Logged }> {
    const page = setupPage({ page: 'test', url, files });
    const logged: Logged = { errors: [], warnings: [] };
    const { error, warn } = console;
    console.error = (...args: unknown[]): void => void logged.errors.push(args);
    console.warn = (...args: unknown[]): void => void logged.warnings.push(args);
    try {
        await start();
    } finally {
        console.error = error;
        console.warn = warn;
    }
    return { page, logged };
}

function urlOf(testPath: string): string {
    return `${ORIGIN}test.html?test=${encodeURIComponent(testPath)}`;
}

function section(page: Harness): HTMLElement | null {
    return page.document.getElementById('subtests-section');
}

function subtestRows(page: Harness): HTMLElement[] {
    return [...page.document.querySelectorAll<HTMLElement>('#subtests-section tr.subtest-row')];
}

/** A row's four cells as text: name, passed, expected failures, unexpected results. */
function cellsOf(row: HTMLElement): string[] {
    return [...row.children].map((cell) => cell.textContent ?? '');
}

function pageWithoutSubtests(page: Harness): string {
    const copy = page.content.cloneNode(true) as HTMLElement;
    copy.querySelector('#subtests-section')?.remove();
    return copy.innerHTML;
}

function assertHealthy(page: Harness, logged: Logged, message: string): void {
    assert.deepEqual(logged.errors, [], `${message}: nothing logged as an error`);
    assert.equal(page.document.getElementById('error')!.style.display, 'none', message);
    assert.equal(page.content.querySelectorAll('.summary-stat').length, 6, message);
    assert.notEqual(page.content.querySelector('.job-table'), null, message);
    for (const line of page.content.querySelectorAll<HTMLElement>('.status-line')) {
        assert.equal(line.style.color, '', `${message}: the status line is not an error`);
        assert.doesNotMatch(line.textContent ?? '', /error|not found/i, message);
    }
}

// --- the section -----------------------------------------------------------

test('a wpt test fetches its subtests bucket and lists them, unexpected results first', async () => {
    const { page, logged } = await load(urlOf(COOP_TEST), {
        'wpt-00.json': WPT,
        'wpt-subtests-00.json': WPT_SUBTESTS,
    });
    try {
        // The wpt bucket, though the name ends in `.html`, then its subtests.
        assert.deepEqual(page.requested, ['wpt-00.json', 'wpt-subtests-00.json']);
        assertHealthy(page, logged, COOP_TEST);
        assert.deepEqual(logged.warnings, []);
        assert.equal(page.content.querySelector('.harness-badge')!.textContent, 'wpt');

        const subtests = section(page);
        assert.notEqual(subtests, null);
        // Last on the page, so that arriving late it moves nothing above it.
        assert.equal(page.content.lastElementChild, subtests);
        assert.equal(subtests!.querySelector('h2')!.textContent, 'Subtests (2 days, 2026-11-21 to 2026-11-22)');
        assert.equal(
            subtests!.querySelector('.subtests-summary')!.textContent,
            '12 subtests · 1 with unexpected results · 0 with expected failures · 11 only passed'
        );

        const rows = subtestRows(page);
        assert.equal(rows.length, 12);
        // The subtest that timed out is tenth in the file and first here.
        assert.deepEqual(cellsOf(rows[0]!), [
            '▸/media/2x2-green.mp4 - parent COOP: ""; child COOP: "same-origin"',
            '6',
            '',
            '2KNOWN-INTERMITTENT-TIMEOUT',
        ]);
        assert.ok(rows[0]!.classList.contains('subtest-unexpected'));
        assert.deepEqual(cellsOf(rows[1]!), [
            '/common/dummy.xml - parent COOP: ""; child COOP: "same-origin"',
            '8',
            '',
            '',
        ]);
        assert.ok(rows.slice(1).every((row) => row.classList.contains('subtest-pass')));
        assert.equal(subtests!.querySelector('.subtests-filter'), null);
        assert.equal(subtests!.querySelector<HTMLElement>('.subtests-footer')!.style.display, 'none');
        // A row that only passed has nothing to open.
        assert.equal(rows[1]!.querySelector('button'), null);
        rows[1]!.click();
        assert.equal(subtests!.querySelector('.subtest-detail'), null);
    } finally {
        page.restore();
    }
});

test('an unexpected result opens to its date, status, job, task link and message', async () => {
    const { page } = await load(urlOf(COOP_TEST), {
        'wpt-00.json': WPT,
        'wpt-subtests-00.json': WPT_SUBTESTS,
    });
    try {
        const [row] = subtestRows(page);
        const toggle = row!.querySelector('button')!;
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');
        assert.equal(section(page)!.querySelector('.subtest-detail'), null);

        toggle.click();
        const detail = row!.nextElementSibling as HTMLElement;
        assert.ok(detail.classList.contains('subtest-detail'));
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
        assert.equal(detail.querySelector('h4')!.textContent, 'Unexpected results');

        const results = [...detail.querySelectorAll('.issue-runs tr')];
        assert.deepEqual(
            results.map((result) => [...result.children].map((cell) => cell.textContent)),
            [
                [
                    '2026-11-22',
                    'KNOWN-INTERMITTENT-TIMEOUT',
                    'test-linux2404-64/debug-web-platform-tests-nofis-33',
                    'Test timed out',
                    'View: Profile Job',
                ],
                [
                    '2026-11-21',
                    'KNOWN-INTERMITTENT-TIMEOUT',
                    'test-linux2404-64/debug-web-platform-tests-nofis-32',
                    'Test timed out',
                    'View: Profile Job',
                ],
            ]
        );
        assert.ok(results[0]!.querySelector('.issue-badge')!.classList.contains('badge-timeout'));

        // The task's page, its profile searched for this test, its Treeherder job.
        const links = [...results[0]!.querySelectorAll('a')].map((a) => a.getAttribute('href'));
        assert.deepEqual(links, [
            'task.html?task=CLry8KtFR-eAY4VGehyChQ.0' +
                '&test=testing%2Fweb-platform%2Ftests%2Fhtml%2Fcross-origin-opener-policy%2Fresource-popup.https.html',
            'https://profiler.firefox.com/from-url/' +
                'https%3A%2F%2Ffirefox-ci-tc.services.mozilla.com%2Fapi%2Fqueue%2Fv1%2Ftask%2F' +
                'CLry8KtFR-eAY4VGehyChQ%2Fruns%2F0%2Fartifacts%2Fpublic%2Fprofile_run-task-resource-usage.json' +
                '?profileName=test-linux2404-64%2Fdebug-web-platform-tests-nofis-33%20(CLry8KtFR-eAY4VGehyChQ.0)' +
                '&markerSearch=resource-popup.https.html',
            'https://treeherder.mozilla.org/jobs?repo=mozilla-central' +
                '&selectedTaskRun=CLry8KtFR-eAY4VGehyChQ.0' +
                '&revision=254865aba31f7e1570dc915e5821972b2464fe6f',
        ]);

        // A second click closes it, and keeps it for a third.
        row!.click();
        assert.equal(detail.style.display, 'none');
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');
        row!.click();
        assert.equal(detail.style.display, '');
        assert.equal(section(page)!.querySelectorAll('.subtest-detail').length, 1);
    } finally {
        page.restore();
    }
});

test('an expected failure opens to its jobs and their counts, apart from the unexpected results', async () => {
    const { page } = await load(urlOf(MOVING_TEST), {
        'wpt-00.json': WPT,
        'wpt-subtests-00.json': WPT_SUBTESTS,
    });
    try {
        assert.equal(
            section(page)!.querySelector('.subtests-summary')!.textContent,
            '5 subtests · 2 with unexpected results · 2 with expected failures · 3 only passed'
        );
        const rows = subtestRows(page);
        assert.deepEqual(cellsOf(rows[0]!).slice(1), ['2', '4KNOWN-FAIL', '2KNOWN-INTERMITTENT-PASS']);
        const expectedBadge = rows[0]!.querySelector('.subtest-expected-cell .issue-badge')!;
        const unexpectedBadge = rows[0]!.querySelector('.subtest-unexpected-cell .issue-badge')!;
        assert.ok(expectedBadge.classList.contains('badge-expected'));
        assert.ok(unexpectedBadge.classList.contains('badge-pass'));

        rows[0]!.click();
        const detail = rows[0]!.nextElementSibling as HTMLElement;
        assert.deepEqual(
            [...detail.querySelectorAll('h4')].map((heading) => heading.textContent),
            ['Unexpected results', 'Expected failures']
        );
        const [unexpected, expected] = [...detail.querySelectorAll('.issue-runs')];
        assert.equal(unexpected!.querySelectorAll('tr').length, 2);
        assert.equal(
            expected!.querySelector('.subtest-expected-status')!.textContent,
            'KNOWN-FAIL4 results on 2 jobs'
        );
        assert.deepEqual(
            [...expected!.querySelectorAll('tr')].map((job) =>
                [...job.children].map((cell) => cell.textContent)
            ),
            [
                ['2', 'test-linux2404-64/debug-web-platform-tests'],
                ['2', 'test-linux2404-64/debug-web-platform-tests-nofis'],
            ]
        );
    } finally {
        page.restore();
    }
});

test('a click that ends a text selection does not open the row', async () => {
    const { page } = await load(urlOf(COOP_TEST), {
        'wpt-00.json': WPT,
        'wpt-subtests-00.json': WPT_SUBTESTS,
    });
    try {
        const [row] = subtestRows(page);
        // Dragging across a name to select it ends in a click on the row.
        const range = page.document.createRange();
        range.selectNodeContents(row!.querySelector('.subtest-name')!);
        page.window.getSelection()!.addRange(range);
        row!.click();
        assert.equal(section(page)!.querySelector('.subtest-detail'), null);
        // The button still works: it is the keyboard's way in.
        row!.querySelector('button')!.click();
        assert.notEqual(section(page)!.querySelector('.subtest-detail'), null);
    } finally {
        page.restore();
    }
});

// --- the URL ---------------------------------------------------------------

const VARIANT = '?url=/common/blank.html&x=1#frag';
const VARIANT_TEST = `${COOP_TEST}${VARIANT}`;

/** The file with one test renamed to carry a variant: the fixture has none. */
function withVariant<T extends { tables: { testNames: string[] } }>(file: T): T {
    const copy = structuredClone(file);
    const nameId = copy.tables.testNames.indexOf('resource-popup.https.html');
    assert.notEqual(nameId, -1);
    copy.tables.testNames[nameId] = `resource-popup.https.html${VARIANT}`;
    return copy;
}

test('a wpt path with ? # & = and / in its variant survives the link into the page', async () => {
    // `withDevParams` inserts before a `#`, and must not take the variant's for one.
    const linking = setupPage({ page: 'test', url: `${ORIGIN}tests.html?data-source=local` });
    let href: string;
    try {
        href = testPageUrl(VARIANT_TEST);
    } finally {
        linking.restore();
    }
    assert.equal(
        href,
        'test.html?test=testing%2Fweb-platform%2Ftests%2Fhtml%2Fcross-origin-opener-policy%2F' +
            'resource-popup.https.html%3Furl%3D%2Fcommon%2Fblank.html%26x%3D1%23frag' +
            '&data-source=local'
    );

    const { page, logged } = await load(new URL(href, ORIGIN).href, {
        // `08` is where the path with its variant hashes to.
        'wpt-08.json': withVariant(WPT),
        'wpt-subtests-08.json': withVariant(WPT_SUBTESTS),
    });
    try {
        assert.deepEqual(page.requested, ['wpt-08.json', 'wpt-subtests-08.json']);
        assertHealthy(page, logged, VARIANT_TEST);
        assert.equal(page.window.__testState!()!.testPath, VARIANT_TEST);

        // The name is the file and its variant, not `blank.html&x=1#frag`.
        const name = `resource-popup.https.html${VARIANT}`;
        assert.equal(page.content.querySelector('h1')!.firstChild!.textContent, name);
        assert.equal(page.document.title, `${name} - Test Info`);
        // Five folders and the name: the `/` of the variant made no sixth.
        const folders = [...page.content.querySelectorAll('.path-segment')];
        assert.deepEqual(
            folders.map((link) => link.textContent),
            ['testing', 'web-platform', 'tests', 'html', 'cross-origin-opener-policy']
        );
        assert.equal(
            folders.at(-1)!.getAttribute('href'),
            'tests.html?path=testing%2Fweb-platform%2Ftests%2Fhtml%2Fcross-origin-opener-policy'
        );
        const file = page.content.querySelector('.path-file')!;
        assert.equal(file.textContent, name);
        assert.equal(
            file.getAttribute('href'),
            `https://searchfox.org/mozilla-central/source/${COOP_TEST}`
        );
        assert.equal(page.content.querySelector('.test-path-line')!.textContent, `${VARIANT_TEST}📋 Copy`);

        assert.equal(subtestRows(page).length, 12);
        // The links out of the page carry the variant whole.
        subtestRows(page)[0]!.click();
        const [task, profile] = [...section(page)!.querySelectorAll('.subtest-detail a')].map((a) =>
            a.getAttribute('href')!
        );
        assert.equal(new URLSearchParams(task!.slice(task!.indexOf('?'))).get('test'), VARIANT_TEST);
        assert.equal(new URLSearchParams(task!.slice(task!.indexOf('?'))).get('data-source'), 'local');
        assert.ok(
            profile!.endsWith(
                '&markerSearch=resource-popup.https.html%3Furl%3D%2Fcommon%2Fblank.html%26x%3D1%23frag'
            ),
            profile
        );
    } finally {
        page.restore();
    }
});

// --- the bound -------------------------------------------------------------

/** The subtests bucket with `copies` more of `MOVING_TEST`'s five subtests, numbered. */
function withManySubtests(copies: number): SubtestsFile {
    const file = structuredClone(WPT_SUBTESTS);
    const { tables, subtests } = file;
    // The last test of the file, so no other test's subtest ids move.
    const testId = file.testInfo.testPathIds.length - 1;
    const count = subtests.countsByTest[testId]!;
    const first = subtests.nameIds.length - count;
    assert.equal(count, 5);

    const { expectedFailures, unexpected } = subtests;
    const expectedRows = expectedFailures.subtestIds.flatMap((id, row) => (id >= first ? [row] : []));
    const unexpectedRows = unexpected.subtestIds.flatMap((id, row) => (id >= first ? [row] : []));
    for (let copy = 1; copy <= copies; copy++) {
        for (let offset = 0; offset < count; offset++) {
            const name = tables.subtestNames[subtests.nameIds[first + offset]!]!;
            subtests.nameIds.push(tables.subtestNames.push(`${name} #${copy}`) - 1);
            subtests.passCounts.push(subtests.passCounts[first + offset]!);
        }
        for (const row of expectedRows) {
            expectedFailures.subtestIds.push(expectedFailures.subtestIds[row]! + copy * count);
            expectedFailures.statusIds.push(expectedFailures.statusIds[row]!);
            expectedFailures.jobNameIds.push(expectedFailures.jobNameIds[row]!);
            expectedFailures.counts.push(expectedFailures.counts[row]!);
        }
        for (const row of unexpectedRows) {
            unexpected.subtestIds.push(unexpected.subtestIds[row]! + copy * count);
            unexpected.statusIds.push(unexpected.statusIds[row]!);
            unexpected.taskIdIds.push(unexpected.taskIdIds[row]!);
            unexpected.messageIds.push(unexpected.messageIds[row]!);
            unexpected.days!.push(unexpected.days![row]!);
        }
    }
    subtests.countsByTest[testId] = count * (copies + 1);
    return file;
}

test('a test with hundreds of subtests draws 100 rows, and 100 more each time it is asked', async () => {
    // 305 subtests: 122 with unexpected results, 183 that only passed.
    const { page, logged } = await load(urlOf(MOVING_TEST), {
        'wpt-00.json': WPT,
        'wpt-subtests-00.json': withManySubtests(60),
    });
    try {
        assertHealthy(page, logged, 'many subtests');
        const subtests = section(page)!;
        assert.equal(
            subtests.querySelector('.subtests-summary')!.textContent,
            '305 subtests · 122 with unexpected results · 122 with expected failures · 183 only passed'
        );

        assert.equal(subtestRows(page).length, 100);
        assert.equal(subtests.querySelectorAll('tbody > tr').length, 100);
        assert.ok(subtestRows(page).every((row) => row.classList.contains('subtest-unexpected')));
        const more = subtests.querySelector<HTMLButtonElement>('.subtests-more')!;
        const count = subtests.querySelector('.subtests-count')!;
        assert.equal(more.textContent, 'Show 100 more');
        assert.equal(count.textContent, 'Showing 100 of 305 subtests');

        // "More" appends: a row opened before is still open after.
        const opened = subtestRows(page)[0]!;
        opened.click();
        more.click();
        assert.equal(subtestRows(page).length, 200);
        assert.equal(subtestRows(page)[0], opened);
        assert.ok(opened.nextElementSibling!.classList.contains('subtest-detail'));
        assert.ok(subtestRows(page)[121]!.classList.contains('subtest-unexpected'));
        assert.ok(subtestRows(page)[122]!.classList.contains('subtest-pass'));
        assert.equal(count.textContent, 'Showing 200 of 305 subtests');

        more.click();
        assert.equal(subtestRows(page).length, 300);
        assert.equal(more.textContent, 'Show 5 more');
        more.click();
        assert.equal(subtestRows(page).length, 305);
        assert.equal(more.style.display, 'none');
        assert.equal(subtests.querySelector<HTMLElement>('.subtests-footer')!.style.display, 'none');
    } finally {
        page.restore();
    }
});

test('the filter draws the subtests it keeps, a page at a time from the start', async () => {
    const { page } = await load(urlOf(MOVING_TEST), {
        'wpt-00.json': WPT,
        'wpt-subtests-00.json': withManySubtests(60),
    });
    try {
        const subtests = section(page)!;
        const input = subtests.querySelector<HTMLInputElement>('#subtests-filter')!;
        assert.equal(input.getAttribute('aria-label'), 'Filter subtests by name');
        const type = (value: string): void => {
            input.value = value;
            input.dispatchEvent(new page.window.Event('input'));
        };
        const more = subtests.querySelector<HTMLButtonElement>('.subtests-more')!;
        const count = subtests.querySelector('.subtests-count')!;

        // A pass-only row, three presses of the button away.
        type('sanity #57');
        assert.deepEqual(
            subtestRows(page).map((row) => cellsOf(row)[0]),
            ['Sanity check around top-level Window #57']
        );
        assert.equal(count.textContent, 'Showing 1 of 1 matching subtest, of 305');
        assert.equal(more.style.display, 'none');

        more.style.display = '';
        type('Move parse-error');
        // Four of the five names have it, in 61 copies.
        assert.equal(count.textContent, 'Showing 100 of 244 matching subtests, of 305');
        assert.equal(subtestRows(page).length, 100);
        more.click();
        assert.equal(subtestRows(page).length, 200);
        // Typing starts over from one page rather than keeping the 200.
        type('Move parse-error external');
        assert.equal(subtestRows(page).length, 100);

        type('no such subtest');
        assert.equal(subtestRows(page).length, 0);
        assert.equal(count.textContent, 'No subtest matches, of 305');

        type('');
        assert.equal(subtestRows(page).length, 100);
        assert.equal(count.textContent, 'Showing 100 of 305 subtests');
    } finally {
        page.restore();
    }
});

// --- no section ------------------------------------------------------------

test('no Subtests section, and no error, when the subtests file is not published', async () => {
    const { page, logged } = await load(urlOf(COOP_TEST), { 'wpt-00.json': WPT });
    try {
        assert.deepEqual(page.requested, ['wpt-00.json', 'wpt-subtests-00.json']);
        assert.equal(section(page), null);
        assertHealthy(page, logged, 'unpublished');
        assert.deepEqual(logged.warnings, []);
        assert.equal(page.window.__testState!()!.subtests, null);

        const withFile = await load(urlOf(COOP_TEST), {
            'wpt-00.json': WPT,
            'wpt-subtests-00.json': WPT_SUBTESTS,
        });
        try {
            assert.notEqual(section(withFile.page), null);
            assert.equal(pageWithoutSubtests(withFile.page), page.content.innerHTML);
        } finally {
            withFile.page.restore();
        }
    } finally {
        page.restore();
    }
});

test('no Subtests section, and no error, for a test the subtests file does not have', async () => {
    const { page, logged } = await load(urlOf(WITHOUT_SUBTESTS), {
        'wpt-00.json': WPT,
        'wpt-subtests-00.json': WPT_SUBTESTS,
    });
    try {
        assert.deepEqual(page.requested, ['wpt-00.json', 'wpt-subtests-00.json']);
        assert.equal(section(page), null);
        assertHealthy(page, logged, 'no subtests');
        assert.deepEqual(logged.warnings, []);

        const unpublished = await load(urlOf(WITHOUT_SUBTESTS), { 'wpt-00.json': WPT });
        try {
            assert.equal(unpublished.page.content.innerHTML, page.content.innerHTML);
        } finally {
            unpublished.page.restore();
        }
    } finally {
        page.restore();
    }
});

test('no Subtests section, and no page error, when the subtests file cannot be read', async () => {
    const unpublished = await load(urlOf(COOP_TEST), { 'wpt-00.json': WPT });
    const expected = unpublished.page.content.innerHTML;
    unpublished.page.restore();

    const text = readFileSync(new URL('./fixtures/wpt-subtests-00.json', import.meta.url), 'utf8');
    const short = structuredClone(WPT_SUBTESTS);
    short.subtests.passCounts.pop();
    const cases: [string, unknown][] = [
        ['truncated JSON', new Response(text.slice(0, text.length >> 1), { status: 200 })],
        ['arrays that disagree', short],
        ['another shape of file', { metadata: {} }],
    ];

    for (const [name, body] of cases) {
        const { page, logged } = await load(urlOf(COOP_TEST), {
            'wpt-00.json': WPT,
            'wpt-subtests-00.json': body,
        });
        try {
            assert.equal(section(page), null, name);
            assertHealthy(page, logged, name);
            assert.equal(page.content.innerHTML, expected, name);
            // A broken file gets one warning that names it, not a page error.
            assert.equal(logged.warnings.length, 1, name);
            assert.match(String(logged.warnings[0]![0]), /wpt-subtests-00\.json/, name);
        } finally {
            page.restore();
        }
    }
});

test('a test of another harness never asks for a subtests file', async () => {
    const cases: [string, string][] = [
        ['xpcshell-00.json', 'xpcshell'],
        ['mochitest-00.json', 'mochitest'],
    ];
    for (const [filename, harness] of cases) {
        const bucket = fixture<BucketFile>(filename);
        const testPath = `${bucket.tables.testPaths[bucket.testInfo.testPathIds[0]!]}/${bucket.tables.testNames[bucket.testInfo.testNameIds[0]!]}`;
        // The subtests fixture is on offer: not showing it is the page's decision.
        const { page, logged } = await load(urlOf(testPath), {
            [filename]: bucket,
            'wpt-subtests-00.json': WPT_SUBTESTS,
            [`${harness}-subtests-00.json`]: WPT_SUBTESTS,
        });
        try {
            assert.deepEqual(page.requested, [filename], testPath);
            assert.equal(page.content.querySelector('.harness-badge')!.textContent, harness);
            assert.equal(section(page), null, testPath);
            assertHealthy(page, logged, testPath);
            assert.deepEqual(logged.warnings, []);
        } finally {
            page.restore();
        }
    }
});
