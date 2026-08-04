/**
 * Adversarial tests: a validator that never fails is not a validator.
 *
 * Step 0's whole claim is that the type declarations were checked against real
 * files. That claim is only worth something if the checker would have noticed
 * had they been wrong — and the first version of it would not have. Every
 * primitive routed a missing or `null` field to the census rather than to an
 * error, so deleting the entire top-level `markers` object from an errors file
 * validated clean, and three fields stayed declared non-nullable against a
 * census recording thousands of nulls in them.
 *
 * So: take each fixture, break it in a way a real format change might break
 * it, and assert the validator complains. A mutation that slips through is a
 * blind spot, and this file is where blind spots become failing tests.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { Checker } from '../tools/validate/check.ts';
import {
    checkBucket,
    checkDaily,
    checkErrors,
    checkIssues,
    checkManifests,
    checkResources,
    checkStackwalk,
    checkStats,
    type FileContext,
} from '../tools/validate/formats.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

type Check = (c: Checker, data: unknown, ctx: FileContext) => void;
type Mutate = (data: never) => void;

async function load(name: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
}

function errorsFrom(check: Check, data: unknown, ctx: FileContext): string[] {
    const c = new Checker();
    check(c, data, ctx);
    return c.errors.map((e) => `${e.path}: ${e.message}`);
}

/**
 * Each case: a fixture, its checker, and a mutation that must be caught.
 *
 * The mutations are chosen to be things the generator could plausibly start
 * doing — a dropped field, a renamed key, an index left dangling by a table
 * change, a count that stops matching its array — rather than arbitrary
 * corruption, so a pass here means something about format drift.
 */
interface Case {
    name: string;
    fixture: string;
    check: Check;
    ctx: FileContext;
    mutate: Mutate;
}

const XPC: FileContext = { harness: 'xpcshell' };
const MOCHI: FileContext = { harness: 'mochitest' };

