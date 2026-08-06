/**
 * `site/manifests.html` against `fx-tests manifests` — `PARITY.md` §5.
 *
 * The comparison the migration exists to make: both sides now answer "which
 * manifest is eating a job's time budget" from the same file, so a disagreement
 * is a real difference in what one of them decided rather than an artefact of
 * the page's logic being inline and untestable.
 *
 * ## The three classes, and which tests cover which
 *
 * `PARITY.md` §1 names three, and all three are here because four of the six
 * reported defects produced *correct numbers*:
 *
 * 1. **Value parity** — the same manifests, the same run counts, the same set
 *    of skipped (manifest, job) pairs, asserted over the whole ranking rather
 *    than on a spot check.
 * 2. **Order parity** — the full ranked sequence, compared position by
 *    position, because the sort-key defect produced the same set in a different
 *    order and would pass any set comparison.
 * 3. **Framing parity** — (row unit, grouping, sort key, direction, window)
 *    derived from the page and asserted against the CLI. This is the check that
 *    was missing when `issues` shipped with the wrong question.
 *
 * ## The one value that genuinely differs, and why it is here
 *
 * **The median.** The page takes the upper middle element and
 * `lib/query/manifest-stats.ts` the nearest-rank quantile, which is the lower
 * middle for an even sample. That is declared as a divergence with its
 * measurement rather than smoothed over, and `assertDeclaredDivergences` fails
 * if it ever stops diverging — because a stale exception is where the next
 * regression hides.
 *
 * `test/framing.test.ts:437-440` states the opposite: "The CLI's `medianOf`
 * matches it deliberately". No function of that name exists in `lib/` or
 * `cli/`, and `test/step5-query.test.ts:401` pins the CLI's rule to nearest
 * rank. That comment is wrong; this file measures the truth so that the claim
 * cannot be believed twice.
 *
 * ## The data is pinned, and an unpinned request fails loudly
 *
 * Two checked-in fixtures, read from disk. No network and no cache: the page's
 * file is published only as "the latest", so a test that fetched it would
 * compare a different day on every run.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { duration as cliDuration } from '../cli/commands/manifests.ts';
import { type ManifestsFile, decodeManifests } from '../lib/formats/manifests.ts';
import {
    type ManifestStats,
    computeManifestStats,
    sortManifests,
    summarize,
} from '../lib/query/manifest-stats.ts';
import {
    type ManifestRow,
    DEFAULT_SORT,
    buildManifestRows,
    formatDuration as pageDuration,
    medianOf,
    sortRows,
} from '../site/manifests-view.ts';
import { type Divergence, assertDeclaredDivergences, assertSameOrder } from './parity-harness.ts';

/**
 * Both pinned files.
 *
 * `manifests.json` is the shared truncation — 200 runs over 200 one-job
 * manifests — and `manifests-pathology.json` is the migration's own selection,
 * whose whole purpose is the shapes the first one lacks. Both are compared,
 * because the degenerate one is where an even/odd median difference cannot
 * appear and the other is where it does.
 */
const FIXTURES = ['manifests.json', 'manifests-pathology.json'] as const;

function load(name: string): ManifestsFile {
    return JSON.parse(
        readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    ) as ManifestsFile;
}

/** The page's rows, by manifest. */
function pageRows(file: ManifestsFile): Map<string, ManifestRow> {
    return new Map(buildManifestRows(file).map((row) => [row.manifest, row]));
}

/** The CLI's rows, by manifest. */
function cliRows(file: ManifestsFile): Map<string, ManifestStats> {
    return new Map(
        computeManifestStats(decodeManifests(structuredClone(file))).map((row) => [
            row.manifest,
            row,
        ])
    );
}

// =========================================================================
// 1. Value parity
// =========================================================================

test('both sides find the same manifests', () => {
    for (const name of FIXTURES) {
        const file = load(name);
        const page = [...pageRows(file).keys()].sort();
        const cli = [...cliRows(file).keys()].sort();
        assert.deepEqual(page, cli, name);
        // Non-empty, or the comparison above is vacuous.
        assert.ok(page.length > 0, `${name}: no manifests`);
    }
});

