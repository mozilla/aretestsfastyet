/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * `site/manifests.ts`, the manifests page controller, driven end to end in
 * jsdom.
 *
 * ## Why this file exists at all
 *
 * The controller exports `start()` and two test seams, and everything worth
 * covering is module-private behind it: the delegated click handler, the three
 * render functions, `applyFilters`, the pager wiring, the chart call and the
 * `popstate` path. There is no seam to unit-test them through, so they are
 * tested the way a reader exercises them — by loading the page and clicking it.
 *
 * That is what makes the interaction defects visible. `PARITY.md` §4 says it
 * directly and this project has measured it twice: **a DOM diff cannot tell a
 * working control from an inert one.** So every control here is *used*, and the
 * assertion is on what changed, not on what the markup looks like.
 *
 * ## Why a local harness rather than `test/dom-harness.ts`
 *
 * That harness serves `fetchData` and builds the crashes/issues markup. This
 * page fetches through **`fetchFromCI`** — its file lives under its own
 * `manifest-timings` index rather than a harness's — and its markup shares no
 * id with either. Parameterizing the shared harness for a third page whose
 * every id differs is the arrangement its own comment argues against, so the
 * markup below is **copied from `site/manifests.html`** and an id renamed there
 * and not here fails as a null dereference inside `start()`.
 *
 * ## Where the expected values come from
 *
 * Never from the code under test. The row contents are tallied off the raw
 * fixture by `tally()` below, which walks the parallel arrays directly and
 * imports nothing from `site/`; the class names and glyphs are literals taken
 * from `manifests.html`'s own stylesheet and markup.
 *
 * ## Which fixture, and why not the obvious one
 *
 * `test/fixtures/manifests-pathology.json`, **not** `manifests.json`. The
 * latter is the published file truncated to its first 200 runs, which lands on
 * 200 manifests with exactly one job and one run each — measured, minimum and
 * maximum both 1. On that file a sub-row filter can be **deleted** and every
 * assertion here still passes, because no row ever has a second job to hide.
 * The same goes for a multi-point chart, a SKIP row next to a row that ran, and
 * an even-length duration sample.
 *
 * The pathology fixture is 21 manifests selected from the real 2026-08-04 file
 * for those shapes, each recording why it is there; `test/manifests-fixture-gen.ts`
 * builds it and throws if the source cannot supply a shape. The one degenerate
 * case it does **not** carry — one job with one run — does not exist in the
 * corpus (0 of 6,227) and is covered by the hand-authored `fast.toml` in
 * `test/manifests-view.test.ts` instead.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import type { ManifestsFile } from '../lib/formats/manifests.ts';
import { resetForTest, start } from '../site/manifests.ts';
import { formatDuration } from '../site/manifests-view.ts';

// --- the fixture, and ground truth read off it ----------------------------

const FIXTURE = JSON.parse(
    readFileSync(new URL('./fixtures/manifests-pathology.json', import.meta.url), 'utf8')
) as ManifestsFile;

/** manifest -> job -> durations, walked without touching `site/`. */
function tally(file: ManifestsFile): Map<string, Map<string, number[]>> {
    const out = new Map<string, Map<string, number[]>>();
    for (let i = 0; i < file.runs.durations.length; i++) {
        const manifest = file.manifests[file.runs.manifestIds[i]!]!;
        const job = file.jobNames[file.runs.jobNameIds[i]!]!;
        let jobs = out.get(manifest);
        if (jobs === undefined) {
            jobs = new Map();
            out.set(manifest, jobs);
        }
        const durations = jobs.get(job);
        if (durations === undefined) {
            jobs.set(job, [file.runs.durations[i]!]);
        } else {
            durations.push(file.runs.durations[i]!);
        }
    }
    return out;
}

const TALLY = tally(FIXTURE);

/** The overall median of a manifest, by the page's rule, computed here. */
function expectedOverall(manifest: string): { median: number | null; runs: number; jobs: number } {
    const pooled: number[] = [];
    let runs = 0;
    let jobs = 0;
    for (const durations of TALLY.get(manifest)!.values()) {
        if (durations.every((duration) => duration === 0)) {
            continue;
        }
        jobs += 1;
        runs += durations.length;
        pooled.push(...durations);
    }
    if (pooled.length === 0) {
        return { median: null, runs: 0, jobs: 0 };
    }
    pooled.sort((a, b) => a - b);
    return { median: pooled[Math.floor(pooled.length / 2)]!, runs, jobs };
}

/** Manifests that ran nowhere, by the independent walk. */
const SKIPPED_EVERYWHERE = [...TALLY.keys()].filter(
    (manifest) => expectedOverall(manifest).median === null
);

// --- the harness ----------------------------------------------------------

/**
 * `site/manifests.html`'s markup, trimmed to what the controller reaches for.
 *
 * Copied from that file (`:276-350`), including the inline `on*` attributes —
 * which do nothing here, exactly as they do nothing in the browser under a
 * module script (divergence 2). Keeping them means the harness cannot
 * accidentally make a control work that is broken on the real page.
 */
