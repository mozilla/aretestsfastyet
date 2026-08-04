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
import { type CacheEntryInfo, type DiskCache, cacheSize, isImmutableKind } from '../cache.ts';
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
    /**
     * The task-artifact half of the totals, broken out.
     *
     * Reported separately because the two halves behave differently and a
     * single number hides which one is big. The aggregates are a bounded set
     * that a TTL refreshes in place; task artifacts accumulate — one
     * `fx-tests try` caches 46 profiles, measured at 828 MB on push 7d16bff8 —
     * and are evicted by a size budget. Someone asking `--size` because the
     * directory is large needs to know which of those they are looking at.
     */
    taskArtifacts: { entryCount: number; bytes: number };
    cleared?: number;
    entries: CacheEntryInfo[];
}

/** The task-artifact totals, as `CacheJson.taskArtifacts` reports them. */
function artifactTotals(entries: readonly CacheEntryInfo[]): {
    entryCount: number;
    bytes: number;
} {
    const artifacts = entries.filter((entry) => isImmutableKind(entry.kind));
    return {
        entryCount: artifacts.length,
        bytes: artifacts.reduce((sum, entry) => sum + entry.bytes, 0),
    };
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
        // Counted before the clear, so the message can say what the two halves
        // were: "cleared 69 entries" is much less useful than knowing 46 of
        // them were the profiles of one Try push.
        const artifacts = artifactTotals(await cache.list());
        const cleared = await cache.clear();
        const result: CacheJson = {
            directory: cache.directory,
            entryCount: 0,
            totalBytes: 0,
            taskArtifacts: { entryCount: 0, bytes: 0 },
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
                `(${bytes(totalBytes)}) from ${cache.directory}` +
                (artifacts.entryCount === 0
                    ? ''
                    : `, of which ${artifacts.entryCount} task ` +
                      `${artifacts.entryCount === 1 ? 'artifact' : 'artifacts'} ` +
                      `(${bytes(artifacts.bytes)})`)
        );
        return;
    }

    const entries = await cache.list();
    const totalBytes = await cacheSize(cache);
    const result: CacheJson = {
        directory: cache.directory,
        entryCount: entries.length,
        totalBytes,
        taskArtifacts: artifactTotals(entries),
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

/**
 * The listing name of an entry: short, and different from its neighbours.
 *
 * A task artifact's key is its 130-character URL, of which 90 characters are
 * the same queue prefix on every row and the artifact path is the same again.
 * The only part that identifies the entry is `<taskId>/runs/<n>`, and it is in
 * the middle — so letting the table's path truncation take the leading
 * directories cuts off exactly the distinguishing part and prints forty-six
 * visually identical rows. Measured on the cache left by `fx-tests try
 * 7d16bff8`, which is what made this worth doing rather than leaving the raw
 * key.
 *
 * Anything that is not a queue artifact URL — every aggregate — is returned
 * unchanged.
 */
export function entryLabel(key: string): string {
    const match = /\/task\/([^/]+)\/runs\/(\d+)\/artifacts\/(.+)$/.exec(key);
    if (match === null) {
        return key;
    }
    return `${match[1]}.${match[2]} ${match[3]}`;
}

/** The task-artifact half of a total, as a parenthetical, or `''`. */
function artifactNote(result: CacheJson): string {
    if (result.taskArtifacts.entryCount === 0) {
        return '';
    }
    return (
        ` — ${bytes(result.taskArtifacts.bytes)} of that is ` +
        `${result.taskArtifacts.entryCount} task ` +
        `${result.taskArtifacts.entryCount === 1 ? 'artifact' : 'artifacts'}`
    );
}

function renderText(result: CacheJson, sizeOnly: boolean): string {
    if (sizeOnly) {
        return (
            `${bytes(result.totalBytes)} in ${result.entryCount} entries ` +
            `(${result.directory})${artifactNote(result)}`
        );
    }
    const lines: (string | null)[] = [
        `${result.directory} — ${result.entryCount} ` +
            `${result.entryCount === 1 ? 'entry' : 'entries'}, ${bytes(result.totalBytes)}` +
            artifactNote(result),
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
                // Truncated from the right, not the left, because
                // `entryLabel()` has already put the identifying part — the
                // task ID and run — at the front. Path-aware truncation here
                // would drop it again.
                { header: 'File', maxWidth: 56 },
                { header: 'Size', align: 'right' },
                { header: 'Generated' },
                { header: 'Fetched' },
            ],
            result.entries.map((entry) => [
                entryLabel(entry.key),
                bytes(entry.bytes),
                // A file with no `generatedAt` is a real case (`index.json`
                // has no metadata block, and neither does a task artifact), so
                // it says so rather than showing a blank that reads as missing
                // data.
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
                entryLabel(entry.key),
                bytes(entry.bytes),
                entry.generatedAt ?? 'n/a',
                entry.fetchedAt,
            ])
        )
    );
    return joinLines(lines);
}
