/**
 * String-table and parallel-array lookups.
 *
 * Every timing file interns its strings into `tables.*` and refers to them by
 * index. Reading a table is trivial; reading it *safely* is the part worth
 * writing once, because the failure mode of an out-of-range index is
 * `undefined` flowing into a string, which then reads as the literal text
 * "undefined" in a report rather than as an error.
 *
 * The other thing this file owns is the **task-ID convention mismatch**. The
 * timing files store `"<taskId>.<retryId>"` always, including `.0`; the
 * resource files store the bare ID and suffix only non-zero retries. See
 * `FORMATS.md` — no resource-file entry in the whole sweep ended in `.0`, and
 * between 0.5% and 5% of entries per file carried a non-zero suffix, so
 * neither side can be assumed to match the other textually. Joining the two
 * families needs normalization, and every site that does it should use the
 * same normalization.
 */

/** Thrown when an index is not in range for the table it indexes. */
export class TableIndexError extends Error {
    // Written out rather than declared as constructor parameter properties:
    // `node --experimental-strip-types` erases types without emitting code, so
    // a parameter property has nowhere to be assigned and is rejected outright.
    readonly table: string;
    readonly index: number;
    readonly length: number;

    constructor(table: string, index: number, length: number) {
        super(`index ${index} out of range for ${table} (length ${length})`);
        this.name = 'TableIndexError';
        this.table = table;
        this.index = index;
        this.length = length;
    }
}

/**
 * Reads `table[index]`, throwing rather than returning `undefined`.
 *
 * `name` is only used in the error message, and is worth passing: "index 41
 * out of range for tables.messages" is actionable and "undefined" is not.
 */
export function lookup(table: readonly string[], index: number, name: string): string {
    const value = table[index];
    if (value === undefined) {
        throw new TableIndexError(name, index, table.length);
    }
    return value;
}

/**
 * Reads `table[index]` where the index may be `null` or absent.
 *
 * `null` is meaningful in several places — a failing run that recorded no
 * message, a crash with no symbolized signature, a test with no Bugzilla
 * component — and is distinct from an out-of-range index, which is still an
 * error. `undefined` is folded in with `null`: it is what reading past the end
 * of a shorter parallel array gives, and the callers that can hit it want the
 * same "not recorded" answer.
 */
export function lookupOptional(
    table: readonly string[],
    index: number | null | undefined,
    name: string
): string | null {
    if (index === null || index === undefined) {
        return null;
    }
    return lookup(table, index, name);
}

/**
 * Reads `table[index]` where the table itself may not have been supplied.
 *
 * A missing table is a caller error — passing a bucket file's group with the
 * issues file's tables, say — and is worth distinguishing from an index that
 * is out of range for a table that *was* supplied.
 */
export function lookupRequiredTable(
    table: readonly string[] | undefined,
    index: number,
    name: string
): string {
    if (table === undefined) {
        throw new Error(`${name} is needed to decode this group but was not supplied`);
    }
    return lookup(table, index, name);
}

/**
 * A test's full path, as every page builds it: the directory from
 * `tables.testPaths` joined to the filename from `tables.testNames`.
 *
 * A test at the top of the tree has an empty directory, in which case the name
 * stands alone rather than being prefixed with a slash.
 */
export function joinTestPath(directory: string, name: string): string {
    return directory ? `${directory}/${name}` : name;
}

/** The tables needed to name a test. */
export interface TestInfoTables {
    testPaths: readonly string[];
    testNames: readonly string[];
    components?: readonly string[] | undefined;
}

/** `testInfo`, as far as naming a test is concerned. */
export interface TestInfoArrays {
    testPathIds: readonly number[];
    testNameIds: readonly number[];
    componentIds?: readonly (number | null)[] | undefined;
}

/** A decoded test identity. */
export interface TestIdentity {
    testId: number;
    /** `dom/base/test/test_foo.html`, or just `test_foo.html` at the root. */
    fullPath: string;
    /** The directory, possibly empty. */
    directory: string;
    /** The filename. */
    name: string;
    /** Bugzilla component, `null` when the test has none recorded. */
    component: string | null;
}

