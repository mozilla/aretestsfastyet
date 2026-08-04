/**
 * `fx-tests try <revision>` — triage a Try push.
 *
 * The command most useful to an agent that just pushed. It answers one
 * question: **which of these failures did my patch cause?**
 *
 * ## How the push's failures are obtained
 *
 * Not from an aggregate — the push's own results are not published as one.
 * `try.html` reads, per failed test job, the job's
 * `public/test_info/profile_resource-usage.json` artifact and extracts the
 * test-status markers from it (`try.html:955`, `profile-worker.js:112`). That
 * is the only source of per-test outcomes for a push, so this command does the
 * same. `parseTestMarkers()` below is the port.
 *
 * The cost is one artifact per failed job, which is why the command reports
 * progress and why `--limit` does not reduce the fetching — the classification
 * needs every failure before it can rank them.
 *
 * ## The three sections, and what separates them
 *
 * `CLI.md`'s split, in decreasing order of "this is probably yours":
 *
 * - **PERMA-FAILS** — failed in every run on the affected config *and* never
 *   failed on central. Almost certainly caused by the patch.
 * - **KNOWN INTERMITTENTS** — also fail on central. Likely not yours.
 * - **NEW INTERMITTENTS** — failed here, not seen failing on central, but not
 *   in every run. Worth a look.
 *
 * Two distinctions carry the weight, and both are easy to lose:
 *
 * **Passed on rerun.** A test that failed and then passed when the harness
 * reran it *within the same job* is intermittent almost by definition. The
 * profile records the rerun phase as a `retry` text marker, so a `PASS` marker
 * inside that range for a test that also failed is the signal
 * (`try.html:1393`). This is a within-job rerun, not the job-level `retryId`.
 *
 * **Same message.** A test that already fails 8% of the time on central, but
 * with a *different* message than the one in your push, is **not** exonerated.
 * `computeConfigStats`'s `tryMessages` option exists for this, and every
 * section reports the same-message rate alongside the overall one.
 */

import { bucketFileSuffix, bucketIndexForPath, type BucketFile, decodeBucket } from '../../lib/formats/buckets.ts';
import { computeConfigStats } from '../../lib/query/config-stats.ts';
import { computeTestStats } from '../../lib/query/test-stats.ts';
import { resourceUsageProfileUrl, uploadedProfileUrl } from '../../lib/links.ts';
import { treeherderPushUrl } from '../../lib/links.ts';
import {
    type TreeherderJob,
    FAILED_JOB_RESULTS,
} from '../../lib/sources/treeherder.ts';
import { fetchJson, timingsIndex } from '../../lib/sources/source.ts';
import { type OptionSpecs, type ParsedArgs, boolOption, stringOption } from '../args.ts';
import { type CommandContext, emit, progress, warn } from '../context.ts';
import { usageError } from '../errors.ts';
import { toJson } from '../format/json.ts';
import * as md from '../format/markdown.ts';
import { applyLimit, joinLines, moreLine, percent, table, truncate } from '../format/text.ts';
import { detectHarness } from '../options.ts';

/** Options `try` adds. */
export const TRY_OPTIONS: OptionSpecs = {
    project: {
        type: 'string',
        placeholder: '<try|autoland|…>',
        describe: 'The Treeherder repository the push is on. Default try.',
    },
    'perma-only': {
        type: 'boolean',
        describe: 'Only the perma-fail section — the highest-signal output.',
    },
    'all-jobs': {
        type: 'boolean',
        describe: 'Also list failures of non-test jobs (builds, lint).',
    },
    'task-ids': { type: 'boolean', describe: 'Print the task IDs behind each failure.' },
    profiles: { type: 'boolean', describe: 'Print raw profile artifact URLs.' },
    concurrency: {
        type: 'number',
        placeholder: '<n>',
        describe: 'How many job profiles to fetch at once. Default 8.',
    },
};

/** The harnesses whose profiles carry test markers. From `try.html:735`. */
const SUPPORTED_HARNESSES = ['mochitest', 'xpcshell'];

/** Default rows per section. */
const DEFAULT_LIMIT = 10;

/** How many artifacts to fetch at once. */
const DEFAULT_CONCURRENCY = 8;

/** One test failure on the push, aggregated across jobs. */
export interface TryFailure {
    path: string;
    /** Distinct configurations it failed on. */
    jobNames: string[];
    /** Failing runs, and how many runs of those jobs there were. */
    failedRuns: number;
    totalRuns: number;
    /** True when every run of every affected config failed. */
    everyRunFailed: boolean;
    /** True when the harness reran it in-job and it passed. */
    passedOnRerun: boolean;
    /** The distinct failure messages seen, most common first. */
    messages: string[];
    /**
     * Whether the same-message comparison against central means anything.
     *
     * False when the push recorded no message and the status is not one that
     * matches on kind instead (timeout, crash). A `sameMessageFailCount` of 0
     * then means "nothing to compare", not "a different failure" — and the
     * difference decides which section a failure lands in. Measured: on
     * autoland push 7c06165ae50f70, 20 of 21 candidate perma-fails had no
     * message.
     */
    messageComparable: boolean;
    statuses: string[];
    /** Only failed under parallel execution. */
    parallelOnly: boolean;
    /** What central says about this test. `null` when it has no data at all. */
    central: CentralHistory | null;
    taskIds?: { taskId: string; retryId: number; jobName: string }[];
    profiles?: { taskId: string; retryId: number; resourceUsage: string; testProfile?: string }[];
}