const PAGE_HTML = `<!DOCTYPE html><html><body>
<div class="container">
<h1>Test Manifest Runtime Analysis</h1>
<div class="controls">
  <div class="control-group">
    <label for="manifestSearch">Search Manifests:</label>
    <div class="search-wrapper">
      <input type="text" id="manifestSearch" class="search-input"
             oninput="updateClearButtons(); filterManifests()">
      <span class="clear-search" id="clearManifest" onclick="clearSearch('manifestSearch')">&times;</span>
    </div>
  </div>
  <div class="control-group">
    <label for="jobSearch">Filter Jobs:</label>
    <div class="search-wrapper">
      <input type="text" id="jobSearch" class="search-input"
             oninput="updateClearButtons(); filterManifests()">
      <span class="clear-search" id="clearJob" onclick="clearSearch('jobSearch')">&times;</span>
    </div>
  </div>
</div>
<div id="errorMessage" class="error" style="display: none;"></div>
<div id="loadingMessage" class="loading">Loading manifest timing data...</div>
<div id="contentArea" style="display: none;">
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-label">Total Manifests</div><div class="stat-value" id="statManifests">—</div></div>
    <div class="stat-card"><div class="stat-label">Total Jobs</div><div class="stat-value" id="statJobs">—</div></div>
    <div class="stat-card"><div class="stat-label">Total Runs</div><div class="stat-value" id="statRuns">—</div></div>
    <div class="stat-card"><div class="stat-label">Data Date</div><div class="stat-value" id="statDate">—</div></div>
  </div>
  <table class="manifest-table">
    <thead>
      <tr>
        <th style="width: 40%;" onclick="sortBy('manifest')">Manifest / Job <span class="sort-indicator">▼</span></th>
        <th style="width: 10%;" onclick="sortBy('jobTypes')">Job Types <span class="sort-indicator">▼</span></th>
        <th style="width: 15%;" onclick="sortBy('runs')">Runs <span class="sort-indicator">▼</span></th>
        <th style="width: 15%;" onclick="sortBy('median')">Median Runtime <span class="sort-indicator">▼</span></th>
        <th style="width: 20%;" onclick="sortBy('mean')">Mean Runtime <span class="sort-indicator">▼</span></th>
      </tr>
    </thead>
    <tbody id="manifestTableBody"></tbody>
  </table>
  <div class="pagination">
    <button onclick="prevPage()" id="btnPrev">Previous</button>
    <span id="pageInfo">Page 1 of 1</span>
    <button onclick="nextPage()" id="btnNext">Next</button>
  </div>
</div>
</div>
</body></html>`;

/** One recorded `Plotly.newPlot(...)`. */
interface PlotCall {
    /** The id the page handed Plotly — **not** the element. */
    id: string;
    /** Whether an element with that id was in the document at the time. */
    resolved: boolean;
    x: number[];
    y: number[];
    customdata: { taskId: string; prefix: string }[];
    layout: Record<string, unknown>;
    config: Record<string, unknown>;
}

interface Harness {
    window: JSDOM['window'];
    document: Document;
    tbody: HTMLElement;
    /** Every `Plotly.newPlot` since setup, in order. */
    plots: PlotCall[];
    /** Every `window.open(url, target)`. */
    opened: [string, string][];
    /** Names `fetchFromCI` was asked for, as `index/filename`. */
    requested: string[];
    restore(): void;
}

/**
 * Installs a jsdom page and the globals the controller declares.
 *
 * `Plotly` is **recorded**, not run: it is a CDN global that needs a real
 * layout engine, which jsdom does not have. Recording it is what makes "was a
 * chart drawn, into which element, with what series" assertable at all — the
 * same exception, for the same reason, that `test/dom-harness.ts` documents for
 * Chart.js.
 */
function setupPage(options: { url?: string; file?: ManifestsFile | null } = {}): Harness {
    const dom = new JSDOM(PAGE_HTML, {
        url: options.url ?? 'https://tests.firefox.dev/manifests.html',
        runScripts: 'outside-only',
    });
    // The real `shared.js`, for `getProfilerOrigin` and `setupWindowResize`.
    // Real rather than stubbed: an assertion on a profiler URL then compares
    // two independent computations rather than echoing a value chosen here.
    dom.window.eval(readFileSync(new URL('../shared.js', import.meta.url), 'utf8'));

    const plots: PlotCall[] = [];
    const opened: [string, string][] = [];
    const requested: string[] = [];

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
    // The delegated click handler is `target instanceof Element`, so `Element`
    // has to be the same constructor the nodes were made with.
    for (const name of ['Element', 'Node', 'HTMLElement', 'Event', 'MouseEvent'] as const) {
        set(name, (dom.window as unknown as Record<string, unknown>)[name]);
    }
    set('history', dom.window.history);
    set('location', dom.window.location);
    for (const name of ['getProfilerOrigin', 'setupWindowResize'] as const) {
        const value = (dom.window as unknown as Record<string, unknown>)[name];
        if (value === undefined) {
            throw new Error(`${name} is not defined by shared.js`);
        }
        set(name, value);
    }

    dom.window.open = ((url?: string | URL, target?: string): null => {
        opened.push([String(url), String(target)]);
        return null;
    }) as typeof dom.window.open;

    set('fetchFromCI', async (index: string, filename: string): Promise<Response> => {
        requested.push(`${index}/${filename}`);
        // Pinned: a name with no entry 404s rather than reaching the network,
        // so an unpinned request fails loudly instead of comparing live data.
        const body = options.file === undefined ? FIXTURE : options.file;
        if (body === null) {
            return new Response('not found', { status: 404 });
        }
        return new Response(JSON.stringify(body), { status: 200 });
    });

    set('Plotly', {
        newPlot: (
            id: string,
            traces: readonly Record<string, unknown>[],
            layout: Record<string, unknown>,
            config: Record<string, unknown>
        ): Promise<unknown> => {
            const trace = traces[0] ?? {};
            plots.push({
                id,
                // The load-bearing part: Plotly is handed an **id**, so a page
                // whose container id does not match what it drew into produces
                // a chart that never appears. Resolving it here is what turns
                // that into a test failure rather than a blank cell.
                resolved: dom.window.document.getElementById(id) !== null,
                x: (trace['x'] as number[]) ?? [],
                y: (trace['y'] as number[]) ?? [],
                customdata: (trace['customdata'] as { taskId: string; prefix: string }[]) ?? [],
                layout,
                config,
            });
            // The real `newPlot` decorates the graph div with `on`.
            const element = dom.window.document.getElementById(id) as
                | (HTMLElement & { on?: unknown })
                | null;
            if (element !== null) {
                element.on = (_event: string, handler: unknown): void => {
                    (element as unknown as Record<string, unknown>)['__handler'] = handler;
                };
            }
            return Promise.resolve(null);
        },
    });

    return {
        window: dom.window,
        document: dom.window.document,
        tbody: dom.window.document.getElementById('manifestTableBody')!,
        plots,
        opened,
        requested,
        restore(): void {
            resetForTest();
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

/** Runs a case with a harness, restoring the globals afterwards. */
async function withPage(
    options: { url?: string; file?: ManifestsFile | null },
    body: (harness: Harness) => Promise<void> | void
): Promise<void> {
    const harness = setupPage(options);
    try {
        await start();
        await body(harness);
    } finally {
        harness.restore();
    }
}

// --- reading the rendered table -------------------------------------------

/** One rendered row, as the assertions name it. */
interface Row {
    kind: string;
    cells: string[];
    /** The expand caret's classes, or `null` when the row has none. */
    icon: string | null;
}

function rows(harness: Harness): Row[] {
    return [...harness.tbody.children].map((tr) => {
        const icon = tr.querySelector('.expand-icon, .job-expand-icon');
        return {
            kind: tr.className,
            cells: [...tr.children].map((td) => td.textContent ?? ''),
            icon: icon === null ? icon : icon.className,
        };
    });
}

/** The first cell's text, which is the manifest path or the job name. */
function names(harness: Harness): string[] {
    return rows(harness).map((row) => row.cells[0] ?? '');
}

/** Clicks an element the way a reader does, so the delegated handler runs. */
function click(harness: Harness, element: Element): void {
    element.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }));
}

