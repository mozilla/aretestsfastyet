/**
 * `fx-tests flaky` — which folder to book a flakiness-burndown session on.
 *
 * `flaky.html` leads with two charts, because "is the tree getting better?" is a
 * shape and a page can draw one. This command leads with something else, and the
 * difference is deliberate: the question a terminal is asked is *where do I spend
 * the afternoon*, and the answer to that is a ranked list of directories with
 * enough on each row to weigh the work against the payoff.
 *
 * So the default view is the page's **flat list**, not its tree and not its
 * charts. See `folderList()` for why the two rankings differ and why the flat one
 * is the actionable one: the tree puts `toolkit` first by virtue of containing
 * everything, and nobody can book a session on `toolkit`.
 *
 * ## The default window is a 7-day average of per-day classifications
 *
 * Both obvious choices are wrong, in opposite directions, and the default had to
 * be neither.
 *
 * **Not the whole 21 days.** `lib/query/flakiness.ts` opens with the measurement:
 * over the window 84% of xpcshell tests have failed at least once, because a test
 * runs on dozens of configurations dozens of times a day. Ranked that way the top
 * folders read 75%, 92%, 99% and nothing discriminates — `netwerk/test/unit` is
 * 437 of 582 and `js/xpconnect/tests/unit` is 148 of 149.
 *
 * **Not one day either**, which is the trap a per-day classification walks into
 * next: weekend push volume is 2.6× lower (`FORMATS.md`), so a single day's counts
 * are partly a fact about the weekday. Measured on the pinned window,
 * `netwerk/test/unit` reads 137 flaky on Tuesday and **76 on Sunday** — a 1.8×
 * swing from the calendar — and `dom/indexedDB/test/unit` is 4th on Sunday and 3rd
 * on Monday at more than double the count. Someone running this on a Monday would
 * be ranking Sunday's fraction of the runs.
 *
 * So the default is `DEFAULT_AVERAGE_DAYS` (7) days of *per-day* verdicts,
 * averaged: a whole number of weeks, so the weekday mix cancels, and still a daily
 * denominator rather than the window's inflated one. `flaky.html`'s headline tiles
 * average the same 7 days (`site/flaky-view.ts`'s `AVERAGE_WINDOW`), so the two
 * agree by construction. The counts are therefore **means per day and are
 * fractional** — 187.0 rather than 187 — which is the honest shape for "on a
 * typical day this folder has 187 flaky tests" and is why the columns carry a
 * decimal.
 *
 * `--day <date>` still ranks one named day and `--all-days` still ranks the whole
 * window, because both are real questions; the header always says which of the
 * three it printed. That is the bug `flaky.html` shipped and had to fix — tiles
 * showing one day above a table showing 21, with nothing saying so.
 *
 * ## What the columns are for
 *
 * A reader choosing between candidates needs the work, the payoff and the risk
 * that the work is not worth doing:
 *
 * - **flaky** — how many test files are flaky *directly in this folder*. The
 *   work. `selfFlaky`, not the subtree roll-up.
 * - **share** — that as a percentage of the folder's own tests. Separates a
 *   rotten folder from two bad files in a healthy one, which want opposite
 *   responses and have the same flaky count.
 * - **skip** — how many of its tests are disabled somewhere. Ground already
 *   given up, usually the same underlying problem, and often the cheapest win.
 * - **tests** — the folder's population, so `share` has a visible denominator.
 * - **in tree** — the subtree's flaky count, printed only when it differs from
 *   the folder's own. That one column is the whole reason the tree view does not
 *   need to be a second table: it says "and there is more below here" without
 *   showing it.
 *
 * ## Flaky and skipped overlap, and the header says so
 *
 * A test that fails on Linux and is disabled on Windows is both. Measured on the
 * pinned window, 800 of 4,807 tests are in both columns, so `flaky + skip` is not
 * a total and the two percentages have different denominators. `OverlappingCounts`
 * has the reasoning; the preamble states it, the way `issues` states which
 * outcomes it counted.
 *
 * The `--group-by days` view is the exception: it uses the mutually exclusive
 * classification, so its three columns *do* sum to `total`. The two views are
 * labelled differently for exactly that reason.
 */

import type { DecodedTimingFile } from '../../lib/formats/decode.ts';
import {
    DEFAULT_AVERAGE_DAYS,
    DEFAULT_MIN_WINDOW_FAILURES,
    type FlakyDay,
    type FolderListRow,
    type FolderNode,
    MIN_FILTERABLE_DAYS,
    flakinessByFolder,
    flakinessByFolderAveraged,
    flakinessOverTime,
    folderList,
    runningAverage,
} from '../../lib/query/flakiness.ts';
import { type OptionSpecs, type ParsedArgs, boolOption, numberOption, stringOption } from '../args.ts';
import { type CommandContext, emit, progress } from '../context.ts';
import { usageError } from '../errors.ts';
import { toJson } from '../format/json.ts';
import * as md from '../format/markdown.ts';
import {
    type Column,
    applyLimit,
    count as fmtCount,
    dateWithWeekday,
    joinLines,
    percent,
    tableSection,
} from '../format/text.ts';
import type { Harness } from '../options.ts';
import { dayIndexOfDate, loadIssues, resolveDayKeyword } from '../data.ts';

