/**
 * Adversarial tests for the decoders: a decoder that never throws is a
 * decoder that will invent a number.
 *
 * `test/mutations.test.ts` does this for `tools/validate/`. This file does it
 * for `lib/`, and it exists because the review of step 1 showed the two are
 * not the same claim. The decoders read entry `i` of several parallel arrays,
 * and where a slot was missing they substituted `0` or `[]`. Four of those
 * sites were mutated — `durations[i] ?? 0` to `?? 99999`, `counts[i] ?? 0` to
 * `?? 7777`, `taskIdIds[i] ?? []` to `?? [0]`, and removing the `entryCount`
 * short-circuit — and **all four survived with the whole suite green**.
 *
 * They survived because today's published data has no truncated arrays, so no
 * fixture reaches the substitution. That is exactly the wrong reason to be
 * confident: the substitution exists for the case that does not happen yet,
 * and its whole effect is to make that case invisible when it does. It is the
 * same shape of mistake as `getCountAtIndex()`'s `else { return 1; }`, which
 * `PLAN.md` §4 names as the thing to eliminate.
 *
 * So: break a group the way format drift might break it, and assert the
 * decoder refuses rather than producing a plausible number. A mutation that
 * slips through here is a silent-wrong-answer path, and this file is where
 * those become failing tests.
 */

import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeBucket } from '../lib/formats/buckets.ts';
import { decodeDaily } from '../lib/formats/daily.ts';
import { decodeIssues } from '../lib/formats/issues.ts';
import { decodeResourceJobs } from '../lib/formats/resources.ts';
import { statsRows } from '../lib/formats/stats.ts';
import type { BucketFile } from '../lib/formats/buckets.ts';
import type { DailyFile } from '../lib/formats/daily.ts';
import type { IssuesFile } from '../lib/formats/issues.ts';
import type { ResourcesFile } from '../lib/formats/resources.ts';
import type { StatsFile } from '../lib/formats/stats.ts';
import {
    MisalignedStatusGroupError,
    UnknownStatusGroupShapeError,
    entryCount,
    iterateStatusGroup,
    totalRuns,
} from '../lib/formats/status-entries.ts';
import type { StatusGroup } from '../lib/formats/status-group.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

async function load<T>(name: string): Promise<T> {
    return JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8')) as T;
}

/** A deep copy, so a mutation cannot leak between tests. */
function clone<T>(value: T): T {
    return structuredClone(value);
}

/** Fully drains a decoded file, which is what forces every entry to decode. */
function drain(file: { testCount: number; runsOfTest(id: number): Iterable<unknown> }): number {
    let entries = 0;
    for (let testId = 0; testId < file.testCount; testId++) {
        for (const _ of file.runsOfTest(testId)) {
            entries += 1;
        }
    }
    return entries;
}

/**
 * Finds the first status group of a given shape in a file, so a mutation can
 * be aimed at a real group rather than a hand-built one.
 */
function firstGroupOfStatus(
    file: { tables: { statuses: string[] }; testRuns: (StatusGroup | null)[][] },
    predicate: (status: string) => boolean
): { testId: number; statusId: number; group: Record<string, unknown> } {
    for (let testId = 0; testId < file.testRuns.length; testId++) {
        const perTest = file.testRuns[testId];
        if (!perTest) {
            continue;
        }
        for (let statusId = 0; statusId < perTest.length; statusId++) {
            const group = perTest[statusId];
            if (group && predicate(file.tables.statuses[statusId]!)) {
                return { testId, statusId, group: group as unknown as Record<string, unknown> };
            }
        }
    }
    throw new Error('no matching group in the fixture');
}

const xpcshellBucket = await load<BucketFile>('xpcshell-00.json');
const xpcshellIssues = await load<IssuesFile>('xpcshell-issues.json');
const xpcshellDaily = await load<DailyFile>('xpcshell-2026-08-03.json');
const xpcshellStats = await load<StatsFile>('xpcshell-stats.json');
const xpcshellResources = await load<ResourcesFile>('xpcshell-2026-08-03-resources.json');

test('the unmutated fixtures decode, so a throw below means the mutation', () => {
    // The control. Without it, a decoder that threw on everything would pass
    // every test in this file.
    assert.ok(drain(decodeBucket(xpcshellBucket)) > 0);
    assert.ok(drain(decodeIssues(xpcshellIssues)) > 0);
    assert.ok(drain(decodeDaily(xpcshellDaily)) > 0);
    assert.ok(decodeResourceJobs(xpcshellResources, 0).length > 0);
    assert.ok(statsRows(xpcshellStats).length > 0);
});

// --- truncated parallel arrays -------------------------------------------
//
// The class of mutation that the `?? 0` substitutions hid. Each one leaves a
// group that still parses as JSON and still looks plausible; the decoder has
// to notice that its arrays no longer agree.

