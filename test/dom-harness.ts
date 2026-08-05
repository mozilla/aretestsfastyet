/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * A jsdom page, for the tests of `next/drilldown-render.ts` and the two page
 * controllers.
 *
 * Those three files were 2,598 lines that **no test imported**, because
 * importing a controller used to start the page. `55c9ff1` made the entry point
 * an exported `start()`; this module is the other half — the environment a node
 * test needs in order to call it.
 *
 * ## Why the real shared scripts, and not stubs
 *
 * `common-links.js`, `common-ui.js`, `common-charts.js` and `shared.js` are
 * plain scripts of top-level function declarations that the page loads by
 * `<script src=…>`. They are `eval`'d into the jsdom window here and lifted onto
 * `globalThis` under the names `next/` declares them with.
 *
 * Stubbing them instead would have been easier and worse, for the reason this
 * project keeps hitting: a stub's return value is a value *the test author
 * chose*, so an assertion on a link href would be checking the stub. Running the
 * real `getCrashViewerUrl` means the expected href in a test has to be written
 * out independently, and a controller that picked the wrong link builder fails.
 *
 * Four globals are **not** the real thing and each is a deliberate exception:
 *
 * - `fetchData` — the real one reaches the network. Here it serves
 *   `test/fixtures/`, which is what makes the suite offline.
 * - `createRateChart` — the real one needs Chart.js and a canvas 2D context,
 *   neither of which jsdom has. It is recorded instead, which also makes "was a
 *   chart drawn, with what series" assertable.
 * - `getDataDateRange` is real, but `common-links.js` reads `data.metadata`; it
 *   works unchanged on the fixtures.
 * - `initHarnessSwitcher` is real and needs an `<h1>`, which `PAGE_HTML` has.
 */

import { readFileSync } from 'node:fs';
// jsdom's types are declared by `test/jsdom.d.ts` rather than by
// `@types/jsdom`; that file records the comparison behind the choice.
import { JSDOM } from 'jsdom';

/**
 * This file declares no ambient globals, and that is the point.
 *
 * It used to declare `getBugButton`, because `next/failures.ts` called it
 * without declaring it: `tsconfig.next.json` compiles all of `next/**` as one
 * program, so the declaration in `next/test.ts` covered the call, while the
 * root project pulls in only the files a test imports and did not. The
 * declaration now lives in `next/failures.ts`'s own `declare global` block,
 * where the call is. Every `next/` module was checked for the same shape —
 * each compiled alone against the DOM lib with no other `next/` file in the
 * program — and `getBugButton` was the only one.
 *
 * What is still needed to import `next/` from a node test is the DOM half,
 * which the `/// <reference lib>` lines at the top of each test file supply.
 */

/** The scripts the two pages load, in the order their `<script>` tags do. */
const SHARED_SCRIPTS = [
    'shared.js',
    'fetch-utils.js',
    'common-ui.js',
    'common-charts.js',
    'common-links.js',
] as const;

/**
 * The names `next/drilldown-render.ts` declares in its `declare global` block,
 * plus the two the controllers use directly.
 *
 * Listed explicitly rather than copied wholesale off the window so that a
 * missing one is an error here rather than a `ReferenceError` inside a render.
 */
const GLOBAL_NAMES = [
    'getProfilerUrl',
    'getCrashViewerUrl',
    'getTreeherderJobUrl',
    'getSearchfoxUrl',
    'getBugzillaUrl',
    'getBugButton',
    'getDataDateRange',
    'getTestTotalRuns',
    'countDailyRunsForTests',
    'makeChartId',
    'initSearchBox',
    'populateDateSelector',
    'initHistoricalToggle',
    'initUrlHashManager',
    'initHarnessSwitcher',
    'getHarnessType',
] as const;

/**
 * The controls both pages carry, by the ids the controllers look up.
 *
 * Trimmed from `next/crashes.html` and `next/failures.html` to the elements the
 * controllers and the shared scripts actually reach for: the `<h1>`
 * `initHarnessSwitcher` rewrites, the `<label>` `initHistoricalToggle` hides
 * through `previousElementSibling`, and the five ids.
 */
const PAGE_HTML = `<!DOCTYPE html><html><body>
<div class="header"><h1>XPCShell Crashes by Signature</h1></div>
<div class="controls">
  <label for="dateSelect">Select Date: </label>
  <select id="dateSelect"></select>
  <span class="status-text" id="statusText">Loading...</span>
  <button id="historicalButton" class="historical-button">Show Last 21 Days</button>
  <input type="text" id="searchBox" class="search-box">
  <button class="search-clear" id="searchClear">×</button>
</div>
<div id="content"><div class="no-data">Loading crash data...</div></div>
</body></html>`;