/**
 * The job name a job row shows, read from the `.job-name` span.
 *
 * Not `tr.textContent`: that concatenates every cell, so it would silently
 * return the name plus the run count plus both durations, and a lookup keyed on
 * it would miss.
 */
function jobNameOf(row: Element): string {
    return row.querySelector('.job-name')!.textContent!;
}

/** Types a whole string, one `input` event per character. */
function type(harness: Harness, id: string, text: string): void {
    const input = harness.document.getElementById(id) as HTMLInputElement;
    input.value = '';
    input.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    for (const character of text) {
        input.value += character;
        input.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    }
}

/**
 * The last index matching a predicate.
 *
 * `Array.prototype.findLastIndex` is ES2023 and this project targets ES2022
 * (`tsconfig.json`), so it is spelled out rather than widening the lib for
 * three call sites in one test file.
 */
function lastIndexWhere<T>(list: readonly T[], matches: (item: T) => boolean): number {
    for (let i = list.length - 1; i >= 0; i--) {
        if (matches(list[i]!)) {
            return i;
        }
    }
    return -1;
}

/** The sort indicators, as `▼`/`▲` with a `*` on the active column. */
function indicators(harness: Harness): string {
    return [...harness.document.querySelectorAll('.manifest-table th')]
        .map((th) => {
            const active = th.classList.contains('sorted') ? '*' : '';
            return active + (th.querySelector('.sort-indicator')?.textContent ?? '');
        })
        .join(' ');
}

// =========================================================================
// First paint
// =========================================================================

test('the page fetches its own index and renders the slowest manifest first', async () => {
    await withPage({}, (harness) => {
        // Its own index, not a harness's. A page asking for
        // `xpcshell-timings` would 404 in production and show an error.
        assert.deepEqual(harness.requested, ['manifest-timings/manifests.json']);

        // The default sort is median **descending**, so the first row is the
        // slowest manifest — computed here from the raw arrays.
        const slowest = [...TALLY.keys()]
            .map((manifest) => ({ manifest, ...expectedOverall(manifest) }))
            .filter((row) => row.median !== null)
            .sort((a, b) => b.median! - a.median!)[0]!;
        assert.equal(names(harness)[0], slowest.manifest);

        // And every SKIP row is **below** every row that ran. This is the
        // first-paint defect, asserted as the thing a reader sees: on the old
        // page all 50 rows of page 1 read SKIP, because the ascending default
        // put the 302 no-runtime manifests first. The fixture holds 21
        // manifests — fewer than one page — of which 6 ran nowhere, so the
        // assertion is about their *position* rather than their absence.
        const rendered = rows(harness);
        const firstSkip = rendered.findIndex((row) => row.cells[3] === 'SKIP');
        const lastRan = lastIndexWhere(rendered, (row) => row.cells[3] !== 'SKIP');
        assert.ok(firstSkip > 0, 'the fixture has SKIP rows, or this proves nothing');
        assert.ok(
            firstSkip > lastRan,
            `a SKIP row is at ${firstSkip}, ahead of a manifest that ran at ${lastRan}`
        );
        assert.equal(indicators(harness), '▼ ▼ ▼ *▼ ▼', 'Median, descending');
    });
});

test('the first row carries the numbers the raw arrays say it should', async () => {
    await withPage({}, (harness) => {
        const first = rows(harness)[0]!;
        const manifest = first.cells[0]!;
        const expected = expectedOverall(manifest);
        assert.equal(first.cells[1], expected.jobs.toLocaleString());
        assert.equal(first.cells[2], expected.runs.toLocaleString());
        // `formatDuration` is imported rather than reimplemented, and that is
        // safe here *because the millisecond value it is given is computed
        // independently above* — the test is checking the aggregation, and the
        // formatting has its own test on literals.
        assert.equal(first.cells[3], formatDuration(expected.median!));
        assert.equal(first.kind, 'manifest-row');
        assert.equal(first.icon, 'expand-icon', 'collapsed, so no `expanded`');
    });
});

test('the four stat cards show the raw table lengths', async () => {
    await withPage({}, (harness) => {
        const text = (id: string): string => harness.document.getElementById(id)!.textContent!;
        assert.equal(text('statManifests'), FIXTURE.manifests.length.toLocaleString());
        assert.equal(text('statJobs'), FIXTURE.jobNames.length.toLocaleString());
        assert.equal(text('statRuns'), FIXTURE.runs.durations.length.toLocaleString());
        assert.equal(text('statDate'), FIXTURE.metadata.date);
        // Built with `toLocaleString` rather than a hardcoded separator: this
        // machine renders 1078 as `1 078` and a literal would pin the wrong one.
    });
});

