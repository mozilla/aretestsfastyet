/**
 * `fx-tests issues`, `failures`, `crashes` and `skips` — the tree-wide views.
 *
 * Four commands in one file because they read the same file, take almost the
 * same options and differ only in what they group by. Splitting them would
 * duplicate the loading, the filters and the "which file can answer this"
 * reasoning below four times.
 *
 * ## The file cannot attribute configurations, and that is not an empty result
 *
 * These read `{harness}-issues.json`, which is 2.8 MB because it **gave up all
 * attribution**: it has no `taskInfo`, its groups carry no `jobNameIds`, and so
 * every per-configuration query over it returns nothing whatever the test.
 *
 * `computeConfigStats()` returns `[]` on it, and `[]` means two entirely
 * different things — "no configuration failed" and "this file cannot say".
 * `canAttributeConfigs()` exists for exactly that distinction, and these
 * commands are where it becomes load-bearing: `fx-tests test` reads bucket
 * files and so never exercises it, which is why step 4 could leave the guard
 * untested. Here, `--config` is **refused** rather than silently matching
 * nothing, because a filter that quietly drops every row looks identical to a
 * tree with no failures.
 *
 * The escape hatch is real and is named in the message: `issues-with-taskids`
 * carries task attribution on the non-passing groups, at about 5× the bytes.
 *
 * ## `run-if` is not a disabled test
 *
 * `fx-tests skips` excludes `run-if` by default: it means the test is scoped to
 * another platform, so it not running here is the annotation working rather
 * than work someone owes. `--include-run-if` keeps them.
 *
 * The measured asymmetry matters for how that is reported. `FORMATS.md`: the
 * 21-day aggregates **already dropped** `run-if` upstream, while the daily
 * files keep them — 253,252 of 398,212 skipped runs on one daily file, 63.6%.
 * So on the aggregate these commands read, `--include-run-if` changes nothing
 * at all, and saying "excluded 0" would imply there were none to exclude rather
 * than that the generator got there first. The output says which population it
 * is reporting.
 */

import type { DecodedTimingFile } from '../../lib/formats/decode.ts';
import { canAttributeConfigs } from '../../lib/query/config-stats.ts';
import { type CrashGroup, groupCrashesBySignature } from '../../lib/query/crashes.ts';
import { type FailureGroup, groupFailuresByMessage } from '../../lib/query/failures.ts';
import {
    type IssueGroup,
    type IssueRow,
    type IssueType,
    type SkipRow,
    findIssues,
    findSkips,
    groupIssues,
} from '../../lib/query/issues.ts';
import { configFilter } from '../../lib/query/test-stats.ts';
import { type OptionSpecs, type ParsedArgs, boolOption, listOption, stringOption } from '../args.ts';
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
    moreLine,
    percent,
    table,
    truncate,
    truncatePath,
} from '../format/text.ts';
import type { Harness } from '../options.ts';
import { type DayWindow, loadIssues, resolveDayWindow } from '../data.ts';

/** Options shared by the four tree-wide commands. */
const SHARED_OPTIONS: OptionSpecs = {
    component: {
        type: 'string',
        placeholder: '<substring>',
        describe: 'Only tests whose Bugzilla component contains this.',
    },
    path: {
        type: 'string',
        placeholder: '<prefix>',
        describe: 'Only tests under this directory prefix.',
    },
};

/** `fx-tests issues` options. */
export const ISSUES_OPTIONS: OptionSpecs = {
    ...SHARED_OPTIONS,
    type: {
        type: 'list',
        placeholder: '<fail|timeout|crash|skip>',
        describe: 'Which outcomes count. Repeatable. Default fail,timeout,crash.',
    },
    'min-rate': {
        type: 'string',
        placeholder: '<pct>',
        describe: 'Drop tests failing less often than this, in percent.',
    },
    sort: {
        type: 'string',
        placeholder: '<rate|count|name>',
        describe: 'How to rank. Default rate.',
    },
    'group-by': {
        type: 'string',
        placeholder: '<test|component|directory|message>',
        describe: 'How to group. Default test. `message` is the one-bug-many-tests view.',
    },
};

