/**
 * `worker-lifecycle.js`: how a pool's worker lifecycle becomes Firefox Profiler markers.
 *
 * The phase rules and the stop-reason grouping are tested on hand-written workers.
 * The real day has no worker without a request and no removal without a stop, so
 * those shapes cannot come from the fixture. The location threads are checked
 * against counts made from the raw timestamps, never from the module's own phases.
 * The fixture exercises decoding and the threads on real rows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { encodeWorkerLifecycle, type LifecycleRow } from './worker-lifecycle-encode.ts';

interface DecodedWorker {
    pool: string;
    zone: string | null;
    launchConfigId: string | null;
    workerId: string | null;
    capacity: number | null;
    requestedMs: number | null;
    runningMs: number | null;
    stoppedMs: number | null;
    removedMs: number | null;
    stoppedReason: string | null;
    removedReason: string | null;
}

interface DecodedError {
    timeMs: number;
    pool: string;
    zone: string | null;
    workerId: string | null;
    launchConfigId: string | null;
    kind: string | null;
    code: string | null;
    title: string | null;
}

interface Lifecycle {
    date: string;
    workers: DecodedWorker[];
    errors: DecodedError[];
}

interface Window {
    startMs: number;
    endMs: number;
}

interface Phase {
    band: string;
    startMs: number;
    endMs: number;
}

type Payload = Record<string, number | string | undefined>;

interface MarkerTable {
    data: Payload[];
    name: number[];
    startTime: number[];
    endTime: (number | null)[];
    phase: number[];
    category: number[];
    length: number;
}

interface SchemaField {
    key: string;
    format?: string;
    hidden?: boolean;
}

interface Schema {
    name: string;
    fields: SchemaField[];
}

interface TaskRun {
    workerId: string | null;
    startMs: number;
    endMs: number;
    taskId: string;
    state: string;
    color?: string;
}

interface ProfileCategory {
    name: string;
    color: string;
    subcategories: string[];
}

interface Thread {
    name: string;
    processName: string;
    pid: string;
    tid: number;
    isMainThread: boolean;
    markers: MarkerTable;
    samples: { stack: number[]; time: number[]; weight: number[]; threadCPUDelta: number[]; length: number };
    stackTable: { frame: number[]; prefix: (number | null)[]; category: number[]; length: number };
    frameTable: { func: number[]; length: number };
    funcTable: { name: number[]; length: number };
}

interface WorkerLifecycleApi {
    decodeWorkerLifecycle(data: unknown): Lifecycle;
    lifecycleForPool(lifecycle: Lifecycle, pool: string): { workers: DecodedWorker[]; errors: DecodedError[] };
    workerPhases(worker: DecodedWorker, window: Window): Phase[];
    stopReasonCategory(reason: string | null): string;
    topStopReasons(workers: DecodedWorker[], window: Window): string[];
    locationPath(zone: string | null): string[];
    locationThreads(
        lifecycle: Lifecycle,
        pool: string,
        options: {
            window: Window;
            tasks: TaskRun[];
            getStringIndex: (value: string) => number;
            categoryBase: number;
            structuralCategory: number;
            idleCategory: number;
            tidBase: number;
        }
    ): { threads: Thread[]; schemas: Schema[]; categories: ProfileCategory[]; bucketMs: number; peakWorkers: number };
    threadOrderParam(trackCount: number): string;
    profilerQuery(trackCount: number): string;
}

// Evaluated in this realm, so the arrays it returns are this test's arrays.
// A vm context would give them another Array prototype, and deepStrictEqual
// rejects that.
function loadWorkerLifecycle(): WorkerLifecycleApi {
    const source = readFileSync(new URL('../worker-lifecycle.js', import.meta.url), 'utf8');
    const evaluate = new Function('module', source) as (module: { exports: unknown }) => void;
    const scriptModule = { exports: {} as unknown };
    evaluate(scriptModule);
    return scriptModule.exports as WorkerLifecycleApi;
}

const WorkerLifecycle = loadWorkerLifecycle();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const POOL = 'gecko-t/t-linux-docker-amd';
const OTHER_POOL = 'gecko-3/b-linux-medium';
const DAY_START = Date.parse('2026-10-29T00:00:00Z');
const WINDOW: Window = { startMs: DAY_START, endMs: DAY_START + 24 * HOUR };
const RESERVED_KEYS = ['cause', 'stack', 'name', 'startTime', 'endTime', 'id'];
const FIXTURE = new URL('./fixtures/worker-lifecycle.json', import.meta.url);

function worker(overrides: Partial<DecodedWorker> = {}): DecodedWorker {
    return {
        pool: POOL,
        zone: 'us-central1-a',
        launchConfigId: 'lc-1',
        workerId: 'w-1',
        capacity: 1,
        requestedMs: null,
        runningMs: null,
        stoppedMs: null,
        removedMs: null,
        stoppedReason: null,
        removedReason: null,
        ...overrides,
    };
}

function lifecycleOf(workers: DecodedWorker[], errors: DecodedError[] = []): Lifecycle {
    return { date: '2026-10-29', workers, errors };
}

function phasesInSeconds(workerRecord: DecodedWorker, window: Window = WINDOW): [string, number, number][] {
    return WorkerLifecycle.workerPhases(workerRecord, window).map(phase => [
        phase.band,
        (phase.startMs - window.startMs) / SECOND,
        (phase.endMs - window.startMs) / SECOND,
    ]);
}

// --- phases ---------------------------------------------------------------

test('a full lifecycle is starting, running, then stopping', () => {
    const phases = phasesInSeconds(worker({
        requestedMs: DAY_START + HOUR,
        runningMs: DAY_START + HOUR + 30 * SECOND,
        stoppedMs: DAY_START + 2 * HOUR,
        removedMs: DAY_START + 2 * HOUR + 5 * SECOND,
    }));
    assert.deepEqual(phases, [
        ['starting', 3600, 3630],
        ['running', 3630, 7200],
        ['stopping', 7200, 7205],
    ]);
});

test('a worker stopped but never removed has no stopping phase', () => {
    const phases = phasesInSeconds(worker({
        requestedMs: DAY_START + HOUR,
        runningMs: DAY_START + HOUR + 30 * SECOND,
        stoppedMs: DAY_START + 2 * HOUR,
    }));
    assert.deepEqual(phases, [
        ['starting', 3600, 3630],
        ['running', 3630, 7200],
    ]);
});

test('a worker that never reached running failed to start at its stop', () => {
    const phases = phasesInSeconds(worker({
        requestedMs: DAY_START + HOUR,
        stoppedMs: DAY_START + 2 * HOUR,
    }));
    assert.deepEqual(phases, [['failedToStart', 3600, 7200]]);
});

test('a failed start that is then removed also has its stopping phase', () => {
    const phases = phasesInSeconds(worker({
        requestedMs: DAY_START + HOUR,
        stoppedMs: DAY_START + 2 * HOUR,
        removedMs: DAY_START + 2 * HOUR + 10 * SECOND,
    }));
    assert.deepEqual(phases, [
        ['failedToStart', 3600, 7200],
        ['stopping', 7200, 7210],
    ]);
});

test('a removal with no stop ends the running phase', () => {
    const phases = phasesInSeconds(worker({
        requestedMs: DAY_START + HOUR,
        runningMs: DAY_START + HOUR + 30 * SECOND,
        removedMs: DAY_START + 3 * HOUR,
    }));
    assert.deepEqual(phases, [
        ['starting', 3600, 3630],
        ['running', 3630, 10800],
    ]);
});

test('a worker still starting runs to the window end', () => {
    const phases = phasesInSeconds(worker({ requestedMs: DAY_START + HOUR }));
    assert.deepEqual(phases, [['starting', 3600, 86400]]);
});

test('a worker still running runs to the window end', () => {
    const phases = phasesInSeconds(worker({
        requestedMs: DAY_START + HOUR,
        runningMs: DAY_START + HOUR + 30 * SECOND,
    }));
    assert.deepEqual(phases, [
        ['starting', 3600, 3630],
        ['running', 3630, 86400],
    ]);
});

test('a worker requested the day before is clipped to the window start', () => {
    const phases = phasesInSeconds(worker({
        requestedMs: DAY_START - HOUR,
        runningMs: DAY_START - 30 * MINUTE,
        stoppedMs: DAY_START + HOUR,
        removedMs: DAY_START + HOUR + 10 * SECOND,
    }));
    assert.deepEqual(phases, [
        ['running', 0, 3600],
        ['stopping', 3600, 3610],
    ]);
});

test('a worker with no request but a running event is running from the window start', () => {
    const phases = phasesInSeconds(worker({
        runningMs: DAY_START + 2 * HOUR,
        stoppedMs: DAY_START + 3 * HOUR,
    }));
    assert.deepEqual(phases, [['running', 0, 10800]]);
});

test('zero-length phases are dropped', () => {
    const phases = phasesInSeconds(worker({
        requestedMs: DAY_START + HOUR,
        runningMs: DAY_START + HOUR,
        stoppedMs: DAY_START + 2 * HOUR,
    }));
    assert.deepEqual(phases, [['running', 3600, 7200]]);
});

test('a removal before the stop draws no stopping phase, and the running phase ends at the removal', () => {
    const phases = phasesInSeconds(worker({
        requestedMs: DAY_START + HOUR,
        runningMs: DAY_START + HOUR + 30 * SECOND,
        stoppedMs: DAY_START + 3 * HOUR,
        removedMs: DAY_START + 2 * HOUR,
    }));
    assert.deepEqual(phases, [
        ['starting', 3600, 3630],
        ['running', 3630, 7200],
    ]);
});

// --- stop reasons ---------------------------------------------------------

test('stop reasons are grouped into categories by pattern', () => {
    const cases: [string | null, string][] = [
        ['workerManager.removeWorker API call', 'removeWorker API call'],
        ['instance not found', 'instance not found'],
        ['instance TERMINATED', 'instance terminated'],
        ['vm not found in state running', 'vm not found'],
        ['terminateAfter time exceeded', 'terminateAfter exceeded'],
        ['deployment Failed: At least one resource deployment operation failed.', 'ARM deployment failed'],
        ['ARM Deployment failure: The template deployment is not valid', 'ARM deployment failed'],
        ['worker never claimed work, created=Wed Oct 28', 'never claimed work'],
        ['worker inactive, lastDateActive=Thu Oct 29', 'inactive'],
        ['failed power state; powerStates=ProvisioningState/succeeded', 'failed power state'],
        ['something nobody has seen before', 'unclassified'],
        [null, 'no reason recorded'],
    ];
    for (const [reason, category] of cases) {
        assert.equal(WorkerLifecycle.stopReasonCategory(reason), category, `reason ${JSON.stringify(reason)}`);
    }
});

test('categories are ranked by count, ties by name, and the top six are kept', () => {
    const reasons: [string, number][] = [
        ['instance not found', 8],
        ['workerManager.removeWorker API call', 7],
        ['terminateAfter time exceeded', 6],
        ['instance TERMINATED', 5],
        ['failed power state; x', 4],
        ['worker inactive, x', 3],
        ['vm not found in state running', 2],
        ['something nobody has seen before', 1],
    ];
    const workers = reasons.flatMap(([reason, count]) =>
        Array.from({ length: count }, (_, index) => worker({
            workerId: `${reason}-${index}`,
            stoppedMs: DAY_START + HOUR,
            stoppedReason: reason,
        }))
    );
    assert.deepEqual(WorkerLifecycle.topStopReasons(workers, WINDOW), [
        'instance not found',
        'removeWorker API call',
        'terminateAfter exceeded',
        'instance terminated',
        'failed power state',
        'inactive',
    ]);
});

test('a tie in counts is broken by name', () => {
    const workers = [
        worker({ workerId: 'a', stoppedMs: DAY_START + HOUR, stoppedReason: 'worker never claimed work, x' }),
        worker({ workerId: 'b', stoppedMs: DAY_START + HOUR, stoppedReason: 'vm not found in state running' }),
    ];
    assert.deepEqual(WorkerLifecycle.topStopReasons(workers, WINDOW), ['never claimed work', 'vm not found']);
});

// --- decoding -------------------------------------------------------------

test('decoding restores absolute times and nulls from the encoded layout', () => {
    const rows: LifecycleRow[] = [
        {
            row_type: 'worker',
            worker_pool_id: 'P',
            worker_group: 'z1',
            worker_id: 'w-a',
            launch_config_id: 'lc-1',
            capacity: 1,
            requested: 1000000,
            running: 1030000,
            stopped: 2000000,
            stopped_reason: 'instance not found',
            removed: 2010000,
            removed_reason: 'workerManager.removeWorker API call',
            error_time: null,
            error_kind: null,
            error_code: null,
            error_title: null,
        },
        {
            row_type: 'worker',
            worker_pool_id: 'P',
            worker_group: null,
            worker_id: 'w-b',
            launch_config_id: null,
            capacity: null,
            requested: 1500000,
            running: null,
            stopped: null,
            stopped_reason: null,
            removed: null,
            removed_reason: null,
            error_time: null,
            error_kind: null,
            error_code: null,
            error_title: null,
        },
        {
            row_type: 'worker',
            worker_pool_id: 'Q',
            worker_group: 'z2',
            worker_id: 'w-c',
            launch_config_id: 'lc-2',
            capacity: 8,
            requested: null,
            running: 900000,
            stopped: 1100000,
            stopped_reason: null,
            removed: null,
            removed_reason: null,
            error_time: null,
            error_kind: null,
            error_code: null,
            error_title: null,
        },
        {
            row_type: 'error',
            worker_pool_id: 'P',
            worker_group: null,
            worker_id: null,
            launch_config_id: null,
            capacity: null,
            requested: null,
            running: null,
            stopped: null,
            stopped_reason: null,
            removed: null,
            removed_reason: null,
            error_time: 1200000,
            error_kind: 'operation-error',
            error_code: null,
            error_title: 'Operation Error',
        },
        {
            row_type: 'error',
            worker_pool_id: 'Q',
            worker_group: 'z2',
            worker_id: 'w-c',
            launch_config_id: 'lc-2',
            capacity: null,
            requested: null,
            running: null,
            stopped: null,
            stopped_reason: null,
            removed: null,
            removed_reason: null,
            error_time: 1000000,
            error_kind: 'arm-deployment-error',
            error_code: 'DeploymentFailed',
            error_title: 'ARM',
        },
    ];
    const artifact = encodeWorkerLifecycle(rows, '2026-10-29', '2026-10-30T02:00:00.000Z');
    const decoded = WorkerLifecycle.decodeWorkerLifecycle(JSON.parse(JSON.stringify(artifact)));
    assert.equal(decoded.date, '2026-10-29');
    assert.deepEqual(decoded.workers, [
        {
            pool: 'Q', zone: 'z2', launchConfigId: 'lc-2', workerId: 'w-c', capacity: 8,
            requestedMs: null, runningMs: 900000, stoppedMs: 1100000, removedMs: null,
            stoppedReason: null, removedReason: null,
        },
        {
            pool: 'P', zone: 'z1', launchConfigId: 'lc-1', workerId: 'w-a', capacity: 1,
            requestedMs: 1000000, runningMs: 1030000, stoppedMs: 2000000, removedMs: 2010000,
            stoppedReason: 'instance not found', removedReason: 'workerManager.removeWorker API call',
        },
        {
            pool: 'P', zone: null, launchConfigId: null, workerId: 'w-b', capacity: null,
            requestedMs: 1500000, runningMs: null, stoppedMs: null, removedMs: null,
            stoppedReason: null, removedReason: null,
        },
    ]);
    assert.deepEqual(decoded.errors, [
        {
            timeMs: 1000000, pool: 'Q', zone: 'z2', workerId: 'w-c', launchConfigId: 'lc-2',
            kind: 'arm-deployment-error', code: 'DeploymentFailed', title: 'ARM',
        },
        {
            timeMs: 1200000, pool: 'P', zone: null, workerId: null, launchConfigId: null,
            kind: 'operation-error', code: null, title: 'Operation Error',
        },
    ]);
});

test('the committed fixture decodes to its declared counts and covers every real shape', () => {
    const data = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const lifecycle = WorkerLifecycle.decodeWorkerLifecycle(data);
    assert.equal(lifecycle.date, '2026-10-29');
    assert.equal(lifecycle.workers.length, data.metadata.workerCount);
    assert.equal(lifecycle.errors.length, data.metadata.errorCount);

    const workers = lifecycle.workers;
    const shapes: [string, boolean][] = [
        ['requested before the day', workers.some(w => w.requestedMs !== null && w.requestedMs < WINDOW.startMs)],
        ['full, with a stop reason', workers.some(w => w.runningMs !== null && w.stoppedMs !== null && w.removedMs !== null && w.stoppedReason !== null)],
        ['full, without a stop reason', workers.some(w => w.runningMs !== null && w.stoppedMs !== null && w.removedMs !== null && w.stoppedReason === null)],
        ['stopped but never removed', workers.some(w => w.runningMs !== null && w.stoppedMs !== null && w.removedMs === null)],
        ['failed to start', workers.some(w => w.runningMs === null && w.stoppedMs !== null && w.removedMs === null)],
        ['failed to start, then removed', workers.some(w => w.runningMs === null && w.stoppedMs !== null && w.removedMs !== null)],
        ['still running', workers.some(w => w.runningMs !== null && w.stoppedMs === null && w.removedMs === null)],
    ];
    for (const [shape, present] of shapes) {
        assert.ok(present, `the fixture has no worker: ${shape}`);
    }
    const kinds = new Set(lifecycle.errors.map(error => `${error.kind}:${error.code === null ? 'no-code' : 'code'}`));
    for (const kind of ['operation-error:code', 'operation-error:no-code', 'arm-deployment-error:code', 'worker-error:no-code', 'creation-error:no-code']) {
        assert.ok(kinds.has(kind), `the fixture has no error: ${kind}`);
    }
});

// --- location threads -----------------------------------------------------

const CATEGORY_BASE = 12;
const STRUCTURAL_CATEGORY = 0;
const IDLE_CATEGORY = 11;
const TID_BASE = 100;
const STATE_ORDER = ['Starting', 'Running a task', 'Waiting for a task', 'Stopping', 'Failed to start'];

interface BuildOptions {
    window?: Window;
    tasks?: TaskRun[];
}

function build(lifecycle: Lifecycle, { window = WINDOW, tasks = [] }: BuildOptions = {}, pool = POOL) {
    const strings: string[] = [];
    const ids = new Map<string, number>();
    const getStringIndex = (value: string): number => {
        let id = ids.get(value);
        if (id === undefined) {
            id = strings.length;
            strings.push(value);
            ids.set(value, id);
        }
        return id;
    };
    const result = WorkerLifecycle.locationThreads(lifecycle, pool, {
        window,
        tasks,
        getStringIndex,
        categoryBase: CATEGORY_BASE,
        structuralCategory: STRUCTURAL_CATEGORY,
        idleCategory: IDLE_CATEGORY,
        tidBase: TID_BASE,
    });
    return { ...result, strings };
}

function threadNamed(threads: Thread[], name: string): Thread {
    const found = threads.find(thread => thread.name === name);
    assert.ok(found, `no thread named ${name}: ${threads.map(thread => thread.name).join(' | ')}`);
    return found;
}

function chartPayloads(thread: Thread, typePrefix: string): Payload[] {
    return thread.markers.data.filter(data => String(data.type).startsWith(typePrefix));
}

function chartName(thread: Thread, strings: string[], typePrefix: string): string {
    const index = thread.markers.data.findIndex(data => String(data.type).startsWith(typePrefix));
    assert.ok(index !== -1, `${thread.name} has no ${typePrefix} chart`);
    return strings[thread.markers.name[index]!]!;
}

function stackNames(thread: Thread, strings: string[], stack: number): string[] {
    const names: string[] = [];
    let current: number | null = stack;
    while (current !== null) {
        const frame = thread.stackTable.frame[current]!;
        names.unshift(strings[thread.funcTable.name[thread.frameTable.func[frame]!]!]!);
        current = thread.stackTable.prefix[current]!;
    }
    return names;
}

// What a worker is doing at an instant, from the raw timestamps and nothing else.
function expectedBand(record: DecodedWorker, at: number): string | null {
    const stops = [record.stoppedMs, record.removedMs].filter((time): time is number => time !== null);
    const retired = stops.length ? Math.min(...stops) : null;
    const end = retired ?? Infinity;
    if (record.stoppedMs !== null && record.removedMs !== null && record.stoppedMs <= record.removedMs && record.stoppedMs <= at && at < record.removedMs) {
        return 'stopping';
    }
    if (record.requestedMs === null) {
        return record.runningMs !== null && at < end ? 'running' : null;
    }
    if (record.runningMs !== null) {
        if (record.requestedMs <= at && at < record.runningMs) {
            return 'starting';
        }
        return record.runningMs <= at && at < end ? 'running' : null;
    }
    if (retired === null) {
        return record.requestedMs <= at ? 'starting' : null;
    }
    return record.requestedMs <= at && at < retired ? 'failedToStart' : null;
}

function expectedState(record: DecodedWorker, at: number, tasks: TaskRun[]): string | null {
    const band = expectedBand(record, at);
    if (band !== 'running') {
        return band;
    }
    const busy = tasks.some(task => task.workerId === record.workerId && task.startMs <= at && at < task.endMs);
    return busy ? 'runningTask' : 'waiting';
}

const BAND_INDEX: Record<string, number> = { running: 0, starting: 1, stopping: 2, failedToStart: 3 };

function expectedBandCounts(workers: DecodedWorker[], at: number, tasks: TaskRun[]): number[] {
    const counts = [0, 0, 0, 0];
    for (const record of workers) {
        const state = expectedState(record, at, tasks);
        if (state === null) {
            continue;
        }
        const band = state === 'runningTask' || state === 'waiting' ? 'running' : state;
        counts[BAND_INDEX[band]!]!++;
    }
    return counts;
}

function zonedWorkers(): DecodedWorker[] {
    const zones: (string | null)[] = ['us-central1-a', 'us-central1-b', 'us-central1-a', 'us-east1-c', 'eastus2', 'us-central1-c', null];
    return syntheticWorkers(140).map((record, i) => ({ ...record, zone: zones[i % zones.length]! }));
}

function bandCounts(payload: Payload): number[] {
    return [0, 1, 2, 3].map(index => Number(payload[`band${index}`] ?? 0));
}

test('a zone is placed under its region and datacenter, Azure has no zone level', () => {
    assert.deepEqual(WorkerLifecycle.locationPath('us-central1-a'), ['Google Cloud', 'us-central1', 'us-central1-a']);
    assert.deepEqual(WorkerLifecycle.locationPath('northamerica-northeast1-b'), ['Google Cloud', 'northamerica-northeast1', 'northamerica-northeast1-b']);
    assert.deepEqual(WorkerLifecycle.locationPath('eastus2'), ['Azure', 'eastus2']);
    assert.deepEqual(WorkerLifecycle.locationPath(null), ['(no location recorded)']);
});

test('the tree runs from all datacenters down to the zones, in a stable order', () => {
    const { threads } = build(lifecycleOf(zonedWorkers()));
    assert.deepEqual(
        threads.map(thread => thread.name),
        [
            'All workers',
            '· Google Cloud',
            '· · us-central1',
            '· · · us-central1-a',
            '· · · us-central1-b',
            '· · · us-central1-c',
            '· · us-east1',
            '· · · us-east1-c',
            '· Azure',
            '· · eastus2',
            '· (no location recorded)',
        ]
    );
    assert.equal(new Set(threads.map(thread => thread.pid)).size, threads.length, 'pids are unique');
    assert.equal(new Set(threads.map(thread => thread.tid)).size, threads.length, 'tids are unique');
    for (const thread of threads) {
        assert.equal(thread.isMainThread, true);
        assert.equal(thread.processName, thread.name);
    }
});

test('a location with no worker and no error in the window has no thread', () => {
    const outside = worker({ workerId: 'old', zone: 'us-west1-a', requestedMs: DAY_START - 5 * HOUR, runningMs: DAY_START - 5 * HOUR + MINUTE, stoppedMs: DAY_START - 4 * HOUR });
    const inside = worker({ workerId: 'new', zone: 'us-central1-a', requestedMs: DAY_START + HOUR, runningMs: DAY_START + HOUR + MINUTE });
    const earlyError: DecodedError = { timeMs: DAY_START - HOUR, pool: POOL, zone: 'asia-east1-a', workerId: null, launchConfigId: null, kind: 'operation-error', code: 'X', title: 'x' };
    const { threads } = build(lifecycleOf([outside, inside], [earlyError]));
    assert.deepEqual(threads.map(thread => thread.name), ['All workers', '· Google Cloud', '· · us-central1', '· · · us-central1-a']);
});

test('a pool with no worker and no error in the window gets no thread at all', () => {
    const theirs = worker({ pool: OTHER_POOL, workerId: 'theirs', requestedMs: DAY_START + HOUR, runningMs: DAY_START + HOUR + MINUTE });
    const result = build(lifecycleOf([theirs]));
    assert.deepEqual(result.threads, []);
    assert.deepEqual(result.schemas, []);
    assert.deepEqual(result.categories, []);
});

test('other pools are ignored', () => {
    const mine = worker({ workerId: 'mine', requestedMs: DAY_START + HOUR, runningMs: DAY_START + HOUR + MINUTE });
    const theirs = worker({ pool: OTHER_POOL, workerId: 'theirs', zone: 'us-east1-b', requestedMs: DAY_START + HOUR, runningMs: DAY_START + HOUR + MINUTE });
    const { threads } = build(lifecycleOf([mine, theirs]));
    assert.ok(!threads.some(thread => thread.name.includes('us-east1')));
});

test('worker counts match an independent count at every bucket, and every parent is the sum of its children', () => {
    const workers = zonedWorkers();
    const { threads, bucketMs } = build(lifecycleOf(workers));
    assert.equal(bucketMs, MINUTE);
    const nodes: [string, (w: DecodedWorker) => boolean][] = [
        ['All workers', () => true],
        ['· Google Cloud', w => w.zone !== null && /-[a-z]$/.test(w.zone)],
        ['· · us-central1', w => w.zone !== null && w.zone.startsWith('us-central1-')],
        ['· · · us-central1-a', w => w.zone === 'us-central1-a'],
        ['· Azure', w => w.zone === 'eastus2'],
        ['· (no location recorded)', w => w.zone === null],
    ];
    for (const [name, member] of nodes) {
        const payloads = chartPayloads(threadNamed(threads, name), 'WorkerStates_');
        assert.equal(payloads.length, 24 * 60, name);
        const members = workers.filter(member);
        payloads.forEach((payload, bucket) => {
            assert.deepEqual(bandCounts(payload), expectedBandCounts(members, WINDOW.startMs + bucket * MINUTE, []), `${name} bucket ${bucket}`);
        });
    }
    const children: Record<string, string[]> = {
        'All workers': ['· Google Cloud', '· Azure', '· (no location recorded)'],
        '· Google Cloud': ['· · us-central1', '· · us-east1'],
        '· · us-central1': ['· · · us-central1-a', '· · · us-central1-b', '· · · us-central1-c'],
    };
    for (const [parent, names] of Object.entries(children)) {
        chartPayloads(threadNamed(threads, parent), 'WorkerStates_').forEach((payload, bucket) => {
            const sums = [0, 0, 0, 0];
            for (const name of names) {
                bandCounts(chartPayloads(threadNamed(threads, name), 'WorkerStates_')[bucket]!).forEach((count, index) => {
                    sums[index]! += count;
                });
            }
            assert.deepEqual(bandCounts(payload), sums, `${parent} bucket ${bucket}`);
        });
    }
});

test('the track name carries the peak, because each track is scaled to its own maximum', () => {
    const workers = zonedWorkers();
    const { threads, strings } = build(lifecycleOf(workers));
    const peakOf = (members: DecodedWorker[]) =>
        Math.max(...Array.from({ length: 24 * 60 }, (_, bucket) => expectedBandCounts(members, WINDOW.startMs + bucket * MINUTE, []).reduce((a, b) => a + b, 0)));
    assert.equal(chartName(threadNamed(threads, 'All workers'), strings, 'WorkerStates_'), `Workers · max ${peakOf(workers)}`);
    const zoneA = workers.filter(w => w.zone === 'us-central1-a');
    assert.equal(chartName(threadNamed(threads, '· · · us-central1-a'), strings, 'WorkerStates_'), `Workers · max ${peakOf(zoneA)}`);
});

test('running splits into running a task and waiting by the tasks the worker claimed', () => {
    const record = worker({ workerId: 'busy', requestedMs: DAY_START + HOUR, runningMs: DAY_START + HOUR + 10 * MINUTE });
    const tasks: TaskRun[] = [
        { workerId: 'busy', startMs: DAY_START + HOUR + 20 * MINUTE, endMs: DAY_START + HOUR + 30 * MINUTE, taskId: 't1', state: 'completed', color: 'green' },
        { workerId: 'busy', startMs: DAY_START + HOUR + 25 * MINUTE, endMs: DAY_START + HOUR + 40 * MINUTE, taskId: 't2', state: 'failed', color: 'red' },
        { workerId: 'someone-else', startMs: DAY_START + HOUR + 12 * MINUTE, endMs: DAY_START + HOUR + 50 * MINUTE, taskId: 't3', state: 'completed', color: 'green' },
    ];
    const { threads, strings } = build(lifecycleOf([record]), { tasks });
    const zone = threadNamed(threads, '· · · us-central1-a');
    const weightByState = new Map<string, number>();
    zone.samples.stack.forEach((stack, index) => {
        const state = stackNames(zone, strings, stack).at(-1)!;
        weightByState.set(state, (weightByState.get(state) ?? 0) + zone.samples.weight[index]!);
    });
    assert.equal(weightByState.get('Starting'), 10 * MINUTE);
    assert.equal(weightByState.get('Running a task'), 20 * MINUTE, 'two overlapping runs are 20 minutes of busy time, not 25');
    const runningEnd = WINDOW.endMs - (DAY_START + HOUR + 10 * MINUTE);
    assert.equal(weightByState.get('Waiting for a task'), runningEnd - 20 * MINUTE);
});

test('call tree totals are worker time, and a parent carries the locations below it', () => {
    const workers = zonedWorkers();
    const { threads, strings } = build(lifecycleOf(workers));
    const weightByPath = (thread: Thread) => {
        const totals = new Map<string, number>();
        thread.samples.stack.forEach((stack, index) => {
            const key = stackNames(thread, strings, stack).join(' > ');
            totals.set(key, (totals.get(key) ?? 0) + thread.samples.weight[index]!);
        });
        return totals;
    };
    const root = weightByPath(threadNamed(threads, 'All workers'));
    const zoneA = weightByPath(threadNamed(threads, '· · · us-central1-a'));
    const region = weightByPath(threadNamed(threads, '· · us-central1'));
    for (const [state, weight] of zoneA) {
        assert.equal(region.get(`us-central1-a > ${state}`), weight, state);
        assert.equal(root.get(`Google Cloud > us-central1 > us-central1-a > ${state}`), weight, state);
    }
    const zoneAWorkers = workers.filter(w => w.zone === 'us-central1-a');
    const expectedRunning = Array.from({ length: 24 * 60 }, (_, bucket) => expectedBandCounts(zoneAWorkers, WINDOW.startMs + bucket * MINUTE, [])[0]!).reduce((a, b) => a + b, 0) * MINUTE;
    assert.equal(zoneA.get('Waiting for a task'), expectedRunning, 'with no tasks, every running worker is waiting');
    assert.ok(!zoneA.has('Running a task'));
});

test('samples are in order, inside the window, and every stack and category exists', () => {
    const { threads, strings } = build(lifecycleOf(zonedWorkers()));
    for (const thread of threads) {
        const { samples } = thread;
        assert.ok(samples.length > 0, thread.name);
        assert.equal(samples.stack.length, samples.length);
        assert.equal(samples.time.length, samples.length);
        assert.equal(samples.weight.length, samples.length);
        assert.equal(samples.threadCPUDelta.length, samples.length);
        for (let i = 0; i < samples.length; i++) {
            if (i > 0) {
                assert.ok(samples.time[i]! > samples.time[i - 1]!, `${thread.name} sample ${i} is not after the previous one`);
            }
            assert.ok(samples.time[i]! <= 24 * HOUR, `${thread.name} sample ${i} is past the window`);
            assert.ok(samples.weight[i]! >= 0);
            assert.ok(samples.threadCPUDelta[i]! >= 0);
            assert.ok(samples.stack[i]! >= 0 && samples.stack[i]! < thread.stackTable.length);
        }
        for (const category of thread.stackTable.category) {
            assert.ok(category === STRUCTURAL_CATEGORY || category === IDLE_CATEGORY || (category >= CATEGORY_BASE && category < CATEGORY_BASE + STATE_ORDER.length), `${thread.name} category ${category}`);
        }
        thread.funcTable.name.forEach(nameIndex => assert.ok(nameIndex >= 0 && nameIndex < strings.length));
    }
});

test('the activity strip is scaled to the pool peak, so a zone reads smaller than the whole pool', () => {
    const { threads, peakWorkers } = build(lifecycleOf(zonedWorkers()));
    const heightsOf = (thread: Thread) => {
        const heights = new Map<number, number>();
        const { samples } = thread;
        for (let i = 0; i < samples.length; i++) {
            const bucket = Math.min(Math.floor((samples.time[i]! - 1e-6) / MINUTE), 24 * 60 - 1);
            const span = samples.time[i]! - (i > 0 ? samples.time[i - 1]! : 0);
            heights.set(bucket, samples.weight[i] === 0 ? 0 : samples.threadCPUDelta[i]! / (1000 * span));
        }
        return heights;
    };
    const root = heightsOf(threadNamed(threads, 'All workers'));
    const zone = heightsOf(threadNamed(threads, '· · · us-central1-b'));
    assert.ok(Math.abs(Math.max(...root.values()) - 1) < 0.01, 'the busiest moment of the pool is full height');
    let compared = 0;
    for (const [bucket, height] of zone) {
        if (height > 0 && root.get(bucket)! > 0) {
            assert.ok(height <= root.get(bucket)! + 0.01, `bucket ${bucket}`);
            compared++;
        }
    }
    assert.ok(compared > 100);
    assert.ok(peakWorkers >= 1);
});

test('every location lists the lanes of the workers below it', () => {
    const workers = zonedWorkers();
    const withPhases = workers.filter(record => WorkerLifecycle.workerPhases(record, WINDOW).length > 0);
    const { threads, strings } = build(lifecycleOf(workers));
    const below: Record<string, (zone: string | null) => boolean> = {
        'All workers': () => true,
        '· Google Cloud': zone => zone !== null && zone.startsWith('us-'),
        '· · us-central1': zone => zone !== null && zone.startsWith('us-central1-'),
        '· · · us-central1-a': zone => zone === 'us-central1-a',
        '· · · us-central1-b': zone => zone === 'us-central1-b',
        '· · · us-central1-c': zone => zone === 'us-central1-c',
        '· · · us-east1-c': zone => zone === 'us-east1-c',
        '· · us-east1': zone => zone !== null && zone.startsWith('us-east1-'),
        '· Azure': zone => zone === 'eastus2',
        '· · eastus2': zone => zone === 'eastus2',
        '· (no location recorded)': zone => zone === null,
    };
    for (const thread of threads) {
        const belongs = below[thread.name];
        assert.ok(belongs, `unexpected thread ${thread.name}`);
        const expected = withPhases.filter(record => belongs(record.zone));
        const laneIds = thread.markers.data.flatMap((data, index) =>
            data.type === 'Worker' || data.type === 'WorkerTask' ? [strings[thread.markers.name[index]!]!.replace(/^\d+ · /, '')] : []
        );
        assert.deepEqual([...new Set(laneIds)].sort(), expected.map(record => record.workerId!).sort(), `${thread.name} lanes`);
    }
});

test('a worker is one line: starting, then its tasks with waiting between them, then stopping, in the order workers first appear', () => {
    const workers = zonedWorkers();
    const eligible = workers.filter(
        record =>
            record.requestedMs !== null &&
            record.runningMs !== null &&
            record.runningMs >= WINDOW.startMs &&
            record.runningMs + 10 * MINUTE < WINDOW.endMs &&
            [record.stoppedMs, record.removedMs].every(time => time === null || time > record.runningMs! + 10 * MINUTE)
    );
    const tasks: TaskRun[] = eligible.slice(0, 20).flatMap((record, i) => [
        { workerId: record.workerId!, startMs: record.runningMs! + MINUTE, endMs: record.runningMs! + 4 * MINUTE, taskId: `first-${i}`, state: 'completed', color: 'green' },
        { workerId: record.workerId!, startMs: record.runningMs! + 6 * MINUTE, endMs: record.runningMs! + 8 * MINUTE, taskId: `second-${i}`, state: 'failed', color: 'red' },
    ]);
    const { threads, strings } = build(lifecycleOf(workers), { tasks });
    const root = threadNamed(threads, 'All workers');
    const lanes = new Map<string, { type: string; state: string; start: number; end: number }[]>();
    root.markers.data.forEach((data, index) => {
        if (data.type !== 'Worker' && data.type !== 'WorkerTask') {
            return;
        }
        const name = strings[root.markers.name[index]!]!;
        const state = strings[data.state as number]!;
        lanes.set(name, [...(lanes.get(name) ?? []), { type: String(data.type), state, start: root.markers.startTime[index]!, end: root.markers.endTime[index]! }]);
    });

    const withPhases = workers.filter(record => WorkerLifecycle.workerPhases(record, WINDOW).length > 0);
    assert.equal(lanes.size, withPhases.length, 'one lane per worker');
    for (const name of lanes.keys()) {
        assert.match(name, /^\d+ · /);
    }

    for (const [name, markers] of lanes) {
        const ordered = markers.slice().sort((a, b) => a.start - b.start);
        ordered.slice(1).forEach((marker, i) => assert.ok(marker.start >= ordered[i]!.end, `${name}: ${marker.state} overlaps ${ordered[i]!.state}`));
    }

    const firstStarts = [...lanes.keys()].sort().map(name => Math.min(...lanes.get(name)!.map(marker => marker.start)));
    firstStarts.slice(1).forEach((start, i) => assert.ok(start >= firstStarts[i]!, 'lanes sort by first appearance'));

    const laneOf = (workerId: string) => [...lanes].find(([name]) => name.endsWith(` · ${workerId}`))![1].slice().sort((a, b) => a.start - b.start);
    for (const record of eligible.slice(0, 20)) {
        const lane = laneOf(record.workerId!);
        const at = (ms: number) => ms - WINDOW.startMs;
        const retiredAt = Math.min(...[record.stoppedMs, record.removedMs].filter((time): time is number => time !== null), Infinity);
        const stops = record.stoppedMs !== null && record.removedMs !== null && record.stoppedMs <= record.removedMs && record.stoppedMs < WINDOW.endMs;
        const startingFrom = Math.max(record.requestedMs!, WINDOW.startMs);
        assert.deepEqual(
            lane.map(marker => [marker.state, marker.start, marker.end]),
            [
                ...(record.runningMs! > startingFrom ? [['Starting', at(startingFrom), at(record.runningMs!)]] : []),
                ['Waiting for a task', at(record.runningMs!), at(record.runningMs! + MINUTE)],
                ['completed', at(record.runningMs! + MINUTE), at(record.runningMs! + 4 * MINUTE)],
                ['Waiting for a task', at(record.runningMs! + 4 * MINUTE), at(record.runningMs! + 6 * MINUTE)],
                ['failed', at(record.runningMs! + 6 * MINUTE), at(record.runningMs! + 8 * MINUTE)],
                ['Waiting for a task', at(record.runningMs! + 8 * MINUTE), at(Math.min(retiredAt, WINDOW.endMs))],
                ...(stops ? [['Stopping', at(record.stoppedMs!), at(Math.min(record.removedMs!, WINDOW.endMs))]] : []),
            ],
            `lane of ${record.workerId}`
        );
    }
});

test('a running worker with no task is waiting for the whole time, and a task outside its running time is not drawn', () => {
    const idle = worker({ workerId: 'idle', zone: 'us-central1-a', requestedMs: DAY_START + HOUR, runningMs: DAY_START + HOUR + MINUTE, stoppedMs: DAY_START + 2 * HOUR, removedMs: null });
    const elsewhere: TaskRun = { workerId: 'idle', startMs: DAY_START + 3 * HOUR, endMs: DAY_START + 3 * HOUR + MINUTE, taskId: 'late', state: 'completed', color: 'green' };
    const { threads, strings } = build(lifecycleOf([idle]), { tasks: [elsewhere] });
    const root = threadNamed(threads, 'All workers');
    const states = root.markers.data.flatMap((data, index) =>
        data.type === 'Worker' || data.type === 'WorkerTask' ? [[strings[data.state as number], root.markers.startTime[index], root.markers.endTime[index]]] : []
    );
    assert.deepEqual(states, [
        ['Starting', HOUR, HOUR + MINUTE],
        ['Waiting for a task', HOUR + MINUTE, 2 * HOUR],
    ]);
});

test('worker states use the Taskcluster UI colours in the categories, the bands and the lanes', () => {
    const { categories } = build(lifecycleOf(zonedWorkers()));
    const colorOf = (name: string) => categories.find(category => category.name === name)?.color;
    assert.equal(colorOf('Worker starting'), 'grey');
    assert.equal(colorOf('Worker running a task'), 'blue');
    assert.equal(colorOf('Worker waiting'), 'lightblue');
    assert.equal(colorOf('Worker stopping'), 'orange');
    assert.equal(colorOf('Worker failed to start'), 'red');
    const { threads, strings } = build(lifecycleOf(zonedWorkers()));
    const phaseColors = new Map<string, string>();
    for (const data of threads.flatMap(thread => thread.markers.data)) {
        if (data.type === 'Worker') {
            phaseColors.set(strings[data.state as number]!, data.color as string);
        }
    }
    for (const [state, color] of [['Starting', 'grey'], ['Waiting for a task', 'blue'], ['Stopping', 'orange'], ['Failed to start', 'red']]) {
        if (phaseColors.has(state!)) {
            assert.equal(phaseColors.get(state!), color, state);
        }
    }
    assert.ok(phaseColors.size >= 3, 'the fixture exercises most states');
});

test('errors in one minute, place and code collapse into one marker that counts them', () => {
    const at = DAY_START + 3 * HOUR + 7 * MINUTE;
    const error = (timeMs: number, zone: string | null, code: string | null): DecodedError => ({
        timeMs,
        pool: POOL,
        zone,
        workerId: 'w-1',
        launchConfigId: 'lc-1',
        kind: 'operation-error',
        code,
        title: 'Zone exhausted',
    });
    const errors = [
        ...Array.from({ length: 92 }, (_, i) => error(at + i * 100, 'us-central1-a', 'ZONE_RESOURCE_POOL_EXHAUSTED')),
        error(at + 2 * MINUTE, 'us-central1-a', 'ZONE_RESOURCE_POOL_EXHAUSTED'),
        ...Array.from({ length: 17 }, (_, i) => error(at + i * 100, 'us-central1-b', 'ZONE_RESOURCE_POOL_EXHAUSTED')),
        error(at, 'us-central1-a', null),
        error(at, null, 'X'),
        error(DAY_START - MINUTE, 'us-central1-a', 'BEFORE'),
        error(WINDOW.endMs, 'us-central1-a', 'AFTER'),
    ];
    const { threads, strings } = build(lifecycleOf([], errors));
    const zoneA = threadNamed(threads, '· · · us-central1-a');
    const markers = zoneA.markers.data.flatMap((data, index) => (data.type === 'PoolErrors' ? [{ data, index }] : []));
    assert.deepEqual(
        markers.map(({ data }) => [data.count, strings[Number(data.code)]]),
        [[92, 'ZONE_RESOURCE_POOL_EXHAUSTED'], [1, '(no code)'], [1, 'ZONE_RESOURCE_POOL_EXHAUSTED']],
        'minute 7 has the burst and the no-code error, minute 9 one more'
    );
    const first = markers[0]!.index;
    assert.equal(zoneA.markers.startTime[first], 3 * HOUR + 7 * MINUTE);
    assert.equal(zoneA.markers.endTime[first], 3 * HOUR + 8 * MINUTE);
    assert.equal(strings[zoneA.markers.name[first]!], 'errors us-central1-a');

    const root = threadNamed(threads, 'All workers');
    const rootCount = root.markers.data.filter(data => data.type === 'PoolErrors').reduce((sum, data) => sum + Number(data.count), 0);
    assert.equal(rootCount, 92 + 1 + 17 + 1 + 1, 'the root counts every error in the window, and none outside it');
    assert.ok(threads.some(thread => thread.name === '· (no location recorded)'));
});

test('errors per minute add up from the zones to the region and the root, and no chart splits them by child', () => {
    const at = DAY_START + 5 * HOUR;
    const make = (offsetMs: number, zone: string): DecodedError => ({ timeMs: at + offsetMs, pool: POOL, zone, workerId: null, launchConfigId: null, kind: 'operation-error', code: 'C', title: 't' });
    const errors = [make(0, 'us-central1-a'), make(10 * SECOND, 'us-central1-a'), make(5 * MINUTE, 'us-central1-b'), make(5 * MINUTE + SECOND, 'us-central1-a'), make(9 * MINUTE, 'us-east1-c')];
    const { threads, strings } = build(lifecycleOf([], errors));
    const minuteOf = (offset: number) => 5 * 60 + offset;
    const perMinute = (name: string) => chartPayloads(threadNamed(threads, name), 'WorkerErrors_').map(payload => Number(payload.band0));
    const root = perMinute('All workers');
    assert.equal(root[minuteOf(0)], 2);
    assert.equal(root[minuteOf(5)], 2);
    assert.equal(root[minuteOf(9)], 1);
    assert.equal(root.reduce((a, b) => a + b, 0), errors.length);
    const region = perMinute('· · us-central1');
    assert.equal(region[minuteOf(5)], 2);
    assert.equal(region.reduce((a, b) => a + b, 0), 4);
    assert.equal(perMinute('· · · us-central1-b')[minuteOf(5)], 1);

    for (const thread of threads) {
        assert.equal(chartPayloads(thread, 'WorkerErrorsBy_').length, 0, `${thread.name} has no breakdown chart`);
    }
    assert.equal(chartName(threadNamed(threads, 'All workers'), strings, 'WorkerErrors_'), 'Errors/min · max 2');
});

test('a location that only has errors gets no worker chart', () => {
    const inside = worker({ workerId: 'w', zone: 'us-central1-a', requestedMs: DAY_START + HOUR, runningMs: DAY_START + HOUR + MINUTE });
    const unlocated: DecodedError = { timeMs: DAY_START + 2 * HOUR, pool: POOL, zone: null, workerId: null, launchConfigId: null, kind: 'operation-error', code: 'X', title: 'x' };
    const { threads } = build(lifecycleOf([inside], [unlocated]));
    const noLocation = threadNamed(threads, '· (no location recorded)');
    assert.equal(chartPayloads(noLocation, 'WorkerStates_').length, 0);
    assert.equal(chartPayloads(noLocation, 'WorkerErrors_').length, 24 * 60);
    assert.ok(chartPayloads(threadNamed(threads, 'All workers'), 'WorkerStates_').length > 0);
});

test('the retirement chart is on the whole pool only', () => {
    const { threads } = build(lifecycleOf(syntheticWorkers(60)));
    assert.ok(chartPayloads(threads[0]!, 'StopReasons').length > 0);
    for (const thread of threads.slice(1)) {
        assert.equal(chartPayloads(thread, 'StopReasons').length, 0, thread.name);
    }
});

test('every payload key is allowed, every type names a schema, every string index is inside the table', () => {
    const data = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const lifecycle = WorkerLifecycle.decodeWorkerLifecycle(data);
    const pools = [...new Set(lifecycle.workers.map(w => w.pool))];
    for (const pool of pools) {
        const poolWorkers = lifecycle.workers.filter(worker => worker.pool === pool && worker.workerId !== null);
        const tasks: TaskRun[] = poolWorkers.map((worker, i) => ({
            workerId: worker.workerId,
            startMs: DAY_START + (i % 20) * HOUR,
            endMs: DAY_START + (i % 20) * HOUR + 5 * MINUTE,
            taskId: `task-${i}`,
            state: 'completed',
            color: 'green',
        }));
        const { threads, schemas, strings, categories } = build(lifecycle, { tasks }, pool);
        const fieldsByType = new Map(schemas.map(schema => [schema.name, schema.fields]));
        const inside = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) < strings.length;
        for (const thread of threads) {
            thread.markers.name.forEach(nameIndex => assert.ok(inside(nameIndex), `marker name ${nameIndex}`));
            thread.markers.category.forEach(category => assert.ok(category === 0 || (category >= CATEGORY_BASE && category < CATEGORY_BASE + categories.length), `marker category ${category}`));
            for (const payload of thread.markers.data) {
                assert.ok(fieldsByType.has(String(payload.type)), `unknown marker type ${String(payload.type)}`);
                for (const key of Object.keys(payload)) {
                    assert.ok(!RESERVED_KEYS.includes(key), `reserved key ${key} in ${String(payload.type)}`);
                }
                for (const field of fieldsByType.get(String(payload.type)) ?? []) {
                    if (field.format === 'unique-string' && payload[field.key] !== undefined) {
                        assert.ok(inside(payload[field.key]), `${String(payload.type)}.${field.key}`);
                    }
                }
            }
        }
        assert.equal(new Set(schemas.map(schema => schema.name)).size, schemas.length, 'schema names are unique');
    }
    assert.ok(pools.length > 1);
});

test('the categories to append are named, and the track order follows the tree', () => {
    const { categories } = build(lifecycleOf(zonedWorkers()));
    assert.deepEqual(
        categories.map(category => category.name),
        ['Worker starting', 'Worker running a task', 'Worker waiting', 'Worker stopping', 'Worker failed to start', 'Worker lanes', 'Worker errors']
    );
    assert.equal(WorkerLifecycle.threadOrderParam(4), '0-1-2-3');
    assert.equal(WorkerLifecycle.threadOrderParam(1), '0');
});

test('the profiler query gives the thread order, because a profile sent by postMessage ignores globalTrackOrder', () => {
    assert.equal(WorkerLifecycle.profilerQuery(4), '?threadOrder=0-1-2-3');
    assert.equal(WorkerLifecycle.profilerQuery(1), '');
});

// --- helpers for the thread tests -----------------------------------------

function syntheticWorkers(count: number): DecodedWorker[] {
    const reasons: (string | null)[] = [
        'instance not found',
        'workerManager.removeWorker API call',
        null,
        'terminateAfter time exceeded',
        'something nobody has seen before',
        'vm not found in state running',
        'failed power state; x',
    ];
    return Array.from({ length: count }, (_, i) => {
        const jitter = (i * 3137) % 9001;
        const base = DAY_START + ((i * 7919 * MINUTE) % (20 * HOUR)) + jitter;
        const requested = i % 10 === 0 ? DAY_START - (1 + (i % 3)) * HOUR : base;
        const running = i % 5 === 0 ? null : base + (60 + (i % 7) * 30) * SECOND;
        const stopped = i % 6 === 0 ? null : base + HOUR * (1 + (i % 9)) + 5 * MINUTE * (i % 4);
        const removed = i % 3 === 0 || stopped === null ? null : stopped + 10 * SECOND * (i % 5);
        return worker({
            workerId: `w-${i}`,
            requestedMs: i % 17 === 0 ? null : requested,
            runningMs: running,
            stoppedMs: stopped,
            removedMs: removed,
            stoppedReason: stopped === null ? null : reasons[i % reasons.length]!,
            removedReason: removed === null ? null : reasons[(i + 2) % reasons.length]!,
        });
    });
}
