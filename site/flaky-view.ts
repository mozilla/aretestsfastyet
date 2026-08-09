/**
 * `flaky.html`'s **view model**: every decision the page makes, as plain
 * values, with no DOM.
 *
 * The seam this project holds (`docs/PARITY.md`, and the rule recorded on the
 * earlier migrations): `lib/` holds the data and the derivations, and the page
 * directory holds anything that names an element id, a CSS class or a UI glyph.
 * So `lib/query/flakiness.ts` decides *what is flaky* and this file decides
 * *what the reader sees* — which rows exist, in what order, expanded or not,
 * and which colour band a percentage falls in.
 *
 * ## What this page is
 *
 * A new page rather than a migration, so there is no old page to be
 * byte-identical to and no divergence list. It answers one question — how flaky
 * is the tree, and where — in two parts:
 *
 * 1. a stacked chart of flaky / stable / skipped tests per day across the
 *    window, with a 7-day centred average of the flaky rate over it;
 * 2. a drillable folder table, each row carrying its subtree's counts and
 *    percentages, coloured by the flaky percentage.
 *
 * It reads the **same files as `issues.html`** — `{harness}-issues.json` for
 * the 21-day window and `{harness}-<date>.json` for a single day — and never
 * loads the 15.9 MB `-with-taskids` variant, because nothing here needs to name
 * the job behind a failure.
 *
 * ## The table's rows are a *flattened* tree
 *
 * The natural encoding of a drillable tree is nested elements, and it is the
 * wrong one here: the table is a grid whose columns must line up across
 * every level, and nesting `<div>`s inside rows makes each level a new
 * formatting context that has to be re-aligned with padding. So the tree is
 * flattened to a list of rows carrying a `depth`, exactly as the other
 * drilldown pages do, and expansion inserts or removes a contiguous run of
 * rows. `visibleRows` is that flattening.
 */

import {
    type FlakyCounts,
    type FlakyDay,
    type FolderListRow,
    type FolderNode,
    type TestLeaf,
    flakyPercentage,
    folderList,
    runningAverage,
} from '../lib/query/flakiness.ts';

/**
 * One row of the folder table — a folder, or a test file inside one.
 *
 * The two are one type rather than a union because every column applies to
 * both: a test file has the same three states and the same percentages as the
 * folder holding it, and the table would otherwise need a parallel set of
 * cells that render identically. `kind` is what the renderer branches on for
 * the icon and the click behaviour, and nothing else.
 */
export interface FolderRow {
    kind: 'folder' | 'test';
    /** The folder this row shows, or the folder a test row lives in. */
    node: FolderNode;
    /** The test, on a `test` row. */
    test?: TestLeaf | undefined;
    /** The full path, for the key and the Searchfox link. */
    path: string;
    /** What the row is labelled with. */
    name: string;
    /** How deep it sits, 0 for a top-level folder. */
    depth: number;
    /** Whether it has children to open. Always false for a test. */
    expandable: boolean;
    /** Whether it is currently open. */
    expanded: boolean;
    flaky: number;
    stable: number;
    skipped: number;
    total: number;
    /** Test files at or below this row. 1 for a test. */
    testCount: number;
    /** `flaky / total * 100`, unrounded. */
    flakyPercent: number;
    /** `stable / total * 100`, unrounded. */
    stablePercent: number;
    /** `skipped / total * 100`, unrounded. */
    skippedPercent: number;
}

/**
 * How the table is ordered.
 *
 * `flaky` is the default and is a **count**, not a percentage: a folder holding
 * one test that failed is 100% flaky and is not where triage starts. The
 * percentage is what colours the row.
 */
export type SortField = 'name' | 'flaky' | 'percent' | 'skipped' | 'skipPercent' | 'total';

export interface SortState {
    field: SortField;
    /** `false` is descending, which is the default for every numeric column. */
    ascending: boolean;
}

