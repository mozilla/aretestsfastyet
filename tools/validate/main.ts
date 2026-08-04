/**
 * Validates one published file against the declarations in `lib/formats/`.
 *
 * **One file per process invocation, by design.** Sweeping every published
 * date is tens of gigabytes; the mochitest errors file alone is ~97 MB for a
 * weekday. Holding one at a time is safe (§4 of `docs/PLAN.md`), holding
 * twenty is not, so the sweep is a shell loop over invocations rather than a
 * loop inside one process. `tools/validate/sweep.sh` is that loop.
 *
 * Usage:
 *   node tools/validate/main.js <family> <harness> [date] [--keep] [--file <path>]
 *
 * Families: daily issues issues-with-taskids bucket stats index errors
 *           manifests resources stackwalk
 *
 * Writes a JSON result to stdout and progress to stderr, so the sweep can
 * collect results with a redirect. Exits 0 when the file validates clean, 1
 * when it does not, and 3 when it could not be fetched.
 */

import { mkdir, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

import { Checker } from './check.ts';
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
    observeStatusTable,
    type FileContext,
} from './formats.ts';

const CI_INDEX = 'https://firefox-ci-tc.services.mozilla.com/api/index/v1/task';

type Family =
    | 'daily'
    | 'issues'
    | 'issues-with-taskids'
    | 'bucket'
    | 'stats'
    | 'index'
    | 'errors'
    | 'manifests'
    | 'resources'
    | 'stackwalk';

interface Args {
    family: Family;
    harness: string;
    date?: string;
    bucket?: string;
    keep: boolean;
    localFile?: string;
    url?: string;
}

function parseArgs(argv: string[]): Args {
    const positional: string[] = [];
    let keep = false;
    let localFile: string | undefined;
    let url: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--keep') {
            keep = true;
        } else if (arg === '--file') {
            localFile = argv[++i];
        } else if (arg === '--url') {
            url = argv[++i];
        } else if (arg !== undefined) {
            positional.push(arg);
        }
    }
    const [family, harness, third] = positional;
    if (family === undefined) {
        throw new Error('usage: main.js <family> <harness> [date|bucket]');
    }
    return {
        family: family as Family,
        harness: harness ?? 'xpcshell',
        ...(third !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(third) ? { date: third } : {}),
        ...(third !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(third) ? { bucket: third } : {}),
        keep,
        ...(localFile !== undefined ? { localFile } : {}),
        ...(url !== undefined ? { url } : {}),
    };
}

/** The Taskcluster index namespace and filename for a family. */
function locate(args: Args): { indexName: string; filename: string } {
    switch (args.family) {
        case 'daily':
            return { indexName: `${args.harness}-timings`, filename: `${args.harness}-${args.date}.json` };
        case 'issues':
            return { indexName: `${args.harness}-timings`, filename: `${args.harness}-issues.json` };
        case 'issues-with-taskids':
            return {
                indexName: `${args.harness}-timings`,
                filename: `${args.harness}-issues-with-taskids.json`,
            };
        case 'bucket':
            return {
                indexName: `${args.harness}-timings`,
                filename: `${args.harness}-${args.bucket ?? '00'}.json`,
            };
        case 'stats':
            return { indexName: `${args.harness}-timings`, filename: `${args.harness}-stats.json` };
        case 'index':
            return { indexName: `${args.harness}-timings`, filename: 'index.json' };
        case 'errors':
            return {
                indexName: `${args.harness}-timings`,
                filename: `${args.harness}-${args.date}-errors.json`,
            };
        case 'resources':
            return {
                indexName: `${args.harness}-timings`,
                filename: `${args.harness}-${args.date}-resources.json`,
            };
        case 'manifests':
            return { indexName: 'manifest-timings', filename: 'manifests.json' };
        case 'stackwalk':
            throw new Error('stackwalk needs an explicit --url or --file');
    }
}