/** `fx-tests failures` options. */
export const FAILURES_OPTIONS: OptionSpecs = {
    ...SHARED_OPTIONS,
    message: {
        type: 'string',
        placeholder: '<substring>',
        describe: 'Only messages containing this.',
    },
};

/** `fx-tests crashes` options. */
export const CRASHES_OPTIONS: OptionSpecs = {
    ...SHARED_OPTIONS,
    signature: {
        type: 'string',
        placeholder: '<substring>',
        describe: 'Only signatures containing this.',
    },
    minidumps: {
        type: 'boolean',
        describe: 'Print minidump IDs, which `fx-tests crash` then reads.',
    },
};

/** `fx-tests skips` options. */
export const SKIPS_OPTIONS: OptionSpecs = {
    ...SHARED_OPTIONS,
    'include-run-if': {
        type: 'boolean',
        describe: 'Keep run-if skips, which mean "not applicable here" rather than "disabled".',
    },
    'group-by': {
        type: 'string',
        placeholder: '<test|component|directory>',
        describe: 'How to group. Default test.',
    },
};

/** The default row count for every tree-wide view. */
const DEFAULT_LIMIT = 20;

// --- shared loading ------------------------------------------------------

/** What every one of these commands needs before it can answer. */
interface TreeQuery {
    harness: Harness;
    file: DecodedTimingFile;
    window: DayWindow;
    pathPrefix: string | undefined;
    component: string | undefined;
    /** The header every command prints. */
    header: TreeHeader;
}

/** The provenance header, shared by all four commands' JSON. */
interface TreeHeader {
    harness: string;
    family: string;
    startDate: string;
    endDate: string;
    dayCount: number;
    singleDay: boolean;
    testCount: number;
    dataSource: string;
    /**
     * Whether the file can attribute runs to configurations.
     *
     * False on `issues.json`. Reported in every response because a consumer
     * that sees no configurations needs to know whether that is an answer.
     */
    canAttributeConfigs: boolean;
    /**
     * Whether the file records minidump IDs on its CRASH groups.
     *
     * False on `issues.json`, measured: its CRASH groups carry `counts`,
     * `days` and `crashSignatureIds` and no `minidumps` field at all — 0 of
     * 676 groups. Separate from `canAttributeConfigs` because they are
     * different capabilities that happen to be absent from the same file, and
     * a caller checking one must not conclude anything about the other.
     */
    recordsMinidumps: boolean;
}

/**
 * Loads the aggregate and applies the shared validation.
 *
 * The `--config` refusal is the important part, and it is a refusal rather than
 * a warning on purpose: `issues.json` attributes nothing, so a config filter
 * over it matches zero rows for every input. Printing an empty table would be a
 * confidently wrong answer, which is the failure mode this project keeps
 * producing.
 */
async function loadTreeQuery(
    context: CommandContext,
    args: ParsedArgs,
    commandName: string
): Promise<TreeQuery> {
    const harness: Harness = context.globals.harness ?? 'xpcshell';
    progress(context, `Reading ${harness}-issues.json…`);
    const { file } = await loadIssues(context, harness);

    if (
        (context.globals.config.length > 0 || context.globals.excludeConfig.length > 0) &&
        !canAttributeConfigs(file)
    ) {
        throw usageError(
            `--config cannot be applied to ${harness}-issues.json: the file records no job ` +
                'names, so every configuration filter over it matches nothing',
            'This is a property of the file, not of the tree — it dropped all attribution to be ' +
                '2.8 MB. Use `fx-tests test <path> --config` for one test, which reads a bucket file.'
        );
    }

    const window = resolveDayWindow(context.globals, file);
    void commandName;
    return {
        harness,
        file,
        window,
        pathPrefix: stringOption(args, 'path'),
        component: stringOption(args, 'component'),
        header: {
            harness,
            family: file.family,
            startDate: window.startDate,
            endDate: window.endDate,
            dayCount: window.dayCount,
            singleDay: window.singleDay,
            testCount: file.testCount,
            dataSource: context.source.name,
            canAttributeConfigs: canAttributeConfigs(file),
            recordsMinidumps: recordsMinidumps(file),
        },
    };
}