/** The table opens on the folders with the most flaky tests. */
export const INITIAL_SORT: SortState = { field: 'flaky', ascending: false };

/** The columns, in order, with the label each header shows. */
export const COLUMNS: readonly [SortField, string][] = [
    ['flaky', 'Flaky'],
    ['percent', 'Flaky %'],
    ['skipped', 'Skipped'],
    ['skipPercent', 'Skip %'],
    ['total', 'Tests'],
];

/**
 * The label of the last column.
 *
 * Always a count of **tests**, in both modes: a test counts once whether the
 * table covers one day or the window. This function exists because it briefly
 * did not — an earlier `allDays` counted one per day a test ran, so the same
 * column meant tests on one day and test-days over the window (4,805 against
 * 100,716) under one header. That is fixed in `windowState` rather than
 * papered over here, and the label is kept as a function so the two modes are
 * visibly asserted to agree.
 */
export function totalColumnLabel(_allDays: boolean): string {
    return 'Tests';
}

/**
 * The next sort state when a header is clicked.
 *
 * Clicking the active column reverses it; clicking a new one starts at that
 * column's natural direction — ascending for the name, descending for every
 * number, because "most flaky first" is what a reader wants from one click.
 */
export function nextSort(current: SortState, field: SortField): SortState {
    if (current.field === field) {
        return { field, ascending: !current.ascending };
    }
    return { field, ascending: field === 'name' };
}

/**
 * Whether a test file is worth a row of its own.
 *
 * A test that passed everywhere on every day it ran has nothing for a reader to
 * act on, and listing it buries the ones that do. Measured on the pinned
 * xpcshell window, clean tests are **707 of 4,807 leaves (15%)** over the 21-day
 * view and **3,122 of 4,805 (65%)** on a single day — so on the day view two
 * rows in three were padding, and expanding `services/sync/tests/unit` gave 103
 * rows of which 93 were fine.
 *
 * They stay in every **count**: a folder's `total`, its percentages and the
 * denominator behind them are unchanged, so hiding a row never moves a number.
 * The folder row's own "N tests" is the honest population and the listing under
 * it is the work — see `hiddenCleanTests`, which names the difference rather
 * than leaving a reader to notice the rows do not add up to the count.
 */
function isWorthListing(leaf: TestLeaf): boolean {
    return leaf.flaky > 0 || leaf.skipped > 0;
}

/**
 * The skip percentage, over the tests that could have been skipped.
 *
 * `total` is the exclusive verdict's population and the skipped column overlaps
 * it — a flaky-and-skipped test is in both — so `skipped / total` is a share of
 * a set the numerator is not a subset of. It cannot exceed 100% on this data,
 * but it is the wrong ratio, and it is why the three columns no longer add up.
 *
 * The denominator is therefore the same `total`, stated as "of all tests here"
 * rather than implied to be one slice of a pie. Kept as a named function so the
 * choice is visible and testable rather than inlined at four call sites.
 */
export function skipPercentOf(counts: { skipped: number; total: number }): number {
    return counts.total > 0 ? (counts.skipped / counts.total) * 100 : 0;
}

/**
 * How many of a folder's own tests were left out of its listing.
 *
 * Rendered as a note under the last row, because a listing shorter than the
 * count above it is otherwise a silent discrepancy — the exact class of thing
 * this project's notes warn about.
 */
export function hiddenCleanTests(node: FolderNode): number {
    return node.tests.filter((leaf) => !isWorthListing(leaf)).length;
}

/** The counters every sortable thing — a folder, a test, a list row — has. */
interface Sortable {
    flaky: number;
    skipped: number;
    total: number;
    /** The path, as the stable tie-break. */
    key: string;
    /** The display name, for the name column. */
    label: string;
}

/**
 * Compares two sortable things by the active column.
 *
 * One comparator for the tree, the leaves and the flat list, so a column cannot
 * mean one thing at one level and something else at another. The tie-break is
 * always the path, which makes every ordering total and therefore stable across
 * re-renders.
 */
