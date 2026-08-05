/**
 * `fx-tests errors` — what is loudest in the test logs on one day.
 *
 * Two things about this command differ from every other one, and both are
 * properties of the data rather than choices of style.
 *
 * ## It has its own window, and it is not the 21-day one
 *
 * `CLI.md` describes `errors` as `--day`-scoped with a default of "the most
 * recent available", and assumes "available" means the 21-day window every
 * other command uses. It does not. `FORMATS.md` measured the index task's
 * artifact listing: it publishes 21 daily files, 21 resources files and **5**
 * errors files. Sixteen of the twenty-one dates in `index.json` have no errors
 * data at all, which was re-confirmed by request while writing this: mochitest
 * 2026-07-30 … 2026-08-03 answer 200 and 2026-07-29 and older answer 404.
 *
 * So `resolveDayWindow()` cannot be reused. Validating `--day` against
 * `index.json` would accept a date whose file 404s, and defaulting to
 * `index.json`'s newest date would fail more often than not. The window here is
 * **discovered** — newest-first, keeping the first file that exists — and a
 * requested date that has none exits 2 with the list of dates that do.
 * `CLI.md`'s "compare two dates" workflow only works inside those five days,
 * and saying so is what turns a confusing empty result into a next step.
 *
 * ## It defaults to mochitest
 *
 * The only command that does. xpcshell runs its tests in parallel, so a test's
 * stdout cannot be emitted as it is produced and is replayed only when the test
 * fails: the xpcshell errors file covers **failing tests only**. That is a
 * biased population, not a small sample of the same one, and ranking it would
 * answer "what do failing tests print" while claiming to answer "what is noisy
 * in CI". Mochitest has no such restriction, so it is the default.
 *
 * `--harness xpcshell` still works and is right for the narrower question —
 * "what did this failing test print?" — which is why the header states the
 * population rather than the command refusing.
 *
 * ## Memory
 *
 * The mochitest file is ~97 MB on a weekday and expands to ~532 MB of heap
 * (`FORMATS.md`), holding 103M markers. Nothing here materializes a
 * per-occurrence object: `rankErrors()` walks the (test, message) groups once
 * and accumulates integers, and the per-group task IDs are decoded only when
 * `--task-ids` asks. The file is also fetched exactly once — an earlier draft
 * probed for existence and then fetched, downloading 97 MB twice to learn
 * something the first response already carried.
 */

import {
    type DecodedErrorsFile,
    type ErrorsFile,
    decodeErrors,
} from '../../lib/formats/errors.ts';
import { parseTaskId } from '../../lib/formats/tables.ts';
import {
    type ComponentShare,
    type ErrorGroup,
    type ErrorGrouping,
    type ErrorSort,
    componentBreakdownLines,
    componentSummary,
    kindTotals,
    rankErrors,
} from '../../lib/query/error-ranking.ts';
import {
    type DataFileName,
    DataFileNotFoundError,
    fetchJson,
    timingsIndex,
} from '../../lib/sources/source.ts';
import { type OptionSpecs, type ParsedArgs, boolOption, stringOption } from '../args.ts';
import { type CommandContext, emit, progress } from '../context.ts';
import { notFoundError, usageError } from '../errors.ts';
import { toJson } from '../format/json.ts';
import * as md from '../format/markdown.ts';
import {
    applyLimit,
    count as fmtCount,
    dateWithWeekday,
    isWeekend,
    joinLines,
    moreLine,
    table,
    truncate,
    weekdayOf,
} from '../format/text.ts';
import type { Harness } from '../options.ts';
import { addDays, loadIndex } from '../data.ts';

/** Options `errors` adds to the globals. */
export const ERRORS_OPTIONS: OptionSpecs = {
    message: {
        type: 'string',
        placeholder: '<substring>',
        describe: 'Only messages whose text contains this.',
    },
    kind: {
        type: 'string',
        placeholder: '<name>',
        describe: 'Only this marker kind. Names come from the file, not a fixed list.',
    },
    test: {
        type: 'string',
        placeholder: '<path>',
        describe: 'Only this test, by full path or directory prefix.',
    },
    component: {
        type: 'string',
        placeholder: '<substring>',
        describe: 'Only messages whose Bugzilla component contains this.',
    },
    file: {
        type: 'string',
        placeholder: '<substring>',
        describe: 'Only messages whose source file contains this.',
    },
    'group-by': {
        type: 'string',
        placeholder: '<message|location|test|component|kind>',
        describe: 'How to group rows. Default location: file and line as well as text.',
    },
    sort: {
        type: 'string',
        placeholder: '<occurrences|tests>',
        describe: 'Rank by total occurrences (default) or by how many tests saw it.',
    },
    'task-ids': { type: 'boolean', describe: 'Print the task IDs behind each row.' },
};

