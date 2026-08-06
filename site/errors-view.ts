/**
 * `errors.html`'s **view model**: every decision the page makes, as plain
 * values, with no DOM.
 *
 * ## Why this page does not use `site/drilldown-view.ts`
 *
 * The brief asked this to be judged honestly rather than assumed either way, so
 * the judgement is written out. The two are **not** the same shape, and the
 * differences are not the kind a parameter absorbs:
 *
 * | | crashes / failures | errors |
 * | --- | --- | --- |
 * | levels | key → dirPath → test → occurrence, **4** | group → sub → task, **3** |
 * | the middle level | a directory, with a **collapse rule** when it holds one test | none — there is no directory level at all |
 * | what a row *is* | fixed: a signature / a message | **chosen by a control**: a message, a test, or a component |
 * | what a sub-row is | fixed: a directory | **the complement of the top level** — a test under a message row, a message under a test row |
 * | columns | fixed: Tests, Occurrences | **1, 2 or 3, decided by the same control** |
 * | the leaf | one run, one row | one *task*, with an **`×N` count** — an errors leaf is `(task, N occurrences)`, not one occurrence |
 * | ranking | `count` or `tests` | `count`, `tests`, `messages` **or `name`**, and `name` starts *ascending* |
 * | the search | drops rows, or rewrites them | drops rows **and never rewrites a count**, but *does* re-filter the subtree when a row is expanded |
 * | the filters | none | **seven kind checkboxes whose meaning depends on the view** |
 *
 * Reusing `buildGroups`/`expandGroup` would have meant a `PathNode` level that
 * is always exactly one synthetic path, a `GroupExtractor` that cannot express
 * "group by test" because it returns a key per *run* and this page groups by
 * *test identity*, a `SubRow` union with two new members, and — the decisive one
 * — `GroupRow` gaining `msgCount`, `kindMask` and a nullable `key`, all of which
 * are meaningless on the other two pages. That is the "three new booleans"
 * signal the brief named, three times over. The previous migration kept
 * `filterGroupsByMatch` and `rewriteGroupsBySearch` as two functions for a
 * smaller difference than any single row of that table.
 *
 * What *is* reused: `site/drilldown-render.ts`'s DOM primitives (`el`,
 * `externalLink`, `insertAfter`, `removeFollowing`, `noData`, `searchBox`) and
 * its `declare global` block for the shared scripts. Those are genuinely
 * page-independent — see `site/errors.ts`.
 *
 * ## Why the page's own data structures are kept, rather than `lib/`'s
 *
 * `lib/query/error-ranking.ts` answers the same question for the CLI and is
 * used by `test/errors-parity.test.ts` as the comparison target. It is **not**
 * called by the page, and that is deliberate rather than an oversight:
 *
 * - It materializes a `Map<string, Accumulator>` keyed by a **string** built by
 *   concatenating four fields per group. The pinned mochitest 2026-08-03 file
 *   holds **210,331 (test, message) groups over 67,840,668 occurrences**, and
 *   the old page's comment at `:310` is explicit that keying the hot loop on an
 *   integer rather than hashing a component or a test path is what makes it
 *   viable.
 * - It caps `tests` at 20 per group and `groupIds` at 50. The page's sub-row
 *   list is uncapped: the widest message-view row on that file expands to
 *   **11,943** tests, and the widest test-view row to **16,849** messages.
 * - It has no notion of the kind checkboxes, of the `name` sort, or of the
 *   `Messages` column.
 *
 * So the seam is the one `PARITY.md` §5 wants: two implementations of the same
 * question, compared against each other, rather than one wrapping the other and
 * making the comparison vacuous.
 *
 * ## The row unit is one source location, and the component is not part of it
 *
 * The single most important framing fact. A row in the message view is one
 * **(kind, text, file, line)** tuple, so the same text emitted from two places
 * is two rows with two counts. `groupName()` (`old/errors.html:489`) spells the
 * display out: the text plus `" file:line"`.
 *
 * **The component is deliberately not in the key**, and that is a change from
 * `errors.html`, whose row unit was the generator's `messageId` — a distinct
 * (kind, text, file, line, **component**) tuple. The component is not a
 * property of the message. The message is emitted at a `file:line`; the
 * component is whichever test happened to be running when it printed. Keying on
 * it splits one message into several rows for a reason that says nothing about
 * the message, and the page already has a whole separate view for the component
 * question.
 *
 * Measured on the pinned `xpcshell-2026-08-04-errors.json`:
 *
 * | | |
 * | --- | --- |
 * | messageIds the generator interned | **1,078** |
 * | distinct (kind, text, file, line) keys, i.e. rows here | **870** |
 * | keys holding more than one messageId | **36** |
 * | of those, keys differing by anything other than the component | **0** |
 * | widest spread | one message over **61** components |
 *
 * `NS_ENSURE_TRUE(inst) failed` occupies 69 messageIds and **5** rows here, and
 * grouping by text alone would collapse those 5 into 1 — which is why the file
 * and the line stay in the key even though the component leaves it. 772 texts
 * over 870 keys; 36 texts occur at more than one location.
 *
 * What the merge must not do is throw the component away, because it is real
 * information: `componentSummary` puts it back on the row, and
 * `componentBreakdown` carries the full list into the tooltip.
 *
 * ## This file must stay DOM-free
 *
 * Enforced the same way as `site/drilldown-view.ts`: `test/errors-view.test.ts`
 * imports it, the root `tsconfig.json` compiles `test/**`, and the root project
 * has no DOM lib. A `document` reach fails `npm run typecheck`.
 */

import type { ErrorsFile } from '../lib/formats/errors.ts';
import { joinTestPath, parseTaskId } from '../lib/formats/tables.ts';
// The component-summary *rule*, shared with `fx-tests errors` so the two sides
// cannot word the same row differently. Only the decision is shared; each side
// aggregates its own way — see `componentBreakdown`.
import {
    type ComponentShare,
    UNKNOWN_COMPONENT as SHARED_UNKNOWN_COMPONENT,
    componentBreakdownLines,
    sortComponents,
} from '../lib/query/error-ranking.ts';

// Re-exported so a caller of this view model — the renderer, and the tests —
// reaches the rule through the module it is already importing, rather than
// having to know it lives in `lib/`.
export {
    type ComponentShare,
    MAX_BREAKDOWN_ROWS,
    componentSummary,
    dominates,
} from '../lib/query/error-ranking.ts';

// --- the controls ---------------------------------------------------------

/** What a row is. `errors.html`'s `#viewSelect`, `:194-198`. */
export type ErrorView = 'message' | 'test' | 'component';

/**
 * The default view.
 *
 * `message`, because it is the **first `<option>` and none carries `selected`**
 * (`old/errors.html:194-198`), so that is what `getView()` (`:599`) reads before
 * anything else runs. The hash can override it (`:1128-1130`) and nothing else
 * can.
 */
export const DEFAULT_VIEW: ErrorView = 'message';

/** Whether a string names a view, for validating the hash. `:1128`. */
export function isErrorView(value: string | undefined): value is ErrorView {
    return value === 'message' || value === 'test' || value === 'component';
}

