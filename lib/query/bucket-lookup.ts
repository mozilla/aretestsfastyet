/**
 * Which 21-day bucket files answer a set of tests — shared by `try.html`
 * (`site/flakiness-fetch.ts`) and `fx-tests try`.
 *
 * Each front-end reads a file its own way (browser `fetch` and a worker; the
 * CLI's cached `DataSource`), so the read is a callback. What is here is the
 * policy both must agree on, and once did not: the page retried a miss under
 * the other harness and the CLI did not, so on try push f26b22875bff four
 * chrome `.xhtml` tests, which `detectHarness` then sent to xpcshell, read "no
 * central data" in the CLI and showed their history on the page. The cause is
 * fixed in `detectHarness`, which is now right for every test in the
 * aggregates, and the retry is gone from both.
 */

import { bucketFileSuffix, bucketIndexForPath } from '../formats/buckets.ts';
import { type Harness, detectHarness } from '../model/harness.ts';

/** One bucket file, and the items wanted from it. */
export interface BucketFileRead<T> {
    harness: Harness;
    /** `mochitest-0a.json`. */
    filename: string;
    items: T[];
}

/**
 * Groups items by the file that answers them under `harnessOf`.
 *
 * Files are ordered by their highest-priority item (lowest `priority`), so a
 * caller filling a table in reads the files for its top rows first: a push
 * failing on 70 tests spread across 12 bucket files takes twelve fetches, and
 * reading them in hash order would fill the table in a random-looking sequence.
 * `old/try.html:2654-2675`. Without `priority`, first-seen order.
 */
export function groupByBucketFile<T>(
    items: readonly T[],
    pathOf: (item: T) => string,
    harnessOf: (path: string) => Harness,
    priority: (item: T) => number = () => 0
): BucketFileRead<T>[] {
    const files = new Map<string, BucketFileRead<T>>();
    for (const item of items) {
        const path = pathOf(item);
        const harness = harnessOf(path);
        const filename = `${harness}-${bucketFileSuffix(bucketIndexForPath(path))}.json`;
        let file = files.get(filename);
        if (file === undefined) {
            file = { harness, filename, items: [] };
            files.set(filename, file);
        }
        file.items.push(item);
    }
    const best = (file: BucketFileRead<T>): number => Math.min(...file.items.map(priority));
    return [...files.values()].sort((a, b) => best(a) - best(b));
}

/** How `lookupInBuckets` reads, and in what order. */
export interface BucketLookupOptions<T> {
    pathOf: (item: T) => string;
    /**
     * Reads one file and resolves with the items it did **not** find — all of
     * them when the file could not be read.
     */
    read: (file: BucketFileRead<T>) => Promise<readonly T[]>;
    /** See `groupByBucketFile`. */
    priority?: ((item: T) => number) | undefined;
    /** Files read at once. Default 1. */
    concurrency?: number | undefined;
}

/**
 * Reads every item from the bucket file of the harness `detectHarness` gives
 * it. Resolves with the items no file held.
 */
export async function lookupInBuckets<T>(
    items: readonly T[],
    options: BucketLookupOptions<T>
): Promise<T[]> {
    const queue = groupByBucketFile(items, options.pathOf, detectHarness, options.priority);
    const missed: T[] = [];
    const lane = async (): Promise<void> => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
            missed.push(...(await options.read(next)));
        }
    };
    await Promise.all(Array.from({ length: options.concurrency ?? 1 }, lane));
    return missed;
}