/**
 * The default row count.
 *
 * `CLI.md` specifies 20, and the file is why: a handful of messages account for
 * most of the volume — on 2026-07-30 the top three were over a quarter of
 * 103.2M markers — so twenty rows is already past the point of diminishing
 * returns for the ranking question.
 */
const DEFAULT_LIMIT = 20;

/**
 * How many dates back to look for an errors file.
 *
 * The window is five days today and the search stops at the first hit, so this
 * bounds the *failed* requests rather than costing anything on a good night. It
 * is deliberately larger than the observed window: a hardcoded 5 would stop
 * finding data the day the generator published a sixth. `index.json`'s length
 * caps it, so this never looks outside the 21 days.
 */
const MAX_WINDOW_PROBE = 21;

/** The `--json` shape. */
export interface ErrorsJson {
    harness: string;
    date: string;
    weekday: string | null;
    weekend: boolean;
    metadata: {
        generatedAt: string;
        jobCount: number;
        processedJobCount: number;
        invalidJobCount: number;
        dataSource: string;
    };
    /**
     * Dates confirmed to have an errors file, newest first.
     *
     * In every response, because it is the fact most often assumed wrong:
     * `index.json` lists 21 dates and only about five of them have errors data.
     */
    availableDates: string[];
    /**
     * True when the search stopped at the first hit, so `availableDates` is a
     * lower bound rather than the whole window.
     *
     * The distinction matters to a script: `availableDates.length === 1` with
     * this false means there really is one date, and with it true means one was
     * found and the rest were not looked at.
     */
    availableDatesArePartial: boolean;
    /**
     * Whether this harness's file covers only failing tests. True for xpcshell.
     *
     * In the JSON rather than only in the prose, so a script cannot compare an
     * xpcshell ranking against a mochitest one without the difference being
     * visible in the data it read.
     */
    failingTestsOnly: boolean;
    /** Per-kind totals over the whole file, from `metadata.markerCounts`. */
    markerCounts: { kind: string; count: number }[];
    /** The kinds `tables.markerNames` declares — data, not a fixed list. */
    markerNames: string[];
    totals: {
        /** Occurrences in rows that passed the filters. */
        matched: number;
        /** Occurrences in the whole file, from walking every group. */
        file: number;
        /** Distinct (test, message) groups that passed the filters. */
        matchedGroups: number;
    };
    grouping: ErrorGrouping;
    sort: ErrorSort;
    /** How many rows the ranking produced, before `--limit`. */
    rowCount: number;
    rows: ErrorRowJson[];
}

interface ErrorRowJson {
    kind: string | null;
    text: string | null;
    file: string | null;
    line: number | null;
    component: string | null;
    count: number;
    testCount: number;
    tests: { path: string; count: number }[];
    /**
     * Every component the row's occurrences came from, biggest first.
     *
     * **Uncapped**, unlike `tests`: a script asking "which components does this
     * message touch" wants the whole list, and the truncation the text renderer
     * applies is a property of a terminal rather than of the answer. Empty for
     * `--group-by kind`.
     */
    components: { component: string; count: number }[];
    /**
     * The one-line summary the text output shows, so a script reads the same
     * verdict the terminal did rather than re-deriving the threshold.
     */
    componentSummary: string | null;
    taskIds?: string[];
}

