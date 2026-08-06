/**
 * The **grouped drill-down view model** shared by `crashes.html` and
 * `failures.html`.
 *
 * These two pages are near-twins: ~1,000 and ~1,150 lines, one `render*List`
 * each, both drilling *group key → directory path → test → occurrence*, both
 * ranking on occurrence count, both collapsing the path level when a path holds
 * exactly one test. Migrating them one at a time would have meant porting the
 * same three-level walk twice and then reconciling two copies of it, so they
 * were migrated as one job and the walk lives here, once.
 *
 * ## Where the seam is, and why it is `site/` and not `lib/`
 *
 * The rule the first three migrations settled:
 *
 * > **`lib/` holds data and derivations. The page directory holds the view
 * > model — including anything that names an element id, a CSS class or a
 * > glyph.**
 *
 * This module fails the `lib/` test on both halves of it. It names
 * `path-row`, `test-row`, `single-occurrence`, `direct-child`, `total-row` and
 * the `📊` of the totals row; and no non-page consumer wants it, because what
 * it computes is *how many rows the table has* — the path level disappears when
 * a path has one test (`old/crashes.html:700`, `old/failures.html:790`), and that is a
 * judgement about what a reader should see, not a fact about crashes.
 *
 * `fx-tests crashes` and `fx-tests failures` ask the same underlying question
 * and get `lib/query/crashes.ts` and `lib/query/failures.ts`, which return flat
 * ranked groups with a `testCount`. They have no path level at all. That is the
 * comparison `PARITY.md` §5 exists to make, and collapsing the two would delete
 * the thing being compared.
 *
 * ## What is parameterized, and what deliberately is not
 *
 * The brief for this migration was explicit that a "shared" helper needing
 * three booleans to serve both pages is really two functions. So the split is
 * by *kind of difference*, not by page:
 *
 * | difference | how it is handled |
 * | --- | --- |
 * | which runs count (`CRASH` vs `FAIL*`) | `GroupExtractor.keyOf` returns `null` to skip a run |
 * | the group key (signature vs message) | `keyOf`, and `nullKey` for the one page that has a rankable "no key" row |
 * | what an occurrence carries (minidump vs not) | `Occurrence.minidump`, optional |
 * | what a test row carries (component) | `TestNode.component`, optional |
 * | **the search** | *not* a parameter — two functions, `filterGroupsByMatch` and `rewriteGroupsBySearch`, because the two pages genuinely do different things (see below) |
 * | the row label (plain vs linkified) | not here at all; the renderer's job |
 *
 * The search is the case that justifies the rule. `old/crashes.html:508-526` keeps
 * or drops whole rows and leaves each surviving row's numbers alone;
 * `old/failures.html:560-592` *rewrites* the counts, so a row shows a smaller number
 * under a search than without one. Serving both from one function would have
 * taken a boolean that changes what every number on the page means. They are
 * two functions with two names, and each page's comment says which it uses.
 *
 * ## This file must stay DOM-free
 *
 * `tsconfig.site.json` gives `site/` the DOM lib, so that is a discipline rather
 * than something the compiler enforces here — but it *is* enforced indirectly:
 * `test/drilldown-view.test.ts` imports this module, the root project compiles
 * `test/**`, and the root project has no DOM. A `document` reach fails
 * `npm run typecheck` on the root project.
 */

import type { DecodedTimingFile, RunEntry } from '../lib/formats/decode.ts';
import { parseTaskId } from '../lib/formats/tables.ts';

// --- the tree ------------------------------------------------------------

/**
 * One occurrence: a single run of one test that produced the group's key.
 *
 * Field-for-field what the old pages push into `testData.crashes` /
 * `testData.failures` (`old/crashes.html:292`, `old/failures.html:280`), minus
 * `timestamp`. The old pages compute `timestamp` and then use it only to derive
 * `date` — `prepareRunsForDisplay` (`common-ui.js:489`) sorts on `date`, and
 * nothing else reads the number — so carrying it would be carrying a field with
 * no consumer.
 */