test('a manifest that ran nowhere renders SKIP in both duration columns', async () => {
    await withPage({}, (harness) => {
        assert.ok(SKIPPED_EVERYWHERE.length > 0, 'the fixture has one, or this proves nothing');
        // Sort ascending by median: the cheapest manifests come first and the
        // skipped ones must **still** be last.
        const headers = [...harness.document.querySelectorAll('.manifest-table th')];
        click(harness, headers[3]!); // median -> ascending
        assert.equal(indicators(harness), '▼ ▼ ▼ *▲ ▼');

        const rendered = names(harness);
        const firstSkipped = rendered.findIndex((name) => SKIPPED_EVERYWHERE.includes(name));
        const lastRan = lastIndexWhere(rendered, (name) => !SKIPPED_EVERYWHERE.includes(name));
        if (firstSkipped !== -1) {
            assert.ok(
                firstSkipped > lastRan,
                'a manifest that ran nowhere is ahead of one that ran, under ascending'
            );
        }

        // And when one is on screen, both duration cells read SKIP rather
        // than `0ms`.
        const skipRow = rows(harness).find((row) => SKIPPED_EVERYWHERE.includes(row.cells[0]!));
        if (skipRow !== undefined) {
            assert.equal(skipRow.cells[3], 'SKIP');
            assert.equal(skipRow.cells[4], 'SKIP');
            assert.equal(skipRow.cells[1], '0', 'no job it ran on');
            assert.equal(skipRow.cells[2], '0', 'no run on a job it ran on');
        }
    });
});

// =========================================================================
// Sorting
// =========================================================================

test('every column sorts, in both directions, and the arrows follow', async () => {
    await withPage({}, (harness) => {
        const headers = [...harness.document.querySelectorAll('.manifest-table th')];
        const expected = ['*▼ ▼ ▼ ▼ ▼', '▼ *▼ ▼ ▼ ▼', '▼ ▼ *▼ ▼ ▼', '▼ ▼ ▼ *▼ ▼', '▼ ▼ ▼ ▼ *▼'];
        for (const [index, header] of headers.entries()) {
            const before = names(harness).join(' ');
            click(harness, header);
            assert.equal(indicators(harness), expected[index], `column ${index}, first click`);
            const descending = names(harness).join(' ');
            click(harness, header);
            assert.equal(
                indicators(harness),
                expected[index]!.replace('*▼', '*▲'),
                `column ${index}, second click`
            );
            const ascending = names(harness).join(' ');
            // The order actually changed. A sort that only repainted the arrow
            // would pass an indicator assertion and fail this one — which is
            // the "inert control" trap.
            assert.notEqual(descending, ascending, `column ${index} reversed nothing`);
            void before;
        }
    });
});

test('the manifest column sorts by name, A to Z when ascending', async () => {
    await withPage({}, (harness) => {
        const headers = [...harness.document.querySelectorAll('.manifest-table th')];
        click(harness, headers[0]!); // descending: Z to A
        const descending = names(harness);
        click(harness, headers[0]!); // ascending: A to Z
        const ascending = names(harness);

        const sorted = [...ascending].sort((a, b) => a.localeCompare(b));
        assert.deepEqual(ascending, sorted, 'ascending really is alphabetical');
        assert.deepEqual(descending, [...descending].sort((a, b) => b.localeCompare(a)));
    });
});

test('sorting keeps the reader on the page they were on', async () => {
    await withPage({ file: WIDE }, (harness) => {
        const next = harness.document.getElementById('btnNext') as HTMLButtonElement;
        click(harness, next);
        assert.match(harness.document.getElementById('pageInfo')!.textContent!, /^Page 2 of /);
        // Upstream never resets the page on a sort (`:487-510`), and neither
        // does this — the row count has not changed, so page 2 still means
        // something and losing the reader's place would be gratuitous.
        click(harness, [...harness.document.querySelectorAll('.manifest-table th')][2]!);
        assert.match(harness.document.getElementById('pageInfo')!.textContent!, /^Page 2 of /);
    });
});

// =========================================================================
// The keystroke sort-flip, which is fixed
// =========================================================================

test('typing does not flip the sort direction, on any keystroke', async () => {
    await withPage({}, (harness) => {
        assert.equal(indicators(harness), '▼ ▼ ▼ *▼ ▼');
        // On the old page each of these six characters flips the arrow, so the
        // direction after typing depends on whether the word has an odd or an
        // even number of letters. Measured in Chrome: `browser` renders `▲`
        // and `browsers` renders `▼`.
        for (const text of ['w', 'we', 'web', 'webd', 'webdr', 'webdri']) {
            type(harness, 'manifestSearch', text);
            assert.equal(indicators(harness), '▼ ▼ ▼ *▼ ▼', `after typing "${text}"`);
        }
        // And clearing does not flip it either.
        click(harness, harness.document.getElementById('clearManifest')!);
        assert.equal(indicators(harness), '▼ ▼ ▼ *▼ ▼');
    });
});

test('a search under an ascending sort stays ascending', async () => {
    await withPage({}, (harness) => {
        click(harness, [...harness.document.querySelectorAll('.manifest-table th')][3]!);
        assert.equal(indicators(harness), '▼ ▼ ▼ *▲ ▼');
        type(harness, 'manifestSearch', 'web');
        // The direction the reader chose survives the search: it is neither
        // flipped nor reset to the default.
        assert.equal(indicators(harness), '▼ ▼ ▼ *▲ ▼');
    });
});

// =========================================================================
// The two search boxes
// =========================================================================