/** Decodes one test's identity from the interned tables. */
export function readTest(
    tables: TestInfoTables,
    testInfo: TestInfoArrays,
    testId: number
): TestIdentity {
    const pathId = testInfo.testPathIds[testId];
    const nameId = testInfo.testNameIds[testId];
    if (pathId === undefined || nameId === undefined) {
        throw new TableIndexError('testInfo', testId, testInfo.testPathIds.length);
    }
    const directory = lookup(tables.testPaths, pathId, 'tables.testPaths');
    const name = lookup(tables.testNames, nameId, 'tables.testNames');
    const componentId = testInfo.componentIds?.[testId] ?? null;
    return {
        testId,
        fullPath: joinTestPath(directory, name),
        directory,
        name,
        component: tables.components
            ? lookupOptional(tables.components, componentId, 'tables.components')
            : null,
    };
}

/**
 * Finds a test by its full path, returning `null` when the file has no such
 * test.
 *
 * Linear, because the files are not indexed by path and a single query reads
 * one file once. A caller doing many lookups against one file should build a
 * map with `indexTestsByPath` instead.
 */
export function findTestByPath(
    tables: TestInfoTables,
    testInfo: TestInfoArrays,
    fullPath: string
): TestIdentity | null {
    const testId = indexTestsByPath(tables, testInfo).get(fullPath);
    return testId === undefined ? null : readTest(tables, testInfo, testId);
}

/** Builds a full-path → test-ID map for repeated lookups against one file. */
export function indexTestsByPath(
    tables: TestInfoTables,
    testInfo: TestInfoArrays
): Map<string, number> {
    const byPath = new Map<string, number>();
    for (let testId = 0; testId < testInfo.testPathIds.length; testId++) {
        const pathId = testInfo.testPathIds[testId]!;
        const nameId = testInfo.testNameIds[testId];
        if (nameId === undefined) {
            continue;
        }
        const directory = lookup(tables.testPaths, pathId, 'tables.testPaths');
        const name = lookup(tables.testNames, nameId, 'tables.testNames');
        byPath.set(joinTestPath(directory, name), testId);
    }
    return byPath;
}

// --- task IDs ------------------------------------------------------------

/** A task ID split into its two parts. */
export interface ParsedTaskId {
    /** The Taskcluster task ID, with no suffix. */
    taskId: string;
    /**
     * The job-level retry (`runs/<n>` in Taskcluster). Zero when the file
     * omitted the suffix, which the resource files do for `.0` — so a zero
     * here means "run 0", whether or not it was written down.
     *
     * This is the job-level retry axis, *not* the harness's within-job rerun.
     * `lib/model/execution.ts` owns the latter; conflating them is the mistake
     * `PLAN.md` §1 warns about.
     */
    retryId: number;
}

/**
 * Splits a task ID from any family into (taskId, retryId).
 *
 * Accepts both conventions: `"abc123.0"` and `"abc123"` both yield retry 0. A
 * suffix that is not a run of digits is not a retry — Taskcluster task IDs are
 * URL-safe base64 and never contain a dot, but being explicit costs nothing
 * and keeps a malformed ID from being silently truncated.
 */
export function parseTaskId(raw: string): ParsedTaskId {
    const dot = raw.lastIndexOf('.');
    if (dot === -1) {
        return { taskId: raw, retryId: 0 };
    }
    const suffix = raw.slice(dot + 1);
    if (suffix.length === 0 || !/^\d+$/.test(suffix)) {
        return { taskId: raw, retryId: 0 };
    }
    return { taskId: raw.slice(0, dot), retryId: Number(suffix) };
}

/**
 * The canonical `"<taskId>.<retryId>"` form, which is what the timing files
 * use.
 *
 * Normalizing to this form on both sides is how a resource-file join is done:
 * `normalizeTaskId(resourcesTaskId) === timingTaskId`. Normalizing to the bare
 * ID instead would merge a job's retries, which is exactly the distinction the
 * suffix exists to preserve.
 */
export function normalizeTaskId(raw: string): string {
    const { taskId, retryId } = parseTaskId(raw);
    return `${taskId}.${retryId}`;
}

/** The bare task ID, with any retry suffix removed. */
export function bareTaskId(raw: string): string {
    return parseTaskId(raw).taskId;
}
