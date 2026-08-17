/**
 * Per-test totals: how often did this test pass, fail, time out, crash, and
 * how often was it skipped.
 *
 * Ported from `computeTestStats()` (`common-test-data.js:267`) onto the step-1
 * primitives. The arithmetic is the same; three things about it changed, and
 * each is a decision `PLAN.md` §2 asked for rather than a rewrite.
 *
 * **The four-branch shape `if` is gone.** `computeTestStats()` reimplements
 * `getCountAtIndex()`'s shape dispatch inline (`:283`-`:291`) with the same
 * silent fallback — a group matching none of the four branches contributes
 * `runCount = 0`. `totalRuns()` throws instead.
 *
 * **`crash` and `expected-fail` are their own totals.** The original folds
 * `EXPECTED-FAIL` into the `else` branch, which is the pass bucket, so a test
 * annotated `fail-if` reads as passing. `model/status.ts` names it, so this
 * counts it separately and `passRate` decides what to do with it.
 *
 * **`UNKNOWN` is counted, not dropped.** The original ignores it explicitly
 * (`:323`), which means its runs vanish from every total including the
 * denominator. `FORMATS.md` found zero occurrences in 21 days, so this changes
 * no number today; what it buys is that a returning `UNKNOWN` shows up as a
 * number in a field called `unknown` rather than as runs that quietly cease to
 * exist.
 *
 * ## The skip count depends on which file it came from
 *
 * The one place a caller can get a *wrong answer* rather than a different one.
 * `FORMATS.md` measured it: **the 21-day aggregates drop `run-if` skips and the
 * daily files keep them** — 253,252 of 398,212 skipped runs on xpcshell
 * 2026-07-30, 63.6%. So the same test's skip count differs by 2.7× depending
 * on the family, and applying the `run-if` filter to an aggregate is a no-op
 * while omitting it on a daily file overstates by that factor.
 *
 * `TestStats` therefore reports **both** `skipped` (filtered, comparable across
 * families) and `runIfSkipped` (what the filter removed, always 0 for an
 * aggregate), and carries the `family` it was computed from. A caller
 * comparing two numbers can check they came from the same family; one that
 * reports a single number has the filtered one, which is the only one that
 * means the same thing everywhere.
 */

import type { DecodedTimingFile, RunEntry } from '../formats/decode.ts';
import type { TimingFamily } from '../formats/decode.ts';
import { classifyStatus, type StatusKind } from '../model/status.ts';
import { skipReason } from '../model/skips.ts';

/** Per-status-kind run totals for one test. */
export interface TestStats {
    /** Which file family produced these numbers. See the module comment. */
    family: TimingFamily;
    /**
     * Runs that reached a verdict: pass + fail + timeout + crash +
     * expected-fail. Excludes skips, which are not runs, and `unknown`, which
     * reported no verdict.
     */
    runCount: number;
    passCount: number;
    failCount: number;
    timeoutCount: number;
    crashCount: number;
    expectedFailCount: number;
    /**
     * Runs of a status this library does not recognize. Zero in all published
     * data; non-zero means the generator emitted something new.
     */
    unknownCount: number;
    /**
     * Skipped runs, `run-if` excluded — the count that means the same thing in
     * every family.
     */
    skipCount: number;
    /**
     * Skipped runs excluded by the `run-if` filter. **Always 0 for an
     * aggregate**, because the generator already dropped them; non-zero only
     * for a daily file. A caller can use this to tell which population it is
     * holding without knowing the family rule by heart.
     */
    runIfSkipCount: number;
    /**
     * Passes over runs, as a percentage, with `expected-fail` in the
     * numerator — the "did CI behave as annotated" rate the dashboards report.
     * `null` when there were no runs, rather than 0: a test that never ran did
     * not have a 0% pass rate.
     */
    passRate: number | null;
}