function compare(a: Sortable, b: Sortable, sort: SortState): number {
    const direction = sort.ascending ? 1 : -1;
    const percent = (item: Sortable): number =>
        item.total > 0 ? (item.flaky / item.total) * 100 : 0;
    const skipPercent = (item: Sortable): number =>
        item.total > 0 ? (item.skipped / item.total) * 100 : 0;
    switch (sort.field) {
        case 'name':
            return direction * a.label.localeCompare(b.label) || a.key.localeCompare(b.key);
        case 'flaky':
            return direction * (a.flaky - b.flaky) || a.key.localeCompare(b.key);
        case 'skipped':
            return direction * (a.skipped - b.skipped) || a.key.localeCompare(b.key);
        case 'total':
            return direction * (a.total - b.total) || a.key.localeCompare(b.key);
        case 'percent':
            return direction * (percent(a) - percent(b)) || a.key.localeCompare(b.key);
        case 'skipPercent':
            return direction * (skipPercent(a) - skipPercent(b)) || a.key.localeCompare(b.key);
    }
}

const asSortable = (node: FolderNode): Sortable => ({
    flaky: node.flaky,
    skipped: node.skipped,
    total: node.total,
    key: node.path,
    label: node.name,
});

const leafAsSortable = (leaf: TestLeaf): Sortable => ({
    flaky: leaf.flaky,
    skipped: leaf.skipped,
    total: leaf.total,
    key: leaf.fullPath,
    label: leaf.name,
});

/**
 * Whether a node or anything under it matches the search term.
 *
 * Matching a *folder* by its full path means typing `dom/base` keeps that
 * subtree, and matching an ancestor keeps everything beneath it — otherwise a
 * search for `dom` would show `dom` with no children to open, which reads as
 * "this folder is empty" rather than "everything here matched".
 */
/**
 * Whether a folder or anything under it matches — **folders only**.
 *
 * The search deliberately does not match test file names. It used to, and the
 * cost was the tree unpacking itself: on the pinned window `browser` matched one
 * folder and twelve files whose own names contain the word
 * (`test_ext_browserSettings.js` and friends), all five levels deep, so
 * reaching them auto-opened **33 folders**. The reader asked for a folder and got
 * the whole subtree.
 *
 * So a search answers "which folders are these", and files are found by opening
 * one. That keeps a search result a short list, and it is why nothing here
 * looks at `node.tests`.
 */
function matches(node: FolderNode, needle: string): boolean {
    if (needle === '' || node.path.toLowerCase().includes(needle)) {
        return true;
    }
    return node.children.some((child) => matches(child, needle));
}

/**
 * Whether this node matches the search *itself*, rather than through a
 * descendant.
 *
 * The distinction is what lets a search auto-open the path down to its results
 * without also blowing open the whole subtree underneath them: an ancestor of a
 * match is opened, the match itself is left as the reader's to expand.
 */
function matchesSelf(node: FolderNode, needle: string): boolean {
    return needle !== '' && node.path.toLowerCase().includes(needle);
}

/**
 * The visible rows, flattened depth-first from the root's children.
 *
 * The root itself is not a row — it is the table's total, rendered separately —
 * so the top level of the table is the repository's top-level directories.
 *
 * ## What a search does to the tree
 *
 * A search **opens the path down to its matches**, rather than filtering the
 * top level and leaving the reader to dig. Typing `netwerk/test` otherwise
 * shows a single collapsed `netwerk` row — the subtree is kept, but nothing
 * says so, and the row reads as the answer when it is only the way to it.
 *
 * So a folder that contains a match is expanded for the duration of the search
 * whether or not the reader opened it, and a folder that *is* a match is left
 * in whatever state they left it: opening the match's own children too would
 * bury a one-line answer under its whole subtree. Neither touches `expanded`,
 * so clearing the search restores exactly the tree the reader had built.
 *
 * ## Where the test files go
 *
 * An expanded folder lists its **subfolders first, then its own test files**.
 * That order is not alphabetical convenience: a folder's subfolders are
 * themselves aggregates that can be drilled further, and its loose files are
 * the leaves of that branch, so putting the files last means the tree structure
 * stays contiguous and the reader is not scrolling past 300 test names to reach
 * the next directory.
 */
