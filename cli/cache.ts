/**
 * The on-disk cache, and the reason a warm run costs no network at all.
 *
 * The aggregate files are tens of megabytes and change once a night, so
 * `CLI.md` asks for a cache "keyed by URL plus the file's
 * `metadata.generatedAt`". That phrasing hides a bootstrapping problem worth
 * being explicit about, because getting it wrong is how a cache ends up
 * "working" while still making a request every time:
 *
 * **`generatedAt` is inside the file.** You cannot key a lookup on it before
 * you have the bytes, so a cache that literally keyed on (URL, generatedAt)
 * would have to fetch the file to find out which cache entry to read — which
 * is the opposite of a cache. A conditional request (`If-Modified-Since`) is no
 * better: it is still a round trip, and `CLI.md` says a warm run should need
 * **no network at all**.
 *
 * So the split here is:
 *
 * - The **lookup key is the URL** (index + filename), hashed. That is what a
 *   caller knows before fetching.
 * - **`generatedAt` is recorded in the entry**, read from the bytes after a
 *   fetch. It is what the entry reports for provenance — `fx-tests cache`
 *   lists it, and every command prints the generation time of the data it
 *   used, so a stale answer is visible rather than silent.
 * - **Freshness is a TTL**, defaulting to the nightly cadence. Within the TTL
 *   the cached bytes are used with no request; past it the file is re-fetched
 *   and the new `generatedAt` recorded.
 *
 * That is what "keyed by URL plus generatedAt" can actually mean for a cache
 * that has to answer before it fetches, and the honest version of it: the URL
 * addresses the entry, `generatedAt` identifies which generation the entry
 * holds.
 *
 * ## Layout
 *
 * Two files per entry under the cache directory: `<hash>.json` holding the
 * bytes and `<hash>.meta.json` holding the metadata. Separate because the data
 * file is the thing that is tens of megabytes, and listing the cache
 * (`fx-tests cache`) should not read any of it.
 *
 * The bytes are stored verbatim rather than re-serialized: the cache is a
 * `DataSource` decorator and the contract is bytes in, the same bytes out.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
    mkdir,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';

import {
    type DataFileName,
    type DataSource,
    dataFileKey,
} from '../lib/sources/source.ts';

/** What is recorded alongside a cached file. */
export interface CacheEntryMeta {
    /** The `index/filename` this entry holds, for `fx-tests cache`'s listing. */
    key: string;
    /** The URL it came from, when the source knew one. */
    url?: string;
    /**
     * The file's own `metadata.generatedAt`, when it had one.
     *
     * Not every cached file does — `index.json` has no metadata block — so
     * this is optional, and its absence means "this file does not say".
     */
    generatedAt?: string;
    /** When this entry was written, as an ISO timestamp. */
    fetchedAt: string;
    /** Size of the cached bytes. */
    bytes: number;
}

/** One entry, as `fx-tests cache` reports it. */
export interface CacheEntryInfo extends CacheEntryMeta {
    /** The hash the entry is filed under. */
    hash: string;
}

/** Options for `diskCache`. */
export interface DiskCacheOptions {
    /** Where entries live. Default `~/.cache/fx-tests`. */
    directory?: string | undefined;
    /**
     * How long a cached entry is used without re-fetching, in milliseconds.
     *
     * Default 12 hours, against a nightly regeneration cadence. Shorter than a
     * day on purpose: the index task's completion time drifts, and a 24-hour
     * TTL anchored to whenever the user last ran the command would routinely
     * serve yesterday's data for a whole extra day.
     */
    ttlMs?: number | undefined;
    /** Injected clock, for tests. */
    now?: (() => number) | undefined;
}

/** The default cache directory. */
export function defaultCacheDir(): string {
    const xdg = process.env['XDG_CACHE_HOME'];
    if (xdg !== undefined && xdg.length > 0) {
        return join(xdg, 'fx-tests');
    }
    return join(homedir(), '.cache', 'fx-tests');
}

/** Twelve hours. See `DiskCacheOptions.ttlMs`. */
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

