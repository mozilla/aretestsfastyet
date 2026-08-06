/**
 * Ranking the errors and warnings in one day's test logs.
 *
 * Behind `fx-tests errors`. `PLAN.md` §3 step 5 names the dominant use case:
 * "what is loudest in the logs", for noise-reduction work, because a handful of
 * messages account for most of the volume — on 2026-07-30 one C++ warning was
 * 16.9M of 103.2M markers and the top three were over a quarter of the file.
 *
 * ## The test-spread count is the discriminator
 *
 * Occurrences alone rank the loudest message, which is usually something
 * ambient. The number that separates "background noise from every test" from
 * "a message specific to one test, and therefore a candidate cause" is **how
 * many distinct tests emitted it**. `CLI.md`'s `tests` column is this, and it
 * is available for free because the file's groups are already keyed by
 * (test, message).
 *
 * ## Grouping is by source location as well as text, and not by component
 *
 * The default key is **(kind, text, file, line)**, and both halves of that are
 * deliberate.
 *
 * *The file and the line are in.* The same text emitted from two different
 * places is two different problems, and merging them produces one row whose
 * count belongs to neither.
 *
 * *The component is out.* A component is not a property of the message: the
 * message is emitted at a `file:line`, and the component is whichever test
 * happened to be running when it printed. Keying on it would split one message
 * into rows for a reason that says nothing about the message. `site/errors.ts`
 * keys the same way for the same reason — it used to key on the generator's
 * `messageId`, which includes the component, and no longer does — so the two
 * sides now agree on the row set and `test/errors-parity.test.ts` compares them
 * row for row rather than folding one onto the other.
 *
 * What neither side throws away is the component itself: every row carries a
 * `components` breakdown and a one-line `componentSummary`. Measured on the
 * pinned xpcshell 2026-08-04 file, 1,078 messageIds fall into 870 rows, 36 of
 * which hold more than one messageId — and **none of the 36** differ by
 * anything except the component.
 *
 * The nulls are what make this fiddly. `FORMATS.md` measured that a message can
 * have a line and **no file** (22 xpcshell messages), so a key built by
 * concatenating `file:line` would collapse every fileless message with the same
 * line number into one group. The key here keeps the two fields separate and
 * distinguishes "absent" from any real value.
 *
 * ## One pass, no per-occurrence objects
 *
 * A weekday mochitest file holds 103M markers. `PLAN.md` §4 is explicit that
 * aggregation must be a single pass over integer-indexed arrays; this walks the
 * groups — tens of thousands of them, not 103M — and accumulates integers. The
 * per-group task ID arrays are never decoded unless `--task-ids` asks.
 */

import type { DecodedErrorsFile, DecodedMessage } from '../formats/errors.ts';

/** How rows are grouped. `CLI.md`'s `--group-by`. */
export type ErrorGrouping = 'message' | 'location' | 'test' | 'component' | 'kind';

/** What to rank by. `CLI.md`'s `--sort`. */
export type ErrorSort = 'occurrences' | 'tests';

/** One ranked row. */
export interface ErrorGroup {
    /** The grouping key, as a display string. */
    key: string;
    /** The marker kind, or `null` when the group spans more than one. */
    kind: string | null;
    /** The message text, or `null` when absent or when the group spans many. */
    text: string | null;
    /** Source file, or `null`. */
    file: string | null;
    /** Source line, or `null`. Independent of `file` — see the module comment. */
    line: number | null;
    /** Bugzilla component, or `null`. */
    component: string | null;
    /** Total occurrences. */
    count: number;
    /**
     * Distinct tests that emitted it — the ambient-vs-specific signal.
     *
     * Exact even when `tests` below is capped: the cap drops rows, not the
     * count, so "in 9,367 tests" stays true while only a handful are listed.
     */
    testCount: number;
    /** The loudest tests, most occurrences first. Capped by `maxTestsPerGroup`. */
    tests: { testId: number; path: string; count: number }[];
    /**
     * Every component this row's occurrences came from, biggest first.
     *
     * Uncapped, because `componentSummary` and `componentBreakdownLines` decide
     * what to show and both need the whole distribution to decide it — a list
     * truncated here would make a 61-component row indistinguishable from a
     * 12-component one. Empty only for a grouping that has no component to
     * report, which is `--group-by kind`; see the accumulator.
     */
    components: ComponentShare[];
    /** The marker group IDs behind this row, for `--task-ids`. Capped. */
    groupIds: number[];
}

