/**
 * Treeherder push and job lookup.
 *
 * Extracted from `old/try.html:759` (`fetchPushId`, `fetchAllJobs`, `parseJobs`)
 * and `fetch-utils.js:92`, which are two copies of the same three requests. Both
 * `try.html` and `fx-tests try` need this, and neither should own it.
 *
 * Unlike everything else in `lib/sources/`, this is not a `DataSource`: it
 * reads a paginated JSON API rather than named artifacts, and the shape of the
 * answer is a push and its jobs rather than bytes. It takes the same injected
 * `FetchLike` so that `lib/` still calls no global `fetch` and so no test hits
 * the network.
 *
 * ## The job encoding, and why `job_property_names` matters
 *
 * `/api/jobs/` does not return objects. It returns `results`, an array of
 * **arrays**, plus `job_property_names`, the field names those arrays are
 * positional against. So field access is `job[propertyNames.indexOf('task_id')]`
 * — and if a name is absent, `indexOf` returns `-1`, which indexes as
 * `undefined` and silently produces a job with no task ID.
 *
 * `old/try.html:791` does exactly that and then drops such jobs with
 * `if (!jobName || !taskId) continue;`, so a Treeherder field rename would
 * present as "the push has no jobs" rather than as an error. Here a missing
 * required field throws once, up front, naming the field.
 *
 * ## Pagination
 *
 * `/api/jobs/?push_id=` is paginated and the page size is Treeherder's choice;
 * a large push runs to several pages. The `next` field carries the whole next
 * URL, so following it is the pagination — but it is an *absolute URL from
 * Treeherder*, which is why `maxPages` exists: a malformed `next` that pointed
 * at itself would otherwise loop forever against someone else's server.
 */

import type { FetchLike } from './http.ts';

/** Treeherder's origin. */
export const TREEHERDER_ROOT = 'https://treeherder.mozilla.org';

/** What `treeherderClient` needs. */
export interface TreeherderOptions {
    /** How requests are made. Required — `lib/` has no global `fetch`. */
    fetch: FetchLike;
    /** Overrides the origin, for a test or a staging instance. */
    root?: string | undefined;
    /**
     * A safety limit on pagination. Reached means something is wrong with
     * `next`, not that a push has a million jobs, so it throws rather than
     * truncating: a silently-short job list would read as "these tests did not
     * run".
     */
    maxPages?: number | undefined;
}

/** A push, as Treeherder describes it. */
export interface Push {
    /** The numeric push ID that `/api/jobs/?push_id=` takes. */
    pushId: number;
    /** The revision as requested, which may be a 12-character prefix. */
    revision: string;
    /** The repository (`try`, `autoland`, `mozilla-central`, …). */
    repository: string;
    /** The commits in the push, newest first. Empty when not returned. */
    revisions: PushRevision[];
}

/** One commit in a push. */
export interface PushRevision {
    revision: string;
    author: string;
    comments: string;
}

/**
 * One job of a push, with the positional array already resolved to fields.
 *
 * `retryId` is the **job-level** retry — Taskcluster's `runs/<n>` — and pairs
 * with `taskId` to make the `"<taskId>.<retryId>"` key the timing files use.
 * It is not the harness's within-job rerun; `lib/model/execution.ts` owns that
 * distinction and `PLAN.md` §1 warns about conflating them.
 */
export interface TreeherderJob {
    /** Treeherder's own job ID, for `/api/project/…/jobs/<id>/bug_suggestions/`. */
    jobId: number;
    /** e.g. `test-linux2404-64/debug-xpcshell-3`. */
    jobName: string;
    taskId: string;
    retryId: number;
    /** `completed`, `running`, `pending`. */
    state: string;
    /** `success`, `testfailed`, `busted`, `exception`, `retry`, `unknown`. */
    result: string;
}

/**
 * Treeherder results that mean the job did not pass.
 *
 * From `old/try.html:814`. `retry` is deliberately **not** here: a retried job was
 * superseded by another run of the same task, and counting it as a failure
 * double-counts an infrastructure hiccup as a test failure.
 */
export const FAILED_JOB_RESULTS: ReadonlySet<string> = new Set([
    'testfailed',
    'busted',
    'exception',
]);

/** Whether a job's result means it failed. */
export function isFailedJob(job: TreeherderJob): boolean {
    return FAILED_JOB_RESULTS.has(job.result);
}

/** Thrown when Treeherder answers with something this module cannot read. */
export class TreeherderError extends Error {
    readonly url: string | undefined;
    readonly status: number | undefined;

    constructor(message: string, url?: string, status?: number) {
        super(message);
        this.name = 'TreeherderError';
        this.url = url;
        this.status = status;
    }
}

/** Thrown when no push matches a revision — a real answer, not a failure. */
export class PushNotFoundError extends Error {
    readonly revision: string;
    readonly repository: string;

    constructor(revision: string, repository: string) {
        super(`no push found for revision ${revision} on ${repository}`);
        this.name = 'PushNotFoundError';
        this.revision = revision;
        this.repository = repository;
    }
}

/** Push and job lookup against one Treeherder deployment. */
export interface TreeherderClient {
    /** Resolves a revision to its push. Throws `PushNotFoundError` if there is none. */
    findPush(repository: string, revision: string): Promise<Push>;
    /** Every job of a push, following pagination to the end. */
    jobsOfPush(pushId: number): Promise<TreeherderJob[]>;
}