test('the manifest box drops the rows that do not match', async () => {
    await withPage({}, (harness) => {
        const before = names(harness).length;
        type(harness, 'manifestSearch', 'webdriver');
        const after = names(harness);
        // Both halves. A filter that kept everything passes the first
        // assertion alone — the exact hole that let a search be deleted with
        // every test green.
        assert.ok(after.every((name) => name.toLowerCase().includes('webdriver')), 'kept rows match');
        assert.ok(after.length < before, 'and the others are gone');
        // Independently: how many manifests actually contain the needle.
        const expected = [...TALLY.keys()].filter((name) =>
            name.toLowerCase().includes('webdriver')
        ).length;
        assert.equal(
            Number(/of (\d+)$/.exec(harness.document.getElementById('pageInfo')!.textContent!)![1]),
            Math.ceil(expected / 50)
        );
    });
});

test('the job box keeps a manifest whole and narrows its sub-rows', async () => {
    await withPage({}, (harness) => {
        // `android`, not `wdspec`: measured on the fixture, `wdspec` matches
        // **every** job of every manifest that has one, so it drops rows but
        // narrows no subtree — a test on it would pass with `filterJobs`
        // deleted. `android` matches 18 of the 21 manifests and, on each of
        // those 18, a strict subset of its jobs.
        const NEEDLE = 'android';
        const expected = [...TALLY.entries()]
            .filter(([, jobs]) => [...jobs.keys()].some((name) => name.includes(NEEDLE)))
            .map(([manifest]) => manifest);
        assert.ok(expected.length > 0 && expected.length < TALLY.size, 'it drops some rows');

        type(harness, 'jobSearch', NEEDLE);
        const kept = names(harness);
        assert.ok(kept.every((name) => expected.includes(name)), 'only manifests running it');
        assert.equal(kept.length, expected.length, 'and all of them');

        // The row's own numbers are **not** rewritten by the search: this row
        // reports the runs and median of every job it ran, including the ones
        // the needle excluded.
        const first = rows(harness)[0]!;
        const stats = expectedOverall(first.cells[0]!);
        assert.equal(first.cells[2], stats.runs.toLocaleString(), 'unfiltered run count');

        // Expanding shows only the matching jobs, which is where the needle
        // narrows something.
        click(harness, harness.tbody.children[0]!);
        const subRows = rows(harness).filter((row) => row.kind === 'job-row');
        assert.ok(subRows.length > 0, 'the row expanded');
        assert.ok(
            subRows.every((row) => row.cells[0]!.includes(NEEDLE)),
            'a non-matching job is not shown under an expanded row'
        );
        // And the manifest genuinely has jobs that were filtered out, or the
        // assertion above is vacuous — this is the half that fails if
        // `filterJobs` returns `row.jobStats` unconditionally.
        const allJobs = TALLY.get(first.cells[0]!)!.size;
        assert.ok(allJobs > subRows.length, `${allJobs} jobs, ${subRows.length} shown`);
    });
});

test('the × button clears its own box and only its own', async () => {
    await withPage({}, (harness) => {
        type(harness, 'manifestSearch', 'webdriver');
        type(harness, 'jobSearch', 'wdspec');
        const clearManifest = harness.document.getElementById('clearManifest')!;
        const clearJob = harness.document.getElementById('clearJob')!;
        assert.ok(clearManifest.classList.contains('visible'));
        assert.ok(clearJob.classList.contains('visible'));

        click(harness, clearManifest);
        assert.equal((harness.document.getElementById('manifestSearch') as HTMLInputElement).value, '');
        assert.equal(
            (harness.document.getElementById('jobSearch') as HTMLInputElement).value,
            'wdspec',
            'the other box is untouched'
        );
        assert.equal(clearManifest.classList.contains('visible'), false);
        assert.ok(clearJob.classList.contains('visible'), 'and its × stays');
        // The table really re-filtered rather than just clearing the input.
        assert.ok(names(harness).length > 0);
    });
});

test('an empty result disables Next instead of leaving it enabled and inert', async () => {
    await withPage({}, (harness) => {
        type(harness, 'manifestSearch', 'zzzznotamanifestzzzz');
        assert.equal(harness.tbody.children.length, 0);
        assert.equal(harness.document.getElementById('pageInfo')!.textContent, 'Page 1 of 0');
        const next = harness.document.getElementById('btnNext') as HTMLButtonElement;
        assert.equal(next.disabled, true, 'divergence 3');
        assert.equal((harness.document.getElementById('btnPrev') as HTMLButtonElement).disabled, true);
    });
});

// =========================================================================
// Expansion, and the chart
// =========================================================================

test('clicking a manifest row shows one child row per job', async () => {
    await withPage({}, (harness) => {
        const first = names(harness)[0]!;
        const expectedJobs = TALLY.get(first)!.size;

        click(harness, harness.tbody.children[0]!);
        const after = rows(harness);
        assert.equal(after[0]!.kind, 'manifest-row expanded');
        assert.equal(after[0]!.icon, 'expand-icon expanded', 'the caret rotates');
        const jobRows = after.filter((row) => row.kind === 'job-row');
        assert.equal(jobRows.length, expectedJobs, 'one row per (manifest, job) pair');
        // A job row's Job Types cell is deliberately empty, and its Runs cell
        // is the pair's own count.
        assert.equal(jobRows[0]!.cells[1], '');

        // Clicking again collapses it, and leaves no orphan.
        click(harness, harness.tbody.children[0]!);
        assert.equal(rows(harness).filter((row) => row.kind === 'job-row').length, 0);
        assert.equal(rows(harness)[0]!.icon, 'expand-icon');
    });
});