/** What the 21-day central aggregate says about a test. */
export interface CentralHistory {
    /** Runs and failures over the whole window, all configs. */
    runCount: number;
    failCount: number;
    failRate: number | null;
    /**
     * The failure rate counting **only** failures whose message matches one
     * from the push. The number that decides whether a known intermittent
     * exonerates this failure.
     */
    sameMessageFailCount: number;
    sameMessageFailRate: number | null;
    /** The worst affected config's overall rate, for the one-line summary. */
    worstConfig: { jobName: string; failRate: number; sameMsgFailRate: number } | null;
    /** Whether the test appears in central data at all. */
    known: boolean;
}

/** The `--json` shape `CLI.md` documents. */
export interface TryJson {
    revision: string;
    pushId: number;
    project: string;
    treeherderUrl: string;
    jobCount: number;
    failedJobCount: number;
    /** Failed test jobs whose profile yielded no test-level failure. */
    unblamedJobCount: number;
    /** Jobs that failed but are not test jobs — builds, lint. */
    otherFailedJobs: { jobName: string; taskId: string; result: string }[];
    permaFails: TryFailure[];
    knownIntermittents: TryFailure[];
    newIntermittents: TryFailure[];
}

/** Runs the command. */
export async function runTry(context: CommandContext, args: ParsedArgs): Promise<void> {
    const revision = args.positionals[0];
    if (revision === undefined) {
        throw usageError(
            'try requires a revision',
            'Usage: fx-tests try <revision>, e.g. fx-tests try 4f2c1a9e8b3d'
        );
    }
    if (args.positionals.length > 1) {
        throw usageError(`try takes one revision, got ${args.positionals.length}`);
    }
    const treeherder = context.treeherder;
    if (treeherder === undefined) {
        throw new Error('try needs a Treeherder client but none was supplied');
    }
    const fetchUrl = context.fetchUrl;
    if (fetchUrl === undefined) {
        throw new Error('try needs a URL fetcher but none was supplied');
    }

    const project = stringOption(args, 'project') ?? 'try';

    progress(context, `Looking up ${revision} on ${project}…`);
    const push = await treeherder.findPush(project, revision);

    progress(context, `Fetching jobs for push ${push.pushId}…`);
    const jobs = await treeherder.jobsOfPush(push.pushId);

    const failedTestJobs = jobs.filter(
        (job) =>
            job.state === 'completed' && job.result === 'testfailed' && isTestJob(job.jobName)
    );
    const successfulTestJobs = jobs.filter(
        (job) => job.state === 'completed' && job.result === 'success' && isTestJob(job.jobName)
    );
    const otherFailedJobs = jobs.filter(
        (job) =>
            job.state === 'completed' &&
            FAILED_JOB_RESULTS.has(job.result) &&
            !isTestJob(job.jobName)
    );

    // Every completed run of each config, so "3/3 runs" has a real denominator
    // rather than counting only the runs that failed.
    const runsPerJobName = new Map<string, number>();
    for (const job of jobs) {
        if (job.state === 'completed' && isTestJob(job.jobName)) {
            runsPerJobName.set(job.jobName, (runsPerJobName.get(job.jobName) ?? 0) + 1);
        }
    }

    let timings: TestTiming[] = [];
    if (failedTestJobs.length > 0) {
        progress(
            context,
            `Fetching ${failedTestJobs.length} job profiles (one per failed test job)…`
        );
        timings = await collectTimings(
            context,
            failedTestJobs,
            fetchUrl,
            Number(args.options.get('concurrency') ?? DEFAULT_CONCURRENCY)
        );
    }

    const failures = aggregateFailures(timings, runsPerJobName, successfulTestJobs);

    // Central history, one bucket file per distinct bucket the failing tests
    // land in. Failing tests cluster, so this is usually one or two files, not
    // one per test.
    if (failures.length > 0) {
        progress(context, `Comparing ${failures.length} failing tests against central…`);
        await attachCentralHistory(context, failures);
    }

    const withTaskIds = boolOption(args, 'task-ids');
    const withProfiles = boolOption(args, 'profiles');
    if (withTaskIds || withProfiles) {
        attachProvenance(failures, timings, withTaskIds, withProfiles);
    }

    const blamed = new Set(
        timings.filter((timing) => isFailureStatus(timing.status)).map(runKeyOf)
    );
    const unblamedJobCount = failedTestJobs.filter(
        (job) => !blamed.has(`${job.taskId}.${job.retryId}`)
    ).length;

    const result: TryJson = {
        revision: push.revision,
        pushId: push.pushId,
        project,
        treeherderUrl: treeherderPushUrl(project, push.revision),
        jobCount: jobs.length,
        failedJobCount: failedTestJobs.length + otherFailedJobs.length,
        unblamedJobCount,
        otherFailedJobs: otherFailedJobs.map((job) => ({
            jobName: job.jobName,
            taskId: job.taskId,
            result: job.result,
        })),
        permaFails: failures.filter(isPermaFail),
        knownIntermittents: failures.filter(
            (failure) => !isPermaFail(failure) && isKnownOnCentral(failure)
        ),
        newIntermittents: failures.filter(
            (failure) => !isPermaFail(failure) && !isKnownOnCentral(failure)
        ),
    };

    if (context.globals.format === 'json') {
        emit(context, toJson(result));
        return;
    }
    const limit = context.globals.limit ?? DEFAULT_LIMIT;
    emit(
        context,
        context.globals.format === 'markdown'
            ? renderMarkdown(result, limit, boolOption(args, 'perma-only'), boolOption(args, 'all-jobs'))
            : renderText(result, limit, boolOption(args, 'perma-only'), boolOption(args, 'all-jobs'))
    );
    // Exit 0 regardless of what was found: `CLI.md` is explicit that the
    // failures are the answer, not an error, and that scripts should branch on
    // --json rather than on the exit code.
}