/** Builds a client over an injected fetch. */
export function treeherderClient(options: TreeherderOptions): TreeherderClient {
    const root = options.root ?? TREEHERDER_ROOT;
    const maxPages = options.maxPages ?? 100;

    async function getJson<T>(url: string): Promise<T> {
        let response;
        try {
            response = await options.fetch(url);
        } catch (error) {
            throw new TreeherderError(
                `request to Treeherder failed: ${(error as Error).message}`,
                url
            );
        }
        if (!response.ok) {
            throw new TreeherderError(
                `Treeherder returned HTTP ${response.status}`,
                url,
                response.status
            );
        }
        const text = new TextDecoder().decode(await response.arrayBuffer());
        try {
            return JSON.parse(text) as T;
        } catch (error) {
            throw new TreeherderError(
                `Treeherder response is not valid JSON: ${(error as Error).message}`,
                url
            );
        }
    }

    return {
        async findPush(repository: string, revision: string): Promise<Push> {
            // `full=true` is what returns the `revisions` array; `count=10`
            // is inherited from `old/try.html:760` — a revision prefix can in
            // principle match more than one push, and the first is taken.
            const url =
                `${root}/api/project/${encodeURIComponent(repository)}/push/` +
                `?full=true&count=10&revision=${encodeURIComponent(revision)}`;
            const data = await getJson<{
                results?: {
                    id?: number;
                    revision?: string;
                    revisions?: PushRevision[];
                }[];
            }>(url);

            const first = data.results?.[0];
            if (first === undefined) {
                throw new PushNotFoundError(revision, repository);
            }
            if (typeof first.id !== 'number') {
                throw new TreeherderError(
                    `push for ${revision} has no numeric id`,
                    url
                );
            }
            return {
                pushId: first.id,
                revision: first.revision ?? revision,
                repository,
                revisions: first.revisions ?? [],
            };
        },

        async jobsOfPush(pushId: number): Promise<TreeherderJob[]> {
            const jobs: TreeherderJob[] = [];
            let url: string | null = `${root}/api/jobs/?push_id=${pushId}`;
            let propertyNames: string[] | null = null;
            let pages = 0;

            while (url !== null) {
                if (++pages > maxPages) {
                    throw new TreeherderError(
                        `job listing for push ${pushId} exceeded ${maxPages} pages; ` +
                            `refusing to keep following "next"`,
                        url
                    );
                }
                const data: {
                    results?: unknown[][];
                    job_property_names?: string[];
                    next?: string | null;
                } = await getJson(url);

                // Treeherder does repeat `job_property_names` on every page —
                // verified on page 2 of push 1991182 — so holding the first
                // page's is not strictly required. It is kept because the
                // alternative is trusting that every page agrees: re-reading
                // them per page would silently re-map the columns if one ever
                // differed, where this decodes every page against the layout
                // the first one declared and cannot drift mid-push.
                propertyNames ??= data.job_property_names ?? null;
                if (propertyNames === null) {
                    throw new TreeherderError(
                        `Treeherder returned jobs with no job_property_names, ` +
                            `so the positional rows cannot be decoded`,
                        url
                    );
                }
                const columns = jobColumns(propertyNames, url);
                for (const row of data.results ?? []) {
                    jobs.push(readJob(row, columns));
                }
                url = data.next ?? null;
            }
            return jobs;
        },
    };
}

/** The column indices of the fields a `TreeherderJob` needs. */
interface JobColumns {
    jobId: number;
    jobName: number;
    taskId: number;
    retryId: number;
    state: number;
    result: number;
}

/**
 * Resolves field names to column indices, throwing if a required one is
 * missing.
 *
 * The check `try.html` does not do. `indexOf` returning `-1` reads as
 * `undefined` at access time, which the page then filters out — turning a
 * renamed Treeherder field into an empty push rather than into an error.
 */
function jobColumns(propertyNames: readonly string[], url: string): JobColumns {
    const required = ['id', 'job_type_name', 'task_id', 'retry_id', 'state', 'result'] as const;
    const missing = required.filter((name) => !propertyNames.includes(name));
    if (missing.length > 0) {
        throw new TreeherderError(
            `Treeherder's job_property_names is missing ${missing.join(', ')}; ` +
                `got: ${propertyNames.join(', ')}`,
            url
        );
    }
    return {
        jobId: propertyNames.indexOf('id'),
        jobName: propertyNames.indexOf('job_type_name'),
        taskId: propertyNames.indexOf('task_id'),
        retryId: propertyNames.indexOf('retry_id'),
        state: propertyNames.indexOf('state'),
        result: propertyNames.indexOf('result'),
    };
}

/** Reads one positional row into a job. */
function readJob(row: readonly unknown[], columns: JobColumns): TreeherderJob {
    return {
        jobId: Number(row[columns.jobId] ?? 0),
        jobName: String(row[columns.jobName] ?? ''),
        taskId: String(row[columns.taskId] ?? ''),
        // A null `retry_id` means run 0, which is how Treeherder writes the
        // first run of a task.
        retryId: Number(row[columns.retryId] ?? 0),
        state: String(row[columns.state] ?? ''),
        result: String(row[columns.result] ?? ''),
    };
}

/**
 * The timings jobs of a push, by harness.
 *
 * Ported from `findTimingsJobsForRevision()` (`fetch-utils.js:92`). A try push
 * that ran `{harness}-timings-rev` produces the same file families as the
 * nightly index task, for that push alone — which is how `try.html` compares a
 * push against central using the same decoders.
 *
 * Keeps the **last** matching completed job, as the original does: a re-triggered
 * timings job supersedes the earlier one, and the list is in push order.
 */
export function findTimingsJobs(jobs: Iterable<TreeherderJob>): Map<string, string> {
    const found = new Map<string, string>();
    for (const job of jobs) {
        if (job.state !== 'completed' || !job.jobName || !job.taskId) {
            continue;
        }
        const match = /(\w+)-timings-rev$/.exec(job.jobName);
        if (match?.[1] !== undefined) {
            found.set(match[1], job.taskId);
        }
    }
    return found;
}
