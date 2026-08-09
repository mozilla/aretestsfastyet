/**
 * `docs/CLI.md`'s worked examples, checked against what the CLI actually prints.
 *
 * The transcripts in that document are the first thing a reader trusts, and
 * nothing was stopping them from drifting: the `fx-tests flaky` sections were
 * written by pasting real output, verified by hand once, and then left. A later
 * change to a column header or a rounding rule would have left the document
 * describing a command that no longer exists, which is the failure this
 * repository's notes call out in other forms — a comment or a doc asserting
 * something the code contradicts is worse than no doc at all.
 *
 * ## Why this reads the pinned artifact rather than a fixture
 *
 * The numbers in those transcripts are the real tree's: 4,838 tests, 250
 * folders, `toolkit/components/extensions/test/xpcshell` at 187 flaky. The
 * checked-in fixture holds **10** tests, so it cannot reproduce a single line of
 * them. The pinned snapshot under `artifacts/` is the only input that can, and
 * it is a development artifact rather than a committed fixture — so this test
 * **skips** when it is absent instead of failing. That is a deliberate trade:
 * the check runs for anyone who has the pinned data (which is how these
 * transcripts are regenerated in the first place) and does not turn a fresh
 * clone red.
 *
 * A skipped test that could silently never run is its own hazard, so the skip
 * says which path was missing, and the parse below fails loudly if the document
 * stops containing the blocks it expects — a transcript that was *deleted*
 * rather than changed must not read as "nothing to check".
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { diskCache } from '../cli/cache.ts';
import { captureStreams } from '../cli/context.ts';
import { type DataFileName, type DataSource, DataFileNotFoundError } from '../lib/sources/source.ts';
import { run } from '../cli/main.ts';

/** The pinned snapshot the documented numbers come from. */
const PINNED: Record<string, string> = {
    'xpcshell-timings/index.json': 'artifacts/pinned/data/index.json',
    'xpcshell-timings/xpcshell-issues.json': 'artifacts/pinned/data/xpcshell-issues.json',
};

const havePinned = Object.values(PINNED).every((path) => existsSync(path));

/** Serves the pinned files and refuses anything else, as the browser harness does. */
function pinnedSource(): DataSource {
    return {
        name: 'pinned',
        async fetch(fileName: DataFileName): Promise<Uint8Array> {
            const local = PINNED[`${fileName.index}/${fileName.filename}`];
            if (local === undefined) {
                throw new DataFileNotFoundError(fileName);
            }
            return new Uint8Array(await readFile(local));
        },
    };
}

async function invoke(argv: readonly string[]): Promise<string> {
    const streams = captureStreams();
    await run({
        argv: [...argv],
        streams,
        source: pinnedSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
    });
    return streams.stdout;
}

/** One `$ fx-tests …` block: the argv it claims, and the output it shows. */
interface Transcript {
    argv: string[];
    expected: string;
}

/**
 * Every fenced block in a section that opens with a `$ fx-tests` line.
 *
 * A block with no invocation line is prose — an options list, a JSON shape —
 * and is skipped rather than treated as a failed match.
 */
function transcriptsOf(doc: string, heading: string): Transcript[] {
    const section = new RegExp(
        `### \`${heading}\`(.*?)(?=\\n### |$)`,
        's'
    ).exec(doc);
    assert.ok(section !== null, `docs/CLI.md has no "### \`${heading}\`" section`);

    const out: Transcript[] = [];
    for (const block of section[1]!.matchAll(/```\n(.*?)```/gs)) {
        const lines = block[1]!.split('\n');
        const at = lines.findIndex((line) => line.startsWith('$ fx-tests'));
        if (at === -1) {
            continue;
        }
        out.push({
            // Drop the `$` and the program name; what is left is argv.
            argv: lines[at]!.trim().slice(1).trim().split(/\s+/).slice(1),
            // A blank line between the invocation and its output is the
            // document's own formatting, not something the command printed, so
            // both ends are trimmed. Blank lines *within* the output are
            // significant and are compared.
            expected: lines
                .slice(at + 1)
                .join('\n')
                .replace(/^\n+/, '')
                .replace(/\n+$/, ''),
        });
    }
    return out;
}

const doc = await readFile(new URL('../docs/CLI.md', import.meta.url), 'utf8');

test('every fx-tests flaky transcript in CLI.md is what the command prints', async (t) => {
    const transcripts = transcriptsOf(doc, 'fx-tests flaky');
    // Guards the "deleted rather than changed" case: if the examples vanish,
    // this test must not quietly pass with nothing to compare.
    assert.ok(
        transcripts.length >= 2,
        `expected at least 2 worked examples under "fx-tests flaky", found ${transcripts.length}`
    );

    if (!havePinned) {
        t.skip(
            `pinned snapshot absent (${Object.values(PINNED).join(', ')}); ` +
                'the documented numbers are the real tree\'s and cannot be reproduced from the fixture'
        );
        return;
    }

    for (const { argv, expected } of transcripts) {
        const actual = (await invoke(argv)).replace(/^\n+/, '').replace(/\n+$/, '');
        assert.equal(
            actual,
            expected,
            `\`fx-tests ${argv.join(' ')}\` no longer prints what docs/CLI.md shows. ` +
                'Regenerate the transcript rather than editing it by hand.'
        );
    }
});
