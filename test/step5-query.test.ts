/**
 * `lib/query/error-ranking.ts` and `lib/query/manifest-stats.ts`, plus the two
 * decoders under them, driven directly.
 *
 * The command-level tests in `cli-step5.test.ts` go through the whole CLI and
 * so can only see what a command chooses to print. Several rules are invisible
 * from there — the fixtures happen not to contain the discriminating case, or
 * the command aggregates the difference away — and a mutation of each survived
 * that suite. These drive the functions with inputs chosen to expose them.
 *
 * Where a fixture does contain the case, the fixture is used and the golden
 * comes from `artifacts/goldens.mjs`, which sums the raw arrays independently.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { type ErrorsFile, decodeErrors } from '../lib/formats/errors.ts';
import { type ManifestsFile, decodeManifests } from '../lib/formats/manifests.ts';
import { kindTotals, matchesTest, rankErrors } from '../lib/query/error-ranking.ts';
import {
    computeManifestStats,
    sortManifests,
    summarize,
    zeroDurationCensus,
} from '../lib/query/manifest-stats.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

function errorsFixture(name: string): ErrorsFile {
    return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as ErrorsFile;
}

function manifestsFixture(): ManifestsFile {
    return JSON.parse(readFileSync(new URL('manifests.json', FIXTURES), 'utf8')) as ManifestsFile;
}

// =========================================================================
// the errors decoder
// =========================================================================

test('taskIdIds are delta-decoded, not read as absolute indices', () => {
    const file = decodeErrors(errorsFixture('xpcshell-2026-08-03-errors.json'));
    // Golden from the raw JSON: group 0's raw deltas are [0,1,1,1,1,1,1,1],
    // which accumulate to indices 0…7 and therefore to eight *different* task
    // IDs. Reading the deltas as absolute indices would give
    // [0,1,1,1,1,1,1,1] — one distinct ID repeated seven times — which is why
    // the distinctness check below is the one that discriminates.
    const taskIds = file.taskIdsOfGroup(0);
    assert.equal(taskIds.length, 8);
    assert.equal(new Set(taskIds).size, 8, 'a non-accumulating decoder repeats an ID');
    assert.deepEqual(taskIds, [
        'WkDFLECkRJ2I3z7PolXNpw.0',
        'QOsKRwFEQHCITI3iWwSWlw.0',
        'PgeG_R7FSUWpyP9i-RTk9g.0',
        'YeuXOge7SMa2v3Dcfl_ueg.0',
        'd7IgdWKdS9GZh81He4aAQQ.0',
        'JGSnxhXyTAW-cVT4gprGDg.0',
        'ZcqzbvS4SNO5clcyPQQI8Q.0',
        'd1M_VwLdTqaRmGL_ZWl8Pw.0',
    ]);
});

test('a group reports how many tasks saw it, from the array length', () => {
    const file = decodeErrors(errorsFixture('xpcshell-2026-08-03-errors.json'));
    const groups = [...file.groups()];
    // Golden: group 0 has 8 task IDs and its counts sum to 8.
    assert.equal(groups[0]!.taskCount, 8);
    assert.equal(groups[0]!.totalCount, 8);
    // Not every group has the same task count, or a hardcoded 1 — or a
    // hardcoded anything — would pass.
    const distinctTaskCounts = new Set(groups.map((group) => group.taskCount));
    assert.ok(distinctTaskCounts.size > 1, 'fixture must have varying task counts');
    // And taskCount agrees with the decoded array for every group.
    for (const group of groups) {
        assert.equal(group.taskCount, file.taskIdsOfGroup(group.groupId).length);
    }
});

test('the decoder throws rather than misattributing non-parallel arrays', () => {
    const raw = errorsFixture('xpcshell-2026-08-03-errors.json');
    raw.markers.counts = raw.markers.counts.slice(0, -1);
    assert.throws(() => decodeErrors(raw), /not parallel/);
});

test('marker kinds come from the file, and differ between the two fixtures', () => {
    const mochitest = decodeErrors(errorsFixture('mochitest-2026-08-03-errors.json'));
    const xpcshell = decodeErrors(errorsFixture('xpcshell-2026-08-03-errors.json'));
    // If the list were hardcoded these would be equal. They are not, which is
    // exactly `FORMATS.md`'s point that the kinds are data.
    assert.deepEqual([...mochitest.markerNames], ['C++ warning', 'console.error']);
    assert.deepEqual(
        [...xpcshell.markerNames],
        ['C++ warning', 'JavaScript error', 'console.error']
    );
    assert.notDeepEqual([...mochitest.markerNames], [...xpcshell.markerNames]);
});

test('kindTotals comes from metadata and is sorted loudest first', () => {
    const file = decodeErrors(errorsFixture('xpcshell-2026-08-03-errors.json'));
    assert.deepEqual(kindTotals(file), [
        { kind: 'C++ warning', count: 521 },
        { kind: 'console.error', count: 123 },
        { kind: 'JavaScript error', count: 19 },
    ]);
});

// =========================================================================
// the ranking
// =========================================================================

test('the default grouping is location, and it differs from message grouping', () => {
    const file = decodeErrors(errorsFixture('mochitest-2026-08-03-errors.json'));
    // Golden: 60 (kind, text, file, line) tuples against 57 (kind, text) ones.
    // Three texts appear at two locations each, which is the whole reason
    // `errors.html` changed to group by location.
    assert.equal(rankErrors(file).rows.length, 60);
    assert.equal(rankErrors(file, { grouping: 'location' }).rows.length, 60);
    assert.equal(rankErrors(file, { grouping: 'message' }).rows.length, 57);
    // Stated as an inequality too, so the test still means something if the
    // fixture is regenerated with different contents.
    assert.ok(
        rankErrors(file, { grouping: 'location' }).rows.length >
            rankErrors(file, { grouping: 'message' }).rows.length
    );
});

test('a line with no file does not merge with another line-only message', () => {
    // `FORMATS.md`: 22 xpcshell messages had a line and no file, and 2,539 on
    // the live mochitest file. A key built by concatenating `file:line` would
    // collapse every fileless message sharing a line number into one group.
    const file = decodeErrors(
        buildErrorsFile([
            { kind: 'C++ warning', text: 'first', file: null, line: 100 },
            { kind: 'C++ warning', text: 'second', file: null, line: 100 },
            { kind: 'C++ warning', text: 'third', file: null, line: null },
        ])
    );
    const ranking = rankErrors(file, { grouping: 'location' });
    assert.equal(ranking.rows.length, 3);
    // And the fileless-but-lined ones keep their line rather than losing it.
    const lined = ranking.rows.filter((row) => row.file === null && row.line === 100);
    assert.equal(lined.length, 2);
});

test('an absent field does not collide with any real value', () => {
    // The sentinel's whole job: whatever stands in for "absent" must be a value
    // a field cannot actually hold, or a message with no file merges with a
    // message whose file happens to *be* that value, and the merged row's count
    // belongs to neither.
    //
    // Both plausible wrong sentinels are covered, because they fail on
    // different inputs and a test pinning one lets the other through — which is
    // exactly what happened: `''` was caught and `':'` survived.
    //
    //  - `''` collides with a file named `""`.
    //  - `':'`, or any printable byte, collides with a file named `":"`.
    for (const collidingValue of ['', ':', '', 'null', '0']) {
        const file = decodeErrors(
            buildErrorsFile([
                { kind: 'C++ warning', text: 'msg', file: null, line: 7, counts: [3] },
                { kind: 'C++ warning', text: 'msg', file: collidingValue, line: 7, counts: [5] },
            ])
        );
        const rows = rankErrors(file, { grouping: 'location' }).rows;
        assert.equal(
            rows.length,
            2,
            `a file named ${JSON.stringify(collidingValue)} must not merge with no file at all`
        );
        assert.deepEqual(
            rows.map((row) => row.count).sort((a, b) => a - b),
            [3, 5]
        );
        // …and each row keeps its own identity, so the split is real rather
        // than two rows that happen to have the right counts.
        assert.deepEqual(
            rows.map((row) => row.file).sort(),
            [collidingValue, null].sort()
        );
    }
});

test('an absent line does not collide with a real line either', () => {
    // The same hazard on the numeric field, which `String()` renders — so a
    // sentinel that is a digit string collides with a real line number.
    const file = decodeErrors(
        buildErrorsFile([
            { kind: 'C++ warning', text: 'msg', file: 'a.cpp', line: null, counts: [3] },
            { kind: 'C++ warning', text: 'msg', file: 'a.cpp', line: 1, counts: [5] },
            { kind: 'C++ warning', text: 'msg', file: 'a.cpp', line: 0, counts: [7] },
        ])
    );
    const rows = rankErrors(file, { grouping: 'location' }).rows;
    assert.equal(rows.length, 3, 'no line, line 0 and line 1 are three groups');
    assert.deepEqual(
        rows.map((row) => row.count).sort((a, b) => a - b),
        [3, 5, 7]
    );
});

test('a printable separator would let two different messages collide', () => {
    // The separator's job, driven by the collision it prevents. These two
    // messages differ only in where the boundary between text and file falls,
    // so any separator that can occur inside a field — `:` being the obvious
    // choice — makes them one group. With a control character they stay two.
    const file = decodeErrors(
        buildErrorsFile([
            { kind: 'C++ warning', text: 'a:b', file: 'c', line: 1, counts: [2] },
            { kind: 'C++ warning', text: 'a', file: 'b:c', line: 1, counts: [4] },
        ])
    );
    const rows = rankErrors(file, { grouping: 'location' }).rows;
    assert.equal(rows.length, 2, 'the parts must not be able to run together');
    assert.deepEqual(
        rows.map((row) => row.count).sort((a, b) => a - b),
        [2, 4]
    );
});

test('the same text from two files is two groups', () => {
    const file = decodeErrors(
        buildErrorsFile([
            { kind: 'C++ warning', text: 'same text', file: 'a.cpp', line: 1 },
            { kind: 'C++ warning', text: 'same text', file: 'b.cpp', line: 1 },
        ])
    );
    assert.equal(rankErrors(file, { grouping: 'location' }).rows.length, 2);
    // …and one group when grouped by text, which is the contrast.
    assert.equal(rankErrors(file, { grouping: 'message' }).rows.length, 1);
});

test('the test-spread count is exact and is not the occurrence count', () => {
    // Two tests emit the same message, one of them far more often. A hardcoded
    // spread, or a spread that counted occurrences, would differ from 2.
    const file = decodeErrors(
        buildErrorsFile([
            { kind: 'C++ warning', text: 'shared', file: 'a.cpp', line: 1, test: 'dir/one.js', counts: [10, 10] },
            { kind: 'C++ warning', text: 'shared', file: 'a.cpp', line: 1, test: 'dir/two.js', counts: [1] },
            { kind: 'C++ warning', text: 'solo', file: 'b.cpp', line: 2, test: 'dir/one.js', counts: [5] },
        ])
    );
    const rows = rankErrors(file).rows;
    const shared = rows.find((row) => row.text === 'shared')!;
    const solo = rows.find((row) => row.text === 'solo')!;
    assert.equal(shared.testCount, 2);
    assert.equal(shared.count, 21);
    assert.equal(solo.testCount, 1);
    assert.equal(solo.count, 5);
    // The per-test breakdown is ordered by occurrences, loudest first.
    assert.deepEqual(
        shared.tests.map((entry) => [entry.path, entry.count]),
        [['dir/one.js', 20], ['dir/two.js', 1]]
    );
});

test('--sort tests really reorders, and is not the occurrence order', () => {
    // Built so the two orders disagree: `loud` has more occurrences, `wide` is
    // in more tests. A `sort` parameter that was read but not used would return
    // the same order twice.
    const file = decodeErrors(
        buildErrorsFile([
            { kind: 'C++ warning', text: 'loud', file: 'a.cpp', line: 1, test: 'dir/one.js', counts: [1000] },
            { kind: 'C++ warning', text: 'wide', file: 'b.cpp', line: 2, test: 'dir/one.js', counts: [1] },
            { kind: 'C++ warning', text: 'wide', file: 'b.cpp', line: 2, test: 'dir/two.js', counts: [1] },
            { kind: 'C++ warning', text: 'wide', file: 'b.cpp', line: 2, test: 'dir/three.js', counts: [1] },
        ])
    );
    const byCount = rankErrors(file, { sort: 'occurrences' }).rows.map((row) => row.text);
    const bySpread = rankErrors(file, { sort: 'tests' }).rows.map((row) => row.text);
    assert.deepEqual(byCount, ['loud', 'wide']);
    assert.deepEqual(bySpread, ['wide', 'loud']);
    assert.notDeepEqual(byCount, bySpread);
});

test('the totals separate what matched from what the file holds', () => {
    const file = decodeErrors(errorsFixture('mochitest-2026-08-03-errors.json'));
    const all = rankErrors(file);
    // Golden: the fixture's counts sum to 15,224.
    assert.equal(all.totals.fileCount, 15_224);
    assert.equal(all.totals.matchedCount, 15_224);

    const filtered = rankErrors(file, { kind: 'console.error' });
    // The file total is a property of the file and must not move with a filter.
    assert.equal(filtered.totals.fileCount, 15_224);
    assert.equal(filtered.totals.matchedCount, 482);
    assert.ok(filtered.totals.matchedGroups < all.totals.matchedGroups);
});

test('matchesTest is a path or prefix match, never a bare substring', () => {
    assert.ok(matchesTest('netwerk/test/unit/test_a.js', 'netwerk/test/unit/test_a.js'));
    assert.ok(matchesTest('netwerk/test/unit/test_a.js', 'netwerk/test/unit'));
    assert.ok(matchesTest('netwerk/test/unit/test_a.js', 'netwerk/test/unit/'));
    assert.ok(matchesTest('netwerk/test/unit/test_a.js', 'netwerk'));
    // The discriminating cases: a bare substring, and a prefix that stops
    // mid-segment. `--test unit` must not select half the tree, and
    // `--test netwerk/test/un` must not match `netwerk/test/unit`.
    assert.ok(!matchesTest('netwerk/test/unit/test_a.js', 'unit'));
    assert.ok(!matchesTest('netwerk/test/unit/test_a.js', 'netwerk/test/un'));
    assert.ok(!matchesTest('netwerk/test/unit/test_a.js', 'test_a.js'));
});

// =========================================================================
// manifest statistics
// =========================================================================

test('the all-zero rule is every(), not some()', () => {
    // The discriminating input, which the fixture does not contain: a config
    // whose durations are *mixed*. Those zeros are runs that finished under the
    // timer's resolution, and the manifest plainly ran there — folding them
    // into "skipped" would drop real runs from the denominator.
    const file = decodeManifests(
        buildManifestsFile([
            { manifest: 'm.toml', config: 'test-linux/opt-x', durations: [0, 500, 0] },
            { manifest: 'm.toml', config: 'test-win/opt-x', durations: [0, 0, 0] },
        ])
    );
    const [stats] = computeManifestStats(file);
    const mixed = stats!.configs.find((c) => c.configuration === 'test-linux/opt-x')!;
    const allZero = stats!.configs.find((c) => c.configuration === 'test-win/opt-x')!;

    assert.equal(mixed.skipped, false, 'a mixed config ran; some() would call it skipped');
    // The zeros stay in the denominator: three runs, not one.
    assert.equal(mixed.durations!.runCount, 3);
    assert.equal(mixed.durations!.max, 500);

    assert.equal(allZero.skipped, true);
    assert.equal(allZero.durations, null);
    assert.deepEqual(stats!.skippedOn, ['test-win/opt-x']);
});

test('a skipped config reports no statistics rather than zeros', () => {
    const file = decodeManifests(
        buildManifestsFile([
            { manifest: 'm.toml', config: 'test-slow/opt-x', durations: [90_000] },
            { manifest: 'm.toml', config: 'test-skipped/opt-x', durations: [0, 0] },
        ])
    );
    const [stats] = computeManifestStats(file);
    const skipped = stats!.configs.find((c) => c.configuration === 'test-skipped/opt-x')!;
    // `null`, not `{median: 0, …}`. A zero median makes the config that did not
    // run the fastest row in the table, which inverts the answer to the only
    // question the command is asked.
    assert.equal(skipped.durations, null);
    // Skipped configs sort last, not first.
    assert.equal(stats!.configs[0]!.configuration, 'test-slow/opt-x');
    assert.equal(stats!.configs[stats!.configs.length - 1]!.skipped, true);
    // And the pooled statistics exclude the skipped runs entirely.
    assert.equal(stats!.runCount, 1);
    assert.equal(stats!.durations!.median, 90_000);
});

test('a manifest skipped everywhere has no durations and sorts last', () => {
    const file = decodeManifests(
        buildManifestsFile([
            { manifest: 'fast.toml', config: 'test-a/opt-x', durations: [10] },
            { manifest: 'gone.toml', config: 'test-a/opt-x', durations: [0, 0] },
            { manifest: 'slow.toml', config: 'test-a/opt-x', durations: [1000] },
        ])
    );
    const stats = computeManifestStats(file);
    const gone = stats.find((row) => row.manifest === 'gone.toml')!;
    assert.equal(gone.durations, null);
    assert.equal(gone.runCount, 0);

    for (const by of ['median', 'p95', 'max', 'total'] as const) {
        const sorted = sortManifests(stats, by);
        assert.equal(
            sorted[sorted.length - 1]!.manifest,
            'gone.toml',
            `sorting by ${by} must put a never-run manifest last`
        );
        assert.equal(sorted[0]!.manifest, 'slow.toml');
    }
    // …and `name` ignores durations entirely.
    assert.deepEqual(
        sortManifests(stats, 'name').map((row) => row.manifest),
        ['fast.toml', 'gone.toml', 'slow.toml']
    );
});

test('--slower-than drops a manifest that has no median at all', () => {
    const file = decodeManifests(
        buildManifestsFile([
            { manifest: 'gone.toml', config: 'test-a/opt-x', durations: [0, 0] },
            { manifest: 'slow.toml', config: 'test-a/opt-x', durations: [5000] },
        ])
    );
    const stats = computeManifestStats(file, { slowerThanMs: 1000 });
    // Treating an absent median as 0 would drop it too — but treating it as
    // Infinity, the other plausible mistake, would keep it.
    assert.deepEqual(stats.map((row) => row.manifest), ['slow.toml']);
});

test('summarize uses nearest-rank quantiles', () => {
    // Ten values 10…100. Nearest-rank p50 is the 5th (ceil(0.5*10) = 5) and p95
    // the 10th. A `floor` would give the 4th and the 9th — a plausible-looking
    // off-by-one that no fixture-level assertion would catch.
    const stats = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    assert.equal(stats.runCount, 10);
    assert.equal(stats.min, 10);
    assert.equal(stats.median, 50);
    assert.equal(stats.p95, 100);
    assert.equal(stats.max, 100);
    assert.equal(stats.total, 550);

    // A single value is its own everything.
    assert.deepEqual(summarize([7]), {
        runCount: 1, min: 7, median: 7, p95: 7, max: 7, total: 7,
    });
    assert.throws(() => summarize([]), /empty/);
});

test('summarize does not reorder its caller\'s array', () => {
    // The array passed in is the accumulator and is still being pooled.
    const durations = [3, 1, 2];
    summarize(durations);
    assert.deepEqual(durations, [3, 1, 2]);
});

test('the zero-duration census matches the fixture', () => {
    const file = decodeManifests(manifestsFixture());
    // Golden from the raw arrays: 18 of 200 runs are zero, and they form 18
    // all-zero pairs out of 200.
    assert.deepEqual(zeroDurationCensus(file), {
        zeroRuns: 18,
        totalRuns: 200,
        skippedPairs: 18,
        totalPairs: 200,
    });
});

test('the decoder exposes both job names, and they differ', () => {
    const file = decodeManifests(manifestsFixture());
    const runs = [...file.runs()];
    // Golden: 191 of the fixture's 200 runs have names that differ, and all 200
    // agree once the task's chunk suffix is stripped. Aggregating on the wrong
    // one silently splits configurations.
    const differing = runs.filter((run) => run.configuration !== run.jobName);
    assert.equal(differing.length, 191);
    const strip = (name: string): string => {
        const slash = name.indexOf('/');
        return slash === -1
            ? name
            : name.slice(0, slash + 1) + name.slice(slash + 1).replace(/-\d+$/, '');
    };
    for (const run of runs) {
        assert.equal(run.configuration, strip(run.jobName));
    }
});

test('aggregation keys on the chunk-stripped name', () => {
    const file = decodeManifests(manifestsFixture());
    for (const stats of computeManifestStats(file)) {
        for (const config of stats.configs) {
            assert.doesNotMatch(
                config.configuration,
                /-\d+$/,
                `${config.configuration} kept a chunk suffix`
            );
        }
    }
});

test('the manifests decoder throws on non-parallel arrays', () => {
    const raw = manifestsFixture();
    raw.runs.durations = raw.runs.durations.slice(0, -1);
    assert.throws(() => decodeManifests(raw), /not parallel/);
});

// =========================================================================
// builders
// =========================================================================

/** One synthetic marker group. */
interface MarkerSpec {
    kind: string;
    text: string | null;
    file: string | null;
    line: number | null;
    test?: string;
    counts?: number[];
}