export interface Occurrence {
    /** The configuration that ran it, e.g. `test-linux1804-64/opt-xpcshell`. */
    jobName: string;
    /** `YYYY-MM-DD`, in UTC. The only time granularity either page displays. */
    date: string;
    /** The bare task ID, without the `.<retryId>` suffix. */
    taskId: string;
    /**
     * The job-level retry, as a string — that is how the link builders want it.
     *
     * The pages split on `.` and take the second half, so a task ID with no
     * suffix gives them `undefined`; `parseTaskId` gives `0` instead. The two
     * disagree only on a malformed ID, and there are none: measured across the
     * pinned snapshot, 0 of 20,656 aggregate task IDs and 0 of 1,293 daily ones
     * lack a `.N` suffix.
     */
    retryId: string;
    /** The dump ID, when the run produced one. Crashes only. */
    minidump?: string | null | undefined;
}

/** One test under one directory path, with its occurrences. */
export interface TestNode {
    /** The bare test file name, without its directory. */
    testName: string;
    /** Every occurrence, in the order the walk found them. */
    occurrences: Occurrence[];
    /**
     * Occurrences of this key in this test.
     *
     * Kept alongside `occurrences` rather than derived from it because the two
     * can legitimately differ: a file with no task attribution yields a count
     * with no occurrence rows behind it, which is the `else` branch at
     * `old/crashes.html:364` / `old/failures.html:350`. Both pages test
     * `totalCount === 1 && occurrences.length > 0` before rendering an
     * occurrence inline, and that guard only means something if the two are
     * tracked separately.
     */
    totalCount: number;
    /** `Product :: Component`, when the file records one. Failures only. */
    component?: string | null | undefined;
}

/** One directory path under one group key. */
export interface PathNode {
    dirPath: string;
    /** Keyed by test name, in walk order. */
    tests: Map<string, TestNode>;
    totalCount: number;
}

/** One group — a crash signature, or a failure message. */
export interface GroupNode {
    key: string;
    /** Keyed by directory path, in walk order. */
    paths: Map<string, PathNode>;
    totalCount: number;
}

/**
 * How a page turns a run into a group key.
 *
 * One function rather than a set of flags, because the two pages differ in
 * three ways at once and they are not independent: crashes take only the
 * `CRASH` status and drop unsymbolized signatures, failures take every status
 * starting `FAIL` and give a missing message a real, rankable name.
 */
export interface GroupExtractor {
    /**
     * The key this run contributes to, or `null` to skip the run entirely.
     *
     * Called for **every** run of every test, so it is also the status filter.
     */
    keyOf(entry: RunEntry): string | null;
}

/**
 * `crashes.html`'s extractor: `CRASH` runs with a symbolized signature.
 *
 * Two exclusions, both deliberate and both matching `old/crashes.html:230-242`:
 *
 * - **`status === 'CRASH'` exactly**, by table lookup, not a prefix test. The
 *   page does `statuses.indexOf('CRASH')`, and the xpcshell file's statuses are
 *   `PASS-PARALLEL, SKIP, PASS-SEQUENTIAL, PASS, TIMEOUT-PARALLEL, FAIL-PARALLEL,
 *   EXPECTED-FAIL, CRASH, TIMEOUT, FAIL-SEQUENTIAL, FAIL, TIMEOUT-SEQUENTIAL`.
 *
 *   Exact and prefix therefore agree on today's data, and that is measured, not
 *   assumed: **no `CRASH`-prefixed status other than `CRASH` itself exists** in
 *   the xpcshell aggregate, the mochitest aggregate, the xpcshell daily file or
 *   the test fixture. A mutation switching this to `startsWith('CRASH')`
 *   survives the suite for that reason. Exact is kept because it is what the
 *   page does — `indexOf` on the table — and because `FAIL` shows the naming
 *   scheme really does grow suffixed variants, so a future `CRASH-PARALLEL`
 *   should be a deliberate decision rather than something a prefix test silently
 *   absorbs.
 * - **A null signature is dropped** (`old/crashes.html:270`: `if (sigId === null)
 *   return;`). This diverges from `lib/query/crashes.ts`, which keeps null as a
 *   group because "a crash that could not be symbolized is still a crash". The
 *   page's choice is reproduced here and the difference is a declared
 *   divergence between the page and the CLI, not between the old and new page.
 *   Measured on the pinned 21-day xpcshell snapshot: 0 of 21,252 crash
 *   occurrences have a null signature, so the two rules select the same runs on
 *   this data and the divergence is latent.
 */
