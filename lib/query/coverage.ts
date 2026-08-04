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
 * that could plausibly have run this test, which comes from other tests in the
 * same file. `configUniverse()` computes it, and it is optional — a caller that
 * does not supply one gets `null` rather than an empty set, because "no configs
 * are missing" and "I did not check" must not look the same.
 *
 * ## Why the universe is scoped to the test's own suites
 *
 * "Every config anywhere in the file" is the wrong universe, and it was the
 * first thing tried. A bucket file holds tests from every mochitest *suite* —
 * `mochitest-plain`, `mochitest-media`, `mochitest-browser-chrome`,
 * `geckoview-mochitest-plain` — because buckets shard by a hash of the test
 * path, not by suite. Measured on the real
 * `browser/extensions/formautofill/.../browser_ml_heuristics.js`: 495 configs
 * in the bucket, 42 of which ran the test, so 453 "never scheduled" rows led by
 * `geckoview-mochitest-media-nogpu`. A browser-chrome test was never going to
 * run under `mochitest-media`, so those rows are not an absence anyone can act
 * on — they bury the two or three that are.
 *
 * The suite is the schedulable unit: a manifest is assigned to a suite, and a
 * config either runs that suite or does not. So the universe is every config
 * running any suite **this test itself ran under**. On the same test that is 45
 * configs and 3 never-scheduled, all three real. Measured across four tests with
 * different shapes, suite scoping takes never-scheduled from 431–494 down to
 * 0–3.
 *
 * What this deliberately does *not* report is a platform the test's suites do
 * not exist on at all. A browser-chrome test has no Android suite in its set, so
 * Android drops out of the universe entirely rather than appearing as 51
 * never-scheduled rows. That absence is real and still reported — by
 * `platformsCovered()` and the caller's "not android" line — but as "this suite
 * does not run there", which is what it is, rather than as a list of configs
 * that were somehow missed.
 *
 * A test's directory would be a closer proxy still, but it is not reachable: the
 * 64 bucket files shard by `hash(fullPath) % 64`, so a test's directory siblings
 * are scattered across all of them and scoping by directory would mean fetching
 * ~224 MB instead of ~3.5 MB. Measured on `browser_ml_heuristics.js`, its own
 * directory contributes exactly one test — itself — to its bucket.
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
import { parseJobName, stripChunkSuffix } from '../model/job-name.ts';
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
    | 'not-applicable'
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
     * Configs in the universe that never scheduled this test, or `null` when
     * no universe was supplied. `null` and `[]` mean different things: "not
     * checked" and "none".
     */
    neverScheduled: string[] | null;
    /**
     * The suites the universe was scoped to — the suites this test itself ran
     * under. Empty when no universe was supplied.
     *
     * Reported so the caller can *say* what the comparison set is. A
     * never-scheduled count with no scope attached is the number the reader
     * cannot check, and the previous unscoped version of this was wrong by two
     * orders of magnitude without anything in the output admitting it.
     */
    universeSuites: string[];
}

/**
 * The never-scheduled configs rolled up to platform × build type.
 *
 * The level a reader thinks in. "Never runs on mac" is the answer to "is this
 * test covered on mac"; twenty config strings that all begin `test-macosx` are
 * the same answer, spelled out at a length nobody reads.
 */
export interface CoverageGap {
    /** `linux`, `windows`, `mac`, `android`, or `unknown`. */
    platform: string;
    /** Configs on this platform that ran the test at least once. */
    ranCount: number;
    /**
     * Configs on this platform that were scheduled but only ever skipped —
     * a `skip-if`, or a `run-if` scoping the test elsewhere.
     *
     * Tracked separately from both other counts because it is the state a
     * platform rollup gets wrong most easily. `dom/media/test/test_playback.html`
     * is scheduled on 20 Android configs and skipped on every one of them:
     * folded into `ranCount` that reads as full Android coverage, and folded
     * into `neverCount` it reads as CI not scheduling it there. Neither is
     * true, and the difference is whether someone owes a `skip-if` fix.
     */
    skippedCount: number;
    /** Configs on this platform in the universe that never scheduled it. */
    neverCount: number;
    /** The never-scheduled config names, for `--limit 0`. */
    neverConfigs: string[];
}

/**
 * Rolls the matrix up to one row per platform.
 *
 * All three counts are needed: a bare `neverCount` cannot distinguish "never
 * runs on mac" (0 ran) from "runs on most mac configs" (many ran, a few did
 * not), and without `skippedCount` a platform where the test is scheduled and
 * disabled everywhere is indistinguishable from one where it runs fine.
 */
export function coverageGaps(coverage: TestCoverage): CoverageGap[] {
    const byPlatform = new Map<string, CoverageGap>();
    const gap = (jobName: string): CoverageGap => {
        const platform = operatingSystemOf(jobName);
        let existing = byPlatform.get(platform);
        if (existing === undefined) {
            existing = {
                platform,
                ranCount: 0,
                skippedCount: 0,
                neverCount: 0,
                neverConfigs: [],
            };
            byPlatform.set(platform, existing);
        }
        return existing;
    };
    for (const config of coverage.configs) {
        const entry = gap(config.jobName);
        if (config.state === 'never-scheduled') {
            entry.neverCount++;
            entry.neverConfigs.push(config.jobName);
        } else if (config.runCount > 0) {
            entry.ranCount++;
        } else {
            entry.skippedCount++;
        }
    }
    return [...byPlatform.values()].sort(
        (a, b) =>
            b.ranCount + b.skippedCount + b.neverCount -
                (a.ranCount + a.skippedCount + a.neverCount) ||
            a.platform.localeCompare(b.platform)
    );
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
    let universeSuites: string[] = [];
    if (options.universe !== undefined) {
        const seen = new Set(rows.keys());

        // The scope: every suite this test itself ran under. A config running
        // some other suite is not a place this test could have been scheduled,
        // so subtracting it would manufacture an absence rather than find one.
        const suites = suitesOf(seen);
        universeSuites = [...suites].sort();

        neverScheduled = [...options.universe]
            .map(stripChunkSuffix)
            .filter((jobName) => !seen.has(jobName))
            .filter((jobName) => inSuites(jobName, suites))
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
        universeSuites,
    };
}

/**
 * The suites a set of config names runs.
 *
 * A config with no parseable suite contributes nothing rather than a `null`
 * bucket: an unparseable name must not quietly widen the universe to every
 * other unparseable name.
 */
function suitesOf(jobNames: Iterable<string>): Set<string> {
    const suites = new Set<string>();
    for (const jobName of jobNames) {
        const { suite } = parseJobName(jobName);
        if (suite !== null) {
            suites.add(suite);
        }
    }
    return suites;
}

/** Whether a config runs one of the suites the test does. */
function inSuites(jobName: string, suites: ReadonlySet<string>): boolean {
    const { suite } = parseJobName(jobName);
    return suite !== null && suites.has(suite);
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
 * Every configuration that appears anywhere in a file — the *candidate* pool
 * `coverageOf()` narrows to the test's own suites before subtracting.
 *
 * Deliberately unfiltered here. The suite scope depends on the test being
 * asked about, and this is computed once per file and reused across tests, so
 * narrowing at this level would either be wrong for every test but one or
 * force a rescan per test. `coverageOf()` applies the scope instead — see this
 * file's header for why the scope is the suite.
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
