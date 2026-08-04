/**
 * Merges the per-file JSON results the sweep produced into the four outputs
 * step 0 has to deliver:
 *
 *   a. every distinct status string and marker kind observed;
 *   b. which declared fields were ever null or absent, per family per harness;
 *   c. the `UNKNOWN` census — occurrences per harness per date;
 *   d. peak heap, against file size.
 *
 * Reads one JSON object per line (the sweep's stdout) and writes the report to
 * stdout. Kept separate from the validator so the sweep can be re-summarized
 * without re-downloading tens of gigabytes.
 */

import { readFile } from 'node:fs/promises';

interface Result {
    label: string;
    family: string;
    harness: string;
    date?: string;
    bucket?: string;
    bytes?: number;
    errors?: { path: string; message: string }[];
    notes?: Record<string, { kind: string; count: number }[]>;
    observations?: Record<string, Record<string, number>>;
    memory?: { heapUsed: number; heapTotal: number; rss: number };
    fetchError?: string;
    parseError?: string;
    status?: number;
}

function mb(bytes: number): string {
    return `${(bytes / 1e6).toFixed(1)} MB`;
}

async function main(): Promise<void> {
    const files = process.argv.slice(2);
    const results: Result[] = [];
    for (const file of files) {
        const text = await readFile(file, 'utf8');
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('{')) {
                continue;
            }
            try {
                results.push(JSON.parse(trimmed) as Result);
            } catch {
                process.stderr.write(`skipping unparseable line in ${file}\n`);
            }
        }
    }

    const out: string[] = [];
    const say = (line = ''): void => {
        out.push(line);
    };

    // --- coverage ---------------------------------------------------------
    const ok = results.filter((r) => !r.fetchError && !r.parseError && (r.errors?.length ?? 0) === 0);
    const failed = results.filter((r) => (r.errors?.length ?? 0) > 0);
    const unfetched = results.filter((r) => r.fetchError);
    const unparsed = results.filter((r) => r.parseError);

    say(`# Sweep report`);
    say();
    say(
        `${results.length} files: ${ok.length} clean, ${failed.length} with errors, ` +
            `${unfetched.length} not fetched, ${unparsed.length} unparseable.`
    );
    say();

    const byFamily = new Map<string, Result[]>();
    for (const r of results) {
        const key = `${r.family}/${r.harness}`;
        const list = byFamily.get(key) ?? [];
        list.push(r);
        byFamily.set(key, list);
    }
    say(`## Coverage`);
    say();
    say(`| family / harness | files | clean | bytes | dates |`);
    say(`| --- | --- | --- | --- | --- |`);
    for (const [key, list] of [...byFamily].sort()) {
        const clean = list.filter(
            (r) => !r.fetchError && !r.parseError && (r.errors?.length ?? 0) === 0
        ).length;
        const bytes = list.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
        const dates = list.map((r) => r.date).filter(Boolean);
        const dateRange =
            dates.length === 0
                ? '—'
                : dates.length === 1
                  ? String(dates[0])
                  : `${dates.length} (${[...dates].sort()[0]} … ${[...dates].sort().at(-1)})`;
        say(`| ${key} | ${list.length} | ${clean} | ${mb(bytes)} | ${dateRange} |`);
    }
    say();

    // --- errors -----------------------------------------------------------
    if (failed.length > 0 || unfetched.length > 0 || unparsed.length > 0) {
        say(`## Failures`);
        say();
        for (const r of unfetched) {
            say(`- **${r.label}**: not fetched — ${r.fetchError}`);
        }
        for (const r of unparsed) {
            say(`- **${r.label}**: unparseable — ${r.parseError}`);
        }
        for (const r of failed) {
            say(`- **${r.label}**: ${r.errors?.length} errors`);
            const seen = new Set<string>();
            for (const e of r.errors ?? []) {
                const key = `${e.path}: ${e.message}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                say(`  - \`${e.path}\` — ${e.message}`);
                if (seen.size >= 15) {
                    break;
                }
            }
        }
        say();
    }

    // --- (a) statuses and marker kinds ------------------------------------
    const merged = new Map<string, Map<string, number>>();
    for (const r of results) {
        for (const [set, bag] of Object.entries(r.observations ?? {})) {
            let target = merged.get(set);
            if (!target) {
                target = new Map();
                merged.set(set, target);
            }
            for (const [value, count] of Object.entries(bag)) {
                target.set(value, (target.get(value) ?? 0) + count);
            }
        }
    }

    say(`## (a) Status strings`);
    say();
    const declared = merged.get('statusesDeclared') ?? new Map();
    const inUse = merged.get('statusesInUse') ?? new Map();
    const perHarnessDeclared = (harness: string): Set<string> =>
        new Set((merged.get(`statusesDeclared/${harness}`) ?? new Map()).keys());
    const xpcDeclared = perHarnessDeclared('xpcshell');
    const mochiDeclared = perHarnessDeclared('mochitest');

    say(`${declared.size} distinct status strings across every file swept.`);
    say();
    say(`| status | xpcshell | mochitest | groups seen |`);
    say(`| --- | --- | --- | --- |`);
    for (const status of [...declared.keys()].sort()) {
        say(
            `| \`${status}\` | ${xpcDeclared.has(status) ? 'yes' : '—'} | ` +
                `${mochiDeclared.has(status) ? 'yes' : '—'} | ${inUse.get(status) ?? 0} |`
        );
    }
    say();

    say(`### Marker kinds`);
    say();
    const kinds = merged.get('markerKinds') ?? new Map();
    const xpcKinds = new Set((merged.get('markerKinds/xpcshell') ?? new Map()).keys());
    const mochiKinds = new Set((merged.get('markerKinds/mochitest') ?? new Map()).keys());
    say(`| marker kind | xpcshell | mochitest |`);
    say(`| --- | --- | --- |`);
    for (const kind of [...kinds.keys()].sort()) {
        say(
            `| \`${kind}\` | ${xpcKinds.has(kind) ? 'yes' : '—'} | ${mochiKinds.has(kind) ? 'yes' : '—'} |`
        );
    }
    say();

    // --- status group shapes ---------------------------------------------
    const shapes = merged.get('statusShapes');
    if (shapes) {
        say(`### Status-group shapes actually observed`);
        say();
        say(`| family / status | shape | groups |`);
        say(`| --- | --- | --- |`);
        for (const [key, count] of [...shapes].sort()) {
            const [pair, shape] = key.split(' -> ');
            say(`| \`${pair}\` | ${shape} | ${count} |`);
        }
        say();
    }

    // --- (b) null / absent census ----------------------------------------
    say(`## (b) Fields observed null, absent or empty`);
    say();
    say(`Per file family and harness. A field listed here is one the decoders`);
    say(`must handle; anything not listed was always present and non-null in`);
    say(`everything swept.`);
    say();
    const noteIndex = new Map<string, Map<string, Map<string, number>>>();
    for (const r of results) {
        const key = `${r.family}/${r.harness}`;
        let perFamily = noteIndex.get(key);
        if (!perFamily) {
            perFamily = new Map();
            noteIndex.set(key, perFamily);
        }
        for (const [path, kinds2] of Object.entries(r.notes ?? {})) {
            let perPath = perFamily.get(path);
            if (!perPath) {
                perPath = new Map();
                perFamily.set(path, perPath);
            }
            for (const { kind, count } of kinds2) {
                perPath.set(kind, (perPath.get(kind) ?? 0) + count);
            }
        }
    }
    for (const [key, perFamily] of [...noteIndex].sort()) {
        if (perFamily.size === 0) {
            continue;
        }
        say(`### \`${key}\``);
        say();
        say(`| field | kinds | occurrences |`);
        say(`| --- | --- | --- |`);
        for (const [path, perPath] of [...perFamily].sort()) {
            const kindList = [...perPath]
                .map(([kind, count]) => `${kind} (${count.toLocaleString('en-US')})`)
                .join(', ');
            const total = [...perPath.values()].reduce((a, b) => a + b, 0);
            say(`| \`${path}\` | ${kindList} | ${total.toLocaleString('en-US')} |`);
        }
        say();
    }

    // --- (c) UNKNOWN census -----------------------------------------------
    say(`## (c) \`UNKNOWN\` census`);
    say();
    const unknownRows: string[] = [];
    let unknownTotal = 0;
    for (const r of results) {
        const declaredHere = r.observations?.[`statusesDeclared/${r.harness}`] ?? {};
        const runsHere = r.observations?.[`statusRuns/${r.harness}`] ?? {};
        const inTable = Object.keys(declaredHere).includes('UNKNOWN');
        const runs = runsHere['UNKNOWN'] ?? 0;
        if (inTable || runs > 0) {
            unknownTotal += runs;
            unknownRows.push(
                `| ${r.harness} | ${r.family} | ${r.date ?? r.bucket ?? '—'} | ` +
                    `${inTable ? 'yes' : 'no'} | ${runs.toLocaleString('en-US')} |`
            );
        }
    }
    const withStatuses = results.filter(
        (r) => Object.keys(r.observations?.[`statusesDeclared/${r.harness}`] ?? {}).length > 0
    );
    say(
        `${withStatuses.length} swept files carry a \`tables.statuses\`. ` +
            `\`UNKNOWN\` appears in **${unknownRows.length}** of them, ` +
            `for **${unknownTotal.toLocaleString('en-US')}** runs in total.`
    );
    say();
    if (unknownRows.length > 0) {
        say(`| harness | family | date | in tables.statuses | runs |`);
        say(`| --- | --- | --- | --- | --- |`);
        for (const row of unknownRows) {
            say(row);
        }
    } else {
        say(
            `Not one occurrence, and the string is absent from every ` +
                `\`tables.statuses\` swept — the generator does not emit it at all.`
        );
    }
    say();

    // Per-harness run totals, so UNKNOWN's absence has a denominator.
    //
    // Counted **per family**, never summed across families. `issues`,
    // `issues-with-taskids` and the 64 bucket files are three encodings of the
    // same 21 days and report identical per-status totals, so adding them
    // multiplies the population by the number of ways it was encoded — which
    // an earlier version of this report did, inflating the figure ~4×.
    say(`### Runs by status, for scale`);
    say();
    say(
        `Counted separately per file family. The aggregates re-encode the same ` +
            `21 days, so these columns must not be added together.`
    );
    say();
    const runsByFamily = new Map<string, Map<string, number>>();
    for (const r of results) {
        const bag = r.observations?.[`statusRuns/${r.harness}`];
        if (!bag) {
            continue;
        }
        const key = `${r.harness}/${r.family}`;
        let target = runsByFamily.get(key);
        if (!target) {
            target = new Map();
            runsByFamily.set(key, target);
        }
        for (const [status, count] of Object.entries(bag)) {
            target.set(status, (target.get(status) ?? 0) + count);
        }
    }
    for (const harness of ['xpcshell', 'mochitest']) {
        const families = [...runsByFamily.keys()]
            .filter((k) => k.startsWith(`${harness}/`))
            .sort();
        if (families.length === 0) {
            continue;
        }
        const statuses = new Set<string>();
        for (const family of families) {
            for (const status of runsByFamily.get(family)!.keys()) {
                statuses.add(status);
            }
        }
        say(`**${harness}**`);
        say();
        say(`| status | ${families.map((f) => f.split('/')[1]).join(' | ')} |`);
        say(`| --- | ${families.map(() => '---').join(' | ')} |`);
        const sorted = [...statuses].sort(
            (a, b) =>
                (runsByFamily.get(families[0]!)!.get(b) ?? 0) -
                (runsByFamily.get(families[0]!)!.get(a) ?? 0)
        );
        for (const status of sorted) {
            const cells = families.map((f) =>
                (runsByFamily.get(f)!.get(status) ?? 0).toLocaleString('en-US')
            );
            say(`| \`${status}\` | ${cells.join(' | ')} |`);
        }
        const totals = families.map((f) =>
            [...runsByFamily.get(f)!.values()].reduce((a, b) => a + b, 0)
        );
        say(`| **total** | ${totals.map((t) => t.toLocaleString('en-US')).join(' | ')} |`);
        say();
    }

    // --- (d) peak heap ----------------------------------------------------
    say(`## (d) Peak heap`);
    say();
    const withMemory = results
        .filter((r) => r.memory && r.bytes)
        .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
    say(`Measured after \`JSON.parse\` and the full walk, in a default Node heap.`);
    say();
    say(`| file | on disk | heapUsed | heapTotal | rss | rss / bytes |`);
    say(`| --- | --- | --- | --- | --- | --- |`);
    for (const r of withMemory.slice(0, 15)) {
        const m = r.memory!;
        say(
            `| \`${r.label}\` | ${mb(r.bytes!)} | ${mb(m.heapUsed)} | ${mb(m.heapTotal)} | ` +
                `${mb(m.rss)} | ${((m.rss / r.bytes!) || 0).toFixed(1)}× |`
        );
    }
    say();

    // --- other observations ----------------------------------------------
    const otherSets = [...merged.keys()].filter(
        (name) =>
            !name.startsWith('statusesDeclared') &&
            !name.startsWith('statusRuns') &&
            !name.startsWith('markerKinds') &&
            name !== 'statusesInUse' &&
            name !== 'statusShapes'
    );
    if (otherSets.length > 0) {
        say(`## Other observations`);
        say();
        for (const name of otherSets.sort()) {
            const bag = merged.get(name)!;
            say(`**${name}**`);
            say();
            for (const [value, count] of [...bag].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
                say(`- ${value}${count > 1 ? ` (×${count})` : ''}`);
            }
            say();
        }
    }

    process.stdout.write(`${out.join('\n')}\n`);
}

await main();