/**
 * Whether a failure is a perma-fail candidate.
 *
 * Both halves are required, and the second is what stops a long-standing
 * central intermittent that happened to fail in all three runs here from being
 * reported as caused by the patch.
 */
function isPermaFail(failure: TryFailure): boolean {
    if (!failure.everyRunFailed || failure.passedOnRerun) {
        return false;
    }
    const central = failure.central;
    if (central === null) {
        // No central data for this test at all — nothing exonerates it.
        return true;
    }
    if (central.failCount === 0) {
        // Never failed on central. The clean perma-fail case.
        return true;
    }
    // Central *has* seen this test fail. Whether that exonerates the push
    // depends on it being the *same* failure, and answering that needs a
    // message on both sides.
    //
    // Measured on autoland push 7c06165ae50f70: 20 of 21 candidate perma-fails
    // recorded **no message at all** in the push's profile. With no message,
    // `sameMessageFailCount` is 0 not because the failures differ but because
    // there was nothing to compare — and treating that as "not failing on
    // central" reported a test that fails 24.9% of the time on central as
    // almost certainly caused by the patch. That is exactly the confidently
    // wrong number this project keeps producing.
    //
    // So an unmatchable failure against a test that already fails on central
    // is not a perma-fail. It goes to the known-intermittent section, where
    // the rate is shown and the missing comparison is stated.
    if (!failure.messageComparable) {
        return false;
    }
    return central.sameMessageFailCount === 0;
}

/** Whether central has seen this test fail the same way. */
function isKnownOnCentral(failure: TryFailure): boolean {
    return failure.central !== null && failure.central.failCount > 0;
}

// --- the push's own results ----------------------------------------------

/** One test's outcome in one job run, from the job's profile. */
interface TestTiming {
    path: string;
    status: string;
    message: string | null;
    jobName: string;
    taskId: string;
    retryId: number;
    /** True when the marker fell inside the harness's rerun phase. */
    isRerun: boolean;
}

/** `taskId.retryId`, the key that identifies one job run. */
function runKeyOf(timing: TestTiming): string {
    return `${timing.taskId}.${timing.retryId}`;
}

/** Statuses that mean the test did not pass. From `try.html:1486`. */
const FAILURE_STATUSES = new Set(['FAIL', 'TIMEOUT', 'CRASH', 'ERROR', 'UNEXPECTED-PASS']);

/** Whether a status means failure, ignoring the execution-mode suffix. */
function isFailureStatus(status: string): boolean {
    return FAILURE_STATUSES.has(status.replace(/-(PARALLEL|SEQUENTIAL)$/, ''));
}

/** Whether a job name is one whose profile carries test markers. */
function isTestJob(jobName: string): boolean {
    return SUPPORTED_HARNESSES.some((harness) => jobName.includes(harness));
}

/** Fetches and parses each job's profile, with bounded concurrency. */
async function collectTimings(
    context: CommandContext,
    jobs: readonly TreeherderJob[],
    fetchUrl: (url: string) => Promise<Uint8Array | null>,
    concurrency: number
): Promise<TestTiming[]> {
    const timings: TestTiming[] = [];
    const queue = [...jobs];
    let done = 0;
    let missing = 0;

    const worker = async (): Promise<void> => {
        for (;;) {
            const job = queue.shift();
            if (job === undefined) {
                return;
            }
            const url = resourceUsageProfileUrl(job.taskId, job.retryId);
            let bytes: Uint8Array | null = null;
            try {
                bytes = await fetchUrl(url);
            } catch {
                // A single unreachable artifact must not fail the command:
                // the answer is still useful without one job, and reporting
                // how many were missing is more honest than either failing or
                // silently dropping them.
                bytes = null;
            }
            done++;
            if (bytes === null) {
                missing++;
            } else {
                try {
                    const profile = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
                    timings.push(...parseTestMarkers(profile, job));
                } catch {
                    missing++;
                }
            }
            if (done % 10 === 0) {
                progress(context, `  …${done}/${jobs.length} profiles`);
            }
        }
    };

    await Promise.all(
        Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker)
    );

    if (missing > 0) {
        warn(
            context,
            `${missing} of ${jobs.length} job profiles could not be read; ` +
                `failures in those jobs are not in this report`
        );
    }
    return timings;
}

/** The marker table shape a Gecko profile's first thread has. */
interface ProfileThread {
    stringArray?: string[];
    markers?: {
        length?: number;
        name?: number[];
        data?: ({
            type?: string;
            test?: string;
            name?: string;
            status?: string;
            message?: string;
            color?: string;
            text?: string;
            signature?: string;
            minidump?: string;
            reason?: string;
        } | null)[];
        startTime?: number[];
        endTime?: number[];
    };
}