export function visibleRows(
    root: FolderNode,
    expanded: ReadonlySet<string>,
    sort: SortState,
    searchTerm = ''
): FolderRow[] {
    const needle = searchTerm.toLowerCase().trim();
    const rows: FolderRow[] = [];

    // How deep the search is allowed to open a branch on its own.
    //
    // A needle matches a *substring of a path*, so searching `browser` matches
    // `toolkit/components/extensions/test/xpcshell/test_browser.js` and would
    // drag its whole five-level ancestry open. Measured on the pinned window,
    // `browser` opened 33 folders and produced 33 inline charts without the
    // reader having clicked anything.
    //
    // So an auto-opened branch stops once the folder itself matches: the reader
    // is shown *where* the matches are and opens the rest. A folder the reader
    // opened by hand is never closed by this — `expanded` still wins below.
    const autoOpenDepth = (node: FolderNode): boolean => !matchesSelf(node, needle);

    const percentsOf = (counts: {
        flaky: number;
        stable: number;
        skipped: number;
        total: number;
    }): { flakyPercent: number; stablePercent: number; skippedPercent: number } => ({
        flakyPercent: counts.total > 0 ? (counts.flaky / counts.total) * 100 : 0,
        stablePercent: counts.total > 0 ? (counts.stable / counts.total) * 100 : 0,
        skippedPercent: counts.total > 0 ? (counts.skipped / counts.total) * 100 : 0,
    });

    const walk = (node: FolderNode, depth: number): void => {
        const children = [...node.children].sort((a, b) =>
            compare(asSortable(a), asSortable(b), sort)
        );
        for (const child of children) {
            if (!matches(child, needle)) {
                continue;
            }
            // What the search opens on its own.
            //
            // Only a branch that has **no matching folder of its own** is
            // auto-opened, and only down to the first folder that does match.
            // `toolkit` matching nothing but *containing* `…/test_browser.js`
            // used to open its whole five-level ancestry; now it opens only if
            // there is no folder on the way down that names the needle itself,
            // and stops as soon as one does.
            //
            // A folder the reader opened by hand always wins, so clearing the
            // search restores exactly their tree.
            const isExpanded =
                expanded.has(child.path) ||
                (needle !== '' &&
                    autoOpenDepth(child) &&
                    // ...and there is a matching folder further down to reach.
                    child.children.some((grandchild) => matches(grandchild, needle)));
            rows.push({
                kind: 'folder',
                node: child,
                path: child.path,
                name: child.name,
                depth,
                // A folder is expandable if it has subfolders or test files
                // **worth listing**: a directory whose every test is clean
                // would otherwise offer a triangle that opens onto nothing.
                expandable:
                    child.children.length > 0 || child.tests.some(isWorthListing),
                expanded: isExpanded,
                flaky: child.flaky,
                stable: child.stable,
                skipped: child.skipped,
                total: child.total,
                testCount: child.testCount,
                ...percentsOf(child),
            });
            if (isExpanded) {
                walk(child, depth + 1);
            }
        }

        // The folder's own test files, after its subfolders. Tests that passed
        // everywhere are left out — see `isWorthListing`.
        const tests = node.tests
            .filter(isWorthListing)
            .sort((a, b) => compare(leafAsSortable(a), leafAsSortable(b), sort));
        for (const leaf of tests) {
            // No per-file search filter: the search matches folders, so once a
            // folder is open every one of its listable tests belongs to the
            // result. Filtering them again would show an opened folder with
            // some of its tests missing and no way to tell why.
            rows.push({
                kind: 'test',
                node,
                test: leaf,
                path: leaf.fullPath,
                name: leaf.name,
                depth,
                expandable: false,
                expanded: false,
                flaky: leaf.flaky,
                stable: leaf.stable,
                skipped: leaf.skipped,
                total: leaf.total,
                testCount: 1,
                ...percentsOf({ ...leaf, stable: leaf.stable }),
            });
        }
    };
    // The root's own loose files are reached by the same walk, at depth 0.
    walk(root, 0);
    return rows;
}