/**
 * The marker kinds and their checkbox/CSS slugs.
 *
 * **Seven, not six.** `old/errors.html:211`'s comment says "The six fixed marker
 * kinds" directly above a table of seven — a comment its own code contradicts,
 * which is one of the traps this project has been bitten by. The count is
 * stated here as a number that a test asserts (`test/errors-view.test.ts`), so
 * it cannot drift again silently.
 *
 * The order is the markup's (`old/errors.html:184-190`), which is the order the
 * checkboxes appear in and the order `getDisabledKindSlugs` (`:1113`) writes
 * them to the URL in. `Object.values` on an object literal preserves insertion
 * order for string keys, so upstream depends on this ordering too.
 *
 * ## These names are a fixed table, and the data's are not
 *
 * `tables.markerNames` is **data**, and it differs by file: the pinned
 * xpcshell 2026-08-04 file carries six kinds in the order
 * `C++ warning, JavaScript error, console.error, console.warn,
 * JavaScript warning, C++ assertion`, the 2026-08-03 file carries the same six
 * in a *different* order, and the pinned mochitest file carries seven including
 * `TSan Error`. So the kind → slug direction has to be a lookup by name, never
 * by index — which is what `computeKindOn` (`:389`) does and what `kindStates`
 * below reproduces.
 *
 * A kind in the file that is **not** in this table gets no checkbox and
 * defaults to on (`:394`: `on[i] = cb ? cb.checked : true`), so a new kind
 * appears in the data and cannot be filtered out until the markup grows a box.
 * Reproduced; see divergence list in `site/errors.ts`.
 */
export const KIND_SLUG: Readonly<Record<string, string>> = {
    'C++ warning': 'cpp-warning',
    'C++ assertion': 'cpp-assertion',
    'console.error': 'console-error',
    'console.warn': 'console-warn',
    'JavaScript error': 'js-error',
    'JavaScript warning': 'js-warning',
    'TSan Error': 'tsan-error',
};

/** The slugs, in markup order. */
export const KIND_SLUGS: readonly string[] = Object.values(KIND_SLUG);

/** One column of the stats area. */
export interface ViewColumn {
    key: 'tests' | 'messages' | 'count';
    label: string;
}

/**
 * The columns each view shows, besides the name column. `old/errors.html:223-227`.
 *
 * The message view has **no Messages column**, and that is not an omission: a
 * message-view row is one message *as a reader means the word* — one text at
 * one source location — so the column would read `1` on 834 of the 870 rows of
 * the pinned xpcshell file and, on the other 36, would count the generator's
 * per-component messageIds, which is a fact about the interning rather than
 * about the message. The component spread is the real content of that number
 * and `componentSummary` is where it goes.
 *
 * `buildGroups` skips computing `totalMsgs` for this view entirely (`:424`),
 * which is why `Totals.messages` below is `null` rather than 0 there — 0 would
 * be a number a reader could mistake for a measurement.
 */
export const VIEW_COLS: Readonly<Record<ErrorView, readonly ViewColumn[]>> = {
    message: [
        { key: 'tests', label: 'Tests' },
        { key: 'count', label: 'Occurrences' },
    ],
    test: [
        { key: 'messages', label: 'Messages' },
        { key: 'count', label: 'Occurrences' },
    ],
    component: [
        { key: 'tests', label: 'Tests' },
        { key: 'messages', label: 'Messages' },
        { key: 'count', label: 'Occurrences' },
    ],
};

/** The name column's header per view. `old/errors.html:228`. */
export const VIEW_NAME_LABEL: Readonly<Record<ErrorView, string>> = {
    message: 'Message',
    test: 'Test',
    component: 'Component',
};

// --- sorting --------------------------------------------------------------

/** Every column that can be sorted on, including the name column. */
export type SortColumn = 'name' | 'tests' | 'messages' | 'count';

/** A column and a direction. */
export interface SortState {
    column: SortColumn;
    ascending: boolean;
}

/**
 * The sort every view starts on: most occurrences first.
 *
 * `old/errors.html:232`, and **re-asserted on every view change** (`:1053`) rather
 * than carried over — so switching from a name-sorted message view to the test
 * view lands on count-descending, not on name-ascending.
 */
export const INITIAL_SORT: SortState = { column: 'count', ascending: false };

/**
 * The next sort state after clicking a header. `old/errors.html:818-828`.
 *
 * The asymmetry is upstream's and is the interesting part: clicking the *same*
 * column flips the direction, but clicking a **new** column starts descending
 * for the three numeric columns and **ascending for `name`**
 * (`ascending = column === 'name'`). A-to-Z is what a reader expects of a name
 * and biggest-first is what they expect of a count, so the rule is right; it is
 * called out because a "new column always descends" rewrite would look like a
 * simplification and would silently reverse the name column.
 */
export function nextSort(current: SortState, column: SortColumn): SortState {
    if (current.column === column) {
        return { column, ascending: !current.ascending };
    }
    return { column, ascending: column === 'name' };
}

// --- the prepared file ----------------------------------------------------

/**
 * One errors file, with every per-message and per-test attribute resolved once.
 *
 * `prepareData` (`old/errors.html:259-350`). The shape is dictated by the size of
 * the input: the pinned mochitest 2026-08-03 file holds 210,331 (test, message)
 * groups over 35,474 messages and 20,345 tests, carrying 67,840,668
 * occurrences. Every field here is either a typed array or a plain array
 * indexed by an integer id, so the grouping loop never hashes a string.
 *
 * `lib/formats/errors.ts` is deliberately **not** the source of these: its
 * `messageAt`/`testPathAt` resolve one entry at a time behind a function call,
 * which is right for the CLI's `rankErrors` (it walks groups, not messages) and
 * wrong for a loop that touches every marker. The raw file is read directly and
 * the *typed* description of it — `ErrorsFile` — is imported, so the fields are
 * still checked against the format.
 */
export interface PreparedErrors {
    /** The parsed file, for the shared scripts that index into it themselves. */
    raw: ErrorsFile;

    /** `tables.markerNames`, as the file orders them. */
    markerNames: readonly string[];

    /** Whether the file has a day axis. See `hasDays`. */
    hasDays: boolean;
    /** Whether the file has per-task attribution. See `hasTasks`. */
    hasTasks: boolean;
    /** `metadata.days`, or 0. */
    numDays: number;

    /** Per (test, message) group: its total occurrences. */
    groupTotal: Float64Array;
    /** Per group: the day index, when the file has a day axis. */
    days: readonly number[] | null;

    /** Per messageId: index into `markerNames`. */
    msgKindId: readonly number[];
    /** Per messageId: the text, or `'(no message)'`. */
    msgText: readonly string[];
    /** Per messageId: the source file, or `null`. */
    msgFile: readonly (string | null)[];
    /** Per messageId: the source line, or `null`. Independent of the file. */
    msgLine: readonly (number | null)[];
    /** Per messageId: the component, or `'Unknown'`. */
    msgComp: readonly string[];
    /** Per messageId: lowercased text + file + component, for the search. */
    msgBlob: readonly string[];

