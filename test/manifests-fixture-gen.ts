/**
 * Builds `test/fixtures/manifests-pathology.json` from a real `manifests.json`.
 *
 * Not a test — the name does not end in `.test.ts`, so the runner does not pick
 * it up. It is here rather than in `tools/` because it is specific to the
 * manifests page's fixture and because `tools/make-fixtures.ts` is shared.
 *
 * ## Why a second manifests fixture exists
 *
 * `test/fixtures/manifests.json` is `truncateManifests(…, 200)`: **the first
 * 200 runs** of the published file. Measured on it, that lands on **200
 * manifests with exactly one job and one run each** — jobs-per-manifest is 1 at
 * both the minimum and the maximum. A fixture of that shape cannot exercise:
 *
 * - multi-job expansion (there is never a second sub-row),
 * - a job-name search that *narrows* an expanded row (every row has one job, so
 *   the filter either keeps it or empties it),
 * - a scatter with more than one point,
 * - the ran/skipped mix inside one manifest,
 * - an even-length duration sample, where the page's median rule and the CLI's
 *   disagree.
 *
 * A page test on it would pass with the sub-row filter deleted, which is the
 * failure mode this project has measured: an assertion that "keeps rows whole"
 * while never checking that non-matching rows disappear.
 *
 * So this selects manifests **for those shapes**, and each entry records why it
 * is there — the discipline `PARITY.md` §6 asks of the push corpus. A shape the
 * source file cannot supply makes this script **throw** rather than quietly
 * emit fewer, because a fixture that silently lost its pathology is worse than
 * no fixture.
 *
 * ## Regenerating
 *
 * ```
 * curl -o /tmp/manifests.json \
 *   'https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/gecko.v2.mozilla-central.latest.source.test-info-manifest-timings/artifacts/public/manifests.json'
 * node --experimental-strip-types test/manifests-fixture-gen.ts /tmp/manifests.json
 * ```
 *
 * The checked-in copy was built from the **2026-08-04** file (6,227 manifests,
 * 494,380 runs). `test/manifests-page.test.ts` asserts the fixture's own
 * `metadata.date` and counts, so a regenerated fixture fails loudly rather than
 * comparing a different day.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import type { ManifestsFile } from '../lib/formats/manifests.ts';

/** What a manifest looks like, for choosing which ones to keep. */
interface Shape {
    /** Distinct (manifest, job) pairs. */
    jobs: number;
    /** Pairs whose durations were all zero. */
    skipped: number;
    /** Pairs that ran. */
    ran: number;
    /** Pairs that ran and hold an even number of runs — the median disagreement. */
    evenPairs: number;
    runs: number;
}

/** One reason a manifest is in the fixture, and how many to take for it. */
interface Want {
    why: string;
    count: number;
    matches: (shape: Shape, jobNames: readonly string[]) => boolean;
}

const WANTED: Want[] = [
    {
        why: 'many jobs, all of which ran: multi-job expansion and job filtering',
        count: 3,
        matches: (shape) => shape.ran >= 8 && shape.skipped === 0,
    },
    {
        why: 'a mix of ran and skipped jobs: the SKIP row and the ordering rule',
        count: 4,
        matches: (shape) => shape.ran >= 3 && shape.skipped >= 2,
    },
    {
        why: 'skipped on every job: the no-runtime-at-all row that must sort last',
        count: 4,
        matches: (shape) => shape.ran === 0 && shape.jobs >= 2,
    },
    {
        why: 'an even-length duration sample: where the two median rules disagree',
        count: 4,
        matches: (shape) => shape.evenPairs >= 1 && shape.ran >= 2,
    },
    {
        why: 'a single job with several runs: a scatter with more than one point',
        // Two, not three: measured on the 2026-08-04 file, **2 of 6,227**
        // manifests run exactly one job. Asking for three fails the run.
        count: 2,
        matches: (shape) => shape.jobs === 1 && shape.runs >= 3,
    },
    {
        why: 'runs a wdspec job: a needle that matches some manifests and not others',
        count: 4,
        matches: (shape, jobNames) =>
            shape.ran >= 2 && jobNames.some((name) => name.includes('wdspec')),
    },
    // A one-job, one-run manifest is **not** here: measured, **0 of 6,227**,
    // because every job in this file ran three times. That degenerate case is
    // covered by the hand-authored `fast.toml` in `test/manifests-view.test.ts`
    // instead of by pretending the corpus has one.
];

/** Remaps a string table to only the entries the kept runs reference. */
function remap(table: readonly string[]): {
    map: (index: number) => number;
    build: () => string[];
    order: () => number[];
} {
    const seen = new Map<number, number>();
    const out: string[] = [];
    return {
        map(index: number): number {
            const existing = seen.get(index);
            if (existing !== undefined) {
                return existing;
            }
            const next = out.length;
            seen.set(index, next);
            out.push(table[index]!);
            return next;
        },
        build: (): string[] => out,
        order: (): number[] => [...seen.keys()],
    };
}

