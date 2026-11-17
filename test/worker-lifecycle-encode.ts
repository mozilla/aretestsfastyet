/**
 * Encodes the worker lifecycle query's rows into `workers-<date>-lifecycle.json`.
 *
 * The producer in mozilla-central (`testing/workers/fetch-worker-data.js`) carries
 * this layout. `worker-lifecycle.js` decodes it. The fixture generator and the
 * round-trip test use this module, so a change to the layout fails here first.
 *
 * Times are epoch milliseconds. Each worker's first event is stored as a
 * difference from the previous worker's first event, and its other events as
 * offsets from that first event. `null` marks an event that did not happen.
 */

export interface LifecycleRow {
    row_type: 'worker' | 'error';
    worker_pool_id: string;
    worker_group: string | null;
    worker_id: string | null;
    launch_config_id: string | null;
    capacity: number | null;
    requested: number | null;
    running: number | null;
    stopped: number | null;
    stopped_reason: string | null;
    removed: number | null;
    removed_reason: string | null;
    error_time: number | null;
    error_kind: string | null;
    error_code: string | null;
    error_title: string | null;
}

export interface LifecycleArtifact {
    metadata: { date: string; generatedAt: string; workerCount: number; errorCount: number };
    tables: {
        pools: string[];
        zones: string[];
        launchConfigs: string[];
        workerIds: string[];
        reasons: string[];
        errorKinds: string[];
        errorCodes: string[];
        errorTitles: string[];
    };
    workers: {
        firstMs: number[];
        requestedMs: (number | null)[];
        runningMs: (number | null)[];
        stoppedMs: (number | null)[];
        removedMs: (number | null)[];
        capacities: (number | null)[];
        poolIds: number[];
        zoneIds: (number | null)[];
        launchConfigIds: (number | null)[];
        workerIdIds: (number | null)[];
        stoppedReasonIds: (number | null)[];
        removedReasonIds: (number | null)[];
    };
    errors: {
        timeMs: number[];
        poolIds: number[];
        zoneIds: (number | null)[];
        workerIdIds: (number | null)[];
        launchConfigIds: (number | null)[];
        kindIds: (number | null)[];
        codeIds: (number | null)[];
        titleIds: (number | null)[];
    };
}

interface Interned {
    table: string[];
    id(value: string | null): number | null;
}

interface WorkerRecord {
    pool: string;
    zone: string | null;
    launchConfigId: string | null;
    workerId: string | null;
    capacity: number | null;
    requested: number | null;
    running: number | null;
    stopped: number | null;
    stoppedReason: string | null;
    removed: number | null;
    removedReason: string | null;
    firstMs: number;
}

interface ErrorRecord {
    timeMs: number;
    pool: string;
    zone: string | null;
    workerId: string | null;
    launchConfigId: string | null;
    kind: string | null;
    code: string | null;
    title: string | null;
}

function intern(values: ReadonlyArray<string | null>): Interned {
    const counts = new Map<string, number>();
    for (const value of values) {
        if (value !== null) {
            counts.set(value, (counts.get(value) ?? 0) + 1);
        }
    }
    const table = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b));
    const positions = new Map(table.map((value, index) => [value, index]));
    return {
        table,
        id: value => (value === null ? null : positions.get(value)!),
    };
}

function differences(values: number[]): number[] {
    return values.map((value, index) => (index === 0 ? value : value - values[index - 1]!));
}

function offsets(times: (number | null)[], bases: number[]): (number | null)[] {
    return times.map((time, index) => (time === null ? null : time - bases[index]!));
}

function firstEvent(times: (number | null)[]): number {
    const present = times.filter((time): time is number => time !== null);
    if (present.length === 0) {
        throw new Error('a worker row has no lifecycle event');
    }
    return Math.min(...present);
}