    /** Per testId: the full `path/name`. */
    testFull: readonly string[];
    /** Per testId: lowercased `testFull`, for the search. */
    testBlob: readonly string[];

    /** Per messageId: its dense component-group id. */
    compGroupId: readonly number[];
    /** Component-group id → display label. */
    compGroupLabel: readonly string[];

    /**
     * Per messageId: its dense **location**-group id, the message view's row.
     *
     * Several messageIds share one location id exactly when they differ only in
     * their component — see the module comment. This is the field that makes
     * the message view's row unit (kind, text, file, line) rather than the
     * generator's messageId.
     */
    locGroupId: Int32Array;
    /** Location-group id → the messageIds in it, ascending. */
    locGroupMids: readonly (readonly number[])[];
    /** Per testId: its dense test-group id. */
    testGroupId: Int32Array;
    /** Test-group id → display label. */
    testGroupLabel: readonly string[];

    /** Per kind: total occurrences over the whole file. */
    kindTotal: Float64Array;
    /** Per testId: bitmask of the kinds it has any marker in. */
    testKindMask: Int32Array;

    /** Per-view CSR buckets, built on demand. */
    csr: Partial<Record<ErrorView, Csr>>;
}

/**
 * Compressed-sparse-row bucketing of marker groups by their group id.
 *
 * `getCSR` (`old/errors.html:357-386`). `order[gStart[g] … gStart[g+1])` lists every
 * marker group belonging to display group `g`, so a filter pass is a flat scan
 * of contiguous runs with no `Map` and no per-group `Set`, and expanding one row
 * touches only that row's run.
 */
export interface Csr {
    /** `nGroups + 1` prefix sums. */
    gStart: Int32Array;
    /** Marker-group indices, bucketed. */
    order: Int32Array;
    nGroups: number;
    /** Group id → display label, or `null` in the message view. See below. */
    labels: readonly string[] | null;
}

/** What a message with no text displays as. `old/errors.html:295`. */
export const NO_MESSAGE = '(no message)';
/**
 * What a message with no component displays as. `old/errors.html:298`.
 *
 * The shared constant, not a second copy of the string: the CLI's rows use the
 * same sentinel, and `test/errors-parity.test.ts` compares the two sides'
 * component summaries — which two independently-spelled sentinels would fail
 * for a reason that has nothing to do with the summary.
 */
export const UNKNOWN_COMPONENT = SHARED_UNKNOWN_COMPONENT;

/**
 * Resolves a file's tables into the flat arrays the grouping loop wants.
 *
 * A faithful port of `prepareData`, with the one shape difference called out at
 * `hasDays`/`hasTasks`.
 */
export function prepareErrors(raw: ErrorsFile): PreparedErrors {
    const tables = raw.tables;
    const messages = raw.messages;
    const testInfo = raw.testInfo;
    const markers = raw.markers as ErrorsMarkersMaybeDays;

    // ## These two are the shape probes, and on today's data both are constant
    //
    // `hasDays` asks whether the file carries a per-group day index and
    // `hasTasks` whether it carries per-group task IDs. Upstream reads them off
    // the parsed object because it expects three file shapes: the daily file,
    // a 21-day counts-only aggregate, and a 21-day with-taskids aggregate.
    //
    // **Measured against the published artifacts, 2026-08-05:** only the daily
    // shape exists. `{harness}-errors.json` and
    // `{harness}-errors-with-taskids.json` both answer **404** for both
    // harnesses, so `hasDays` is false and `hasTasks` is true on every file
    // this page can actually load. The probes are kept because they are how the
    // page tells the shapes apart and the generator may yet publish the others;
    // what is *not* kept is any claim that the other branches are exercised.
    // See `site/errors.ts`'s divergence list, entry 6.
    const hasDays = Array.isArray(markers.days);
    const hasTasks = Array.isArray(markers.taskIdIds);

    const nGroups = markers.testIds.length;
    const counts = markers.counts as unknown as number[][] | number[];
    const groupTotal = new Float64Array(nGroups);
    if (hasTasks) {
        const perTask = counts as number[][];
        for (let g = 0; g < nGroups; g++) {
            const cs = perTask[g]!;
            let sum = 0;
            for (let j = 0; j < cs.length; j++) {
                sum += cs[j]!;
            }
            groupTotal[g] = sum;
        }
    } else {
        // The counts-only shape stores a scalar per group. `old/errors.html:288`.
        const scalar = counts as number[];
        for (let g = 0; g < nGroups; g++) {
            groupTotal[g] = scalar[g]!;
        }
    }

    const msgText = messages.textIds.map((id) =>
        id != null ? tables.messageTexts[id]! : NO_MESSAGE
    );
    const msgFile = messages.fileIds.map((id) => (id != null ? tables.files[id]! : null));
    const msgComp = messages.componentIds.map((id) =>
        id != null ? tables.components[id]! : UNKNOWN_COMPONENT
    );
    // The haystack a search matches a *message* against: its text, its file and
    // its component, lowercased once. `old/errors.html:299`. Note what is absent —
    // the **line number** and the **kind** are not searchable, so `1234` finds
    // nothing and `warning` matches only messages whose text says it.
    const msgBlob = msgText.map(
        (text, i) => `${text} ${msgFile[i] ?? ''} ${msgComp[i]!}`.toLowerCase()
    );

    const testFull = testInfo.testPathIds.map((pathId, i) => {
        const path = tables.testPaths[pathId]!;
        const name = tables.testNames[testInfo.testNameIds[i]!]!;
        // A test at the repository root has an empty path and must not render
        // as `/name`, which is the rule `joinTestPath` holds. `old/errors.html:306`.
        return joinTestPath(path, name);
    });
    const testBlob = testFull.map((s) => s.toLowerCase());

    // The component view groups by a string, so it is interned to a dense
    // integer first; a missing component folds into one trailing sentinel.
    const compGroupLabel = [...tables.components, UNKNOWN_COMPONENT];
    const compSentinel = tables.components.length;
    const compGroupId = messages.componentIds.map((id) => (id == null ? compSentinel : id));

    // The message view groups by (kind, text, file, line), so the four ids are
    // interned to a dense location id the same way. The key is built from the
    // *raw table ids* rather than from the resolved strings: two messages share
    // a text exactly when they share a `textIds` entry, so comparing integers
    // is both cheaper and free of the escaping question a string key raises.
    //
    // `??` folds an absent id onto `NO_ID`, which is outside the id space
    // because the tables are dense from 0 — so "no file" cannot collide with
    // "the file at index 0", the distinction `KEY_ABSENT` exists for in
    // `lib/query/error-ranking.ts`. The line is the file's own number rather
    // than an index, and `FORMATS.md` measured messages carrying a line with no
    // file, so the two fields stay independent.
    const NO_ID = -1;
    const locIndex = new Map<string, number>();
    const locGroupMids: number[][] = [];
    const locGroupId = new Int32Array(messages.textIds.length);
    for (let m = 0; m < messages.textIds.length; m++) {
        const key = `${messages.markerNameIds[m]},${messages.textIds[m] ?? NO_ID},${
            messages.fileIds[m] ?? NO_ID
        },${messages.lines[m] ?? NO_ID}`;
        let id = locIndex.get(key);
        if (id === undefined) {
            id = locGroupMids.length;
            locIndex.set(key, id);
            locGroupMids.push([]);
        }
        locGroupId[m] = id;
        locGroupMids[id]!.push(m);
    }

    // The test view groups by the full path string, so two `testInfo` entries
    // with the same path *and* name must share a row. `old/errors.html:325-331`.
    const testIndex = new Map<string, number>();
    const testGroupLabel: string[] = [];
    const testGroupId = new Int32Array(testFull.length);
    for (let i = 0; i < testFull.length; i++) {
        const key = testFull[i]!;
        let id = testIndex.get(key);
        if (id === undefined) {
            id = testGroupLabel.length;
            testIndex.set(key, id);
            testGroupLabel.push(key);
        }
        testGroupId[i] = id;
    }

    // Per-kind grand totals, so the message view can refresh its Total row on a
    // checkbox toggle without re-grouping. `testKindMask` exists because the
    // distinct-test total is *not* summable across kinds: one test emitting a
    // warning and an error is one test, not two. `old/errors.html:338-347`.
    const msgKindId = messages.markerNameIds;
    const kindTotal = new Float64Array(tables.markerNames.length);
    const testKindMask = new Int32Array(testFull.length);
    for (let i = 0; i < nGroups; i++) {
        const kind = msgKindId[markers.messageIds[i]!]!;
        kindTotal[kind] = kindTotal[kind]! + groupTotal[i]!;
        const tid = markers.testIds[i]!;
        testKindMask[tid] = testKindMask[tid]! | (1 << kind);
    }

    return {
        raw,
        markerNames: tables.markerNames,
        hasDays,
        hasTasks,
        numDays: (raw.metadata as { days?: number }).days ?? 0,
        groupTotal,
        days: hasDays ? markers.days! : null,
        msgKindId,
        msgText,
        msgFile,
        msgLine: messages.lines,
        msgComp,
        msgBlob,
        testFull,
        testBlob,
        compGroupId,
        compGroupLabel,
        locGroupId,
        locGroupMids,
        testGroupId,
        testGroupLabel,
        kindTotal,
        testKindMask,
        csr: {},
    };
}

