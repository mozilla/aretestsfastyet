/**
 * `fx-tests cache` — inspect and clear the on-disk cache.
 *
 * Small, and worth having for one reason beyond tidiness: when a command
 * reports a number that looks wrong, the first question is how old the data
 * behind it is. `generatedAt` per entry answers that, and it comes from the
 * file itself rather than from the mtime — a distinction that matters because
 * a file re-fetched this morning can still hold last night's generation.
 *
 * This command never touches the network, so it works offline and it is the
 * one command that ignores `--no-cache`: asking to inspect a cache while
 * saying not to use one is not a contradiction worth erroring over.
 */

import type { ParsedArgs } from '../args.ts';
import { type OptionSpecs, boolOption } from '../args.ts';
import { type CacheEntryInfo, type DiskCache, cacheSize } from '../cache.ts';
import { type CommandContext, emit } from '../context.ts';
import { usageError } from '../errors.ts';
import { toJson } from '../format/json.ts';
import * as md from '../format/markdown.ts';
import { bytes, joinLines, table } from '../format/text.ts';

/** Options `cache` adds. */
export const CACHE_OPTIONS: OptionSpecs = {
    clear: { type: 'boolean', describe: 'Delete every cached entry.' },
    size: { type: 'boolean', describe: 'Report the total size on disk.' },
};

/** The `--json` shape. */
export interface CacheJson {
    directory: string;
    entryCount: number;
    totalBytes: number;
    cleared?: number;
    entries: CacheEntryInfo[];
}

/** Runs the command. */
export async function runCache(
    context: CommandContext,
    args: ParsedArgs,
    cache: DiskCache
): Promise<void> {
    if (args.positionals.length > 0) {
        throw usageError(`cache takes no arguments, got "${args.positionals[0]}"`);
    }
    const wantsClear = boolOption(args, 'clear');

    if (wantsClear) {
        const totalBytes = await cacheSize(cache);
        const cleared = await cache.clear();
        const result: CacheJson = {
            directory: cache.directory,
            entryCount: 0,
            totalBytes: 0,
            cleared,
            entries: [],
        };
        if (context.globals.format === 'json') {
            emit(context, toJson(result));
            return;
        }
        emit(
            context,
            `Cleared ${cleared} ${cleared === 1 ? 'entry' : 'entries'} ` +
                `(${bytes(totalBytes)}) from ${cache.directory}`
        );
        return;
    }

    const entries = await cache.list();
    const totalBytes = await cacheSize(cache);
    const result: CacheJson = {
        directory: cache.directory,
        entryCount: entries.length,
        totalBytes,
        entries,
    };

    if (context.globals.format === 'json') {
        emit(context, toJson(result));
        return;
    }
    emit(
        context,
        context.globals.format === 'markdown'
            ? renderMarkdown(result)
            : renderText(result, boolOption(args, 'size'))
    );
}

function renderText(result: CacheJson, sizeOnly: boolean): string {
    if (sizeOnly) {
        return `${bytes(result.totalBytes)} in ${result.entryCount} entries (${result.directory})`;
    }
    const lines: (string | null)[] = [
        `${result.directory} — ${result.entryCount} ` +
            `${result.entryCount === 1 ? 'entry' : 'entries'}, ${bytes(result.totalBytes)}`,
    ];
    if (result.entries.length === 0) {
        lines.push('');
        lines.push('  (empty)');
        return joinLines(lines);
    }
    lines.push('');
    lines.push(
        ...table(
            [
                { header: 'File' },
                { header: 'Size', align: 'right' },
                { header: 'Generated' },
                { header: 'Fetched' },
            ],
            result.entries.map((entry) => [
                entry.key,
                bytes(entry.bytes),
                // A file with no `generatedAt` is a real case (`index.json`
                // has no metadata block), so it says so rather than showing a
                // blank that reads as missing data.
                entry.generatedAt ?? 'n/a',
                entry.fetchedAt,
            ])
        )
    );
    return joinLines(lines);
}

function renderMarkdown(result: CacheJson): string {
    const lines: (string | null)[] = [
        md.heading('fx-tests cache'),
        '',
        `${md.code(result.directory)} — ${result.entryCount} entries, ${bytes(result.totalBytes)}`,
        '',
    ];
    lines.push(
        ...md.table(
            [
                { header: 'File' },
                { header: 'Size', align: 'right' },
                { header: 'Generated' },
                { header: 'Fetched' },
            ],
            result.entries.map((entry) => [
                entry.key,
                bytes(entry.bytes),
                entry.generatedAt ?? 'n/a',
                entry.fetchedAt,
            ])
        )
    );
    return joinLines(lines);
}