/** One row of the flat, non-tree folder list. */
export interface ListRow extends FolderListRow {
    flakyPercent: number;
    skippedPercent: number;
    /** `selfFlaky / selfTotal * 100`. */
    selfFlakyPercent: number;
}

/**
 * The flat folder list, ranked by the active sort.
 *
 * The tree's alternative, for the burndown question: *which single directory
 * should I book a session on*. Ranked by `selfFlaky` — the flaky tests directly
 * in the folder — because the subtree roll-up always puts `toolkit` first by
 * virtue of containing everything, which is not an answer anyone can act on.
 *
 * The `flaky` column therefore shows `selfFlaky` here and the subtree total in
 * the tree. That is a real difference between the two views and the page labels
 * it, rather than quietly showing the same header over two different numbers.
 */
export function listRows(
    root: FolderNode,
    sort: SortState,
    searchTerm = ''
): ListRow[] {
    const needle = searchTerm.toLowerCase().trim();
    const rows = folderList(root)
        .filter((row) => needle === '' || row.path.toLowerCase().includes(needle))
        .map((row) => ({
            ...row,
            flakyPercent: row.selfTotal > 0 ? (row.selfFlaky / row.selfTotal) * 100 : 0,
            skippedPercent: row.total > 0 ? (row.skipped / row.total) * 100 : 0,
            selfFlakyPercent: row.selfTotal > 0 ? (row.selfFlaky / row.selfTotal) * 100 : 0,
        }));

    rows.sort((a, b) =>
        compare(
            // The list ranks on the folder's *own* tests, so the comparator is
            // handed those counters rather than the subtree's.
            { flaky: a.selfFlaky, skipped: a.skipped, total: a.selfTotal, key: a.path, label: a.name },
            { flaky: b.selfFlaky, skipped: b.skipped, total: b.selfTotal, key: b.path, label: b.name },
            sort
        )
    );
    return rows;
}

/**
 * The test files of one folder, for an expanded row in the flat list.
 *
 * The list's rows are folders wherever they sit in the tree, so opening one has
 * to find its node again by path — there is no parent row to walk down from, as
 * there is in the tree view. Only the folder's **own** files are returned, which
 * is the same set its `selfFlaky` counts, so the rows under a row add up to it.
 *
 * Ranked worst-first by the same comparator the rest of the table uses, and
 * **flaky tests first regardless of the active column** is deliberate: a reader
 * who opened a burndown candidate wants the tests to fix at the top, not
 * whatever alphabetical order the folder happens to have.
 */
export function testsOfFolder(
    root: FolderNode,
    path: string,
    sort: SortState
): FolderRow[] {
    const node = findFolder(root, path);
    if (node === null) {
        return [];
    }
    return node.tests
        .filter(isWorthListing)
        .sort((a, b) => compare(leafAsSortable(a), leafAsSortable(b), sort))
        .map((leaf) => ({
            kind: 'test' as const,
            node,
            test: leaf,
            path: leaf.fullPath,
            name: leaf.name,
            depth: 0,
            expandable: false,
            expanded: false,
            flaky: leaf.flaky,
            stable: leaf.stable,
            skipped: leaf.skipped,
            total: leaf.total,
            testCount: 1,
            flakyPercent: leaf.total > 0 ? (leaf.flaky / leaf.total) * 100 : 0,
            stablePercent: leaf.total > 0 ? (leaf.stable / leaf.total) * 100 : 0,
            skippedPercent: leaf.total > 0 ? (leaf.skipped / leaf.total) * 100 : 0,
        }));
}