/**
 * `ErrorsMarkers` plus the two fields only the (unpublished) aggregates carry.
 *
 * `lib/formats/errors.ts` describes the daily shape, which is the only one
 * published — see the measurement at `prepareErrors`. Declaring the optional
 * fields here rather than widening the `lib/` type keeps the format module
 * describing what exists.
 */
interface ErrorsMarkersMaybeDays {
    testIds: number[];
    messageIds: number[];
    taskIdIds?: number[][];
    counts: number[][] | number[];
    /** Per-group day index into the 21-day window. Aggregates only. */
    days?: number[];
}

/**
 * Builds (and caches) the CSR buckets for one view. `getCSR` (`:357`).
 *
 * The message view is the case worth reading twice: it has **no label table**,
 * because a row's group id is a **location id** and its name is rendered from
 * one of the diagnostics under it. That is what makes the row unit
 * (kind, text, file, line) — see the module comment.
 */
export function getCsr(data: PreparedErrors, view: ErrorView): Csr {
    const cached = data.csr[view];
    if (cached !== undefined) {
        return cached;
    }

    const markers = data.raw.markers;
    const n = markers.testIds.length;
    const mids = markers.messageIds;
    const tids = markers.testIds;

    const byTest = view === 'test';
    const compIds = view === 'component' ? data.compGroupId : null;
    const testIds = byTest ? data.testGroupId : null;
    const labels =
        view === 'component'
            ? data.compGroupLabel
            : byTest
              ? data.testGroupLabel
              : null;
    const nGroups = labels !== null ? labels.length : data.locGroupMids.length;

    const groupIdOf = (i: number): number =>
        testIds !== null
            ? testIds[tids[i]!]!
            : compIds !== null
              ? compIds[mids[i]!]!
              : data.locGroupId[mids[i]!]!;

    const gStart = new Int32Array(nGroups + 1);
    for (let i = 0; i < n; i++) {
        const at = groupIdOf(i) + 1;
        gStart[at] = gStart[at]! + 1;
    }
    for (let g = 0; g < nGroups; g++) {
        gStart[g + 1] = gStart[g + 1]! + gStart[g]!;
    }

    const order = new Int32Array(n);
    const pos = gStart.slice();
    for (let i = 0; i < n; i++) {
        order[pos[groupIdOf(i)]!++] = i;
    }

    const csr: Csr = { gStart, order, nGroups, labels };
    data.csr[view] = csr;
    return csr;
}

// --- the kind checkboxes --------------------------------------------------

/**
 * Which marker kinds are enabled, indexed by the file's `markerNameId`.
 *
 * `computeKindOn` (`old/errors.html:389-397`) with the DOM read lifted out: the
 * caller passes the set of *disabled slugs*, which is also exactly what the URL
 * carries (`hide=`, `:1113-1116`).
 *
 * The two defaults are upstream's and both matter:
 *
 * - **A kind with no checkbox is on.** `:394`'s `on[i] = cb ? cb.checked : true`.
 *   Reachable: `tables.markerNames` is data, and a kind the markup does not name
 *   cannot be turned off. None exists on the pinned files (xpcshell has 6 of the
 *   7, mochitest has all 7), so this is measured-unreachable *today*, not
 *   unreachable.
 * - **An absent `hide=` means everything on**, which is why the URL encodes the
 *   *disabled* set rather than the enabled one: the empty string is the default
 *   state and produces the shortest link.
 */
export function kindStates(
    markerNames: readonly string[],
    disabledSlugs: ReadonlySet<string>
): boolean[] {
    return markerNames.map((name) => {
        const slug = KIND_SLUG[name];
        return slug === undefined ? true : !disabledSlugs.has(slug);
    });
}

/** Bitmask of the enabled kinds. `kindOnMask` (`old/errors.html:701`). */
export function kindMask(kindOn: readonly boolean[]): number {
    let mask = 0;
    for (let k = 0; k < kindOn.length; k++) {
        if (kindOn[k]) {
            mask |= 1 << k;
        }
    }
    return mask;
}

/**
 * The disabled slugs a double-click on one checkbox produces.
 *
 * "Solo": show only that kind. `old/errors.html:1214-1223`. Every slug **in the
 * markup's table** except the clicked one is disabled — including a slug for a
 * kind the loaded file does not have, which is harmless because `kindStates`
 * only reads the ones the file names.
 */
export function soloKind(slug: string): Set<string> {
    return new Set(KIND_SLUGS.filter((candidate) => candidate !== slug));
}

// --- grouping -------------------------------------------------------------

/** One row of the ranked list. */
export interface ErrorGroupRow {
    /**
     * The row's group id.
     *
     * In the message view this is a **location id** — an index into
     * `locGroupMids` — and the row renders itself from the diagnostics under
     * it; in the other two it indexes the view's label table.
     */
    gid: number;
    /** The label, or `null` in the message view until `groupName` builds it. */
    key: string | null;
    /** Occurrences. */
    count: number;
    /** Bitmask of the marker kinds in this row. */
    kindMask: number;
    /** Distinct tests, or 0 when the view has no Tests column. */
    testCount: number;
    /** Distinct messages, or 0 when the view has no Messages column. */
    msgCount: number;
    /** The lowercase search haystack, built on demand by `ensureHaystacks`. */
    hay: string | null;
}