/** Options for `rankErrors`. */
export interface ErrorRankingOptions {
    grouping?: ErrorGrouping | undefined;
    sort?: ErrorSort | undefined;
    /** Only messages whose text contains this, case-insensitively. */
    message?: string | undefined;
    /** Only this marker kind, matched exactly against `tables.markerNames`. */
    kind?: string | undefined;
    /** Only this test, matched as a full path or a path prefix. */
    test?: string | undefined;
    /** Only messages whose component contains this, case-insensitively. */
    component?: string | undefined;
    /** Only messages whose source file contains this, case-insensitively. */
    file?: string | undefined;
    /** How many per-test rows to keep per group. */
    maxTestsPerGroup?: number | undefined;
    /** How many marker-group IDs to keep per group, for `--task-ids`. */
    maxGroupIds?: number | undefined;
}

const DEFAULT_MAX_TESTS = 20;
const DEFAULT_MAX_GROUP_IDS = 50;

/** The totals a ranking covers, so a caller can say what it filtered away. */
export interface ErrorRankingTotals {
    /** Occurrences in the groups that passed the filters. */
    matchedCount: number;
    /** Occurrences in the whole file, from walking every group. */
    fileCount: number;
    /** Distinct (test, message) groups that passed the filters. */
    matchedGroups: number;
}

/** A ranking: the rows, and the totals they were drawn from. */
export interface ErrorRanking {
    rows: ErrorGroup[];
    totals: ErrorRankingTotals;
}

/** Internal accumulator — integers plus a per-test map, nothing per occurrence. */
interface Accumulator {
    key: string;
    kind: string | null;
    text: string | null;
    file: string | null;
    line: number | null;
    component: string | null;
    count: number;
    /** testId -> occurrences. Its size is the exact `testCount`. */
    perTest: Map<number, number>;
    /**
     * component -> occurrences, for the row's component summary.
     *
     * A `Map` keyed on the component string rather than a per-occurrence list:
     * the widest row on the pinned mochitest file spans 153 components over
     * 2,281,087 occurrences, and the map holds 153 entries.
     */
    perComponent: Map<string, number>;
    groupIds: number[];
}

/**
 * Ranks a day's markers.
 *
 * One pass over the file's (test, message) groups. Messages are resolved once
 * each into a small cache rather than per group, because a message that appears
 * in 9,000 tests would otherwise be re-decoded 9,000 times.
 */