/** A `Crash` marker, before it is matched to a test. */
interface CrashMarker {
    /** The test the crash was recorded against, as written in the marker. */
    testPath: string;
    start: number;
    signature: string | null;
    minidump: string | null;
    reason: string | null;
    /** Set once a `CRASH`-status test marker has claimed it. */
    consumed: boolean;
}

/**
 * Extracts per-test outcomes from a job's resource-usage profile.
 *
 * Ported from `extractTestTimings()` (`profile-worker.js:112`) and the richer
 * copy in `try.html:955`. What it keeps from both:
 *
 * - **The `parallel` and `retry` text markers are ranges**, not flags. A test
 *   marker overlapping the `parallel` range ran in parallel; one overlapping
 *   `retry` was the harness's within-job rerun. That is where the
 *   `-PARALLEL`/`-SEQUENTIAL` suffix on a try push comes from — the aggregates
 *   get it from the generator, a push has to derive it.
 * - **`FAIL` with `color === 'green'` is an expected failure**, not a failure.
 *   Missing this reports every `fail-if` annotated test as broken.
 * - **The test path may be `manifest.toml:path/to/test.js`**, and only the part
 *   after the colon is the path the aggregates use.
 * - **`Crash` markers that no test marker claims become synthetic `CRASH`
 *   entries** (`try.html:1042`). This is not an edge case: measured on try push
 *   717fc67feaa071, all four failed mochitest jobs had *every* `Test` marker at
 *   `PASS` or `SKIP`, and the actual failures were four shutdown-hang `Crash`
 *   markers recorded against tests that had already finished. Without this the
 *   command reports "no test-level failures found" for a push that plainly has
 *   them — which is what it did before this was ported.
 */
export function parseTestMarkers(profile: unknown, job: TreeherderJob): TestTiming[] {
    const thread = (profile as { threads?: ProfileThread[] })?.threads?.[0];
    const markers = thread?.markers;
    const stringArray = thread?.stringArray;
    if (markers?.data === undefined || markers.name === undefined || stringArray === undefined) {
        return [];
    }
    const length = markers.length ?? markers.data.length;
    const startTime = markers.startTime ?? [];
    const endTime = markers.endTime ?? [];

    const rangesOf = (text: string): { start: number; end: number }[] => {
        const ranges: { start: number; end: number }[] = [];
        for (let i = 0; i < length; i++) {
            const data = markers.data![i];
            if (data?.type === 'Text' && data.text === text) {
                ranges.push({ start: startTime[i] ?? 0, end: endTime[i] ?? 0 });
            }
        }
        return ranges;
    };
    const parallelRanges = rangesOf('parallel');
    const retryRanges = rangesOf('retry');
    const overlaps = (
        start: number,
        end: number,
        ranges: readonly { start: number; end: number }[]
    ): boolean => ranges.some((range) => start < range.end && end > range.start);

    // Crash markers are collected first so a CRASH-status test marker can
    // claim the one inside its time range, leaving the unclaimed ones to
    // become synthetic entries below.
    const crashMarkers: CrashMarker[] = [];
    for (let i = 0; i < length; i++) {
        const data = markers.data[i];
        if (data?.type !== 'Crash' || data.test === undefined) {
            continue;
        }
        crashMarkers.push({
            testPath: data.test,
            start: startTime[i] ?? 0,
            signature: data.signature ?? null,
            minidump: data.minidump ?? null,
            reason: data.reason ?? null,
            consumed: false,
        });
    }

    const testStringId = stringArray.indexOf('test');
    const timings: TestTiming[] = [];

    for (let i = 0; i < length; i++) {
        if (markers.name[i] !== testStringId) {
            continue;
        }
        const data = markers.data[i];
        if (data?.type !== 'Test') {
            continue;
        }
        let path = data.test ?? data.name ?? null;
        if (path === null) {
            continue;
        }
        if (path.includes(':')) {
            path = path.split(':')[1] ?? path;
        }
        if (!/\.(js|html|xhtml)$/.test(path)) {
            continue;
        }

        const start = startTime[i] ?? 0;
        const end = endTime[i] ?? 0;
        let status = data.status ?? 'UNKNOWN';
        if (status === 'FAIL' && data.color === 'green') {
            status = 'EXPECTED-FAIL';
        } else if (
            ['TIMEOUT', 'FAIL', 'CRASH', 'PASS'].includes(status) &&
            parallelRanges.length > 0
        ) {
            status += overlaps(start, end, parallelRanges) ? '-PARALLEL' : '-SEQUENTIAL';
        }

        let message = data.message ?? null;
        if (status.startsWith('CRASH')) {
            // Claim the crash marker inside this test's range, so it is not
            // also emitted as a synthetic entry below. Matched on the raw
            // `data.test`, which still carries the manifest prefix the path
            // above had stripped.
            const matching = crashMarkers.find(
                (crash) =>
                    !crash.consumed &&
                    crash.testPath === data.test &&
                    crash.start >= start &&
                    crash.start <= end
            );
            if (matching !== undefined) {
                matching.consumed = true;
                message ??= matching.signature;
            }
        }

        timings.push({
            path,
            status,
            message: normalizeMessage(message),
            jobName: job.jobName,
            taskId: job.taskId,
            retryId: job.retryId,
            isRerun: retryRanges.length > 0 && overlaps(start, end, retryRanges),
        });
    }

    // Crashes no test marker claimed. `try.html:1042`: these happen during
    // manifest teardown or shutdown, so the test they are recorded against has
    // usually already reported PASS. Dropping them loses the only evidence of
    // the failure — measured on push 717fc67feaa071, where all four failing
    // jobs' failures were exclusively of this kind.
    for (const crash of crashMarkers) {
        if (crash.consumed) {
            continue;
        }
        // The marker's `test` can carry a manifest prefix and a " (finished)"
        // suffix, neither of which is part of the path the aggregates use.
        let path = crash.testPath;
        if (path.includes(':')) {
            path = path.split(':')[1] ?? path;
        }
        path = path.replace(/\s+\(finished\)$/, '').trim();
        if (!/\.(js|html|xhtml)$/.test(path)) {
            // A crash recorded against a manifest rather than a test. Real,
            // but it has no test path to join against central, so reporting
            // it as a test failure would invent one.
            continue;
        }
        timings.push({
            path,
            status: 'CRASH',
            message: normalizeMessage(crash.signature ?? crash.reason),
            jobName: job.jobName,
            taskId: job.taskId,
            retryId: job.retryId,
            isRerun: false,
        });
    }

    return timings;
}

