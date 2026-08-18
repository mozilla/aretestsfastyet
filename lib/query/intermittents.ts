/**
 * Ranking sheriff-annotated intermittents by the test each bug names.
 *
 * `/failures/` ranks bugs tree-wide with no harness parameter, so "the top 20
 * mochitest intermittents" is not a query. A bug is a mochitest bug when its
 * **summary names a test path that the mochitest data actually holds** — the
 * same 21-day aggregates `fx-tests test` resolves against, read once for the
 * whole run. That is a fact about a published test list, not an inference from
 * a job name.
 *
 * The alternative, reading Treeherder's `test_suite`, describes the *job* that
 * ran rather than the test that failed, and it presents an infrastructure bug
 * that fires across every job — `[taskcluster:error] Task aborted` — as a
 * mochitest intermittent. Bugs whose summary names no verifiable test are
 * therefore not classified at all, and are reported separately.
 *
 * **The depth is `maxScan`, never the display limit.** Tying it to `--limit`
 * made `--limit 1` scan one candidate, so `--json` returned one row with no
 * fuller answer for `--limit 0` to reveal.
 */

import {
    type BugFailureCount,
    type BugOccurrence,
    harnessOfOccurrence,
    stripSuiteChunk,
    summaryRemainder,
    testPathCandidates,
    testPathOfLine,
} from '../sources/intermittents.ts';
import { configFilter } from './test-stats.ts';

/** Which harness a scan is looking for. */
export type ScanHarness = 'mochitest' | 'xpcshell';

/**
 * What `--harness` selects: a harness, or the bugs that named no known test.
 *
 * `unknown` is not a harness, and that is the point — it is the third value the
 * classification takes, so it belongs on the same axis rather than on a separate
 * switch. A row is mochitest, xpcshell or unknown; the filter picks one of the
 * three, or none of them and shows all.
 */
export type HarnessSelector = ScanHarness | 'unknown';

/** Which harness a path belongs to, from the published test lists. */
export type HarnessOfPath = (path: string) => ScanHarness | null;

/**
 * One ranked bug, whatever its classification.
 *
 * A single type rather than one for classified rows and one for the rest,
 * because with no `--harness` they share a list ordered by count. What separates
 * them is `harness`, an attribute of the row rather than a precondition for
 * having one.
 */
export interface RankedIntermittent {
    bugId: number;
    /** Jobs sheriffs annotated with this bug, in the window. Treeherder's own count. */
    count: number;
    /**
     * Which harness the summary's test path belongs to, or `unknown` when the
     * summary named no test this tool holds.
     */
    harness: HarnessSelector;
    /** The verified test path, or `null` on an `unknown` row. */
    test: string | null;
    /**
     * What to say about the failure.
     *
     * On a classified row, the summary with its triage prefix and the path
     * removed — the part the other columns do not already show. On an `unknown`
     * row there is no path to remove, so this is the whole summary minus the
     * prefix, and it is everything the row has.
     */
    failure: string;
}

/** A name and how many occurrences carried it. */
export interface SuiteCount {
    name: string;
    count: number;
}

/** What the scan classified, in the window as a whole. */
export interface ScanCoverage {
    /** How many bugs the tree-wide ranking held, the no-bug group included. */
    ranked: number;
    /** How many of them carried a bug number and so could be classified. */
    scanned: number;
    /** How many named a verified mochitest test. */
    mochitest: number;
    /** How many named a verified xpcshell test. */
    xpcshell: number;
    /** How many named no test path this tool could verify. */
    unknown: number;
    /**
     * `/failures/`'s `{"bug_id": null}` group: annotations with no bug attached.
     *
     * Regularly the largest single group, and unclassifiable at any depth —
     * there is no bug, so there is no summary to read a test path from.
     */
    noBugCount: number;
}

/** A scan's result. */
export interface ScanResult {
    /** Every classified bug, count-descending, before any `--harness` filter. */
    rows: RankedIntermittent[];
    coverage: ScanCoverage;
}

/** What `scanBugs` needs from its caller. */
export interface ScanOptions {
    /** The tree-wide ranking from `/api/failures/`, count-descending. */
    ranking: readonly BugFailureCount[];
    /** Every candidate's Bugzilla summary, by bug number. */
    summaries: ReadonlyMap<number, string>;
    /** Which harness a path belongs to, from the published test lists. */
    harnessOfPath: HarnessOfPath;
}

/**
 * Classifies every bug in the ranking by the test its summary names.
 *
 * Classifies rather than filters: the `--harness` selection happens in
 * `selectHarness` afterwards, over the same rows. Splitting it that way is what
 * lets the unfiltered list rank classified and unknown bugs together — with the
 * filter inside the loop, a row had to be one or the other to exist at all.
 *
 * Synchronous, which is the shape worth noticing: classification costs no
 * per-bug request, so the whole ranking is classified rather than a prefix of
 * it. Only the `--bug` drill-down fetches per bug.
 */
