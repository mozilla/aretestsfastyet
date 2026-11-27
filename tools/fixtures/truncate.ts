/**
 * Truncating a real published file down to a fixture.
 *
 * Keep the first N tests (or marker groups, or runs), then rebuild every
 * string table to contain only what the kept entries reference and renumber
 * the indices accordingly. The result is a valid file of the same shape,
 * small enough to check in.
 *
 * The subtlety these functions exist for: several arrays are indexed *by* a
 * table rather than parallel to the kept data — `taskInfo` by task-ID index,
 * `machineInfos` by machine-info index — so they must be re-emitted in the
 * remapped order, not sliced. Slicing them misaligns every entry and produces
 * a file that still parses.
 *
 * Kept apart from `make-fixtures.ts` so the truncation can be tested without
 * touching the network.
 */

/**
 * Remaps a string table to only the entries the kept data references.
 *
 * Returns the new table and a `map` from old index to new. Indices that were
 * never referenced are dropped, which is what makes the fixture small — a
 * 21-day file's `taskIds` table is most of its bytes.
 */
export class TableRemap {
    readonly #used = new Map<number, number>();
    readonly #source: string[];

    constructor(source: string[]) {
        this.#source = source;
    }

    /** Records a reference and returns the new index. */
    map(oldIndex: number | null): number | null {
        if (oldIndex === null || oldIndex === undefined) {
            return null;
        }
        const existing = this.#used.get(oldIndex);
        if (existing !== undefined) {
            return existing;
        }
        const next = this.#used.size;
        this.#used.set(oldIndex, next);
        return next;
    }