export function rankErrors(
    file: DecodedErrorsFile,
    options: ErrorRankingOptions = {}
): ErrorRanking {
    const grouping = options.grouping ?? 'location';
    const maxTests = options.maxTestsPerGroup ?? DEFAULT_MAX_TESTS;
    const maxGroupIds = options.maxGroupIds ?? DEFAULT_MAX_GROUP_IDS;

    const messageNeedle = options.message?.toLowerCase();
    const componentNeedle = options.component?.toLowerCase();
    const fileNeedle = options.file?.toLowerCase();

    // Resolving a message hits four string tables, so it is cached: the same
    // message is shared by every test that emitted it.
    const messageCache = new Map<number, DecodedMessage>();
    const messageOf = (messageId: number): DecodedMessage => {
        let decoded = messageCache.get(messageId);
        if (decoded === undefined) {
            decoded = file.messageAt(messageId);
            messageCache.set(messageId, decoded);
        }
        return decoded;
    };
    const testPathCache = new Map<number, string>();
    const pathOf = (testId: number): string => {
        let path = testPathCache.get(testId);
        if (path === undefined) {
            path = file.testPathAt(testId);
            testPathCache.set(testId, path);
        }
        return path;
    };

    const groups = new Map<string, Accumulator>();
    let matchedCount = 0;
    let fileCount = 0;
    let matchedGroups = 0;

    for (const group of file.groups()) {
        fileCount += group.totalCount;

        const message = messageOf(group.messageId);
        if (options.kind !== undefined && message.kind !== options.kind) {
            continue;
        }
        if (
            messageNeedle !== undefined &&
            !(message.text ?? '').toLowerCase().includes(messageNeedle)
        ) {
            continue;
        }
        if (
            componentNeedle !== undefined &&
            !(message.component ?? '').toLowerCase().includes(componentNeedle)
        ) {
            continue;
        }
        if (fileNeedle !== undefined && !(message.file ?? '').toLowerCase().includes(fileNeedle)) {
            continue;
        }
        const path = pathOf(group.testId);
        if (options.test !== undefined && !matchesTest(path, options.test)) {
            continue;
        }

        matchedCount += group.totalCount;
        matchedGroups += 1;

        const key = groupKey(grouping, message, path);
        let accumulator = groups.get(key);
        if (accumulator === undefined) {
            accumulator = {
                key,
                ...groupFields(grouping, message, path),
                count: 0,
                perTest: new Map(),
                perComponent: new Map(),
                groupIds: [],
            };
            groups.set(key, accumulator);
        }
        accumulator.count += group.totalCount;
        accumulator.perTest.set(
            group.testId,
            (accumulator.perTest.get(group.testId) ?? 0) + group.totalCount
        );
        if (grouping !== 'kind') {
            // `--group-by kind` is the one grouping with no component question:
            // its rows are "C++ warning" and "console.error", and every
            // component in the file appears under each. Accumulating there
            // would cost a hash per group to produce a summary reading
            // "428 components" on every row.
            const component = message.component ?? UNKNOWN_COMPONENT;
            accumulator.perComponent.set(
                component,
                (accumulator.perComponent.get(component) ?? 0) + group.totalCount
            );
        }
        if (accumulator.groupIds.length < maxGroupIds) {
            accumulator.groupIds.push(group.groupId);
        }
    }

    const rows: ErrorGroup[] = [];
    for (const accumulator of groups.values()) {
        rows.push({
            key: accumulator.key,
            kind: accumulator.kind,
            text: accumulator.text,
            file: accumulator.file,
            line: accumulator.line,
            component: accumulator.component,
            count: accumulator.count,
            testCount: accumulator.perTest.size,
            tests: [...accumulator.perTest]
                .sort((a, b) => b[1] - a[1])
                .slice(0, maxTests)
                .map(([testId, count]) => ({ testId, path: pathOf(testId), count })),
            components: sortComponents(accumulator.perComponent),
            groupIds: accumulator.groupIds,
        });
    }

    const sort = options.sort ?? 'occurrences';
    rows.sort((a, b) =>
        sort === 'tests'
            ? b.testCount - a.testCount || b.count - a.count
            : b.count - a.count || b.testCount - a.testCount
    );

    return { rows, totals: { matchedCount, fileCount, matchedGroups } };
}

// --- the component summary ------------------------------------------------
//
// This section is shared with `site/errors-view.ts`, which imports the rule
// rather than restating it. Both sides show the same summary on the same row,
// and `test/errors-parity.test.ts` asserts it — a check that means something
// only because the two sides reach the rule by different routes: the page walks
// its CSR run over the markers, the CLI accumulates a map while ranking. What
// must not be duplicated is the *decision*, because two copies of a threshold
// drift and the parity test would then be comparing two bugs.

/** What a message with no component recorded is called. `errors.html:298`. */
export const UNKNOWN_COMPONENT = 'Unknown';

/**
 * One component's share of a row.
 *
 * `count` is occurrences, not messages: a component that emitted the message
 * 30,856 times and one that emitted it once are not equally worth naming, and
 * counting messages would make them look identical.
 */
export interface ComponentShare {
    component: string;
    count: number;
}

/**
 * Orders a component map, biggest first.
 *
 * Ties are broken by component name, so the order is a function of the data
 * rather than of `Map` insertion order — which is the order the file's groups
 * happened to be walked in, and would make the leader of a tied row change when
 * the generator re-ordered its tables. **Measured on the pinned mochitest
 * 2026-08-03 file: 98 of the 1,302 multi-component rows have an exact tie for
 * the lead**, so this is not theoretical. Those same rows are the ones
 * `componentSummary` refuses to name a leader for.
 */
export function sortComponents(perComponent: ReadonlyMap<string, number>): ComponentShare[] {
    return [...perComponent]
        .map(([component, count]) => ({ component, count }))
        .sort((a, b) => b.count - a.count || a.component.localeCompare(b.component));
}

