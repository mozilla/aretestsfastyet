/**
 * Builds `test/fixtures/worker-lifecycle.json` from real rows of STMO query 130614.
 *
 * Not a test: the name does not end in `.test.ts`. The fixture is cut from real
 * output, never written by hand, because the lifecycle shapes are easy to get
 * wrong on paper. Each quota below names a shape the real day contains, and the
 * script throws when a quota cannot be met rather than emitting fewer rows.
 *
 * The shapes the real day lacks (a worker with no request, a removal with no
 * stop) are exercised by inline cases in `test/worker-lifecycle.test.ts`, not by
 * this fixture.
 *
 * Usage: node --experimental-strip-types test/worker-lifecycle-fixture-gen.ts <results.json>
 * where results.json is
 * https://sql.telemetry.mozilla.org/api/queries/130614/results.json?api_key=<the query's key>
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { encodeWorkerLifecycle, type LifecycleRow } from './worker-lifecycle-encode.ts';

interface ResultFile {
    query_result: { retrieved_at: string; data: { rows: LifecycleRow[] } };
}

const OUT = new URL('./fixtures/worker-lifecycle.json', import.meta.url);
const DAY_MS = 24 * 60 * 60 * 1000;

const POOLS = [
    'gecko-t/t-linux-docker-noscratch-amd',
    'gecko-t/t-linux-docker-amd',
    'gecko-3/b-linux-medium',
];

// Workers requested before the day, so the window clipping runs on real rows.
// Taken from any pool: the three chosen pools have one or two of them.
const CARRIED_OVER_QUOTA = 4;

const POOL_QUOTAS: ReadonlyArray<readonly [string, number]> = [
    ['full', 4],
    ['full-without-reason', 3],
    ['stopped-only', 3],
    ['failed-to-start', 2],
];

// Shapes that exist only in some pools, so taken from any pool.
const ANY_POOL_QUOTAS: ReadonlyArray<readonly [string, number]> = [
    ['still-running', 4],
    ['failed-and-removed', 3],
];

interface ErrorQuota {
    kind: string;
    withCode: boolean;
    count: number;
}

const ERROR_QUOTAS: ReadonlyArray<ErrorQuota> = [
    { kind: 'operation-error', withCode: true, count: 2 },
    { kind: 'operation-error', withCode: false, count: 1 },
    { kind: 'arm-deployment-error', withCode: true, count: 1 },
    { kind: 'worker-error', withCode: false, count: 1 },
    { kind: 'creation-error', withCode: false, count: 1 },
];

function shapeOf(row: LifecycleRow): string {
    const running = row.running !== null;
    const stopped = row.stopped !== null;
    const removed = row.removed !== null;
    if (running && stopped && removed) {
        return row.stopped_reason === null ? 'full-without-reason' : 'full';
    }
    if (running && stopped) {
        return 'stopped-only';
    }
    if (!running && stopped && !removed) {
        return 'failed-to-start';
    }
    if (!running && stopped && removed) {
        return 'failed-and-removed';
    }
    if (running && !stopped && !removed) {
        return 'still-running';
    }
    return 'other';
}

function matchesShape(kind: string, row: LifecycleRow, dayStart: number): boolean {
    if (kind === 'carried-over') {
        return row.requested !== null && row.requested < dayStart;
    }
    return shapeOf(row) === kind;
}

function pickWorkers(
    candidates: LifecycleRow[],
    predicate: (row: LifecycleRow) => boolean,
    count: number,
    taken: Set<string>,
    label: string
): LifecycleRow[] {
    const picked: LifecycleRow[] = [];
    for (const row of candidates) {
        if (picked.length === count) {
            break;
        }
        if (!row.worker_id || taken.has(row.worker_id) || !predicate(row)) {
            continue;
        }
        taken.add(row.worker_id);
        picked.push(row);
    }
    if (picked.length !== count) {
        throw new Error(`${label}: wanted ${count} rows, the query has ${picked.length}`);
    }
    return picked;
}

function pickErrors(candidates: LifecycleRow[], quota: ErrorQuota): LifecycleRow[] {
    const matching = candidates.filter(
        row => row.error_kind === quota.kind && (row.error_code !== null) === quota.withCode
    );
    if (matching.length < quota.count) {
        throw new Error(`${quota.kind} (code ${quota.withCode}): wanted ${quota.count}, the query has ${matching.length}`);
    }
    return matching.slice(0, quota.count);
}

const inputPath = process.argv[2];
if (!inputPath) {
    throw new Error('usage: worker-lifecycle-fixture-gen.ts <results.json>');
}
const result: ResultFile = JSON.parse(readFileSync(inputPath, 'utf8'));
const { retrieved_at: retrievedAt, data } = result.query_result;
const rows = data.rows;
const date = new Date(Date.parse(retrievedAt) - DAY_MS).toISOString().slice(0, 10);
const dayStart = Date.parse(`${date}T00:00:00Z`);

const byWorkerId = (a: LifecycleRow, b: LifecycleRow) => (a.worker_id ?? '').localeCompare(b.worker_id ?? '');
const workers = rows.filter(row => row.row_type === 'worker').sort(byWorkerId);
const errors = rows.filter(row => row.row_type === 'error').sort((a, b) => (a.error_time ?? 0) - (b.error_time ?? 0));

const taken = new Set<string>();
const pickedWorkers: LifecycleRow[] = pickWorkers(
    workers,
    row => matchesShape('carried-over', row, dayStart),
    CARRIED_OVER_QUOTA,
    taken,
    'carried-over'
);
for (const pool of POOLS) {
    for (const [kind, count] of POOL_QUOTAS) {
        const candidates = workers.filter(row => row.worker_pool_id === pool);
        pickedWorkers.push(
            ...pickWorkers(candidates, row => matchesShape(kind, row, dayStart), count, taken, `${pool} ${kind}`)
        );
    }
}
for (const [kind, count] of ANY_POOL_QUOTAS) {
    pickedWorkers.push(...pickWorkers(workers, row => shapeOf(row) === kind, count, taken, kind));
}

const pickedErrors = ERROR_QUOTAS.flatMap(quota => pickErrors(errors, quota));

const artifact = encodeWorkerLifecycle([...pickedWorkers, ...pickedErrors], date, retrievedAt);
writeFileSync(OUT, `${JSON.stringify(artifact)}\n`);

const shapeCounts = new Map<string, number>();
for (const row of pickedWorkers) {
    const key = `${row.worker_pool_id} ${shapeOf(row)}`;
    shapeCounts.set(key, (shapeCounts.get(key) ?? 0) + 1);
}
console.log(`wrote ${pickedWorkers.length} workers and ${pickedErrors.length} pool errors for ${date}`);
for (const [key, count] of [...shapeCounts].sort()) {
    console.log(`  ${count}  ${key}`);
}