export const crashExtractor: GroupExtractor = {
    keyOf(entry: RunEntry): string | null {
        if (entry.status !== 'CRASH') {
            return null;
        }
        // `undefined` means the group carried no `crashSignatureIds` array at
        // all, `null` means it did and this entry's was null. The page cannot
        // tell those apart — it guards on the array's presence and then on the
        // element — and treats both as "no row", so both return null here.
        return entry.crashSignature ?? null;
    },
};

/** What `failures.html` calls a failure that recorded no message. */
export const NO_FAILURE_MESSAGE = '(no failure message)';

/**
 * `failures.html`'s extractor: every status starting `FAIL`, message or not.
 *
 * Both halves matter and both are `old/failures.html:213-218` and `:263`:
 *
 * - **A prefix test, not an exact one.** `FAIL`, `FAIL-PARALLEL` and
 *   `FAIL-SEQUENTIAL` are all present in the pinned file and all three are
 *   counted. Note what this excludes: `EXPECTED-FAIL` does not start with
 *   `FAIL`, and `TIMEOUT*` and `CRASH` are absent from this page entirely.
 * - **A missing message becomes a real row.** `'(no failure message)'` is
 *   rankable and ranks *first* on the pinned snapshot: 8,461 occurrences across
 *   1,990 tests, ahead of the next message's 5,326. Mapping it to a key rather
 *   than dropping it is the whole reason this page's top row exists.
 *
 * The `messageIds`-presence guard (`old/failures.html:234`) needs no counterpart:
 * `FORMATS.md` records that `FAIL*` groups always carry `messageIds`, so the
 * guard never fires for a status this extractor accepts — and where it would,
 * `entry.message` is `undefined` and maps to the same `'(no failure message)'`
 * the page's `msgId === undefined` branch produces.
 */
export const failureExtractor: GroupExtractor = {
    keyOf(entry: RunEntry): string | null {
        if (!entry.status.startsWith('FAIL')) {
            return null;
        }
        return entry.message ?? NO_FAILURE_MESSAGE;
    },
};

/** What `buildGroups` needs beyond the file itself. */
export interface BuildOptions {
    /**
     * Whether to read `component` onto each test node. Failures only — the
     * crashes page never reads one, and resolving it costs a table lookup per
     * test.
     */
    withComponent?: boolean | undefined;
}

/**
 * Walks the file once and builds the *key → path → test → occurrence* tree.
 *
 * This is `processCrashData` (`old/crashes.html:225`) and `processFailureData`
 * (`old/failures.html:207`) unified. What the unification buys, beyond one copy
 * instead of two, is that the **five status-group shapes** are now
 * `lib/formats/status-entries.ts`'s problem rather than each page's: both pages
 * open-code a two-branch `isBucketedFormat` test and decode `days` or
 * `timestamps` by hand, and both branches are wrong for the three shapes they
 * do not name. `iterateStatusGroup` resolves all five and throws on a sixth.
 *
 * ## The date, which is the one thing the shapes disagree about
 *
 * Both pages derive a `YYYY-MM-DD` from a timestamp, and they get that
 * timestamp two different ways:
 *
 * - **Bucketed** (`{harness}-issues-with-taskids.json`, the 21-day default):
 *   `(metadata.startTime + cumulativeDays * 86400) * 1000`. `startTime` is the
 *   *first* day of the window, and `entry.day` is the same cumulative sum the
 *   page computes by hand, so the arithmetic is reproduced exactly — see
 *   `dateOfEntry`.
 * - **Flat** (`{harness}-{date}.json`, one day): the entry's own delta-decoded
 *   timestamp, which `lib/formats/daily.ts` already returns as absolute Unix
 *   seconds because it passes `metadata.startTime` into the iterator.
 *
 * So the caller supplies `startTime` for the bucketed case and the entry
 * supplies it for the flat case, and `dateOfEntry` prefers the entry's.
 */
