/**
 * Treeherder's sheriff-annotated intermittent failures, and the Bugzilla lookup
 * that makes them readable.
 *
 * The data behind <https://treeherder.mozilla.org/intermittent-failures/>: a CI
 * failure a sheriff judged worth tracking and attached a bug number to. Not an
 * aggregate computed from logs — a human judgement, which is what makes a
 * burndown built on it assignable.
 *
 * `/api/failures/` ranks bugs by annotation count; `/api/failuresbybug/` returns
 * one bug's occurrences. Both take `startday`, `endday` and `tree`; that is the
 * whole vocabulary. Three consequences:
 *
 * **No harness parameter exists**, so `/failures/` ranks every harness at once
 * and nothing in its response identifies a mochitest bug. Answering "the top N
 * mochitest intermittents" means ranking tree-wide then reading `test_suite`
 * from `/failuresbybug/`, one request per candidate bug.
 *
 * **`/failures/` carries no bug summary and no test name**, only `bug_id` and
 * `bug_count`. The summary comes from Bugzilla, batched; the test name from
 * `lines` on the per-bug rows.
 *
 * **`bug_id` can be null** — the group of annotations made without naming a bug,
 * regularly the largest one. Nothing can be looked up or drilled into for it, so
 * callers report it as a count rather than dropping it.
 */

import type { FetchLike } from './http.ts';
import { TREEHERDER_ROOT } from './treeherder.ts';

/** Bugzilla's REST origin. */
export const BUGZILLA_ROOT = 'https://bugzilla.mozilla.org';

/**
 * One row of `/api/failures/`: a bug and how many annotations it has.
 *
 * `bugId` is `null` for the no-bug group. See the module comment.
 */
export interface BugFailureCount {
    bugId: number | null;
    count: number;
}

/** One row of `/api/failuresbybug/`, as `FailuresByBugSerializer` returns it. */
export interface BugOccurrence {
    bugId: number | null;
    /**
     * The job type with the platform and build type removed:
     * `mochitest-browser-chrome-39`, `xpcshell-spi-nw-2`. The **suite**, not a
     * test path — the test name, where there is one, is inside `lines`.
     */
    testSuite: string;
    platform: string;
    buildType: string;
    revision: string;
    tree: string;
    /** `YYYY-MM-DD HH:MM:SS`, as the API formats it. */
    pushTime: string;
    machineName: string;
    /** `"unknown"` when Treeherder has no Taskcluster metadata for the job. */
    taskId: string;
    /** The job's `TEST-UNEXPECTED-FAIL` log lines. Empty when none were kept. */
    lines: string[];
}

/** Thrown when Treeherder or Bugzilla answers with something unreadable. */
export class IntermittentsError extends Error {
    readonly url: string;
    readonly status: number | undefined;

    constructor(message: string, url: string, status?: number) {
        super(message);
        this.name = 'IntermittentsError';
        this.url = url;
        this.status = status;
    }
}

/** What `intermittentsClient` needs. */
export interface IntermittentsOptions {
    /** How requests are made. Required — `lib/` has no global `fetch`. */
    fetch: FetchLike;
    /** Overrides Treeherder's origin, for a test or a staging instance. */
    root?: string | undefined;
    /** Overrides Bugzilla's origin, for a test. */
    bugzillaRoot?: string | undefined;
}

/** A date range, both ends inclusive, both `YYYY-MM-DD`. */
export interface DayRange {
    /** `startday`. */
    start: string;
    /** `endday`. Treeherder extends it to the end of that day (`get_end_of_day`). */
    end: string;
}

/** The two queries this module makes, over one Treeherder deployment. */
export interface IntermittentsClient {
    /** `/api/failures/`: every annotated bug in the range, count-descending. */
    rankBugs(tree: string, range: DayRange): Promise<BugFailureCount[]>;
    /** `/api/failuresbybug/`: every occurrence of one bug in the range. */
    occurrencesOfBug(tree: string, range: DayRange, bug: number): Promise<BugOccurrence[]>;
    /** Bugzilla summaries for a set of bug numbers, batched. */
    bugSummaries(bugs: readonly number[]): Promise<Map<number, string>>;
}

/**
 * The repo groups `tree` accepts besides a repository name.
 *
 * Mirrors Treeherder's `REPO_GROUPS`, so a typo can be answered with the valid
 * group names rather than with its 400.
 */
export const TREE_GROUPS: readonly string[] = ['trunk', 'firefox-releases', 'comm-releases'];