test('both sides classify exactly the same (manifest, job) pairs as skipped', () => {
    // The rule that changes a sixth of the data, and the one thing both sides
    // genuinely share a definition of. A disagreement here would mean one of
    // them reads `any` where the other reads `every`.
    for (const name of FIXTURES) {
        const file = load(name);
        const page = pageRows(file);
        const cli = cliRows(file);

        const pageSkipped: string[] = [];
        for (const [manifest, row] of page) {
            for (const job of row.jobStats) {
                if (job.skipped) {
                    pageSkipped.push(`${manifest}${job.jobName}`);
                }
            }
        }
        const cliSkipped: string[] = [];
        for (const [manifest, row] of cli) {
            for (const config of row.skippedOn) {
                cliSkipped.push(`${manifest}${config}`);
            }
        }
        pageSkipped.sort();
        cliSkipped.sort();
        assert.deepEqual(pageSkipped, cliSkipped, name);
        assert.ok(pageSkipped.length > 0, `${name}: no skipped pairs, so this proves nothing`);
    }
});

test('both sides agree on which manifests ran nowhere at all', () => {
    for (const name of FIXTURES) {
        const file = load(name);
        const page = [...pageRows(file).values()]
            .filter((row) => row.allSkipped)
            .map((row) => row.manifest)
            .sort();
        const cli = [...cliRows(file).values()]
            .filter((row) => row.durations === null)
            .map((row) => row.manifest)
            .sort();
        assert.deepEqual(page, cli, name);
    }
});

test('both sides count the same runs, on the same configurations', () => {
    for (const name of FIXTURES) {
        const file = load(name);
        const page = pageRows(file);
        const cli = cliRows(file);
        for (const [manifest, row] of page) {
            const other = cli.get(manifest)!;
            // Runs on pairs that ran. A side that included the skipped pairs
            // reports a larger number here.
            assert.equal(row.totalRuns, other.runCount, `${manifest} (${name}): runCount`);
            // Configurations it ran on. The page calls this Job Types.
            assert.equal(
                row.totalJobs,
                other.configs.filter((config) => !config.skipped).length,
                `${manifest} (${name}): configurations that ran`
            );
            // Every pair is present on both sides, skipped ones included.
            assert.equal(
                row.jobStats.length,
                other.configs.length,
                `${manifest} (${name}): total pairs`
            );
            assert.deepEqual(
                row.jobStats.map((job) => job.jobName).sort(),
                other.configs.map((config) => config.configuration).sort(),
                `${manifest} (${name}): the configurations themselves`
            );
        }
    }
});

test('both sides agree on every per-pair run count', () => {
    for (const name of FIXTURES) {
        const file = load(name);
        const cli = cliRows(file);
        for (const [manifest, row] of pageRows(file)) {
            const configs = new Map(
                cli.get(manifest)!.configs.map((config) => [config.configuration, config])
            );
            for (const job of row.jobStats) {
                assert.equal(
                    job.runCount,
                    configs.get(job.jobName)!.runCount,
                    `${manifest} / ${job.jobName} (${name})`
                );
            }
        }
    }
});

test('the medians agree on every odd-length sample and differ only on even ones', () => {
    // The precise shape of the disagreement, rather than "they sometimes
    // differ": if a difference ever showed up on an *odd* sample the cause
    // would be a real bug in one of them rather than the known rule.
    let odd = 0;
    let evenSame = 0;
    let evenDifferent = 0;
    for (const name of FIXTURES) {
        const file = load(name);
        const cli = cliRows(file);
        for (const [manifest, row] of pageRows(file)) {
            const configs = new Map(
                cli.get(manifest)!.configs.map((config) => [config.configuration, config])
            );
            for (const job of row.jobStats) {
                const other = configs.get(job.jobName)!;
                if (job.skipped) {
                    assert.equal(other.skipped, true);
                    assert.equal(other.durations, null, 'a skipped pair reports no statistics');
                    continue;
                }
                const count = job.runCount;
                const same = job.median === other.durations!.median;
                if (count % 2 === 1) {
                    assert.ok(
                        same,
                        `${manifest} / ${job.jobName} (${name}): ${count} runs is odd, so the ` +
                            `two median rules must agree — got ${job.median} and ` +
                            `${other.durations!.median}`
                    );
                    odd += 1;
                } else if (same) {
                    // An even sample whose two middle values happen to be equal.
                    evenSame += 1;
                } else {
                    // The page takes the upper of the two, so it is never lower.
                    assert.ok(
                        job.median! > other.durations!.median,
                        `${manifest} / ${job.jobName}: the page's median should be the higher one`
                    );
                    evenDifferent += 1;
                }
            }
        }
    }
    // The fixtures really do exercise both, or the assertions above are empty.
    assert.ok(odd > 0, 'no odd-length sample in either fixture');
    assert.ok(
        evenDifferent > 0,
        'no even-length sample where the rules disagree, so the divergence is untested'
    );
    void evenSame;
});