/** The filename an entry is stored under. */
export function cacheHash(name: DataFileName): string {
    return createHash('sha256').update(dataFileKey(name)).digest('hex').slice(0, 32);
}

/** The cache itself, usable on its own by `fx-tests cache`. */
export interface DiskCache {
    readonly directory: string;
    /** Cached bytes for a name, or `null` when absent or stale. */
    get(name: DataFileName): Promise<Uint8Array | null>;
    /** Stores bytes, recording `generatedAt` if the payload carries one. */
    put(name: DataFileName, bytes: Uint8Array, url?: string): Promise<void>;
    /** Every entry, for the `cache` command. */
    list(): Promise<CacheEntryInfo[]>;
    /** Deletes everything. Returns how many entries were removed. */
    clear(): Promise<number>;
}

/** Opens (does not create) a disk cache. */
export function diskCache(options: DiskCacheOptions = {}): DiskCache {
    const directory = options.directory ?? defaultCacheDir();
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const now = options.now ?? Date.now;

    const dataPath = (hash: string): string => join(directory, `${hash}.json`);
    const metaPath = (hash: string): string => join(directory, `${hash}.meta.json`);

    async function readMeta(hash: string): Promise<CacheEntryMeta | null> {
        try {
            const text = await readFile(metaPath(hash), 'utf8');
            return JSON.parse(text) as CacheEntryMeta;
        } catch {
            // A missing or corrupt metadata file means "no usable entry".
            // Not an error: a cache that throws when its own directory is in
            // an unexpected state is worse than one that re-fetches.
            return null;
        }
    }

    return {
        directory,

        async get(name: DataFileName): Promise<Uint8Array | null> {
            const hash = cacheHash(name);
            const meta = await readMeta(hash);
            if (meta === null) {
                return null;
            }
            const age = now() - Date.parse(meta.fetchedAt);
            if (!Number.isFinite(age) || age < 0 || age > ttlMs) {
                return null;
            }
            try {
                const buffer = await readFile(dataPath(hash));
                return new Uint8Array(buffer);
            } catch {
                return null;
            }
        },

        async put(name: DataFileName, bytes: Uint8Array, url?: string): Promise<void> {
            const hash = cacheHash(name);
            await mkdir(directory, { recursive: true });
            const meta: CacheEntryMeta = {
                key: dataFileKey(name),
                fetchedAt: new Date(now()).toISOString(),
                bytes: bytes.byteLength,
            };
            if (url !== undefined) {
                meta.url = url;
            }
            const generatedAt = readGeneratedAt(bytes);
            if (generatedAt !== null) {
                meta.generatedAt = generatedAt;
            }
            // Data first, then metadata: the metadata file is what `get()`
            // keys on, so writing it last means a crash between the two leaves
            // an orphaned data file rather than metadata pointing at bytes
            // that are not there.
            await writeFile(dataPath(hash), bytes);
            await writeFile(metaPath(hash), JSON.stringify(meta, null, 2));
        },

        async list(): Promise<CacheEntryInfo[]> {
            let names: string[];
            try {
                names = await readdir(directory);
            } catch {
                return [];
            }
            const entries: CacheEntryInfo[] = [];
            for (const fileName of names) {
                if (!fileName.endsWith('.meta.json')) {
                    continue;
                }
                const hash = fileName.slice(0, -'.meta.json'.length);
                const meta = await readMeta(hash);
                if (meta !== null) {
                    entries.push({ ...meta, hash });
                }
            }
            entries.sort((a, b) => a.key.localeCompare(b.key));
            return entries;
        },

        async clear(): Promise<number> {
            let names: string[];
            try {
                names = await readdir(directory);
            } catch {
                return 0;
            }
            let removed = 0;
            for (const fileName of names) {
                if (fileName.endsWith('.meta.json')) {
                    removed++;
                }
                await rm(join(directory, fileName), { force: true });
            }
            return removed;
        },
    };
}