/**
 * Whether a file's CRASH groups carry minidump IDs.
 *
 * `issues.json` does not — see `TreeHeader.recordsMinidumps`. Keyed on the
 * family rather than on whether any group happened to have one, because "this
 * file cannot record them" and "no crash in this window uploaded one" are
 * different answers and only the family distinguishes them reliably.
 */
function recordsMinidumps(file: DecodedTimingFile): boolean {
    return file.family !== 'issues';
}

/** The shared query options, as the `lib/query` functions take them. */
function sharedOptions(query: TreeQuery): {
    pathPrefix?: string;
    component?: string;
    dayRange?: { from: number; to: number };
} {
    return {
        ...(query.pathPrefix === undefined ? {} : { pathPrefix: query.pathPrefix }),
        ...(query.component === undefined ? {} : { component: query.component }),
        ...(query.window.range === null ? {} : { dayRange: query.window.range }),
    };
}

/** The header lines every tree-wide command prints. */
function headerLines(header: TreeHeader, subject: string): string[] {
    const lines: string[] = [];
    lines.push(
        `${header.harness} ${subject} — ` +
            (header.singleDay
                ? dateWithWeekday(header.endDate)
                : `${header.dayCount} days (${dateWithWeekday(header.startDate)} … ` +
                  `${dateWithWeekday(header.endDate)})`) +
            `, ${fmtCount(header.testCount)} tests in the file`
    );
    if (!header.canAttributeConfigs) {
        // Stated up front rather than only when someone asks for a config:
        // a reader comparing this against `fx-tests test` needs to know the two
        // files answer different questions.
        lines.push(
            '  This file records no job names, so nothing here can be broken down by ' +
                'configuration.'
        );
    }
    return lines;
}

// --- fx-tests issues -----------------------------------------------------

/** The `--json` shape for `issues`. */
export interface IssuesJson {
    header: TreeHeader;
    groupBy: string;
    sort: string;
    types: IssueType[];
    rowCount: number;
    rows: unknown[];
}

/** Runs `fx-tests issues`. */
export async function runIssues(context: CommandContext, args: ParsedArgs): Promise<void> {
    rejectPositionals(args, 'issues');
    const query = await loadTreeQuery(context, args, 'issues');

    const types = readTypes(args);
    const minRate = readPercent(stringOption(args, 'min-rate'), '--min-rate');
    const sort = readSort(args, ['rate', 'count', 'name'], 'rate');
    const groupBy = readGroupBy(args, ['test', 'component', 'directory', 'message'], 'test');
    const limit = context.globals.limit ?? DEFAULT_LIMIT;

    // `--group-by message` is a different query, not a regrouping of the rows:
    // an `IssueRow` carries counts, not the messages behind them. `CLI.md` calls
    // it the "one bug, many tests" view and `failures.ts` is where it lives.
    if (groupBy === 'message') {
        const groups = groupFailuresByMessage(query.file, sharedOptions(query));
        const shown = applyLimit(groups, limit);
        const result = {
            header: query.header,
            groupBy,
            sort,
            types,
            rowCount: groups.length,
            rows: shown.map(failureGroupJson),
        };
        emitResult(context, result, () => renderFailures(result, 'Issues by message'));
        return;
    }

    const rows = findIssues(query.file, {
        ...sharedOptions(query),
        types,
        ...(minRate === undefined ? {} : { minRate }),
    });

    if (groupBy === 'component' || groupBy === 'directory') {
        const groups = sortGroups(groupIssues(rows, groupBy), sort);
        const shown = applyLimit(groups, limit);
        const result = {
            header: query.header,
            groupBy,
            sort,
            types,
            rowCount: groups.length,
            rows: shown,
        };
        emitResult(context, result, () => renderIssueGroups(result));
        return;
    }

    const sorted = sortIssueRows(rows, sort);
    const shown = applyLimit(sorted, limit);
    const result = {
        header: query.header,
        groupBy,
        sort,
        types,
        rowCount: sorted.length,
        rows: shown.map(issueRowJson),
    };
    emitResult(context, result, () => renderIssueRows(result));
}