/** Options for `computeTestStats`. */
export interface TestStatsOptions {
    /**
     * Restrict to a day range, as absolute day indices (0 = oldest). Both ends
     * inclusive. Entries of a daily file have `day === null` and are always
     * included — the file *is* one day, so filtering it by day index is the
     * caller having already chosen.
     */
    dayRange?: { from: number; to: number } | undefined;
    /** Keep only entries whose job name satisfies this. See `configFilter()`. */
    jobFilter?: ((jobName: string) => boolean) | undefined;
}

/**
 * Whether an entry is inside the requested day range.
 *
 * A `null` day means a daily file, which covers exactly one day: there is
 * nothing to filter against, and dropping such entries would make `--day` on a
 * daily file return nothing at all.
 */
export function inDayRange(
    day: number | null,
    range: { from: number; to: number } | undefined
): boolean {
    if (range === undefined || day === null) {
        return true;
    }
    return day >= range.from && day <= range.to;
}

/**
 * Totals a test's runs by status kind.
 *
 * One pass over the entries. Passing a `jobFilter` costs the job resolution
 * for every entry, which is why it is optional rather than always on: the
 * common `fx-tests test` path wants every config.
 */
export function computeTestStats(
    file: DecodedTimingFile,
    testId: number,
    options: TestStatsOptions = {}
): TestStats {
    const stats: TestStats = {
        family: file.family,
        runCount: 0,
        passCount: 0,
        failCount: 0,
        timeoutCount: 0,
        crashCount: 0,
        expectedFailCount: 0,
        unknownCount: 0,
        skipCount: 0,
        runIfSkipCount: 0,
        passRate: null,
    };

    for (const entry of file.runsOfTest(testId)) {
        if (!inDayRange(entry.day, options.dayRange)) {
            continue;
        }
        // Per task, not per entry — see `configTargetsOfEntry()`.
        let count = entry.count;
        if (options.jobFilter !== undefined) {
            const kept = filterEntryByConfig(file, entry, options.jobFilter);
            if (kept === null || kept.count === 0) {
                continue;
            }
            count = kept.count;
        }
        addEntry(stats, classifyStatus(entry.status).kind, entry, count);
    }

    stats.runCount =
        stats.passCount +
        stats.failCount +
        stats.timeoutCount +
        stats.crashCount +
        stats.expectedFailCount;
    stats.passRate =
        stats.runCount > 0
            ? ((stats.passCount + stats.expectedFailCount) / stats.runCount) * 100
            : null;
    return stats;
}

/** Adds one entry's `count` runs into the totals, by kind. */
function addEntry(
    stats: TestStats,
    kind: StatusKind,
    entry: RunEntry,
    count: number
): void {
    switch (kind) {
        case 'pass':
            stats.passCount += count;
            return;
        case 'fail':
            stats.failCount += count;
            return;
        case 'timeout':
            stats.timeoutCount += count;
            return;
        case 'crash':
            stats.crashCount += count;
            return;
        case 'expected-fail':
            stats.expectedFailCount += count;
            return;
        case 'unknown':
            stats.unknownCount += count;
            return;
        case 'skip':
            // The one kind whose count depends on the message. `run-if` means
            // the test is scoped to another platform, so it not running here
            // is the annotation working; the aggregates have already dropped
            // these, so this branch only ever fires on a daily file.
            if (skipReason(entry.message) === 'run-if') {
                stats.runIfSkipCount += count;
            } else {
                stats.skipCount += count;
            }
            return;
    }
}

/**
 * The job name behind an entry, whichever way the shape records it.
 *
 * Two shapes carry `jobName` directly; the failing shapes carry task-ID indices
 * and need `taskInfo`. **This is the first task's job, not the entry's**, and a
 * FAIL/TIMEOUT/CRASH bucket routinely spans configurations — anything that has to
 * be right per configuration needs `configTargetsOfEntry()` instead.
 */
