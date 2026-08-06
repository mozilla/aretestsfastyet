/**
 * Where does this test actually run?
 *
 * Ported from `calculateJobNameBreakdown()` (`old/test.html:2606`), which builds
 * this matrix for a page and has no CLI equivalent. New as a *library*
 * function, not new logic.
 *
 * ## The two states that look alike
 *
 * A failure-only view — which is what every other query here produces — cannot
 * answer "does this test run on Android?", because several different situations
 * all show up as "no failures on Android":
 *
 * | state | what happened | what a failure list shows |
 * | --- | --- | --- |
 * | **ran and passed** | scheduled, ran, passed every time | nothing |
 * | **ran and was skipped** | scheduled, but a `skip-if` disabled it | nothing |
 * | **not scheduled** | CI never ran this test there | nothing |
 *
 * The first two are what this reports, and separating them is the point.
 * Both are recorded facts: a `durations`/`skip-counts` group attributes a run,
 * or a skip, to a named job. "Scheduled here and disabled" is someone's work to
 * do; "scheduled here and green" is not, and a failure list shows neither.
 *
 * The third is **not reported, deliberately**. Nothing in a test's own runs
 * records a config that never scheduled it, so stating it would mean inventing
 * a universe to subtract from — and no universe has a principled boundary. An
 * earlier version subtracted from every config in the bucket file and produced
 * 453 "never scheduled" rows for a browser-chrome test, led by
 * `geckoview-mochitest-media` variants it could never have run under. Scoping
 * that universe to the test's own suites cut it to 3, but the boundary was
 * still arbitrary: widen it and iOS appears, narrow it and real gaps vanish.
 *
 * **Absence is the signal instead.** This reports the configs the test *was*
 * scheduled on. A reader who sees no Android row concludes it does not run on
 * Android — from data that exists, with no enumeration of things that do not.
 * `calculateJobNameBreakdown()` has always worked this way: it iterates the
 * test's own status groups and has no universe at all.
 *
 * ## Why this needs a bucket file
 *
 * Passing runs are attributed to a job name only where the group carries
 * `jobNameIds`, which is the bucket files' `durations` shape. In
 * `{harness}-issues.json` the pass-like groups are `counts` with no
 * attribution, and in `issues-with-taskids.json` they *stay* `counts`
 * (`FORMATS.md`) — so despite the name, that file has no task IDs for passing
 * runs either. Coverage over those families would show the failing configs
 * only, which is exactly the view this exists to replace.
 *
 * `coverageOf()` therefore reports `attributedPasses`, and the CLI should
 * refuse `--coverage` on a family where it is false rather than print a
 * confidently wrong table.
 */

import type { DecodedTimingFile } from '../formats/decode.ts';
import { stripChunkSuffix } from '../model/job-name.ts';
import { classifyStatus } from '../model/status.ts';
import { displaySkipMessage, skipReason } from '../model/skips.ts';
import { inDayRange, type TestStatsOptions } from './test-stats.ts';

/** What happened to a test on one configuration. */
export type CoverageState =
    /** Ran, and every run passed. */
    | 'ok'
    /** Ran, and some runs did not pass. */
    | 'intermittent'
    /** Ran every time and never passed — a perma-fail on this config. */
    | 'perma-fail'
    /** Scheduled, but a `skip-if` disabled it. Never actually executed. */
    | 'skipped'
    /**
     * Did not run because a `run-if` scopes the test to another platform —
     * the annotation working, not something disabled.
     *
     * A distinct state rather than `skipped` because the two mean opposite
     * things to whoever reads the table: a `skip-if` is work someone owes, a
     * `run-if` is the test correctly not applying here. Only ever produced
     * from a **daily** file: the 21-day aggregates drop `run-if` skips
     * upstream, so on those families such a config simply does not appear
     * (`FORMATS.md`).
     *
     * Not a rare state. 11 rows in `test/fixtures/xpcshell-2026-08-03.json`,
     * which holds 11 tests, and 9,111 in the full file for that date — so the
     * fixture number is a property of the cut and the state is common in
     * practice.
     */
    | 'not-applicable';

/** One row of the coverage matrix. */
export interface ConfigCoverage {
    /** Chunk-stripped job name — the configuration identity. */
    jobName: string;
    state: CoverageState;
    /** Runs that reached a verdict. Zero for `skipped` and `not-applicable`. */
    runCount: number;
    passCount: number;
    failCount: number;
    timeoutCount: number;
    crashCount: number;
    expectedFailCount: number;
    /** Skipped runs, `run-if` excluded. */
    skipCount: number;
    /** Skipped runs a `run-if` annotation accounts for. */
    runIfSkipCount: number;
    /** Skip messages seen here, in display form, with counts. */
    skipMessages: Map<string, number>;
}

