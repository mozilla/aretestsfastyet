/**
 * Turning what a caller typed into a test the data actually holds — a basename,
 * a fragment, or a full path.
 *
 * Shared with `test.html`, and **the step order is the shared part**: it decides
 * which test a name resolves to, so reordering these silently makes the CLI and
 * the page answer differently about one name, which neither front-end's tests
 * can see.
 *
 * 1. The bucket file for the inferred or given harness. There is no retry
 *    under the other harness: `detectHarness` is right for every test in the
 *    aggregates (measured over all 128 bucket files on 2026-11-15), so a miss
 *    there is a test the data does not hold, and the other file cannot.
 * 2. A unique substring match over both harnesses' 21-day aggregates.
 * 3. Several matches → the candidates, which the page shows as a dropdown.
 * 4. Nothing matched → `unknown`.
 *
 * `not-in-file` is not a step: it is step 2 finding one path that its own bucket
 * does not hold, where "no such test" would be false.
 */
import type { DecodedTimingFile } from '../formats/decode.ts';
import { type TestIdentity, joinTestPath } from '../formats/tables.ts';
import { type Harness, detectHarness } from '../model/harness.ts';

/**
 * The search terms a typed query decomposes into.
 *
 * Empty terms are dropped: `[].every()` is true for every path, so whitespace
 * would otherwise match the whole tree.
 */
export function searchTerms(query: string): string[] {
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term !== '');
}

function matchesTerms(path: string, terms: readonly string[]): boolean {
    const lower = path.toLowerCase();
    return terms.every((term) => lower.includes(term));
}

export interface TestPathMatches {
    matches: string[];
    /** How many matched, which the `limit` on `matches` can cap away. */
    total: number;
    truncated: boolean;
}

/** Every test path matching a query: `limit` of them, but a full count. */
export function matchTestPaths(
    allTests: readonly string[],
    query: string,
    limit: number
): TestPathMatches {
    const terms = searchTerms(query);
    if (terms.length === 0) {
        return { matches: [], total: 0, truncated: false };
    }
    const matches: string[] = [];
    let total = 0;
    for (const path of allTests) {
        if (!matchesTerms(path, terms)) {
            continue;
        }
        total++;
        if (matches.length < limit) {
            matches.push(path);
        }
    }
    return { matches, total, truncated: total > matches.length };
}

/** How many candidates a resolution collects. The count is not capped. */
export const CANDIDATE_LIMIT = 50;

export interface TestPathsSource {
    tables: { testPaths: readonly string[]; testNames: readonly string[] };
    testInfo: { testPathIds: readonly number[]; testNameIds: readonly number[] };
}

/**
 * The sorted union of every test path in the given aggregates.
 *
 * An unreadable file is passed as `null` and skipped: one harness's paths still
 * resolve most fragments. An out-of-range path id means the same as an empty
 * directory — no directory — so both give the bare name.
 */
export function collectTestPaths(files: readonly (TestPathsSource | null)[]): string[] {
    const paths = new Set<string>();
    for (const file of files) {
        if (file === null) {
            continue;
        }
        const { testPaths, testNames } = file.tables;
        const { testPathIds, testNameIds } = file.testInfo;
        for (let i = 0; i < testPathIds.length; i++) {
            const name = testNames[testNameIds[i]!];
            if (name === undefined) {
                continue;
            }
            paths.add(joinTestPath(testPaths[testPathIds[i]!] ?? '', name));
        }
    }
    return [...paths].sort();
}

/** `raw` is generic because `test.html` renders from `metadata` as well. */
export interface LoadedTestFile<Raw> {
    decoded: DecodedTimingFile;
    raw: Raw;
}

export interface TestLookupLoaders<Raw> {
    /** `null` when unpublished. */
    loadBucket(harness: Harness, testPath: string): Promise<LoadedTestFile<Raw> | null>;
    /** Both harnesses' 21-day paths. Two large files, so steps 2-3 only. */
    loadAllTestPaths(): Promise<string[]>;
    /** Called before each step that costs a fetch, for a progress line. */
    onStep?: ((message: string) => void) | undefined;
}