/** Builds a client over an injected fetch. */
export function intermittentsClient(options: IntermittentsOptions): IntermittentsClient {
    const root = options.root ?? TREEHERDER_ROOT;
    const bugzillaRoot = options.bugzillaRoot ?? BUGZILLA_ROOT;

    async function getJson<T>(url: string): Promise<T> {
        let response;
        try {
            response = await options.fetch(url);
        } catch (error) {
            throw new IntermittentsError(
                `request failed: ${(error as Error).message}`,
                url
            );
        }
        if (!response.ok) {
            throw new IntermittentsError(`HTTP ${response.status}`, url, response.status);
        }
        const text = new TextDecoder().decode(await response.arrayBuffer());
        try {
            return JSON.parse(text) as T;
        } catch (error) {
            throw new IntermittentsError(
                `response is not valid JSON: ${(error as Error).message}`,
                url
            );
        }
    }

    return {
        async rankBugs(tree: string, range: DayRange): Promise<BugFailureCount[]> {
            const url = `${root}/api/failures/?${rangeQuery(tree, range)}`;
            const rows = await getJson<{ bug_id: number | null; bug_count: number }[]>(url);
            return rows.map((row) => ({ bugId: row.bug_id, count: row.bug_count }));
        },

        async occurrencesOfBug(
            tree: string,
            range: DayRange,
            bug: number
        ): Promise<BugOccurrence[]> {
            const url = `${root}/api/failuresbybug/?${rangeQuery(tree, range)}&bug=${bug}`;
            const rows = await getJson<
                {
                    bug_id: number | null;
                    test_suite: string;
                    platform: string;
                    build_type: string;
                    revision: string;
                    tree: string;
                    push_time: string;
                    machine_name: string;
                    task_id: string;
                    lines: string[];
                }[]
            >(url);
            return rows.map((row) => ({
                bugId: row.bug_id,
                testSuite: row.test_suite,
                platform: row.platform,
                buildType: row.build_type,
                revision: row.revision,
                tree: row.tree,
                pushTime: row.push_time,
                machineName: row.machine_name,
                taskId: row.task_id,
                lines: row.lines,
            }));
        },

        async bugSummaries(bugs: readonly number[]): Promise<Map<number, string>> {
            const found = new Map<number, string>();
            for (const batch of chunk(bugs, BUG_BATCH_SIZE)) {
                if (batch.length === 0) {
                    continue;
                }
                const url =
                    `${bugzillaRoot}/rest/bug?id=${batch.join(',')}` +
                    `&include_fields=id,summary`;
                const data = await getJson<{ bugs?: { id: number; summary: string }[] }>(url);
                for (const bug of data.bugs ?? []) {
                    found.set(bug.id, bug.summary);
                }
            }
            return found;
        },
    };
}

/**
 * How many bug numbers go in one Bugzilla request.
 *
 * Bounded by URL length rather than by the API, which takes a comma-joined `id`.
 */
export const BUG_BATCH_SIZE = 100;

/** The query string all three intermittents endpoints share. */
function rangeQuery(tree: string, range: DayRange): string {
    return (
        `startday=${encodeURIComponent(range.start)}` +
        `&endday=${encodeURIComponent(range.end)}` +
        `&tree=${encodeURIComponent(tree)}`
    );
}

/** Splits into batches of at most `size`. */
function chunk<T>(items: readonly T[], size: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        batches.push(items.slice(i, i + size));
    }
    return batches;
}

/**
 * Which harness an **occurrence** ran under, from its job name, or `null`.
 *
 * Deliberately not the ranked list's classifier, which reads a test path out of
 * the bug summary. That is the right evidence for "is this *bug* a mochitest
 * bug", because a summary names one test and a bug spans many jobs. Here the
 * question is different — "did *this job* run mochitest" — and the row carries
 * the job name that answers it directly, which is better evidence than
 * re-deriving it from the bug.
 *
 * The harness is a `-`-delimited word rather than a prefix, because Treeherder
 * computes `test_suite` by subtracting the platform and build type out of the
 * job name: an ASAN mochitest arrives as `opt-mochitest-chrome-1proc` and an
 * Android one as `geckoview-mochitest-plain-3`. `gtest-1proc` and
 * `opt-gtest-1proc` are neither harness, which is why the boundary matters in
 * both directions.
 *
 * `null` for a job that is neither — talos, reftest, wpt, a build task — and
 * callers report how many rather than dropping them.
 */
export function harnessOfOccurrence(testSuite: string): 'mochitest' | 'xpcshell' | null {
    if (/(^|-)mochitest(-|$)/.test(testSuite)) {
        return 'mochitest';
    }
    return /(^|-)xpcshell(-|$)/.test(testSuite) ? 'xpcshell' : null;
}