/** The totals shown in the `📊 Total` row. */
export interface Totals {
    /** Occurrences. */
    count: number;
    /** Distinct tests, or `null` when the view has no Tests column. */
    tests: number | null;
    /**
     * Distinct messages, or `null` when the view has no Messages column.
     *
     * `null` rather than 0 for the message view: `buildGroups` never computes it
     * there (`old/errors.html:424`, `needMsgs = view !== 'message'`), and 0 would be
     * a number a reader could take for a measurement. The renderer never asks
     * for it, because `VIEW_COLS.message` has no `messages` column.
     */
    messages: number | null;
}

/** A grouping's rows and the totals they were drawn from. */
export interface GroupingResult {
    view: ErrorView;
    /** Every non-empty row, ranked. */
    rows: ErrorGroupRow[];
    totals: Totals;
}

/**
 * Groups every marker for one view, honouring the kind checkboxes.
 *
 * `buildGroups` (`old/errors.html:416-474`). One pass over the CSR runs,
 * accumulating into typed arrays.
 *
 * ## The kind filter is applied here **only outside the message view**
 *
 * This is the page's most surprising behaviour and it is upstream's
 * (`:422`, `applyKind = view !== 'message'`). The reason is structural rather
 * than an optimisation:
 *
 * - A **message-view** row has exactly one kind, because the **kind is part of
 *   its key** — merging the component out of the key did not change this, and
 *   would have broken it had the kind gone too. A checkbox can therefore only
 *   ever show or hide the *whole* row, never change its number — so the rows are
 *   built once over all kinds and the checkboxes filter visibility later
 *   (`visibleRows`). What the checkboxes *do* change there is the **Total row
 *   and every percentage tooltip**, which are recomputed from the per-kind
 *   aggregates (`:686-695`, `messageTotals` below).
 * - A **test-view or component-view** row mixes kinds, so unchecking one changes
 *   the row's count, its test/message counts and therefore the ranking. Those
 *   views must re-group, which is what `onKindFilterChange` (`:1042-1049`) does.
 *
 * Getting this backwards is not a cosmetic bug: applying `kindOn` in the message
 * view would leave the counts identical (each row is one kind) but would drop
 * every row of a disabled kind from `rows` *and* from the haystack pass, so a
 * search after a toggle would behave differently. `test/errors-view.test.ts`
 * has a mutation for it.
 *
 * ## Distinct counts come from a stamp array, not a `Set`
 *
 * `tidStamp[tid] === g + 1` means "this test has already been counted for group
 * g". One `Int32Array` reused across all groups replaces a `Set` per group,
 * which is what makes this viable at 210,331 groups. The `+ 1` is load-bearing:
 * a zero-initialized array must not read as "already seen group 0".
 */
export function buildGroupRows(
    data: PreparedErrors,
    view: ErrorView,
    kindOn: readonly boolean[],
    sort: SortState
): GroupingResult {
    const markers = data.raw.markers;
    const mids = markers.messageIds;
    const tids = markers.testIds;
    const groupTotal = data.groupTotal;
    const msgKindId = data.msgKindId;
    const { gStart, order, nGroups, labels } = getCsr(data, view);

    const applyKind = view !== 'message';
    const needTests = view !== 'test';
    const needMsgs = view !== 'message';
    const numTests = data.testFull.length;
    const numMids = data.msgKindId.length;

    const gCount = new Float64Array(nGroups);
    const gMask = new Int32Array(nGroups);
    const gTest = needTests ? new Int32Array(nGroups) : null;
    const gMsg = needMsgs ? new Int32Array(nGroups) : null;
    const tidStamp = needTests ? new Int32Array(numTests) : null;
    const midStamp = needMsgs ? new Int32Array(numMids) : null;
    const seenTid = needTests ? new Uint8Array(numTests) : null;
    const seenMid = needMsgs ? new Uint8Array(numMids) : null;

    let total = 0;
    let totalTests = 0;
    let totalMsgs = 0;

    for (let g = 0; g < nGroups; g++) {
        const end = gStart[g + 1]!;
        for (let j = gStart[g]!; j < end; j++) {
            const i = order[j]!;
            const mid = mids[i]!;
            const kind = msgKindId[mid]!;
            if (applyKind && !kindOn[kind]) {
                continue;
            }
            const c = groupTotal[i]!;
            gCount[g] = gCount[g]! + c;
            total += c;
            gMask[g] = gMask[g]! | (1 << kind);
            if (needTests) {
                const tid = tids[i]!;
                if (tidStamp![tid] !== g + 1) {
                    tidStamp![tid] = g + 1;
                    gTest![g] = gTest![g]! + 1;
                }
                if (!seenTid![tid]) {
                    seenTid![tid] = 1;
                    totalTests++;
                }
            }
            if (needMsgs) {
                if (midStamp![mid] !== g + 1) {
                    midStamp![mid] = g + 1;
                    gMsg![g] = gMsg![g]! + 1;
                }
                if (!seenMid![mid]) {
                    seenMid![mid] = 1;
                    totalMsgs++;
                }
            }
        }
    }

    const rows: ErrorGroupRow[] = [];
    for (let g = 0; g < nGroups; g++) {
        // `gCount[g] <= 0` drops a group with no surviving markers. Note the
        // consequence the brief names: **the universe of this page is the
        // markers in the file**, so a test that emitted nothing has no row at
        // all and there is no run-count normalization anywhere. `:451-452`.
        if (gCount[g]! <= 0) {
            continue;
        }
        rows.push({
            gid: g,
            key: labels !== null ? labels[g]! : null,
            count: gCount[g]!,
            kindMask: gMask[g]!,
            testCount: needTests ? gTest![g]! : 0,
            msgCount: needMsgs ? gMsg![g]! : 0,
            hay: null,
        });
    }

    sortRows(data, rows, sort);

    return {
        view,
        rows,
        totals: {
            count: total,
            tests: needTests ? totalTests : null,
            messages: needMsgs ? totalMsgs : null,
        },
    };
}

/**
 * A row's display name.
 *
 * `groupName` (`old/errors.html:489-497`). In the test and component views it is
 * the label table's entry; in the message view it is built on demand from the
 * row's diagnostic and **cached onto the row**, because materializing a string
 * per row during grouping would allocate 31,530 strings the page may never
 * show.
 *
 * The shape is `text` + `" file"` + `":line"`, with each part dropped when
 * absent — and note the nesting: **a line with no file is not shown at all**,
 * because the `line` clause is inside the `file` clause. That is upstream's
 * (`:493-494`) and is reachable: 16 of the 1,078 messages on the pinned
 * xpcshell file have a line and no file, so those rows are named by their text
 * alone even though the grouping distinguished them by line. Two such rows with
 * the same text therefore render as two identically-named rows with different
 * counts. Reproduced; divergence list entry 5.
 *
 * The three fields are read off `representativeMid`, which is sound precisely
 * because they are the row's key: every messageId in the row carries the same
 * text, file and line, and differs only in its component.
 */