/**
 * Builds a minimal errors file from message specs.
 *
 * Hand-built rather than mutated from a fixture, because the cases these
 * exercise — a line with no file, one text at two locations — are ones the
 * fixtures do not happen to contain. The shape is the published one; only the
 * contents are chosen.
 */
function buildErrorsFile(specs: MarkerSpec[]): ErrorsFile {
    const texts: string[] = [];
    const files: string[] = [];
    const kinds: string[] = [];
    const testPaths: string[] = [];
    const testNames: string[] = [];
    const intern = (table: string[], value: string): number => {
        const at = table.indexOf(value);
        return at === -1 ? table.push(value) - 1 : at;
    };

    const testInfo = {
        testPathIds: [] as number[],
        testNameIds: [] as number[],
        componentIds: [] as (number | null)[],
    };
    const messages = {
        markerNameIds: [] as number[],
        textIds: [] as (number | null)[],
        fileIds: [] as (number | null)[],
        lines: [] as (number | null)[],
        componentIds: [] as (number | null)[],
    };
    const markers = {
        testIds: [] as number[],
        messageIds: [] as number[],
        taskIdIds: [] as number[][],
        counts: [] as number[][],
    };

    /** Interns a test path, returning its index in `testInfo`. */
    const internTest = (path: string): number => {
        const slash = path.lastIndexOf('/');
        const dirId = intern(testPaths, slash === -1 ? '' : path.slice(0, slash));
        const nameId = intern(testNames, slash === -1 ? path : path.slice(slash + 1));
        for (let i = 0; i < testInfo.testPathIds.length; i++) {
            if (testInfo.testPathIds[i] === dirId && testInfo.testNameIds[i] === nameId) {
                return i;
            }
        }
        testInfo.testPathIds.push(dirId);
        testInfo.testNameIds.push(nameId);
        testInfo.componentIds.push(null);
        return testInfo.testPathIds.length - 1;
    };

    for (const spec of specs) {
        messages.markerNameIds.push(intern(kinds, spec.kind));
        messages.textIds.push(spec.text === null ? null : intern(texts, spec.text));
        messages.fileIds.push(spec.file === null ? null : intern(files, spec.file));
        messages.lines.push(spec.line);
        messages.componentIds.push(null);

        const counts = spec.counts ?? [1];
        markers.testIds.push(internTest(spec.test ?? 'dir/test_default.js'));
        markers.messageIds.push(messages.markerNameIds.length - 1);
        // Delta-encoded from 0, as the format stores them: the first entry is
        // absolute and later ones are increments.
        markers.taskIdIds.push(counts.map((_, i) => (i === 0 ? 0 : 1)));
        markers.counts.push(counts);
    }

    const taskCount = Math.max(1, ...markers.taskIdIds.map((ids) => ids.length));
    const markerCounts: Record<string, number> = {};
    for (let g = 0; g < markers.counts.length; g++) {
        const kind = kinds[messages.markerNameIds[markers.messageIds[g]!]!]!;
        markerCounts[kind] =
            (markerCounts[kind] ?? 0) + markers.counts[g]!.reduce((a, b) => a + b, 0);
    }

    return {
        metadata: {
            date: '2026-08-03',
            startTime: 0,
            generatedAt: '2026-08-04T00:00:00.000Z',
            jobCount: taskCount,
            processedJobCount: taskCount,
            invalidJobCount: 0,
            markerCounts,
        },
        tables: {
            jobNames: ['test-linux/opt-x'],
            testPaths,
            testNames,
            repositories: ['mozilla-central'],
            taskIds: Array.from({ length: taskCount }, (_, i) => `TASK${i}.0`),
            components: [],
            commitIds: ['abc'],
            markerNames: kinds,
            messageTexts: texts,
            files,
        },
        messages,
        taskInfo: {
            repositoryIds: Array.from({ length: taskCount }, () => 0),
            jobNameIds: Array.from({ length: taskCount }, () => 0),
            commitIds: Array.from({ length: taskCount }, () => 0),
        },
        testInfo,
        markers,
    };
}