test('a skipped job row reads SKIP and still reports its run count', async () => {
    await withPage({}, (harness) => {
        // A manifest with at least one skipped pair and at least one that ran.
        const entry = [...TALLY.entries()].find(([, jobs]) => {
            const values = [...jobs.values()];
            return (
                values.some((durations) => durations.every((duration) => duration === 0)) &&
                values.some((durations) => durations.some((duration) => duration !== 0))
            );
        });
        if (entry === undefined) {
            return; // The fixture has no such manifest; nothing to assert.
        }
        const [manifest, jobs] = entry;
        type(harness, 'manifestSearch', manifest);
        click(harness, harness.tbody.children[0]!);

        const jobRows = rows(harness).filter((row) => row.kind === 'job-row');
        for (const row of jobRows) {
            const durations = jobs.get(row.cells[0]!)!;
            const skipped = durations.every((duration) => duration === 0);
            assert.equal(row.cells[3], skipped ? 'SKIP' : formatDuration(
                [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)]!
            ), row.cells[0]);
            // The run count is shown either way: the pair has runs.
            assert.equal(row.cells[2], durations.length.toLocaleString());
        }
        // The skipped ones are last.
        const skippedAt = jobRows.findIndex((row) => row.cells[3] === 'SKIP');
        const ranAt = lastIndexWhere(jobRows, (row) => row.cells[3] !== 'SKIP');
        assert.ok(skippedAt > ranAt, 'a skipped job is below every job that ran');
    });
});

test('expanding a job draws exactly one chart, into the element it created', async () => {
    await withPage({}, async (harness) => {
        click(harness, harness.tbody.children[0]!);
        const manifest = names(harness)[0]!;
        const jobRow = [...harness.tbody.children].find((tr) => tr.className === 'job-row')!;
        const jobName = jobNameOf(jobRow);

        click(harness, jobRow);
        // The chart is queued in a microtask, as it is on the page.
        await Promise.resolve();
        await Promise.resolve();

        const chartRows = [...harness.tbody.children].filter((tr) => tr.className === 'chart-row');
        assert.equal(chartRows.length, 1, 'one chart row');
        const cell = chartRows[0]!.firstElementChild as HTMLTableCellElement;
        assert.equal(cell.getAttribute('colspan'), '5', 'the chart spans the whole table');
        const container = cell.firstElementChild as HTMLElement;

        // The check against the mistake this project has made twice: an
        // element was emitted **and** a chart was drawn into it, and they are
        // the same element.
        assert.equal(harness.plots.length, 1, 'exactly one newPlot');
        assert.equal(harness.plots[0]!.id, container.id, 'drawn into the emitted container');
        assert.equal(harness.plots[0]!.resolved, true, 'the id resolves in the document');

        // The series, computed here from the raw arrays.
        const durations = TALLY.get(manifest)!.get(jobName)!;
        assert.deepEqual(harness.plots[0]!.y, durations, 'file order, not sorted');
        assert.deepEqual(
            harness.plots[0]!.x,
            durations.map((_, index) => index + 1),
            'x is 1-based position in the file'
        );
        assert.equal(harness.plots[0]!.customdata.length, durations.length);
        assert.equal(harness.plots[0]!.config['responsive'], true);

        // Collapsing removes the row and does not draw again. The row has to
        // be found again: `renderTable` rebuilds the whole `<tbody>`, so the
        // element captured before the expansion is detached and clicking it
        // reaches no handler — which is a property of the page worth naming
        // rather than working around silently.
        assert.equal(jobRow.isConnected, false, 'the render replaced the row');
        const liveJobRow = [...harness.tbody.children].find(
            (tr) => tr.className === 'job-row' && jobNameOf(tr) === jobName
        )!;
        click(harness, liveJobRow);
        assert.equal([...harness.tbody.children].filter((tr) => tr.className === 'chart-row').length, 0);
        await Promise.resolve();
        assert.equal(harness.plots.length, 1, 'collapsing draws nothing');
    });
});

test('no chart element is ever left without a chart', async () => {
    await withPage({}, async (harness) => {
        // Expand three manifests and a job under each, then check the invariant
        // across the whole table rather than on one row.
        for (let i = 0; i < 3; i++) {
            const manifestRows = [...harness.tbody.children].filter(
                (tr) => tr.className.startsWith('manifest-row')
            );
            click(harness, manifestRows[i]!);
        }
        for (const jobRow of [...harness.tbody.children].filter((tr) => tr.className === 'job-row').slice(0, 3)) {
            click(harness, jobRow);
        }
        await Promise.resolve();
        await Promise.resolve();

        const containers = [...harness.tbody.querySelectorAll('.chart-row div[id]')];
        assert.ok(containers.length >= 1, 'at least one chart is open');
        const drawn = new Set(harness.plots.map((plot) => plot.id));
        for (const container of containers) {
            assert.ok(drawn.has(container.id), `${container.id} was emitted but never drawn`);
        }
        // And nothing was drawn into an id that is not on screen.
        const onScreen = new Set(containers.map((container) => container.id));
        for (const plot of harness.plots) {
            assert.ok(onScreen.has(plot.id), `${plot.id} was drawn but is not in the table`);
        }
    });
});

test('a chart click opens the resource profile, and Alt+click the error summary', async () => {
    await withPage({}, async (harness) => {
        click(harness, harness.tbody.children[0]!);
        const manifest = names(harness)[0]!;
        const jobRow = [...harness.tbody.children].find((tr) => tr.className === 'job-row')!;
        const jobName = jobNameOf(jobRow);
        click(harness, jobRow);
        await Promise.resolve();
        await Promise.resolve();

        const container = harness.document.getElementById(harness.plots[0]!.id) as HTMLElement & {
            __handler?: (data: unknown) => void;
        };
        assert.equal(typeof container.__handler, 'function', 'a plotly_click handler was attached');

        const point = harness.plots[0]!.customdata[0]!;
        // A plain click: the resource profile, in the profiler, focused on the
        // manifest. The expected URL is built here from the raw task id.
        container.__handler!({ points: [{ customdata: point }], event: { altKey: false } });
        assert.equal(harness.opened.length, 1);
        const [url, target] = harness.opened[0]!;
        assert.equal(target, '_blank');
        const parsed = new URL(url);
        assert.equal(parsed.origin, 'https://profiler.firefox.com');
        assert.equal(parsed.searchParams.get('markerSearch'), manifest);
        assert.equal(parsed.searchParams.get('profileName'), `${jobName} (${point.taskId})`);
        assert.match(
            decodeURIComponent(parsed.pathname),
            new RegExp(`/task/${point.taskId.split('.')[0]}/runs/\\d+/.*profile_resource-usage\\.json$`)
        );

        // Alt+click: the error summary log, named after the harness family.
        container.__handler!({ points: [{ customdata: point }], event: { altKey: true } });
        assert.equal(harness.opened.length, 2);
        assert.match(
            harness.opened[1]![0],
            new RegExp(`/test_info/${point.prefix}_errorsummary\\.log$`)
        );
        // The two are different URLs, so a handler ignoring `altKey` fails.
        assert.notEqual(harness.opened[0]![0], harness.opened[1]![0]);
    });
});