/** Finds a folder node by its full path, or `null`. */
export function findFolder(root: FolderNode, path: string): FolderNode | null {
    if (root.path === path) {
        return root;
    }
    for (const child of root.children) {
        // Only descend where the path can be — the tree is deep and a full walk
        // per expanded row is wasted work.
        if (path === child.path || path.startsWith(`${child.path}/`)) {
            return findFolder(child, path);
        }
    }
    return null;
}

/**
 * Whether an inline chart has anything to draw.
 *
 * `chartVisibility` on `issues.html` answers the same question for the same
 * reason: a folder whose tests were only ever skipped should show the skip line
 * and not an empty flaky one, and a folder with a single day of data should show
 * no chart at all rather than a one-point plot.
 */
export function inlineChartVisible(days: readonly FlakyDay[]): boolean {
    return days.length > 1 && days.some((day) => day.total > 0);
}

/**
 * Every ancestor path of a folder, so opening a search result can reveal it.
 *
 * `dom/base/test` yields `dom`, `dom/base`, `dom/base/test`.
 */
export function ancestorPaths(path: string): string[] {
    const segments = path.split('/');
    const paths: string[] = [];
    let current = '';
    for (const segment of segments) {
        current = current === '' ? segment : `${current}/${segment}`;
        paths.push(current);
    }
    return paths;
}

/**
 * The colour band a flaky percentage falls in.
 *
 * Five bands rather than a continuous gradient: a reader compares rows by
 * *category* — "these are the bad ones" — and a continuous scale makes 21% and
 * 24% two different colours that mean the same thing. The thresholds are set
 * against the measured distribution of the pinned xpcshell window, whose daily
 * tree-wide rate sits between 12% and 24%, so the middle band is where a
 * typical folder lands and the outer bands are genuinely unusual.
 *
 * Returned as a class-name suffix rather than a colour, because the stylesheet
 * owns the palette.
 */
export function flakyBand(percent: number): 'none' | 'low' | 'medium' | 'high' | 'severe' {
    if (percent <= 0) {
        return 'none';
    }
    if (percent < 10) {
        return 'low';
    }
    if (percent < 25) {
        return 'medium';
    }
    if (percent < 50) {
        return 'high';
    }
    return 'severe';
}

/**
 * A percentage as the page prints it.
 *
 * Rounded **once**, from the raw ratio — `page-migration-pattern` records
 * double-rounding as a defect reviews keep finding, and it shipped a wrong
 * digit once. One decimal below 10% and none above, because the difference
 * between 3.2% and 3.4% is worth seeing and the difference between 62% and 63%
 * is not.
 */
export function formatPercent(percent: number): string {
    if (percent === 0) {
        return '0%';
    }
    if (percent < 10) {
        return `${percent.toFixed(1)}%`;
    }
    return `${Math.round(percent)}%`;
}

/**
 * The two charts' series, ready for Chart.js.
 *
 * **Two charts, not one with two axes.** A dual-axis chart makes the reader
 * decode which series belongs to which scale before they can read either, and
 * the two questions are genuinely separate: "how many tests are in trouble"
 * and "what share of the tree is that". Splitting them lets each own its
 * y-axis and its own zero.
 *
 * **`stable` is not plotted.** It is ~80% of every day, so including it in the
 * stack fixes the y-axis around 4,800 and compresses the flaky and skipped
 * bands — the two series the page exists to show — into the bottom fifth of the
 * plot. It stays in every denominator, in the tiles and in the table; it is
 * only the *chart* that drops it, and the counts chart is labelled so that
 * absence is stated rather than implied.
 */