/** Runs the command. */
export async function runErrors(context: CommandContext, args: ParsedArgs): Promise<void> {
    if (args.positionals.length > 0) {
        throw usageError(
            `errors takes no positional arguments, got "${args.positionals[0]}"`,
            'Filter with --message, --kind, --test, --component or --file.'
        );
    }
    if (context.globals.since !== undefined) {
        // Not silently ignored: `--since 3` looks like it widened the window
        // and did not. There is no multi-day errors aggregate to widen into,
        // and reporting one day's numbers under a three-day flag is exactly the
        // plausible wrong answer this project keeps producing.
        throw usageError(
            '--since does not apply to errors: the files are per-date, with no multi-day aggregate',
            'Use --day <date> for one day, and run the command twice to compare two days.'
        );
    }

    // The one command that defaults to mochitest — see the module comment.
    const harness: Harness = context.globals.harness ?? 'mochitest';
    const grouping = readGrouping(args);
    const sort = readSort(args);

    const loaded = await loadErrorsFile(context, harness);
    const decoded = decodeErrors(loaded.file);

    const kindOption = stringOption(args, 'kind');
    if (kindOption !== undefined && !decoded.markerNames.includes(kindOption)) {
        // The kind list is data, so an unknown kind is answered with the list
        // this file carries rather than with an empty ranking. Asking xpcshell
        // for `TSan Error` — mochitest-only — is the case that makes an empty
        // result actively misleading.
        throw usageError(
            `no marker kind "${kindOption}" in ${harness} ${loaded.date}`,
            `This file carries: ${decoded.markerNames.join(', ')}.`
        );
    }

    const ranking = rankErrors(decoded, {
        grouping,
        sort,
        ...optional('message', stringOption(args, 'message')),
        ...optional('kind', kindOption),
        ...optional('test', stringOption(args, 'test')),
        ...optional('component', stringOption(args, 'component')),
        ...optional('file', stringOption(args, 'file')),
    });

    const limit = context.globals.limit ?? DEFAULT_LIMIT;
    const shown = applyLimit(ranking.rows, limit);
    const wantTaskIds = boolOption(args, 'task-ids');

    const result: ErrorsJson = {
        harness,
        date: loaded.date,
        weekday: weekdayOf(loaded.date),
        weekend: isWeekend(loaded.date),
        metadata: {
            generatedAt: decoded.generatedAt,
            jobCount: decoded.jobCount,
            processedJobCount: decoded.processedJobCount,
            invalidJobCount: decoded.invalidJobCount,
            dataSource: context.source.name,
        },
        availableDates: loaded.availableDates,
        availableDatesArePartial: loaded.partial,
        failingTestsOnly: harness === 'xpcshell',
        markerCounts: kindTotals(decoded),
        markerNames: [...decoded.markerNames],
        totals: {
            matched: ranking.totals.matchedCount,
            file: ranking.totals.fileCount,
            matchedGroups: ranking.totals.matchedGroups,
        },
        grouping,
        sort,
        rowCount: ranking.rows.length,
        // Task IDs are decoded only for the rows that will be shown: doing it
        // for tens of thousands of dropped rows would allocate for nothing.
        rows: shown.map((row) => toRowJson(row, wantTaskIds ? decoded : null)),
    };

    if (context.globals.format === 'json') {
        emit(context, toJson(result));
        return;
    }
    emit(
        context,
        context.globals.format === 'markdown' ? renderMarkdown(result) : renderText(result)
    );
}

/** Only sets a key when the value is present, for `exactOptionalPropertyTypes`. */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
    return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** Reads and validates `--group-by`. */
function readGrouping(args: ParsedArgs): ErrorGrouping {
    const value = stringOption(args, 'group-by') ?? 'location';
    const allowed: ErrorGrouping[] = ['message', 'location', 'test', 'component', 'kind'];
    if (!(allowed as string[]).includes(value)) {
        throw usageError(`--group-by expects one of ${allowed.join(', ')}, got "${value}"`);
    }
    return value as ErrorGrouping;
}

/** Reads and validates `--sort`. */
function readSort(args: ParsedArgs): ErrorSort {
    const value = stringOption(args, 'sort') ?? 'occurrences';
    if (value !== 'occurrences' && value !== 'tests') {
        throw usageError(`--sort expects occurrences or tests, got "${value}"`);
    }
    return value;
}

/** What `loadErrorsFile` resolved. */
interface LoadedErrors {
    file: ErrorsFile;
    date: string;
    /** Dates confirmed to have an errors file, newest first. */
    availableDates: string[];
    /** True when the search stopped early, so `availableDates` is a lower bound. */
    partial: boolean;
}

/**
 * Fetches the errors file for `--day`, or the most recent one that exists.
 *
 * The reason this is not `resolveDayWindow()`: the errors window is a subset of
 * `index.json`'s, so the only way to know a date has data is to ask for it.
 *
 * - **`--day` given.** One request. A 404 is exit 2 *with the dates that do
 *   have data* — the failure `CLI.md`'s compare-two-dates workflow hits the
 *   moment one of the dates falls outside the five, and the reason it must not
 *   read as an empty result.
 * - **No `--day`.** Walk newest-first and keep the first file that exists. One
 *   request on a good night, a handful after the generator has been down.
 */
