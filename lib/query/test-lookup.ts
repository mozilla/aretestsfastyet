/**
 * Turning what a caller typed into a test the data actually holds — a basename,
 * a fragment, or a full path.
 *
 * Shared with `test.html`, and **the step order is the shared part**: it decides
 * which test a name resolves to, so reordering these silently makes the CLI and
 * the page answer differently about one name, which neither front-end's tests
 * can see.
 *
 * 1. The bucket file for the inferred or given harness.
 * 2. The other harness at the same bucket index — this covers `detectHarness`'s
 *    `test_*.js` hole. Skipped when the caller named a harness.
 * 3. A unique substring match over both harnesses' 21-day aggregates.
 * 4. Several matches → the candidates, which the page shows as a dropdown.
 * 5. Nothing matched → `unknown`.
 *
 * `not-in-file` is not a step: it is step 3 finding one path that its own bucket
 * does not hold, where "no such test" would be false.
 */
import type { DecodedTimingFile } from '../formats/decode.ts';
import { type TestIdentity, joinTestPath } from '../formats/tables.ts';
import { type Harness, detectHarness, otherHarness } from '../model/harness.ts';

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
    /** `null` when unpublished: step 2 reads a bucket that often is. */
    loadBucket(harness: Harness, testPath: string): Promise<LoadedTestFile<Raw> | null>;
    /** Both harnesses' 21-day paths. Two large files, so steps 3-4 only. */
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
    /** Found under the other harness, so `detectHarness` guessed wrong. */
    viaOtherHarness: boolean;
    /** What was typed, when step 3 resolved a fragment. `null` otherwise. */
    resolvedFrom: string | null;
    file: LoadedTestFile<Raw>;
    identity: TestIdentity;
}

/** The outcome of the ladder. */
export type TestResolution<Raw> =
    | ResolvedTest<Raw>
    | {
          /** Step 4: a fragment several tests match. */
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
          /** Step 5: nothing in either harness, and no path contains it. */
          kind: 'unknown';
          query: string;
          searched: Harness[];
          /**
           * `null` when the list could not be read, so no search happened — the
           * front-end must not then say that nothing matches.
           */
          allTests: string[] | null;
      };

/**
 * Steps 1-2 for one path: the inferred harness, then the other one.
 *
 * Step 3's re-lookup needs both too — a fragment can resolve to a misclassified
 * `test_*.js` just as a typed path can.
 */
async function findInEitherHarness<Raw>(
    testPath: string,
    explicitHarness: Harness | undefined,
    loaders: TestLookupLoaders<Raw>
): Promise<{ file: LoadedTestFile<Raw>; identity: TestIdentity; harness: Harness; viaOtherHarness: boolean } | null> {
    const first = explicitHarness ?? detectHarness(testPath);
    const attempts: Harness[] =
        explicitHarness === undefined ? [first, otherHarness(first)] : [first];
    for (const harness of attempts) {
        if (harness !== first) {
            loaders.onStep?.(`Not found in ${first}, trying ${harness}…`);
        }
        const file = await loaders.loadBucket(harness, testPath);
        const identity = file === null ? null : file.decoded.findTest(testPath);
        if (file !== null && identity !== null) {
            return { file, identity, harness, viaOtherHarness: harness !== first };
        }
    }
    return null;
}

/**
 * Walks the ladder.
 *
 * `explicitHarness` skips step 2 rather than being a hint: a caller who named a
 * harness asked about that harness.
 */
export async function resolveTest<Raw>(
    query: string,
    explicitHarness: Harness | undefined,
    loaders: TestLookupLoaders<Raw>
): Promise<TestResolution<Raw>> {
    const inferredHarness = explicitHarness === undefined;
    const first = explicitHarness ?? detectHarness(query);
    const searched: Harness[] = inferredHarness ? [first, otherHarness(first)] : [first];

    const direct = await findInEitherHarness(query, explicitHarness, loaders);
    if (direct !== null) {
        return {
            kind: 'found',
            testPath: query,
            harness: direct.harness,
            inferredHarness,
            viaOtherHarness: direct.viaOtherHarness,
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
        const resolved = await findInEitherHarness(match, explicitHarness, loaders);
        if (resolved !== null) {
            return {
                kind: 'found',
                testPath: match,
                harness: resolved.harness,
                inferredHarness,
                viaOtherHarness: resolved.viaOtherHarness,
                // Null when the match is what was typed, which steps 1-2 can
                // still miss on a stale bucket the re-lookup then finds. Without
                // this, the page redirects to the URL it is already on.
                resolvedFrom: match === query ? null : query,
                file: resolved.file,
                identity: resolved.identity,
            };
        }
        return { kind: 'not-in-file', query, testPath: match, searched, allTests };
    }
    return { kind: 'ambiguous', query, candidates: matches, total, truncated, allTests };
}