/** A test the ladder found. */
export interface ResolvedTest<Raw> {
    kind: 'found';
    /** The path the data holds it under — not necessarily what was typed. */
    testPath: string;
    harness: Harness;
    inferredHarness: boolean;
    /** What was typed, when step 2 resolved a fragment. `null` otherwise. */
    resolvedFrom: string | null;
    file: LoadedTestFile<Raw>;
    identity: TestIdentity;
}

/** The outcome of the ladder. */
export type TestResolution<Raw> =
    | ResolvedTest<Raw>
    | {
          /** Step 3: a fragment several tests match. */
          kind: 'ambiguous';
          query: string;
          /** At most `CANDIDATE_LIMIT` of them; `total` is the true count. */
          candidates: string[];
          total: number;
          truncated: boolean;
          allTests: string[];
      }
    | {
          /**
           * The path exists tree-wide but not in the file that should hold it:
           * a harness the test does not run under, or two families published at
           * different times. Not `unknown` — the path is known to exist.
           */
          kind: 'not-in-file';
          query: string;
          testPath: string;
          searched: Harness[];
          allTests: string[];
      }
    | {
          /** Step 4: not in its bucket, and no path contains it. */
          kind: 'unknown';
          query: string;
          searched: Harness[];
          /**
           * `null` when the list could not be read, so no search happened — the
           * front-end must not then say that nothing matches.
           */
          allTests: string[] | null;
      };

/** Step 1 for one path, and step 2's re-lookup of its match. */
async function findInHarness<Raw>(
    testPath: string,
    harness: Harness,
    loaders: TestLookupLoaders<Raw>
): Promise<{ file: LoadedTestFile<Raw>; identity: TestIdentity } | null> {
    const file = await loaders.loadBucket(harness, testPath);
    const identity = file === null ? null : file.decoded.findTest(testPath);
    return file === null || identity === null ? null : { file, identity };
}

/** Walks the ladder. */
export async function resolveTest<Raw>(
    query: string,
    explicitHarness: Harness | undefined,
    loaders: TestLookupLoaders<Raw>
): Promise<TestResolution<Raw>> {
    const inferredHarness = explicitHarness === undefined;
    const harness = explicitHarness ?? detectHarness(query);
    const searched: Harness[] = [harness];

    const direct = await findInHarness(query, harness, loaders);
    if (direct !== null) {
        return {
            kind: 'found',
            testPath: query,
            harness,
            inferredHarness,
            resolvedFrom: null,
            file: direct.file,
            identity: direct.identity,
        };
    }

    loaders.onStep?.('Test not found, looking for a unique match…');
    let allTests: string[];
    try {
        allTests = await loaders.loadAllTestPaths();
    } catch {
        return { kind: 'unknown', query, searched, allTests: null };
    }

    const { matches, total, truncated } = matchTestPaths(allTests, query, CANDIDATE_LIMIT);
    if (matches.length === 0) {
        return { kind: 'unknown', query, searched, allTests };
    }
    if (total === 1) {
        const match = matches[0]!;
        const matchHarness = explicitHarness ?? detectHarness(match);
        const resolved = await findInHarness(match, matchHarness, loaders);
        if (resolved !== null) {
            return {
                kind: 'found',
                testPath: match,
                harness: matchHarness,
                inferredHarness,
                // Null when the match is what was typed, which step 1 can
                // still miss on a stale bucket the re-lookup then finds. Without
                // this, the page redirects to the URL it is already on.
                resolvedFrom: match === query ? null : query,
                file: resolved.file,
                identity: resolved.identity,
            };
        }
        return { kind: 'not-in-file', query, testPath: match, searched: [matchHarness], allTests };
    }
    return { kind: 'ambiguous', query, candidates: matches, total, truncated, allTests };
}