test('clicking a job row does not collapse its manifest', async () => {
    await withPage({}, (harness) => {
        click(harness, harness.tbody.children[0]!);
        const jobRow = [...harness.tbody.children].find((tr) => tr.className === 'job-row')!;
        click(harness, jobRow);
        // The manifest is still expanded. Upstream needs `stopPropagation` for
        // this (`:697`); here the delegated handler resolves the nearest row.
        assert.equal(rows(harness)[0]!.kind, 'manifest-row expanded');
        assert.ok(rows(harness).some((row) => row.kind === 'chart-row'));
    });
});

test('expansion survives a re-render, and follows the manifest rather than the position', async () => {
    await withPage({}, (harness) => {
        const first = names(harness)[0]!;
        click(harness, harness.tbody.children[0]!);
        assert.ok(rows(harness).some((row) => row.kind === 'job-row'));

        // Re-sort so the expanded manifest moves. It must still be expanded,
        // and the row that took position 0 must **not** be.
        click(harness, [...harness.document.querySelectorAll('.manifest-table th')][0]!);
        const after = rows(harness);
        const expandedNames = after
            .filter((row) => row.kind === 'manifest-row expanded')
            .map((row) => row.cells[0]);
        if (after.some((row) => row.cells[0] === first)) {
            assert.deepEqual(expandedNames, [first], 'the same manifest, wherever it landed');
        } else {
            // It moved off the page; nothing on this page should be expanded.
            assert.deepEqual(expandedNames, []);
        }
    });
});

// =========================================================================
// Pagination
// =========================================================================

/**
 * The pathology fixture, widened to more than two pages of manifests.
 *
 * 21 manifests is one page, so the pager cannot be exercised on it. Rather than
 * choose the fixture for the pager and lose the pathologies, each manifest is
 * re-emitted under `copyN/` prefixes: the **row count** is what paging depends
 * on, and every row still carries real durations, real jobs and the real
 * skipped/ran mix. `web` appears in some names and not others, so the
 * "search resets the page" case has something to narrow to.
 *
 * The runs are copied wholesale, so `copy3/dom/payments/…` is skipped
 * everywhere exactly as the original is — the widening does not launder a
 * pathology away.
 */
function widened(copies: number): ManifestsFile {
    const base = FIXTURE;
    const manifests: string[] = [];
    const manifestIds: number[] = [];
    const jobNameIds: number[] = [];
    const taskIds: number[] = [];
    const durations: number[] = [];
    for (let copy = 0; copy < copies; copy++) {
        const offset = manifests.length;
        manifests.push(...base.manifests.map((name) => `copy${copy}/${name}`));
        for (let i = 0; i < base.runs.durations.length; i++) {
            manifestIds.push(offset + base.runs.manifestIds[i]!);
            jobNameIds.push(base.runs.jobNameIds[i]!);
            taskIds.push(base.runs.taskIds[i]!);
            durations.push(base.runs.durations[i]!);
        }
    }
    return {
        ...base,
        manifests,
        runs: { manifestIds, jobNameIds, taskIds, durations },
    };
}

/** 6 copies of 21 = 126 manifests, so three pages of 50 and a short one. */
const WIDE = widened(6);

test('Next and Previous move a page and stop at the ends', async () => {
    await withPage({ file: WIDE }, (harness) => {
        const info = (): string => harness.document.getElementById('pageInfo')!.textContent!;
        const prev = harness.document.getElementById('btnPrev') as HTMLButtonElement;
        const next = harness.document.getElementById('btnNext') as HTMLButtonElement;
        const total = Number(/of (\d+)$/.exec(info())![1]);
        // 126 manifests at 50 a page is 3, derived here rather than read back.
        assert.equal(total, Math.ceil(WIDE.manifests.length / 50));
        assert.ok(total > 2, 'the fixture needs three pages, or this proves little');

        assert.equal(prev.disabled, true, 'page 1: Previous is disabled');
        const page1 = names(harness).join(' ');

        click(harness, next);
        assert.equal(info(), `Page 2 of ${total}`);
        assert.equal(prev.disabled, false);
        const page2 = names(harness).join(' ');
        // Different rows, not just a different label.
        assert.notEqual(page1, page2);

        click(harness, prev);
        assert.equal(info(), `Page 1 of ${total}`);
        assert.equal(names(harness).join(' '), page1, 'back to the same rows');

        // Walk to the last page and confirm Next disables itself there.
        for (let i = 1; i < total; i++) {
            click(harness, next);
        }
        assert.equal(info(), `Page ${total} of ${total}`);
        assert.equal(next.disabled, true);
        click(harness, next);
        assert.equal(info(), `Page ${total} of ${total}`, 'a disabled Next does nothing');
    });
});