/**
 * Normalizes a failure message so two runs of the same failure group together.
 *
 * From `try.html:865`. The substitutions strip the parts that differ per run —
 * a task number, a rejection timestamp, an elapsed time — which would
 * otherwise make every occurrence its own message and defeat the same-message
 * comparison against central entirely.
 */
export function normalizeMessage(message: string | null): string | null {
    if (message === null) {
        return null;
    }
    return message
        .replace(/\r\n/g, '\n')
        .replace(/task_\d+/g, 'task_id')
        .replace(/\nRejection date: [^\n]+/g, '')
        .replace(/Test ran for \d+s/g, 'Test ran for Xs');
}

/** Groups per-run outcomes into one entry per test. */
function aggregateFailures(
    timings: readonly TestTiming[],
    runsPerJobName: ReadonlyMap<string, number>,
    successfulTestJobs: readonly TreeherderJob[]
): TryFailure[] {
    // A test that passed when the harness reran it inside the same job is
    // intermittent almost by definition (`try.html:1393`). Keyed by run, since
    // the same test can pass on rerun in one job and fail outright in another.
    const passedOnRerunByRun = new Map<string, Set<string>>();
    for (const timing of timings) {
        if (!timing.isRerun || !timing.status.startsWith('PASS')) {
            continue;
        }
        const key = runKeyOf(timing);
        let set = passedOnRerunByRun.get(key);
        if (set === undefined) {
            set = new Set();
            passedOnRerunByRun.set(key, set);
        }
        set.add(timing.path);
    }

    const successfulJobNames = new Set(successfulTestJobs.map((job) => job.jobName));

    interface Accumulator {
        path: string;
        jobNames: Set<string>;
        failedRunKeys: Set<string>;
        messages: Map<string, number>;
        statuses: Set<string>;
        passedOnRerun: boolean;
        modes: Set<string>;
    }
    const byTest = new Map<string, Accumulator>();

    for (const timing of timings) {
        if (!isFailureStatus(timing.status)) {
            continue;
        }
        let entry = byTest.get(timing.path);
        if (entry === undefined) {
            entry = {
                path: timing.path,
                jobNames: new Set(),
                failedRunKeys: new Set(),
                messages: new Map(),
                statuses: new Set(),
                passedOnRerun: false,
                modes: new Set(),
            };
            byTest.set(timing.path, entry);
        }
        entry.jobNames.add(timing.jobName);
        entry.failedRunKeys.add(runKeyOf(timing));
        entry.statuses.add(timing.status);
        if (timing.message !== null) {
            entry.messages.set(timing.message, (entry.messages.get(timing.message) ?? 0) + 1);
        }
        if (passedOnRerunByRun.get(runKeyOf(timing))?.has(timing.path) === true) {
            entry.passedOnRerun = true;
        }
        const suffix = /-(PARALLEL|SEQUENTIAL)$/.exec(timing.status)?.[1];
        entry.modes.add(suffix ?? 'UNRECORDED');
    }

    const failures: TryFailure[] = [];
    for (const entry of byTest.values()) {
        const totalRuns = [...entry.jobNames].reduce(
            (sum, jobName) => sum + (runsPerJobName.get(jobName) ?? 0),
            0
        );
        const failedRuns = entry.failedRunKeys.size;
        failures.push({
            path: entry.path,
            jobNames: [...entry.jobNames].sort(),
            failedRuns,
            totalRuns,
            // Every run of every affected config failed, and no config of this
            // test succeeded outright. The second half matters: a config with
            // a fully-successful run of the same job name means the failure is
            // not deterministic there.
            everyRunFailed:
                totalRuns > 0 &&
                failedRuns >= totalRuns &&
                ![...entry.jobNames].some((jobName) => successfulJobNames.has(jobName)),
            passedOnRerun: entry.passedOnRerun,
            messages: [...entry.messages]
                .sort((a, b) => b[1] - a[1])
                .map(([message]) => message),
            // A timeout or a crash records no message anywhere — not in the
            // push and not in the aggregates (`FORMATS.md`) — so for those the
            // status kind is the comparison and it is a valid one. For a plain
            // FAIL with no message there is nothing to compare at all.
            messageComparable:
                entry.messages.size > 0 ||
                [...entry.statuses].some(
                    (status) => status.startsWith('TIMEOUT') || status.startsWith('CRASH')
                ),
            statuses: [...entry.statuses].sort(),
            parallelOnly: entry.modes.size === 1 && entry.modes.has('PARALLEL'),
            central: null,
        });
    }
    return failures.sort(
        (a, b) => b.failedRuns - a.failedRuns || a.path.localeCompare(b.path)
    );
}