async function loadErrorsFile(context: CommandContext, harness: Harness): Promise<LoadedErrors> {
    const index = await loadIndex(context, harness);
    // `index.json` is published newest first; sorting descending costs nothing
    // and makes "the most recent" true rather than assumed.
    const indexDates = [...index.dates].sort((a, b) => b.localeCompare(a));

    if (context.globals.day !== undefined) {
        const wanted = resolveErrorsDay(context.globals.day, indexDates);
        const name = errorsFileName(harness, wanted);
        progress(context, `Reading ${name.filename}…`);
        try {
            const file = await fetchJson<ErrorsFile>(context.source, name);
            // Only the requested date is known to exist. Enumerating the rest
            // would cost up to 20 requests to decorate a successful run.
            return { file, date: wanted, availableDates: [wanted], partial: true };
        } catch (error) {
            if (error instanceof DataFileNotFoundError) {
                const available = await probeAvailableDates(context, harness, indexDates);
                throw notFoundError(
                    `no ${harness} errors data for ${wanted}: ${name.filename} is not published.`,
                    available.dates.length === 0
                        ? 'No errors file exists for any date in the window. The errors files are ' +
                          'published for only a few of the dates `fx-tests dates` lists.'
                        : `Errors data exists for ${available.dates.length} of the ` +
                          `${indexDates.length} dates in the window: ${available.dates.join(', ')}.`
                );
            }
            throw error;
        }
    }

    // No `--day`: the fetch and the existence check are the same request.
    const limit = Math.min(indexDates.length, MAX_WINDOW_PROBE);
    for (let i = 0; i < limit; i++) {
        const date = indexDates[i]!;
        const name = errorsFileName(harness, date);
        progress(context, `Reading ${name.filename}…`);
        try {
            const file = await fetchJson<ErrorsFile>(context.source, name);
            return { file, date, availableDates: [date], partial: true };
        } catch (error) {
            if (error instanceof DataFileNotFoundError) {
                continue;
            }
            throw error;
        }
    }
    throw notFoundError(
        `no ${harness} errors data published for any of the ${indexDates.length} dates in the window`,
        'The errors files are published for only some dates. Run `fx-tests dates` for the window, ' +
            'and note that a date being listed there does not mean it has errors data.'
    );
}

/** What dates were found to have an errors file. */
interface ProbeResult {
    dates: string[];
    /** True when the walk stopped before checking every date. */
    partial: boolean;
}

/**
 * Asks for every date's errors file and reports which exist.
 *
 * Only reached after a `--day` has already missed, which is what makes up to 20
 * requests acceptable: the command owes the user the list of dates it could
 * have been asked for instead, and an error saying "not that date" without
 * saying "these dates" is the confusing empty result to avoid.
 *
 * A transport failure is not swallowed. A 404 means "not published" and
 * anything else means the source is unwell; treating the second as the first
 * would report an outage as "this date has no data".
 */
async function probeAvailableDates(
    context: CommandContext,
    harness: Harness,
    dates: readonly string[]
): Promise<ProbeResult> {
    const found: string[] = [];
    const limit = Math.min(dates.length, MAX_WINDOW_PROBE);
    for (let i = 0; i < limit; i++) {
        try {
            await context.source.fetch(errorsFileName(harness, dates[i]!));
            found.push(dates[i]!);
        } catch (error) {
            if (error instanceof DataFileNotFoundError) {
                continue;
            }
            throw error;
        }
    }
    return { dates: found, partial: limit < dates.length };
}

/** The name of a harness's errors file for one date. */
export function errorsFileName(harness: Harness, date: string): DataFileName {
    return { index: timingsIndex(harness), filename: `${harness}-${date}-errors.json` };
}

/**
 * Resolves `--day` for this command.
 *
 * `today`/`yesterday` are relative to `index.json`'s newest date, matching
 * `resolveDayKeyword()`. Note what that means here: "today" is the newest date
 * in the 21-day window, which frequently has **no errors file**. That is not
 * papered over by silently substituting the newest errors date — someone who
 * typed `--day today` and got data from two days earlier would compare two days
 * without knowing it. The 404 path says so instead.
 */
