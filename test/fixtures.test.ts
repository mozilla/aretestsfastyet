/**
 * Every fixture is re-validated with the same checker the sweep ran against
 * whole published files.
 *
 * This is what keeps truncation honest. A fixture is a *subset*, and the
 * failure mode of subsetting a table-encoded file is silent: drop a test but
 * keep an index pointing at a table entry that no longer exists, and the file
 * still parses as JSON and still looks plausible. The index-range checks catch
 * exactly that, so a bug in `tools/fixtures/truncate.ts` fails here rather
 * than becoming a wrong golden value in a later step's tests.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { Checker } from '../tools/validate/check.ts';
import {
    checkBucket,
    checkDaily,
    checkErrors,
    checkIndex,
    checkIssues,
    checkIssuesWithTaskIds,
    checkManifests,
    checkResources,
    checkStackwalk,
    checkStats,
    type FileContext,
} from '../tools/validate/formats.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

type Check = (c: Checker, data: unknown, ctx: FileContext) => void;

/** Maps a fixture filename to the checker for its family. */
function checkerFor(name: string): { check: Check; ctx: FileContext } | undefined {
    const harness = name.startsWith('mochitest') ? 'mochitest' : 'xpcshell';
    const date = /(\d{4}-\d{2}-\d{2})/.exec(name)?.[1];
    const ctx: FileContext = { harness, ...(date !== undefined ? { date } : {}) };

    if (name === 'index.json') {
        return { check: checkIndex, ctx };
    }
    if (name === 'manifests.json') {
        return { check: checkManifests, ctx };
    }
    if (name.startsWith('stackwalk-')) {
        return { check: checkStackwalk, ctx };
    }
    if (name.endsWith('-stats.json')) {
        return { check: checkStats, ctx };
    }
    if (name.endsWith('-issues.json')) {
        return { check: checkIssues, ctx };
    }
    if (name.endsWith('-issues-with-taskids.json')) {
        return { check: checkIssuesWithTaskIds, ctx };
    }
    if (name.endsWith('-errors.json')) {
        return { check: checkErrors, ctx };
    }
    if (name.endsWith('-resources.json')) {
        return { check: checkResources, ctx };
    }
    // The daily test comes first: a date ends in two hex-looking digits, so
    // `xpcshell-2026-08-03.json` matches the bucket pattern too.
    if (/-\d{4}-\d{2}-\d{2}\.json$/.test(name)) {
        return { check: checkDaily, ctx };
    }
    if (/-[0-9a-f]{2}\.json$/.test(name)) {
        return { check: checkBucket, ctx };
    }
    return undefined;
}

const names = (await readdir(FIXTURES)).filter((n) => n.endsWith('.json')).sort();

test('there are fixtures to check', () => {
    assert.ok(names.length > 0, `no fixtures in ${FIXTURES}`);
});

for (const name of names) {
    test(`${name} validates against its declared type`, async () => {
        const entry = checkerFor(name);
        assert.ok(entry, `no checker matches the fixture name ${name}`);
        const data: unknown = JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8'));
        const c = new Checker();
        entry.check(c, data, entry.ctx);
        assert.deepEqual(
            c.errors,
            [],
            `${name}:\n${c.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`
        );
    });
}

test('fixtures stay small enough to check in', async () => {
    const oversized: string[] = [];
    for (const name of names) {
        const bytes = (await readFile(path.join(FIXTURES, name))).byteLength;
        if (bytes > 2_000_000) {
            oversized.push(`${name} (${(bytes / 1e6).toFixed(1)} MB)`);
        }
    }
    assert.deepEqual(oversized, [], `fixtures over 2 MB: ${oversized.join(', ')}`);
});

test('the timing fixtures cover every status in their tables', async () => {
    // The point of selecting tests by status rather than taking a prefix: if
    // a status is in `tables.statuses` but no kept test carries it, the
    // fixture cannot exercise that shape and this catches the regression.
    for (const name of names) {
        if (!/-(issues|issues-with-taskids|[0-9a-f]{2}|\d{4}-\d{2}-\d{2})\.json$/.test(name)) {
            continue;
        }
        const data = JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8')) as {
            tables?: { statuses?: string[] };
            testRuns?: (unknown | null)[][];
        };
        const statuses = data.tables?.statuses;
        if (!statuses || !data.testRuns) {
            continue;
        }
        const covered = new Set<string>();
        for (const perTest of data.testRuns) {
            perTest?.forEach((group, statusId) => {
                if (group) {
                    covered.add(statuses[statusId]!);
                }
            });
        }
        const missing = statuses.filter((s) => !covered.has(s));
        assert.deepEqual(missing, [], `${name} has no test carrying: ${missing.join(', ')}`);
    }
});