export function scanBugs(options: ScanOptions): ScanResult {
    const { ranking, summaries, harnessOfPath } = options;

    const noBugCount = ranking
        .filter((row) => row.bugId === null)
        .reduce((sum, row) => sum + row.count, 0);
    // The no-bug group cannot be classified: there is no bug to read a summary
    // from. It is reported in the coverage instead.
    const candidates = ranking.filter(
        (row): row is BugFailureCount & { bugId: number } => row.bugId !== null
    );

    const rows: RankedIntermittent[] = candidates.map((candidate) => {
        const summary = summaries.get(candidate.bugId) ?? '';
        // Only the first verified path is used. A summary naming two is rare —
        // one in a live top-80, a reftest comparing a file against its
        // reference — and neither of that pair is a test this tool holds, so
        // the case resolves as unknown anyway.
        const verified = testPathCandidates(summary)
            .map((path) => ({ path, harness: harnessOfPath(path) }))
            .find((entry) => entry.harness !== null);
        return verified === undefined
            ? {
                  bugId: candidate.bugId,
                  count: candidate.count,
                  harness: 'unknown' as const,
                  test: null,
                  failure: summaryRemainder(summary, null),
              }
            : {
                  bugId: candidate.bugId,
                  count: candidate.count,
                  harness: verified.harness as ScanHarness,
                  test: verified.path,
                  failure: summaryRemainder(summary, verified.path),
              };
    });

    // Already count-descending, since `/failures/` is and the count is
    // Treeherder's own. Sorted anyway so the order is this function's contract
    // rather than an upstream detail.
    const ordered = [...rows].sort((a, b) => b.count - a.count);
    const count = (harness: HarnessSelector): number =>
        ordered.filter((row) => row.harness === harness).length;
    return {
        rows: ordered,
        coverage: {
            ranked: ranking.length,
            scanned: candidates.length,
            mochitest: count('mochitest'),
            xpcshell: count('xpcshell'),
            unknown: count('unknown'),
            noBugCount,
        },
    };
}

/**
 * The rows one `--harness` selects, or all of them when none was given.
 *
 * Separate from `scanBugs` so that "what is this bug" and "which of them do I
 * want" stay separate questions. The unfiltered answer is the whole ranking,
 * which is the honest default: the tool ranks what sheriffs annotated, and the
 * harness is one column of that.
 */
export function selectHarness(
    rows: readonly RankedIntermittent[],
    harness: HarnessSelector | undefined
): RankedIntermittent[] {
    return harness === undefined ? [...rows] : rows.filter((row) => row.harness === harness);
}

/**
 * Counts, per test path, how many occurrences named it — not how many lines.
 *
 * A job emits the marker once per failing assertion, so counting lines can
 * report a path many times more often than the population it is drawn from,
 * beside columns that are per occurrence.
 */
export function tallyTests(occurrences: readonly BugOccurrence[]): SuiteCount[] {
    return tally(
        occurrences.flatMap((row) => [
            ...new Set(
                row.lines
                    .map((line) => testPathOfLine(line))
                    .filter((path): path is string => path !== null)
            ),
        ])
    );
}