function resolveErrorsDay(day: string, indexDates: readonly string[]): string {
    if (day === 'today' || day === 'latest' || day === 'yesterday') {
        const newest = indexDates[0];
        if (newest === undefined) {
            throw notFoundError(`the index lists no dates, so --day ${day} cannot be resolved`);
        }
        return day === 'yesterday' ? addDays(newest, -1) : newest;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw usageError(`--day expects YYYY-MM-DD, "today" or "yesterday", got "${day}"`);
    }
    return day;
}

/** Builds one row's JSON, resolving task IDs only when asked. */
function toRowJson(row: ErrorGroup, file: DecodedErrorsFile | null): ErrorRowJson {
    const json: ErrorRowJson = {
        kind: row.kind,
        text: row.text,
        file: row.file,
        line: row.line,
        component: row.component,
        count: row.count,
        testCount: row.testCount,
        tests: row.tests.map((entry) => ({ path: entry.path, count: entry.count })),
        components: row.components.map((share) => ({
            component: share.component,
            count: share.count,
        })),
        componentSummary: componentSummary(row.components),
    };
    if (file !== null) {
        const seen = new Set<string>();
        for (const groupId of row.groupIds) {
            for (const raw of file.taskIdsOfGroup(groupId)) {
                const { taskId, retryId } = parseTaskId(raw);
                seen.add(`${taskId}.${retryId}`);
            }
        }
        json.taskIds = [...seen];
    }
    return json;
}

// --- rendering -----------------------------------------------------------

/** Plain text, laid out as `CLI.md`'s ranking example. */
function renderText(result: ErrorsJson): string {
    const lines: (string | null)[] = [];
    lines.push(...headerLines(result));
    lines.push('');

    if (result.rows.length === 0) {
        lines.push('No markers matched.');
        lines.push(
            `  The file holds ${fmtCount(result.totals.file)} markers, so this is a filter with ` +
                'no matches rather than an empty file.'
        );
        lines.push('');
        lines.push(...footerLines(result));
        return joinLines(lines);
    }

    // The `tests` column sits next to the count because it is the
    // discriminator: a message in one test is a candidate cause and the same
    // message in 9,000 is ambient noise, and the occurrence count alone does
    // not distinguish them.
    lines.push(
        ...table(
            [
                { header: 'occurrences', align: 'right' },
                { header: 'tests', align: 'right' },
                { header: result.grouping === 'test' ? 'test' : 'message' },
            ],
            result.rows.map((row) => [
                fmtCount(row.count),
                fmtCount(row.testCount),
                truncate(oneLine(describeRow(row)), 88),
            ])
        )
    );
    lines.push(moreLine(result.rowCount, result.rows.length));

    // Source locations go under the table rather than in a column: a path plus
    // a line is 60 characters and would squeeze the message off a terminal.
    const located = result.rows.filter((row) => locationOf(row) !== null);
    if (located.length > 0) {
        lines.push('');
        lines.push('Where they come from');
        for (const row of located) {
            lines.push(
                `  ${truncate(oneLine(describeRow(row)), 52).padEnd(52)}  ` +
                    `${truncate(locationOf(row)!, 60)}`
            );
        }
    }

    // Which components the rows land in, in the same shape and for the same
    // reason as the locations above: a component name is 40 characters and a
    // `+8 more` suffix is another 8, so it does not fit beside an 88-character
    // message.
    //
    // Skipped entirely when the grouping already answers it: `--group-by
    // component` rows *are* components and the summary would repeat the row's
    // own name, and `--group-by kind` rows have no component to report.
    const summarized = result.rows.filter(
        (row) => row.componentSummary !== null && componentBlockApplies(result.grouping)
    );
    if (summarized.length > 0) {
        lines.push('');
        lines.push('Which components');
        for (const row of summarized) {
            lines.push(
                `  ${truncate(oneLine(describeRow(row)), 52).padEnd(52)}  ` +
                    `${truncate(row.componentSummary!, 60)}`
            );
        }
    }

    // `CLI.md`'s "is this specific to one test, or everywhere?" view, only for
    // a query narrow enough that the answer is about a message rather than
    // about the file. At twenty rows the per-row test list is noise, and the
    // `tests` column already carries the signal.
    if (result.rows.length <= 3) {
        for (const row of result.rows) {
            if (row.tests.length === 0) {
                continue;
            }
            lines.push('');
            lines.push(`  ${spreadVerdict(row)}`);
            for (const test of row.tests.slice(0, 5)) {
                lines.push(
                    `    ${fmtCount(test.count).padStart(9)}  ${displayTestPath(test.path)}`
                );
            }
            if (row.testCount > 5) {
                lines.push(`    … ${fmtCount(row.testCount - 5)} more tests`);
            }
            // The full breakdown, at the same narrowness the test list uses:
            // once the query is down to a few rows the reader is asking about
            // *this message*, and "which components, how much each" is then the
            // question the one-line summary above only gestures at. Nothing to
            // add when the row has a single component — the summary already
            // named it and its count is the row's count.
            if (componentBlockApplies(result.grouping) && row.components.length > 1) {
                lines.push('');
                lines.push(`  Components — ${row.componentSummary!}`);
                for (const line of componentBreakdownLines(row.components as ComponentShare[])) {
                    lines.push(`    ${line}`);
                }
            }
        }
    }

    if (result.rows.some((row) => row.taskIds !== undefined)) {
        lines.push('');
        lines.push('Task IDs');
        for (const row of result.rows) {
            if (row.taskIds === undefined) {
                continue;
            }
            lines.push(`  ${truncate(oneLine(describeRow(row)), 76)}`);
            lines.push(`    ${row.taskIds.slice(0, 8).join(' ')}`);
            if (row.taskIds.length > 8) {
                lines.push(`    … ${fmtCount(row.taskIds.length - 8)} more`);
            }
        }
    }

    lines.push('');
    lines.push(...footerLines(result));
    return joinLines(lines);
}