export function buildGroups(
    file: DecodedTimingFile,
    startTime: number,
    extractor: GroupExtractor,
    options: BuildOptions = {}
): Map<string, GroupNode> {
    const groups = new Map<string, GroupNode>();

    for (let testId = 0; testId < file.testCount; testId++) {
        const identity = file.testAt(testId);
        const dirPath = identity.directory;
        const testName = identity.name;

        // Per-test rather than per-run, matching the pages: they group a test's
        // runs by key first and only then merge into the global tree. The
        // difference is observable in `occurrences` order — a test's runs stay
        // contiguous — and `prepareRunsForDisplay` sorts by date afterwards, so
        // it only decides ties within a date.
        const perKey = new Map<string, Occurrence[]>();
        const countPerKey = new Map<string, number>();

        for (const entry of file.runsOfTest(testId)) {
            const key = extractor.keyOf(entry);
            if (key === null) {
                continue;
            }
            countPerKey.set(key, (countPerKey.get(key) ?? 0) + entry.count);
            let list = perKey.get(key);
            if (list === undefined) {
                list = [];
                perKey.set(key, list);
            }
            appendOccurrences(list, file, entry, startTime);
        }

        if (perKey.size === 0) {
            continue;
        }

        const component = options.withComponent === true ? identity.component : undefined;

        for (const [key, occurrences] of perKey) {
            const count = countPerKey.get(key) ?? 0;

            let group = groups.get(key);
            if (group === undefined) {
                group = { key, paths: new Map(), totalCount: 0 };
                groups.set(key, group);
            }

            let path = group.paths.get(dirPath);
            if (path === undefined) {
                path = { dirPath, tests: new Map(), totalCount: 0 };
                group.paths.set(dirPath, path);
            }

            let test = path.tests.get(testName);
            if (test === undefined) {
                test = { testName, occurrences: [], totalCount: 0 };
                if (component !== undefined) {
                    test.component = component;
                }
                path.tests.set(testName, test);
            }

            test.occurrences.push(...occurrences);
            test.totalCount += count;
            path.totalCount += count;
            group.totalCount += count;
        }
    }

    return groups;
}

/**
 * Turns one decoded entry into its per-run occurrence rows.
 *
 * An entry is a *bucket*, not a run: the `task-ids` shape holds one entry per
 * (day, message, signature) with `count` task IDs inside it, and both pages
 * expand that bucket into one displayed row per task ID (`old/crashes.html:284`,
 * `old/failures.html:273`). An entry with no task attribution — the `counts` shape,
 * which is what `{harness}-issues.json` uses throughout — yields no rows at
 * all, and its `count` is carried by `totalCount` instead. That is the
 * `Array.isArray(crashes)` false branch the old pages have and, on the files
 * these pages actually load, never take.
 */
function appendOccurrences(
    into: Occurrence[],
    file: DecodedTimingFile,
    entry: RunEntry,
    startTime: number
): void {
    const taskIds = entry.taskIds;
    if (taskIds === undefined) {
        return;
    }
    const date = dateOfEntry(entry, startTime);
    for (let i = 0; i < taskIds.length; i++) {
        const raw = taskIds[i];
        if (raw === undefined) {
            continue;
        }
        const { taskId, retryId } = parseTaskId(raw);
        const taskIdIndex = entry.taskIdIndexes?.[i];
        const occurrence: Occurrence = {
            // A file with no `taskInfo` cannot name the job. The old pages read
            // `tables.jobNames[undefined]` and render the string "undefined";
            // an empty string is what an absent name should look like, and the
            // renderer shows nothing rather than a word.
            jobName:
                taskIdIndex === undefined ? '' : (file.jobNameOfTaskIndex(taskIdIndex) ?? ''),
            date,
            taskId,
            retryId: String(retryId),
        };
        if (entry.minidumps !== undefined) {
            occurrence.minidump = entry.minidumps[i] ?? null;
        }
        into.push(occurrence);
    }
}

