/**
 * Tree-wide triage: what is failing, across every test in a file.
 *
 * Behind `fx-tests issues`. Where `test-stats.ts` answers about one test, this
 * walks every test in the file once and reports the ones that are not clean,
 * grouped however the caller asks.
 *
 * ## One pass, integer accumulators
 *
 * `PLAN.md` §4 is specific about this: aggregate in a single pass over
 * integer-indexed arrays rather than materializing per-occurrence objects. A
 * 21-day aggregate holds ~40M xpcshell runs and ~172M mochitest ones, so an
 * object per run is not viable. Each test contributes one row with six
 * counters, and rows are dropped as soon as they are known to be uninteresting.
 *
 * ## What "the population" is, and why this file will not mix families
 *
 * `FORMATS.md` measures that `issues.json`, `issues-with-taskids.json` and the
 * 64 bucket files are three encodings of the *same* 21 days: adding their
 * totals multiplies the population by the number of encodings, and an earlier
 * revision of that document quoted a figure 4× too large by doing exactly
 * that. Two agents have made the same mistake.
 *
 * The defence here is structural rather than documentary: every function takes
 * **one** `DecodedTimingFile`. There is no parameter to pass a second file
 * through, so there is no summing across families to get wrong. A caller that
 * wants both must call twice and compare, which is the operation that makes
 * sense — and even then, `FORMATS.md` now measures that the daily files and the
 * aggregates disagree on job membership as well as on skips, so the comparison
 * is not apples to apples either.
 */

import type { DecodedTimingFile } from '../formats/decode.ts';
import { classifyStatus } from '../model/status.ts';
import { skipReason } from '../model/skips.ts';
import { inDayRange } from './test-stats.ts';

/** One test's tree-wide row. */
export interface IssueRow {
    testId: number;
    fullPath: string;
    directory: string;
    component: string | null;
    /** Runs that reached a verdict. */
    runCount: number;
    passCount: number;
    failCount: number;
    timeoutCount: number;
    crashCount: number;
    expectedFailCount: number;
    /** Skipped runs, `run-if` excluded. */
    skipCount: number;
    /** `(fail + timeout + crash) / runCount * 100`, or 0 when nothing ran. */
    failRate: number;
}

/** Which non-passing outcomes a query is interested in. */
export type IssueType = 'fail' | 'timeout' | 'crash' | 'skip';

/** Options for `findIssues`. */
export interface IssuesOptions {
    /** Only tests whose path starts with this. `CLI.md`'s `--path`. */
    pathPrefix?: string | undefined;
    /** Only tests whose component contains this, case-insensitively. */
    component?: string | undefined;
    /**
     * Which outcomes make a test interesting. Default: all the non-passing
     * ones except skip, since a skipped test is not a failing one and
     * `fx-tests skips` is its own command.
     */
    types?: readonly IssueType[] | undefined;
    /** Drop tests below this failure rate, in percent. */
    minRate?: number | undefined;
    /** Drop tests with fewer than this many matching occurrences. */
    minCount?: number | undefined;
    /** Restrict to a day range, as absolute day indices. Both ends inclusive. */
    dayRange?: { from: number; to: number } | undefined;
}

const DEFAULT_TYPES: readonly IssueType[] = ['fail', 'timeout', 'crash'];

/**
 * Every test in the file with a non-passing outcome, sorted by descending
 * failure rate.
 *
 * Sorting is by rate rather than by count because a count ranks the tests that
 * run most, not the ones that are worst — `CLI.md` offers `--sort count` for
 * when the opposite is wanted, and that is the caller's re-sort of this array.
 */
export function findIssues(
    file: DecodedTimingFile,
    options: IssuesOptions = {}
): IssueRow[] {
    const types = new Set(options.types ?? DEFAULT_TYPES);
    const rows: IssueRow[] = [];

    for (let testId = 0; testId < file.testCount; testId++) {
        const identity = file.testAt(testId);
        if (options.pathPrefix !== undefined && !identity.fullPath.startsWith(options.pathPrefix)) {
            continue;
        }
        if (options.component !== undefined) {
            const component = identity.component;
            if (
                component === null ||
                !component.toLowerCase().includes(options.component.toLowerCase())
            ) {
                continue;
            }
        }

        const row: IssueRow = {
            testId,
            fullPath: identity.fullPath,
            directory: identity.directory,
            component: identity.component,
            runCount: 0,
            passCount: 0,
            failCount: 0,
            timeoutCount: 0,
            crashCount: 0,
            expectedFailCount: 0,
            skipCount: 0,
            failRate: 0,
        };

        for (const entry of file.runsOfTest(testId)) {
            if (!inDayRange(entry.day, options.dayRange)) {
                continue;
            }
            switch (classifyStatus(entry.status).kind) {
                case 'pass':
                    row.passCount += entry.count;
                    break;
                case 'fail':
                    row.failCount += entry.count;
                    break;
                case 'timeout':
                    row.timeoutCount += entry.count;
                    break;
                case 'crash':
                    row.crashCount += entry.count;
                    break;
                case 'expected-fail':
                    row.expectedFailCount += entry.count;
                    break;
                case 'skip':
                    if (skipReason(entry.message) !== 'run-if') {
                        row.skipCount += entry.count;
                    }
                    break;
                case 'unknown':
                    break;
            }
        }

        row.runCount =
            row.passCount +
            row.failCount +
            row.timeoutCount +
            row.crashCount +
            row.expectedFailCount;
        const nonPass = row.failCount + row.timeoutCount + row.crashCount;
        row.failRate = row.runCount > 0 ? (nonPass / row.runCount) * 100 : 0;

        let matched = 0;
        if (types.has('fail')) matched += row.failCount;
        if (types.has('timeout')) matched += row.timeoutCount;
        if (types.has('crash')) matched += row.crashCount;
        if (types.has('skip')) matched += row.skipCount;
        if (matched === 0) {
            continue;
        }
        if (options.minCount !== undefined && matched < options.minCount) {
            continue;
        }
        if (options.minRate !== undefined && row.failRate < options.minRate) {
            continue;
        }
        rows.push(row);
    }

    rows.sort((a, b) => b.failRate - a.failRate || a.fullPath.localeCompare(b.fullPath));
    return rows;
}