/** One issue row's JSON. */
function issueRowJson(row: IssueRow): Record<string, unknown> {
    return {
        test: row.fullPath,
        directory: row.directory,
        component: row.component,
        runCount: row.runCount,
        passCount: row.passCount,
        failCount: row.failCount,
        timeoutCount: row.timeoutCount,
        crashCount: row.crashCount,
        skipCount: row.skipCount,
        failRate: row.failRate,
    };
}

/** Sorts issue rows. */
function sortIssueRows(rows: readonly IssueRow[], sort: string): IssueRow[] {
    const sorted = [...rows];
    if (sort === 'name') {
        sorted.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
    } else if (sort === 'count') {
        const nonPass = (row: IssueRow): number =>
            row.failCount + row.timeoutCount + row.crashCount + row.skipCount;
        sorted.sort((a, b) => nonPass(b) - nonPass(a) || a.fullPath.localeCompare(b.fullPath));
    }
    // `rate` is `findIssues`' own order, so nothing to do.
    return sorted;
}

/** Sorts grouped rows. */
function sortGroups(groups: readonly IssueGroup[], sort: string): IssueGroup[] {
    const sorted = [...groups];
    if (sort === 'name') {
        sorted.sort((a, b) => a.key.localeCompare(b.key));
    } else if (sort === 'count') {
        const nonPass = (g: IssueGroup): number => g.failCount + g.timeoutCount + g.crashCount;
        sorted.sort((a, b) => nonPass(b) - nonPass(a) || a.key.localeCompare(b.key));
    }
    return sorted;
}

/** Renders the per-test issues table. */
function renderIssueRows(result: {
    header: TreeHeader;
    rowCount: number;
    rows: Record<string, unknown>[];
}): Rendered {
    return {
        preamble: headerLines(result.header, 'issues'),
        table: {
            columns: [
                { header: 'Test' },
                { header: 'runs', align: 'right' },
                { header: 'fail', align: 'right' },
                { header: 'timeout', align: 'right' },
                { header: 'crash', align: 'right' },
                { header: 'rate', align: 'right' },
            ],
            rows: result.rows.map((row) => [
                // Leading directories go, not the filename: the basename is
                // what identifies a test and what `fx-tests test` takes.
                truncatePath(String(row.test), 62),
                fmtCount(Number(row.runCount)),
                fmtCount(Number(row.failCount)),
                fmtCount(Number(row.timeoutCount)),
                fmtCount(Number(row.crashCount)),
                percent(Number(row.failRate)),
            ]),
        },
        total: result.rowCount,
        shown: result.rows.length,
        epilogue: [],
        empty: 'No test matched.',
    };
}

/** Renders the grouped issues table. */
function renderIssueGroups(result: {
    header: TreeHeader;
    groupBy: string;
    rowCount: number;
    rows: IssueGroup[];
}): Rendered {
    return {
        preamble: headerLines(result.header, `issues by ${result.groupBy}`),
        table: {
            columns: [
                { header: result.groupBy === 'component' ? 'Component' : 'Directory' },
                { header: 'tests', align: 'right' },
                { header: 'runs', align: 'right' },
                { header: 'fail', align: 'right' },
                { header: 'rate', align: 'right' },
            ],
            rows: result.rows.map((group) => [
                truncate(group.key, 58),
                fmtCount(group.testCount),
                fmtCount(group.runCount),
                fmtCount(group.failCount + group.timeoutCount + group.crashCount),
                percent(group.failRate),
            ]),
        },
        total: result.rowCount,
        shown: result.rows.length,
        epilogue: [],
        empty: 'No test matched.',
    };
}

