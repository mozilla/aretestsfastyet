/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * `site/index.ts`, the landing page controller, driven end to end in jsdom.
 *
 * ## Why this file builds its own jsdom rather than using `test/dom-harness.ts`
 *
 * That harness serves the crashes and issues pages: it loads five shared
 * scripts, lifts sixteen `common-*` globals onto `globalThis`, and stubs
 * `createRateChart` and Chart.js. This page needs almost none of that and needs
 * three things it does not have — `withDevParams`, `renderDashboardTeaser` and
 * a **Plotly** recorder — plus the landing page's own markup. Adding a fourth
 * page kind and a third chart stub to a shared file for one caller is the
 * "three new booleans" signal; a local `setupIndexPage` is smaller and says
 * what this page actually depends on.
 *
 * The same discipline applies, though, and it is the load-bearing one:
 * **`fetch-utils.js`, `shared.js` and `dashboards.js` are the real files**,
 * `eval`'d into the window. So an assertion on a link's href compares against
 * the real `withDevParams`, and an assertion on the teaser compares against the
 * real `DASHBOARDS` list — not against a stub whose return value this test
 * chose. Two globals are replaced, each for a stated reason:
 *
 * - `fetchData` — the real one reaches the network. Here it serves values the
 *   test supplies, which is what makes the suite offline.
 * - `Plotly` — needs a real layout engine. Recorded instead, with the whole
 *   trace list, which also makes "was this chart drawn, with which series, in
 *   which mode" assertable. jsdom has no `IntersectionObserver`, so the charts
 *   would otherwise be unreachable from a test entirely.
 *
 * ## What a DOM diff cannot tell you, and what is done about it
 *
 * A rendered-tree comparison cannot distinguish a working control from an inert
 * one. Every interaction here is therefore asserted by its **effect**: the
 * toggle is checked by the y values Plotly received changing from percentages
 * to counts, the anchor click by `location.hash`, and the lazy chart by a draw
 * that had not happened before the call.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';

import type { StatsFile } from '../lib/formats/stats.ts';
import { computeSummary } from '../lib/query/summary.ts';
import { SUMMARY_DAYS, mergeBackfillStats, summaryRows } from '../site/index-view.ts';

const ROOT = new URL('../', import.meta.url);
const FIXTURES = new URL('./fixtures/', import.meta.url);

/** The scripts `site/index.html` loads, in the order its tags do. */
const SHARED_SCRIPTS = ['fetch-utils.js', 'shared.js', 'dashboards.js'] as const;

/** The globals those scripts define that `site/index.ts` names. */
const GLOBAL_NAMES = ['withDevParams', 'renderDashboardTeaser', 'setupWindowResize'] as const;

/** One recorded `Plotly.newPlot`. */
interface PlotCall {
    id: string;
    traces: Record<string, unknown>[];
    layout: Record<string, unknown>;
}

interface IndexHarness {
    window: JSDOM['window'];
    document: Document;
    /** Every `Plotly.newPlot` since the page started, in order. */
    plots: PlotCall[];
    /** Names `fetchData` was asked for, in order, including the 404s. */
    requested: string[];
    /** URLs the plain `fetch` was asked for — the two backfill siblings. */
    fetched: string[];
    restore(): void;
}

/**
 * The landing page's markup, read from `site/index.html` itself.
 *
 * Read rather than copied, unlike `dom-harness.ts`'s two page constants. The
 * reason those are copied is that the crashes and issues pages disagree about
 * every element id and a shared template would hide a mismatch — but here there
 * is one page, and reading its real markup means an id renamed in the HTML and
 * not in the controller fails as a null lookup in `start()`. The `<script>`
 * tags are stripped: jsdom must not try to load Plotly from a CDN.
 */
function pageMarkup(): string {
    return readFileSync(new URL('site/index.html', ROOT), 'utf8').replace(
        /<script\b[^>]*>[\s\S]*?<\/script>/g,
        ''
    );
}

function statsFixture(name: string): StatsFile {
    return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as StatsFile;
}

function backfillFile(): StatsFile {
    return JSON.parse(
        readFileSync(new URL('mochitest-stats-backfill.json', ROOT), 'utf8')
    ) as StatsFile;
}

/**
 * Installs the landing page on `globalThis` and returns the handles a test needs.
 *
 * `files` are served by `fetchData`; `siblings` by the plain `fetch` the two
 * backfill requests use. A name with no entry 404s, exactly as the real page's
 * xpcshell backfill request does on every load.
 */