/** A group of issue rows sharing a key. */
export interface IssueGroup {
    /** The component, directory, or whatever the rows were grouped by. */
    key: string;
    /** How many distinct tests are in the group. */
    testCount: number;
    runCount: number;
    failCount: number;
    timeoutCount: number;
    crashCount: number;
    skipCount: number;
    failRate: number;
}

/**
 * Groups issue rows by component or directory.
 *
 * `CLI.md`'s `--group-by component|directory`. Grouping by *message* is a
 * different operation — it needs the messages, which a row does not carry —
 * and lives in `failures.ts`.
 */
export function groupIssues(
    rows: Iterable<IssueRow>,
    by: 'component' | 'directory'
): IssueGroup[] {
    const groups = new Map<string, IssueGroup>();
    for (const row of rows) {
        const key = by === 'component' ? (row.component ?? '(no component)') : row.directory;
        let group = groups.get(key);
        if (group === undefined) {
            group = {
                key,
                testCount: 0,
                runCount: 0,
                failCount: 0,
                timeoutCount: 0,
                crashCount: 0,
                skipCount: 0,
                failRate: 0,
            };
            groups.set(key, group);
        }
        group.testCount += 1;
        group.runCount += row.runCount;
        group.failCount += row.failCount;
        group.timeoutCount += row.timeoutCount;
        group.crashCount += row.crashCount;
        group.skipCount += row.skipCount;
    }
    const out = [...groups.values()];
    for (const group of out) {
        const nonPass = group.failCount + group.timeoutCount + group.crashCount;
        group.failRate = group.runCount > 0 ? (nonPass / group.runCount) * 100 : 0;
    }
    out.sort((a, b) => b.failRate - a.failRate || a.key.localeCompare(b.key));
    return out;
}

/** What is skipped where — behind `fx-tests skips`. */
export interface SkipRow {
    testId: number;
    fullPath: string;
    directory: string;
    component: string | null;
    /** Skipped runs, `run-if` excluded unless `includeRunIf`. */
    skipCount: number;
    /** Skip conditions in display form, with counts. */
    messages: Map<string, number>;
    /** Configurations the test was skipped on, where the file attributes them. */
    jobNames: Set<string>;
}

/** Options for `findSkips`. */
export interface SkipsOptions {
    pathPrefix?: string | undefined;
    component?: string | undefined;
    /**
     * Keep `run-if` skips too. `CLI.md`'s `--include-run-if`.
     *
     * Off by default because a `run-if` means the test is scoped to another
     * platform, so it not running here is the annotation working rather than
     * something disabled. Note the asymmetry `FORMATS.md` measures: on a
     * 21-day aggregate this flag changes nothing at all, because the generator
     * already dropped them, while on a daily file it changes the count by up
     * to 2.7×.
     */
    includeRunIf?: boolean | undefined;
    dayRange?: { from: number; to: number } | undefined;
}

/** Every skipped test in the file, sorted by descending skip count. */
export function findSkips(file: DecodedTimingFile, options: SkipsOptions = {}): SkipRow[] {
    const rows: SkipRow[] = [];
    for (let testId = 0; testId < file.testCount; testId++) {
        const identity = file.testAt(testId);
        if (options.pathPrefix !== undefined && !identity.fullPath.startsWith(options.pathPrefix)) {
            continue;
        }
        if (options.component !== undefined) {
            const component = identity.component;
            if (
                component === null ||
                !component.toLowerCase().includes(options.component.toLowerCase())
            ) {
                continue;
            }
        }

        const row: SkipRow = {
            testId,
            fullPath: identity.fullPath,
            directory: identity.directory,
            component: identity.component,
            skipCount: 0,
            messages: new Map(),
            jobNames: new Set(),
        };

        for (const entry of file.runsOfTest(testId)) {
            if (!inDayRange(entry.day, options.dayRange)) {
                continue;
            }
            if (classifyStatus(entry.status).kind !== 'skip') {
                continue;
            }
            const reason = skipReason(entry.message);
            if (reason === 'run-if' && !options.includeRunIf) {
                continue;
            }
            row.skipCount += entry.count;
            if (entry.message) {
                const display = entry.message.replace(/^skip-if:\s*/, '');
                row.messages.set(display, (row.messages.get(display) ?? 0) + entry.count);
            }
            if (entry.jobName !== undefined) {
                row.jobNames.add(entry.jobName);
            }
        }

        if (row.skipCount > 0) {
            rows.push(row);
        }
    }
    rows.sort((a, b) => b.skipCount - a.skipCount || a.fullPath.localeCompare(b.fullPath));
    return rows;
}
