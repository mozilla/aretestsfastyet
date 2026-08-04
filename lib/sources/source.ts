/**
 * The seam that keeps `lib/` pure: a source is a name and a way to get bytes.
 *
 * `PLAN.md` §2's layering rule is that `lib/` must not touch `window`,
 * `document`, `fetch` or `fs`. That rule has to be *implementable*, and this
 * interface is what makes it so: everything above it takes a `DataSource` and
 * asks for a file by name, and the two things that know how bytes actually
 * arrive — a browser's `fetch`, Node's disk cache plus `fetch` — live outside
 * `lib/` and are passed in.
 *
 * The interface is deliberately about *bytes*, not parsed JSON. Two reasons:
 *
 * - The caller with the memory budget should decide when to parse. A 155 MB
 *   mochitest daily file expands to ~629 MB of heap (`FORMATS.md`), and a
 *   source that eagerly parsed would take that decision away.
 * - A cache keys on bytes. `cli/cache.ts` (step 4) writes what it fetched and
 *   re-reads it later; a parsed object is not a thing it can store.
 *
 * `fetchJson` is provided anyway, because every current caller does want the
 * parse and doing it in one place is where the "which file failed" context
 * lives.
 */

/**
 * How a file is named to a source.
 *
 * Published files live under an index, so a name is the pair (index, filename)
 * rather than a bare string. `fetch-utils.js` collapses the two by deriving the
 * index from the filename's prefix (`fetchData()`, `:212`), which works only
 * because it hardcodes `{harness}-timings` and has nowhere to put
 * `manifest-timings`. Keeping them separate is what lets `sources/http.ts`
 * serve more than one index.
 */
export interface DataFileName {
    /**
     * The `test-info-*` index suffix: `xpcshell-timings`, `mochitest-timings`,
     * `manifest-timings`.
     */
    index: string;
    /** The artifact filename, e.g. `xpcshell-00.json`. */
    filename: string;
}

/** A source of published data files, by name. */
export interface DataSource {
    /**
     * A short label for diagnostics — `central`, `try`, `local`, `fake`.
     * Printed by the CLI so a surprising number can be traced to where it came
     * from.
     */
    readonly name: string;

    /**
     * Fetches a file's bytes.
     *
     * Throws `DataFileNotFoundError` when the file does not exist — a real
     * answer for a date outside the errors window (`FORMATS.md`: only 5 of 21
     * dates have an errors file) — and `DataFetchError` for anything else.
     */
    fetch(name: DataFileName): Promise<Uint8Array>;
}

/**
 * Thrown when a named file does not exist at the source.
 *
 * Distinct from `DataFetchError` because the two mean different things to a
 * caller and to `CLI.md`'s exit codes: a 404 is "this data was never published"
 * (exit 2 or 4) while a network failure is "try again" (exit 3). Collapsing
 * them is how a transient outage gets reported as missing data.
 */
export class DataFileNotFoundError extends Error {
    readonly name2: DataFileName;
    readonly url: string | undefined;

    constructor(name: DataFileName, url?: string) {
        super(
            `no such data file: ${name.filename} in index ${name.index}` +
                (url === undefined ? '' : ` (${url})`)
        );
        this.name = 'DataFileNotFoundError';
        this.name2 = name;
        this.url = url;
    }
}

/** Thrown when a file exists but could not be fetched — network, 5xx, timeout. */
export class DataFetchError extends Error {
    readonly name2: DataFileName;
    readonly url: string | undefined;
    /** The HTTP status, when there was one. Absent for a transport failure. */
    readonly status: number | undefined;

    constructor(name: DataFileName, message: string, url?: string, status?: number) {
        super(`failed to fetch ${name.filename} from index ${name.index}: ${message}`);
        this.name = 'DataFetchError';
        this.name2 = name;
        this.url = url;
        this.status = status;
    }
}

/**
 * Fetches and parses a file as JSON.
 *
 * The decode is `TextDecoder` + `JSON.parse` rather than a `Response.json()`,
 * because the source hands back bytes and may not have come from HTTP at all.
 * A parse failure is wrapped so the message names the file — an unadorned
 * `Unexpected token < in JSON at position 0` from a 45 MB download is a poor
 * error, and it is the one an HTML error page produces.
 */
export async function fetchJson<T>(source: DataSource, name: DataFileName): Promise<T> {
    const bytes = await source.fetch(name);
    const text = new TextDecoder().decode(bytes);
    try {
        return JSON.parse(text) as T;
    } catch (error) {
        throw new DataFetchError(
            name,
            `response is not valid JSON: ${(error as Error).message}`
        );
    }
}

/**
 * The `test-info-*` index a harness's timing files live under.
 *
 * One line, and worth naming: the string is built by concatenation in five
 * places across `fetch-utils.js` and the pages, and the CLI needs the same
 * answer for a harness it was given as a flag rather than sniffed from a
 * filename.
 */
export function timingsIndex(harness: string): string {
    return `${harness}-timings`;
}

/** The index `manifests.json` lives under — its own, not a harness's. */
export const MANIFEST_TIMINGS_INDEX = 'manifest-timings';

/**
 * A source backed by an in-memory map, for tests.
 *
 * Lives in `lib/` rather than in `test/` because it is part of the contract:
 * the interface is only useful if it is cheap to implement, and this is the
 * proof plus the thing every test in the repo uses. No test may hit the
 * network (`PLAN.md` §3 step 3), and this is what makes that easy rather than
 * merely required.
 */
export function memorySource(
    files: ReadonlyMap<string, Uint8Array | string>,
    name = 'fake'
): DataSource {
    return {
        name,
        fetch(fileName: DataFileName): Promise<Uint8Array> {
            const key = dataFileKey(fileName);
            const value = files.get(key) ?? files.get(fileName.filename);
            if (value === undefined) {
                return Promise.reject(new DataFileNotFoundError(fileName));
            }
            return Promise.resolve(
                typeof value === 'string' ? new TextEncoder().encode(value) : value
            );
        },
    };
}

/** The `index/filename` key a name maps to, for caches and fake sources. */
export function dataFileKey(name: DataFileName): string {
    return `${name.index}/${name.filename}`;
}