/**
 * The `YYYY-MM-DD` an entry happened on, in UTC.
 *
 * `entry.timestamps` is the daily files' per-run absolute time and is preferred
 * where it exists. Otherwise the entry carries a day index into the 21-day
 * window and the date is `startTime + day * 86400`, which is exactly the
 * arithmetic at `old/crashes.html:266` and `old/failures.html:259`.
 *
 * `toISOString().split('T')[0]` is kept rather than replaced with a formatter:
 * it is what both pages do, it is UTC, and a local-time formatter would shift
 * the date by one for anyone west of Greenwich.
 *
 * **The `entry.timestamps` branch is unfalsifiable on today's data, and that is
 * measured rather than assumed.** A mutation deleting it — always using
 * `startTime` — survives the whole test suite, because a daily file's
 * `startTime` is midnight UTC of the one day it covers and every run in it falls
 * inside that day: **0 of 2,463,557 runs across the two daily files (7,558 in
 * the fixture, 2,455,999 in the full 2026-08-04 file) has a different UTC date
 * from `startTime`**, spanning 00:05 to 22:30. So for the *date*, the two are
 * interchangeable. The branch stays because it is the correct expression of the
 * intent — the entry knows when it happened — and because a file whose runs
 * crossed midnight would silently take every date from the wrong end without it.
 */
function dateOfEntry(entry: RunEntry, startTime: number): string {
    const seconds = entry.timestamps?.[0] ?? (entry.day === null ? startTime : startTime + entry.day * 86400);
    return new Date(seconds * 1000).toISOString().split('T')[0]!;
}

// --- the ranked list -----------------------------------------------------

/** Which column the list is ranked on. */
export type SortColumn = 'count' | 'tests';

/** A column and a direction. */
export interface SortState {
    column: SortColumn;
    ascending: boolean;
}

/**
 * The sort both pages start on: most occurrences first.
 *
 * `old/crashes.html:120` and `old/failures.html:102`, identical.
 *
 * Both pages' comparators have a third branch — `'signature'` on crashes,
 * `'message'` on failures — that sorts the key with `localeCompare`. **Both are
 * dead**, and this is a measurement rather than a reading: the only writers of
 * `currentSort.column` are the two `sortBy(…)` calls in each page's header
 * markup (`old/crashes.html:558`/`:564`, `old/failures.html:631`/`:637`), which pass
 * `'tests'` and `'count'`. `grep -o "sortBy('[a-z]*')"` over both files returns
 * exactly those four call sites and no fifth. There is no control that can
 * produce the branch, no URL parameter that sets it, and `SortColumn` therefore
 * does not have the value — which is what makes the omission checkable by the
 * compiler rather than by a comment.
 */
export const INITIAL_SORT: SortState = { column: 'count', ascending: false };

/**
 * The next sort state after clicking a column header.
 *
 * `old/crashes.html:963` and `old/failures.html:1074`, identical: same column flips the
 * direction, a new column starts descending.
 */
export function nextSort(current: SortState, column: SortColumn): SortState {
    if (current.column === column) {
        return { column, ascending: !current.ascending };
    }
    return { column, ascending: false };
}

/** One row of the ranked list. */
export interface GroupRow {
    key: string;
    /**
     * How many tests this key was seen in.
     *
     * ## This is a distinct count, and that took measuring
     *
     * Both pages compute it by summing `pathData.tests.size` across paths
     * (`old/crashes.html:496`, `old/failures.html:538`) under a comment saying "unique
     * tests", and a sum-of-sizes is the shape of a double-count. It is not one
     * here, and the reason is a property of the data rather than of the loop:
     * a test node is keyed `(dirPath, testName)`, and **every `(testPath,
     * testName)` pair in the file belongs to exactly one test ID** — measured on
     * the pinned snapshot, 4,838 test IDs and 4,838 distinct pairs, zero
     * duplicates. So the per-path `tests` maps of one group are disjoint and
     * their sizes add up to the distinct count.
     *
     * Verified end to end rather than argued: on the 21-day xpcshell snapshot,
     * all 90 crash-signature rows have `sum(tests.size)` equal to the size of
     * the set of distinct `dirPath + '/' + testName` strings. So this agrees
     * with `lib/query/crashes.ts`'s `testCount`, which counts distinct test IDs.
     *
     * The **total row** is a different matter and is genuinely an overcount —
     * see `totalsOf`.
     */
    testCount: number;
    /** Occurrences of this key. */
    count: number;
    /** The tree under this row, possibly rewritten by a search. */
    paths: Map<string, PathNode>;
}

/** Flattens the tree into unsorted, unfiltered rows. */
export function rowsOf(groups: Map<string, GroupNode>): GroupRow[] {
    return [...groups.values()].map((group) => ({
        key: group.key,
        testCount: countTests(group.paths),
        count: group.totalCount,
        paths: group.paths,
    }));
}