// --- fx-tests failures ---------------------------------------------------

/** Runs `fx-tests failures`. */
export async function runFailures(context: CommandContext, args: ParsedArgs): Promise<void> {
    rejectPositionals(args, 'failures');
    const query = await loadTreeQuery(context, args, 'failures');
    const limit = context.globals.limit ?? DEFAULT_LIMIT;

    const groups = groupFailuresByMessage(query.file, {
        ...sharedOptions(query),
        ...optional('message', stringOption(args, 'message')),
    });
    const shown = applyLimit(groups, limit);
    const result = {
        header: query.header,
        groupBy: 'message',
        sort: 'count',
        types: ['fail'] as IssueType[],
        rowCount: groups.length,
        rows: shown.map(failureGroupJson),
    };
    emitResult(context, result, () => renderFailures(result, 'failures by message'));
}

/** One failure group's JSON. */
function failureGroupJson(group: FailureGroup): Record<string, unknown> {
    return {
        message: group.message,
        count: group.count,
        testCount: group.testCount,
        tests: group.tests.map((test) => ({ test: test.fullPath, count: test.count })),
        // A Set does not survive JSON.stringify; spelled out rather than
        // silently serializing as `{}`.
        jobNames: [...group.jobNames],
        taskIds: group.taskIds,
    };
}

/** Renders a message-grouped table. */
function renderFailures(
    result: { header: TreeHeader; rowCount: number; rows: Record<string, unknown>[] },
    subject: string
): Rendered {
    return {
        preamble: headerLines(result.header, subject),
        // `tests` is the discriminator here for the same reason it is in
        // `errors`: one message across thirty tests is one bug, and across one
        // test is another kind of bug entirely.
        table: {
            columns: [
                { header: 'failures', align: 'right' },
                { header: 'tests', align: 'right' },
                { header: 'message' },
            ],
            rows: result.rows.map((row) => [
                fmtCount(Number(row.count)),
                fmtCount(Number(row.testCount)),
                truncate(oneLine(String(row.message ?? '(no message recorded)')), 84),
            ]),
        },
        total: result.rowCount,
        shown: result.rows.length,
        epilogue: [],
        empty: 'No failure matched.',
    };
}

// --- fx-tests crashes ----------------------------------------------------

/** Runs `fx-tests crashes`. */
export async function runCrashes(context: CommandContext, args: ParsedArgs): Promise<void> {
    rejectPositionals(args, 'crashes');
    const query = await loadTreeQuery(context, args, 'crashes');
    const limit = context.globals.limit ?? DEFAULT_LIMIT;
    const wantMinidumps = boolOption(args, 'minidumps');
    if (wantMinidumps && !query.header.recordsMinidumps) {
        // Refused rather than printing an empty section, for the same reason
        // `--config` is: a flag that silently produces nothing is
        // indistinguishable from a window in which nothing crashed.
        throw usageError(
            `--minidumps cannot be answered from ${query.harness}-issues.json: its CRASH groups ` +
                'record signatures and counts but no minidump IDs',
            'This is a property of the file. `fx-tests test <path> --task-ids` reads a bucket ' +
                'file, which carries them.'
        );
    }

    const groups = groupCrashesBySignature(query.file, {
        ...sharedOptions(query),
        ...optional('signature', stringOption(args, 'signature')),
    });
    const shown = applyLimit(groups, limit);
    const result = {
        header: query.header,
        rowCount: groups.length,
        rows: shown.map((group) => crashGroupJson(group, wantMinidumps)),
    };
    emitResult(context, result, () => renderCrashes(result, wantMinidumps, query.header));
}