/**
 * Reads `metadata.generatedAt` out of cached bytes without parsing the file.
 *
 * A regex over the first few kilobytes, and deliberately so: the alternative
 * is `JSON.parse` on a 45 MB download to read one string, which for a bucket
 * file costs a 195 MB heap peak (`FORMATS.md`) purely to write a cache entry.
 * `metadata` is the first key the generator emits, so the field is always near
 * the start.
 *
 * Returns `null` when the field is not there, which is a real case —
 * `index.json` has no metadata block — and not an error.
 */
export function readGeneratedAt(bytes: Uint8Array): string | null {
    const head = new TextDecoder().decode(bytes.subarray(0, 4096));
    const match = /"generatedAt"\s*:\s*"([^"]+)"/.exec(head);
    return match?.[1] ?? null;
}

/**
 * Wraps a source so its fetches are cached on disk.
 *
 * A decorator rather than a mode of `httpSource`, because the cache is a
 * Node-only concern and `lib/` must not touch `fs` (`PLAN.md` §2). It also
 * means `--no-cache` is "do not wrap" rather than a flag threaded through the
 * fetch path.
 *
 * A cache write failure is **not** fatal: a read-only or full cache directory
 * should make the CLI slower, not broken. The write error is reported through
 * `onWarning` so it is visible on stderr rather than swallowed.
 */
export function cachedSource(
    inner: DataSource,
    cache: DiskCache,
    hooks: {
        onHit?: ((name: DataFileName) => void) | undefined;
        onMiss?: ((name: DataFileName) => void) | undefined;
        onWarning?: ((message: string) => void) | undefined;
    } = {}
): DataSource {
    return {
        name: inner.name,
        async fetch(name: DataFileName): Promise<Uint8Array> {
            const cached = await cache.get(name);
            if (cached !== null) {
                hooks.onHit?.(name);
                return cached;
            }
            hooks.onMiss?.(name);
            const bytes = await inner.fetch(name);
            try {
                await cache.put(name, bytes);
            } catch (error) {
                hooks.onWarning?.(describeCacheWriteFailure(cache.directory, error));
            }
            return bytes;
        },
    };
}

/**
 * Turns a cache-write failure into something the reader can act on.
 *
 * The raw form was `EPERM: operation not permitted, mkdir '/proc'`, which is
 * accurate and useless: it does not say the command still worked, does not say
 * what the consequence is, and does not say what to do. Someone seeing it
 * mid-output reasonably concludes the run failed. It did not — the data below
 * the warning is complete, and only the caching of it was skipped.
 *
 * So the message states, in order: what could not be done, that the answer is
 * unaffected, what it costs, and the two flags that resolve it. The errno is
 * kept at the end, because it is the part worth pasting into a search.
 */
export function describeCacheWriteFailure(directory: string, error: unknown): string {
    const message = (error as Error | undefined)?.message ?? String(error);
    const code = (error as NodeJS.ErrnoException | undefined)?.code;

    const cause =
        code === 'EACCES' || code === 'EPERM'
            ? `no permission to write the cache directory ${directory}`
            : code === 'ENOSPC'
              ? `no space left to write the cache directory ${directory}`
              : code === 'EROFS'
                ? `the cache directory ${directory} is on a read-only filesystem`
                : `could not write the cache directory ${directory}`;

    return (
        `${cause}. The results below are complete and correct — only caching was ` +
        `skipped, so this run and the next one re-download instead of reading from ` +
        `disk. Use --cache-dir <path> to cache somewhere writable, or --no-cache to ` +
        `stop trying. (${message})`
    );
}

/** Total bytes held by the cache directory, for `fx-tests cache --size`. */
export async function cacheSize(cache: DiskCache): Promise<number> {
    let names: string[];
    try {
        names = await readdir(cache.directory);
    } catch {
        return 0;
    }
    let total = 0;
    for (const fileName of names) {
        try {
            total += (await stat(join(cache.directory, fileName))).size;
        } catch {
            // Raced with a concurrent clear; skip it.
        }
    }
    return total;
}