export interface ChartSeries {
    labels: string[];
    /** The counts chart: flaky and skipped, stacked. */
    flaky: number[];
    skipped: number[];
    /** Kept for the tooltip's denominator, not drawn. */
    stable: number[];
    total: number[];
    /** The percentage chart: the flaky share per day. */
    flakyPercent: number[];
    /** The centred 7-day mean of `flakyPercent`, `null` where undefined. */
    average: (number | null)[];
    /** The skipped share per day, drawn alongside the flaky one. */
    skippedPercent: number[];
}

/** The window of the running average, in days. */
export const AVERAGE_WINDOW = 7;

/**
 * Turns the per-day counts into the arrays the chart draws.
 *
 * The labels are `MM-DD`: the year is the same for every point in a 21-day
 * window and spending axis width on it costs a tick.
 */
export function chartSeries(days: readonly FlakyDay[]): ChartSeries {
    return {
        labels: days.map((day) => day.date.slice(5)),
        flaky: days.map((day) => day.flaky),
        stable: days.map((day) => day.stable),
        skipped: days.map((day) => day.skipped),
        total: days.map((day) => day.total),
        flakyPercent: days.map((day) => flakyPercentage(day)),
        skippedPercent: days.map((day) =>
            day.total > 0 ? (day.skipped / day.total) * 100 : 0
        ),
        average: runningAverage(days, AVERAGE_WINDOW),
    };
}

/**
 * What each headline tile means, spelled out for a tooltip.
 *
 * The three states are cheap to name and easy to misread — "stable" sounds like
 * "never failed", which is only true with the noise filter off — so the wording
 * is **derived from the threshold in force** rather than written once. With a
 * threshold of 1 a test that failed a single time in three weeks is counted as
 * passing, so "stable" really means "passed every time, or failed no more than
 * once", and "flaky" means "failed at least twice".
 *
 * `days` is the window's length so the text can say "in the last 21 days"
 * rather than "in the window", and `threshold` is the *effective* one — 0 on a
 * single-day view, where the filter cannot apply.
 */
export function tileTooltips(
    threshold: number,
    days: number
): { stable: string; flaky: string; skipped: string } {
    const window = days === 1 ? 'on this day' : `in the last ${days} days`;
    if (threshold <= 0) {
        return {
            stable: `Passed every time it ran, and was never skipped, ${window}.`,
            flaky: `Failed at least once ${window} — a failure, a timeout or a crash.`,
            skipped: `Never failed ${window}, but was skipped on at least one configuration.`,
        };
    }
    const times = threshold === 1 ? 'once' : `${threshold} times`;
    const atLeast = threshold === 1 ? 'twice' : `${threshold + 1} times`;
    return {
        stable:
            `Passed every time it ran — or failed no more than ${times} ${window}, ` +
            'which the noise filter counts as passing — and was never skipped.',
        flaky: `Failed at least ${atLeast} ${window} — failures, timeouts and crashes all count.`,
        skipped:
            `Did not fail more than ${times} ${window}, but was skipped on at least ` +
            'one configuration.',
    };
}

/** Which shape the folder table takes. */
export type TableMode = 'tree' | 'list';

/** The table opens as a tree; the list is the burndown view. */
export const DEFAULT_TABLE_MODE: TableMode = 'tree';

/** The `test.html` link for one test path. */
export function testPageUrl(fullPath: string): string {
    return `test.html?test=${encodeURIComponent(fullPath)}`;
}