test('the two median rules are what this file says they are', () => {
    // Spelled out on a literal, independently of any fixture, so the divergence
    // below cannot be explained away as a fixture artefact.
    const sample = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    assert.equal(medianOf(sample), 60, 'the page: the upper middle');
    assert.equal(summarize(sample).median, 50, 'the CLI: nearest rank, the lower middle');
});

// =========================================================================
// 2. Order parity
// =========================================================================

test('the default ranking is the same sequence on both sides, up to the median rule', () => {
    for (const name of FIXTURES) {
        const file = load(name);
        // Both sorted by median, descending — the page's default and the CLI's.
        const page = sortRows(buildManifestRows(file), DEFAULT_SORT).map((row) => row.manifest);
        const cli = sortManifests([...cliRows(file).values()], 'median').map((row) => row.manifest);

        // Not `assertSameOrder` directly: the CLI breaks ties on the manifest
        // path and the page does not (divergence: "tie-break"), and the two
        // median rules put a handful of rows in a different place. So the
        // comparison that is meaningful is over the rows whose median the two
        // sides agree on *and* which have no tie — checked by comparing the
        // ranked medians rather than the names.
        const pageRowsByName = pageRows(file);
        const pageMedians = page.map((manifest) => pageRowsByName.get(manifest)!.overallMedian);
        // A descending sequence, with the absent ones last: this is the
        // property the ranking has to have, on both sides.
        for (let i = 1; i < pageMedians.length; i++) {
            const previous = pageMedians[i - 1]!;
            const current = pageMedians[i]!;
            if (previous === null) {
                assert.equal(current, null, `${name}: a ranked row follows a skipped one`);
            } else if (current !== null) {
                assert.ok(previous >= current, `${name}: the page's ranking is not descending`);
            }
        }
        assert.equal(page.length, cli.length, name);
        // The two agree on which manifest is worst, which is the question the
        // command is for. Ties on the top median would make this fragile, so it
        // is asserted only when the top median is unique.
        const cliStats = cliRows(file);
        const topMedian = cliStats.get(cli[0]!)!.durations?.median;
        const tiedAtTop = [...cliStats.values()].filter(
            (row) => row.durations?.median === topMedian
        ).length;
        if (tiedAtTop === 1) {
            assert.equal(page[0], cli[0], `${name}: the slowest manifest`);
        }
    }
});

test('ranking by runs is the same sequence on both sides', () => {
    // `runs` has no median rule in it, so this one is an exact order
    // comparison — and it is the check that would have caught the sort-key
    // defect, which produced the same set in a different order.
    for (const name of FIXTURES) {
        const file = load(name);
        const page = sortRows(buildManifestRows(file), { column: 'runs', ascending: false });
        const cli = sortManifests([...cliRows(file).values()], 'runs');

        // The CLI breaks ties on the name and the page does not, so the
        // sequences are compared after applying the same tie-break to both —
        // which leaves the *key* being compared, not the tie policy.
        const key = (manifest: string, runs: number): string => `${runs}${manifest}`;
        assertSameOrder(
            [...page]
                .sort((a, b) => b.totalRuns - a.totalRuns || a.manifest.localeCompare(b.manifest))
                .map((row) => key(row.manifest, row.totalRuns)),
            cli.map((row) => key(row.manifest, row.runCount)),
            `${name}: ranking by runs`
        );
    }
});

test('ranking by name is the same sequence on both sides', () => {
    for (const name of FIXTURES) {
        const file = load(name);
        assertSameOrder(
            sortRows(buildManifestRows(file), { column: 'manifest', ascending: true }).map(
                (row) => row.manifest
            ),
            sortManifests([...cliRows(file).values()], 'name').map((row) => row.manifest),
            `${name}: ranking by name`
        );
    }
});

test('a manifest that ran nowhere is last on both sides, under every key', () => {
    for (const name of FIXTURES) {
        const file = load(name);
        const skipped = new Set(
            [...pageRows(file).values()].filter((row) => row.allSkipped).map((row) => row.manifest)
        );
        if (skipped.size === 0) {
            continue;
        }
        // The CLI, descending — its only direction.
        const cli = sortManifests([...cliRows(file).values()], 'median').map((row) => row.manifest);
        assert.ok(
            cli.slice(-skipped.size).every((manifest) => skipped.has(manifest)),
            `${name}: the CLI does not put them last`
        );
        // The page, in **both** directions — which the CLI has no analogue for
        // and which is where the page's own defect was.
        for (const ascending of [true, false]) {
            const page = sortRows(buildManifestRows(file), { column: 'median', ascending }).map(
                (row) => row.manifest
            );
            assert.ok(
                page.slice(-skipped.size).every((manifest) => skipped.has(manifest)),
                `${name}: the page does not put them last, ascending=${ascending}`
            );
        }
    }
});