    /** The remapped table, in new-index order. */
    build(): string[] {
        return this.order().map((oldIndex) => this.#source[oldIndex] ?? '');
    }

    /**
     * The old indices that were referenced, in new-index order. This is what
     * lets a parallel array (`taskInfo`, `machineInfos`) be re-emitted in the
     * remapped order rather than sliced — they are indexed *by* the table, so
     * slicing them would silently misalign every entry.
     */
    order(): number[] {
        const out: number[] = new Array(this.#used.size);
        for (const [oldIndex, newIndex] of this.#used) {
            out[newIndex] = oldIndex;
        }
        return out;
    }
}

export type AnyRecord = Record<string, unknown>;

/**
 * Chooses which tests a fixture keeps.
 *
 * **Not the first N.** Taking a prefix is what makes a fixture circular: in
 * `xpcshell-00.json` the first `FAIL` group is on test 76 and there is no
 * `TIMEOUT` at all in the first 40, so a prefix fixture would validate the
 * decoder against exactly the shapes that happened to survive the cut. Instead
 * this walks every status and takes the first few tests carrying each, so the
 * fixture covers all five status-group shapes in as few tests as possible.
 */
function selectTests(
    testRuns: (AnyRecord | null)[][],
    statuses: string[],
    perStatus: number,
    preferred?: (testId: number) => boolean
): number[] {
    const chosen = new Set<number>();
    // Two passes when a directory is preferred, and the order matters. The
    // first takes the status's tests from inside that directory, so the fixture
    // really does contain the folder; the second tops each status up from
    // anywhere, because a status can be absent from one directory while present
    // in the table — `EXPECTED-FAIL` is carried by 4 of 21,429 mochitest tests
    // and by none in any one folder, and `fixtures.test.ts` requires every
    // status in a table to have a test carrying it.
    const passes =
        preferred === undefined ? [undefined] : [preferred, undefined as undefined];
    for (let statusId = 0; statusId < statuses.length; statusId++) {
        let taken = 0;
        for (const filter of passes) {
            for (let i = 0; i < testRuns.length && taken < perStatus; i++) {
                if (filter !== undefined && !filter(i)) {
                    continue;
                }
                if (testRuns[i]?.[statusId]) {
                    if (!chosen.has(i)) {
                        chosen.add(i);
                    }
                    taken += 1;
                }
            }
        }
    }
    return [...chosen].sort((a, b) => a - b);
}

/**
 * Truncates a timing file (daily, issues, issues-with-taskids, bucket) down to
 * a status-covering selection of tests, rebuilding every table.
 *
 * All four families share this code because they share the `testRuns` /
 * `tables` / `testInfo` skeleton; what differs is which arrays a status group
 * carries, and those are copied through generically.
 *
 * `perStatus` is how many tests to keep for each status, not a total.
 *
 * `pathPrefix` *prefers* tests under one directory, for a fixture that has to
 * **contain** a particular folder — `tests.html` merges the two harnesses'
 * aggregates, and testing that merge needs both fixtures to hold tests in one
 * shared folder, which status coverage alone will not arrange.
 *
 * Prefers rather than restricts: a status can be absent from the chosen
 * directory and present in the file's `statuses` table, and
 * `fixtures.test.ts` requires every status in a table to be carried by some
 * test. So each status is filled from the directory first and topped up from
 * anywhere. Both properties hold — the folder is present, and so is every
 * status — and the function throws rather than quietly returning a fixture
 * that lacks the folder it was asked for.
 */
export function truncateTimingFile(
    data: AnyRecord,
    perStatus: number,
    pathPrefix?: string,
    mustKeep?: ReadonlySet<string>
): AnyRecord {
    const tables = data['tables'] as Record<string, string[]>;
    const testInfo = data['testInfo'] as Record<string, (number | null)[]>;
    const testRuns = data['testRuns'] as (AnyRecord | null)[][];
    const taskInfo = data['taskInfo'] as Record<string, (number | null)[]> | undefined;

    const remaps: Record<string, TableRemap> = {};
    for (const [name, table] of Object.entries(tables)) {
        remaps[name] = new TableRemap(table);
    }
    // Statuses are indexed positionally by testRuns, so they cannot be
    // sparsely remapped without renumbering every group. Keep them whole.
    const keptStatuses = tables['statuses'] ?? [];

    // Task IDs are referenced from status groups *and* indexed by taskInfo, so
    // they need their own remap that also drives taskInfo's truncation.
    const taskRemap = tables['taskIds'] ? new TableRemap(tables['taskIds']) : undefined;

    const preferred =
        pathPrefix === undefined
            ? undefined
            : (testId: number): boolean => {
                  const directoryId = testInfo['testPathIds']?.[testId];
                  const directory =
                      directoryId === null || directoryId === undefined
                          ? ''
                          : (tables['testPaths']?.[directoryId] ?? '');
                  return directory === pathPrefix || directory.startsWith(`${pathPrefix}/`);
              };
    const selected = selectTests(testRuns, keptStatuses, perStatus, preferred);
    // Tests another fixture needs here, eg. those of the wpt subtests fixture.
    const required: number[] = [];
    if (mustKeep !== undefined) {
        for (let testId = 0; testId < testRuns.length; testId++) {
            const directory = tables['testPaths']?.[testInfo['testPathIds']?.[testId] ?? -1] ?? '';
            const name = tables['testNames']?.[testInfo['testNameIds']?.[testId] ?? -1] ?? '';
            if (mustKeep.has(directory ? `${directory}/${name}` : name)) {
                required.push(testId);
            }
        }
    }
    const kept = [...new Set([...selected, ...required])].sort((a, b) => a - b);
    if (kept.length === 0) {
        throw new Error('No tests carry any status, so the fixture would be empty.');
    }
    if (preferred !== undefined && !kept.some(preferred)) {
        // The whole point of asking for a directory is that the fixture
        // contains it; silently producing one that does not would leave the
        // test that needs it passing against the wrong data.
        throw new Error(
            `No tests under ${String(pathPrefix)} carry any status, so the fixture ` +
                'would not contain that folder.'
        );
    }

    const keptRuns: (AnyRecord | null)[][] = [];
    for (const i of kept) {
        const perTest = testRuns[i];
        if (!perTest) {
            keptRuns.push(perTest as never);
            continue;
        }
        const newPerTest: (AnyRecord | null)[] = [];
        for (let statusId = 0; statusId < perTest.length; statusId++) {
            const group = perTest[statusId];
            if (!group) {
                newPerTest.push(null);
                continue;
            }
            const newGroup: AnyRecord = {};
            for (const [key, value] of Object.entries(group)) {
                switch (key) {
                    case 'messageIds':
                        newGroup[key] = (value as (number | null)[]).map((id) =>
                            remaps['messages']!.map(id)
                        );
                        break;
                    case 'crashSignatureIds':
                        newGroup[key] = (value as (number | null)[]).map((id) =>
                            remaps['crashSignatures']!.map(id)
                        );
                        break;
                    case 'jobNameIds':
                        newGroup[key] = (value as number[]).map((id) => remaps['jobNames']!.map(id));
                        break;
                    case 'taskIdIds':
                        newGroup[key] = (value as (number | number[])[]).map((entry) =>
                            Array.isArray(entry)
                                ? entry.map((id) => taskRemap!.map(id))
                                : taskRemap!.map(entry)
                        );
                        break;
                    default:
                        // days, counts, durations, timestamps, minidumps —
                        // values, not indices, so they copy through unchanged.
                        newGroup[key] = value;
                }
            }
            newPerTest.push(newGroup);
        }
        keptRuns.push(newPerTest);
    }

    const newTestInfo: AnyRecord = {};
    for (const [key, value] of Object.entries(testInfo)) {
        const keptValues = kept.map((i) => value[i] ?? null);
        const table =
            key === 'testPathIds'
                ? 'testPaths'
                : key === 'testNameIds'
                  ? 'testNames'
                  : key === 'componentIds'
                    ? 'components'
                    : undefined;
        newTestInfo[key] = table
            ? keptValues.map((id) => remaps[table]!.map(id))
            : keptValues;
    }

    // taskInfo is indexed by task-ID index, so it must be re-emitted in the
    // remapped order rather than sliced.
    let newTaskInfo: AnyRecord | undefined;
    if (taskInfo && taskRemap) {
        const keptTaskIds = taskRemap.build();
        const order: number[] = [];
        const original = tables['taskIds'] ?? [];
        for (const id of keptTaskIds) {
            order.push(original.indexOf(id));
        }
        newTaskInfo = {};
        for (const [key, value] of Object.entries(taskInfo)) {
            const table =
                key === 'repositoryIds'
                    ? 'repositories'
                    : key === 'jobNameIds'
                      ? 'jobNames'
                      : key === 'commitIds'
                        ? 'commitIds'
                        : undefined;
            newTaskInfo[key] = order.map((oldIndex) => {
                const entry = value[oldIndex] ?? null;
                return table ? remaps[table]!.map(entry) : entry;
            });
        }
    }

    const newTables: AnyRecord = {};
    for (const name of Object.keys(tables)) {
        if (name === 'statuses') {
            newTables[name] = keptStatuses;
        } else if (name === 'taskIds') {
            newTables[name] = taskRemap ? taskRemap.build() : [];
        } else {
            newTables[name] = remaps[name]!.build();
        }
    }

    // The aggregates carry a test count that must match what survived; the
    // daily files have no such field, so do not invent one for them.
    const metadata = { ...(data['metadata'] as AnyRecord) };
    if ('totalTestCount' in metadata) {
        metadata['totalTestCount'] = keptRuns.length;
    }

    return {
        metadata,
        tables: newTables,
        ...(newTaskInfo ? { taskInfo: newTaskInfo } : {}),
        testInfo: newTestInfo,
        testRuns: keptRuns,
    };
}

// --- the subtests family ---------------------------------------------------

type SubtestRows = Record<string, (number | null)[] | (number | null)[][]>;

/** Where each test's subtests start, and the test's full path. */
function subtestLayout(data: AnyRecord): { first: number[]; counts: number[]; paths: string[] } {
    const tables = data['tables'] as Record<string, string[]>;
    const testInfo = data['testInfo'] as Record<string, (number | null)[]>;
    const counts = (data['subtests'] as AnyRecord)['countsByTest'] as number[];
    const first: number[] = [];
    const paths: string[] = [];
    let next = 0;
    for (let testId = 0; testId < counts.length; testId++) {
        first.push(next);
        next += counts[testId]!;
        const directory = tables['testPaths']?.[testInfo['testPathIds']?.[testId] ?? -1] ?? '';
        const name = tables['testNames']?.[testInfo['testNameIds']?.[testId] ?? -1] ?? '';
        paths.push(directory ? `${directory}/${name}` : name);
    }
    return { first, counts, paths };
}

/** `perKind` tests with unexpected results, expected failures only, passes only. */
export function selectSubtestTests(data: AnyRecord, perKind: number): string[] {
    const subtests = data['subtests'] as AnyRecord;
    const { first, counts, paths } = subtestLayout(data);
    const withRows = (rows: AnyRecord): Set<number> => {
        const tests = new Set<number>();
        let testId = 0;
        for (const subtestId of rows['subtestIds'] as number[]) {
            while (subtestId >= first[testId]! + counts[testId]!) {
                testId++;
            }
            tests.add(testId);
        }
        return tests;
    };
    const unexpected = withRows(subtests['unexpected'] as AnyRecord);
    const expected = withRows(subtests['expectedFailures'] as AnyRecord);
    const kinds: ((testId: number) => boolean)[] = [
        (testId) => unexpected.has(testId),
        (testId) => expected.has(testId) && !unexpected.has(testId),
        (testId) => !expected.has(testId) && !unexpected.has(testId),
    ];
    const chosen: string[] = [];
    for (const isKind of kinds) {
        let taken = 0;
        for (let testId = 0; testId < paths.length && taken < perKind; testId++) {
            if (isKind(testId)) {
                chosen.push(paths[testId]!);
                taken++;
            }
        }
    }
    return chosen;
}

/** Keeps the tests `keep` accepts and at most `maxSubtests` subtests of each. */
export function truncateSubtests(
    data: AnyRecord,
    keep: (testPath: string) => boolean,
    maxSubtests: number
): AnyRecord {
    const tables = data['tables'] as Record<string, string[]>;
    const testInfo = data['testInfo'] as Record<string, (number | null)[]>;
    const taskInfo = data['taskInfo'] as Record<string, (number | null)[]>;
    const subtests = data['subtests'] as AnyRecord;
    const expected = subtests['expectedFailures'] as SubtestRows;
    const unexpected = subtests['unexpected'] as SubtestRows;
    const { first, counts, paths } = subtestLayout(data);

    const remaps: Record<string, TableRemap> = {};
    for (const [name, table] of Object.entries(tables)) {
        remaps[name] = new TableRemap(table);
    }
    const remap = (table: string, id: number | null): number | null => remaps[table]!.map(id);

    const rowsBySubtest = (rows: SubtestRows): Map<number, number[]> => {
        const bySubtest = new Map<number, number[]>();
        (rows['subtestIds'] as number[]).forEach((subtestId, row) => {
            const list = bySubtest.get(subtestId);
            if (list === undefined) {
                bySubtest.set(subtestId, [row]);
            } else {
                list.push(row);
            }
        });
        return bySubtest;
    };
    const expectedRows = rowsBySubtest(expected);
    const unexpectedRows = rowsBySubtest(unexpected);
    const hasDays = unexpected['days'] !== undefined;

    const newTestInfo: Record<string, (number | null)[]> = {
        testPathIds: [],
        testNameIds: [],
        componentIds: [],
    };
    const out = {
        countsByTest: [] as number[],
        nameIds: [] as (number | null)[],
        passCounts: [] as number[],
        expectedFailures: {
            subtestIds: [] as number[],
            statusIds: [] as (number | null)[],
            jobNameIds: [] as (number | null)[][],
            counts: [] as number[][],
        },
        unexpected: {
            subtestIds: [] as number[],
            statusIds: [] as (number | null)[],
            taskIdIds: [] as (number | null)[][],
            messageIds: [] as (number | null)[][],
            ...(hasDays ? { days: [] as number[][] } : {}),
        },
    };
    const resultCounts = new Map<string, number>();
    const count = (status: string, results: number): void => {
        resultCounts.set(status, (resultCounts.get(status) ?? 0) + results);
    };

    for (let testId = 0; testId < paths.length; testId++) {
        if (!keep(paths[testId]!)) {
            continue;
        }
        const all = Array.from({ length: counts[testId]! }, (_, index) => first[testId]! + index);
        const withRows = all.filter((id) => expectedRows.has(id) || unexpectedRows.has(id));
        const passOnly = all.filter((id) => !expectedRows.has(id) && !unexpectedRows.has(id));
        // Subtests with a row first, then back in file order for the decoder.
        const kept = [...withRows, ...passOnly].slice(0, maxSubtests).sort((a, b) => a - b);

        newTestInfo['testPathIds']!.push(remap('testPaths', testInfo['testPathIds']![testId]!));
        newTestInfo['testNameIds']!.push(remap('testNames', testInfo['testNameIds']![testId]!));
        newTestInfo['componentIds']!.push(remap('components', testInfo['componentIds']![testId] ?? null));
        out.countsByTest.push(kept.length);

        for (const oldId of kept) {
            const newId = out.nameIds.length;
            out.nameIds.push(remap('subtestNames', (subtests['nameIds'] as number[])[oldId]!));
            const passCount = (subtests['passCounts'] as number[])[oldId]!;
            out.passCounts.push(passCount);
            count('PASS', passCount);

            for (const row of expectedRows.get(oldId) ?? []) {
                const statusId = (expected['statusIds'] as number[])[row]!;
                const rowCounts = (expected['counts'] as number[][])[row]!;
                out.expectedFailures.subtestIds.push(newId);
                out.expectedFailures.statusIds.push(remap('statuses', statusId));
                out.expectedFailures.jobNameIds.push(
                    (expected['jobNameIds'] as number[][])[row]!.map((id) => remap('jobNames', id))
                );
                out.expectedFailures.counts.push(rowCounts);
                count(tables['statuses']![statusId]!, rowCounts.reduce((sum, value) => sum + value, 0));
            }
            for (const row of unexpectedRows.get(oldId) ?? []) {
                const statusId = (unexpected['statusIds'] as number[])[row]!;
                const taskIdIds = (unexpected['taskIdIds'] as number[][])[row]!;
                out.unexpected.subtestIds.push(newId);
                out.unexpected.statusIds.push(remap('statuses', statusId));
                out.unexpected.taskIdIds.push(taskIdIds.map((id) => remap('taskIds', id)));
                out.unexpected.messageIds.push(
                    (unexpected['messageIds'] as (number | null)[][])[row]!.map((id) => remap('messages', id))
                );
                out.unexpected.days?.push((unexpected['days'] as number[][])[row]!);
                count(tables['statuses']![statusId]!, taskIdIds.length);
            }
        }
    }

    // taskInfo is indexed by task-ID index: re-emitted in the remapped order.
    const taskOrder = remaps['taskIds']!.order();
    const newTaskInfo: AnyRecord = {};
    for (const [key, value] of Object.entries(taskInfo)) {
        const table =
            key === 'repositoryIds'
                ? 'repositories'
                : key === 'jobNameIds'
                  ? 'jobNames'
                  : key === 'commitIds'
                    ? 'commitIds'
                    : undefined;
        newTaskInfo[key] = taskOrder.map((oldIndex) => {
            const entry = value[oldIndex] ?? null;
            return table ? remap(table, entry) : entry;
        });
    }

    const newTables: AnyRecord = {};
    for (const name of Object.keys(tables)) {
        newTables[name] = remaps[name]!.build();
    }

    const metadata = { ...(data['metadata'] as AnyRecord) };
    metadata['subtestCount'] = out.nameIds.length;
    if ('totalTestCount' in metadata) {
        metadata['totalTestCount'] = out.countsByTest.length;
    }
    if ('resultCounts' in metadata) {
        metadata['resultCounts'] = Object.fromEntries(
            [...resultCounts].filter(([, results]) => results > 0).sort(([a], [b]) => (a < b ? -1 : 1))
        );
    }

    return {
        metadata,
        tables: newTables,
        taskInfo: newTaskInfo,
        testInfo: newTestInfo,
        subtests: out,
    };
}

/**
 * Truncates an errors file to its first `count` marker groups, keeping at most
 * `tasksPerGroup` tasks in each.
 *
 * Capping the tasks per group is what makes a mochitest fixture viable: a
 * single group there spans 8,000-odd tasks, so 60 groups would drag in most of
 * a 17,000-entry `taskIds` table and produce a 1.8 MB fixture. The cap keeps
 * the delta-encoded structure — several tasks per group, ascending — while
 * cutting the table down to what a test needs.
 */
export function truncateErrors(
    data: AnyRecord,
    count: number,
    tasksPerGroup = 8
): AnyRecord {
    const tables = data['tables'] as Record<string, string[]>;
    const messages = data['messages'] as Record<string, (number | null)[]>;
    const testInfo = data['testInfo'] as Record<string, (number | null)[]>;
    const taskInfo = data['taskInfo'] as Record<string, number[]>;
    const markers = data['markers'] as {
        testIds: number[];
        messageIds: number[];
        taskIdIds: number[][];
        counts: number[][];
    };

    const keep = Math.min(count, markers.testIds.length);
    const testRemap = new TableRemap([]);
    const messageRemap = new TableRemap([]);
    const taskRemap = new TableRemap(tables['taskIds'] ?? []);

    const newMarkers = {
        testIds: [] as (number | null)[],
        messageIds: [] as (number | null)[],
        taskIdIds: [] as number[][],
        counts: [] as number[][],
    };
    for (let i = 0; i < keep; i++) {
        newMarkers.testIds.push(testRemap.map(markers.testIds[i]!));
        newMarkers.messageIds.push(messageRemap.map(markers.messageIds[i]!));
        // taskIdIds is delta-encoded per group: decode, remap, re-encode.
        // The remapped indices are not necessarily ascending any more, so the
        // group is sorted before re-encoding to keep the deltas non-negative.
        const decoded: number[] = [];
        let acc = 0;
        for (const delta of markers.taskIdIds[i]!) {
            acc += delta;
            decoded.push(acc);
            if (decoded.length >= tasksPerGroup) {
                break;
            }
        }
        const pairs = decoded.map((taskId, j) => ({
            taskId: taskRemap.map(taskId)!,
            count: markers.counts[i]![j]!,
        }));
        pairs.sort((a, b) => a.taskId - b.taskId);
        const reencoded: number[] = [];
        let previous = 0;
        for (const { taskId } of pairs) {
            reencoded.push(taskId - previous);
            previous = taskId;
        }
        newMarkers.taskIdIds.push(reencoded);
        newMarkers.counts.push(pairs.map((p) => p.count));
    }

    // Rebuild the message and test tables in the order the kept markers
    // referenced them.
    const messageOrder = messageRemap.order();
    const testOrder = testRemap.order();

    const markerNameRemap = new TableRemap(tables['markerNames'] ?? []);
    const textRemap = new TableRemap(tables['messageTexts'] ?? []);
    const fileRemap = new TableRemap(tables['files'] ?? []);
    const componentRemap = new TableRemap(tables['components'] ?? []);
    const testPathRemap = new TableRemap(tables['testPaths'] ?? []);
    const testNameRemap = new TableRemap(tables['testNames'] ?? []);
    const jobNameRemap = new TableRemap(tables['jobNames'] ?? []);
    const repositoryRemap = new TableRemap(tables['repositories'] ?? []);
    const commitRemap = new TableRemap(tables['commitIds'] ?? []);

    const newMessages: AnyRecord = {
        markerNameIds: messageOrder.map((i) => markerNameRemap.map(messages['markerNameIds']![i]!)),
        textIds: messageOrder.map((i) => textRemap.map(messages['textIds']![i]!)),
        fileIds: messageOrder.map((i) => fileRemap.map(messages['fileIds']![i]!)),
        lines: messageOrder.map((i) => messages['lines']![i]!),
        componentIds: messageOrder.map((i) => componentRemap.map(messages['componentIds']![i]!)),
    };

    const newTestInfo: AnyRecord = {
        testPathIds: testOrder.map((i) => testPathRemap.map(testInfo['testPathIds']![i]!)),
        testNameIds: testOrder.map((i) => testNameRemap.map(testInfo['testNameIds']![i]!)),
        componentIds: testOrder.map((i) => componentRemap.map(testInfo['componentIds']![i]!)),
    };

    const taskOrder = taskRemap.order();
    const newTaskInfo: AnyRecord = {
        repositoryIds: taskOrder.map((i) => repositoryRemap.map(taskInfo['repositoryIds']![i]!)),
        jobNameIds: taskOrder.map((i) => jobNameRemap.map(taskInfo['jobNameIds']![i]!)),
        commitIds: taskOrder.map((i) => commitRemap.map(taskInfo['commitIds']![i]!)),
    };

    // metadata.markerCounts must agree with what survived, or the fixture
    // asserts a total the file does not contain.
    const markerCounts: Record<string, number> = {};
    for (let i = 0; i < newMarkers.messageIds.length; i++) {
        const kindId = newMessages['markerNameIds'] as (number | null)[];
        const kind = markerNameRemap.build()[kindId[newMarkers.messageIds[i]!]!] ?? '';
        const total = newMarkers.counts[i]!.reduce((a, b) => a + b, 0);
        markerCounts[kind] = (markerCounts[kind] ?? 0) + total;
    }

    return {
        metadata: { ...(data['metadata'] as AnyRecord), markerCounts },
        tables: {
            jobNames: jobNameRemap.build(),
            testPaths: testPathRemap.build(),
            testNames: testNameRemap.build(),
            repositories: repositoryRemap.build(),
            taskIds: taskRemap.build(),
            components: componentRemap.build(),
            commitIds: commitRemap.build(),
            markerNames: markerNameRemap.build(),
            messageTexts: textRemap.build(),
            files: fileRemap.build(),
        },
        messages: newMessages,
        taskInfo: newTaskInfo,
        testInfo: newTestInfo,
        markers: newMarkers,
    };
}

/** Truncates `manifests.json` to its first `count` runs. */
export function truncateManifests(data: AnyRecord, count: number): AnyRecord {
    const runs = data['runs'] as Record<string, number[]>;
    const tasks = data['tasks'] as { id: string[]; jobName: number[]; commitId: number[]; prefix: number[] };

    const manifestRemap = new TableRemap(data['manifests'] as string[]);
    const jobNameRemap = new TableRemap(data['jobNames'] as string[]);
    const commitRemap = new TableRemap(data['commits'] as string[]);
    const prefixRemap = new TableRemap(data['prefixes'] as string[]);
    const taskRemap = new TableRemap(tasks.id);

    const keep = Math.min(count, runs['manifestIds']!.length);
    const newRuns = {
        manifestIds: [] as (number | null)[],
        jobNameIds: [] as (number | null)[],
        taskIds: [] as (number | null)[],
        durations: [] as number[],
    };
    for (let i = 0; i < keep; i++) {
        newRuns.manifestIds.push(manifestRemap.map(runs['manifestIds']![i]!));
        newRuns.jobNameIds.push(jobNameRemap.map(runs['jobNameIds']![i]!));
        newRuns.taskIds.push(taskRemap.map(runs['taskIds']![i]!));
        newRuns.durations.push(runs['durations']![i]!);
    }

    const taskOrder = taskRemap.order();
    const newTasks = {
        id: taskOrder.map((i) => tasks.id[i]!),
        jobName: taskOrder.map((i) => jobNameRemap.map(tasks.jobName[i]!)),
        commitId: taskOrder.map((i) => commitRemap.map(tasks.commitId[i]!)),
        prefix: taskOrder.map((i) => prefixRemap.map(tasks.prefix[i]!)),
    };

    return {
        metadata: data['metadata'],
        manifests: manifestRemap.build(),
        jobNames: jobNameRemap.build(),
        commits: commitRemap.build(),
        prefixes: prefixRemap.build(),
        tasks: newTasks,
        runs: newRuns,
    };
}

/** Truncates a resources file to its first `count` jobs. */
export function truncateResources(data: AnyRecord, count: number): AnyRecord {
    const jobs = data['jobs'] as Record<string, unknown[]>;
    const jobNameRemap = new TableRemap(data['jobNames'] as string[]);
    const repositoryRemap = new TableRemap(data['repositories'] as string[]);
    const machineRemap = new TableRemap([]);

    const keep = Math.min(count, jobs['taskIds']!.length);
    const newJobs: AnyRecord = {};
    for (const [key, value] of Object.entries(jobs)) {
        const kept = value.slice(0, keep);
        if (key === 'jobNameIds') {
            newJobs[key] = kept.map((id) => jobNameRemap.map(id as number));
        } else if (key === 'repositoryIds') {
            newJobs[key] = kept.map((id) => repositoryRemap.map(id as number));
        } else if (key === 'machineInfoIds') {
            newJobs[key] = kept.map((id) => machineRemap.map(id as number));
        } else {
            newJobs[key] = kept;
        }
    }

    const machineOrder = machineRemap.order();
    const machineInfos = data['machineInfos'] as unknown[];
    return {
        jobNames: jobNameRemap.build(),
        repositories: repositoryRemap.build(),
        machineInfos: machineOrder.map((i) => machineInfos[i]),
        jobs: newJobs,
    };
}