/**
 * The threshold at which one component is named as a row's leader.
 *
 * **A strict majority of the row's occurrences**, and both halves of that were
 * measured rather than picked.
 *
 * *Why a majority at all.* The two ends the product decision names are 98.7% of
 * 9 components (`TargetingContextRecorder: Could not get "addonsInfo"` on the
 * pinned xpcshell 2026-08-04 file, where `Firefox :: Nimbus Desktop Client` is
 * 30,856 of 31,271) and 17.2% of 61 (`uncaught exception: Object`, where the
 * leader holds 591 of 3,437). Any cut between those separates them, so the
 * question is what the cut *means*, and "more than half the occurrences came
 * from here" is the only statement about a leader that stays true as the
 * component count grows. A fixed share like 40% would name a leader on a
 * 61-way split where the other 60 components hold 60% between them.
 *
 * *Why strict.* On the pinned mochitest file **92 rows sit at exactly 50.0%**,
 * of which **72 are exact two-way ties** — 34 against 34. Naming one of two
 * tied components as the leader would report a coin flip as a finding, and
 * which one won would depend on `sortComponents`' tie-break rather than on the
 * data. `>` sends all 98 of that file's exact ties to the spread form; `>=`
 * would name a leader on every one.
 *
 * *What it does on the real files.* Of the 36 multi-component rows on the
 * pinned xpcshell 2026-08-04 file it names a leader on 29 and reports the
 * spread on 7; of the 1,302 on the pinned mochitest file, 1,022 and 280. The
 * 834 single-component xpcshell rows and 30,228 mochitest ones are unaffected —
 * a lone component is always named, with no "+N more".
 */
export function dominates(leaderCount: number, total: number): boolean {
    return leaderCount * 2 > total;
}

/**
 * The one-line component summary for a row, or `null` when it has none.
 *
 * Three shapes, and which one appears is the whole of the decision:
 *
 * | the row | reads |
 * | --- | --- |
 * | one component | `Firefox :: Nimbus Desktop Client` |
 * | several, one holding a strict majority | `Firefox :: Nimbus Desktop Client  +8 more` |
 * | several, none holding one | `61 components` |
 *
 * The spread form names no component **on purpose**. Its whole content is "do
 * not read a component off this row", and printing a leader beside that would
 * undo it — the reader would take the named one as the answer, which on the
 * 61-component row means attributing 3,437 occurrences to a component holding
 * 591 of them.
 *
 * `null` only for an empty list, which is `--group-by kind` — see the
 * accumulator. A message with **no component recorded** carries
 * `UNKNOWN_COMPONENT` and is summarized like any other, because "we do not
 * know" is an answer and a blank reads as a rendering fault.
 *
 * `shares` must be ordered, which `sortComponents` guarantees; the leader is
 * `shares[0]`.
 */
export function componentSummary(shares: readonly ComponentShare[]): string | null {
    if (shares.length === 0) {
        return null;
    }
    if (shares.length === 1) {
        return shares[0]!.component;
    }
    const total = shares.reduce((sum, share) => sum + share.count, 0);
    if (dominates(shares[0]!.count, total)) {
        return `${shares[0]!.component}  +${(shares.length - 1).toLocaleString()} more`;
    }
    return `${shares.length.toLocaleString()} components`;
}

/**
 * How many components a full breakdown lists before saying "and N more".
 *
 * The widest row on the pinned files spreads over **153** components (mochitest
 * 2026-08-03, `uncaught exception: Object`, 2,281,087 occurrences) and 61 on
 * the pinned xpcshell file. 153 lines is more than a browser tooltip or a
 * terminal can show, and letting either truncate it means the cut lands
 * somewhere neither this code nor the reader chose.
 *
 * Twelve fits and holds most of what there is to see. Measured on the widest
 * rows: the top twelve are **74.3%** of the 61-component xpcshell row and
 * **79.2%** and **79.1%** of the next two widest mochitest rows. The
 * 153-component row is the exception at **46.3%**, with the other 141 holding
 * 53.7% between them — an average of 8,693 each against the leader's 148,150,
 * so the tail is genuinely thin rather than hiding a second leader.
 */
export const MAX_BREAKDOWN_ROWS = 12;

/**
 * The full breakdown as lines of `component  count`, biggest first, truncated
 * at `MAX_BREAKDOWN_ROWS`.
 *
 * Shown on **both** the concentrated and the spread cases, because the question
 * the summary raises is the same either way — "which components, and how much
 * each" — and answering it only when the answer is boring would be backwards.
 *
 * The truncation is never silent: the tail line says how many components were
 * dropped **and how many occurrences they hold**, so the shown lines plus that
 * number still add up to the row's count.
 */