/**
 * Whether the component blocks are worth printing for a grouping.
 *
 * Two groupings answer the component question by construction and get nothing
 * added:
 *
 * - **`component`**, where a row *is* a component. Its summary would restate the
 *   row's own name, and the breakdown would be a one-line block saying the row
 *   equals itself.
 * - **`kind`**, where a row is `C++ warning` and every component in the file
 *   appears under it. `rankErrors` does not even accumulate the map there.
 *
 * The other three — `location` (the default), `message` and `test` — all have
 * rows a component is a real attribute *of*, and all three get it.
 */
function componentBlockApplies(grouping: ErrorGrouping): boolean {
    return grouping !== 'component' && grouping !== 'kind';
}

/** The verdict line for a row's test spread. */
function spreadVerdict(row: ErrorRowJson): string {
    const head = `${fmtCount(row.count)} occurrences in ${fmtCount(row.testCount)} test${
        row.testCount === 1 ? '' : 's'
    }`;
    if (row.testCount === 1) {
        return `${head} — specific to that test, not ambient noise`;
    }
    if (row.testCount >= 50) {
        return `${head} — ambient: spread this wide is background noise, not a lead`;
    }
    return head;
}

/** The header: what file this is, and the per-kind totals. */
function headerLines(result: ErrorsJson): string[] {
    const lines: string[] = [];
    lines.push(
        `${result.harness}, ${dateWithWeekday(result.date)} — ` +
            `${fmtCount(result.metadata.jobCount)} jobs, ` +
            `${fmtCount(result.totals.file)} markers`
    );
    if (result.markerCounts.length > 0) {
        // From `metadata.markerCounts`, which is why "how noisy is this harness
        // today, and in which category" costs one file read and no extra pass.
        lines.push(
            '  ' +
                result.markerCounts
                    .map((entry) => `${entry.kind} ${fmtCount(entry.count)}`)
                    .join(' · ')
        );
    }
    if (result.weekend) {
        // `FORMATS.md` measures 2.6× between a Thursday and a Sunday. An
        // absolute count from a weekend is not comparable with a weekday's, and
        // comparing counts is what this command is for.
        lines.push(
            '  Weekend: push volume drops several-fold, so these counts are a fraction of a'
        );
        lines.push('  weekday’s and make a poor baseline. Prefer a weekday when comparing.');
    }
    if (result.failingTestsOnly) {
        // Not a footnote. An xpcshell ranking answers a different question, and
        // reading it as "what is noisy in CI" gives a wrong answer that looks
        // right.
        lines.push(
            '  xpcshell replays a test’s stdout only when it fails, so this file covers failing'
        );
        lines.push(
            '  tests only — a biased population, not a smaller sample. Use --harness mochitest'
        );
        lines.push('  to rank overall log noise.');
    }
    return lines;
}

