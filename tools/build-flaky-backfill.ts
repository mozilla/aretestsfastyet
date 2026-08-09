/**
 * Builds `{harness}-flaky-backfill.json` — months of per-day flaky / stable /
 * skipped counts for the two charts at the top of `flaky.html`.
 *
 * The page reads `{harness}-issues.json`, which is the **21-day** aggregate, so
 * without this the charts are 21 days wide and the questions they exist to
 * answer — is the tree getting better, is the test count growing — are not
 * askable. The pattern is the one `site/index.ts` already uses for
 * `mochitest-stats-backfill.json`: fetch a committed file next to the page,
 * merge it into the live artifact, warn on any overlapping date the two
 * disagree about.
 *
 * Usage: `node --experimental-strip-types tools/build-flaky-backfill.ts`
 *   `--harness xpcshell|mochitest|both` (default `both`)
 *   `--from YYYY-MM-DD` / `--to YYYY-MM-DD` — clamp the span
 *   `--out DIR` — where the JSON goes (default the repository root)
 *
 * ## Where the history comes from
 *
 * Two Taskcluster index routes publish the same task's artifacts:
 *
 * - `index.gecko.v2.mozilla-central.latest.source.test-info-{harness}-timings`
 *   — whatever ran most recently. This is what the *page* fetches.
 * - `index.gecko.v2.mozilla-central.pushdate.YYYY.MM.DD.latest.source.test-info-{harness}-timings`
 *   — the run for one push date. This is what makes history reachable.
 *
 * Each pushdate task carries `{harness}-issues.json` (its own 21-day aggregate,
 * ending on that date) **and** the 21 `{harness}-<date>.json` daily files that
 * went into it. This tool reads the aggregate, for two reasons and not for the
 * obvious one:
 *
 * - it is 21 days per fetch instead of one, so a year costs ~18 requests per
 *   harness rather than ~365 — measured, xpcshell `-issues.json` is 13 MB and a
 *   daily file is 17 MB, so per *day of history* the aggregate is about 27×
 *   cheaper in bytes as well as in requests;
 * - **the noise filter needs a window.** See below; this is the load-bearing
 *   reason.
 *
 * ## Why the stride is 21 days, exactly
 *
 * `lib/query/flakiness.ts`'s noise filter reads a test's failures over the
 * *whole file* and, if they total `minWindowFailures` or fewer, counts them as
 * passes. That is a **window** rule applied to per-day figures, deliberately —
 * "was this one unlucky run?" cannot be answered from inside one day — and
 * `MIN_FILTERABLE_DAYS` records what happens when the window is one day: the
 * same 2026-08-04 reads 923 flaky inside a 21-day aggregate and 562 as a
 * standalone daily file, a 39% gap.
 *
 * So a backfilled day must be classified over a window the same *length* as the
 * live page's, or the joined series steps at the seam. Fetching aggregates whose
 * end dates are 21 days apart gives every backfilled day exactly one 21-day
 * window — the same rule, the same threshold, no overlap to reconcile.
 *
 * ## De-duplication is by date, never by sum
 *
 * The stride is 21 days but the *available* pushdates are not evenly spaced (no
 * push, no task), so windows sometimes overlap and the same date arrives twice.
 * Overlapping windows are **de-duplicated by date, keeping the newer window's
 * reading**, and never added together. `lib/formats/FORMATS.md` and the header
 * of `lib/query/issues.ts` both record the mistake this avoids: two encodings of
 * the same 21 days have byte-identical totals, so summing across them multiplies
 * the population by the number of ways it was written down.
 *
 * The two readings of a shared date are not identical, because their noise
 * windows differ — a test that failed once in window A may have failed twice in
 * window B. Measured on xpcshell 2026-02-09 vs 2026-02-11, which share 19 days:
 * the flaky counts differ by 0–24 tests a day (median 2, worst 2026-01-23:
 * 1719 vs 1797, 4.5%). That is the filter's window moving, not a decoding
 * disagreement, and it is why the tool reports the spread rather than asserting
 * the windows agree.
 *
 * ## What retention actually allows, measured 2026-08-09
 *
 * Artifacts expire a year after the task, and the index entry expires with them,
 * so "a year" is the ceiling. Both harnesses fall short of it for their own
 * reasons:
 *
 * | harness | earliest usable pushdate | why not earlier |
 * | --- | --- | --- |
 * | xpcshell | **2025-12-15** | 2025-12-14 and earlier index entries exist (back to 2025-11-01, expiring 2026-11-02) but have **no `-issues.json`** — only daily files. The aggregate was not published yet. |
 * | mochitest | **2026-01-31** | no pushdate index entry at all before it; 2026-01-30 and earlier are 404. |
 *
 * ## The obsolete `hours` encoding, and why it is handled here
 *
 * Aggregates published up to **2026-02-09** carry `hours` on each status group
 * where current ones carry `days`: a delta-encoded count of hours from
 * `metadata.startTime`, so the day a run landed on is `floor(cumulative / 24)`.
 * `lib/formats/status-entries.ts` knows five shapes and none of them is this
 * one, so `decodeIssues` throws `UnknownStatusGroupShapeError` on those files.
 *
 * The semantics were **measured, not assumed**: across 2,401,754 entries of the
 * 2025-12-15 xpcshell aggregate the deltas are non-negative and the cumulative
 * maximum is 503, against 21 × 24 = 504. The reading was then checked against an
 * independently generated file — the 2026-02-11 aggregate, which is in the
 * `days` encoding and shares 18 dates with 2026-02-09 — and the two agree to
 * within 0–24 tests a day on the shared dates, the same spread two `days`-format
 * windows show. So `floor(hours / 24)` is the day index.
 *
 * The conversion lives **in this tool and not in `lib/`** on purpose. The
 * encoding stopped being published six months ago, so adding a sixth shape to
 * the decoder every page runs would put a permanent branch on a live path to
 * serve one offline tool. The tool rewrites `hours` into the `days` the decoder
 * already understands and then calls the *real* `decodeIssues` and
 * `flakinessOverTime`, so the numbers it commits come from the same code the
 * page runs — which is the property that matters at the seam.
 *
 * ## What is committed
 *
 * One row per date: `{ date, flaky, stable, skipped, total }`, four integers and
 * a string. Raw artifacts are never committed — they are 13 MB each.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { decodeIssues, type IssuesFile } from '../lib/formats/issues.ts';
import {
    DEFAULT_MIN_WINDOW_FAILURES,
    flakinessOverTime,
} from '../lib/query/flakiness.ts';
import type { FlakyBackfillFile, FlakyBackfillRow } from '../lib/formats/flaky-backfill.ts';
import { BACKFILL_WINDOW_DAYS } from '../lib/formats/flaky-backfill.ts';

const INDEX = 'https://firefox-ci-tc.services.mozilla.com/api/index/v1/task';
const QUEUE = 'https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task';

/** The harnesses that publish a `test-info-{harness}-timings` task. */
const HARNESSES = ['xpcshell', 'mochitest'] as const;
type Harness = (typeof HARNESSES)[number];