export function componentBreakdownLines(shares: readonly ComponentShare[]): string[] {
    const shown = shares.slice(0, MAX_BREAKDOWN_ROWS);
    const lines = shown.map((share) => `${share.component}  ${share.count.toLocaleString()}`);
    if (shares.length > shown.length) {
        const rest = shares.slice(shown.length);
        const restCount = rest.reduce((sum, share) => sum + share.count, 0);
        lines.push(
            `… and ${rest.length.toLocaleString()} more, ${restCount.toLocaleString()} occurrences`
        );
    }
    return lines;
}

/**
 * Whether a test path matches a `--test` argument.
 *
 * Exact path or directory prefix, so both
 * `--test netwerk/test/unit/test_URIFixup.js` and `--test netwerk/test/unit`
 * work. A bare substring match would make `--test unit` select half the tree,
 * which is not what someone naming a test means.
 */
export function matchesTest(path: string, wanted: string): boolean {
    if (path === wanted) {
        return true;
    }
    const prefix = wanted.endsWith('/') ? wanted : `${wanted}/`;
    return path.startsWith(prefix);
}

/**
 * The separator between the parts of a grouping key.
 *
 * A unit separator, written as an escape rather than as a literal control
 * character in the source. It used to be literal, which made it invisible in a
 * diff, unmatched by a textual search, and impossible to mutation-test — a
 * mutation swapping it for a colon could not even be applied. Named and
 * escaped, it is all three.
 *
 * It has to be a byte that cannot occur in the data. A message text can contain
 * anything — colons, numbers, newlines — so a printable separator lets two
 * different messages build the same key and silently merge into one row.
 */
const KEY_SEPARATOR = '\u001f';

/**
 * The stand-in for a field that is absent, as opposed to empty.
 *
 * A control character for the same reason, and load-bearing for the same
 * measurement: a message with no file and a message from a file named `""` are
 * different groups, and `FORMATS.md`'s messages carrying a line with **no
 * file** — 22 on one xpcshell day, 2,539 on a live mochitest one — must not
 * merge with each other merely because they share a line number.
 *
 * The empty string would not do: it makes an absent field indistinguishable
 * from an empty one, which is exactly the collision this prevents.
 */
const KEY_ABSENT = '\u0001';

/**
 * The key a message groups under.
 *
 * See `KEY_SEPARATOR` and `KEY_ABSENT` for why both are control characters and
 * why neither may be a printable byte.
 */
function groupKey(grouping: ErrorGrouping, message: DecodedMessage, path: string): string {
    const part = (value: string | number | null): string =>
        value === null ? KEY_ABSENT : String(value);
    switch (grouping) {
        case 'message':
            // Text alone, which is what `errors.html` used to do. Kept as an
            // option because "how much of this text is there in total" is a
            // real question, but not the default — see the module comment.
            return [part(message.kind), part(message.text)].join(KEY_SEPARATOR);
        case 'location':
            return [
                part(message.kind),
                part(message.text),
                part(message.file),
                part(message.line),
            ].join(KEY_SEPARATOR);
        case 'test':
            return path;
        case 'component':
            return part(message.component);
        case 'kind':
            return message.kind;
    }
}

/** The display fields a group carries, which depend on what it grouped by. */
function groupFields(
    grouping: ErrorGrouping,
    message: DecodedMessage,
    path: string
): Pick<ErrorGroup, 'kind' | 'text' | 'file' | 'line' | 'component'> {
    switch (grouping) {
        case 'message':
            // File and line vary within the group by construction, so they are
            // null rather than whichever one happened to be seen first.
            return {
                kind: message.kind,
                text: message.text,
                file: null,
                line: null,
                component: null,
            };
        case 'location':
            return {
                kind: message.kind,
                text: message.text,
                file: message.file,
                line: message.line,
                component: message.component,
            };
        case 'test':
            return { kind: null, text: path, file: null, line: null, component: null };
        case 'component':
            return {
                kind: null,
                text: null,
                file: null,
                line: null,
                component: message.component,
            };
        case 'kind':
            return { kind: message.kind, text: null, file: null, line: null, component: null };
    }
}

/**
 * The per-kind totals, as `CLI.md`'s second header line shows them.
 *
 * Straight from `metadata.markerCounts` — the whole point being that it costs
 * one file read rather than a pass — sorted loudest first, with the kind names
 * coming from the data.
 */
export function kindTotals(file: DecodedErrorsFile): { kind: string; count: number }[] {
    return Object.entries(file.markerCounts)
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}