/** Sums `tests.size` over the paths. See `GroupRow.testCount`. */
function countTests(paths: Map<string, PathNode>): number {
    let total = 0;
    for (const path of paths.values()) {
        total += path.tests.size;
    }
    return total;
}

/**
 * `crashes.html`'s search: **keep or drop whole rows, never change a number.**
 *
 * `old/crashes.html:508-526`. A row survives if the signature, any of its directory
 * paths, or any of its test names contains the term; a surviving row keeps the
 * counts it had with no search at all, including the tests and occurrences that
 * did not match. Expanding it shows everything.
 *
 * The visible consequence, which is reproduced rather than fixed: the **Total
 * row does change**, because it is summed over the surviving rows
 * (`old/crashes.html:545-548`, after the filter). So searching narrows the total
 * while every row above it keeps its full number, and the total is no longer
 * the sum of what a reader can see expanded — it is the sum of the *whole* of
 * each matching row.
 */
export function filterGroupsByMatch(rows: GroupRow[], searchTerm: string): GroupRow[] {
    if (searchTerm === '') {
        return rows;
    }
    const needle = searchTerm.toLowerCase();
    return rows.filter((row) => {
        if (row.key.toLowerCase().includes(needle)) {
            return true;
        }
        for (const [dirPath, path] of row.paths) {
            if (dirPath.toLowerCase().includes(needle)) {
                return true;
            }
            for (const testName of path.tests.keys()) {
                if (testName.toLowerCase().includes(needle)) {
                    return true;
                }
            }
        }
        return false;
    });
}

/**
 * `failures.html`'s search: **rewrite each row to only what matched.**
 *
 * `old/failures.html:550-596`, and a genuinely different operation from
 * `filterGroupsByMatch` — which is why it is a second function rather than a
 * flag on the first.
 *
 * The rule has two levels:
 *
 * - If the **message** matches, the row passes through untouched, whole subtree
 *   and original counts.
 * - Otherwise the row is rebuilt from the tests whose path or name matched, and
 *   its `count` and `testCount` are recomputed from just those. A row that
 *   keeps nothing is dropped.
 *
 * So the same row shows a **smaller number under a search than without one**,
 * and the number it shows is the number of occurrences a reader can actually
 * find by expanding it. That is a defensible design and the opposite of the
 * crashes page's; both are reproduced as they are.
 *
 * Note the asymmetry inside the second branch, which is upstream's and is kept:
 * when a *path* matches, every test under it is kept and counted, including
 * tests whose own names match nothing.
 */
export function rewriteGroupsBySearch(rows: GroupRow[], searchTerm: string): GroupRow[] {
    if (searchTerm === '') {
        return rows;
    }
    const needle = searchTerm.toLowerCase();
    const out: GroupRow[] = [];

    for (const row of rows) {
        if (row.key.toLowerCase().includes(needle)) {
            out.push(row);
            continue;
        }

        const paths = new Map<string, PathNode>();
        let count = 0;
        let testCount = 0;

        for (const [dirPath, path] of row.paths) {
            const pathMatches = dirPath.toLowerCase().includes(needle);
            const tests = new Map<string, TestNode>();
            let pathCount = 0;

            for (const [testName, test] of path.tests) {
                if (pathMatches || testName.toLowerCase().includes(needle)) {
                    tests.set(testName, test);
                    pathCount += test.totalCount;
                    testCount++;
                }
            }

            if (tests.size > 0) {
                paths.set(dirPath, { dirPath, tests, totalCount: pathCount });
                count += pathCount;
            }
        }

        if (paths.size > 0) {
            out.push({ key: row.key, testCount, count, paths });
        }
    }

    return out;
}

/**
 * Ranks the rows.
 *
 * `old/crashes.html:529-539` and `old/failures.html:602-612`, identical once the dead
 * key-name branch is dropped (see `INITIAL_SORT`). `Array.prototype.sort` is
 * stable, so ties keep the walk order — which for these pages is the order
 * `testRuns` first produced each key.
 */
export function sortRows(rows: GroupRow[], sort: SortState): GroupRow[] {
    const sorted = [...rows];
    sorted.sort((a, b) => {
        const compare = sort.column === 'tests' ? a.testCount - b.testCount : a.count - b.count;
        return sort.ascending ? compare : -compare;
    });
    return sorted;
}