/**
 * The earliest pushdate worth asking for, per harness.
 *
 * Not a guess and not a retention figure: these are the dates measured on
 * 2026-08-09 (see the header table) where `-issues.json` first becomes
 * fetchable. Earlier dates are skipped rather than probed, because probing them
 * costs one request each and the answer does not change until retention moves
 * the floor *up*.
 *
 * The floor moving up is the expected failure: a re-run six months from now will
 * find these 404 and log them, which is the right outcome — the tool reports
 * what it actually got rather than the span it was asked for.
 */
const EARLIEST: Record<Harness, string> = {
    xpcshell: '2025-12-15',
    mochitest: '2026-01-31',
};

/** How far forward of a missing pushdate to look, in days. */
const PROBE_FORWARD = 6;

function toDate(iso: string): Date {
    return new Date(`${iso}T00:00:00Z`);
}

function toIso(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
    return toIso(new Date(toDate(iso).getTime() + days * 86_400_000));
}

/** The pushdate index namespace for one harness and date. */
function namespaceOf(harness: Harness, iso: string): string {
    const [year, month, day] = iso.split('-');
    return (
        `gecko.v2.mozilla-central.pushdate.${year}.${month}.${day}` +
        `.latest.source.test-info-${harness}-timings`
    );
}

/** The task the pushdate index points at, or `null` if there is no entry. */
async function taskFor(harness: Harness, iso: string): Promise<string | null> {
    const response = await fetch(`${INDEX}/${namespaceOf(harness, iso)}`);
    if (!response.ok) {
        return null;
    }
    const body = (await response.json()) as { taskId?: string };
    return body.taskId ?? null;
}