/** One recorded `createRateChart` call. */
export interface ChartCall {
    canvasId: string;
    /** The daily series, as the controller computed it. */
    series: { day: number; date: string; events: number; totalRuns: number }[];
    label: string;
    eventLabel: string;
}

export interface Harness {
    window: JSDOM['window'];
    document: Document;
    /** `#content`, where a render puts its list. */
    content: HTMLElement;
    /** Every `createRateChart` call since the harness was built, in order. */
    charts: ChartCall[];
    /** Files `fetchData` will serve, by the name the controller asks for. */
    files: Map<string, unknown>;
    /** Names `fetchData` was asked for, in order, including the 404s. */
    requested: string[];
    /** Restores the globals this harness replaced. */
    restore(): void;
}

const FIXTURES = new URL('./fixtures/', import.meta.url);
const ROOT = new URL('../', import.meta.url);

/** A fixture's parsed JSON, for a test that wants to tally it by hand. */
export function fixture<T>(name: string): T {
    return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;
}

/**
 * Installs a jsdom page on `globalThis` and returns the handles a test needs.
 *
 * `url` sets `?kind=` and the `#hash` the controller reads at startup, which is
 * the only way to drive `loadFromUrlHash` from outside — it is module-private.
 */
export function setupPage(options: { url?: string; files?: Record<string, unknown> } = {}): Harness {
    const dom = new JSDOM(PAGE_HTML, {
        url: options.url ?? 'https://tests.firefox.dev/crashes.html',
        runScripts: 'outside-only',
    });

    for (const name of SHARED_SCRIPTS) {
        dom.window.eval(readFileSync(new URL(name, ROOT), 'utf8'));
    }

    const files = new Map<string, unknown>(Object.entries(options.files ?? {}));
    const requested: string[] = [];
    const charts: ChartCall[] = [];

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
    // Both controllers' delegated click handler is
    // `if (!(target instanceof Element) …)`, so `Element` has to be the *same*
    // constructor the nodes were made with — the browser has one global and
    // node has none. Without this the handler throws `ReferenceError` on every
    // click and no expansion is reachable from a test.
    for (const name of ['Element', 'Node', 'HTMLElement', 'Event'] as const) {
        set(name, (dom.window as unknown as Record<string, unknown>)[name]);
    }
    for (const name of GLOBAL_NAMES) {
        const value = (dom.window as unknown as Record<string, unknown>)[name];
        if (value === undefined) {
            throw new Error(`${name} is not defined by the shared scripts`);
        }
        set(name, value);
    }

    // Offline. A name with no entry 404s, exactly as the page's own fetch does
    // for a date with no file, so the error path is reachable from a test.
    set('fetchData', async (filename: string): Promise<Response> => {
        requested.push(filename);
        const body = files.get(filename);
        if (body === undefined) {
            return new Response('not found', { status: 404 });
        }
        return new Response(JSON.stringify(body), { status: 200 });
    });

    set(
        'createRateChart',
        (canvasId: string, series: ChartCall['series'], label: string, eventLabel: string) => {
            charts.push({ canvasId, series, label, eventLabel });
            return null;
        }
    );

    return {
        window: dom.window,
        document: dom.window.document,
        content: dom.window.document.getElementById('content')!,
        charts,
        files,
        requested,
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

// --- reading the rendered tree -------------------------------------------

/** An element's tag and classes, as one comparable string: `div.a.b`. */
export function shape(element: Element): string {
    const classes = [...element.classList].sort();
    return element.tagName.toLowerCase() + classes.map((name) => `.${name}`).join('');
}

/** `shape` for a whole node list, in document order. */
export function shapes(elements: Iterable<Element>): string[] {
    return [...elements].map(shape);
}

/**
 * The path from `root` to `element` as `div.a > span.b`.
 *
 * Written so an assertion can name the *nesting* a page produces, which is the
 * thing `inlineLinksCell` differs on and which a class-only check would miss.
 */
export function pathTo(root: Element, element: Element): string {
    const parts: string[] = [];
    let node: Element | null = element;
    while (node !== null && node !== root) {
        parts.unshift(shape(node));
        node = node.parentElement;
    }
    return parts.join(' > ');
}