/** The whole matrix for one test. */
export interface TestCoverage {
    /** One row per configuration, sorted by descending run count then name. */
    configs: ConfigCoverage[];
    /**
     * Whether passing runs could be attributed to a configuration in this
     * file. False for the issues families, where the rows below cover only the
     * configs that failed — a partial view that must not be presented as
     * coverage.
     */
    attributedPasses: boolean;
}

/**
 * One platform's share of the matrix — where the test was scheduled, rolled up.
 *
 * The level a reader thinks in. "Scheduled on 20 mac configs, ran on none of
 * them" is the answer to "is this test covered on mac"; twenty config strings
 * that all begin `test-macosx` are the same answer at a length nobody reads.
 *
 * Only platforms that appear in the matrix get a row. A platform with nothing
 * scheduled has no row, and that absence is the report: no Android row means
 * the test does not run on Android.
 */
export interface CoveragePlatform {
    /** `linux`, `windows`, `mac`, `android`, or `unknown`. */
    platform: string;
    /** Configs on this platform that ran the test at least once. */
    ranCount: number;
    /**
     * Configs on this platform that were scheduled but only ever skipped —
     * a `skip-if`, or a `run-if` scoping the test elsewhere.
     *
     * Tracked separately from `ranCount` because it is the distinction a
     * platform rollup gets wrong most easily.
     * `dom/media/test/test_playback.html` is scheduled on 20 Android configs
     * and skipped on every one of them: folded into `ranCount` that reads as
     * full Android coverage, and dropped entirely it reads as CI not
     * scheduling it there. Neither is true, and the difference is whether
     * someone owes a `skip-if` fix.
     */
    skippedCount: number;
}

/**
 * Rolls the matrix up to one row per platform the test is scheduled on.
 *
 * Both counts are needed: without `skippedCount`, a platform where the test is
 * scheduled and disabled everywhere is indistinguishable from one where it
 * runs fine — and that is the one difference somebody has to act on.
 */
export function coveragePlatforms(coverage: TestCoverage): CoveragePlatform[] {
    const byPlatform = new Map<string, CoveragePlatform>();
    for (const config of coverage.configs) {
        const platform = operatingSystemOf(config.jobName);
        let entry = byPlatform.get(platform);
        if (entry === undefined) {
            entry = { platform, ranCount: 0, skippedCount: 0 };
            byPlatform.set(platform, entry);
        }
        if (config.runCount > 0) {
            entry.ranCount++;
        } else {
            entry.skippedCount++;
        }
    }
    return [...byPlatform.values()].sort(
        (a, b) =>
            b.ranCount + b.skippedCount - (a.ranCount + a.skippedCount) ||
            a.platform.localeCompare(b.platform)
    );
}

/** Options for `coverageOf`. */
export type CoverageOptions = TestStatsOptions;

/** A fresh row. */
function emptyRow(jobName: string): ConfigCoverage {
    return {
        jobName,
        state: 'ok',
        runCount: 0,
        passCount: 0,
        failCount: 0,
        timeoutCount: 0,
        crashCount: 0,
        expectedFailCount: 0,
        skipCount: 0,
        runIfSkipCount: 0,
        skipMessages: new Map(),
    };
}

/**
 * The per-configuration ran/passed/skipped matrix for a test.
 *
 * One pass over the test's own entries. Every row is a config the data says
 * this test was scheduled on; nothing is added from outside the test's runs.
 */
export function coverageOf(
    file: DecodedTimingFile,
    testId: number,
    options: CoverageOptions = {}
): TestCoverage {
    const rows = new Map<string, ConfigCoverage>();
    const row = (rawJobName: string): ConfigCoverage => {
        const jobName = stripChunkSuffix(rawJobName);
        let existing = rows.get(jobName);
        if (existing === undefined) {
            existing = emptyRow(jobName);
            rows.set(jobName, existing);
        }
        return existing;
    };

    for (const entry of file.runsOfTest(testId)) {
        if (!inDayRange(entry.day, options.dayRange)) {
            continue;
        }
        const { kind } = classifyStatus(entry.status);

        // Resolve the entry to one or more configurations. The two attributed
        // shapes name a job; the failing shapes name tasks, one run each.
        const targets: { jobName: string; count: number }[] = [];
        if (entry.jobName !== undefined) {
            targets.push({ jobName: entry.jobName, count: entry.count });
        } else if (entry.taskIdIndexes !== undefined) {
            for (const taskIdIndex of entry.taskIdIndexes) {
                const jobName = file.jobNameOfTaskIndex(taskIdIndex);
                if (jobName !== null) {
                    targets.push({ jobName, count: 1 });
                }
            }
        }

        for (const target of targets) {
            if (options.jobFilter !== undefined && !options.jobFilter(target.jobName)) {
                continue;
            }
            const r = row(target.jobName);
            switch (kind) {
                case 'pass':
                    r.passCount += target.count;
                    break;
                case 'fail':
                    r.failCount += target.count;
                    break;
                case 'timeout':
                    r.timeoutCount += target.count;
                    break;
                case 'crash':
                    r.crashCount += target.count;
                    break;
                case 'expected-fail':
                    r.expectedFailCount += target.count;
                    break;
                case 'unknown':
                    break;
                case 'skip': {
                    if (skipReason(entry.message) === 'run-if') {
                        r.runIfSkipCount += target.count;
                    } else {
                        r.skipCount += target.count;
                        if (entry.message) {
                            const display = displaySkipMessage(entry.message);
                            r.skipMessages.set(
                                display,
                                (r.skipMessages.get(display) ?? 0) + target.count
                            );
                        }
                    }
                    break;
                }
            }
        }
    }

    for (const r of rows.values()) {
        r.runCount =
            r.passCount + r.failCount + r.timeoutCount + r.crashCount + r.expectedFailCount;
        r.state = stateOf(r);
    }

    const configs = [...rows.values()].sort(
        (a, b) => b.runCount - a.runCount || a.jobName.localeCompare(b.jobName)
    );

    return {
        configs,
        attributedPasses: file.family === 'bucket' || file.family === 'daily',
    };
}