/**
 * Fetches one task's 21-day aggregate, or `null` if it does not publish one.
 *
 * A 404 here is the interesting case rather than an error: every xpcshell
 * pushdate index entry before 2025-12-15 resolves to a task that has the daily
 * files and no aggregate. See the header.
 */
async function aggregateOf(harness: Harness, taskId: string): Promise<IssuesFile | null> {
    const response = await fetch(aggregateUrl(harness, taskId));
    if (!response.ok) {
        return null;
    }
    return (await response.json()) as IssuesFile;
}

function aggregateUrl(harness: Harness, taskId: string): string {
    return `${QUEUE}/${taskId}/artifacts/public/${harness}-issues.json`;
}

/**
 * Whether a task publishes an aggregate, without downloading its 13 MB.
 *
 * A `HEAD` rather than a ranged `GET`: the artifact is served from Google
 * Storage behind a redirect and answers `HEAD` with the stored length, so the
 * probe costs two round trips and no body.
 */
async function hasAggregate(harness: Harness, taskId: string): Promise<boolean> {
    const response = await fetch(aggregateUrl(harness, taskId), { method: 'HEAD' });
    return response.ok;
}

/**
 * A status group in either encoding: current files carry `days`, files up to
 * 2026-02-09 carry `hours`. Everything else about the group is untouched.
 */
interface EitherEncoding {
    days?: number[];
    hours?: number[];
}

/**
 * Rewrites an aggregate's obsolete `hours` axis into the `days` the decoder
 * understands, in place, and reports whether it had to.
 *
 * `hours` is delta-encoded from `metadata.startTime`, so the running total is
 * kept across the group and the day is `floor(total / 24)`. The output is
 * delta-encoded too, because that is what `iterateStatusGroup` expects — it
 * accumulates `days[i]` rather than reading it absolutely.
 *
 * Two entries can land on the same day, and then the emitted delta is `0`. That
 * is legal: the decoder's accumulator handles it, and the alternative —
 * collapsing them — would need the counts merged as well and would change how
 * many entries the group has.
 */
function normaliseEncoding(file: IssuesFile): boolean {
    let converted = false;
    for (const perTest of file.testRuns) {
        if (!perTest) {
            continue;
        }
        for (const group of perTest) {
            if (group === null) {
                continue;
            }
            const either = group as unknown as EitherEncoding;
            if (either.hours === undefined || either.days !== undefined) {
                continue;
            }
            converted = true;
            let hours = 0;
            let previousDay = 0;
            const days: number[] = [];
            for (const delta of either.hours) {
                hours += delta;
                const day = Math.floor(hours / 24);
                days.push(day - previousDay);
                previousDay = day;
            }
            either.days = days;
            delete either.hours;
        }
    }
    return converted;
}

/** One aggregate's contribution: its rows, and which window they came from. */
interface Window {
    /** The aggregate's `endDate`, which is the pushdate it was fetched under. */
    endDate: string;
    rows: FlakyBackfillRow[];
    /** How many tests the noise filter neutralised over this window. */
    neutralised: number;
    /** Whether the file was in the obsolete `hours` encoding. */
    converted: boolean;
}

/**
 * Turns one aggregate into per-day rows, through the page's own code path.
 *
 * `flakinessOverTime` with the page's default threshold, on the whole file: the
 * point of the 21-day stride is that this is the identical call the page makes
 * on the live artifact, so a backfilled day and a live day are classified by the
 * same rule over the same window length.
 */
function windowOf(file: IssuesFile): Window {
    const converted = normaliseEncoding(file);
    const decoded = decodeIssues(file);
    const series = flakinessOverTime(decoded, {
        minWindowFailures: DEFAULT_MIN_WINDOW_FAILURES,
    });
    return {
        endDate: decoded.endDate,
        rows: series.days.map((day) => ({
            date: day.date,
            flaky: day.flaky,
            stable: day.stable,
            skipped: day.skipped,
            total: day.total,
        })),
        neutralised: series.neutralisedTests,
        converted,
    };
}