function setupIndexPage(
    options: {
        url?: string;
        files?: Record<string, unknown>;
        siblings?: Record<string, unknown>;
    } = {}
): IndexHarness {
    const dom = new JSDOM(pageMarkup(), {
        url: options.url ?? 'https://tests.firefox.dev/index.html',
        runScripts: 'outside-only',
        // `requestAnimationFrame` is off in jsdom without this, and the page
        // defers its whole render into one — so without it `start()` throws and
        // nothing renders. Enabling it keeps the real sequencing under test
        // rather than stubbing the frame away.
        pretendToBeVisual: true,
    });

    for (const name of SHARED_SCRIPTS) {
        let source = readFileSync(new URL(name, ROOT), 'utf8');
        if (name === 'dashboards.js') {
            // `dashboards.js` declares `const DASHBOARDS`, which is scoped to
            // this eval and is not a window property — and each `window.eval`
            // gets its own scope, so a later one cannot see it either. Appending
            // the export inside the same eval is what makes the real list
            // readable by a test, so an assertion on the teaser compares against
            // `dashboards.js` rather than against a literal this file chose.
            source += '\nwindow.__DASHBOARDS = DASHBOARDS;';
        }
        dom.window.eval(source);
    }

    const files = new Map<string, unknown>(Object.entries(options.files ?? {}));
    const siblings = new Map<string, unknown>(Object.entries(options.siblings ?? {}));
    const requested: string[] = [];
    const fetched: string[] = [];
    const plots: PlotCall[] = [];

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
    for (const name of ['Element', 'Node', 'HTMLElement', 'Event'] as const) {
        set(name, (dom.window as unknown as Record<string, unknown>)[name]);
    }
    // The controller calls the bare global, as a page does. Bound to the window
    // because jsdom's implementation is a method on it.
    set('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
    for (const name of GLOBAL_NAMES) {
        const value = (dom.window as unknown as Record<string, unknown>)[name];
        if (value === undefined) {
            throw new Error(`${name} is not defined by the shared scripts`);
        }
        set(name, value);
    }

    set('fetchData', (filename: string): Promise<Response> => {
        requested.push(filename);
        const body = files.get(filename);
        return Promise.resolve(
            body === undefined
                ? new Response('not found', { status: 404 })
                : new Response(JSON.stringify(body), { status: 200 })
        );
    });

    // The two committed backfill siblings go through the plain `fetch`, not
    // `fetchData` — they are files in the repository, not published artifacts.
    set('fetch', (url: string): Promise<Response> => {
        fetched.push(url);
        const body = siblings.get(url);
        return Promise.resolve(
            body === undefined
                ? new Response('not found', { status: 404 })
                : new Response(JSON.stringify(body), { status: 200 })
        );
    });

    (dom.window as unknown as Record<string, unknown>)['Plotly'] = {
        newPlot: (
            id: string,
            traces: Record<string, unknown>[],
            layout: Record<string, unknown>
        ): Promise<unknown> => {
            plots.push({ id, traces, layout });
            return Promise.resolve(null);
        },
    };

    // `requestAnimationFrame` exists in jsdom but fires on a timer; the page
    // uses it plus a `setTimeout(…, 0)` before drawing. `flush()` below waits
    // for both rather than this replacing them, so the real sequencing runs.

    return {
        window: dom.window,
        document: dom.window.document,
        plots,
        requested,
        fetched,
        restore(): void {
            for (const [name, value] of saved) {
                if (value === undefined) {
                    delete scope[name];
                } else {
                    scope[name] = value;
                }
            }
        },
    };
}

/**
 * Lets the page's `requestAnimationFrame` → `setTimeout(0)` chain run.
 *
 * `updateDisplay` defers the table render to an animation frame and the chart
 * draws to a task after it, so a test that asserted immediately after `start()`
 * would see the placeholder rows. Waiting on real timers rather than stubbing
 * them keeps that sequencing under test.
 */
async function flush(harness: IndexHarness): Promise<void> {
    await new Promise<void>((resolve) => {
        harness.window.requestAnimationFrame(() => {
            setTimeout(resolve, 5);
        });
    });
}

/**
 * A fresh instance of the controller.
 *
 * `site/index.ts` keeps the loaded files, the summaries and the current display
 * mode in module-level `let`s, exactly as the page does — so a second `start()`
 * against the same module instance inherits the first test's display mode and
 * its stats. That is correct for a page, which is loaded once, and wrong for a
 * suite: it made two tests here pass or fail depending on their order, with the
 * charts plotting raw counts because an *earlier* test had clicked the toggle.
 *
 * The cache-busting query is the same device `test/issues-page.test.ts:992`
 * uses for the same reason.
 */
async function freshController(): Promise<{ start(): Promise<void> }> {
    return (await import(
        `../site/index.ts?case=${Date.now()}-${Math.random()}`
    )) as { start(): Promise<void> };
}

/** Starts the page with the pinned files loaded. */
async function startPage(
    options: { files?: Record<string, unknown>; siblings?: Record<string, unknown> } = {}
): Promise<IndexHarness> {
    const harness = setupIndexPage({
        files: options.files ?? {
            'xpcshell-stats.json': statsFixture('xpcshell-stats.json'),
            'mochitest-stats.json': statsFixture('mochitest-stats.json'),
        },
        ...(options.siblings === undefined
            ? { siblings: { './mochitest-stats-backfill.json': backfillFile() } }
            : { siblings: options.siblings }),
    });
    const { start } = await freshController();
    await start();
    await flush(harness);
    return harness;
}

/** The rows of the summary table, as `[name, pct, counts]` per cell. */
function tableRows(harness: IndexHarness): { name: string; cells: [string, string][] }[] {
    const body = harness.document.getElementById('statsSummary')!;
    return [...body.querySelectorAll('tr')].map((tr) => {
        const cells = [...tr.querySelectorAll('td')].slice(1);
        return {
            name: tr.querySelector('.harness-name')!.textContent!,
            cells: cells.map((td) => [
                td.querySelector('.stat-value')!.textContent!,
                td.querySelector('.stat-secondary')?.textContent ?? '',
            ]),
        };
    });
}

// =========================================================================
// First paint
// =========================================================================

test('the page fetches both stats files and both backfill siblings', async () => {
    const harness = await startPage();
    try {
        assert.deepEqual(harness.requested, ['xpcshell-stats.json', 'mochitest-stats.json']);
        // The xpcshell one 404s on every real load too: only mochitest has a
        // committed backfill. Both are still requested, as upstream does.
        assert.deepEqual(harness.fetched, [
            './xpcshell-stats-backfill.json',
            './mochitest-stats-backfill.json',
        ]);
    } finally {
        harness.restore();
    }
});

test('the summary table renders one row per harness plus the flavors', async () => {
    const harness = await startPage();
    try {
        const rows = tableRows(harness);
        assert.deepEqual(
            rows.map((row) => row.name),
            [
                'XPCShell',
                'Mochitest',
                'Browser Chrome',
                'DevTools',
                'Plain',
                'Chrome',
                'A11y',
                'Media',
                'Remote',
                'WebGL',
            ]
        );
        // The placeholder rows are gone: upstream ships ten of them to reserve
        // layout height, and a page that failed to render would leave them.
        assert.ok(!rows.some((row) => row.cells.some(([value]) => value === '—' && row.name === 'XPCShell')));
    } finally {
        harness.restore();
    }
});

test('the rendered numbers match a tally taken off the fixtures', async () => {
    const harness = await startPage();
    try {
        // Expected values from the view model over the same merged input — a
        // second path to the numbers, not the renderer's own output. The
        // separators come from `toLocaleString()` because this machine's locale
        // renders 1078 as `1 078`.
        const expected = summaryRows(
            mergeBackfillStats(null, statsFixture('xpcshell-stats.json')).stats,
            mergeBackfillStats(backfillFile(), statsFixture('mochitest-stats.json')).stats
        );
        const rows = tableRows(harness);
        assert.equal(rows.length, expected.length);

        for (const [i, row] of rows.entries()) {
            const model = expected[i]!;
            assert.equal(row.name, model.name);
            assert.equal(row.cells[0]![0], `${model.testFailureRate!.toFixed(2)}%`);
            assert.equal(
                row.cells[0]![1],
                `${model.totals.failedTestRuns.toLocaleString()} / ${model.totals.totalTestRuns.toLocaleString()}`
            );
            assert.equal(row.cells[1]![0], `${model.jobFailureRate!.toFixed(2)}%`);
            // The job cell's second line must be the rate's own two numbers,
            // not a different numerator over a different denominator.
            assert.equal(
                row.cells[1]![1],
                `${model.totals.failedJobs.toLocaleString()} / ${model.jobPopulation.toLocaleString()}`
            );
            assert.equal(row.cells[2]![0], `${model.skipRate!.toFixed(2)}%`);
            assert.equal(
                row.cells[3]![0],
                model.isFlavor ? '—' : `${model.invalidJobRate!.toFixed(2)}%`
            );
        }

        // And the two headline rows as literals, measured off the pinned files,
        // so a change to any of these eight is a deliberate edit here.
        assert.deepEqual(
            rows[0]!.cells.map(([value]) => value),
            ['0.17%', '12.24%', '4.72%', '0.47%']
        );
        assert.deepEqual(
            rows[1]!.cells.map(([value]) => value),
            ['0.09%', '2.98%', '5.28%', '0.33%']
        );
    } finally {
        harness.restore();
    }
});

test('a flavor row has a dash for invalid jobs and no second line', async () => {
    const harness = await startPage();
    try {
        const body = harness.document.getElementById('statsSummary')!;
        const flavorRows = [...body.querySelectorAll('tr.flavor-row')];
        assert.equal(flavorRows.length, 8);
        for (const row of flavorRows) {
            const invalid = [...row.querySelectorAll('td')][4]!;
            assert.equal(invalid.querySelector('.stat-value')!.textContent, '—');
            assert.equal(
                invalid.querySelector('.stat-secondary'),
                null,
                'a dash with an "0 / 0" under it would read as a measured zero'
            );
        }
    } finally {
        harness.restore();
    }
});

test('only harness rows carry links, and they point where upstream points', async () => {
    const harness = await startPage();
    try {
        const body = harness.document.getElementById('statsSummary')!;
        const rows = [...body.querySelectorAll('tr')];

        // Harness rows: two links each, on the first two columns only.
        for (const row of rows.filter((tr) => !tr.classList.contains('flavor-row'))) {
            const links = [...row.querySelectorAll('a.stat-link')];
            assert.equal(links.length, 2);
        }
        // Flavor rows: none. A DOM diff would see the same numbers either way.
        for (const row of rows.filter((tr) => tr.classList.contains('flavor-row'))) {
            assert.equal(row.querySelectorAll('a').length, 0);
        }

        const [xpcshellRow] = rows;
        const links = [...xpcshellRow!.querySelectorAll('a')];
        // Built by the real `withDevParams` from `fetch-utils.js`, so this
        // compares two independent computations rather than a stub's echo.
        assert.equal(
            links[0]!.getAttribute('href'),
            (globalThis as unknown as { withDevParams(url: string): string }).withDevParams(
                'issues.html?kind=xpcshell#date=21days'
            )
        );
        // Divergence 8: no dev params on the green link, reproduced.
        assert.equal(links[1]!.getAttribute('href'), 'green.html#xpcshell');
    } finally {
        harness.restore();
    }
});

test('the dev parameters really do reach the issues link and not the green one', async () => {
    // The previous test compares against `withDevParams` on a URL with no dev
    // params set, where it is the identity — so it would pass on a page that
    // never called it. This drives the case where the two differ.
    const harness = setupIndexPage({
        url: 'https://tests.firefox.dev/index.html?data-source=try&profiler=1',
        files: {
            'xpcshell-stats.json': statsFixture('xpcshell-stats.json'),
            'mochitest-stats.json': statsFixture('mochitest-stats.json'),
        },
        siblings: {},
    });
    try {
        const { start } = await freshController();
        await start();
        await flush(harness);

        const row = harness.document.getElementById('statsSummary')!.querySelector('tr')!;
        const links = [...row.querySelectorAll('a')];
        const issues = links[0]!.getAttribute('href')!;
        assert.ok(issues.includes('data-source=try'), `no dev params on ${issues}`);
        assert.ok(issues.includes('#date=21days'), 'the hash survives the parameter splice');
        assert.equal(links[1]!.getAttribute('href'), 'green.html#xpcshell');
    } finally {
        harness.restore();
    }
});

test('the dashboard teaser shows one chip per featured dashboard', async () => {
    const harness = await startPage();
    try {
        const teaser = harness.document.getElementById('dashboardTeaser')!;
        const chips = [...teaser.querySelectorAll('a.dash-chip')];
        // Counted off the real `DASHBOARDS` in the window, not off a literal:
        // the teaser skips the current page, which is `index.html`.
        // The real list, republished off `dashboards.js` by the harness — so
        // this compares against that file rather than a literal chosen here.
        // Spread into a node-realm array: `.filter`/`.map` on a jsdom-realm
        // array returns a jsdom-realm one, which `deepEqual` reports as "same
        // structure but not reference-equal".
        const dashboards = [
            ...(
                harness.window as unknown as {
                    __DASHBOARDS: { featured?: boolean; file: string; title: string }[];
                }
            ).__DASHBOARDS,
        ];
        const featured = dashboards.filter(
            (entry) => entry.featured === true && entry.file !== 'index.html'
        );
        assert.equal(chips.length, featured.length);
        // `String(...)` on both sides: the chip text and the `DASHBOARDS`
        // entries come from the jsdom realm, and `deepEqual` compares those as
        // non-reference-equal to node's own strings.
        assert.deepEqual(
            chips.map((chip) => String(chip.textContent)),
            featured.map((entry) => String(entry.title))
        );
        assert.ok(teaser.querySelector('a.dash-teaser-all'));
    } finally {
        harness.restore();
    }
});

// =========================================================================
// The three windows, on the page
// =========================================================================

test('the heading keeps its 7-day wording on a full file', async () => {
    const harness = await startPage();
    try {
        assert.equal(
            harness.document.getElementById('summary')!.textContent,
            `Summary (Last ${SUMMARY_DAYS} Days)`
        );
    } finally {
        harness.restore();
    }
});

test('a short file narrows both the window and the heading', async () => {
    // Divergence 3. Not reachable on the pinned files, so it is driven here
    // with a 3-date one — the browser run cannot see this.
    const short: StatsFile = {
        metadata: { generatedAt: '2026-08-04T00:00:00.000Z', harness: 'xpcshell' },
        dates: ['2026-08-01', '2026-08-02', '2026-08-03'],
        totalTestRuns: [100, 100, 100],
        failedTestRuns: [1, 2, 3],
        skippedTestRuns: [0, 0, 0],
        processedJobCount: [10, 10, 10],
        failedJobs: [1, 1, 1],
        invalidJobs: [0, 0, 0],
        ignoredJobs: [0, 0, 0],
        markerCounts: {},
    };
    const harness = await startPage({
        files: { 'xpcshell-stats.json': short },
        siblings: {},
    });
    try {
        assert.equal(
            harness.document.getElementById('summary')!.textContent,
            'Summary (Last 3 Days)',
            'upstream leaves this saying "Last 7 Days" over 3 days of data'
        );
        const rows = tableRows(harness);
        assert.equal(rows.length, 1, 'mochitest 404d, so it has no row');
        assert.equal(rows[0]!.cells[0]![0], '2.00%');
        assert.equal(rows[0]!.cells[0]![1], '6 / 300');
    } finally {
        harness.restore();
    }
});

test('each chart says the span it covers, read off the data', async () => {
    // Divergence 5. The fix for the three-windows problem.
    const harness = await startPage();
    try {
        const xpc = statsFixture('xpcshell-stats.json');
        const merged = mergeBackfillStats(backfillFile(), statsFixture('mochitest-stats.json'))
            .stats;
        for (const id of [
            'testFailureContainer',
            'jobFailureContainer',
            'skipRateContainer',
            'xpcshellBreakdownContainer',
        ]) {
            const info = harness.document.getElementById(id)!.querySelector('.info-text')!;
            assert.ok(
                info.textContent!.includes(`XPCShell ${xpc.dates.length} days`),
                `${id} should name the xpcshell span: ${info.textContent}`
            );
            assert.ok(
                info.textContent!.includes(`Mochitest ${merged.dates.length} days`),
                `${id} should name the mochitest span: ${info.textContent}`
            );
            // And it is a different number from the table's, which is the point.
            assert.ok(!info.textContent!.includes(`XPCShell ${SUMMARY_DAYS} days`));
        }
    } finally {
        harness.restore();
    }
});

test('the window label is not appended twice on a redraw', async () => {
    const harness = await startPage();
    try {
        const info = harness.document
            .getElementById('testFailureContainer')!
            .querySelector('.info-text')!;
        const once = info.textContent!;
        harness.document.getElementById('btnCount')!.dispatchEvent(
            new harness.window.Event('click')
        );
        await flush(harness);
        assert.equal(info.textContent, once, 'a toggle must not re-append the sentence');
    } finally {
        harness.restore();
    }
});

// =========================================================================
// The charts
// =========================================================================

test('no chart is drawn until its container is asked for', async () => {
    // jsdom has no `IntersectionObserver`, which is the same state a background
    // browser tab is in — Chrome throttles it and the observer never fires.
    const harness = await startPage();
    try {
        assert.deepEqual(harness.plots, []);
    } finally {
        harness.restore();
    }
});

test('each container draws the chart it names, with the expected series', async () => {
    const harness = await startPage();
    try {
        const draw = (id: string): void => {
            (harness.window as unknown as { __drawChart(id: string): void }).__drawChart(id);
        };

        draw('testFailureContainer');
        assert.equal(harness.plots.length, 1);
        assert.equal(harness.plots[0]!.id, 'testFailureChart');
        assert.deepEqual(
            harness.plots[0]!.traces.map((trace) => trace['name']),
            [
                'XPCShell',
                'Mochitest',
                'Browser Chrome',
                'DevTools',
                'Plain',
                'Chrome',
                'A11y',
                'Media',
                'Remote',
                'WebGL',
            ]
        );

        draw('skipRateContainer');
        assert.equal(harness.plots[1]!.id, 'skipRateChart');

        // The job chart's legend order differs: upstream closes its harness
        // loop before the flavor block, so the flavors follow both harnesses
        // rather than only mochitest. Here that is the same order, but the
        // *reason* differs and a future edit could diverge — asserted so it
        // cannot drift silently.
        draw('jobFailureContainer');
        assert.equal(harness.plots[2]!.id, 'jobFailureChart');
        assert.deepEqual(harness.plots[2]!.traces.map((trace) => trace['name']).slice(0, 2), [
            'XPCShell',
            'Mochitest',
        ]);

        // One container, two charts.
        draw('xpcshellBreakdownContainer');
        assert.deepEqual(
            harness.plots.slice(3).map((plot) => plot.id),
            ['xpcshellBreakdownChart', 'mochitestBreakdownChart']
        );
        assert.deepEqual(
            harness.plots[3]!.traces.map((trace) => trace['name']),
            ['Intermittent', 'Invalid', 'Backout']
        );
    } finally {
        harness.restore();
    }
});

test('the flavor traces start hidden behind the legend', async () => {
    const harness = await startPage();
    try {
        (harness.window as unknown as { __drawChart(id: string): void }).__drawChart(
            'testFailureContainer'
        );
        const traces = harness.plots[0]!.traces;
        assert.equal(traces[0]!['visible'], undefined, 'the harness series is shown');
        assert.equal(traces[1]!['visible'], undefined);
        for (const trace of traces.slice(2)) {
            assert.equal(trace['visible'], 'legendonly', `${String(trace['name'])} starts hidden`);
        }
        // And they are styled as the thin dotted lines upstream draws.
        assert.deepEqual(traces[2]!['line'], {
            color: '#c0392b',
            width: 1.5,
            dash: 'dot',
        });
    } finally {
        harness.restore();
    }
});

test('a chart plots the whole file, not the summary window', async () => {
    const harness = await startPage();
    try {
        (harness.window as unknown as { __drawChart(id: string): void }).__drawChart(
            'testFailureContainer'
        );
        const xpcTrace = harness.plots[0]!.traces[0]!;
        const x = xpcTrace['x'] as string[];
        assert.equal(x.length, statsFixture('xpcshell-stats.json').dates.length);
        assert.ok(x.length > SUMMARY_DAYS * 20);
    } finally {
        harness.restore();
    }
});

test('a chart hover shows the percentage rounded once from the raw ratio', async () => {
    const harness = await startPage();
    try {
        (harness.window as unknown as { __drawChart(id: string): void }).__drawChart(
            'testFailureContainer'
        );
        const trace = harness.plots[0]!.traces[0]!;
        const customdata = trace['customdata'] as { percentage: string; numerator: string }[];
        const y = trace['y'] as number[];
        const xpc = statsFixture('xpcshell-stats.json');

        // Recomputed from the raw file, not read back off the trace.
        for (const [i, entry] of customdata.entries()) {
            const expected = (xpc.failedTestRuns[i]! / xpc.totalTestRuns[i]!) * 100;
            assert.equal(entry.percentage, expected.toFixed(2));
            assert.equal(y[i], expected, 'the y value is the unrounded ratio');
            assert.equal(entry.numerator, xpc.failedTestRuns[i]!.toLocaleString());
        }
    } finally {
        harness.restore();
    }
});

// =========================================================================
// Interactions
// =========================================================================

test('the display toggle switches the charts from percentages to counts', async () => {
    // A DOM diff cannot tell a working toggle from an inert one, so this is
    // asserted by the y values Plotly received.
    const harness = await startPage();
    try {
        const win = harness.window as unknown as {
            __drawChart(id: string): void;
            __displayMode(): string;
        };
        win.__drawChart('testFailureContainer');
        const before = harness.plots[0]!.traces[0]!['y'] as number[];
        const xpc = statsFixture('xpcshell-stats.json');
        assert.equal(before[0], (xpc.failedTestRuns[0]! / xpc.totalTestRuns[0]!) * 100);
        assert.equal(win.__displayMode(), 'percentage');

        harness.document.getElementById('btnCount')!.dispatchEvent(
            new harness.window.Event('click')
        );
        await flush(harness);

        assert.equal(win.__displayMode(), 'count');
        const redrawn = harness.plots[harness.plots.length - 1]!;
        assert.equal(redrawn.id, 'testFailureChart');
        const after = redrawn.traces[0]!['y'] as number[];
        assert.deepEqual(after.slice(0, 5), xpc.failedTestRuns.slice(0, 5));
        assert.notDeepEqual(after.slice(0, 5), before.slice(0, 5));

        // And the y-axis label follows.
        assert.equal(
            (redrawn.layout['yaxis'] as { title: string }).title,
            'Failed Test Runs'
        );
    } finally {
        harness.restore();
    }
});

test('the toggle moves the active class between the two buttons', async () => {
    const harness = await startPage();
    try {
        const percentage = harness.document.getElementById('btnPercentage')!;
        const count = harness.document.getElementById('btnCount')!;
        assert.ok(percentage.classList.contains('active'), 'the markup starts on percentage');
        assert.ok(!count.classList.contains('active'));

        count.dispatchEvent(new harness.window.Event('click'));
        await flush(harness);
        assert.ok(!percentage.classList.contains('active'));
        assert.ok(count.classList.contains('active'));

        percentage.dispatchEvent(new harness.window.Event('click'));
        await flush(harness);
        assert.ok(percentage.classList.contains('active'));
        assert.ok(!count.classList.contains('active'));
    } finally {
        harness.restore();
    }
});

test('the toggle leaves the summary table unchanged', async () => {
    // The mode affects the charts only: the table always shows both a
    // percentage and a raw count. Upstream re-renders it anyway on every
    // toggle, which is worth knowing when reading a DOM diff.
    const harness = await startPage();
    try {
        const before = tableRows(harness);
        harness.document.getElementById('btnCount')!.dispatchEvent(
            new harness.window.Event('click')
        );
        await flush(harness);
        assert.deepEqual(tableRows(harness), before);
    } finally {
        harness.restore();
    }
});

test('clicking an h2 writes its id to the hash, and the h3s do not', async () => {
    const harness = await startPage();
    try {
        const headings = [...harness.document.querySelectorAll('h2[id]')];
        assert.deepEqual(
            headings.map((heading) => heading.id),
            ['summary', 'test-failures', 'job-failures', 'test-skips', 'failure-breakdown']
        );

        for (const heading of headings) {
            heading.dispatchEvent(new harness.window.Event('click'));
            assert.equal(harness.window.location.hash, `#${heading.id}`);
        }

        // The two `<h3>` in the breakdown container are not click-to-anchor,
        // because the selector is `h2[id]`. Asserted so the property is a
        // recorded decision rather than an accident of the `</h2>` typo.
        const before = harness.window.location.hash;
        const h3s = [...harness.document.querySelectorAll('h3[id]')];
        assert.equal(h3s.length, 2);
        for (const heading of h3s) {
            heading.dispatchEvent(new harness.window.Event('click'));
        }
        assert.equal(harness.window.location.hash, before);
    } finally {
        harness.restore();
    }
});

test('the page reads no URL state', async () => {
    // Upstream reads no `URLSearchParams` and no `location.hash`; it only
    // writes one. A hash on arrival must therefore change nothing.
    const withHash = setupIndexPage({
        url: 'https://tests.firefox.dev/index.html#test-skips',
        files: {
            'xpcshell-stats.json': statsFixture('xpcshell-stats.json'),
            'mochitest-stats.json': statsFixture('mochitest-stats.json'),
        },
        siblings: { './mochitest-stats-backfill.json': backfillFile() },
    });
    try {
        const { start } = await freshController();
        await start();
        await flush(withHash);
        assert.equal(withHash.window.location.hash, '#test-skips', 'unchanged, not consumed');
        // And the view is the default one.
        assert.equal(
            (withHash.window as unknown as { __displayMode(): string }).__displayMode(),
            'percentage'
        );
        assert.deepEqual(withHash.plots, [], 'no chart was drawn by the hash');
    } finally {
        withHash.restore();
    }
});

// =========================================================================
// Degraded loads
// =========================================================================

test('a harness that 404s is simply absent, and the other still renders', async () => {
    const harness = await startPage({
        files: { 'mochitest-stats.json': statsFixture('mochitest-stats.json') },
        siblings: { './mochitest-stats-backfill.json': backfillFile() },
    });
    try {
        const rows = tableRows(harness);
        assert.equal(rows[0]!.name, 'Mochitest', 'no XPCShell row');
        assert.ok(!rows.some((row) => row.name === 'XPCShell'));
        assert.equal(harness.document.getElementById('errorMessage')!.style.display, 'none');

        (harness.window as unknown as { __drawChart(id: string): void }).__drawChart(
            'xpcshellBreakdownContainer'
        );
        assert.deepEqual(
            harness.plots.map((plot) => plot.id),
            ['mochitestBreakdownChart'],
            'the absent harness draws no chart rather than an empty one'
        );
    } finally {
        harness.restore();
    }
});

test('both harnesses failing shows the error message', async () => {
    const harness = await startPage({ files: {}, siblings: {} });
    try {
        const message = harness.document.getElementById('errorMessage')!;
        assert.equal(message.style.display, 'block');
        assert.ok(message.textContent!.includes('Could not load statistics'));
        assert.deepEqual(tableRows(harness).length, 10, 'the placeholder rows are left in place');
    } finally {
        harness.restore();
    }
});

test('a missing backfill leaves the mochitest charts on the live span', async () => {
    const harness = await startPage({
        files: {
            'xpcshell-stats.json': statsFixture('xpcshell-stats.json'),
            'mochitest-stats.json': statsFixture('mochitest-stats.json'),
        },
        siblings: {},
    });
    try {
        (harness.window as unknown as { __drawChart(id: string): void }).__drawChart(
            'testFailureContainer'
        );
        const mochitestTrace = harness.plots[0]!.traces[1]!;
        assert.equal(
            (mochitestTrace['x'] as string[]).length,
            statsFixture('mochitest-stats.json').dates.length,
            'without the backfill the chart shows 66 dates instead of 198'
        );
        // The summary table is unaffected: its window is the last 7 dates,
        // which live has.
        assert.equal(tableRows(harness)[1]!.cells[0]![0], '0.09%');
    } finally {
        harness.restore();
    }
});

// =========================================================================
// The prior-period tooltip (divergence 6)
// =========================================================================

test('a harness row quotes the CLI rate and the prior period in its tooltip', async () => {
    const harness = await startPage();
    try {
        const row = harness.document.getElementById('statsSummary')!.querySelector('tr')!;
        const cells = [...row.querySelectorAll('td')].slice(1);

        // The expected numbers come from `computeSummary` over the same file —
        // the shared query, not this page's arithmetic.
        const summary = computeSummary(statsFixture('xpcshell-stats.json'));
        assert.ok(summary.prior !== null);

        const testTitle = cells[0]!.getAttribute('title')!;
        assert.ok(testTitle.startsWith('Percentage of test runs that failed'));
        assert.ok(
            testTitle.includes(`Test failure rate: ${summary.current.testFailureRate!.toFixed(2)}%`),
            testTitle
        );
        assert.ok(
            testTitle.includes(`prior ${summary.prior.dayCount}d ${summary.prior.testFailureRate!.toFixed(2)}%`),
            testTitle
        );

        // This is the metric whose two rates round to the same 0.17% on the
        // pinned file, so it must say so rather than printing "+0.01 points"
        // between two identical numbers.
        assert.ok(
            testTitle.endsWith('(unchanged at this precision).'),
            `xpcshell's test failure rate rounds to 0.17% in both periods: ${testTitle}`
        );

        // The job failure rate used to be a declared divergence and the tooltip
        // had to name a different number than the cell. Both sides are now
        // corrected to `failedJobs / (processed + invalid)`, so the tooltip and
        // the cell must agree — asserted in that direction so a regression on
        // either side shows up here as well as in the parity file.
        const jobTitle = cells[1]!.getAttribute('title')!;
        assert.ok(jobTitle.includes('Job failure rate:'), jobTitle);
        assert.ok(
            !jobTitle.includes('all failed jobs'),
            'the disambiguating suffix is stale now that the two agree'
        );
        const cliJobRate = `${summary.current.jobFailureRate!.toFixed(2)}%`;
        assert.ok(jobTitle.includes(cliJobRate), 'the tooltip carries the CLI rate');
        assert.equal(
            cells[1]!.querySelector('.stat-value')!.textContent,
            cliJobRate,
            'and the cell shows the same number'
        );

        // Same for the skip rate, the other former divergence.
        const skipTitle = cells[2]!.getAttribute('title')!;
        assert.ok(skipTitle.includes('Skip rate:'), skipTitle);
        assert.ok(!skipTitle.includes('of everything scheduled'), skipTitle);
        assert.equal(
            cells[2]!.querySelector('.stat-value')!.textContent,
            `${summary.current.skipRate!.toFixed(2)}%`,
            'the skip cell and the CLI agree too'
        );
    } finally {
        harness.restore();
    }
});

test('a change is only reported when the reader could see it', async () => {
    // Found in the browser run: rendering each part at two decimals produced
    // `0.17%, prior 7d 0.17% (+0.01 points)` — every number correctly rounded
    // and the line as a whole self-contradictory. Measured on the pinned files,
    // 1 of the 8 harness/metric pairs rounds equal and 7 do not, so this
    // asserts both branches rather than only the one that fires.
    const harness = await startPage();
    try {
        const rows = [
            ...harness.document.getElementById('statsSummary')!.querySelectorAll('tr'),
        ].filter((tr) => !tr.classList.contains('flavor-row'));

        let unchanged = 0;
        let reported = 0;
        for (const [i, name] of ['xpcshell', 'mochitest'].entries()) {
            const summary = computeSummary(statsFixture(`${name}-stats.json`));
            assert.ok(summary.prior !== null);
            const cells = [...rows[i]!.querySelectorAll('td')].slice(1);
            const keys = [
                'testFailureRate',
                'jobFailureRate',
                'skipRate',
                'invalidJobRate',
            ] as const;
            for (const [column, key] of keys.entries()) {
                const title = cells[column]!.getAttribute('title')!;
                const current = summary.current[key]!.toFixed(2);
                const prior = summary.prior[key]!.toFixed(2);
                if (current === prior) {
                    unchanged++;
                    assert.ok(
                        title.endsWith('(unchanged at this precision).'),
                        `${name} ${key}: both round to ${current}%, so no change may be claimed`
                    );
                } else {
                    reported++;
                    assert.ok(
                        /\([+\u2212]\d+\.\d{2} points\)\.$/.test(title),
                        `${name} ${key}: ${current}% vs ${prior}% should report a change: ${title}`
                    );
                }
            }
        }
        // Both branches were exercised, or this test proves only one of them.
        assert.equal(unchanged, 1);
        assert.equal(reported, 7);
    } finally {
        harness.restore();
    }
});

test('a flavor row gets no prior-period line', async () => {
    const harness = await startPage();
    try {
        const flavor = harness.document
            .getElementById('statsSummary')!
            .querySelector('tr.flavor-row')!;
        for (const cell of flavor.querySelectorAll('td[title]')) {
            assert.ok(
                !cell.getAttribute('title')!.includes('prior'),
                'a flavor is not a StatsFile, so there is no comparison to make'
            );
        }
    } finally {
        harness.restore();
    }
});

test('a file too short for a prior period gets no comparison line', async () => {
    const short: StatsFile = {
        metadata: { generatedAt: '2026-08-04T00:00:00.000Z', harness: 'xpcshell' },
        dates: ['2026-08-01', '2026-08-02', '2026-08-03'],
        totalTestRuns: [100, 100, 100],
        failedTestRuns: [1, 2, 3],
        skippedTestRuns: [0, 0, 0],
        processedJobCount: [10, 10, 10],
        failedJobs: [1, 1, 1],
        invalidJobs: [0, 0, 0],
        ignoredJobs: [0, 0, 0],
        markerCounts: {},
    };
    const harness = await startPage({
        files: { 'xpcshell-stats.json': short },
        siblings: {},
    });
    try {
        const cell = harness.document
            .getElementById('statsSummary')!
            .querySelector('td[title]')!;
        assert.equal(cell.getAttribute('title'), 'Percentage of test runs that failed');
    } finally {
        harness.restore();
    }
});