export function jobNameOfEntry(file: DecodedTimingFile, entry: RunEntry): string | null {
    if (entry.jobName !== undefined) {
        return entry.jobName;
    }
    const first = entry.taskIdIndexes?.[0];
    return first === undefined ? null : file.jobNameOfTaskIndex(first);
}

/** One configuration an entry's runs belong to, and how many of them. */
export interface ConfigTarget {
    jobName: string;
    count: number;
    /** Positions in the entry's parallel arrays; empty on the `jobName` shapes. */
    indexes: number[];
}

/** The configurations one entry's runs belong to, with a run count each. */
export function configTargetsOfEntry(
    file: DecodedTimingFile,
    entry: RunEntry
): ConfigTarget[] {
    if (entry.jobName !== undefined) {
        return [{ jobName: entry.jobName, count: entry.count, indexes: [] }];
    }
    if (entry.taskIdIndexes === undefined) {
        // `{harness}-issues.json`'s `counts` shape: no attribution to resolve.
        return [];
    }
    const byJob = new Map<string, ConfigTarget>();
    entry.taskIdIndexes.forEach((taskIdIndex, i) => {
        const jobName = file.jobNameOfTaskIndex(taskIdIndex);
        if (jobName === null) {
            // An unnameable task's run leaves the totals, even under a filter
            // that accepts everything. No published file hits this.
            return;
        }
        let target = byJob.get(jobName);
        if (target === undefined) {
            target = { jobName, count: 0, indexes: [] };
            byJob.set(jobName, target);
        }
        target.count++;
        target.indexes.push(i);
    });
    return [...byJob.values()];
}

/**
 * How many of an entry's runs a config filter keeps, and which task positions.
 * `null` for an unattributed entry — a different answer from "kept none".
 */
export function filterEntryByConfig(
    file: DecodedTimingFile,
    entry: RunEntry,
    jobFilter: (jobName: string) => boolean
): { count: number; indexes: number[] } | null {
    const targets = configTargetsOfEntry(file, entry);
    if (targets.length === 0) {
        return null;
    }
    let count = 0;
    const indexes: number[] = [];
    for (const target of targets) {
        if (!jobFilter(target.jobName)) {
            continue;
        }
        count += target.count;
        indexes.push(...target.indexes);
    }
    indexes.sort((a, b) => a - b);
    return { count, indexes };
}

/**
 * An entry restricted to the runs a config filter keeps, or `null` for none.
 *
 * `count` and the parallel arrays all describe the same kept runs afterwards, so
 * a rerun count, a task-ID list and a profile list built from a narrowed entry
 * cannot disagree with the totals.
 */
export function narrowEntryToConfig(
    file: DecodedTimingFile,
    entry: RunEntry,
    jobFilter: (jobName: string) => boolean
): RunEntry | null {
    const kept = filterEntryByConfig(file, entry, jobFilter);
    if (kept === null || kept.count === 0) {
        return null;
    }
    if (kept.count === entry.count) {
        return entry;
    }
    // Indexes positionally and must not compact: dropping a hole would shorten
    // the array below `count` and shift every later element out of step with
    // `taskIds`, silently misattributing tasks. The throw keeps that visible.
    const pick = <T>(values: readonly T[] | undefined, field: string): T[] | undefined => {
        if (values === undefined) {
            return undefined;
        }
        if (values.length !== entry.count) {
            throw new RangeError(
                `${entry.status} entry has ${values.length} ${field} for ${entry.count} runs; ` +
                    'narrowing by configuration needs them parallel'
            );
        }
        return kept.indexes.map((i) => values[i]!);
    };
    const narrowed: RunEntry = { ...entry, count: kept.count };
    // Assigned conditionally: an absent array must stay absent, not become
    // `undefined`, for the `in` checks and `?.` chains downstream.
    const taskIds = pick(entry.taskIds, 'taskIds');
    if (taskIds !== undefined) {
        narrowed.taskIds = taskIds;
    }
    const taskIdIndexes = pick(entry.taskIdIndexes, 'taskIdIndexes');
    if (taskIdIndexes !== undefined) {
        narrowed.taskIdIndexes = taskIdIndexes;
    }
    const durations = pick(entry.durations, 'durations');
    if (durations !== undefined) {
        narrowed.durations = durations;
    }
    const timestamps = pick(entry.timestamps, 'timestamps');
    if (timestamps !== undefined) {
        narrowed.timestamps = timestamps;
    }
    const minidumps = pick(entry.minidumps, 'minidumps');
    if (minidumps !== undefined) {
        narrowed.minidumps = minidumps;
    }
    return narrowed;
}