/** `fx-tests flaky` options. */
export const FLAKY_OPTIONS: OptionSpecs = {
    path: {
        type: 'string',
        placeholder: '<prefix>',
        describe: 'Only tests under this directory prefix.',
    },
    'group-by': {
        type: 'string',
        placeholder: '<list|folder|days>',
        describe:
            'How to group. Default list — folders ranked by their own flaky tests, the ' +
            'burndown view. `folder` rolls subtrees up; `days` is the trend.',
    },
    sort: {
        type: 'string',
        placeholder: '<flaky|share|skips|tests|name>',
        describe: 'How to rank. Default flaky.',
    },
    noise: {
        type: 'number',
        placeholder: '<n>',
        describe:
            'Read a test failing this often or less over the window as passing. Default 1; ' +
            '0 disables. Ignored on a single-day file.',
    },
    'average-days': {
        type: 'number',
        placeholder: '<n>',
        describe:
            'Average the per-day counts over this many days. Default 7; a multiple of 7 is ' +
            'strongly preferred, since weekend push volume is 2.6x lower.',
    },
    'all-days': {
        type: 'boolean',
        describe:
            'Classify over the whole window instead: flaky if flaky on ANY day. A much looser ' +
            'bar — tree-wide that is ~84% of tests. See the header it prints.',
    },
};

/** The default row count, as every other tree-wide view uses. */
const DEFAULT_LIMIT = 20;

/** The centred running mean's window, in days, for `--group-by days`. */
const TREND_WINDOW = 7;

/** How rows can be ranked. */
type FlakySort = 'flaky' | 'share' | 'skips' | 'tests' | 'name';

/** Which view to print. */
type FlakyGroupBy = 'list' | 'folder' | 'days';

/** The provenance header, shared by every view and repeated in `--json`. */
interface FlakyHeader {
    harness: string;
    family: string;
    /** The file's whole window. */
    startDate: string;
    endDate: string;
    dayCount: number;
    testCount: number;
    dataSource: string;
    /**
     * How the folder views classified: an average, one day, or the whole window.
     *
     * Named rather than left implicit because the three give a 48%, a 53% and a
     * 75% reading of the same folder, and a reader cannot tell them apart from
     * the numbers. See the module comment.
     */
    scope: 'average' | 'day' | 'all-days';
    /** The dates the folder views covered, oldest first. */
    scopeDates: string[];
    /**
     * How many days were averaged, or `null` outside `scope: 'average'`.
     *
     * The count actually used, which is fewer than requested on a short file —
     * so a view cannot label a 3-day file's numbers a 7-day average.
     */
    averageDays: number | null;
    /**
     * The noise threshold **actually applied**, which is 0 on a single-day file
     * whatever was asked for. Reported rather than the request, so a caller
     * cannot claim a filter that did not run. See `MIN_FILTERABLE_DAYS`.
     */
    minWindowFailures: number;
    /** What `--noise` asked for, so the two can be seen to differ. */
    requestedMinWindowFailures: number;
    /** How many tests the filter neutralised. */
    neutralisedTests: number;
    /** True when the filter was requested and skipped for being unjudgeable. */
    noiseFilterSkipped: boolean;
}

/** Everything a view needs, loaded once. */
interface FlakyQuery {
    harness: Harness;
    file: DecodedTimingFile;
    pathPrefix: string | undefined;
    /** Set only when `--day` named one; otherwise the scope is not a single day. */
    day: number | undefined;
    allDays: boolean;
    /** How many days to average, when the scope is the default average. */
    averageDays: number;
    minWindowFailures: number;
    header: FlakyHeader;
}

/**
 * Loads the aggregate and resolves the day.
 *
 * `resolveDayWindow()` is deliberately **not** reused. It returns an inclusive
 * *range* of day indices, which is the right shape for a command summing runs
 * over a window, and the wrong shape here: this classification is per day, so a
 * range of days is not a thing it can be evaluated on: "flaky over days 14-20" is
 * either seven verdicts or a looser single verdict, and those are the two things
 * `--average-days` and `--all-days` already name. So `--day` picks one day,
 * `--average-days` sets the averaging width, `--since` narrows the trend series,
 * and none of the three is silently reinterpreted as another.
 */