test('a truncated counts array is caught, not padded with zeros', () => {
    // The reviewer's direct probe, as a test. `days:[0,1,1]` with `counts:[7]`
    // used to decode to three entries — one real and two invented with
    // `count: 0` — which is a silently wrong per-day breakdown.
    const group = { days: [0, 1, 1], counts: [7] } as unknown as StatusGroup;
    assert.throws(() => [...iterateStatusGroup(group, 'PASS', {})], MisalignedStatusGroupError);
    assert.throws(() => entryCount(group, undefined, 'PASS'), MisalignedStatusGroupError);

    // And on a real group rather than a hand-built one.
    const file = clone(xpcshellIssues);
    const { group: real } = firstGroupOfStatus(file, (s) => s.startsWith('PASS'));
    (real['counts'] as number[]).pop();
    assert.throws(() => drain(decodeIssues(file)), MisalignedStatusGroupError);
});

test('a truncated durations array is caught, not read as an empty bucket', () => {
    const file = clone(xpcshellBucket);
    const { group } = firstGroupOfStatus(file, (s) => s.startsWith('PASS'));
    (group['durations'] as number[][]).pop();
    assert.throws(() => drain(decodeBucket(file)), MisalignedStatusGroupError);
});

test('a truncated taskIdIds array is caught, not read as an empty bucket', () => {
    // The worst of the three when it was silent: an empty bucket decodes to
    // `count: 0`, so a truncated failing group would report *fewer failures*
    // rather than an error.
    const file = clone(xpcshellBucket);
    const { group } = firstGroupOfStatus(file, (s) => s.startsWith('FAIL'));
    (group['taskIdIds'] as number[][]).pop();
    assert.throws(() => drain(decodeBucket(file)), MisalignedStatusGroupError);
});

test('a truncated days array is caught', () => {
    // `days` is the array the decoder trusted most: it took its length as the
    // entry count and read everything else against it. Making it *shorter*
    // than the others is therefore the mutation that used to be invisible in
    // the other direction — entries would simply be dropped.
    const file = clone(xpcshellBucket);
    const { group } = firstGroupOfStatus(file, (s) => s.startsWith('PASS'));
    (group['days'] as number[]).pop();
    assert.throws(() => drain(decodeBucket(file)), MisalignedStatusGroupError);
});

test('a truncated messageIds array is caught', () => {
    // Not counted from, but read per entry: a short one used to yield `null`
    // for the missing tail, which is indistinguishable from a real
    // "no message recorded".
    const file = clone(xpcshellBucket);
    const { group } = firstGroupOfStatus(file, (s) => s === 'SKIP');
    (group['messageIds'] as (number | null)[]).pop();
    assert.throws(() => drain(decodeBucket(file)), MisalignedStatusGroupError);
});

test('a truncated timestamps array is caught', () => {
    const file = clone(xpcshellDaily);
    const { group } = firstGroupOfStatus(file, (s) => s.startsWith('PASS'));
    (group['timestamps'] as number[]).pop();
    assert.throws(() => drain(decodeDaily(file)), MisalignedStatusGroupError);
});

test('a truncated minidumps array is caught', () => {
    const file = clone(xpcshellBucket);
    const { group } = firstGroupOfStatus(file, (s) => s === 'CRASH');
    (group['minidumps'] as unknown[]).pop();
    assert.throws(() => drain(decodeBucket(file)), MisalignedStatusGroupError);
});

test('an array made longer is caught too, not silently ignored', () => {
    // The mirror case. Extra entries are as much a sign of drift as missing
    // ones, and reading `days.length` would have skipped them entirely.
    const file = clone(xpcshellIssues);
    const { group } = firstGroupOfStatus(file, (s) => s.startsWith('PASS'));
    (group['counts'] as number[]).push(1);
    assert.throws(() => drain(decodeIssues(file)), MisalignedStatusGroupError);
});

test('a hole inside an array is caught, even though the lengths agree', () => {
    // `at()` is the second line of defence, and it needs its own test because
    // the length check in `entryCount()` normally fires first — mutating
    // `at()` to return 0 instead of throwing left every other test in this
    // file passing, which makes it exactly the kind of unexercised guard that
    // rots.
    //
    // A sparse array reaches it: `[1, , 3]` has length 3, so every array
    // agrees, and only the read of slot 1 can notice. JSON cannot express a
    // hole, but `undefined` from a shortened *inner* array can, and a
    // generator emitting `null` where a number belongs would land here too.
    const sparse: number[] = [0, 0, 0];
    delete sparse[1];
    const group = { days: [0, 0, 0], counts: sparse } as unknown as StatusGroup;
    assert.throws(
        () => [...iterateStatusGroup(group, 'PASS', {})],
        (error: unknown) => {
            assert.ok(error instanceof MisalignedStatusGroupError);
            assert.match(error.message, /index=1/);
            return true;
        }
    );

    // The same for the `days` array itself, which is read before the switch.
    const sparseDays: number[] = [0, 0, 0];
    delete sparseDays[2];
    assert.throws(
        () =>
            [
                ...iterateStatusGroup(
                    { days: sparseDays, counts: [1, 1, 1] } as unknown as StatusGroup,
                    'PASS',
                    {}
                ),
            ],
        MisalignedStatusGroupError
    );
});