/** How two windows' readings of the same date differ. */
interface Overlap {
    date: string;
    kept: FlakyBackfillRow;
    dropped: FlakyBackfillRow;
}

/**
 * Merges every window into one date-keyed series, newer windows winning.
 *
 * Newer wins because the page itself is the newest window of all: keeping the
 * most recently generated reading of a date makes the backfill approach the live
 * artifact's answer as the seam gets close, rather than diverging from it.
 */
function mergeWindows(windows: Window[]): { rows: FlakyBackfillRow[]; overlaps: Overlap[] } {
    const byDate = new Map<string, FlakyBackfillRow>();
    const overlaps: Overlap[] = [];
    // Oldest first, so a later assignment is a newer window overwriting.
    const ordered = [...windows].sort((a, b) => a.endDate.localeCompare(b.endDate));
    for (const window of ordered) {
        for (const row of window.rows) {
            const existing = byDate.get(row.date);
            if (existing !== undefined && !sameRow(existing, row)) {
                overlaps.push({ date: row.date, kept: row, dropped: existing });
            }
            byDate.set(row.date, row);
        }
    }
    return {
        rows: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
        overlaps,
    };
}

function sameRow(a: FlakyBackfillRow, b: FlakyBackfillRow): boolean {
    return (
        a.flaky === b.flaky &&
        a.stable === b.stable &&
        a.skipped === b.skipped &&
        a.total === b.total
    );
}

/** A pushdate that actually publishes an aggregate. */
interface Resolved {
    pushdate: string;
    taskId: string;
}

/**
 * The first pushdate at or after `iso` that publishes an aggregate.
 *
 * **The probe is for the aggregate, not for the index entry**, and that
 * distinction cost five days of history the first time round. Stepping back 21
 * days from 2026-08-08 lands on Saturday 2025-12-20, which *has* an index entry
 * — so an existence check stopped there — but whose task has no
 * `xpcshell-issues.json`. The window was then dropped whole and the series read
 * 2025-12-21..2026-08-08 with 2025-12-16..12-20 missing, even though 2025-12-16
 * publishes one perfectly well. Asking the question the caller actually has
 * ("can I get 21 days ending near here?") costs one extra request on a miss and
 * recovers the days.
 *
 * `PROBE_FORWARD` days forward and never backward: backward would re-fetch a
 * window an earlier step already has, and a missing pushdate is a weekend, so
 * the next weekday is a day or two ahead.
 */
async function resolveNear(
    harness: Harness,
    iso: string,
    limit: string,
    taken: ReadonlySet<string>
): Promise<Resolved | null> {
    for (let forward = 0; forward <= PROBE_FORWARD; forward++) {
        const candidate = addDays(iso, forward);
        if (candidate > limit) {
            break;
        }
        if (taken.has(candidate)) {
            continue;
        }
        const taskId = await taskFor(harness, candidate);
        if (taskId === null) {
            continue;
        }
        // An index entry with no aggregate is not a usable pushdate: every
        // xpcshell entry before 2025-12-15 is exactly that.
        if (await hasAggregate(harness, taskId)) {
            return { pushdate: candidate, taskId };
        }
    }
    return null;
}

/**
 * The pushdates to fetch for one harness: `to` backwards in 21-day steps.
 *
 * Backwards from the newest, so the freshest windows are the ones that line up
 * with the seam.
 */
async function pushdatesFor(harness: Harness, from: string, to: string): Promise<Resolved[]> {
    const found: Resolved[] = [];
    const taken = new Set<string>();
    let cursor = to;
    while (cursor >= from) {
        const resolved = await resolveNear(harness, cursor, to, taken);
        if (resolved !== null) {
            found.push(resolved);
            taken.add(resolved.pushdate);
        } else {
            process.stderr.write(
                `  no ${harness} aggregate within ${PROBE_FORWARD} days of ${cursor}\n`
            );
        }
        cursor = addDays(cursor, -BACKFILL_WINDOW_DAYS);
    }
    // The stride rarely lands on the retention floor, and the days between the
    // floor and the oldest window it did land on are reachable but unfetched.
    // Measured on xpcshell: stepping back 21 days from 2026-08-08 reaches
    // 2026-01-10, whose window starts 2025-12-21, leaving the floor's own three
    // weeks behind. So the floor is asked for explicitly. Its window overlaps
    // the next one, which the date de-duplication absorbs.
    found.sort((a, b) => a.pushdate.localeCompare(b.pushdate));
    const oldest = found[0]?.pushdate;
    if (oldest !== undefined && oldest > from) {
        const floor = await resolveNear(harness, from, addDays(oldest, -1), taken);
        if (floor !== null) {
            found.unshift(floor);
        }
    }
    return found;
}