/** One crash group's JSON. */
function crashGroupJson(group: CrashGroup, withMinidumps: boolean): Record<string, unknown> {
    const json: Record<string, unknown> = {
        signature: group.signature,
        count: group.count,
        testCount: group.testCount,
        tests: group.tests.map((test) => ({ test: test.fullPath, count: test.count })),
        jobNames: [...group.jobNames],
        /** How many dumps this group has that can actually be fetched. */
        minidumpCount: group.minidumps.length,
    };
    if (withMinidumps) {
        json.minidumps = group.minidumps.map((dump) => ({
            taskId: dump.taskId,
            retryId: dump.retryId,
            minidumpId: dump.minidumpId,
            /** Copy-pasteable straight into `fx-tests crash`. */
            command: `fx-tests crash ${dump.taskId}.${dump.retryId} ${dump.minidumpId}`,
        }));
    }
    return json;
}

/** Renders the crashes table. */
function renderCrashes(
    result: { rowCount: number; rows: Record<string, unknown>[] },
    withMinidumps: boolean,
    header: TreeHeader
): Rendered {
    const epilogue: string[] = [];
    const anyDumps = result.rows.some((row) => Number(row.minidumpCount) > 0);

    if (!header.recordsMinidumps) {
        // The same shape of trap as `canAttributeConfigs`, and measured the
        // same way: `issues.json`'s CRASH groups carry `counts`, `days` and
        // `crashSignatureIds` and **no `minidumps` field at all** — 0 of 676
        // groups have one. So "0 dumps" here is not "the dumps were never
        // uploaded", it is "this file does not record them", and the two would
        // otherwise be indistinguishable.
        epilogue.push(
            '  This file records no minidump IDs, so the dumps column is 0 for every row — that'
        );
        epilogue.push(
            '  is a property of the file, not of the crashes. `fx-tests test <path> --task-ids`'
        );
        epilogue.push('  reads a bucket file, which does carry them.');
    } else if (withMinidumps) {
        epilogue.push('Minidumps');
        for (const row of result.rows) {
            const dumps = row.minidumps as { command: string }[] | undefined;
            if (dumps === undefined || dumps.length === 0) {
                continue;
            }
            epilogue.push(`  ${truncate(String(row.signature ?? '(not symbolized)'), 76)}`);
            for (const dump of dumps.slice(0, 3)) {
                epilogue.push(`    ${dump.command}`);
            }
            if (dumps.length > 3) {
                epilogue.push(`    … ${dumps.length - 3} more`);
            }
        }
    } else {
        // A group can legitimately have crashes and no dump even on a file that
        // records them: 58 mochitest entries in the sweep had a null signature
        // *and* a null minidump, the dump never having been uploaded.
        const noDumps = result.rows.filter((row) => Number(row.minidumpCount) === 0);
        if (noDumps.length > 0) {
            epilogue.push(
                `  ${noDumps.length} of these have no minidump to fetch: the dump was never ` +
                    'uploaded, so the crash is counted but cannot be read.'
            );
        }
        if (anyDumps) {
            epilogue.push('  --minidumps prints the IDs, which `fx-tests crash` reads.');
        }
    }

    return {
        preamble: headerLines(header, 'crashes by signature'),
        table: {
            columns: [
                { header: 'crashes', align: 'right' },
                { header: 'tests', align: 'right' },
                { header: 'dumps', align: 'right' },
                { header: 'signature' },
            ],
            rows: result.rows.map((row) => [
                fmtCount(Number(row.count)),
                fmtCount(Number(row.testCount)),
                fmtCount(Number(row.minidumpCount)),
                truncate(String(row.signature ?? '(not symbolized)'), 76),
            ]),
        },
        total: result.rowCount,
        shown: result.rows.length,
        epilogue,
        empty: 'No crash matched.',
    };
}

// --- fx-tests skips ------------------------------------------------------