/** Selects the manifests and rebuilds a self-contained file over their runs. */
export function buildPathologyFixture(source: ManifestsFile): {
    file: ManifestsFile;
    chosen: { manifest: string; why: string; shape: Shape }[];
} {
    const byManifest = new Map<string, number[]>();
    for (let i = 0; i < source.runs.durations.length; i++) {
        const manifest = source.manifests[source.runs.manifestIds[i]!]!;
        const existing = byManifest.get(manifest);
        if (existing === undefined) {
            byManifest.set(manifest, [i]);
        } else {
            existing.push(i);
        }
    }

    const shapeOf = (indices: readonly number[]): { shape: Shape; jobNames: string[] } => {
        const jobs = new Map<string, number[]>();
        for (const i of indices) {
            const job = source.jobNames[source.runs.jobNameIds[i]!]!;
            const existing = jobs.get(job);
            if (existing === undefined) {
                jobs.set(job, [source.runs.durations[i]!]);
            } else {
                existing.push(source.runs.durations[i]!);
            }
        }
        const values = [...jobs.values()];
        const skipped = values.filter((d) => d.every((x) => x === 0)).length;
        return {
            shape: {
                jobs: jobs.size,
                skipped,
                ran: jobs.size - skipped,
                evenPairs: values.filter((d) => !d.every((x) => x === 0) && d.length % 2 === 0)
                    .length,
                runs: indices.length,
            },
            jobNames: [...jobs.keys()],
        };
    };

    const chosen: { manifest: string; why: string; shape: Shape }[] = [];
    const taken = new Set<string>();
    for (const want of WANTED) {
        let count = 0;
        for (const [manifest, indices] of byManifest) {
            if (count >= want.count) {
                break;
            }
            if (taken.has(manifest)) {
                continue;
            }
            const { shape, jobNames } = shapeOf(indices);
            if (!want.matches(shape, jobNames)) {
                continue;
            }
            taken.add(manifest);
            chosen.push({ manifest, why: want.why, shape });
            count += 1;
        }
        if (count < want.count) {
            // Loudly. A fixture that lost a pathology still passes every test
            // written against it, which is the whole failure mode.
            throw new Error(
                `only found ${count} of ${want.count} manifests for: ${want.why}. ` +
                    'The source file does not have this shape; fix the count or the predicate ' +
                    'rather than shipping a fixture that cannot exercise it.'
            );
        }
    }

    const runIndices = chosen.flatMap(({ manifest }) => byManifest.get(manifest)!);
    runIndices.sort((a, b) => a - b);

    const manifests = remap(source.manifests);
    const jobNames = remap(source.jobNames);
    const commits = remap(source.commits);
    const prefixes = remap(source.prefixes);
    const tasks = remap(source.tasks.id);

    const runs = {
        manifestIds: [] as number[],
        jobNameIds: [] as number[],
        taskIds: [] as number[],
        durations: [] as number[],
    };
    for (const i of runIndices) {
        runs.manifestIds.push(manifests.map(source.runs.manifestIds[i]!));
        runs.jobNameIds.push(jobNames.map(source.runs.jobNameIds[i]!));
        runs.taskIds.push(tasks.map(source.runs.taskIds[i]!));
        runs.durations.push(source.runs.durations[i]!);
    }

    // `tasks` is indexed *by* the task table rather than parallel to the runs,
    // so it is re-emitted in the remapped order. Slicing it would misalign
    // every entry and still produce a file that parses — the subtlety
    // `tools/fixtures/truncate.ts` exists to get right.
    const taskOrder = tasks.order();
    return {
        file: {
            metadata: source.metadata,
            manifests: manifests.build(),
            jobNames: jobNames.build(),
            commits: commits.build(),
            prefixes: prefixes.build(),
            tasks: {
                id: taskOrder.map((i) => source.tasks.id[i]!),
                jobName: taskOrder.map((i) => jobNames.map(source.tasks.jobName[i]!)),
                commitId: taskOrder.map((i) => commits.map(source.tasks.commitId[i]!)),
                prefix: taskOrder.map((i) => prefixes.map(source.tasks.prefix[i]!)),
            },
            runs,
        },
        chosen,
    };
}

// Run directly: `node --experimental-strip-types test/manifests-fixture-gen.ts <source>`
if (process.argv[1]?.endsWith('manifests-fixture-gen.ts') === true) {
    const sourcePath = process.argv[2];
    if (sourcePath === undefined) {
        throw new Error('usage: manifests-fixture-gen.ts <path to a real manifests.json>');
    }
    const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as ManifestsFile;
    const { file, chosen } = buildPathologyFixture(source);
    const out = new URL('./fixtures/manifests-pathology.json', import.meta.url);
    writeFileSync(out, JSON.stringify(file));
    console.log(
        `${file.manifests.length} manifests, ${file.jobNames.length} job names, ` +
            `${file.runs.durations.length} runs, ${file.tasks.id.length} tasks`
    );
    for (const entry of chosen) {
        console.log(`  ${entry.manifest}\n      ${entry.why}`);
    }
}