export function groupName(data: PreparedErrors, row: ErrorGroupRow): string {
    if (row.key === null) {
        const mid = representativeMid(data, row.gid);
        const file = data.msgFile[mid];
        const line = data.msgLine[mid];
        row.key = data.msgText[mid]! + (file ? ` ${file}${line != null ? `:${line}` : ''}` : '');
    }
    return row.key;
}

/**
 * A message-view row's first messageId, for the fields its key determines.
 *
 * The kind, the text, the file and the line are identical across every
 * messageId in a location group — that *is* the grouping key — so "the first
 * one" is not an arbitrary pick for those four fields, and the merge is only
 * safe for them. The **component** is the field that varies, and reading it off
 * this messageId would be the arbitrary pick; `componentSummary` exists so the
 * renderer never has to.
 */
export function representativeMid(data: PreparedErrors, gid: number): number {
    return data.locGroupMids[gid]![0]!;
}

// --- the component summary ------------------------------------------------

/**
 * Every component behind one row, most occurrences first.
 *
 * This is the page's half of the summary: the *aggregation*, which is
 * page-shaped because it walks the row's CSR run over the markers. The
 * *decision* — whether to name a leader, and how to word it — is
 * `componentSummary` in `lib/query/error-ranking.ts`, imported rather than
 * restated so the page and `fx-tests errors` cannot drift apart on it.
 *
 * The counts are summed over the row's marker groups, so a location emitted
 * under two components contributes to both, and the shares sum to the row's
 * count.
 */
export function componentBreakdown(data: PreparedErrors, row: ErrorGroupRow): ComponentShare[] {
    const totals = new Map<string, number>();
    const markers = data.raw.markers;
    const mids = markers.messageIds;
    const { gStart, order } = getCsr(data, 'message');

    for (let j = gStart[row.gid]!, end = gStart[row.gid + 1]!; j < end; j++) {
        const i = order[j]!;
        const component = data.msgComp[mids[i]!]!;
        totals.set(component, (totals.get(component) ?? 0) + data.groupTotal[i]!);
    }

    return sortComponents(totals);
}

/**
 * The full breakdown as tooltip text — the shared lines, joined by newlines.
 *
 * A `title` attribute renders `\n` as a line break, so the shared
 * `componentBreakdownLines` serves both this and the CLI's indented block
 * without either having to know how the other lays it out.
 */
export function componentBreakdownTitle(shares: readonly ComponentShare[]): string | null {
    if (shares.length === 0) {
        return null;
    }
    return componentBreakdownLines(shares).join('\n');
}

/** A row's value in one column. `colValue` (`old/errors.html:589-595`). */
export function colValue(
    data: PreparedErrors,
    row: ErrorGroupRow,
    key: SortColumn
): number | string {
    switch (key) {
        case 'count':
            return row.count;
        case 'tests':
            return row.testCount;
        case 'messages':
            return row.msgCount;
        case 'name':
            return groupName(data, row);
    }
}

/**
 * Ranks the rows **in place**. `sortGroups` (`old/errors.html:476-483`).
 *
 * In place because the page re-sorts the already-grouped array on a header click
 * rather than re-grouping (`:826`), and because `buildGroupRows` sorts the array
 * it just built. `Array.prototype.sort` is stable, so ties keep CSR order — which
 * is ascending group id, i.e. `messageId` order in the message view and label
 * order in the other two.
 *
 * The comparator branches on the *runtime* type of the value, which is how one
 * function serves both the three numeric columns and the string `name` column.
 */
export function sortRows(
    data: PreparedErrors,
    rows: ErrorGroupRow[],
    sort: SortState
): ErrorGroupRow[] {
    rows.sort((a, b) => {
        const av = colValue(data, a, sort.column);
        const bv = colValue(data, b, sort.column);
        const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : av - (bv as number);
        return sort.ascending ? cmp : -cmp;
    });
    return rows;
}

// --- filtering ------------------------------------------------------------

/**
 * Builds each row's lowercase search haystack, once. `ensureHays` (`:569-587`).
 *
 * A row's haystack is every distinct message blob and every distinct test blob
 * under it, joined by spaces — so a search matches a row when it matches *any*
 * message text, file, component or test path in it. Built lazily because a
 * session that never searches never pays for it, and cached on the rows until
 * the next re-group.
 *
 * The guard is upstream's: `if (!rows.length || rows[0].hay !== null) return`.
 * It tests **only the first row**, which is sound because the only writer is
 * this loop and it writes all of them or none.
 */
export function ensureHaystacks(
    data: PreparedErrors,
    view: ErrorView,
    rows: readonly ErrorGroupRow[]
): void {
    if (rows.length === 0 || rows[0]!.hay !== null) {
        return;
    }
    const markers = data.raw.markers;
    const mids = markers.messageIds;
    const tids = markers.testIds;
    const { gStart, order } = getCsr(data, view);
    const midStamp = new Int32Array(data.msgKindId.length);
    const tidStamp = new Int32Array(data.testFull.length);

    for (const row of rows) {
        const gid = row.gid;
        const parts: string[] = [];
        for (let j = gStart[gid]!, end = gStart[gid + 1]!; j < end; j++) {
            const i = order[j]!;
            const mid = mids[i]!;
            const tid = tids[i]!;
            if (midStamp[mid] !== gid + 1) {
                midStamp[mid] = gid + 1;
                parts.push(data.msgBlob[mid]!);
            }
            if (tidStamp[tid] !== gid + 1) {
                tidStamp[tid] = gid + 1;
                parts.push(data.testBlob[tid]!);
            }
        }
        row.hay = parts.join(' ');
    }
}

/**
 * The rows a reader can see. `applyFilter`'s selection half (`:666-681`).
 *
 * Two independent filters, and the first only applies to the message view:
 *
 * 1. **The kind mask**, message view only — `!(row.kindMask & onMask)`. A
 *    message-view row is one kind, so this is exactly "is this row's kind
 *    checked". In the other views the kinds are already baked into the counts by
 *    `buildGroupRows`, and applying the mask again would drop a mixed-kind row
 *    that legitimately survived with a smaller count.
 * 2. **The search term**, a plain lowercase substring test against the
 *    haystack. Not a regex, no `!`-prefix negation, no word boundaries —
 *    `old/errors.html:678` is `g.hay.indexOf(term) < 0`. Checked against the whole
 *    page: nothing anywhere in `errors.html` treats `!` specially, so a search
 *    for `!foo` looks for the literal three characters and matches nothing on
 *    the pinned files.
 *
 * **Note what this does *not* do: it never changes a row's numbers.** A row
 * that survives a search shows the count it had with no search, and expanding it
 * shows only the sub-rows that matched (`buildDetail` re-applies the term). So
 * the row's own number can exceed the sum of what expanding it reveals — see
 * divergence list entry 4.
 */