/**
 * Classifies a row once its counts are final.
 *
 * `perma-fail` is separated from `intermittent` because it is the single most
 * useful thing the matrix can say: a config where the test ran and *never*
 * passed is broken there, not flaky there, and `CLI.md`'s try triage keys its
 * highest-signal section on the distinction.
 */
function stateOf(r: ConfigCoverage): CoverageState {
    if (r.runCount === 0) {
        // No verdict on this config. Which of the two non-running states it is
        // depends on *why*: a reportable skip means disabled, while a row that
        // exists only because of a `run-if` means the test is scoped
        // elsewhere. Calling the latter "skipped" reads as "someone turned
        // this off here", which is the opposite of what the annotation says.
        if (r.skipCount === 0 && r.runIfSkipCount > 0) {
            return 'not-applicable';
        }
        return 'skipped';
    }
    const nonPass = r.failCount + r.timeoutCount + r.crashCount;
    if (nonPass === 0) {
        return 'ok';
    }
    return nonPass === r.runCount ? 'perma-fail' : 'intermittent';
}

/**
 * Every platform any test in a file runs on.
 *
 * The comparison set behind the default view's "Runs on N configs across
 * linux, windows, mac — not android" line, which is a *platform*-level claim
 * and needs a platform-level set to be a measured absence rather than an
 * assumption about what CI has.
 *
 * Deliberately platforms and not configs. A config-level version of this was
 * what `--coverage` used to subtract from to list "never scheduled" configs,
 * and enumerating configs that do not exist has no principled boundary — see
 * this file's header. Platforms are bounded by what the file actually contains:
 * four of them, all of which really run tests.
 *
 * Scans every test, so it is O(file). Only the attributed shapes contribute,
 * so on a family without attributed passes this sees only the platforms that
 * failed something. Check `attributedPasses` before trusting it.
 */
export function platformsInFile(file: DecodedTimingFile): Set<string> {
    const platforms = new Set<string>();
    // `unknown` is excluded: it is the parse failing, not a platform, and
    // reporting "not unknown" as a missing platform would be nonsense.
    const add = (jobName: string): void => {
        const os = operatingSystemOf(stripChunkSuffix(jobName));
        if (os !== 'unknown') {
            platforms.add(os);
        }
    };
    for (let testId = 0; testId < file.testCount; testId++) {
        for (const entry of file.runsOfTest(testId)) {
            if (entry.jobName !== undefined) {
                add(entry.jobName);
            } else if (entry.taskIdIndexes !== undefined) {
                for (const taskIdIndex of entry.taskIdIndexes) {
                    const jobName = file.jobNameOfTaskIndex(taskIdIndex);
                    if (jobName !== null) {
                        add(jobName);
                    }
                }
            }
        }
    }
    return platforms;
}

/**
 * The distinct operating systems a test ran on, from its coverage rows.
 *
 * `CLI.md`'s "Runs on 34 configs across linux, windows, macos (not android)"
 * line. Rows where the test only ever skipped are excluded — the question is
 * where it *runs*.
 */
export function platformsCovered(coverage: TestCoverage): Map<string, number> {
    const byOs = new Map<string, number>();
    for (const config of coverage.configs) {
        if (config.runCount === 0) {
            continue;
        }
        const os = operatingSystemOf(config.jobName);
        byOs.set(os, (byOs.get(os) ?? 0) + 1);
    }
    return byOs;
}

/** The coarse OS of a job name, or `unknown` when it does not parse. */
function operatingSystemOf(jobName: string): string {
    const slash = jobName.indexOf('/');
    const platform = slash === -1 ? jobName : jobName.slice(0, slash);
    if (platform.includes('android')) return 'android';
    if (platform.includes('linux')) return 'linux';
    if (platform.includes('win')) return 'windows';
    if (platform.includes('macos') || platform.includes('osx')) return 'mac';
    return 'unknown';
}