/** Counts occurrences of each name, count-descending then alphabetical. */
export function tally(names: readonly string[]): SuiteCount[] {
    const counts = new Map<string, number>();
    for (const name of names) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** How the drill-down groups one bug's occurrences. */
export interface BugDrilldown {
    bugId: number;
    /** Occurrences in the reported population — after any filter. */
    occurrences: number;
    /**
     * Every occurrence of the bug in the window, before any filter.
     *
     * Carried so the header can state the filter's effect rather than printing
     * a silently smaller number: `127 of 168` is a fact a reader can check,
     * `127` alone is not.
     */
    totalOccurrences: number;
    /**
     * Job names with the chunk number stripped, count-descending.
     *
     * The chunk is dropped because `mochitest-browser-chrome-1` through `-12`
     * are one configuration run twelve ways, and a reader asking "where does
     * this bug fail" wants one row for it, not twelve. Variant suffixes
     * (`-no-nv`, `-swr`, `-msix`) are not chunks and survive. The raw values
     * stay in `occurrenceRows` under `--json`.
     */
    jobNames: SuiteCount[];
    platforms: SuiteCount[];
    buildTypes: SuiteCount[];
    trees: SuiteCount[];
    tests: SuiteCount[];
    /** Distinct `TEST-UNEXPECTED-FAIL` lines, count-descending. */
    lines: SuiteCount[];
    /**
     * Occurrences whose job name is neither mochitest nor xpcshell.
     *
     * Reported so "this bug is all mochitest" stays distinguishable from "some
     * of its jobs were not classified".
     */
    unclassifiedOccurrences: number;
}

/** How `--bug` narrows the occurrences it reports. */
export interface DrilldownFilter {
    /** Keep only occurrences whose job ran this harness. */
    harness?: ScanHarness | undefined;
    /** Substrings to keep, matched against `<platform>/<buildType>`. */
    config?: readonly string[] | undefined;
    /** Substrings to drop, applied after `config`. */
    excludeConfig?: readonly string[] | undefined;
}

/**
 * The configuration string an occurrence is matched against.
 *
 * `<platform>/<buildType>`, which is the shape `fx-tests test --config` matches
 * job names in — so `macosx1500-aarch64`, `debug` and `macosx1500-aarch64/debug`
 * all work, and a caller who learned the flag there does not learn a second
 * convention here. The rows carry the two fields separately; this is the only
 * place they are joined.
 */
export function occurrenceConfig(row: BugOccurrence): string {
    return `${row.platform}/${row.buildType}`;
}

/**
 * Groups one bug's occurrences, optionally narrowed.
 *
 * **Every field is computed from the same filtered population.** A header total
 * that disagrees with its own table is the defect item 14 exists to fix, and the
 * way to get it is to filter one list and compute the rest over everything — so
 * the filter is applied once, here, and every tally below reads `rows`.
 *
 * The harness comes from each occurrence's own job name rather than from the
 * bug's summary. The ranked list classifies a *bug*, where a summary naming one
 * test is the best evidence available; here the question is whether *this job*
 * ran mochitest, and the row says so directly.
 */
export function summariseBug(
    bugId: number,
    occurrences: readonly BugOccurrence[],
    filter: DrilldownFilter = {}
): BugDrilldown {
    const rows = filterOccurrences(occurrences, filter);
    return {
        bugId,
        occurrences: rows.length,
        totalOccurrences: occurrences.length,
        jobNames: tally(rows.map((row) => stripSuiteChunk(row.testSuite))),
        platforms: tally(rows.map((row) => row.platform)),
        buildTypes: tally(rows.map((row) => row.buildType)),
        trees: tally(rows.map((row) => row.tree)),
        tests: tallyTests(rows),
        // Per occurrence, like every other tally here: a job emits the marker
        // once per failing assertion, so counting raw lines reports a job that
        // failed eighteen assertions as eighteen jobs.
        lines: tally(rows.flatMap((row) => [...new Set(row.lines.map(failureLineDetail))])),
        unclassifiedOccurrences: rows.filter(
            (row) => harnessOfOccurrence(row.testSuite) === null
        ).length,
    };
}

/** The occurrences `summariseBug` kept, for the rows and `--json`. */
export function filterOccurrences(
    occurrences: readonly BugOccurrence[],
    filter: DrilldownFilter = {}
): BugOccurrence[] {
    const matchesConfig = configFilter(filter.config ?? [], filter.excludeConfig ?? []);
    return occurrences.filter(
        (row) =>
            (filter.harness === undefined ||
                harnessOfOccurrence(row.testSuite) === filter.harness) &&
            matchesConfig(occurrenceConfig(row))
    );
}

/**
 * Drops the `HH:MM:SS     INFO - ` prefix a mozharness log line carries.
 *
 * Without it the timestamp makes every line distinct, so a ranking of lines has
 * every count at 1.
 */
export function stripLogTimestamp(line: string): string {
    return line.replace(/^\d{2}:\d{2}:\d{2}\s+\w+\s+-\s+/, '').trim();
}

/**
 * The part of a failure line that distinguishes it from the others.
 *
 * The marker and path are 60-plus characters of prefix, and the path is already
 * reported in its own section, so a truncated ranking of one test's failures
 * shows identical visible text on every row. Both come off; a line with no path
 * field (`[taskcluster:error]`) keeps whatever followed the marker.
 */
export function failureLineDetail(line: string): string {
    const stripped = stripLogTimestamp(line);
    const marker = stripped.indexOf('TEST-UNEXPECTED-FAIL');
    if (marker === -1) {
        return stripped;
    }
    const fields = stripped.slice(marker).split('|');
    // The message can itself contain `|`, so the tail is rejoined, not indexed.
    const rest = fields.slice(2).join('|').trim();
    return rest.length === 0 ? stripped : normaliseDuration(rest);
}

/**
 * Collapses a per-run duration to `<n>ms`, so one message is one row.
 *
 * The harness appends `finished in 1306ms` to a failing test file, carrying the
 * `TEST-UNEXPECTED-FAIL` marker, so these are real failure lines — but the
 * number differs on every run, which made each occurrence its own row. Measured
 * on live bug 1829935: 108 of 120 message rows were this one message, each with
 * a count of 1, burying the twelve rows that say what actually failed.
 *
 * Same reasoning as `stripLogTimestamp`: text that is unique per occurrence
 * cannot be ranked, and the ranking is the point. The duration is not dropped —
 * `--json`'s `occurrenceRows` keep every line verbatim.
 */
function normaliseDuration(message: string): string {
    return message.replace(/\b\d+ms\b/g, '<n>ms');
}