/** Runs `fx-tests skips`. */
export async function runSkips(context: CommandContext, args: ParsedArgs): Promise<void> {
    rejectPositionals(args, 'skips');
    const query = await loadTreeQuery(context, args, 'skips');
    const limit = context.globals.limit ?? DEFAULT_LIMIT;
    const includeRunIf = boolOption(args, 'include-run-if');
    const groupBy = readGroupBy(args, ['test', 'component', 'directory'], 'test');

    const rows = findSkips(query.file, {
        ...sharedOptions(query),
        includeRunIf,
    });

    // The measured asymmetry: the 21-day aggregates already dropped `run-if`
    // upstream, so on this file the flag changes nothing. Saying which
    // population is being reported is the difference between "there are no
    // run-if skips" and "this file never had any to begin with".
    const runIfIsUpstreamFiltered = query.file.family !== 'daily';

    const sorted = [...rows].sort((a, b) => b.skipCount - a.skipCount);
    const shown = applyLimit(sorted, limit);
    const result = {
        header: query.header,
        groupBy,
        includeRunIf,
        runIfIsUpstreamFiltered,
        rowCount: sorted.length,
        totalSkips: sorted.reduce((sum, row) => sum + row.skipCount, 0),
        rows: shown.map(skipRowJson),
    };
    emitResult(context, result, () => renderSkips(result));
}

/** One skip row's JSON. */
function skipRowJson(row: SkipRow): Record<string, unknown> {
    return {
        test: row.fullPath,
        directory: row.directory,
        component: row.component,
        skipCount: row.skipCount,
        // Maps and Sets do not survive JSON.stringify.
        messages: [...row.messages].map(([message, count]) => ({ message, count })),
        jobNames: [...row.jobNames],
    };
}

/** Renders the skips table. */
function renderSkips(result: {
    header: TreeHeader;
    includeRunIf: boolean;
    runIfIsUpstreamFiltered: boolean;
    rowCount: number;
    totalSkips: number;
    rows: Record<string, unknown>[];
}): Rendered {
    const preamble = headerLines(result.header, 'skips');
    preamble.push(
        `  ${fmtCount(result.totalSkips)} skipped runs across ${fmtCount(result.rowCount)} tests.`
    );
    // The population statement. Which of these prints is the whole point of
    // tracking `runIfIsUpstreamFiltered`.
    if (result.runIfIsUpstreamFiltered) {
        preamble.push(
            '  This is a 21-day aggregate, and the generator already dropped run-if skips from it,'
        );
        preamble.push(
            '  so --include-run-if would change nothing here. A daily file keeps them — on one'
        );
        preamble.push('  measured day they were 63.6% of all skipped runs.');
    } else if (result.includeRunIf) {
        preamble.push(
            '  Including run-if skips, which mean "not applicable on this platform" rather than'
        );
        preamble.push('  "disabled".');
    } else {
        preamble.push(
            '  Excluding run-if skips, which mean "not applicable on this platform" rather than'
        );
        preamble.push('  "disabled" (--include-run-if to keep them).');
    }

    return {
        preamble,
        table: {
            columns: [
                { header: 'Test' },
                { header: 'skips', align: 'right' },
                { header: 'reason' },
            ],
            rows: result.rows.map((row) => {
                const messages = row.messages as { message: string; count: number }[];
                return [
                    truncatePath(String(row.test), 56),
                    fmtCount(Number(row.skipCount)),
                    truncate(oneLine(messages[0]?.message ?? '(no reason recorded)'), 50) +
                        (messages.length > 1 ? ` (+${messages.length - 1} more)` : ''),
                ];
            }),
        },
        total: result.rowCount,
        shown: result.rows.length,
        epilogue: [],
        empty: 'No skipped test matched.',
    };
}

// --- shared helpers ------------------------------------------------------

/** Only sets a key when the value is present. */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
    return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** These commands take no positionals; a stray one is usually a missing flag. */
function rejectPositionals(args: ParsedArgs, name: string): void {
    if (args.positionals.length > 0) {
        throw usageError(
            `${name} takes no positional arguments, got "${args.positionals[0]}"`,
            `Did you mean --path ${args.positionals[0]} or --component "${args.positionals[0]}"?`
        );
    }
}