/** The trailing note about the window, which is the fact most often assumed. */
function footerLines(result: ErrorsJson): string[] {
    return [
        describeWindow(result),
        '  There is no multi-day errors aggregate, so “was this error here when the test was',
        '  passing?” means running this command for two dates and comparing. Compare weekday',
        '  against weekday — weekend volume is a fraction of a weekday’s.',
    ];
}

/**
 * The sentence about which dates have errors data.
 *
 * The most useful line in the output for someone about to try `CLI.md`'s
 * compare-two-dates workflow, because that workflow silently does not work
 * outside these dates: `index.json` lists 21 and only about five have an errors
 * file, so the obvious "compare against last Tuesday" is a 404 rather than a
 * comparison.
 */
export function describeWindow(result: ErrorsJson): string {
    if (result.availableDatesArePartial) {
        return (
            'Errors files exist for only a few of the dates `fx-tests dates` lists; this is ' +
            `${result.date}. Pass --day <date> for another — a date with no errors file exits 2 ` +
            'and names the ones that have data.'
        );
    }
    return (
        `Errors files exist for ${result.availableDates.length} of the dates in the window: ` +
        `${result.availableDates.join(', ')}.`
    );
}

/** A row's display text. */
function describeRow(row: ErrorRowJson): string {
    if (row.text !== null) {
        return row.text === '' ? '(empty message text)' : row.text;
    }
    if (row.component !== null) {
        return row.component;
    }
    if (row.kind !== null) {
        return row.kind;
    }
    // Grouped by component, and this group's messages had none. Naming it beats
    // a blank cell, which reads as a rendering fault rather than as data.
    return '(no component recorded)';
}

/**
 * The source-location line, or `null`.
 *
 * Handles the case `FORMATS.md` flags: a message can carry a line and **no
 * file**, so `${file}:${line}` would print `null:1300`. A line with nothing to
 * attach it to is reported as such rather than dropped, since dropping it would
 * hide the distinction the grouping deliberately kept.
 */
function locationOf(row: ErrorRowJson): string | null {
    if (row.file !== null && row.line !== null) {
        return `${row.file}:${row.line}`;
    }
    if (row.file !== null) {
        return row.file;
    }
    if (row.line !== null) {
        return `line ${row.line} (no source file recorded)`;
    }
    return null;
}

/** Collapses a multi-line message onto one line. */
function oneLine(value: string): string {
    return value.replace(/\s*\r?\n\s*/g, ' ⏎ ').trim();
}

/**
 * A test path for display, naming the empty-path case rather than printing
 * nothing.
 *
 * The errors files intern a test path and a test name separately and both can
 * be empty — output the harness recorded against no particular test. As a blank
 * cell it reads as a rendering bug; named, it is a fact about where the marker
 * came from.
 */
function displayTestPath(path: string): string {
    return path === '' ? '(not attributed to a test)' : path;
}

/** Markdown, for pasting into a bug. */
function renderMarkdown(result: ErrorsJson): string {
    const lines: (string | null)[] = [];
    lines.push(md.heading(`${result.harness} errors — ${dateWithWeekday(result.date)}`, 1));
    lines.push('');
    for (const line of headerLines(result).slice(1)) {
        lines.push(line.trim());
    }
    lines.push('');
    if (result.rows.length === 0) {
        lines.push('No markers matched.');
        lines.push('');
        lines.push(...footerLines(result).map((line) => line.trim()));
        return joinLines(lines);
    }
    // Markdown gets the component as a column rather than as a block below:
    // this output is for pasting into a bug, where the component is often the
    // first thing a triager wants beside the message, and a table has the width
    // a terminal does not.
    const withComponents = componentBlockApplies(result.grouping);
    lines.push(
        ...md.table(
            [
                { header: 'occurrences', align: 'right' },
                { header: 'tests', align: 'right' },
                { header: 'message' },
                { header: 'location' },
                ...(withComponents ? [{ header: 'components' }] : []),
            ],
            result.rows.map((row) => [
                fmtCount(row.count),
                fmtCount(row.testCount),
                oneLine(describeRow(row)),
                locationOf(row) ?? '',
                ...(withComponents ? [row.componentSummary ?? ''] : []),
            ])
        )
    );
    lines.push(md.moreLine(result.rowCount, result.rows.length));
    lines.push('');
    lines.push(...footerLines(result).map((line) => line.trim()));
    return joinLines(lines);
}