/** Builds and writes one harness's backfill. */
async function buildHarness(harness: Harness, from: string, to: string, outDir: string): Promise<void> {
    const start = from > EARLIEST[harness] ? from : EARLIEST[harness];
    process.stderr.write(`\n${harness}: pushdates ${start} .. ${to}\n`);
    const pushdates = await pushdatesFor(harness, start, to);
    process.stderr.write(`  ${pushdates.length} pushdate task(s)\n`);

    const windows: Window[] = [];
    for (const { pushdate, taskId } of pushdates) {
        const file = await aggregateOf(harness, taskId);
        if (file === null) {
            // `resolveNear` already confirmed the artifact exists, so this is a
            // transient fetch failure rather than a missing file.
            process.stderr.write(`  ${pushdate}: ${harness}-issues.json vanished on ${taskId}\n`);
            continue;
        }
        const window = windowOf(file);
        windows.push(window);
        process.stderr.write(
            `  ${pushdate}: ${window.rows.length} days ending ${window.endDate}` +
                `${window.converted ? ' (hours encoding)' : ''}, ` +
                `${window.neutralised} noise-filtered\n`
        );
    }

    if (windows.length === 0) {
        process.stderr.write(`  nothing fetched for ${harness}; not writing a file\n`);
        return;
    }

    const { rows, overlaps } = mergeWindows(windows);
    if (overlaps.length > 0) {
        // Not an error: two windows' noise filters see different failure
        // totals. Reported so a large spread is visible rather than averaged
        // away — see the header's measurement.
        const worst = overlaps.reduce((a, b) =>
            Math.abs(a.kept.flaky - a.dropped.flaky) >= Math.abs(b.kept.flaky - b.dropped.flaky)
                ? a
                : b
        );
        process.stderr.write(
            `  ${overlaps.length} date(s) read differently by two windows; ` +
                `worst ${worst.date}: flaky ${worst.dropped.flaky} -> ${worst.kept.flaky}\n`
        );
    }

    const file: FlakyBackfillFile = {
        metadata: {
            harness,
            startDate: rows[0]!.date,
            endDate: rows[rows.length - 1]!.date,
            days: rows.length,
            windowDays: BACKFILL_WINDOW_DAYS,
            minWindowFailures: DEFAULT_MIN_WINDOW_FAILURES,
            generatedAt: new Date().toISOString(),
            sourceWindows: windows.map((window) => window.endDate).sort(),
        },
        days: rows,
    };
    const target = path.join(outDir, `${harness}-flaky-backfill.json`);
    // One row per line: the file is committed, so a diff between two runs
    // should be readable as "these dates changed".
    const body = `${JSON.stringify(file, null, 1)}\n`;
    await writeFile(target, body, 'utf8');
    process.stderr.write(
        `  wrote ${target}: ${rows.length} days ${file.metadata.startDate}..` +
            `${file.metadata.endDate}, ${(body.length / 1024).toFixed(1)} kB\n`
    );
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const flag = (name: string): string | undefined => {
        const index = argv.indexOf(`--${name}`);
        return index >= 0 ? argv[index + 1] : undefined;
    };
    const which = flag('harness') ?? 'both';
    const outDir = flag('out') ?? process.cwd();
    // Yesterday by default: today's pushdate task usually has not run yet —
    // measured 2026-08-09, the 2026.08.09 namespace 404s for both harnesses
    // while 2026.08.08 resolves.
    const to = flag('to') ?? addDays(toIso(new Date()), -1);
    const from = flag('from') ?? '2025-01-01';

    const harnesses = which === 'both' ? HARNESSES : [which as Harness];
    for (const harness of harnesses) {
        if (!HARNESSES.includes(harness)) {
            throw new Error(`unknown harness ${harness}`);
        }
        await buildHarness(harness, from, to, outDir);
    }
}

await main();