const cases: Case[] = [
    // --- whole containers going missing ---------------------------------
    {
        name: 'errors: the entire markers object is deleted',
        fixture: 'mochitest-2026-08-03-errors.json',
        check: checkErrors,
        ctx: MOCHI,
        mutate: (d: Record<string, unknown>) => delete d['markers'],
    },
    {
        name: 'errors: the entire messages object is deleted',
        fixture: 'xpcshell-2026-08-03-errors.json',
        check: checkErrors,
        ctx: XPC,
        mutate: (d: Record<string, unknown>) => delete d['messages'],
    },
    {
        name: 'errors: metadata.markerCounts is deleted',
        fixture: 'xpcshell-2026-08-03-errors.json',
        check: checkErrors,
        ctx: XPC,
        mutate: (d: Record<string, Record<string, unknown>>) => delete d['metadata']!['markerCounts'],
    },
    {
        name: 'issues: testInfo is deleted',
        fixture: 'xpcshell-issues.json',
        check: checkIssues,
        ctx: XPC,
        mutate: (d: Record<string, unknown>) => delete d['testInfo'],
    },
    {
        name: 'bucket: tables is deleted',
        fixture: 'xpcshell-00.json',
        check: checkBucket,
        ctx: XPC,
        mutate: (d: Record<string, unknown>) => delete d['tables'],
    },
    {
        name: 'daily: testRuns is deleted',
        fixture: 'xpcshell-2026-08-03.json',
        check: checkDaily,
        ctx: XPC,
        mutate: (d: Record<string, unknown>) => delete d['testRuns'],
    },
    {
        name: 'manifests: runs is deleted',
        fixture: 'manifests.json',
        check: checkManifests,
        ctx: XPC,
        mutate: (d: Record<string, unknown>) => delete d['runs'],
    },
    {
        name: 'resources: jobs is deleted',
        fixture: 'xpcshell-2026-08-03-resources.json',
        check: checkResources,
        ctx: XPC,
        mutate: (d: Record<string, unknown>) => delete d['jobs'],
    },
    {
        name: 'stackwalk: threads is deleted',
        fixture: 'stackwalk-crash.json',
        check: checkStackwalk,
        ctx: XPC,
        mutate: (d: Record<string, unknown>) => delete d['threads'],
    },

    // --- individual required fields going missing ------------------------
    {
        name: 'errors: markers.counts is deleted',
        fixture: 'xpcshell-2026-08-03-errors.json',
        check: checkErrors,
        ctx: XPC,
        mutate: (d: Record<string, Record<string, unknown>>) => delete d['markers']!['counts'],
    },
    {
        name: 'errors: messages.markerNameIds is deleted',
        fixture: 'xpcshell-2026-08-03-errors.json',
        check: checkErrors,
        ctx: XPC,
        mutate: (d: Record<string, Record<string, unknown>>) => delete d['messages']!['markerNameIds'],
    },
    {
        name: 'issues: metadata.days is deleted',
        fixture: 'xpcshell-issues.json',
        check: checkIssues,
        ctx: XPC,
        mutate: (d: Record<string, Record<string, unknown>>) => delete d['metadata']!['days'],
    },
    {
        name: 'stats: dates is deleted',
        fixture: 'xpcshell-stats.json',
        check: checkStats,
        ctx: XPC,
        mutate: (d: Record<string, unknown>) => delete d['dates'],
    },
    {
        name: 'resources: jobs.cpuBuckets is deleted',
        fixture: 'xpcshell-2026-08-03-resources.json',
        check: checkResources,
        ctx: XPC,
        mutate: (d: Record<string, Record<string, unknown>>) => delete d['jobs']!['cpuBuckets'],
    },

    // --- nulls where the declaration forbids them ------------------------
    {
        name: 'errors: a markerNameIds entry becomes null',
        fixture: 'xpcshell-2026-08-03-errors.json',
        check: checkErrors,
        ctx: XPC,
        mutate: (d: { messages: { markerNameIds: (number | null)[] } }) => {
            d.messages.markerNameIds[0] = null;
        },
    },
    {
        name: 'errors: a markers.testIds entry becomes null',
        fixture: 'xpcshell-2026-08-03-errors.json',
        check: checkErrors,
        ctx: XPC,
        mutate: (d: { markers: { testIds: (number | null)[] } }) => {
            d.markers.testIds[0] = null;
        },
    },
    {
        name: 'issues: a testInfo.testPathIds entry becomes null',
        fixture: 'xpcshell-issues.json',
        check: checkIssues,
        ctx: XPC,
        mutate: (d: { testInfo: { testPathIds: (number | null)[] } }) => {
            d.testInfo.testPathIds[0] = null;
        },
    },
    {
        name: 'manifests: a runs.durations entry becomes null',
        fixture: 'manifests.json',
        check: checkManifests,
        ctx: XPC,
        mutate: (d: { runs: { durations: (number | null)[] } }) => {
            d.runs.durations[0] = null;
        },
    },
    {
        name: 'resources: a startTimes entry becomes null',
        fixture: 'xpcshell-2026-08-03-resources.json',
        check: checkResources,
        ctx: XPC,
        mutate: (d: { jobs: { startTimes: (number | null)[] } }) => {
            d.jobs.startTimes[0] = null;
        },
    },
    {
        name: 'stackwalk: a frame offset becomes null',
        fixture: 'stackwalk-crash.json',
        check: checkStackwalk,
        ctx: XPC,
        mutate: (d: { threads: { frames: { offset: string | null }[] }[] }) => {
            d.threads[0]!.frames[0]!.offset = null;
        },
    },

    // --- indices left dangling by a table change -------------------------
    {
        name: 'issues: a testPathIds index points past the table',
        fixture: 'xpcshell-issues.json',
        check: checkIssues,
        ctx: XPC,
        mutate: (d: { tables: { testPaths: string[] }; testInfo: { testPathIds: number[] } }) => {
            d.testInfo.testPathIds[0] = d.tables.testPaths.length;
        },
    },
    {
        name: 'bucket: a table entry is removed, dangling every index past it',
        fixture: 'xpcshell-00.json',
        check: checkBucket,
        ctx: XPC,
        mutate: (d: { tables: { jobNames: string[] } }) => {
            d.tables.jobNames.pop();
        },
    },
    {
        name: 'errors: a delta-encoded taskIdIds group overruns the table',
        fixture: 'xpcshell-2026-08-03-errors.json',
        check: checkErrors,
        ctx: XPC,
        mutate: (d: { tables: { taskIds: string[] }; markers: { taskIdIds: number[][] } }) => {
            d.markers.taskIdIds[0]![0] = d.tables.taskIds.length + 1;
        },
    },
    {
        name: 'manifests: a runs.taskIds index points past tasks',
        fixture: 'manifests.json',
        check: checkManifests,
        ctx: XPC,
        mutate: (d: { tasks: { id: string[] }; runs: { taskIds: number[] } }) => {
            d.runs.taskIds[0] = d.tasks.id.length;
        },
    },
    {
        name: 'stackwalk: crashing_thread points past threads',
        fixture: 'stackwalk-crash.json',
        check: checkStackwalk,
        ctx: XPC,
        mutate: (d: { threads: unknown[]; crash_info: { crashing_thread: number } }) => {
            d.crash_info.crashing_thread = d.threads.length;
        },
    },

    // --- parallel arrays falling out of step -----------------------------
    {
        name: 'errors: markers.counts loses an entry',
        fixture: 'xpcshell-2026-08-03-errors.json',
        check: checkErrors,
        ctx: XPC,
        mutate: (d: { markers: { counts: number[][] } }) => {
            d.markers.counts.pop();
        },
    },
    {
        name: 'errors: a group has more taskIdIds than counts',
        fixture: 'xpcshell-2026-08-03-errors.json',
        check: checkErrors,
        ctx: XPC,
        mutate: (d: { markers: { counts: number[][] } }) => {
            d.markers.counts[0]!.pop();
        },
    },
    {
        name: 'issues: testInfo arrays fall out of step',
        fixture: 'xpcshell-issues.json',
        check: checkIssues,
        ctx: XPC,
        mutate: (d: { testInfo: { testNameIds: number[] } }) => {
            d.testInfo.testNameIds.pop();
        },
    },
    {
        name: 'resources: jobs arrays fall out of step',
        fixture: 'xpcshell-2026-08-03-resources.json',
        check: checkResources,
        ctx: XPC,
        mutate: (d: { jobs: { maxMemories: number[] } }) => {
            d.jobs.maxMemories.pop();
        },
    },
    {
        name: 'resources: a cpuBuckets entry stops having ten buckets',
        fixture: 'xpcshell-2026-08-03-resources.json',
        check: checkResources,
        ctx: XPC,
        mutate: (d: { jobs: { cpuBuckets: number[][] } }) => {
            d.jobs.cpuBuckets[0]!.pop();
        },
    },
    {
        name: 'stats: a series falls out of step with dates',
        fixture: 'xpcshell-stats.json',
        check: checkStats,
        ctx: XPC,
        mutate: (d: { totalTestRuns: number[] }) => {
            d.totalTestRuns.pop();
        },
    },
    {
        name: 'stackwalk: frame_count stops matching frames',
        fixture: 'stackwalk-crash.json',
        check: checkStackwalk,
        ctx: XPC,
        mutate: (d: { threads: { frame_count: number }[] }) => {
            d.threads[0]!.frame_count += 1;
        },
    },

    // --- wrong types and unexpected keys ---------------------------------
    {
        name: 'a new top-level key appears',
        fixture: 'xpcshell-issues.json',
        check: checkIssues,
        ctx: XPC,
        mutate: (d: Record<string, unknown>) => {
            d['somethingNew'] = [1, 2, 3];
        },
    },
    {
        name: 'a new status-group key appears',
        fixture: 'xpcshell-00.json',
        check: checkBucket,
        ctx: XPC,
        mutate: (d: { testRuns: (Record<string, unknown> | null)[][] }) => {
            for (const perTest of d.testRuns) {
                for (const group of perTest ?? []) {
                    if (group) {
                        group['newAxis'] = [1];
                        return;
                    }
                }
            }
        },
    },
    {
        name: 'errors: a count becomes a string',
        fixture: 'xpcshell-2026-08-03-errors.json',
        check: checkErrors,
        ctx: XPC,
        mutate: (d: { markers: { counts: (number | string)[][] } }) => {
            d.markers.counts[0]![0] = '7';
        },
    },
    {
        name: 'issues: metadata.startDate stops being a date',
        fixture: 'xpcshell-issues.json',
        check: checkIssues,
        ctx: XPC,
        mutate: (d: { metadata: { startDate: string } }) => {
            d.metadata.startDate = 'yesterday';
        },
    },
    {
        name: 'issues: aggregatedFrom holds dates instead of filenames',
        fixture: 'xpcshell-issues.json',
        check: checkIssues,
        ctx: XPC,
        mutate: (d: { metadata: { aggregatedFrom: string[] } }) => {
            d.metadata.aggregatedFrom[0] = '2026-08-03';
        },
    },
    {
        name: 'manifests: job names stop agreeing beyond the chunk suffix',
        fixture: 'manifests.json',
        check: checkManifests,
        ctx: XPC,
        mutate: (d: { jobNames: string[]; runs: { jobNameIds: number[] } }) => {
            // Point a run at some unrelated job name.
            const current = d.runs.jobNameIds[0]!;
            d.runs.jobNameIds[0] = current === 0 ? d.jobNames.length - 1 : 0;
        },
    },
    // --- the status-dependent field rules --------------------------------
    //
    // `messageIds` presence follows the status, not the shape. These two
    // guard the rule Step 1's iterator has to encode.
    {
        name: 'bucket: a FAIL group loses its messageIds',
        fixture: 'xpcshell-00.json',
        check: checkBucket,
        ctx: XPC,
        mutate: (d: {
            tables: { statuses: string[] };
            testRuns: (Record<string, unknown> | null)[][];
        }) => {
            const ids = d.tables.statuses
                .map((s, i) => (/^FAIL(-|$)/.test(s) ? i : -1))
                .filter((i) => i >= 0);
            for (const perTest of d.testRuns) {
                for (const id of ids) {
                    if (perTest?.[id]) {
                        delete perTest[id]!['messageIds'];
                        return;
                    }
                }
            }
        },
    },
    {
        name: 'bucket: a TIMEOUT group gains messageIds',
        fixture: 'xpcshell-00.json',
        check: checkBucket,
        ctx: XPC,
        mutate: (d: {
            tables: { statuses: string[] };
            testRuns: (Record<string, unknown> | null)[][];
        }) => {
            const ids = d.tables.statuses
                .map((s, i) => (/^TIMEOUT(-|$)/.test(s) ? i : -1))
                .filter((i) => i >= 0);
            for (const perTest of d.testRuns) {
                for (const id of ids) {
                    const group = perTest?.[id];
                    if (group) {
                        group['messageIds'] = (group['taskIdIds'] as unknown[]).map(() => null);
                        return;
                    }
                }
            }
        },
    },
    {
        name: 'bucket: a CRASH group loses its crashSignatureIds',
        fixture: 'xpcshell-00.json',
        check: checkBucket,
        ctx: XPC,
        mutate: (d: {
            tables: { statuses: string[] };
            testRuns: (Record<string, unknown> | null)[][];
        }) => {
            const id = d.tables.statuses.indexOf('CRASH');
            for (const perTest of d.testRuns) {
                if (perTest?.[id]) {
                    delete perTest[id]!['crashSignatureIds'];
                    return;
                }
            }
        },
    },
    {
        name: 'bucket: a day delta decodes past the end of the window',
        fixture: 'xpcshell-00.json',
        check: checkBucket,
        ctx: XPC,
        mutate: (d: { testRuns: (Record<string, unknown> | null)[][] }) => {
            for (const perTest of d.testRuns) {
                for (const group of perTest ?? []) {
                    const days = group?.['days'] as number[] | undefined;
                    if (days?.length) {
                        days[0] = 999;
                        return;
                    }
                }
            }
        },
    },
];

for (const testCase of cases) {
    test(`caught: ${testCase.name}`, async () => {
        const clean = await load(testCase.fixture);
        assert.deepEqual(
            errorsFrom(testCase.check, clean, testCase.ctx),
            [],
            'the unmutated fixture should validate clean'
        );

        const mutated = await load(testCase.fixture);
        (testCase.mutate as (d: unknown) => void)(mutated);
        const errors = errorsFrom(testCase.check, mutated, testCase.ctx);
        assert.ok(
            errors.length > 0,
            `the validator did not notice. Mutation: ${testCase.name}`
        );
    });
}