/** One synthetic (manifest, config) pair with its durations. */
interface ManifestSpec {
    manifest: string;
    config: string;
    durations: number[];
}

/**
 * Builds a minimal `manifests.json`.
 *
 * `config` is the chunk-stripped configuration; the task's job name gets a
 * `-1` chunk suffix appended, mirroring the real file where the two differ on
 * 83% of runs.
 */
function buildManifestsFile(specs: ManifestSpec[]): ManifestsFile {
    const manifests: string[] = [];
    const jobNames: string[] = [];
    const taskIds: string[] = [];
    const intern = (table: string[], value: string): number => {
        const at = table.indexOf(value);
        return at === -1 ? table.push(value) - 1 : at;
    };

    const tasks = { id: [] as string[], jobName: [] as number[], commitId: [] as number[], prefix: [] as number[] };
    const runs = {
        manifestIds: [] as number[],
        jobNameIds: [] as number[],
        taskIds: [] as number[],
        durations: [] as number[],
    };

    for (const spec of specs) {
        const manifestId = intern(manifests, spec.manifest);
        const configId = intern(jobNames, spec.config);
        // The chunked name the task carries, which must not be what
        // aggregation keys on.
        const chunkedId = intern(jobNames, `${spec.config}-1`);
        spec.durations.forEach((duration, i) => {
            const taskName = `${spec.config}#${i}`;
            let taskIndex = taskIds.indexOf(taskName);
            if (taskIndex === -1) {
                taskIndex = taskIds.push(taskName) - 1;
                tasks.id.push(`TASK${taskIndex}`);
                tasks.jobName.push(chunkedId);
                tasks.commitId.push(0);
                tasks.prefix.push(0);
            }
            runs.manifestIds.push(manifestId);
            runs.jobNameIds.push(configId);
            runs.taskIds.push(taskIndex);
            runs.durations.push(duration);
        });
    }

    return {
        metadata: {
            date: '2026-08-03',
            repository: 'mozilla-central',
            generatedAt: '2026-08-04T00:00:00.000Z',
            processedJobCount: tasks.id.length,
            failedJobCount: 0,
        },
        manifests,
        jobNames,
        commits: ['abc'],
        prefixes: ['xpcshell'],
        tasks,
        runs,
    };
}