async function loadFlakyQuery(context: CommandContext, args: ParsedArgs): Promise<FlakyQuery> {
    const harness: Harness = context.globals.harness ?? 'xpcshell';
    progress(context, `Reading ${harness}-issues.json…`);
    const { file } = await loadIssues(context, harness);

    if (context.globals.config.length > 0 || context.globals.excludeConfig.length > 0) {
        // The same refusal `issues` makes, for the same reason: `issues.json`
        // records no job names, so a configuration filter over it matches
        // nothing for every input and an empty table would read as a clean tree.
        throw usageError(
            `--config cannot be applied to ${harness}-issues.json: the file records no job ` +
                'names, so every configuration filter over it matches nothing',
            'Flakiness here is a per-test verdict over all configurations. `fx-tests test <path> ' +
                '--config` reads a bucket file and can break one test down by configuration.'
        );
    }

    const days = file.days ?? 1;
    const allDays = boolOption(args, 'all-days');
    const requested = numberOption(args, 'noise') ?? DEFAULT_MIN_WINDOW_FAILURES;
    const averageDays = numberOption(args, 'average-days') ?? DEFAULT_AVERAGE_DAYS;
    if (averageDays < 1) {
        throw usageError(`--average-days expects at least 1, got ${averageDays}`);
    }
    if (allDays && args.options.has('average-days')) {
        throw usageError(
            '--all-days and --average-days are mutually exclusive',
            '--all-days is a single verdict over the whole window; --average-days averages ' +
                'per-day verdicts. Pick one.'
        );
    }

    let day: number | undefined;
    if (context.globals.day !== undefined) {
        if (allDays) {
            throw usageError(
                '--day and --all-days are mutually exclusive',
                '--day classifies on one day; --all-days classifies over the whole window. ' +
                    'They are the two ends of the choice, not a range.'
            );
        }
        if (args.options.has('average-days')) {
            throw usageError(
                '--day and --average-days are mutually exclusive',
                '--day is one day; --average-days averages several. Drop --day to average.'
            );
        }
        const wanted = resolveDayKeyword(context.globals.day, file.endDate);
        const index = dayIndexOfDate(file.endDate, days, wanted);
        if (index === null) {
            throw usageError(
                `no data for ${wanted}: ${harness}-issues.json covers ` +
                    `${dateOfIndex(file.endDate, days, 0)} … ${file.endDate} (${days} days)`,
                'Run `fx-tests dates` to see what is published.'
            );
        }
        day = index;
    }

    // `flakinessOverTime` is what reports the threshold it really applied and
    // how many tests it neutralised, and both are header facts every view
    // prints — so the series is computed once here rather than only by the
    // trend view. It is one pass over a file already in memory.
    const series = flakinessOverTime(file, {
        minWindowFailures: requested,
        ...(args.options.has('path') ? { pathPrefix: stringOption(args, 'path') } : {}),
    });

    // The three scopes, resolved once so the header and the views cannot disagree
    // about which one ran — which is the mismatch `flaky.html` had to fix.
    const scope: FlakyHeader['scope'] = allDays ? 'all-days' : day !== undefined ? 'day' : 'average';
    const effectiveAverage = Math.max(1, Math.min(averageDays, days));
    const scopeDates =
        scope === 'day'
            ? [dateOfIndex(file.endDate, days, day!)]
            : scope === 'all-days'
              ? [dateOfIndex(file.endDate, days, 0), file.endDate]
              : Array.from({ length: effectiveAverage }, (_unused, offset) =>
                    dateOfIndex(file.endDate, days, days - effectiveAverage + offset)
                );

    return {
        harness,
        file,
        pathPrefix: stringOption(args, 'path'),
        day,
        allDays,
        averageDays,
        minWindowFailures: series.minWindowFailures,
        header: {
            harness,
            family: file.family,
            startDate: dateOfIndex(file.endDate, days, 0),
            endDate: file.endDate,
            dayCount: days,
            testCount: file.testCount,
            dataSource: context.source.name,
            scope,
            scopeDates,
            averageDays: scope === 'average' ? effectiveAverage : null,
            minWindowFailures: series.minWindowFailures,
            requestedMinWindowFailures: requested,
            neutralisedTests: series.neutralisedTests,
            // The distinction `MIN_FILTERABLE_DAYS` documents: a caller who
            // asked for a filter on a one-day file gets the unfiltered
            // classification, and is told so rather than left to assume the
            // 366 tests it would have neutralised were quietly handled.
            noiseFilterSkipped: requested > 0 && series.minWindowFailures === 0,
        },
    };
}