// =========================================================================
// 3. Framing parity
// =========================================================================

/** What question a side asks, in the terms `PARITY.md` §5 names. */
interface Framing {
    rowUnit: string;
    subRowUnit: string | null;
    sortKey: string;
    sortDirection: string;
    window: string;
    skippedRule: string;
}

test('both sides ask the same question, at the same level of aggregation', () => {
    // Derived from the page: `ManifestRow` is one manifest path, `JobStats` one
    // configuration, `DEFAULT_SORT` is median descending, the file is one day.
    const page: Framing = {
        rowUnit: 'manifest path',
        subRowUnit: 'configuration (chunk-stripped job name)',
        sortKey: DEFAULT_SORT.column,
        sortDirection: DEFAULT_SORT.ascending ? 'asc' : 'desc',
        window: 'a single artifact — one day, no date control',
        skippedRule: 'all-zero-duration pairs are skipped, excluded from stats, sorted last',
    };
    // Derived from the CLI: `cli/commands/manifests.ts:217` defaults `--sort` to
    // median, `sortManifests` is descending for every numeric key, and
    // `ManifestStats.configs` is one entry per configuration.
    const cli: Framing = {
        rowUnit: 'manifest path',
        subRowUnit: 'configuration (chunk-stripped job name)',
        sortKey: 'median',
        sortDirection: 'desc',
        window: 'a single artifact — one day, no date control',
        skippedRule: 'all-zero-duration pairs are skipped, excluded from stats, sorted last',
    };
    assert.deepEqual(page, cli);
});

test('every one of the page`s sortable columns has a CLI analogue, or is declared', () => {
    // `PARITY.md` §5: flags map to controls. The page's five headers against
    // the CLI's `--sort` values (`cli/commands/manifests.ts:218`).
    const pageColumns = ['manifest', 'jobTypes', 'runs', 'median', 'mean'];
    const cliSorts = ['median', 'p95', 'max', 'runs', 'total', 'name'];
    const mapping: Record<string, string | null> = {
        manifest: 'name',
        runs: 'runs',
        median: 'median',
        // No CLI analogue, and no page analogue for three of the CLI's.
        jobTypes: null,
        mean: null,
    };
    for (const column of pageColumns) {
        const analogue = mapping[column];
        if (analogue !== null && analogue !== undefined) {
            assert.ok(cliSorts.includes(analogue), `${column} maps to a real --sort`);
        }
    }
    // And the reverse direction, so a new CLI sort does not go unnoticed: the
    // CLI has three keys the page cannot sort by.
    assert.deepEqual(
        cliSorts.filter((sort) => !Object.values(mapping).includes(sort)),
        ['p95', 'max', 'total']
    );
});

// =========================================================================
// The declared divergences
// =========================================================================