test('the misalignment error names the arrays and their lengths', () => {
    // A throw that does not say what disagreed sends someone to a debugger.
    const group = { days: [0, 1, 1], counts: [7] } as unknown as StatusGroup;
    assert.throws(
        () => [...iterateStatusGroup(group, 'FAIL-PARALLEL', {})],
        (error: unknown) => {
            assert.ok(error instanceof MisalignedStatusGroupError);
            assert.match(error.message, /FAIL-PARALLEL/);
            assert.match(error.message, /days=3/);
            assert.match(error.message, /counts=1/);
            return true;
        }
    );
});

// --- shapes that stop being shapes ---------------------------------------

test('a group that loses its counting array is unrecognized, not empty', () => {
    // Removing `counts` from a `counts` group leaves `{ days }`, which under
    // the old code fell through to... nothing, because `statusGroupShape` did
    // already throw here. Asserted so it stays that way.
    const file = clone(xpcshellIssues);
    const { group } = firstGroupOfStatus(file, (s) => s.startsWith('PASS'));
    delete group['counts'];
    assert.throws(() => drain(decodeIssues(file)), UnknownStatusGroupShapeError);
});

test('a renamed counting array is unrecognized, not counted as one run', () => {
    // The format-drift case `PLAN.md` §4 describes: a sixth shape appears and
    // `getCountAtIndex()` returns 1 for every entry of it.
    const file = clone(xpcshellIssues);
    const { group } = firstGroupOfStatus(file, (s) => s.startsWith('PASS'));
    group['runCounts'] = group['counts'];
    delete group['counts'];
    assert.throws(() => drain(decodeIssues(file)), UnknownStatusGroupShapeError);
});

test('a nested array flattened is caught rather than crashing on .slice', () => {
    // `taskIdIds: [[1,2],[3]]` becoming `[1,2,3]` is a plausible generator
    // change, and it changes what an entry *means*.
    //
    // Length checking alone does **not** catch it, which is the thing this
    // test found: flattening a group whose buckets each hold one element
    // leaves the length unchanged — `[[7]]` and `[7]` are both length 1 — and
    // the first `FAIL-PARALLEL` group in the fixture is exactly that. Before
    // `nestedAt()`, the decoder got past every guard and died on
    // `indexes.slice is not a function`: a TypeError from three frames deep
    // rather than a statement about the data.
    const file = clone(xpcshellBucket);
    const { group } = firstGroupOfStatus(file, (s) => s.startsWith('FAIL'));
    const nested = group['taskIdIds'] as number[][];
    assert.equal(nested.length, nested.flat().length, 'the fixture group is the tricky case');
    group['taskIdIds'] = nested.flat();
    assert.throws(
        () => drain(decodeBucket(file)),
        (error: unknown) => {
            assert.ok(error instanceof UnknownStatusGroupShapeError);
            assert.match(error.message, /taskIdIds\[0\] is number, expected an array/);
            return true;
        }
    );
});

test('a flattened durations array is caught the same way', () => {
    const file = clone(xpcshellBucket);
    const { group } = firstGroupOfStatus(file, (s) => s.startsWith('PASS'));
    // Replace each bucket with its first duration, keeping the length.
    group['durations'] = (group['durations'] as number[][]).map((b) => b[0] ?? 0);
    assert.throws(() => drain(decodeBucket(file)), /durations\[0\] is number, expected an array/);
});

test('a flattened minidumps array is caught the same way', () => {
    // The daily files store one minidump string per entry and everything else
    // stores an array per entry, so this is the mutation that would happen if
    // a family adopted the other convention.
    const file = clone(xpcshellBucket);
    const { group } = firstGroupOfStatus(file, (s) => s === 'CRASH');
    group['minidumps'] = (group['minidumps'] as (string | null)[][]).map((b) => b[0] ?? null);
    assert.throws(() => drain(decodeBucket(file)), /minidumps\[0\] is string, expected an array/);
});