const CHECKERS: Record<Family, (c: Checker, data: unknown, ctx: FileContext) => void> = {
    daily: checkDaily,
    issues: checkIssues,
    'issues-with-taskids': checkIssuesWithTaskIds,
    bucket: checkBucket,
    stats: checkStats,
    index: checkIndex,
    errors: checkErrors,
    manifests: checkManifests,
    resources: checkResources,
    stackwalk: checkStackwalk,
};

/** Streams the artifact to disk, so the download is not held in memory too. */
async function download(url: string, dest: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
        throw Object.assign(new Error(`HTTP ${response.status} for ${url}`), {
            status: response.status,
        });
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(dest));
}

async function main(): Promise<number> {
    const args = parseArgs(process.argv.slice(2));
    const label =
        args.localFile ??
        args.url ??
        `${args.family}/${args.harness}${args.date ? `/${args.date}` : ''}${args.bucket ? `/${args.bucket}` : ''}`;

    let file: string;
    let downloaded = false;
    if (args.localFile !== undefined) {
        file = args.localFile;
    } else {
        const url =
            args.url ??
            (() => {
                const { indexName, filename } = locate(args);
                return `${CI_INDEX}/gecko.v2.mozilla-central.latest.source.test-info-${indexName}/artifacts/public/${filename}`;
            })();
        file = path.join(
            'artifacts',
            'sweep',
            `${args.family}-${args.harness}-${args.date ?? args.bucket ?? 'x'}-${process.pid}.json`
        );
        process.stderr.write(`fetching ${url}\n`);
        try {
            await download(url, file);
        } catch (error) {
            const status = (error as { status?: number }).status;
            process.stdout.write(
                `${JSON.stringify({ label, family: args.family, harness: args.harness, date: args.date, fetchError: String(error), status })}\n`
            );
            return 3;
        }
        downloaded = true;
    }

    try {
        const bytes = (await stat(file)).size;
        const text = await readFile(file, 'utf8');
        let data: unknown;
        try {
            data = JSON.parse(text);
        } catch (error) {
            process.stdout.write(
                `${JSON.stringify({ label, family: args.family, harness: args.harness, parseError: String(error) })}\n`
            );
            return 1;
        }

        const c = new Checker();
        const ctx: FileContext = {
            harness: args.harness,
            ...(args.date !== undefined ? { date: args.date } : {}),
        };
        CHECKERS[args.family](c, data, ctx);
        observeStatusTable(c, data, args.harness);

        // Peak heap, measured after the parse and the walk — the number the
        // plan asks for is what a contributor's default heap has to hold.
        const peak = process.memoryUsage();

        const result = {
            label,
            family: args.family,
            harness: args.harness,
            date: args.date,
            bucket: args.bucket,
            bytes,
            errors: c.errors,
            notes: Object.fromEntries(
                [...c.notes].map(([path, kinds]) => [
                    path,
                    [...kinds].map((kind) => ({
                        kind,
                        count: c.noteCounts.get(`${path} ${kind}`) ?? 0,
                    })),
                ])
            ),
            observations: Object.fromEntries(
                [...c.observations].map(([name, bag]) => [name, Object.fromEntries(bag)])
            ),
            memory: {
                heapUsed: peak.heapUsed,
                heapTotal: peak.heapTotal,
                rss: peak.rss,
                external: peak.external,
            },
        };
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.stderr.write(
            `${label}: ${c.errors.length} errors, ${c.notes.size} noted fields, ` +
                `${(bytes / 1e6).toFixed(1)} MB, rss ${(peak.rss / 1e6).toFixed(0)} MB\n`
        );
        return c.errors.length === 0 ? 0 : 1;
    } finally {
        if (downloaded && !args.keep) {
            await rm(file, { force: true });
        }
    }
}

main().then(
    (code) => {
        process.exitCode = code;
    },
    (error: unknown) => {
        process.stderr.write(`${String(error)}\n`);
        process.exitCode = 3;
    }
);