test('every declared divergence still diverges', () => {
    const file = load('manifests-pathology.json');
    const page = pageRows(file);
    const cli = cliRows(file);

    // The (manifest, job) pair with an even run count whose two middle
    // durations differ — found here rather than hardcoded, so a regenerated
    // fixture moves the example instead of breaking the test.
    let medianExample: { pageMedian: number; cliMedian: number } | null = null;
    for (const [manifest, row] of page) {
        const configs = new Map(
            cli.get(manifest)!.configs.map((config) => [config.configuration, config])
        );
        for (const job of row.jobStats) {
            if (job.skipped) {
                continue;
            }
            const other = configs.get(job.jobName)!;
            if (job.median !== other.durations!.median) {
                medianExample = {
                    pageMedian: job.median!,
                    cliMedian: other.durations!.median,
                };
                break;
            }
        }
        if (medianExample !== null) {
            break;
        }
    }
    assert.notEqual(medianExample, null, 'the fixture no longer exercises the median divergence');

    const divergences: Divergence[] = [
        {
            what: 'the median of an even-length sample',
            reason:
                'The page takes the upper middle element (manifests.html:429) and the CLI the ' +
                'nearest-rank quantile (lib/query/manifest-stats.ts:302), which is the lower ' +
                'middle. They agree on every odd sample and differ on every even one — measured ' +
                'on the pinned 2026-08-04 file, 3,122 of 6,227 manifests get a different overall ' +
                'median. Both rules are deliberate: test/step5-query.test.ts:401 pins the CLI\'s, ' +
                'and changing the page\'s would move every even-sample number on a dashboard in ' +
                'daily use. Unifying is a decision to take once, not silently inside a migration.',
            page: medianExample!.pageMedian,
            cli: medianExample!.cliMedian,
        },
        {
            what: 'the tie-break on equal sort keys',
            reason:
                'sortManifests breaks a tie on the manifest path (lib/query/manifest-stats.ts:255, ' +
                ':272); the page leaves tied rows in the order the file produced them, as ' +
                'manifests.html:495-506 does. Adding one to the page would reorder real rows ' +
                'against the page being compared, for a stability the stable sort already gives ' +
                'from a deterministic input order. The CLI wants it because its output is a ' +
                'short ranked list a reader diffs between runs.',
            page: 'input order',
            cli: 'manifest path',
        },
        {
            what: 'the statistics each side computes per pair',
            reason:
                'The page shows a mean, which DurationStats does not have, and the CLI shows ' +
                'p95, max and total, which the page has no column for. Neither is missing ' +
                'anything: the page answers "how long does this usually take here" for a reader ' +
                'scanning a table, and the CLI answers "what is the tail costing" for someone ' +
                'sizing a timeout. Adding a mean to DurationStats for one page, or three columns ' +
                'to the page for the CLI, would serve neither.',
            page: ['median', 'mean'],
            cli: ['min', 'median', 'p95', 'max', 'total'],
        },
        {
            what: 'how a duration is rendered',
            reason:
                'formatDuration floors the seconds of a minute value and has no hour form, so ' +
                '7,200,000 ms is "120m 0s"; the CLI rounds, pads to two digits and has an hour ' +
                'form, giving "2h 00m". Presentation only — every value comparison in this file ' +
                'is on the milliseconds — and the page keeps its own because changing it changes ' +
                'every cell on a page in daily use. The CLI side is now ' +
                'lib/model/duration.ts formatDurationPadded, shared with nothing else; the ' +
                'page keeps its own copy in site/manifests-view.ts precisely because this ' +
                'divergence is what the difference between them is.',
            page: '120m 0s',
            cli: '2h 00m',
        },
    ];
    assertDeclaredDivergences('manifests', divergences);
});

/**
 * A CLI defect this comparison found, **now fixed**, pinned so it cannot return.
 *
 * `cli/commands/manifests.ts:471` used to compute the seconds part of a
 * `Xm YYs` value with `Math.round(seconds - minutes * 60)`, which reaches
 * **60** whenever the fractional part is at least .5 — so `119,900 ms` printed
 * as `1m 60s` and `3,599,900 ms` as `59m 60s`. Neither is a duration.
 *
 * `formatDuration` on the page floors instead and gives `1m 59s`, which is why
 * this surfaced here rather than in the CLI's own tests: the two sides format
 * the same milliseconds and only one of them could be read aloud.
 *
 * The implementation now lives in `lib/model/duration.ts` as
 * `formatDurationPadded`, which rounds the total to whole seconds *before*
 * splitting it, so no field can reach its own modulus. `cliDuration` is that
 * function under the CLI's name.
 *
 * The expectations below are literals rather than anything derived from the
 * formatter: an implementation that still carried would satisfy a computed
 * expectation, which is the whole failure mode this file guards against.
 */
test('neither side renders a 60 in a subordinate field', () => {
    // The two values that were wrong, with what they must now say.
    assert.equal(cliDuration(119_900), '2m 00s');
    assert.equal(cliDuration(3_599_900), '1h 00m');
    // And the neighbours that were already right, so a fix that simply shifted
    // the boundary by one does not pass.
    assert.equal(cliDuration(119_400), '1m 59s');
    assert.equal(cliDuration(119_500), '2m 00s');
    assert.equal(cliDuration(3_599_400), '59m 59s');
    assert.equal(cliDuration(3_599_500), '1h 00m');

    // Exhaustive over every integer millisecond of the first two hours, which
    // covers both carry points. `pageDuration` floors and never produced a 60;
    // `cliDuration` rounds and used to.
    for (let ms = 0; ms < 7_200_000; ms++) {
        assert.doesNotMatch(cliDuration(ms), /\b60s$|\b60m$/, `cli, ${ms} ms`);
        assert.doesNotMatch(pageDuration(ms), /\b60s$|\b60m$/, `page, ${ms} ms`);
    }
});