// --- central comparison ---------------------------------------------------

/**
 * Fills in each failure's central history from the 21-day aggregates.
 *
 * Reads the bucket file each failing test hashes into. Failing tests cluster
 * by directory and the hash is over the full path, so this is not
 * one-file-per-test in practice, but the worst case is bounded at 64 per
 * harness and the files are cached.
 *
 * The same-message rate is what makes the comparison meaningful: `CLI.md` is
 * explicit that a test already failing 8% on central *with a different
 * message* is not exonerated.
 */
async function attachCentralHistory(
    context: CommandContext,
    failures: readonly TryFailure[]
): Promise<void> {
    // Group by (harness, bucket) so each file is fetched once.
    const wanted = new Map<string, { harness: string; suffix: string; failures: TryFailure[] }>();
    for (const failure of failures) {
        const harness = detectHarness(failure.path);
        const suffix = bucketFileSuffix(bucketIndexForPath(failure.path));
        const key = `${harness}-${suffix}`;
        let group = wanted.get(key);
        if (group === undefined) {
            group = { harness, suffix, failures: [] };
            wanted.set(key, group);
        }
        group.failures.push(failure);
    }

    for (const group of wanted.values()) {
        let file: BucketFile;
        try {
            file = await fetchJson<BucketFile>(context.source, {
                index: timingsIndex(group.harness),
                filename: `${group.harness}-${group.suffix}.json`,
            });
        } catch (error) {
            // Central history is an enrichment, not the answer. Losing it
            // downgrades every failure in this bucket to "unknown on central"
            // rather than failing the command — and the warning says so, so
            // the missing comparison is visible rather than read as "never
            // failed on central".
            warn(
                context,
                `could not read central history for ${group.harness}-${group.suffix}.json: ` +
                    `${(error as Error).message}`
            );
            continue;
        }
        const decoded = decodeBucket(file);
        for (const failure of group.failures) {
            const identity = decoded.findTest(failure.path);
            if (identity === null) {
                // Not in central data at all. Left as `null`, which the
                // renderer prints as "no central data", distinct from
                // "0 failures on central".
                continue;
            }
            const stats = computeTestStats(decoded, identity.testId);
            const configs = computeConfigStats(decoded, identity.testId, {
                tryMessages: failure.messages,
                // A timeout or a crash records no message at all
                // (`FORMATS.md`), so for those the status kind stands in for
                // one — otherwise every timeout would count as a different
                // failure from the timeout on central.
                matchAnyTimeout: failure.statuses.some((status) => status.startsWith('TIMEOUT')),
                matchAnyCrash: failure.statuses.some((status) => status.startsWith('CRASH')),
            });
            const failCount = stats.failCount + stats.timeoutCount + stats.crashCount;
            const sameMessageFailCount = configs.reduce(
                (sum, config) => sum + config.sameMsgFailCount,
                0
            );
            const worst = configs.find((config) => config.failCount > 0) ?? null;
            failure.central = {
                runCount: stats.runCount,
                failCount,
                failRate: stats.runCount > 0 ? (failCount / stats.runCount) * 100 : null,
                sameMessageFailCount,
                sameMessageFailRate:
                    stats.runCount > 0 ? (sameMessageFailCount / stats.runCount) * 100 : null,
                worstConfig:
                    worst === null
                        ? null
                        : {
                              jobName: worst.jobName,
                              failRate: worst.failRate,
                              sameMsgFailRate: worst.sameMsgFailRate,
                          },
                known: true,
            };
        }
    }
}

/** Attaches task IDs and profile URLs to each failure. */
function attachProvenance(
    failures: readonly TryFailure[],
    timings: readonly TestTiming[],
    withTaskIds: boolean,
    withProfiles: boolean
): void {
    const byPath = new Map<string, TestTiming[]>();
    for (const timing of timings) {
        if (!isFailureStatus(timing.status)) {
            continue;
        }
        const list = byPath.get(timing.path) ?? [];
        list.push(timing);
        byPath.set(timing.path, list);
    }
    for (const failure of failures) {
        const list = byPath.get(failure.path) ?? [];
        if (withTaskIds) {
            failure.taskIds = list.map((timing) => ({
                taskId: timing.taskId,
                retryId: timing.retryId,
                jobName: timing.jobName,
            }));
        }
        if (withProfiles) {
            const seen = new Set<string>();
            failure.profiles = [];
            for (const timing of list) {
                const key = runKeyOf(timing);
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                const row: NonNullable<TryFailure['profiles']>[number] = {
                    taskId: timing.taskId,
                    retryId: timing.retryId,
                    resourceUsage: resourceUsageProfileUrl(timing.taskId, timing.retryId),
                };
                // Only when the message actually names one. `CLI.md`: emit
                // nothing rather than guess a filename.
                const testProfile = uploadedProfileUrl(
                    timing.taskId,
                    timing.retryId,
                    timing.message
                );
                if (testProfile !== null) {
                    row.testProfile = testProfile;
                }
                failure.profiles.push(row);
            }
        }
    }
}