/** The date of a day index. Day 0 is the oldest, as the files encode it. */
function dateOfIndex(endDate: string, days: number, index: number): string {
    const end = Date.parse(`${endDate}T00:00:00Z`);
    if (Number.isNaN(end)) {
        return endDate;
    }
    return new Date(end - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
}

/** Runs `fx-tests flaky`. */
export async function runFlaky(context: CommandContext, args: ParsedArgs): Promise<void> {
    if (args.positionals.length > 0) {
        throw usageError(
            `flaky takes no positional arguments, got "${args.positionals[0]}"`,
            `Did you mean --path ${args.positionals[0]}?`
        );
    }
    const groupBy = readGroupBy(args);
    const sort = readSort(args);
    if (groupBy === 'days' && args.options.has('sort')) {
        // A calendar is not a ranking. Accepting `--sort` here and ignoring it
        // would be the "flag did nothing" failure `cli/args.ts` opens by
        // rejecting for unknown flags.
        throw usageError(
            '--sort does not apply to --group-by days, which is ordered by date',
            'Drop --sort, or use --group-by list to rank folders.'
        );
    }

    const query = await loadFlakyQuery(context, args);
    const limit = context.globals.limit ?? DEFAULT_LIMIT;

    if (groupBy === 'days') {
        emitResult(context, trendResult(query, context, limit), (result) => renderTrend(result));
        return;
    }

    const noise = {
        minWindowFailures: query.header.requestedMinWindowFailures,
        ...(query.pathPrefix === undefined ? {} : { pathPrefix: query.pathPrefix }),
    };
    // The default scope averages per-day verdicts, so it is a different walk and
    // not a `FolderOptions` flag — see `flakinessByFolderAveraged`.
    const root =
        query.header.scope === 'average'
            ? flakinessByFolderAveraged(query.file, {
                  ...noise,
                  averageDays: query.averageDays,
              }).root
            : flakinessByFolder(query.file, {
                  ...noise,
                  ...(query.allDays ? { allDays: true } : {}),
                  ...(query.day === undefined ? {} : { day: query.day }),
              });

    const rows = groupBy === 'list' ? listRows(root) : treeRows(root);
    const sorted = sortRows(rows, sort);
    const shown = applyLimit(sorted, limit);
    const result: FolderResult = {
        header: query.header,
        groupBy,
        sort,
        pathPrefix: query.pathPrefix ?? null,
        allDays: query.allDays,
        totals: {
            flaky: root.flaky,
            stable: root.stable,
            skipped: root.skipped,
            flakyAndSkipped: root.flakyAndSkipped,
            total: root.total,
            testCount: root.testCount,
        },
        rowCount: sorted.length,
        rows: shown,
    };
    emitResult(context, result, renderFolders);
}

// --- the folder views ----------------------------------------------------

/** One row of the `list` or `folder` view. */
interface FolderRow {
    path: string;
    /** The flaky count this row is ranked and judged on. */
    flaky: number;
    /** The denominator of `flakyPercent`. */
    total: number;
    /** Tests skipped somewhere, overlapping `flaky` by `flakyAndSkipped`. */
    skipped: number;
    flakyAndSkipped: number;
    /** Test files behind `total`. */
    testCount: number;
    /**
     * The subtree's flaky count.
     *
     * Equal to `flaky` in the `folder` view by construction, and in the `list`
     * view on any folder with no subfolders — which is 246 of 250 on the pinned
     * window. Carried on every row anyway so `--json` has one shape, and printed
     * only where it says something.
     */
    subtreeFlaky: number;
    /** Rounded **once**, from the raw ratio. Double-rounding is a known defect. */
    flakyPercent: number;
    skippedPercent: number;
}

/**
 * The burndown rows: one per folder, counting only the tests directly in it.
 *
 * `selfSkipped` rather than the subtree's `skipped`, so every column on the row
 * describes the same population as the `flaky` column it sits next to.
 */
function listRows(root: FolderNode): FolderRow[] {
    return folderList(root).map((row: FolderListRow) => ({
        path: row.path,
        flaky: row.selfFlaky,
        total: row.selfTotal,
        skipped: row.selfSkipped,
        flakyAndSkipped: row.selfFlakyAndSkipped,
        testCount: row.selfTestCount,
        subtreeFlaky: row.flaky,
        flakyPercent: ratio(row.selfFlaky, row.selfTotal),
        skippedPercent: ratio(row.selfSkipped, row.selfTotal),
    }));
}

/**
 * The subtree roll-up: one row per folder, counting everything beneath it.
 *
 * The tree view flattened rather than drawn. A terminal cannot be drilled, and
 * indenting 250 rows of a 6-deep tree produces something less readable than the
 * paths themselves — which are already the tree, written down.
 */
function treeRows(root: FolderNode): FolderRow[] {
    const rows: FolderRow[] = [];
    const visit = (node: FolderNode): void => {
        if (node.path !== '') {
            rows.push({
                path: node.path,
                flaky: node.flaky,
                total: node.total,
                skipped: node.skipped,
                flakyAndSkipped: node.flakyAndSkipped,
                testCount: node.testCount,
                subtreeFlaky: node.flaky,
                flakyPercent: ratio(node.flaky, node.total),
                skippedPercent: ratio(node.skipped, node.total),
            });
        }
        for (const child of node.children) {
            visit(child);
        }
    };
    visit(root);
    return rows;
}

/** A percentage from the raw counts, unrounded. The formatter rounds, once. */
function ratio(part: number, whole: number): number {
    return whole > 0 ? (part / whole) * 100 : 0;
}

/**
 * Whether two counts differ by enough to be worth showing as different.
 *
 * `!==` is wrong under the averaged scope and wrong in a way that looks like a
 * feature: `folderList` re-sums per-leaf means, so a folder with no subfolders at
 * all comes out with a subtree total differing from its own by ~1e-14, and the
 * "in tree" column — which should appear on 4 of 250 rows — printed on all of
 * them. The tolerance is far below the smallest real difference, which is one
 * test-day, or `1/averageDays` ≥ 1/21.
 */
function differs(a: number, b: number): boolean {
    return Math.abs(a - b) > 1e-6;
}

/**
 * A per-day mean, with one decimal — but only where the decimal says something.
 *
 * A mean that is a whole number to within the tolerance is printed as one. That is
 * not cosmetic tidying: skip annotations barely move day to day, so the skip column
 * is exactly integral on almost every row, and printing `131.0` there put a decimal
 * point on 250 rows to signal a fractionality that column does not have. The
 * decimal is the signal that a number is a mean, so it has to be spent where it is
 * true — `187.0` for a flaky count that really is 1,309/7.
 *
 * Rounded **once** from the raw mean. The share column is computed from the same
 * unrounded numbers, so it cannot disagree with its own numerator.
 */
function mean(value: number): string {
    const whole = Math.abs(value - Math.round(value)) <= 1e-6;
    return value.toLocaleString('en-US', {
        minimumFractionDigits: whole ? 0 : 1,
        maximumFractionDigits: whole ? 0 : 1,
    });
}

/**
 * Ranks folder rows.
 *
 * `flaky` is the default and ranks on the count, not the share, for the reason
 * `sortTree()` gives: a folder holding one test that failed is 100% flaky and is
 * not where to start. `--sort share` is there for the reader who has already
 * decided how much time they have.
 */
function sortRows(rows: readonly FolderRow[], sort: FlakySort): FolderRow[] {
    const sorted = [...rows];
    const byPath = (a: FolderRow, b: FolderRow): number => a.path.localeCompare(b.path);
    switch (sort) {
        case 'flaky':
            sorted.sort((a, b) => b.flaky - a.flaky || byPath(a, b));
            break;
        case 'share':
            sorted.sort((a, b) => b.flakyPercent - a.flakyPercent || byPath(a, b));
            break;
        case 'skips':
            sorted.sort((a, b) => b.skipped - a.skipped || byPath(a, b));
            break;
        case 'tests':
            sorted.sort((a, b) => b.testCount - a.testCount || byPath(a, b));
            break;
        case 'name':
            sorted.sort(byPath);
            break;
    }
    return sorted;
}

/** The `--json` shape of the folder views. */
interface FolderResult {
    header: FlakyHeader;
    groupBy: 'list' | 'folder';
    sort: FlakySort;
    pathPrefix: string | null;
    allDays: boolean;
    /** The whole selection's counts — the root node's. */
    totals: {
        flaky: number;
        stable: number;
        skipped: number;
        flakyAndSkipped: number;
        total: number;
        testCount: number;
    };
    rowCount: number;
    rows: FolderRow[];
}

/** Renders a folder view. */
function renderFolders(result: FolderResult): Rendered {
    const sortColumn: Record<FlakySort, string> = {
        flaky: 'flaky',
        share: 'share',
        skips: 'skip',
        tests: 'tests',
        name: 'Folder',
    };
    const column = (header: string, rest: Omit<Column, 'header'> = {}): Column => ({
        header,
        ...rest,
        ...(header === sortColumn[result.sort]
            ? { sort: result.sort === 'name' ? 'asc' : 'desc' }
            : {}),
    });
    // Printed only when at least one row has more below it, so the common case
    // — a leaf directory, 246 of 250 on the pinned window — does not carry a
    // column of repeated numbers.
    const anySubtree = result.rows.some((row) => differs(row.subtreeFlaky, row.flaky));
    // Averaged counts are means per day and are fractional; a single day's and
    // the window's are counts of test files. Printing `187.0` under the average
    // and `208` under `--day` is the cheapest available signal that the two
    // columns are not the same quantity.
    const num = result.header.scope === 'average' ? mean : fmtCount;
    const columns = [
        column('Folder', { path: true }),
        column('flaky', { align: 'right' }),
        column('share', { align: 'right' }),
        column('skip', { align: 'right' }),
        column('tests', { align: 'right' }),
        ...(anySubtree ? [{ header: 'in tree', align: 'right' as const }] : []),
    ];
    return {
        preamble: headerLines(result),
        table: {
            columns,
            rows: result.rows.map((row) => [
                row.path,
                num(row.flaky),
                percent(row.flakyPercent),
                num(row.skipped),
                // Always an integer: `testCount` is test files, which does not
                // become fractional just because the states above it did.
                fmtCount(row.testCount),
                ...(anySubtree ? [differs(row.subtreeFlaky, row.flaky) ? num(row.subtreeFlaky) : ''] : []),
            ]),
        },
        total: result.rowCount,
        shown: result.rows.length,
        epilogue: epilogueFor(result),
        empty: emptyMessage(result),
    };
}

/**
 * The next command to run, which is the point of printing a ranking at all.
 *
 * `CLI.md`'s "answers, not dumps": a reader who has picked a folder should not
 * have to work out what to type next. Named against the top row rather than left
 * generic, so it is copy-pasteable — the same treatment `crashes --minidumps`
 * gives its `fx-tests crash` lines.
 */
function epilogueFor(result: FolderResult): string[] {
    const top = result.rows[0];
    if (top === undefined) {
        return [];
    }
    return [
        `  Next, for the folder you pick:`,
        `    fx-tests issues --path ${top.path}     # which tests, and what they fail with`,
        `    fx-tests skips --path ${top.path}      # what is already disabled there`,
    ];
}

// --- the trend view ------------------------------------------------------

/** One row of `--group-by days`. */
interface TrendRow {
    date: string;
    day: number;
    flaky: number;
    stable: number;
    skipped: number;
    total: number;
    flakyPercent: number;
    /** The centred 7-day mean, or `null` where there is no measurement. */
    average: number | null;
}

/** The `--json` shape of the trend view. */
interface TrendResult {
    header: FlakyHeader;
    groupBy: 'days';
    pathPrefix: string | null;
    averageWindow: number;
    rowCount: number;
    rows: TrendRow[];
}

/**
 * The per-day series.
 *
 * Kept because it is the one view whose numbers a folder ranking cannot imply:
 * it says whether the folder you are about to fix is getting worse or was always
 * like this. It is a table of numbers rather than a drawing — `CLI.md` §Non-goals
 * rules out chart rendering, and no `cli/format/` module has a sparkline to
 * reuse.
 *
 * `--since n` filters the series to its last `n` days, which is a filter on a
 * computed series and not a different classification: each day is still
 * classified on its own runs, and the noise filter still judges "one unlucky
 * run" against the whole 21 days. Narrowing what is *printed* cannot change
 * that, and must not appear to.
 */
function trendResult(query: FlakyQuery, context: CommandContext, limit: number): TrendResult {
    const series = flakinessOverTime(query.file, {
        minWindowFailures: query.header.requestedMinWindowFailures,
        ...(query.pathPrefix === undefined ? {} : { pathPrefix: query.pathPrefix }),
    });
    const average = runningAverage(series.days, TREND_WINDOW);
    let rows: TrendRow[] = series.days.map((day: FlakyDay, index: number) => ({
        date: day.date,
        day: day.day,
        flaky: day.flaky,
        stable: day.stable,
        skipped: day.skipped,
        total: day.total,
        flakyPercent: ratio(day.flaky, day.total),
        average: average[index] ?? null,
    }));
    if (context.globals.since !== undefined) {
        rows = rows.slice(Math.max(0, rows.length - context.globals.since));
    }
    // Oldest-first, as the files encode it and the charts plot it. The limit
    // therefore keeps the **newest** rows: a truncated calendar that dropped
    // today would answer "how is it now" with last fortnight.
    const shown = limit === 0 ? rows : rows.slice(Math.max(0, rows.length - limit));
    return {
        header: query.header,
        groupBy: 'days',
        pathPrefix: query.pathPrefix ?? null,
        averageWindow: TREND_WINDOW,
        rowCount: rows.length,
        rows: shown,
    };
}

/** Renders the trend table. */
function renderTrend(result: TrendResult): Rendered {
    const lines = headerLines(result);
    return {
        preamble: lines,
        table: {
            columns: [
                { header: 'Date', sort: 'asc' },
                { header: 'flaky', align: 'right' },
                { header: 'stable', align: 'right' },
                { header: 'skipped', align: 'right' },
                { header: 'total', align: 'right' },
                { header: 'flaky%', align: 'right' },
                { header: `${result.averageWindow}d avg`, align: 'right' },
            ],
            rows: result.rows.map((row) => [
                dateWithWeekday(row.date),
                fmtCount(row.flaky),
                fmtCount(row.stable),
                fmtCount(row.skipped),
                fmtCount(row.total),
                percent(row.flakyPercent),
                percent(row.average),
            ]),
        },
        total: result.rowCount,
        shown: result.rows.length,
        epilogue: [
            '  --group-by list ranks the folders behind these numbers.',
        ],
        empty:
            `No day had any test run. Searched ${fmtCount(result.header.testCount)} tests in ` +
            `${result.header.harness}-issues.json over ${result.header.startDate} … ` +
            `${result.header.endDate}. Check --path (a directory prefix) for typos.`,
    };
}

// --- shared header and epilogue -----------------------------------------

/**
 * The provenance lines every view prints.
 *
 * Three things have to be here rather than in a footnote, because each one is a
 * factor-of-several difference a reader would otherwise attribute to Firefox:
 * which day was classified, whether the flaky and skip columns overlap, and
 * whether the noise filter ran.
 */
function headerLines(result: FolderResult | TrendResult): string[] {
    const { header } = result;
    const lines: string[] = [];
    const subject =
        result.groupBy === 'days'
            ? 'flakiness by day'
            : result.groupBy === 'list'
              ? 'flaky tests by folder'
              : 'flaky tests by folder subtree';
    lines.push(
        `${header.harness} ${subject} — ${header.dayCount} days ` +
            `(${dateWithWeekday(header.startDate)} … ${dateWithWeekday(header.endDate)}), ` +
            `${fmtCount(header.testCount)} tests in the file`
    );
    if (result.pathPrefix !== null) {
        lines.push(`Under ${result.pathPrefix} only.`);
    }
    lines.push(
        'Flaky means a test failed, timed out or crashed at least once; skipped means it was ' +
            'disabled somewhere, run-if excluded.'
    );

    if (result.groupBy === 'days') {
        // The one view whose three columns are mutually exclusive, said plainly
        // because the other two views' are not and share these column names.
        lines.push(
            'Each test is classified on the runs it had that day, in exactly one of the three ' +
                'states, so flaky + stable + skipped = total.'
        );
    } else if (header.scope === 'all-days') {
        // The 84% measurement. A reader who does not know this reads 75% as a
        // statement about the folder rather than about the window.
        lines.push(
            `--all-days: a test counts as flaky if it failed on ANY of the ${header.dayCount} ` +
                'days, which is a much looser bar — tree-wide that is ~84% of tests, because a ' +
                'test runs on dozens of configs dozens of times a day. Drop --all-days for the ' +
                '7-day average, which discriminates.'
        );
    } else if (header.scope === 'day') {
        lines.push(
            `--day: classified on ${dateWithWeekday(header.scopeDates[0] ?? header.endDate)} ` +
                'alone. One day is partly a fact about the weekday — weekend push volume is 2.6x ' +
                'lower, and on the pinned window netwerk/test/unit reads 137 flaky on a Tuesday ' +
                'and 76 on a Sunday. Drop --day for the 7-day average.'
        );
    } else {
        // The default, and the one that needs the most saying: the numbers are
        // means, over a whole number of weeks, of per-day verdicts. Each of those
        // three properties is load-bearing and none is visible in the digits.
        const first = header.scopeDates[0] ?? header.startDate;
        const last = header.scopeDates[header.scopeDates.length - 1] ?? header.endDate;
        lines.push(
            `Counts are the MEAN PER DAY over the last ${header.averageDays ?? 0} days ` +
                `(${first} … ${last}), each day classified on its own runs — so 187.0 means "on ` +
                'a typical day, 187 of this folder\'s tests were flaky". A whole number of weeks, ' +
                "because weekend push volume is 2.6x lower and one day's ranking is partly the " +
                `calendar. --day <date> ranks one day, --all-days the whole ${header.dayCount}.`
        );
    }

    if (result.groupBy !== 'days') {
        lines.push(
            'The flaky and skip columns OVERLAP — a test failing on Linux and disabled on ' +
                'Windows is both — so they do not sum to tests, and share is flaky/tests, not ' +
                'flaky/(flaky+skip).'
        );
    }

    if (header.noiseFilterSkipped) {
        // Stated, not silently dropped. `MIN_FILTERABLE_DAYS`: on a one-day
        // file the same threshold neutralised 366 tests and reported 562 flaky
        // where the 21-day window reads 923 for the same date.
        lines.push(
            `--noise ${header.requestedMinWindowFailures} was NOT applied: this file covers ` +
                `fewer than ${MIN_FILTERABLE_DAYS} days, and "did this fail more than once in ` +
                'the window" cannot be judged from one day. The counts below are unfiltered.'
        );
    } else if (header.minWindowFailures > 0) {
        lines.push(
            `Noise filter: a test failing ${header.minWindowFailures} time` +
                `${header.minWindowFailures === 1 ? '' : 's'} or fewer across the ` +
                `${header.dayCount} days is read as passing — ` +
                `${fmtCount(header.neutralisedTests)} tests neutralised (--noise 0 disables).`
        );
    } else {
        lines.push(
            'Noise filter off (--noise 1 is the default; it reads a single failure as a pass).'
        );
    }
    return lines;
}

/**
 * The width the text renderer wraps preamble prose to.
 *
 * The caveats are built as whole sentences rather than pre-broken lines, because
 * the two renderers want opposite things from them: the text one wants them
 * wrapped and indented for a terminal, and Markdown wants each to be one
 * paragraph. Hard-wrapping at source gave Markdown one paragraph *per line* — an
 * eight-line caveat became eight blank-line-separated fragments — so the wrapping
 * happens here, at the only place that wants it.
 */
const WRAP_WIDTH = 96;

/** Wraps a caveat to `WRAP_WIDTH`, indented under the heading. */
function wrapCaveat(text: string, indent = '  '): string[] {
    const words = text.split(' ');
    const out: string[] = [];
    let line = '';
    for (const word of words) {
        const candidate = line === '' ? word : `${line} ${word}`;
        if (`${indent}${candidate}`.length > WRAP_WIDTH && line !== '') {
            out.push(`${indent}${line}`);
            line = word;
        } else {
            line = candidate;
        }
    }
    if (line !== '') {
        out.push(`${indent}${line}`);
    }
    return out;
}

/** What to say when the selection is empty. */
function emptyMessage(result: FolderResult): string {
    const { header } = result;
    const over =
        header.scope === 'day'
            ? `on ${header.scopeDates[0] ?? header.endDate}`
            : header.scope === 'all-days'
              ? `over all ${header.dayCount} days`
              : `over the last ${header.averageDays ?? 0} days`;
    return (
        `No folder matched. Searched ${fmtCount(header.testCount)} tests in ` +
        `${header.harness}-issues.json, classified ${over}. ` +
        'Check --path (a directory prefix) for typos — and note that a folder whose tests did ' +
        'not run at all in that window has no row, since it has no rate.'
    );
}

// --- option reading ------------------------------------------------------

function readGroupBy(args: ParsedArgs): FlakyGroupBy {
    const value = stringOption(args, 'group-by') ?? 'list';
    if (value !== 'list' && value !== 'folder' && value !== 'days') {
        throw usageError(
            `--group-by expects one of list, folder, days, got "${value}"`,
            'list ranks folders by their own flaky tests (the burndown view); folder rolls ' +
                'subtrees up; days is the trend.'
        );
    }
    return value;
}

function readSort(args: ParsedArgs): FlakySort {
    const value = stringOption(args, 'sort') ?? 'flaky';
    const allowed: FlakySort[] = ['flaky', 'share', 'skips', 'tests', 'name'];
    if (!(allowed as string[]).includes(value)) {
        throw usageError(`--sort expects one of ${allowed.join(', ')}, got "${value}"`);
    }
    return value as FlakySort;
}

// --- rendering plumbing --------------------------------------------------

/** What a view produces, before it is laid out. Mirrors `issues.ts`. */
interface Rendered {
    preamble: string[];
    table: { columns: Column[]; rows: string[][] } | null;
    total: number;
    shown: number;
    epilogue: string[];
    empty: string;
}

/**
 * How many decimals a `--json` mean carries.
 *
 * Four, which is three more than anything is printed to and far more than the
 * data supports — the point is not precision but *stability*. The averages are
 * sums of `1/windowDays`, so a folder whose 187 tests are flaky every day comes
 * out as `186.99999999999858`, and emitting that raw makes `--json` a shape whose
 * digits change with the iteration order. A consumer diffing two runs would see
 * churn that is not in the data, and `CLI.md` promises a stable shape.
 *
 * The text renderer is deliberately **not** routed through this: it rounds from
 * the raw value to one decimal, once. Rounding to 4 and then to 1 would be the
 * double-rounding this repo already has a recorded defect for.
 */
const JSON_DECIMALS = 4;

/**
 * Rounds every number in a result for `--json`, leaving integers alone.
 *
 * Applied at the emit boundary and nowhere else, so the ranking, the percentages
 * and the text output are all computed from the unrounded values.
 */
function roundForJson(value: unknown): unknown {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? value : Number(value.toFixed(JSON_DECIMALS));
    }
    if (Array.isArray(value)) {
        return value.map(roundForJson);
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
                key,
                roundForJson(entry),
            ])
        );
    }
    return value;
}