test('a search resets to page 1 before the render, not after', async () => {
    await withPage({ file: WIDE }, (harness) => {
        const info = (): string => harness.document.getElementById('pageInfo')!.textContent!;
        click(harness, harness.document.getElementById('btnNext')!);
        assert.match(info(), /^Page 2 /);

        type(harness, 'manifestSearch', 'web');
        // Divergence 4. Upstream renders page 2 of the new result and only
        // then assigns `currentPage = 1`, so the label, the buttons and the
        // rows are all one render behind.
        assert.match(info(), /^Page 1 /);
        assert.equal((harness.document.getElementById('btnPrev') as HTMLButtonElement).disabled, true);
        // And the rows really are the first page of the new result.
        const shown = names(harness);
        assert.ok(shown.every((name) => name.toLowerCase().includes('web')));
    });
});

// =========================================================================
// URL state
// =========================================================================

test('the searches come out of the URL on load', async () => {
    await withPage(
        { url: 'https://tests.firefox.dev/manifests.html?q=webdriver&job=wdspec' },
        (harness) => {
            assert.equal(
                (harness.document.getElementById('manifestSearch') as HTMLInputElement).value,
                'webdriver'
            );
            assert.equal(
                (harness.document.getElementById('jobSearch') as HTMLInputElement).value,
                'wdspec'
            );
            // Both × buttons show, and the table is already narrowed — the
            // page paints the result once rather than painting everything.
            assert.ok(harness.document.getElementById('clearManifest')!.classList.contains('visible'));
            assert.ok(
                names(harness).every((name) => name.toLowerCase().includes('webdriver')),
                'the filter was applied before the first paint'
            );
        }
    );
});

test('typing writes the search into the URL, and clearing removes it', async () => {
    await withPage({}, (harness) => {
        type(harness, 'manifestSearch', 'web');
        assert.equal(new URL(harness.window.location.href).searchParams.get('q'), 'web');
        type(harness, 'jobSearch', 'wdspec');
        assert.equal(new URL(harness.window.location.href).searchParams.get('job'), 'wdspec');

        click(harness, harness.document.getElementById('clearManifest')!);
        const url = new URL(harness.window.location.href);
        assert.equal(url.searchParams.has('q'), false, 'deleted, not set to empty');
        assert.equal(url.searchParams.get('job'), 'wdspec');
    });
});

test('a burst of keystrokes is one history entry, not one per character', async () => {
    await withPage({}, (harness) => {
        const before = harness.window.history.length;
        type(harness, 'manifestSearch', 'webdriver');
        // Nine characters. Upstream's push-then-replace keeps it to one entry,
        // and this reproduces it — a page pushing per keystroke makes the Back
        // button useless.
        assert.equal(
            harness.window.history.length - before,
            1,
            'nine keystrokes should add one entry'
        );
    });
});

test('popstate re-reads the URL without flipping the sort or keeping the page', async () => {
    await withPage({ file: WIDE }, async (harness) => {
        // A search whose result is still more than one page, so that being on
        // page 2 when the `popstate` lands is reachable. `copy` prefixes every
        // manifest in the widened fixture, so this keeps all 126.
        type(harness, 'manifestSearch', 'copy');
        click(harness, harness.document.getElementById('btnNext')!);
        assert.match(harness.document.getElementById('pageInfo')!.textContent!, /^Page 2 /);

        // **Wait out the 500 ms debounce before the popstate**, and this wait
        // is load-bearing rather than incidental. `syncFiltersToUrl` pushes
        // only when `pushStateTimer` is null; inside the window it *replaces*.
        // A `popstate` fired immediately after typing therefore takes the
        // replace branch even in a handler that wrongly calls
        // `onFiltersChanged`, so `history.length` does not move and the
        // assertion below cannot see the defect. Measured: with the wait,
        // the mutated handler takes the history from 2 entries to 3; without
        // it, from 2 to 2. This is exactly how the mutation survived the first
        // version of this test.
        await new Promise((resolve) => setTimeout(resolve, 600));

        // Simulate the browser restoring the earlier URL and firing popstate.
        harness.window.history.replaceState(null, '', 'https://tests.firefox.dev/manifests.html');
        const entriesBefore = harness.window.history.length;
        harness.window.dispatchEvent(new harness.window.Event('popstate'));

        // **The handler must not push.** Upstream is explicit about it —
        // `:929` "Apply filters without pushing new history" — and it is the
        // half a DOM comparison cannot see: a `popstate` that pushes leaves the
        // entry the reader just navigated away from sitting on top of the
        // stack, so pressing Back again returns to where they already are and
        // the button stops working.
        assert.equal(
            harness.window.history.length,
            entriesBefore,
            'popstate must not add a history entry'
        );
        assert.equal(
            harness.window.location.search,
            '',
            'and must not rewrite the URL it was just handed'
        );

        assert.equal(
            (harness.document.getElementById('manifestSearch') as HTMLInputElement).value,
            '',
            'the box follows the URL'
        );
        // Neither of the two `popstate` defects: the sort does not flip
        // (upstream's `:937` calls `sortBy`), and the page resets before the
        // render (upstream's `:938` assigns after it — measured in Chrome as
        // "Page 2 of 5" after Back).
        assert.equal(indicators(harness), '▼ ▼ ▼ *▼ ▼');
        assert.match(harness.document.getElementById('pageInfo')!.textContent!, /^Page 1 /);
        assert.ok(names(harness).length > 0);
        assert.equal(
            harness.document.getElementById('clearManifest')!.classList.contains('visible'),
            false
        );
    });
});

// =========================================================================
// Failure
// =========================================================================

test('a failed fetch shows the error and hides the table', async () => {
    await withPage({ file: null }, (harness) => {
        const error = harness.document.getElementById('errorMessage')!;
        assert.equal(error.style.display, 'block');
        assert.match(error.textContent!, /404/);
        assert.equal(harness.document.getElementById('loadingMessage')!.style.display, 'none');
        // The content area stays hidden rather than showing an empty table.
        assert.equal(harness.document.getElementById('contentArea')!.style.display, 'none');
    });
});
