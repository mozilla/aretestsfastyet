/// <reference lib="dom" />
/**
 * `tools/page-assets.ts` and the build step that uses it.
 *
 * ## The bug, and why 1,333 passing tests did not see it
 *
 * `site/index.ts` fetches a committed sibling — `mochitest-stats-backfill.json`
 * — from code rather than from a tag. The build discovered siblings by scanning
 * the HTML for `src=`/`href=` attributes, so it never saw that fetch, never
 * copied the file into `dist-site/`, and the deployed page's request 404'd.
 * The page treats a 404 backfill as "there is no backfill", so nothing threw:
 * the mochitest chart just showed 68 points from 2026-05-29 where it should
 * have shown 200 from 2026-01-17.
 *
 * `test/index-page.test.ts` has a test named "a missing backfill leaves the
 * mochitest charts on the live span" which asserts precisely that 68-point
 * behaviour. That test is right — graceful degradation is what the page should
 * do when the file is genuinely absent — and it is exactly why the suite was
 * silent. It answers "what does the page do without the file"; nothing answered
 * "does the built output contain the file".
 *
 * So this file asserts the other half, and asserts it against the **real build
 * output**: `npm run pages` into a scratch directory, then look in it. The two
 * layers are:
 *
 * 1. `findSiblingAssets` directly, on inputs written here.
 * 2. The build end to end, including driving the built page in jsdom over a
 *    `fetch` that can only see what the build actually copied.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';

import { findSiblingAssets } from '../tools/page-assets.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * The file whose absence was the bug.
 *
 * A literal, deliberately. Deriving it by scanning `site/index.ts` with the
 * same pattern the build uses would make the test agree with the scanner by
 * construction — it would pass just as happily if `FETCH_SIBLING` matched
 * nothing at all, which is the defect that produced this bug in the first
 * place. The name is pinned here and nowhere else.
 */
const BACKFILL = 'mochitest-stats-backfill.json';

/** The page that fetches it, likewise pinned. */
const PAGE = 'index.html';

// =========================================================================
// The scanner
// =========================================================================

test('a sibling fetched from code is found, not just one in a tag', () => {
    const html = `<html><script src="shared.js"></script>
        <script type="module">const r = await fetch("./${BACKFILL}");</script></html>`;
    assert.deepEqual(findSiblingAssets(html), [
        { name: BACKFILL, required: true },
        { name: 'shared.js', required: true },
    ]);
});

test('a fetched sibling is required unless the source says otherwise', () => {
    const html = `<script>fetch("./data.json");fetch("./maybe.json");</script>`;
    const source = '// build-optional: maybe.json — only some deploys have one.\n';
    assert.deepEqual(findSiblingAssets(html, [source]), [
        { name: 'data.json', required: true },
        { name: 'maybe.json', required: false },
    ]);
});

test('the marker names its file, so a multi-line explanation still applies', () => {
    // The real marker in `site/index.ts` runs to seven comment lines before the
    // call. A position-based directive would have silently stopped matching.
    const source = [
        '// build-optional: maybe.json — the first line of the reason,',
        '// which continues here, and here,',
        '// and here.',
        'const p = fetch("./maybe.json");',
    ].join('\n');
    assert.deepEqual(findSiblingAssets('fetch("./maybe.json")', [source]), [
        { name: 'maybe.json', required: false },
    ]);
});

test('a marker for one file does not exempt another', () => {
    const html = 'fetch("./a-backfill.json");fetch("./b-backfill.json");';
    const source = '// build-optional: a-backfill.json\n';
    assert.deepEqual(findSiblingAssets(html, [source]), [
        { name: 'a-backfill.json', required: false },
        { name: 'b-backfill.json', required: true },
    ]);
});

test('a tag keeps a file required even when a fetch of it is optional', () => {
    // The tag issues its request unconditionally, so the marker cannot make the
    // file optional overall.
    const html = '<script src="both.js"></script><script>fetch("./both.js")</script>';
    assert.deepEqual(findSiblingAssets(html, ['// build-optional: both.js\n']), [
        { name: 'both.js', required: true },
    ]);
});

test('only page-relative fetches count as siblings', () => {
    // A remote URL cannot be copied, a computed one cannot be resolved at build
    // time, and a `fetchData` name is a published CI artifact that never sits
    // next to the page. None of the three is a sibling.
    const html = [
        'fetch("https://example.com/remote.json");',
        'fetch("//cdn.example.com/proto.json");',
        'fetch(someUrl);',
        'fetch(`./${harness}-stats.json`);',
        'fetchData("mochitest-stats.json");',
    ].join('');
    assert.deepEqual(findSiblingAssets(html), []);
});

test('a sibling fetched twice is copied once', () => {
    assert.deepEqual(findSiblingAssets('fetch("./x.json");fetch("./x.json")'), [
        { name: 'x.json', required: true },
    ]);
});

// =========================================================================
// The build
// =========================================================================

/** `npm run pages` into a scratch directory. Built once, shared by the tests. */
let output: string | null = null;

function builtPages(): string {
    if (output === null) {
        output = mkdtempSync(join(tmpdir(), 'fx-pages-'));
        execFileSync(
            process.execPath,
            ['--experimental-strip-types', join(ROOT, 'tools', 'build-pages.ts')],
            { cwd: ROOT, env: { ...process.env, FX_PAGES_BUILD_OUT: output }, stdio: 'pipe' }
        );
    }
    return output;
}

after(() => {
    if (output !== null) {
        rmSync(output, { recursive: true, force: true });
    }
});

