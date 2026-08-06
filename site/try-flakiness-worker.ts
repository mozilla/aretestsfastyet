/**
 * The flakiness worker: one 21-day bucket file in, one row of history per test
 * out.
 *
 * ## Why this is a separate esbuild entry point, and not just an import
 *
 * This is the one thing about `try.html` that could not be transliterated, and
 * it is worth setting out because the failure mode is silent.
 *
 * The old page builds its worker by calling `.toString()` on six functions from
 * `common-test-data.js` and concatenating the source into a `Blob`
 * (`try.html:2584`):
 *
 * ```js
 * const sharedCode = [getChunkIndex, getCountAtIndex, findTest, computeTestStats,
 *                     stripChunkSuffix, computeConfigStats]
 *     .map(fn => fn.toString()).join('\n');
 * ```
 *
 * That works only because those six are *top-level function declarations in a
 * script*, with no imports, no closure and no helpers — so their source text is
 * a complete program. **None of those three properties survives bundling.**
 * esbuild renames identifiers to avoid collisions, so `computeConfigStats`
 * becomes something like `computeConfigStats2` and the `stripChunkSuffix` it
 * calls becomes `stripChunkSuffix3`; the names in the concatenated source no
 * longer resolve. Worse, `lib/query/config-stats.ts` calls `classifyStatus` and
 * `lib/formats/decode.ts`, none of which is in the six-function list — a
 * `.toString()` of the bundled function would produce a program referring to
 * transitive dependencies that were never copied in. The worker would throw
 * `ReferenceError` on its first message, and the page's `catch` at
 * `try.html:2610` turns that into `notFound` for every test in the file, so the
 * flakiness column would just be **empty** with no error anywhere.
 *
 * The fix is to let the bundler do what it is for: this file is its own entry
 * point, esbuild follows its imports, and the result is a self-contained
 * program with the function bodies inlined and no bare imports left.
 * `tools/build-pages.ts` inlines that program into the page as a string
 * constant, and `site/try.ts` builds the `Blob` from it — so the page is still
 * one self-contained file with no extra request, which is the property
 * `tools/build-pages.ts` exists to preserve.
 *
 * **Measured**: the bundle is 12.4 kB with zero `import`/`export` statements
 * (asserted by the build). The old inline worker was six functions totalling
 * about 7 kB of source; the difference is `lib/formats/decode.ts`, which the
 * old page did not need because `common-test-data.js` walked the raw JSON
 * shapes inline.
 *
 * ## What it computes
 *
 * Per test in the file: `computeTestStats` for the headline denominators, and
 * `computeConfigStats` restricted to the configurations the test failed on **in
 * this push** — that restriction is what makes the answer "was this already
 * failing where I saw it fail" rather than "is this test flaky somewhere".
 *
 * `hasMatchingMessage` is `configs.some(c => c.sameMsgFailCount > 0)`
 * (`try.html:2606`) and not a whole-file question: it must agree with the rates
 * the tooltip shows, which are these configs' and no others'.
 */

import { type BucketFile, decodeBucket } from '../lib/formats/buckets.ts';
import { computeConfigStats, type ConfigStats } from '../lib/query/config-stats.ts';
import { computeTestStats, type TestStats } from '../lib/query/test-stats.ts';
import { MIN_RECENT_RUNS, type FlakinessRequest } from './try-view.ts';

/** What the main thread posts in. */
interface WorkerRequest {
    /** The raw bytes of one bucket file, transferred. */
    buffer: ArrayBuffer;
    tests: FlakinessRequest[];
}

/** One test's answer. */
export interface FlakinessResult {
    path: string;
    found: boolean;
    stats?: TestStats;
    hasMatchingMessage?: boolean;
    configs?: ConfigStats[];
    totalDays?: number;
}

/** What the worker posts back. */
export interface WorkerResponse {
    results?: FlakinessResult[];
    error?: string;
}

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
    const { buffer, tests } = event.data;
    try {
        const json = new TextDecoder().decode(buffer);
        const raw = JSON.parse(json) as BucketFile;
        const file = decodeBucket(raw);
        const results: FlakinessResult[] = [];
        for (const { path, tryMessages, hasTimeout, hasCrash, jobNames } of tests) {
            const found = file.findTest(path);
            if (found === null) {
                results.push({ path, found: false });
                continue;
            }
            const stats = computeTestStats(file, found.testId);
            // `file.days` is the aggregate's window. Upstream reads
            // `data.metadata.days` and falls back to 0 (`try.html:2601`); a
            // daily file would give `null` here, which the display code treats
            // the same way its `|| HISTORY_DAYS` fallback does.
            const totalDays = file.days ?? 0;
            const configs = computeConfigStats(file, found.testId, {
                jobNames,
                minRecentRuns: MIN_RECENT_RUNS,
                tryMessages,
                matchAnyTimeout: hasTimeout,
                matchAnyCrash: hasCrash,
            });
            results.push({
                path,
                found: true,
                stats,
                // Agrees with the rates the tooltip shows, because it is asked
                // of the same configs.
                hasMatchingMessage: configs.some((config) => config.sameMsgFailCount > 0),
                configs,
                totalDays,
            });
        }
        const response: WorkerResponse = { results };
        self.postMessage(response);
    } catch (error) {
        const response: WorkerResponse = {
            error: error instanceof Error ? error.message : String(error),
        };
        self.postMessage(response);
    }
};
