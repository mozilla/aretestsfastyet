/**
 * `failures.html`'s **view model**: what is left of the page's decisions once
 * the drill-down it shares with `crashes.html` has been factored out.
 *
 * Almost everything structural lives in `site/drilldown-view.ts`. What is only
 * true of the failures page:
 *
 * - the row unit is a **failure message string**, and `'(no failure message)'`
 *   is a real, rankable row — the *largest* one on the pinned snapshot;
 * - the search **rewrites the counts on the rows**, so the same row shows a
 *   smaller number under a search;
 * - a test row can carry a **bug-filing button**, which needs the test's
 *   Bugzilla component and the file's date range;
 * - the message itself is **linkified** to Searchfox when it starts with a
 *   `[file : line]` prefix.
 *
 * ## This file must stay DOM-free
 *
 * Enforced indirectly: `test/failures-view.test.ts` imports it, the root project
 * compiles `test/**`, and the root project has no DOM lib.
 */

import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import {
    type GroupNode,
    type GroupRow,
    type PathNode,
    type SortState,
    buildGroups,
    failureExtractor,
    rewriteGroupsBySearch,
    rowsOf,
    sortRows,
} from './drilldown-view.ts';

/** The word the per-test tooltip uses. `failures.html:818`. */
export const FAILURE_NOUN = 'message';

/**
 * Builds the message tree for a loaded file.
 *
 * `withComponent` is on: this page's bug button needs the test's Bugzilla
 * component (`failures.html:243`), and it is the only one of the two pages that
 * does.
 */
export function buildFailureGroups(
    file: DecodedTimingFile,
    startTime: number
): Map<string, GroupNode> {
    return buildGroups(file, startTime, failureExtractor, { withComponent: true });
}

/**
 * The ranked, searched list of message rows, and the map the expansions read.
 *
 * ## Why the map comes back with the rows
 *
 * `failures.html` keeps a module-scope `filteredFailureData` (`:101`, written at
 * `:599`) and every expansion reads the subtree out of *it* rather than out of
 * the unfiltered data (`:957`, `:1003`, `:1051`). That indirection is what makes
 * the search consistent: expanding a row under a search shows only the tests
 * that matched, and the counts on the row are the counts of what expanding it
 * will reveal.
 *
 * `crashes.html` has no equivalent — it expands from `currentData.crashData`
 * (`:858`), the unfiltered tree — which is the other half of the two pages'
 * different search semantics.
 *
 * Returning the map with the rows rather than storing it in a module variable
 * keeps the whole thing a function of its inputs, which is what lets a node test
 * drive a search and assert on the subtree it produced.
 */
export interface FailureList {
    rows: GroupRow[];
    /** message → the subtree that row expands to. Search-aware. */
    expandable: Map<string, Map<string, PathNode>>;
}

export function failureList(
    groups: Map<string, GroupNode>,
    searchTerm: string,
    sort: SortState
): FailureList {
    const rewritten = rewriteGroupsBySearch(rowsOf(groups), searchTerm);
    // Built before the sort, exactly as upstream does (`failures.html:599` sits
    // between the filter and the sort). It makes no difference — a Map keyed by
    // message does not care about row order — and the ordering is preserved so
    // that a reader comparing the two files does not have to wonder whether it
    // did.
    const expandable = new Map(rewritten.map((row) => [row.key, row.paths]));
    return { rows: sortRows(rewritten, sort), expandable };
}

/**
 * Whether the Searchfox link on a message should be built, and where it splits.
 *
 * `linkifyFailureMessage` (`common-ui.js:22`) links only the `[file : line]`
 * prefix of a message, leaving the rest as text — and it decides whether to link
 * at all by testing the *URL* for a `#`, which `getSearchfoxUrl`
 * (`common-links.js:104`) only adds when the message matches
 * `/^\[[^\] :]+ : (\d+)\]/`.
 *
 * Reproduced here as a decision rather than as markup so it can be tested
 * without a DOM, and so the renderer can build one anchor and one text node
 * instead of parsing a string. The regex is `common-links.js`'s, character for
 * character.
 *
 * The split point is `message.indexOf(']') + 1`, which is upstream's and is
 * *not* the same as the end of the match: for `[a : 1] x] y` the regex matches
 * through index 6 and `indexOf(']')` also finds index 6, but the two would
 * disagree if a `]` preceded the prefix — which the regex's `[^\] :]+` makes
 * impossible. So they agree for every message that links at all.
 */
export interface MessageLink {
    /** The `[file : line]` part, which becomes the anchor's text. */
    linked: string;
    /** Everything after it, plain text. */
    rest: string;
}

const SEARCHFOX_LINE = /^\[[^\] :]+ : (\d+)\]/;

/**
 * Splits a message into its linked prefix and its remainder, or `null` when the
 * whole message is plain text.
 */
export function messageLink(message: string): MessageLink | null {
    if (!SEARCHFOX_LINE.test(message)) {
        return null;
    }
    const end = message.indexOf(']') + 1;
    return { linked: message.slice(0, end), rest: message.slice(end) };
}

/**
 * The test whose path the message's Searchfox link points at.
 *
 * `failures.html:659-668`: the test with the most occurrences of this message,
 * across every path in the row. Ties go to the first one the walk found, since
 * the comparison is a strict `>`.
 *
 * Returns `null` for a row with no tests, which `rewriteGroupsBySearch` cannot
 * produce — it drops a row whose subtree emptied — but which a caller holding a
 * hand-built row could.
 */
export function mostFrequentTestPath(paths: Map<string, PathNode>): string | null {
    let best: string | null = null;
    let bestCount = 0;
    for (const path of paths.values()) {
        for (const test of path.tests.values()) {
            if (test.totalCount > bestCount) {
                bestCount = test.totalCount;
                best = `${path.dirPath}/${test.testName}`;
            }
        }
    }
    return best;
}

/**
 * Whether a test row gets a 🐛 bug-filing button.
 *
 * `failures.html:751`: `component?.includes(' :: ')`. A component that is not in
 * `Product :: Component` form cannot be split into the two Bugzilla fields, so
 * the button is omitted rather than filed against a product that does not exist.
 */
export function hasBugButton(component: string | null | undefined): boolean {
    return component !== null && component !== undefined && component.includes(' :: ');
}