function workerRecord(row: LifecycleRow): WorkerRecord {
    const requested = row.requested === null ? null : Number(row.requested);
    const running = row.running === null ? null : Number(row.running);
    const stopped = row.stopped === null ? null : Number(row.stopped);
    const removed = row.removed === null ? null : Number(row.removed);
    return {
        pool: row.worker_pool_id,
        zone: row.worker_group,
        launchConfigId: row.launch_config_id,
        workerId: row.worker_id,
        capacity: row.capacity,
        requested,
        running,
        stopped,
        stoppedReason: row.stopped_reason,
        removed,
        removedReason: row.removed_reason,
        firstMs: firstEvent([requested, running, stopped, removed]),
    };
}

function errorRecord(row: LifecycleRow): ErrorRecord {
    if (row.error_time === null) {
        throw new Error('a pool error row has no time');
    }
    return {
        timeMs: Number(row.error_time),
        pool: row.worker_pool_id,
        zone: row.worker_group,
        workerId: row.worker_id,
        launchConfigId: row.launch_config_id,
        kind: row.error_kind,
        code: row.error_code,
        title: row.error_title,
    };
}

export function encodeWorkerLifecycle(rows: LifecycleRow[], date: string, generatedAt: string): LifecycleArtifact {
    const workers = rows
        .filter(row => row.row_type === 'worker')
        .map(workerRecord)
        .sort((a, b) => a.firstMs - b.firstMs || (a.workerId ?? '').localeCompare(b.workerId ?? ''));
    const errors = rows
        .filter(row => row.row_type === 'error')
        .map(errorRecord)
        .sort((a, b) => a.timeMs - b.timeMs);

    const pools = intern([...workers.map(worker => worker.pool), ...errors.map(error => error.pool)]);
    const zones = intern([...workers.map(worker => worker.zone), ...errors.map(error => error.zone)]);
    const launchConfigs = intern([
        ...workers.map(worker => worker.launchConfigId),
        ...errors.map(error => error.launchConfigId),
    ]);
    const workerIds = intern([...workers.map(worker => worker.workerId), ...errors.map(error => error.workerId)]);
    const reasons = intern([
        ...workers.map(worker => worker.stoppedReason),
        ...workers.map(worker => worker.removedReason),
    ]);
    const errorKinds = intern(errors.map(error => error.kind));
    const errorCodes = intern(errors.map(error => error.code));
    const errorTitles = intern(errors.map(error => error.title));

    const firsts = workers.map(worker => worker.firstMs);
    const errorTimes = errors.map(error => error.timeMs);

    return {
        metadata: { date, generatedAt, workerCount: workers.length, errorCount: errors.length },
        tables: {
            pools: pools.table,
            zones: zones.table,
            launchConfigs: launchConfigs.table,
            workerIds: workerIds.table,
            reasons: reasons.table,
            errorKinds: errorKinds.table,
            errorCodes: errorCodes.table,
            errorTitles: errorTitles.table,
        },
        workers: {
            firstMs: differences(firsts),
            requestedMs: offsets(workers.map(worker => worker.requested), firsts),
            runningMs: offsets(workers.map(worker => worker.running), firsts),
            stoppedMs: offsets(workers.map(worker => worker.stopped), firsts),
            removedMs: offsets(workers.map(worker => worker.removed), firsts),
            capacities: workers.map(worker => worker.capacity),
            poolIds: workers.map(worker => pools.id(worker.pool)!),
            zoneIds: workers.map(worker => zones.id(worker.zone)),
            launchConfigIds: workers.map(worker => launchConfigs.id(worker.launchConfigId)),
            workerIdIds: workers.map(worker => workerIds.id(worker.workerId)),
            stoppedReasonIds: workers.map(worker => reasons.id(worker.stoppedReason)),
            removedReasonIds: workers.map(worker => reasons.id(worker.removedReason)),
        },
        errors: {
            timeMs: differences(errorTimes),
            poolIds: errors.map(error => pools.id(error.pool)!),
            zoneIds: errors.map(error => zones.id(error.zone)),
            workerIdIds: errors.map(error => workerIds.id(error.workerId)),
            launchConfigIds: errors.map(error => launchConfigs.id(error.launchConfigId)),
            kindIds: errors.map(error => errorKinds.id(error.kind)),
            codeIds: errors.map(error => errorCodes.id(error.code)),
            titleIds: errors.map(error => errorTitles.id(error.title)),
        },
    };
}