/** The two numbers in the `📊 Total` row. */
export interface Totals {
    /** Sum of the rows' `testCount`. Overcounts; see `totalsOf`. */
    tests: number;
    /** Sum of the rows' `count`. Exact. */
    count: number;
}

/**
 * Totals the visible rows.
 *
 * `old/crashes.html:545-548` and `old/failures.html:618-621`, identical.
 *
 * ## `tests` counts a test once per group it appears in
 *
 * Unlike the per-row `testCount`, this one really does overcount, and by a lot.
 * A test that crashes with three different signatures is one test in each of
 * three rows and three tests in this sum. Measured on the pinned 21-day
 * xpcshell snapshot:
 *
 * | page | total row shows | distinct tests | ratio |
 * | --- | --- | --- | --- |
 * | crashes | 1,098 | 676 | 1.62× |
 * | failures | 7,976 | 3,793 | 2.10× |
 *
 * 266 of the 676 crashing tests have more than one signature.
 *
 * **It is reproduced, not fixed**, and the reason is that fixing it silently
 * would be worse than either leaving it or removing it. The number is a sum of
 * the column above it — a reader can verify it by adding the rows up, and on a
 * searched crashes list it is the *only* number that responds to the search. A
 * distinct count would stop matching the column and start disagreeing with a
 * reader's arithmetic, with nothing on the page to explain why. Changing what
 * the row means is a product decision about a number a human reads, not a
 * migration's to make; this migration's job is to make it true that the old and
 * new pages agree. It is on both pages' declared-divergence lists as a known,
 * unchanged defect.
 */
export function totalsOf(rows: readonly GroupRow[]): Totals {
    let tests = 0;
    let count = 0;
    for (const row of rows) {
        count += row.count;
        tests += row.testCount;
    }
    return { tests, count };
}

// --- the expanded subtree ------------------------------------------------

/**
 * What one row of the expanded subtree is.
 *
 * `path` and `test` are the two the old pages emit as `path-row` and
 * `test-row`; `single` is a `test-row` that also carries the one occurrence
 * inline rather than expanding to it.
 */
export type SubRow =
    | { kind: 'path'; dirPath: string; testCount: number; count: number }
    | {
          kind: 'test';
          dirPath: string;
          test: TestNode;
          /** Whether the path level above it was collapsed away. */
          direct: boolean;
      }
    | {
          kind: 'single';
          dirPath: string;
          test: TestNode;
          occurrence: Occurrence;
          direct: boolean;
      };

/**
 * The rows under an expanded group, in display order.
 *
 * `generateCrashExpandedContent` (`old/crashes.html:681`) and
 * `generateFailureExpandedContent` (`old/failures.html:771`) unified. Three
 * decisions, all shared:
 *
 * 1. **Paths rank by occurrence count, descending** (`old/crashes.html:696`).
 * 2. **A path holding exactly one test disappears** — the test is emitted
 *    directly, with the `direct-child` class and its *full* path in the label
 *    (`old/crashes.html:700`, `old/failures.html:790`). This is the rule that makes
 *    `dirPath` part of every `SubRow`: a direct child shows `dir/name` and a
 *    child under a path row shows only `name`.
 * 3. **A test with exactly one occurrence, and that occurrence in hand, is
 *    rendered inline** rather than being expandable (`old/crashes.html:704`,
 *    `old/failures.html:794`). The second half of the condition is load-bearing on a
 *    file with no task attribution, where `totalCount` is 1 and there is no
 *    occurrence to show.
 */
export function expandGroup(paths: Map<string, PathNode>): SubRow[] {
    const ordered = [...paths.values()].sort((a, b) => b.totalCount - a.totalCount);
    const rows: SubRow[] = [];

    for (const path of ordered) {
        if (path.tests.size === 1) {
            const test = [...path.tests.values()][0]!;
            rows.push(testRow(path.dirPath, test, true));
        } else {
            rows.push({
                kind: 'path',
                dirPath: path.dirPath,
                testCount: path.tests.size,
                count: path.totalCount,
            });
        }
    }

    return rows;
}

/**
 * The rows under an expanded path.
 *
 * `generatePathExpandedContent` (`old/crashes.html:742`, `old/failures.html:839`).
 * Tests rank by occurrence count, descending, and none of them is a
 * `direct-child` — the path row is above them.
 */