export function visibleRows(
    view: ErrorView,
    rows: readonly ErrorGroupRow[],
    onMask: number,
    searchTerm: string
): ErrorGroupRow[] {
    const isMessage = view === 'message';
    const out: ErrorGroupRow[] = [];
    for (const row of rows) {
        if (isMessage && !(row.kindMask & onMask)) {
            continue;
        }
        if (searchTerm !== '' && !row.hay!.includes(searchTerm)) {
            continue;
        }
        out.push(row);
    }
    return out;
}

/**
 * The message view's totals, recomputed from the per-kind aggregates.
 *
 * `applyFilter`'s second half (`old/errors.html:686-695`). The message view does not
 * re-group on a checkbox toggle, so its Total row would otherwise keep the
 * all-kinds numbers — and because `pctTitle` divides by `total`, **every
 * percentage tooltip on the page would be wrong too**, not just the one row.
 *
 * The two numbers are computed differently, and that asymmetry is the point:
 *
 * - **Occurrences** are summable across kinds, so it is a sum of `kindTotal`.
 * - **Tests** are not: a test emitting a warning and an error is one test in
 *   both, so summing per-kind test counts would double-count it. The mask array
 *   is what makes the distinct count possible without a re-group.
 *
 * Measured on the pinned xpcshell 2026-08-04 file: with all kinds on, tests =
 * 624 and the per-kind test counts sum to 1,110 — a 1.78× overcount the mask
 * avoids.
 *
 * Note this is the **grand** total over the whole file, unaffected by the search
 * term. That is upstream's behaviour and it is the page bug called out as
 * divergence 4.
 */
export function messageTotals(data: PreparedErrors, kindOn: readonly boolean[]): Totals {
    let count = 0;
    for (let k = 0; k < data.kindTotal.length; k++) {
        if (kindOn[k]) {
            count += data.kindTotal[k]!;
        }
    }
    const onMask = kindMask(kindOn);
    let tests = 0;
    for (let i = 0; i < data.testKindMask.length; i++) {
        if (data.testKindMask[i]! & onMask) {
            tests++;
        }
    }
    return { count, tests, messages: null };
}

// --- the expanded subtree -------------------------------------------------

/** One task that saw a group's markers. */
export interface Instance {
    taskId: string;
    /** As a string, which is what the shared link builders want. */
    retryId: string;
    jobName: string;
    /** Occurrences in this task — rendered as `×N` when above 1. */
    count: number;
    /** `YYYY-MM-DD`, or `''` when the file records none. */
    date: string;
}

/** One sub-row under an expanded group. */
export interface SubGroup {
    /**
     * A `testId` in the message view, a `messageId` in the other two.
     *
     * The complement of the top level, which is the structural reason this page
     * cannot use `site/drilldown-view.ts`'s fixed `PathNode` → `TestNode`.
     */
    key: number;
    count: number;
    /** The tasks, or `null` when the file has no task attribution. */
    instances: Map<number, { count: number; day: number }> | null;
}

/** An expanded group's contents. */
export interface GroupDetail {
    /** Sub-rows, most occurrences first. */
    subs: SubGroup[];
    /** Per-day occurrences, or `null` without a day axis. */
    dayCounts: Float64Array | null;
}

/**
 * Builds one group's sub-rows and per-task instances. `buildGroupDetail` (`:504`).
 *
 * Deferred until a row is expanded, and it walks **only that row's CSR run**, so
 * it is O(the row) rather than O(the file) — which matters when the widest row
 * of the pinned mochitest file covers 11,943 tests out of 20,345.
 *
 * ## The kind filter and the search are both re-applied here
 *
 * `:525` and `:527`. So an expanded row under a search shows only the sub-rows
 * that matched, even though the row's own count (from `buildGroupRows`) was
 * computed without the search. The two disagreeing is upstream's behaviour and
 * is divergence 4.
 *
 * The kind re-application is what makes an expanded **message-view** row correct
 * after a toggle: the row survived because *its* kind is on, and its sub-rows
 * are tests, all of which share that kind — so the filter is a no-op there. In
 * the test and component views it is the same filter `buildGroupRows` applied,
 * re-run because the detail is built from the raw markers rather than from the
 * row.
 */
export function buildDetail(
    data: PreparedErrors,
    view: ErrorView,
    row: ErrorGroupRow,
    kindOn: readonly boolean[],
    searchTerm: string
): GroupDetail {
    const markers = data.raw.markers as ErrorsMarkersMaybeDays;
    const mids = markers.messageIds;
    const tids = markers.testIds;
    const groupTotal = data.groupTotal;
    const days = data.days;
    const taskIdIds = data.hasTasks ? markers.taskIdIds! : null;
    const perTaskCounts = data.hasTasks ? (markers.counts as number[][]) : null;
    const { gStart, order } = getCsr(data, view);

    const subs = new Map<number, SubGroup>();
    const dayCounts = data.hasDays ? new Float64Array(data.numDays) : null;

    for (let j = gStart[row.gid]!, end = gStart[row.gid + 1]!; j < end; j++) {
        const i = order[j]!;
        const mid = mids[i]!;
        if (!kindOn[data.msgKindId[mid]!]) {
            continue;
        }
        const tid = tids[i]!;
        if (
            searchTerm !== '' &&
            !data.msgBlob[mid]!.includes(searchTerm) &&
            !data.testBlob[tid]!.includes(searchTerm)
        ) {
            continue;
        }

        const c = groupTotal[i]!;
        // `days[i] < nDays` guards a day index past the window's end, which
        // upstream has at `:530` and which cannot fire on a file with no day
        // axis because `dayCounts` is null.
        if (days !== null && dayCounts !== null && days[i]! < data.numDays) {
            const day = days[i]!;
            dayCounts[day] = dayCounts[day]! + c;
        }

        const subKey = view === 'message' ? tid : mid;
        let sub = subs.get(subKey);
        if (sub === undefined) {
            sub = { key: subKey, count: 0, instances: data.hasTasks ? new Map() : null };
            subs.set(subKey, sub);
        }
        sub.count += c;

        if (taskIdIds !== null && perTaskCounts !== null && sub.instances !== null) {
            // Per-group delta encoding, ascending from 0 — `lib/formats/errors.ts`
            // documents it and `forEachDelta` implements the same walk. Inlined
            // rather than called because the parallel `counts[i][k]` has to be
            // read at the same index, which the callback form does not expose.
            const deltas = taskIdIds[i]!;
            const counts = perTaskCounts[i]!;
            const day = days !== null ? days[i]! : -1;
            let taskIdIndex = 0;
            for (let k = 0; k < deltas.length; k++) {
                taskIdIndex += deltas[k]!;
                let entry = sub.instances.get(taskIdIndex);
                if (entry === undefined) {
                    entry = { count: 0, day };
                    sub.instances.set(taskIdIndex, entry);
                }
                entry.count += counts[k]!;
            }
        }
    }

    return {
        // Descending by occurrences, and **stable**, so ties keep the order the
        // CSR walk found them in. `:558`.
        subs: [...subs.values()].sort((a, b) => b.count - a.count),
        dayCounts,
    };
}