// --- rendering -----------------------------------------------------------

/** How central compares, as one line. */
function centralLine(failure: TryFailure): string {
    const central = failure.central;
    if (central === null) {
        return 'No central data for this test in the 21-day window';
    }
    if (central.failCount === 0) {
        return `Never failed on central in 21 days (0/${central.runCount} runs)`;
    }
    const overall = `${percent(central.failRate)} on central (${central.failCount}/${central.runCount})`;
    if (!failure.messageComparable) {
        // Saying "0.0% with the same message" here would be a measurement of
        // nothing presented as a measurement of something.
        return `${overall}; this push recorded no failure message, so it cannot be compared`;
    }
    // Both rates: the overall one says "this test is flaky", the same-message
    // one says "it is flaky *this way*", and only the second exonerates.
    return (
        `${overall}, ` +
        `${percent(central.sameMessageFailRate)} with the same message ` +
        `(${central.sameMessageFailCount})`
    );
}

/**
 * The "same message" column, which must not print a rate it does not have.
 *
 * `n/a` when there is no central data; `?` when the push recorded no message,
 * so 0 would mean "nothing to compare" while reading as "a different failure".
 */
function sameMessageCell(failure: TryFailure): string {
    if (failure.central === null) {
        return 'n/a';
    }
    if (!failure.messageComparable) {
        return '?';
    }
    return percent(failure.central.sameMessageFailRate);
}

/** Plain text, as `CLI.md` lays it out. */
function renderText(
    result: TryJson,
    limit: number,
    permaOnly: boolean,
    allJobs: boolean
): string {
    const lines: (string | null)[] = [];
    lines.push(
        `Try push ${result.revision.slice(0, 12)} (${result.project}) — ` +
            `${result.jobCount} jobs, ${result.failedJobCount} failed`
    );
    lines.push('Compared against 21 days of mozilla-central history.');
    lines.push(result.treeherderUrl);

    if (
        result.permaFails.length === 0 &&
        result.knownIntermittents.length === 0 &&
        result.newIntermittents.length === 0
    ) {
        lines.push('');
        lines.push('No test-level failures found.');
        if (result.unblamedJobCount > 0) {
            lines.push(
                `${result.unblamedJobCount} failed test jobs had no test-level failure ` +
                    `attributed to them (harness crash, or no profile).`
            );
        }
        if (result.otherFailedJobs.length > 0) {
            lines.push(
                `${result.otherFailedJobs.length} non-test jobs failed ` +
                    `(--all-jobs to list them).`
            );
        }
        return joinLines(lines);
    }

    lines.push('');
    lines.push(...section(
        'PERMA-FAILS',
        result.permaFails,
        'fail in every run on the affected config, and were not failing on central. ' +
            'These are almost certainly yours.',
        limit
    ));

    if (!permaOnly) {
        lines.push('');
        lines.push(
            ...compactSection(
                'KNOWN INTERMITTENTS',
                result.knownIntermittents,
                'also fail on central; likely not yours.',
                limit
            )
        );
        lines.push('');
        lines.push(
            ...compactSection(
                'NEW INTERMITTENTS',
                result.newIntermittents,
                'failed here, never on central. Worth a look.',
                limit
            )
        );
    }

    if (result.unblamedJobCount > 0) {
        lines.push('');
        lines.push(
            `${result.unblamedJobCount} failed test jobs had no test-level failure attributed`
        );
        lines.push(
            '  to them — a harness crash, or a profile that could not be read. Check them on'
        );
        lines.push('  Treeherder; this command cannot say what failed in them.');
    }

    if (allJobs && result.otherFailedJobs.length > 0) {
        lines.push('');
        lines.push(`OTHER FAILED JOBS (${result.otherFailedJobs.length})`);
        const shown = applyLimit(result.otherFailedJobs, limit);
        for (const job of shown) {
            lines.push(`  ${job.result.padEnd(10)} ${job.jobName}  ${job.taskId}`);
        }
        lines.push(moreLine(result.otherFailedJobs.length, shown.length));
    } else if (result.otherFailedJobs.length > 0) {
        lines.push('');
        lines.push(
            `${result.otherFailedJobs.length} non-test jobs also failed (--all-jobs to list).`
        );
    }

    return joinLines(lines);
}