/**
 * The failure messages of a test, with a count each.
 *
 * `computeTestStats()` returns a flat `failureMessages` array with one entry
 * per *bucket* rather than per run, and mixes crash signatures into the same
 * array (`:317`). Both are reported separately here: a count is what a caller
 * displays (`17x Assertion failed: …` in `CLI.md`), and a signature is not a
 * message.
 *
 * Timeouts contribute nothing, because `FORMATS.md` measured that `TIMEOUT*`
 * groups carry no `messageIds` at all — not null messages, no array. Reading
 * one would yield `undefined` for every timeout and read as "failed with no
 * message".
 */
export function failureMessageCounts(
    file: DecodedTimingFile,
    testId: number,
    options: TestStatsOptions = {}
): Map<string | null, number> {
    const counts = new Map<string | null, number>();
    for (const entry of file.runsOfTest(testId)) {
        if (!inDayRange(entry.day, options.dayRange)) {
            continue;
        }
        if (classifyStatus(entry.status).kind !== 'fail') {
            continue;
        }
        let count = entry.count;
        if (options.jobFilter !== undefined) {
            const kept = filterEntryByConfig(file, entry, options.jobFilter);
            if (kept === null || kept.count === 0) {
                continue;
            }
            count = kept.count;
        }
        // `undefined` (no array) and `null` (no message on this entry) are both
        // "no message recorded" as far as a display list is concerned.
        const key = entry.message ?? null;
        counts.set(key, (counts.get(key) ?? 0) + count);
    }
    return counts;
}

/** Crash signatures of a test, with a count each. `null` when unsymbolized. */
export function crashSignatureCounts(
    file: DecodedTimingFile,
    testId: number,
    options: TestStatsOptions = {}
): Map<string | null, number> {
    const counts = new Map<string | null, number>();
    for (const entry of file.runsOfTest(testId)) {
        if (!inDayRange(entry.day, options.dayRange)) {
            continue;
        }
        if (classifyStatus(entry.status).kind !== 'crash') {
            continue;
        }
        let count = entry.count;
        if (options.jobFilter !== undefined) {
            const kept = filterEntryByConfig(file, entry, options.jobFilter);
            if (kept === null || kept.count === 0) {
                continue;
            }
            count = kept.count;
        }
        const key = entry.crashSignature ?? null;
        counts.set(key, (counts.get(key) ?? 0) + count);
    }
    return counts;
}

/**
 * A job-name predicate from `--config` / `--exclude-config` substring lists.
 *
 * `CLI.md`'s rule: an entry matches if it is *contained* in the job name, the
 * includes are a union, and the excludes are applied after — so
 * `--config linux --exclude-config debug` is "linux, but not debug". Empty
 * include list means everything.
 *
 * Callers disagree on what they test: `computeConfigStats` passes the
 * chunk-stripped name, `configTargetsOfEntry` and `coverageOf` the raw one. Only
 * a needle ending in a chunk number can tell them apart, so unifying them is a
 * spec decision about what `--config` matches, not a cleanup.
 */
export function configFilter(
    include: readonly string[] = [],
    exclude: readonly string[] = []
): (jobName: string) => boolean {
    return (jobName: string): boolean => {
        if (include.length > 0 && !include.some((s) => jobName.includes(s))) {
            return false;
        }
        return !exclude.some((s) => jobName.includes(s));
    };
}
