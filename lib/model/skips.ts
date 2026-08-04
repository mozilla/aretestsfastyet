/**
 * `run-if` vs `skip-if` semantics, and the one structural choice the pages
 * make differently.
 *
 * A skipped test carries a message naming the manifest annotation that skipped
 * it — `skip-if: os == "win"` or `run-if: os == "linux"`. The two mean
 * different things and the dashboards agree on the distinction:
 *
 * - **`skip-if`** — the test *should* run here but is disabled, usually
 *   because it is broken or unreliable. This is a skip worth reporting; it is
 *   work someone owes.
 * - **`run-if`** — the test is explicitly scoped to some other platform. It
 *   not running here is the annotation working as intended, not a problem.
 *   `issues.html:641` says so in the UI.
 * - **no message** — every site counts these as skips. Not because anyone
 *   decided to: `msg?.startsWith('run-if')` is `undefined` for a null message,
 *   which is falsy, so `perma-fails.html:511`, `variant.html:575` and
 *   `test.html:2642` fall through to the counting path. That behaviour is
 *   preserved here, and made explicit rather than incidental — a skip whose
 *   reason was not recorded is still a skip, and dropping it would understate
 *   the count.
 *
 * ## The real divergence is structural
 *
 * An earlier draft of `PLAN.md` claimed the sites disagreed about no-message
 * skips. They do not. The genuine difference is **which array they iterate**,
 * and `PLAN.md` §1 states it precisely: one group iterates `messageIds`, the
 * other iterates `jobNameIds` and adds `getCountAtIndex(...)`, and the two
 * "diverge only when an entry's count is not 1".
 *
 * | site | iterates | adds per entry |
 * | --- | --- | --- |
 * | `xpcshell-timings.html:666` | `messageIds` | **1** (`skipCount++`) |
 * | `common-test-data.js:303` | `messageIds` | `getCountAtIndex(...)` |
 * | `perma-fails.html:504`, `test.html:2637`, `variant.html:575` | `jobNameIds` | `getCountAtIndex(...)` |
 *
 * Note which site is where. `common-test-data.js:303` iterates `messageIds`
 * like `xpcshell-timings.html` but adds `getCountAtIndex(statusGroup, i)`, so
 * it already counts **runs** — it is evidence *for* the rule below, not
 * against it. **`xpcshell-timings.html:666` is the only site that counts
 * entries.** An earlier version of this comment put both in the per-entry row,
 * which overstated the divergence as two sites when it is one.
 *
 * The per-entry rule is wrong, not merely different: an entry in a `counts` or
 * `skip-counts` group is a *bucket* of runs, and counting it as one run
 * answers "how many distinct (day, job, message) buckets were there" while
 * claiming to answer "how many runs were skipped". This module counts runs,
 * which is what every caller's label says, and what four of the five sites
 * already do.
 *
 * The gap is large and depends on how much a file buckets, so no single
 * multiplier describes it. Measured over whole published files, counting
 * non-`run-if` skips:
 *
 * | file | entries | runs | ratio |
 * | --- | --- | --- | --- |
 * | `xpcshell-issues.json` | 27,024 | 2,166,688 | **80.2×** |
 * | `mochitest-issues.json` | 118,709 | 8,893,259 | 74.9× |
 * | `xpcshell-00.json` | 5,085 | 37,774 | 7.4× |
 * | `mochitest-00.json` | 13,982 | 128,314 | 9.2× |
 *
 * The 64-bucket files split the same runs across 64 files, so each holds more,
 * smaller buckets and the ratio is an order of magnitude lower. A test
 * asserting a ratio therefore has to name the file it measured.
 */

import type { StatusEntry } from '../formats/status-entries.ts';

/** Why a test did not run, as far as the message says. */
export type SkipReason =
    /** `skip-if:` — the test is disabled here. Counted as a skip. */
    | 'skip-if'
    /** `run-if:` — the test is scoped elsewhere. Not counted as a skip. */
    | 'run-if'
    /** A message that is neither. Counted, since it is not a `run-if`. */
    | 'other'
    /** No message recorded. Counted — see the module comment. */
    | 'unrecorded';

/**
 * Classifies a skip message.
 *
 * `undefined` and `null` both mean "no message": `undefined` is a group with
 * no `messageIds` array at all, `null` an entry whose ID was null. Neither
 * records a reason, so both are `unrecorded` and both are counted.
 */
export function skipReason(message: string | null | undefined): SkipReason {
    if (message === null || message === undefined) {
        return 'unrecorded';
    }
    if (message.startsWith('run-if')) {
        return 'run-if';
    }
    if (message.startsWith('skip-if')) {
        return 'skip-if';
    }
    return 'other';
}

/**
 * Whether a skip with this message counts as a skip worth reporting.
 *
 * Everything except `run-if`. This is the predicate the eight sites spell as
 * `!msg?.startsWith('run-if')`, with the null-message behaviour intentional
 * rather than a side effect of optional chaining.
 */
export function countsAsSkip(message: string | null | undefined): boolean {
    return skipReason(message) !== 'run-if';
}

/**
 * Strips the `skip-if: ` prefix for display.
 *
 * Every page that shows a skip message does this (`issues.html:1679`,
 * `test.html:927`, and five more), because the prefix is the same on every
 * message and the condition after it is the informative part.
 */
export function displaySkipMessage(message: string): string {
    return message.replace(/^skip-if:\s*/, '');
}

/** A skip total, split by whether the reason was recorded. */
export interface SkipCounts {
    /** Runs skipped for a reason that is not `run-if`. The reportable total. */
    skipped: number;
    /** Runs skipped by a `run-if` annotation — excluded from `skipped`. */
    runIf: number;
    /** Of `skipped`, the runs whose skip recorded no message at all. */
    unrecorded: number;
}

/**
 * Totals skipped runs over the entries of a SKIP status group.
 *
 * Counts **runs**, using each entry's `count`, which is the structural choice
 * the module comment argues for. Iterating the iterator's entries is what
 * makes the choice unavoidable: an entry knows how many runs it stands for, so
 * there is no longer a `messageIds` array sitting there inviting one-per-entry
 * counting.
 */
export function countSkips(entries: Iterable<StatusEntry>): SkipCounts {
    const counts: SkipCounts = { skipped: 0, runIf: 0, unrecorded: 0 };
    for (const entry of entries) {
        const reason = skipReason(entry.message);
        if (reason === 'run-if') {
            counts.runIf += entry.count;
            continue;
        }
        counts.skipped += entry.count;
        if (reason === 'unrecorded') {
            counts.unrecorded += entry.count;
        }
    }
    return counts;
}

/**
 * Totals skipped runs per skip message, for the "why is this skipped here"
 * view.
 *
 * Keyed by the display form, since that is what a caller shows and two
 * messages differing only in the prefix are the same reason. `run-if` entries
 * are excluded, consistent with `countSkips`; entries with no message are
 * grouped under `null`, which keeps them countable without inventing a label
 * for them.
 */
export function skipMessageCounts(entries: Iterable<StatusEntry>): Map<string | null, number> {
    const byMessage = new Map<string | null, number>();
    for (const entry of entries) {
        if (skipReason(entry.message) === 'run-if') {
            continue;
        }
        const key =
            entry.message === null || entry.message === undefined
                ? null
                : displaySkipMessage(entry.message);
        byMessage.set(key, (byMessage.get(key) ?? 0) + entry.count);
    }
    return byMessage;
}