/**
 * A `test_suite` value with its trailing chunk number removed.
 *
 * `mochitest-browser-chrome-2` and `mochitest-browser-chrome-11` are the same
 * configuration run in different chunks, so grouping the raw values splits one
 * answer into a dozen rows. Variant suffixes are *not* numbers — `-no-nv`,
 * `-swr`, `-msix`, `-spi`, `-nofis` — so they survive, which is the distinction
 * that matters: `-no-nv-7` versus `-7` is two configurations, `-7` versus `-8`
 * is one.
 *
 * Not `lib/model/job-name.ts`'s `stripChunkSuffix`, and deliberately: that one
 * anchors the strip after the `/` that separates the build type, because a
 * platform can end in digits and stripping the whole name would eat part of it.
 * Treeherder has already removed the platform and build type from `test_suite`
 * (`TestSuiteField`), so there is no `/` and no platform left to damage — but
 * that also means the shared function returns these unchanged. Loosening it
 * would weaken the guarantee it makes for job names that still carry a
 * platform, so this is its own rule for its own field.
 */
export function stripSuiteChunk(testSuite: string): string {
    return testSuite.replace(/-\d+$/, '');
}

/**
 * Path-shaped tokens in a bug summary, in the order they appear.
 *
 * The first half of classifying a bug. Sheriffs name the failing test in the
 * summary — `Frequent browser/.../browser_tab_preview.js | single tracking bug`
 * — so the path is there to be read, but *only a caller that checks it against
 * the real test data may call the result a mochitest*: this returns candidates,
 * not verdicts. Measured over a live top-80 ranking, 48 summaries yield a token
 * and 8 of those are not tests this tool knows (wpt, a crashtest, a marionette
 * `.py`, the xpcshell harness script itself).
 *
 * The extension list is what keeps a token path-shaped rather than merely
 * slash-separated: a summary routinely carries `gfx/wr/...` source locations and
 * `/_mozilla/webgpu/cts/...` fragments, and neither is a file.
 */
export function testPathCandidates(summary: string): string[] {
    const found: string[] = [];
    for (const match of summary.matchAll(TEST_PATH_TOKEN)) {
        const path = match[1]!;
        if (!found.includes(path)) {
            found.push(path);
        }
    }
    return found;
}

/**
 * A `dir/.../file.ext` token with a test-file extension.
 *
 * `.py` and `.toml` are in the list because a summary can legitimately name a
 * manifest or a marionette test; both are rejected later by the check against
 * the real test paths, which is where "is this a test" is actually decided.
 */
const TEST_PATH_TOKEN = /\b((?:[\w.+-]+\/)+[\w.+-]+\.(?:js|mjs|html|xhtml|xul|sjs|py|toml|ini))\b/g;

/**
 * The bug summary with its triage prefix and the test path removed.
 *
 * What is left is the part that says something the other columns do not. A
 * summary is `<prefix> <path> | <message>`, and both of the first two are
 * already columns of their own, so showing them again spends the width that
 * the message needs — the message is what distinguishes two bugs on the same
 * test.
 *
 * Returns an empty string when nothing is left, which is the common case for a
 * tracking bug whose whole summary is the path.
 */
export function summaryRemainder(summary: string, path: string | null): string {
    let rest = summary.replace(TRIAGE_PREFIX, '');
    if (path !== null) {
        rest = rest.replace(path, '');
    }
    return rest.replace(/^[\s|:-]+/, '').replace(/[\s|]+$/, '').trim();
}

/**
 * The triage words a sheriff puts in front of a summary.
 *
 * Repeated rather than alternated once: `Perma [tier 2] ` and
 * `High frequency intermittent ` both occur, so one pass over a single
 * alternation would leave the second word behind.
 */
const TRIAGE_PREFIX =
    /^(?:(?:perma|frequent|intermittent|high frequ[en]*cy|\[meta\]|\[tier \d\]|\[?not ?a ?leak\]?)[\s|:-]*)+/i;

/**
 * The test path a `TEST-UNEXPECTED-FAIL` line names, or `null`.
 *
 * The only place a per-test name appears in this API — `test_suite` is the suite
 * and chunk — so without it a "top intermittents" list names chunks. The format
 * is `… TEST-UNEXPECTED-FAIL | <path> | <message>`. `null` for a line with no
 * path field, which a `[taskcluster:error]` genuinely has.
 */
export function testPathOfLine(line: string): string | null {
    const marker = line.indexOf('TEST-UNEXPECTED-FAIL');
    if (marker === -1) {
        return null;
    }
    const fields = line.slice(marker).split('|');
    const candidate = fields[1]?.trim();
    if (candidate === undefined || candidate.length === 0) {
        return null;
    }
    return candidate;
}