export function expandPath(path: PathNode): SubRow[] {
    return [...path.tests.values()]
        .sort((a, b) => b.totalCount - a.totalCount)
        .map((test) => testRow(path.dirPath, test, false));
}

/** One test row, inline if it has exactly one occurrence to show. */
function testRow(dirPath: string, test: TestNode, direct: boolean): SubRow {
    if (test.totalCount === 1 && test.occurrences.length > 0) {
        return { kind: 'single', dirPath, test, occurrence: test.occurrences[0]!, direct };
    }
    return { kind: 'test', dirPath, test, direct };
}

/**
 * The occurrences of an expanded test, newest first, with the date shown once
 * per day.
 *
 * `prepareRunsForDisplay` (`common-ui.js:488`) reimplemented rather than called,
 * for one reason: the shared version *mutates* its input, stamping a `dateHtml`
 * string of markup onto every occurrence. That is fine for a page that
 * concatenates HTML and wrong for one that builds elements — and it would mean
 * the view model handing the renderer a string containing `<td>`.
 *
 * The sort is upstream's, including its tie behaviour: `localeCompare` on the
 * `YYYY-MM-DD` strings, descending, and `Array.prototype.sort` is stable so
 * same-day occurrences keep walk order.
 */
export function occurrenceRows(test: TestNode): { occurrence: Occurrence; showDate: boolean }[] {
    const sorted = [...test.occurrences].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    let lastDate: string | null = null;
    return sorted.map((occurrence) => {
        if (!occurrence.date) {
            return { occurrence, showDate: false };
        }
        const showDate = occurrence.date !== lastDate;
        lastDate = occurrence.date;
        return { occurrence, showDate };
    });
}

// --- the per-test tooltip ------------------------------------------------

/**
 * The `title` on a test row's count cell, or `''` when the run total is unknown.
 *
 * `old/crashes.html:719-721` and `old/failures.html:816-818`, which differ in exactly
 * one word — "of this signature" against "of this message" — hence `noun`.
 *
 * Two details are upstream's and are kept because a reader compares this
 * against the row:
 *
 * - **The percentage rounds once**, from the raw ratio, with `toFixed(2)`. Not
 *   from an already-rounded intermediate.
 * - **`totalRuns` is 0 unless the 21-day file is loaded.** `getTestTotalRuns`
 *   is called with `historicalData`, which is `null` in single-day mode
 *   (`old/crashes.html:718`), so every tooltip on a single-day view is empty. That
 *   is upstream's behaviour and is reproduced by the caller passing 0.
 */
export function occurrenceTooltip(count: number, totalRuns: number, noun: string): string {
    if (totalRuns <= 0) {
        return '';
    }
    const percentage = ((count / totalRuns) * 100).toFixed(2);
    const occurrenceText = count === 1 ? 'occurrence' : 'occurrences';
    return `${count} ${occurrenceText} of this ${noun} out of ${totalRuns.toLocaleString()} runs (${percentage}%)`;
}

// --- URL state -----------------------------------------------------------

/** The hash state both pages carry: a date (or `21days`) and a search term. */
export interface UrlState {
    date: string;
    q: string;
}

/** The window `old/crashes.html:994` / `old/failures.html:1105` default to. */
export const HISTORICAL_DATE = '21days';

/**
 * Whether a hash's `date` means the 21-day view.
 *
 * Absent and `21days` both do, which is what makes historical the **default**
 * despite `isHistoricalMode = false` at `old/crashes.html:121` and
 * `old/failures.html:103`. Those initializers describe the state before the first
 * load, not the view a reader gets: `loadFromUrlHash` runs before any render and
 * toggles into historical mode when the hash says nothing.
 */
export function isHistoricalDate(date: string | undefined): boolean {
    return date === undefined || date === '' || date === HISTORICAL_DATE;
}

/** Reads the two keys these pages use out of a parsed hash. */
export function readUrlState(params: URLSearchParams): Partial<UrlState> {
    const state: Partial<UrlState> = {};
    const date = params.get('date');
    if (date !== null) {
        state.date = date;
    }
    const q = params.get('q');
    if (q !== null) {
        state.q = q;
    }
    return state;
}