/** The detailed section — perma-fails get every fact. */
function section(
    title: string,
    failures: readonly TryFailure[],
    description: string,
    limit: number
): string[] {
    const lines: string[] = [`${title} (${failures.length}) — ${description}`];
    if (failures.length === 0) {
        lines.push('  (none)');
        return lines;
    }
    const shown = applyLimit(failures, limit);
    for (const failure of shown) {
        lines.push('');
        lines.push(`  ${failure.path}`);
        lines.push(
            `    fails on ${failure.jobNames.length === 1 ? failure.jobNames[0] : `${failure.jobNames.length} configs`}` +
                ` (${failure.failedRuns}/${failure.totalRuns} runs)`
        );
        if (failure.jobNames.length > 1) {
            for (const jobName of failure.jobNames.slice(0, 4)) {
                lines.push(`      ${jobName}`);
            }
            if (failure.jobNames.length > 4) {
                lines.push(`      … ${failure.jobNames.length - 4} more configs`);
            }
        }
        lines.push(`    ${centralLine(failure)}`);
        if (failure.passedOnRerun) {
            lines.push('    Passed when the harness reran it in the same job — intermittent.');
        }
        if (failure.parallelOnly) {
            lines.push(
                '    Only failed under parallel execution — likely racing with its neighbours.'
            );
        }
        for (const message of failure.messages.slice(0, 2)) {
            lines.push(`    ${truncate(message.replace(/\s*\n\s*/g, ' ⏎ '), 110)}`);
        }
        if (failure.taskIds !== undefined) {
            for (const entry of failure.taskIds.slice(0, 5)) {
                lines.push(`    task ${entry.taskId}.${entry.retryId}  ${entry.jobName}`);
            }
        }
        if (failure.profiles !== undefined) {
            for (const entry of failure.profiles.slice(0, 5)) {
                lines.push(`    profile ${entry.resourceUsage}`);
                if (entry.testProfile !== undefined) {
                    lines.push(`    test profile ${entry.testProfile}`);
                }
            }
        }
    }
    const more = moreLine(failures.length, shown.length);
    if (more !== null) {
        lines.push(more);
    }
    return lines;
}

/** The compact sections — one line each, as `CLI.md` shows. */
function compactSection(
    title: string,
    failures: readonly TryFailure[],
    description: string,
    limit: number
): string[] {
    const lines: string[] = [`${title} (${failures.length}) — ${description}`];
    if (failures.length === 0) {
        lines.push('  (none)');
        return lines;
    }
    const shown = applyLimit(failures, limit);
    lines.push(
        ...table(
            [
                { header: 'test', maxWidth: 60 },
                { header: 'here', align: 'right' },
                { header: 'central', align: 'right' },
                { header: 'same msg', align: 'right' },
            ],
            shown.map((failure) => [
                failure.path,
                `${failure.failedRuns}/${failure.totalRuns}`,
                failure.central === null ? 'n/a' : percent(failure.central.failRate),
                sameMessageCell(failure),
            ])
        )
    );
    for (const failure of shown) {
        if (failure.passedOnRerun) {
            lines.push(`    ${failure.path}: passed on harness rerun`);
        }
    }
    const more = moreLine(failures.length, shown.length);
    if (more !== null) {
        lines.push(more);
    }
    return lines;
}

/** Markdown, for pasting into a bug or PR. */
function renderMarkdown(
    result: TryJson,
    limit: number,
    permaOnly: boolean,
    allJobs: boolean
): string {
    const lines: (string | null)[] = [];
    lines.push(md.heading(`Try push ${result.revision.slice(0, 12)} (${result.project})`, 1));
    lines.push('');
    lines.push(
        `${result.jobCount} jobs, ${result.failedJobCount} failed. ` +
            `Compared against 21 days of mozilla-central history.`
    );
    lines.push('');
    lines.push(`[View on Treeherder](${result.treeherderUrl})`);

    const sections: [string, readonly TryFailure[], string][] = permaOnly
        ? [['Perma-fails', result.permaFails, 'Fail in every run on the affected config, and were not failing on central.']]
        : [
              ['Perma-fails', result.permaFails, 'Fail in every run on the affected config, and were not failing on central.'],
              ['Known intermittents', result.knownIntermittents, 'Also fail on central; likely not yours.'],
              ['New intermittents', result.newIntermittents, 'Failed here, never on central.'],
          ];

    for (const [title, failures, description] of sections) {
        lines.push('');
        lines.push(md.heading(`${title} (${failures.length})`));
        lines.push('');
        lines.push(`_${description}_`);
        lines.push('');
        if (failures.length === 0) {
            lines.push('None.');
            continue;
        }
        const shown = applyLimit(failures, limit);
        lines.push(
            ...md.table(
                [
                    { header: 'Test' },
                    { header: 'Configs', align: 'right' },
                    { header: 'Here', align: 'right' },
                    { header: 'Central', align: 'right' },
                    { header: 'Same message', align: 'right' },
                    { header: 'Message' },
                ],
                shown.map((failure) => [
                    failure.path,
                    String(failure.jobNames.length),
                    `${failure.failedRuns}/${failure.totalRuns}`,
                    failure.central === null ? 'n/a' : percent(failure.central.failRate),
                    sameMessageCell(failure),
                    truncate(failure.messages[0] ?? '', 120),
                ])
            )
        );
        lines.push(md.moreLine(failures.length, shown.length));
    }

    if (allJobs && result.otherFailedJobs.length > 0) {
        lines.push('');
        lines.push(md.heading(`Other failed jobs (${result.otherFailedJobs.length})`));
        lines.push('');
        lines.push(
            ...md.table(
                [{ header: 'Result' }, { header: 'Job' }, { header: 'Task' }],
                applyLimit(result.otherFailedJobs, limit).map((job) => [
                    job.result,
                    job.jobName,
                    job.taskId,
                ])
            )
        );
    }

    return joinLines(lines);
}
