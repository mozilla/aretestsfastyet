/**
 * `fx-tests summary` — the 7-day topline.
 *
 * The cheapest command in the CLI, and the one to run first when the question
 * is "is the tree unusually bad today". Reads only `{harness}-stats.json`, a
 * few hundred kilobytes of flat per-date arrays: no status groups are decoded
 * at all.
 *
 * Both harnesses by default, because "the tree" is both and reading one file
 * each is still cheap. `--harness` narrows it.
 *
 * The period is 7 days against the prior 7 for the reason `query/summary.ts`
 * documents: push volume drops several-fold at weekends, so a window that is
 * not a whole number of weeks compares a different weekday mix against itself
 * and reports the calendar as a trend.
 */

import type { StatsFile } from '../../lib/formats/stats.ts';
import { type Summary, computeSummary } from '../../lib/query/summary.ts';
import { fetchJson, timingsIndex } from '../../lib/sources/source.ts';
import type { OptionSpecs } from '../args.ts';
import { type ParsedArgs, numberOption } from '../args.ts';
import { type CommandContext, emit, progress } from '../context.ts';
import { usageError } from '../errors.ts';
import * as md from '../format/markdown.ts';
import { toJson } from '../format/json.ts';
import { dateWithWeekday, delta, joinLines, percent } from '../format/text.ts';
import type { Harness } from '../options.ts';

/** Options `summary` adds to the globals. */
export const SUMMARY_OPTIONS: OptionSpecs = {
    days: {
        type: 'number',
        placeholder: '<n>',
        describe: 'Period length in days. Default 7; a multiple of 7 is strongly preferred.',
    },
};

/** The `--json` shape. One entry per harness. */
export interface SummaryJson {
    harness: string;
    generatedAt: string;
    current: Summary['current'];
    prior: Summary['prior'];
    delta: Summary['delta'];
}

/** Runs the command. */
export async function runSummary(context: CommandContext, args: ParsedArgs): Promise<void> {
    const days = numberOption(args, 'days');
    if (days !== undefined && days < 1) {
        throw usageError(`--days expects at least 1, got ${days}`);
    }
    if (args.positionals.length > 0) {
        throw usageError(`summary takes no arguments, got "${args.positionals[0]}"`);
    }

    const harnesses: Harness[] =
        context.globals.harness !== undefined
            ? [context.globals.harness]
            : ['xpcshell', 'mochitest'];

    const results: SummaryJson[] = [];
    for (const harness of harnesses) {
        progress(context, `Reading ${harness}-stats.json…`);
        const file = await fetchJson<StatsFile>(context.source, {
            index: timingsIndex(harness),
            filename: `${harness}-stats.json`,
        });
        const summary = computeSummary(file, days === undefined ? {} : { days });
        results.push({
            harness,
            generatedAt: file.metadata.generatedAt,
            current: summary.current,
            prior: summary.prior,
            delta: summary.delta,
        });
    }

    if (context.globals.format === 'json') {
        emit(context, toJson({ harnesses: results }));
        return;
    }
    emit(
        context,
        context.globals.format === 'markdown'
            ? renderMarkdown(results)
            : renderText(results)
    );
}

/** The rate rows, in the order `CLI.md` shows them. */
function rows(entry: SummaryJson): { label: string; value: number | null; change: number | null }[] {
    return [
        {
            label: 'test failure rate',
            value: entry.current.testFailureRate,
            change: entry.delta.testFailureRate,
        },
        {
            label: 'job failure rate',
            value: entry.current.jobFailureRate,
            change: entry.delta.jobFailureRate,
        },
        { label: 'skip rate', value: entry.current.skipRate, change: entry.delta.skipRate },
        {
            label: 'invalid job rate',
            value: entry.current.invalidJobRate,
            change: entry.delta.invalidJobRate,
        },
    ];
}

/** Plain text, as `CLI.md` lays it out. */
function renderText(results: readonly SummaryJson[]): string {
    const lines: (string | null)[] = [];
    for (const entry of results) {
        const { current, prior } = entry;
        // The weekday goes on the end date because a period ending on a Sunday
        // has a different weekday mix from one ending on a Thursday, and the
        // rates are what they are partly because of that.
        const header =
            `${entry.harness.padEnd(10)} (${current.dayCount}d ending ` +
            `${dateWithWeekday(current.endDate)})`;
        lines.push(
            prior === null ? header : `${header}          vs prior ${prior.dayCount}d`
        );
        for (const row of rows(entry)) {
            const value = percent(row.value, 2).padEnd(10);
            lines.push(`  ${row.label.padEnd(22)}${value}${prior === null ? '' : `    ${delta(row.change)}`}`);
        }
        if (prior === null) {
            // Not a footnote: without it, the missing comparison column reads
            // as "nothing changed" rather than "there is no prior period".
            lines.push(
                `  (no prior ${current.dayCount}-day period in the file, so no comparison)`
            );
        }
        lines.push('');
    }
    return joinLines(lines);
}

/** Markdown, for pasting into a bug. */
function renderMarkdown(results: readonly SummaryJson[]): string {
    const lines: (string | null)[] = [];
    for (const entry of results) {
        const { current, prior } = entry;
        lines.push(
            md.heading(
                `${entry.harness} — ${current.dayCount}d ending ${dateWithWeekday(current.endDate)}`
            )
        );
        lines.push('');
        const columns: md.MarkdownColumn[] = [
            { header: 'Metric' },
            { header: 'Rate', align: 'right' },
        ];
        if (prior !== null) {
            columns.push({ header: `vs prior ${prior.dayCount}d`, align: 'right' });
        }
        lines.push(
            ...md.table(
                columns,
                rows(entry).map((row) =>
                    prior === null
                        ? [row.label, percent(row.value, 2)]
                        : [row.label, percent(row.value, 2), delta(row.change)]
                )
            )
        );
        lines.push('');
    }
    return joinLines(lines);
}