/**
 * Resolves one sub-row's tasks into displayable rows. `renderInstances` (`:935`).
 *
 * `parseTaskId` replaces upstream's `lastIndexOf('.')` split. The two agree on
 * every suffixed ID and differ only on one with no `.N` — upstream would produce
 * `taskId: ''` and `retryId: <the whole string>` from `lastIndexOf` returning
 * -1, which is worse than `parseTaskId`'s `retryId: 0`. **Measured on the pinned
 * files: 0 of 736 xpcshell and 0 of 108,675 mochitest task IDs lack a suffix**,
 * so the two select the same values here.
 *
 * The date has two sources, matching `:944-948`: a day index into the aggregate
 * window, or the file's own `metadata.date`. On every published file the second
 * branch is the one taken, because no file has a day axis — see `prepareErrors`.
 */
export function instancesOf(data: PreparedErrors, sub: SubGroup): Instance[] {
    if (sub.instances === null) {
        return [];
    }
    const raw = data.raw;
    const out: Instance[] = [];
    for (const [taskIdIndex, entry] of sub.instances) {
        const { taskId, retryId } = parseTaskId(raw.tables.taskIds[taskIdIndex]!);
        let date = '';
        if (data.hasDays && entry.day >= 0) {
            date = new Date((raw.metadata.startTime + entry.day * 86400) * 1000)
                .toISOString()
                .split('T')[0]!;
        } else if (raw.metadata.date) {
            date = raw.metadata.date;
        }
        out.push({
            taskId,
            retryId: String(retryId),
            jobName: raw.tables.jobNames[raw.taskInfo.jobNameIds[taskIdIndex]!]!,
            count: entry.count,
            date,
        });
    }
    return out;
}

/**
 * Orders instances newest-first and says which ones show their date.
 *
 * `prepareRunsForDisplay` (`common-ui.js:488`) reimplemented for the same reason
 * `site/drilldown-view.ts` does: the shared version **mutates** its input,
 * stamping a `dateHtml` string of markup onto every run, which is wrong for a
 * renderer that builds elements and would mean this module handing back `<td>`.
 *
 * The sort is upstream's, `localeCompare` on the `YYYY-MM-DD` strings,
 * descending, and stable — so within one date the tasks keep `Map` insertion
 * order, which is ascending task index. On a single-day file **every** instance
 * shares the one date, so exactly the first row shows it.
 */
export function instanceRows(
    instances: readonly Instance[]
): { instance: Instance; showDate: boolean }[] {
    const sorted = [...instances].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    let lastDate: string | null = null;
    return sorted.map((instance) => {
        if (!instance.date) {
            return { instance, showDate: false };
        }
        const showDate = instance.date !== lastDate;
        lastDate = instance.date;
        return { instance, showDate };
    });
}

// --- percentages ----------------------------------------------------------

/**
 * The share-of-total tooltip on an occurrences cell, or `null` for none.
 *
 * `pctTitle` (`old/errors.html:631-635`). **The only ratio on this page** — there is
 * no run-count normalization anywhere, because the file's universe is the
 * markers it contains and a test that emitted nothing has no row.
 *
 * Two details are load-bearing:
 *
 * - **Rounded once, from the raw ratio**, with `toFixed(2)`. Never from an
 *   already-rounded intermediate.
 * - **A zero total yields no tooltip at all**, not `"0.00%"` — `if (!total)`.
 *   Reachable: unchecking every kind box in the message view makes the total 0
 *   while rows are still on screen (they are filtered out too, so the list is
 *   empty — but the Total row remains and its own cell also loses its tooltip).
 *
 * ## Why it shows two numbers where upstream showed one
 *
 * Upstream passes the **grand** total always, so under a search a row reads a
 * share of a population that is not on screen. Measured on the pinned xpcshell
 * file: searching `NS_ENSURE_TRUE` leaves 100 rows totalling 20,922 visible,
 * and the top row's tooltip reads `4.85% of all occurrences` when it is 73.04%
 * of what the reader can see. Both numbers are true; the tooltip named only the
 * less useful one, and named it in a way that reads as though it were the
 * obvious one.
 *
 * So when a filter is narrowing the list, both are shown and both are labelled.
 * With no filter the two populations are the same and a second number would be
 * noise, so the wording stays as it was.
 *
 * Rounded once, from the raw ratio, with `toFixed(2)` — never from an
 * already-rounded intermediate.
 */
export function pctTitle(count: number, total: number, visibleTotal?: number): string | null {
    if (!total) {
        return null;
    }
    const share = (value: number): string => ((count / value) * 100).toFixed(2);
    // `undefined` means the caller has no filtered population to report; equal
    // totals mean nothing is filtered. Both collapse to the one-number form.
    if (visibleTotal === undefined || visibleTotal === total || !visibleTotal) {
        return `${share(total)}% of all ${total.toLocaleString()} occurrences`;
    }
    return (
        `${share(visibleTotal)}% of the ${visibleTotal.toLocaleString()} shown, ` +
        `${share(total)}% of all ${total.toLocaleString()}`
    );
}

// --- URL state ------------------------------------------------------------

/** The four keys this page's hash carries. `old/errors.html:1169-1174`. */
export interface UrlState {
    /** A date, or `21days`. */
    date: string;
    /** The search term. */
    q: string;
    /** The group-by view. */
    view: ErrorView;
    /** The **disabled** kind slugs, comma-separated. Empty means all on. */
    hide: string;
}

/** Parses `hide=` into a set. `loadFromUrlHash` (`old/errors.html:1133`). */
export function parseHidden(hide: string | undefined): Set<string> {
    return new Set((hide ?? '').split(',').filter(Boolean));
}

/**
 * Serializes the disabled slugs. `getDisabledKindSlugs` (`old/errors.html:1113`).
 *
 * In markup order, not in the order they were unchecked, so the same visual
 * state always produces the same URL.
 */
export function formatHidden(disabled: ReadonlySet<string>): string {
    return KIND_SLUGS.filter((slug) => disabled.has(slug)).join(',');
}

/** Reads this page's four keys out of a parsed hash. */
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
    const view = params.get('view');
    // Validated, not trusted: `#view=bogus` must leave the page on its current
    // view rather than on a view with no columns. `old/errors.html:1128`.
    if (view !== null && isErrorView(view)) {
        state.view = view;
    }
    const hide = params.get('hide');
    if (hide !== null) {
        state.hide = hide;
    }
    return state;
}

/** The hash value meaning the 21-day aggregate. `old/errors.html:1145`. */
export const HISTORICAL_DATE = '21days';

/**
 * Whether a hash's `date` means the 21-day view.
 *
 * **Only the exact string `21days`.** This is the opposite of
 * `site/drilldown-view.ts`'s `isHistoricalDate`, where an absent date *also*
 * means historical — and the difference is real, not an oversight on either
 * side: `old/errors.html:1144-1152`'s comment says "Default: most recent single
 * day", and its `else` branch toggles *out* of historical mode. A link with no
 * `date` therefore gives the crashes page the 21-day view and this page one day.
 */
export function isHistoricalDate(date: string | undefined): boolean {
    return date === HISTORICAL_DATE;
}