/** The headline numbers above the chart. */
export interface Headline {
    /** The most recent day with any tests, or `null` if the file is empty. */
    latest: FlakyDay | null;
    /** Its flaky percentage. */
    flakyPercent: number;
    /**
     * The tiles' own numbers: the mean of the last `AVERAGE_WINDOW` days.
     *
     * The tiles used to show the single most recent day, which put 923 flaky
     * (19%) above a table total of 3,867 (80%) with nothing saying the two
     * covered different windows. A one-day headline is also the noisiest
     * number on the page — this window's days range from 12% to 65%.
     *
     * So the tiles are the 7-day average, `days` says how many days actually
     * went into it, and the table keeps its own window and labels it. Counts
     * are rounded means of the daily counts, so the three still sum to
     * `total`.
     */
    average: FlakyCounts & { total: number; days: number } | null;
    /**
     * The change in the 7-day average between the first and last day that have
     * one, in percentage points. Positive means the tree got flakier.
     *
     * The *average* rather than the raw rate, because a single bad day at
     * either end would otherwise be reported as a trend — 2026-07-15's 65% is
     * exactly that day in the pinned window.
     */
    trend: number | null;
}

/** The summary shown above the chart. */
export function headline(days: readonly FlakyDay[]): Headline {
    const withTests = days.filter((day) => day.total > 0);
    const latest = withTests.at(-1) ?? null;
    const average = runningAverage(days, AVERAGE_WINDOW).filter(
        (value): value is number => value !== null
    );
    const first = average[0];
    const last = average.at(-1);

    // The tiles' window: the last `AVERAGE_WINDOW` days that have any tests.
    // Fewer, if the file is shorter — `days` reports how many were used, so the
    // heading can say "7-day average" or "3-day average" truthfully.
    const window = withTests.slice(-AVERAGE_WINDOW);
    let tileAverage: Headline['average'] = null;
    if (window.length > 0) {
        const mean = (pick: (day: FlakyDay) => number): number =>
            Math.round(window.reduce((sum, day) => sum + pick(day), 0) / window.length);
        const flaky = mean((day) => day.flaky);
        const stable = mean((day) => day.stable);
        const skipped = mean((day) => day.skipped);
        tileAverage = {
            flaky,
            stable,
            skipped,
            // Summed from the rounded parts rather than averaged separately, so
            // the three tiles' percentages add to 100 and cannot show a total
            // the parts contradict.
            total: flaky + stable + skipped,
            days: window.length,
        };
    }

    return {
        latest,
        flakyPercent: latest === null ? 0 : flakyPercentage(latest),
        average: tileAverage,
        trend:
            first === undefined || last === undefined || average.length < 2
                ? null
                : last - first,
    };
}

/** The `#`-hash state this page reads and writes. */
export interface UrlState {
    /** `21days`, or a `YYYY-MM-DD`. */
    date?: string | undefined;
    /** The search term. */
    q?: string | undefined;
    /** Open folders, comma-separated. */
    open?: string | undefined;
    /** The noise threshold, if it is not the default. */
    noise?: string | undefined;
    /** `list` when the table is the flat folder list. */
    view?: string | undefined;
}

/** The value `date` takes for the 21-day window, matching `issues.html`. */
export const HISTORICAL_DATE = '21days';

/** Whether a `date` hash value means the 21-day aggregate. */
export function isHistoricalDate(date: string | undefined): boolean {
    // An absent date is the aggregate: this page opens on the window, which is
    // the default `issues.html` was changed to on its migration.
    return date === undefined || date === '' || date === HISTORICAL_DATE;
}

/** Reads the hash into state. */
export function readUrlState(params: URLSearchParams): UrlState {
    const read = (key: string): string | undefined => {
        const value = params.get(key);
        return value === null || value === '' ? undefined : value;
    };
    return {
        date: read('date'),
        q: read('q'),
        open: read('open'),
        noise: read('noise'),
        view: read('view'),
    };
}

/** The table mode a hash value names, defaulting to the tree. */
export function parseTableMode(value: string | undefined): TableMode {
    return value === 'list' ? 'list' : DEFAULT_TABLE_MODE;
}

/** The open-folder set as it appears in the hash, and back. */
export function parseOpen(value: string | undefined): Set<string> {
    if (value === undefined || value === '') {
        return new Set();
    }
    return new Set(value.split(',').filter((path) => path !== ''));
}