/** Emits in whichever format was asked for. */
function emitResult<T>(context: CommandContext, result: T, build: (result: T) => Rendered): void {
    if (context.globals.format === 'json') {
        emit(context, toJson(roundForJson(result)));
        return;
    }
    const content = build(result);
    emit(
        context,
        context.globals.format === 'markdown' ? renderMarkdownFrom(content) : renderTextFrom(content)
    );
}

/** Plain text: the shared aligned-column layout. */
function renderTextFrom(content: Rendered): string {
    // The heading is one line by construction; every caveat after it is a whole
    // sentence and is wrapped here. See `wrapCaveat`.
    const [heading, ...caveats] = content.preamble;
    const lines: (string | null)[] = [
        heading ?? '',
        ...caveats.flatMap((caveat) => wrapCaveat(caveat)),
        '',
    ];
    if (content.table === null || content.table.rows.length === 0) {
        lines.push(content.empty);
    } else {
        lines.push(...tableSection(content.table.columns, content.table.rows, content));
    }
    lines.push('');
    lines.push(...content.epilogue);
    return joinLines(lines);
}

/** Markdown: a real table, as every other command emits. */
function renderMarkdownFrom(content: Rendered): string {
    const lines: (string | null)[] = [];
    const [heading, ...caveats] = content.preamble;
    lines.push(md.heading(heading ?? 'Flakiness', 1));
    lines.push('');
    for (const caveat of caveats) {
        lines.push(caveat.trim());
        lines.push('');
    }
    if (content.table === null || content.table.rows.length === 0) {
        lines.push(content.empty);
    } else {
        lines.push(...md.table(content.table.columns, content.table.rows));
        lines.push(md.moreLine(content.total, content.shown));
    }
    if (content.epilogue.length > 0) {
        lines.push('');
        for (const line of content.epilogue) {
            lines.push(line.trim());
        }
    }
    return joinLines(lines);
}
