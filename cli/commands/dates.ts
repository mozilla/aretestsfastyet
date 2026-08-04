/**
 * `fx-tests dates` — which dates have data.
 *
 * The check for "did last night's job actually run". `index.json` is a bare
 * list of dates, newest first, and it is the authority on the 21-day window
 * every other command's `--day` is validated against.
 *
 * It reports the window per harness rather than once, because the two indexes
 * are separate tasks that can and do drift apart by a night.
 *
 * The weekday is printed with each date for the reason `FORMATS.md` measures:
 * a weekend day carries a fraction of a weekday's push volume, so which dates
 * are in the window changes what the counts from it mean.
 */

import type { IndexFile } from '../../lib/formats/stats.ts';
import { fetchJson, timingsIndex } from '../../lib/sources/source.ts';
import type { ParsedArgs } from '../args.ts';
import { type CommandContext, emit, progress } from '../context.ts';
import { usageError } from '../errors.ts';
import { toJson } from '../format/json.ts';
import * as md from '../format/markdown.ts';
import { dateWithWeekday, isWeekend, joinLines } from '../format/text.ts';
import type { Harness } from '../options.ts';

/** The `--json` shape. */
export interface DatesJson {
    harnesses: {
        harness: string;
        /** Newest first, as published. */
        dates: string[];
        oldest: string | null;
        newest: string | null;
        dayCount: number;
    }[];
}

/** Runs the command. */
export async function runDates(context: CommandContext, args: ParsedArgs): Promise<void> {
    if (args.positionals.length > 0) {
        throw usageError(`dates takes no arguments, got "${args.positionals[0]}"`);
    }

    const harnesses: Harness[] =
        context.globals.harness !== undefined
            ? [context.globals.harness]
            : ['xpcshell', 'mochitest'];

    const result: DatesJson = { harnesses: [] };
    for (const harness of harnesses) {
        progress(context, `Reading ${harness} index.json…`);
        const file = await fetchJson<IndexFile>(context.source, {
            index: timingsIndex(harness),
            filename: 'index.json',
        });
        const dates = [...file.dates];
        result.harnesses.push({
            harness,
            dates,
            // `index.json` is newest first, so the ends are the other way round
            // from `stats.json`. Naming them rather than indexing at the call
            // site is what stops that from being got wrong twice.
            newest: dates[0] ?? null,
            oldest: dates[dates.length - 1] ?? null,
            dayCount: dates.length,
        });
    }

    if (context.globals.format === 'json') {
        emit(context, toJson(result));
        return;
    }
    emit(
        context,
        context.globals.format === 'markdown' ? renderMarkdown(result) : renderText(result)
    );
}

function renderText(result: DatesJson): string {
    const lines: (string | null)[] = [];
    for (const entry of result.harnesses) {
        if (entry.dayCount === 0) {
            lines.push(`${entry.harness}: no dates published`);
            lines.push('');
            continue;
        }
        lines.push(
            `${entry.harness}: ${entry.dayCount} dates, ` +
                `${dateWithWeekday(entry.oldest!)} … ${dateWithWeekday(entry.newest!)}`
        );
        for (const date of entry.dates) {
            lines.push(`  ${dateWithWeekday(date)}${isWeekend(date) ? '  — weekend' : ''}`);
        }
        lines.push('');
    }
    return joinLines(lines);
}

function renderMarkdown(result: DatesJson): string {
    const lines: (string | null)[] = [];
    for (const entry of result.harnesses) {
        lines.push(md.heading(entry.harness));
        lines.push('');
        if (entry.dayCount === 0) {
            lines.push('No dates published.');
            lines.push('');
            continue;
        }
        lines.push(
            ...md.table(
                [{ header: 'Date' }, { header: 'Weekday' }, { header: 'Note' }],
                entry.dates.map((date) => [
                    date,
                    dateWithWeekday(date).replace(`${date} `, '').replace(/[()]/g, ''),
                    isWeekend(date) ? 'weekend' : '',
                ])
            )
        );
        lines.push('');
    }
    return joinLines(lines);
}