test('the built page ships the data file it fetches', () => {
    // The assertion the old scan could not make: not "does the page degrade
    // gracefully without the backfill", but "is the backfill there at all".
    assert.ok(
        existsSync(join(builtPages(), BACKFILL)),
        `${BACKFILL} is not next to the built ${PAGE}. The page fetches it with a ` +
            'relative URL, so it 404s and the charts silently lose six months of history.'
    );
});

test('the copied data file is the committed one, byte for byte', () => {
    assert.deepEqual(
        readFileSync(join(builtPages(), BACKFILL)),
        readFileSync(join(ROOT, BACKFILL)),
        'the build copied something other than the committed backfill'
    );
});

test('the built page still requests the file by the name that was copied', () => {
    // Guards the seam between the two halves: the scan could copy a file the
    // page no longer asks for, or the page could be renamed out from under a
    // hard-coded copy, and either way the 404 comes back.
    const built = readFileSync(join(builtPages(), PAGE), 'utf8');
    assert.ok(built.includes(`fetch("./${BACKFILL}")`), `the built ${PAGE} does not fetch ${BACKFILL}`);
});

// =========================================================================
// The built page, driven over its own output directory
// =========================================================================

/**
 * The mochitest history the page shows when its `fetch` can only see the files
 * the build produced.
 *
 * The point of going through jsdom rather than stopping at "the file exists" is
 * that it reproduces the user-visible symptom. `fetch` here is backed by the
 * build output directory and nothing else, so a file the build failed to copy
 * 404s exactly as it did in the browser.
 */
async function mochitestChartDates(): Promise<string[]> {
    const dir = builtPages();
    const markup = readFileSync(join(dir, PAGE), 'utf8');
    // The inlined module and the Plotly CDN tag are both dropped: jsdom must not
    // reach the network, and the module is `import`ed below instead so it runs
    // against the same stubs `test/index-page.test.ts` uses.
    const dom = new JSDOM(markup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''), {
        url: 'https://tests.firefox.dev/index.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });

    for (const name of ['fetch-utils.js', 'shared.js', 'dashboards.js']) {
        dom.window.eval(readFileSync(join(ROOT, name), 'utf8'));
    }

    const plots: { id: string; traces: Record<string, unknown>[] }[] = [];
    const scope = globalThis as unknown as Record<string, unknown>;
    const saved = new Map<string, unknown>();
    const set = (name: string, value: unknown): void => {
        if (!saved.has(name)) {
            saved.set(name, scope[name]);
        }
        scope[name] = value;
    };

    set('window', dom.window);
    set('document', dom.window.document);
    for (const name of ['Element', 'Node', 'HTMLElement', 'Event']) {
        set(name, (dom.window as unknown as Record<string, unknown>)[name]);
    }
    set('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
    for (const name of ['withDevParams', 'renderDashboardTeaser', 'setupWindowResize']) {
        set(name, (dom.window as unknown as Record<string, unknown>)[name]);
    }

    /** Serves a name out of the build output, or 404s exactly as a server would. */
    const serve = (name: string): Response => {
        const path = join(dir, name.replace(/^\.\//, ''));
        return existsSync(path)
            ? new Response(readFileSync(path, 'utf8'), { status: 200 })
            : new Response('not found', { status: 404 });
    };
    // The live artifacts are published by CI and gitignored, so they come from
    // `test/fixtures/` — the same pinned files `test/index-page.test.ts` uses,
    // which are a real capture of the 2026-05-29…2026-08-03 live span.
    //
    // The split is the whole design of this test. `fetchData` is *not* the
    // thing under test and is served from the fixtures unconditionally; the
    // plain `fetch` is served from the build output and nothing else, so a
    // sibling the build failed to copy 404s here exactly as it did in a browser.
    set('fetchData', (name: string): Promise<Response> => {
        const path = join(ROOT, 'test', 'fixtures', name);
        return Promise.resolve(
            existsSync(path)
                ? new Response(readFileSync(path, 'utf8'), { status: 200 })
                : new Response('not found', { status: 404 })
        );
    });
    set('fetch', (name: string): Promise<Response> => Promise.resolve(serve(name)));

    (dom.window as unknown as Record<string, unknown>)['Plotly'] = {
        newPlot: (id: string, traces: Record<string, unknown>[]): Promise<unknown> => {
            plots.push({ id, traces });
            return Promise.resolve(null);
        },
    };

    try {
        const module = (await import(`../site/index.ts?built=${Date.now()}`)) as {
            start(): Promise<void>;
        };
        await module.start();
        await new Promise<void>((resolve) => {
            dom.window.requestAnimationFrame(() => setTimeout(resolve, 5));
        });
        (dom.window as unknown as { __drawChart(id: string): void }).__drawChart(
            'testFailureContainer'
        );
        const trace = plots[0]?.traces[1];
        return (trace?.['x'] as string[] | undefined) ?? [];
    } finally {
        for (const [name, value] of saved) {
            if (value === undefined) {
                delete scope[name];
            } else {
                scope[name] = value;
            }
        }
    }
}

test('the built page charts the full mochitest history, not just the live span', async () => {
    const dates = await mochitestChartDates();

    // Pinned literals, not values read back out of the two input files. The
    // 66 the bug produced and the 198 it should be are both properties of the
    // pinned fixture and the committed backfill, and writing them down is what
    // makes the failure message say which one happened. `test/fixtures/
    // mochitest-stats.json` is 66 dates from 2026-05-29; the backfill is 145
    // from 2026-01-17, overlapping to 198.
    assert.equal(
        dates.length,
        198,
        dates.length === 66
            ? 'the chart is on the live span alone: the backfill 404d against the build output'
            : 'unexpected chart span'
    );
    assert.equal(dates[0], '2026-01-17', 'the chart does not start at the backfill');
    assert.equal(dates.at(-1), '2026-08-03', 'the chart does not end at the live artifact');
});