test('totalRuns rejects the same broken groups the iterator does', () => {
    // `totalsByStatus()` is the cheap path that skips entry decoding, so it
    // needs its own guard — a caller taking totals must not get a number the
    // iterator would have refused to produce.
    const renamed = { days: [0], runCounts: [5] } as unknown as StatusGroup;
    assert.throws(() => totalRuns(renamed, 'PASS'), UnknownStatusGroupShapeError);
    assert.throws(() => totalRuns({} as unknown as StatusGroup, 'PASS'), UnknownStatusGroupShapeError);
});

// --- table indices -------------------------------------------------------

test('an index left dangling by a shrunken table is caught', () => {
    // The failure mode a truncated fixture has: keep an index, drop the table
    // entry it points at. It reads as `undefined`, which becomes the literal
    // text "undefined" in a report.
    const file = clone(xpcshellBucket);
    file.tables.jobNames = file.tables.jobNames.slice(0, 1);
    assert.throws(() => drain(decodeBucket(file)), /out of range for tables\.jobNames/);
});

test('a dangling message index is caught', () => {
    const file = clone(xpcshellBucket);
    file.tables.messages = [];
    assert.throws(() => drain(decodeBucket(file)), /out of range for tables\.messages/);
});

test('a dangling task-ID index is caught', () => {
    const file = clone(xpcshellBucket);
    file.tables.taskIds = file.tables.taskIds.slice(0, 1);
    assert.throws(() => drain(decodeBucket(file)), /out of range for tables\.taskIds/);
});

test('taskIdIndexes stay consistent with the strings they resolved to', () => {
    // The step-3 enabler: if these two ever disagreed, a per-configuration
    // query would attribute a failure to the wrong job.
    const file = decodeBucket(xpcshellBucket);
    let checked = 0;
    for (let testId = 0; testId < file.testCount; testId++) {
        for (const entry of file.runsOfTest(testId)) {
            if (!entry.taskIdIndexes) {
                continue;
            }
            assert.equal(entry.taskIdIndexes.length, entry.taskIds?.length);
            for (let k = 0; k < entry.taskIdIndexes.length; k++) {
                assert.equal(
                    xpcshellBucket.tables.taskIds[entry.taskIdIndexes[k]!],
                    entry.taskIds![k]
                );
                assert.notEqual(file.jobNameOfTaskIndex(entry.taskIdIndexes[k]!), null);
                checked += 1;
            }
        }
    }
    assert.ok(checked > 0);
});

test('jobNameOfTaskIndex rejects an out-of-range index and admits when it cannot answer', () => {
    const bucket = decodeBucket(xpcshellBucket);
    assert.throws(
        () => bucket.jobNameOfTaskIndex(xpcshellBucket.tables.taskIds.length + 1000),
        /out of range for taskInfo\.jobNameIds/
    );
    // `{harness}-issues.json` has no `taskInfo` at all, so the honest answer
    // is "this file cannot say" rather than a throw or a made-up name.
    assert.equal(decodeIssues(xpcshellIssues).jobNameOfTaskIndex(0), null);
});

// --- the other families --------------------------------------------------

test('a truncated resources array is caught, not read as a job using no memory', () => {
    // `maxMemories[i] ?? 0` reported a job that peaked at zero bytes, which is
    // a plausible-looking number that would sort to the top of a "most
    // efficient job" list.
    for (const key of [
        'maxMemories',
        'idleTimes',
        'singleCoreTimes',
        'startTimes',
        'jobNameIds',
        'chunks',
        'cpuBuckets',
    ] as const) {
        const file = clone(xpcshellResources);
        (file.jobs[key] as unknown[]).pop();
        assert.throws(
            () => decodeResourceJobs(file, 0),
            /misaligned/,
            `a short ${key} was not caught`
        );
    }
});

test('a CPU bucket array of the wrong length is caught', () => {
    // Declared as exactly ten buckets, and a caller charting them by index
    // would silently mislabel every bucket if that changed.
    const file = clone(xpcshellResources);
    file.jobs.cpuBuckets[0] = [1, 2, 3];
    assert.throws(() => decodeResourceJobs(file, 0), /CPU buckets, expected 10/);
});

test('a truncated stats series is caught, not padded into a quiet day', () => {
    // A padded 0 reads as "nothing ran that day", which is indistinguishable
    // from a real weekend and would be charted as one.
    for (const key of ['totalTestRuns', 'failedTestRuns', 'invalidJobs'] as const) {
        const file = clone(xpcshellStats);
        file[key].pop();
        assert.throws(() => statsRows(file), /misaligned/, `a short ${key} was not caught`);
    }
    // Including the per-kind marker series, which are keyed rather than named.
    const file = clone(xpcshellStats);
    const kind = Object.keys(file.markerCounts)[0]!;
    file.markerCounts[kind]!.pop();
    assert.throws(() => statsRows(file), /misaligned/);
});
