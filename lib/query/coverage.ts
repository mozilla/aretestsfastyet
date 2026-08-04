/**
 * Where does this test actually run?
 *
 * Ported from `calculateJobNameBreakdown()` (`test.html:2606`), which builds
 * this matrix for a page and has no CLI equivalent. New as a *library*
 * function, not new logic.
 *
 * ## The three states that look alike
 *
 * A failure-only view — which is what every other query here produces — cannot
 * answer "does this test run on Android?", because three different situations
 * all show up as "no failures on Android":
 *
 * | state | what happened | what a failure list shows |
 * | --- | --- | --- |
 * | **ran and passed** | scheduled, ran, passed every time | nothing |
 * | **ran and was skipped** | scheduled, but a `skip-if` disabled it | nothing |
 * | **never scheduled** | the config does not run this suite at all | nothing |
 *
 * Distinguishing them is the whole point of `fx-tests test --coverage`, and it
 * is the reason `CLI.md` puts a `status` column on that table. The first two
 * are visible in the data — a `durations`/`skip-counts` group attributes to a
 * job name directly. The third is *not*: nothing in a test's own runs records
 * a config that never scheduled it.
 *
 * So `neverScheduled` needs a **universe** to subtract from: the set of configs
 * that ran this suite at all, which comes from other tests in the same file.
 * `configUniverse()` computes it, and it is optional — a caller that does not
 * supply one gets `null` rather than an empty set, because "no configs are
 * missing" and "I did not check" must not look the same.
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
    /** Scheduled, but skipped by an annotation. Never actually executed. */
    | 'skipped'
    /**
     * The config runs this suite, but never scheduled this test. Only ever
     * reported when the caller supplied a universe to compare against.
     */
    | 'never-scheduled';

/** One row of the coverage matrix. */
export interface ConfigCoverage {
    /** Chunk-stripped job name — the configuration identity. */
    jobName: string;
    state: CoverageState;
    /** Runs that reached a verdict. Zero for `skipped` and `never-scheduled`. */
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
    /**
     * Configs that run this suite but never scheduled this test, or `null`
     * when no universe was supplied. `null` and `[]` mean different things:
     * "not checked" and "none".
     */
    neverScheduled: string[] | null;
}

/** Options for `coverageOf`. */
export interface CoverageOptions extends TestStatsOptions {
    /**
     * Every configuration that runs this suite, for `never-scheduled`. Build
     * it with `configUniverse()`.
     */
    universe?: Iterable<string> | undefined;
}

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
 * The per-configuration ran/passed/skipped/never-scheduled matrix for a test.
 *
 * One pass over the test's entries, plus a set difference against the universe
 * if one was given.
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

    let neverScheduled: string[] | null = null;
    if (options.universe !== undefined) {
        const seen = new Set(rows.keys());
        neverScheduled = [...options.universe]
            .map(stripChunkSuffix)
            .filter((jobName) => !seen.has(jobName))
            .filter((jobName) => options.jobFilter?.(jobName) ?? true)
            .sort();
        // Dedupe: two chunks of one config strip to the same name.
        neverScheduled = [...new Set(neverScheduled)];
        for (const jobName of neverScheduled) {
            const r = emptyRow(jobName);
            r.state = 'never-scheduled';
            configs.push(r);
        }
    }

    return {
        configs,
        attributedPasses: file.family === 'bucket' || file.family === 'daily',
        neverScheduled,
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
        // No verdict on this config at all. If anything was skipped here, that
        // is why; otherwise the config appeared only through a filtered-out
        // `run-if` skip, which still means the test did not run here.
        return 'skipped';
    }
    const nonPass = r.failCount + r.timeoutCount + r.crashCount;
    if (nonPass === 0) {
        return 'ok';
    }
    return nonPass === r.runCount ? 'perma-fail' : 'intermittent';
}

/**
 * Every configuration that appears anywhere in a file — the universe to
 * subtract from for `never-scheduled`.
 *
 * Scans every test, so it is O(file) and the expensive part of `--coverage`.
 * Worth it only when the question is "where does this *not* run", which is why
 * it is a separate call rather than something `coverageOf` does implicitly.
 *
 * Only the attributed shapes contribute, so on a family without attributed
 * passes this returns just the configs that failed something — which is not a
 * universe. Check `attributedPasses` before trusting it.
 */
export function configUniverse(file: DecodedTimingFile): Set<string> {
    const universe = new Set<string>();
    for (let testId = 0; testId < file.testCount; testId++) {
        for (const entry of file.runsOfTest(testId)) {
            if (entry.jobName !== undefined) {
                universe.add(stripChunkSuffix(entry.jobName));
            } else if (entry.taskIdIndexes !== undefined) {
                for (const taskIdIndex of entry.taskIdIndexes) {
                    const jobName = file.jobNameOfTaskIndex(taskIdIndex);
                    if (jobName !== null) {
                        universe.add(stripChunkSuffix(jobName));
                    }
                }
            }
        }
    }
    return universe;
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
