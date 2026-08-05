/**
 * `fx-tests manifests [name]` — which manifest is eating a job's time budget.
 *
 * Reads `manifests.json` from the `manifest-timings` index: its own index, its
 * own shape, and **one day** rather than a 21-day window despite there being no
 * date in the filename. So `--day` and `--since` have nothing to filter here,
 * and both are refused rather than ignored.
 *
 * ## What this answers, and what it does not
 *
 * It narrows a job timeout to a manifest and a configuration. It does **not**
 * say why that manifest is slow: the file holds per-manifest durations, not
 * per-test ones, so "one slow test or a thousand cheap ones" is a follow-up for
 * `fx-tests test --durations` on the tests in that manifest. Worth stating
 * rather than leaving implicit — it is easy to expect more from this data than
 * it holds, and the output says so in as many words.
 *
 * ## The all-zero-durations rule
 *
 * A manifest whose durations are all zero on a config was **skipped** there,
 * not run instantly (`manifests.html:415`), and `FORMATS.md` measures 71,272 of
 * 433,836 runs at zero — 16.4%. Those pairs carry no duration statistics at all
 * rather than zeros, sort last rather than first, and are listed under
 * "Skipped on". Getting this wrong makes every skipped config the fastest row
 * in the table, which inverts the answer to the only question being asked.
 */

import { type ManifestsFile, decodeManifests } from '../../lib/formats/manifests.ts';
import {
    type DurationStats,
    type ManifestConfigStats,
    type ManifestSort,
    type ManifestStats,
    computeManifestStats,
    configurationFilter,
    sortManifests,
    zeroDurationCensus,
} from '../../lib/query/manifest-stats.ts';
import { formatDurationPadded } from '../../lib/model/duration.ts';
import { MANIFEST_TIMINGS_INDEX, fetchJson } from '../../lib/sources/source.ts';
import { type OptionSpecs, type ParsedArgs, listOption, stringOption } from '../args.ts';
import { type CommandContext, emit, progress } from '../context.ts';
import { notFoundError, usageError } from '../errors.ts';
import { toJson } from '../format/json.ts';
import * as md from '../format/markdown.ts';
import {
    type Column,
    applyLimit,
    count as fmtCount,
    dateWithWeekday,
    joinLines,
    tableSection,
    truncate,
} from '../format/text.ts';

/** Options `manifests` adds to the globals. */
export const MANIFESTS_OPTIONS: OptionSpecs = {
    job: {
        type: 'list',
        placeholder: '<list>',
        describe: 'Comma-separated job-name substrings. Same as --config.',
    },
    platform: {
        type: 'list',
        placeholder: '<list>',
        describe: 'Comma-separated platforms: linux, windows, mac, android.',
    },
    sort: {
        type: 'string',
        placeholder: '<median|p95|max|runs|total|name>',
        describe: 'How to rank manifests. Default median.',
    },
    'slower-than': {
        type: 'string',
        placeholder: '<duration>',
        describe: 'Only manifests with a median above this, e.g. 30s, 5m, 500ms.',
    },
};

/** The default number of manifest rows shown. */
const DEFAULT_LIMIT = 10;

/** The `--json` shape. */
export interface ManifestsJson {
    /** Set when a manifest name was given as a positional. */
    manifest: string | null;
    metadata: {
        /** The single day the file covers. */
        date: string;
        weekday: string | null;
        repository: string;
        generatedAt: string;
        processedJobCount: number;
        failedJobCount: number;
        dataSource: string;
    };
    /**
     * How much of the file is "skipped" rather than "fast".
     *
     * Reported unconditionally because the share is large and the distinction
     * is the one thing about this file that is invisible in its format.
     */
    zeroDurations: {
        zeroRuns: number;
        totalRuns: number;
        skippedPairs: number;
        totalPairs: number;
    };
    sort: ManifestSort;
    /** How many manifests matched, before `--limit`. */
    rowCount: number;
    rows: ManifestRowJson[];
}

interface ManifestRowJson {
    manifest: string;
    runCount: number;
    /** `null` when the manifest was skipped on every configuration. */
    durations: DurationStats | null;
    platforms: { platform: string; configCount: number }[];
    skippedOn: string[];
    configs: {
        configuration: string;
        runCount: number;
        skipped: boolean;
        durations: DurationStats | null;
    }[];
}