/** Reads and validates `--type`. */
function readTypes(args: ParsedArgs): IssueType[] {
    const values = listOption(args, 'type');
    if (values.length === 0) {
        return ['fail', 'timeout', 'crash'];
    }
    const allowed: IssueType[] = ['fail', 'timeout', 'crash', 'skip'];
    for (const value of values) {
        if (!(allowed as string[]).includes(value)) {
            throw usageError(`--type expects one of ${allowed.join(', ')}, got "${value}"`);
        }
    }
    return values as IssueType[];
}

/** Reads and validates `--sort`. */
function readSort(args: ParsedArgs, allowed: readonly string[], fallback: string): string {
    const value = stringOption(args, 'sort') ?? fallback;
    if (!allowed.includes(value)) {
        throw usageError(`--sort expects one of ${allowed.join(', ')}, got "${value}"`);
    }
    return value;
}

/** Reads and validates `--group-by`. */
function readGroupBy(args: ParsedArgs, allowed: readonly string[], fallback: string): string {
    const value = stringOption(args, 'group-by') ?? fallback;
    if (!allowed.includes(value)) {
        throw usageError(`--group-by expects one of ${allowed.join(', ')}, got "${value}"`);
    }
    return value;
}

/**
 * Reads a percentage option.
 *
 * A string rather than a `number` option because `--min-rate 0.5` is a
 * perfectly reasonable thing to type and the number parser rejects
 * non-integers.
 */
function readPercent(value: string | undefined, flag: string): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        throw usageError(`${flag} expects a percentage between 0 and 100, got "${value}"`);
    }
    return parsed;
}

/**
 * What a tree-wide command produces, before it is laid out.
 *
 * Separating the content from the layout is what lets one renderer serve both
 * text and Markdown. The alternative — render text and fence it for
 * `--markdown` — is what these four used to do, and it made them the only
 * commands in the CLI whose `--markdown` was not real Markdown: someone pasting
 * `manifests` and `issues` into one bug got a table and a code block.
 */
interface Rendered {
    /** Lines above the table: the provenance header and any caveats. */
    preamble: string[];
    /** The table, or `null` for a command that has nothing to show. */
    table: { columns: Column[]; rows: string[][] } | null;
    /** The `… n more` line's inputs. */
    total: number;
    shown: number;
    /** Lines below the table. */
    epilogue: string[];
    /** Shown instead of the table when there are no rows. */
    empty: string;
}

/** Emits in whichever format was asked for. */
function emitResult(context: CommandContext, result: unknown, build: () => Rendered): void {
    if (context.globals.format === 'json') {
        emit(context, toJson(result));
        return;
    }
    const content = build();
    emit(
        context,
        context.globals.format === 'markdown'
            ? renderMarkdownFrom(content)
            : renderTextFrom(content)
    );
}

/** Plain text: the shared aligned-column layout. */
function renderTextFrom(content: Rendered): string {
    const lines: (string | null)[] = [...content.preamble, ''];
    if (content.table === null || content.table.rows.length === 0) {
        lines.push(content.empty);
    } else {
        lines.push(...table(content.table.columns, content.table.rows));
        lines.push(moreLine(content.total, content.shown));
    }
    lines.push(...content.epilogue);
    return joinLines(lines);
}

/**
 * Markdown: a real table, matching every other command.
 *
 * The preamble becomes prose rather than staying inside a fence, so a pasted
 * report reads as a report. `md.table` escapes cell contents, which matters
 * here because a failure message can contain a pipe.
 */
function renderMarkdownFrom(content: Rendered): string {
    const lines: (string | null)[] = [];
    const [heading, ...caveats] = content.preamble;
    lines.push(md.heading(heading ?? 'Results', 1));
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

/** Collapses a multi-line message onto one line. */
function oneLine(value: string): string {
    return value.replace(/\s*\r?\n\s*/g, ' ⏎ ').trim();
}

/** Re-exported so `configFilter` stays reachable if a bucket-backed mode lands. */
export { configFilter };