/** Runs the command. */
export async function runManifests(context: CommandContext, args: ParsedArgs): Promise<void> {
    if (args.positionals.length > 1) {
        throw usageError(
            `manifests takes at most one manifest name, got ${args.positionals.length}: ` +
                args.positionals.join(', ')
        );
    }
    // `manifests.json` covers one day and carries no day axis at all, so a day
    // filter has nothing to filter. Refused rather than ignored: silently
    // dropping `--day` would report yesterday's file under today's flag.
    if (context.globals.day !== undefined || context.globals.since !== undefined) {
        throw usageError(
            'manifests.json covers a single day and has no day axis, so --day and --since do not apply',
            'The file the index publishes is the latest one; its date is in the output header.'
        );
    }

    const wanted = args.positionals[0];
    const sort = readSort(args);
    const slowerThanMs = readDuration(stringOption(args, 'slower-than'));

    progress(context, 'Reading manifests.json…');
    const raw = await fetchJson<ManifestsFile>(context.source, {
        index: MANIFEST_TIMINGS_INDEX,
        filename: 'manifests.json',
    });
    const file = decodeManifests(raw);

    // `--job` and `--config` are the same filter; `CLI.md` lists both, and a
    // caller should not have to know which one this command took.
    const include = [...listOption(args, 'job'), ...context.globals.config];
    const platforms = listOption(args, 'platform');
    const jobFilter =
        include.length > 0 || context.globals.excludeConfig.length > 0
            ? configurationFilter(include, context.globals.excludeConfig)
            : undefined;

    const stats = computeManifestStats(file, {
        ...(wanted === undefined ? {} : { manifest: wanted }),
        ...(jobFilter === undefined ? {} : { jobFilter }),
        ...(platforms.length === 0 ? {} : { platforms }),
        ...(slowerThanMs === undefined ? {} : { slowerThanMs }),
    });

    if (wanted !== undefined && stats.length === 0) {
        throw notFoundError(
            `no manifest matching "${wanted}" in manifests.json for ${file.date}`,
            'The name is matched as a substring. Run `fx-tests manifests` with no argument ' +
                'to see the slowest manifests, or widen the filters.'
        );
    }

    const sorted = sortManifests(stats, sort);
    const limit = context.globals.limit ?? DEFAULT_LIMIT;
    // A named manifest is one row and the caller asked for it by name, so it is
    // never truncated: `--limit` is about ranking, not about lookup.
    const shown = wanted === undefined ? applyLimit(sorted, limit) : sorted;

    const result: ManifestsJson = {
        manifest: wanted ?? null,
        metadata: {
            date: file.date,
            weekday: weekdayOfDate(file.date),
            repository: file.repository,
            generatedAt: file.generatedAt,
            processedJobCount: file.processedJobCount,
            failedJobCount: file.failedJobCount,
            dataSource: context.source.name,
        },
        zeroDurations: zeroDurationCensus(file),
        sort,
        rowCount: sorted.length,
        rows: shown.map(toRowJson),
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

/** Reads and validates `--sort`. */
function readSort(args: ParsedArgs): ManifestSort {
    const value = stringOption(args, 'sort') ?? 'median';
    const allowed: ManifestSort[] = ['median', 'p95', 'max', 'runs', 'total', 'name'];
    if (!(allowed as string[]).includes(value)) {
        throw usageError(`--sort expects one of ${allowed.join(', ')}, got "${value}"`);
    }
    return value as ManifestSort;
}

/**
 * Parses `--slower-than` into milliseconds.
 *
 * A bare number is **seconds**, not milliseconds: someone typing
 * `--slower-than 30` means half a minute, and reading it as 30 ms would match
 * every manifest in the tree and look like the flag did nothing.
 */
export function readDuration(value: string | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
    if (match === null) {
        throw usageError(
            `--slower-than expects a duration like 500ms, 30s, 5m or 1h, got "${value}"`
        );
    }
    const amount = Number(match[1]);
    switch (match[2]) {
        case 'ms':
            return amount;
        case 'm':
            return amount * 60_000;
        case 'h':
            return amount * 3_600_000;
        // A bare number is seconds — see the doc comment.
        case 's':
        case undefined:
        default:
            return amount * 1000;
    }
}

/** The weekday of a date, or `null`. */
function weekdayOfDate(date: string): string | null {
    const match = /\(([A-Za-z]+)\)$/.exec(dateWithWeekday(date));
    return match?.[1] ?? null;
}

/** One manifest's JSON. */
function toRowJson(row: ManifestStats): ManifestRowJson {
    return {
        manifest: row.manifest,
        runCount: row.runCount,
        durations: row.durations,
        platforms: row.platforms,
        skippedOn: row.skippedOn,
        configs: row.configs.map((config) => ({
            configuration: config.configuration,
            runCount: config.runCount,
            skipped: config.skipped,
            durations: config.durations,
        })),
    };
}

// --- rendering -----------------------------------------------------------

/** Plain text. */
function renderText(result: ManifestsJson): string {
    const lines: (string | null)[] = [];
    lines.push(...headerLines(result));
    lines.push('');

    if (result.rows.length === 0) {
        lines.push('No manifest matched.');
        lines.push('');
        lines.push(...footerLines());
        return joinLines(lines);
    }

    // One named manifest gets the per-config table; a ranking gets one row per
    // manifest. `CLI.md` lays both out and they answer different questions.
    if (result.manifest !== null && result.rows.length === 1) {
        lines.push(...renderOneManifest(result.rows[0]!));
        lines.push('');
        lines.push(...footerLines());
        return joinLines(lines);
    }

    // `--sort` names the column directly, except `name`, which orders by the
    // manifest itself. `sortManifests()` is descending for every numeric key.
    const sortColumn = result.sort === 'name' ? 'Manifest' : result.sort;
    const column = (header: string, rest: Omit<Column, 'header'> = {}): Column => ({
        header,
        ...rest,
        ...(header === sortColumn
            ? { sort: result.sort === 'name' ? 'asc' : 'desc' }
            : {}),
    });
    lines.push(
        ...tableSection(
            [
                // A manifest is a path too, and `fx-tests manifests <path>`
                // takes it, so it gets the same auto-sized path column.
                column('Manifest', { path: true }),
                column('runs', { align: 'right' }),
                column('median', { align: 'right' }),
                column('p95', { align: 'right' }),
                column('max', { align: 'right' }),
                column('total', { align: 'right' }),
            ],
            result.rows.map((row) => [
                row.manifest,
                fmtCount(row.runCount),
                duration(row.durations?.median),
                duration(row.durations?.p95),
                duration(row.durations?.max),
                duration(row.durations?.total),
            ]),
            { total: result.rowCount, shown: result.rows.length }
        )
    );

    const skippedEverywhere = result.rows.filter((row) => row.durations === null);
    if (skippedEverywhere.length > 0) {
        lines.push('');
        lines.push(
            `  ${skippedEverywhere.length} of these ran on no configuration at all ` +
                '(every duration zero), so they have no runtime — not a runtime of zero.'
        );
    }

    lines.push('');
    lines.push(...footerLines());
    return joinLines(lines);
}

/** The per-configuration view of one named manifest. */
function renderOneManifest(row: ManifestRowJson): string[] {
    const lines: (string | null)[] = [];
    lines.push(row.manifest);

    const ran = row.configs.filter((config) => !config.skipped);
    if (ran.length === 0) {
        lines.push(
            '  Skipped on every configuration it appears on: every duration recorded was zero,'
        );
        lines.push('  which means it did not run there rather than that it ran instantly.');
    } else {
        lines.push(
            `  Runs on ${ran.length} configuration${ran.length === 1 ? '' : 's'}` +
                (row.platforms.length === 0
                    ? ''
                    : `, ${row.platforms.length} platform${row.platforms.length === 1 ? '' : 's'}: ` +
                      row.platforms
                          .map((entry) => `${entry.platform} (${entry.configCount})`)
                          .join(', '))
        );
    }
    if (row.skippedOn.length > 0) {
        // The visible half of the all-zero rule. These configs are not fast;
        // they did not run.
        lines.push(
            `  Skipped on ${row.skippedOn.length} configuration` +
                `${row.skippedOn.length === 1 ? '' : 's'} (all durations zero): ` +
                truncate(row.skippedOn.slice(0, 4).join(', '), 100) +
                (row.skippedOn.length > 4 ? `, and ${row.skippedOn.length - 4} more` : '')
        );
    }

    if (ran.length > 0) {
        lines.push('');
        lines.push(
            ...tableSection(
                [
                    // A configuration name is what `--config` takes, so it is
                    // an identifier to copy rather than prose: same auto-sized
                    // treatment as a path, and it is slash-separated too. A
                    // tail cut here produced
                    // `…/debug-mochitest-devtools-chr…`, which names nothing.
                    { header: 'Configuration', path: true },
                    { header: 'runs', align: 'right' },
                    // Ordered by median duration, as the ranking above is.
                    { header: 'median', align: 'right', sort: 'desc' },
                    { header: 'p95', align: 'right' },
                    { header: 'max', align: 'right' },
                ],
                ran.map((config) => [
                    config.configuration,
                    fmtCount(config.runCount),
                    duration(config.durations?.median),
                    duration(config.durations?.p95),
                    duration(config.durations?.max),
                ]),
                { total: ran.length, shown: ran.length }
            )
        );
    }
    return lines.filter((line): line is string => line !== null);
}

/** The header: which day, and how much of it is skips. */
function headerLines(result: ManifestsJson): string[] {
    const { metadata, zeroDurations } = result;
    const lines: string[] = [];
    lines.push(
        `manifests, ${dateWithWeekday(metadata.date)} — ${metadata.repository}, ` +
            `${fmtCount(metadata.processedJobCount)} jobs ` +
            `(${fmtCount(metadata.failedJobCount)} failed)`
    );
    // Unconditional, because the share is large and the rule is the one thing
    // about this file that cannot be seen in its format.
    const pct =
        zeroDurations.totalRuns === 0
            ? 0
            : (zeroDurations.zeroRuns / zeroDurations.totalRuns) * 100;
    lines.push(
        `  ${fmtCount(zeroDurations.zeroRuns)} of ${fmtCount(zeroDurations.totalRuns)} runs ` +
            `(${pct.toFixed(1)}%) recorded a zero duration. A manifest whose durations are all`
    );
    lines.push(
        `  zero on a config was skipped there, not run instantly — ` +
            `${fmtCount(zeroDurations.skippedPairs)} of ` +
            `${fmtCount(zeroDurations.totalPairs)} (manifest, config) pairs.`
    );
    return lines;
}

/** The division-of-labour note `CLI.md` asks for. */
function footerLines(): string[] {
    return [
        'This file has per-manifest durations, not per-test ones, so it narrows a job timeout',
        'to a manifest and a config but cannot say whether that is one slow test or a thousand',
        'cheap ones. Use `fx-tests test <path> --durations` on the tests in the manifest for that.',
    ];
}

/**
 * A duration for display, or `—` when there is none.
 *
 * `—` rather than `0` is the whole point: a skipped config has no runtime, and
 * printing zero would make it the fastest row in the table.
 *
 * The implementation moved to `lib/model/duration.ts` when the tree's thirteen
 * duration formatters were inventoried; this name is kept because the command's
 * call sites and `test/manifests-parity.test.ts` both use it. The move fixed
 * the carry bug that made `119,900 ms` print as `1m 60s` — see that module for
 * the measurement.
 */
export const duration = formatDurationPadded;

/** Markdown, for pasting into a bug. */
function renderMarkdown(result: ManifestsJson): string {
    const lines: (string | null)[] = [];
    lines.push(md.heading(`Manifest timings — ${dateWithWeekday(result.metadata.date)}`, 1));
    lines.push('');
    for (const line of headerLines(result).slice(1)) {
        lines.push(line.trim());
    }
    lines.push('');
    if (result.rows.length === 0) {
        lines.push('No manifest matched.');
        return joinLines(lines);
    }
    if (result.manifest !== null && result.rows.length === 1) {
        const row = result.rows[0]!;
        lines.push(md.heading(row.manifest));
        lines.push('');
        const ran = row.configs.filter((config) => !config.skipped);
        lines.push(
            ...md.table(
                [
                    { header: 'Configuration' },
                    { header: 'runs', align: 'right' },
                    { header: 'median', align: 'right' },
                    { header: 'p95', align: 'right' },
                    { header: 'max', align: 'right' },
                ],
                ran.map((config) => [
                    config.configuration,
                    fmtCount(config.runCount),
                    duration(config.durations?.median),
                    duration(config.durations?.p95),
                    duration(config.durations?.max),
                ])
            )
        );
        if (row.skippedOn.length > 0) {
            lines.push('');
            lines.push(
                `**Skipped on ${row.skippedOn.length} configurations** (all durations zero): ` +
                    row.skippedOn.join(', ')
            );
        }
    } else {
        lines.push(
            ...md.table(
                [
                    { header: 'Manifest' },
                    { header: 'runs', align: 'right' },
                    { header: 'median', align: 'right' },
                    { header: 'p95', align: 'right' },
                    { header: 'max', align: 'right' },
                ],
                result.rows.map((row) => [
                    row.manifest,
                    fmtCount(row.runCount),
                    duration(row.durations?.median),
                    duration(row.durations?.p95),
                    duration(row.durations?.max),
                ])
            )
        );
        lines.push(md.moreLine(result.rowCount, result.rows.length));
    }
    lines.push('');
    lines.push(...footerLines());
    return joinLines(lines);
}

/** Re-exported for the tests. */
export type { ManifestConfigStats };
