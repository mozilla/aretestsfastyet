/**
 * New page vs CLI for the crash viewer:
 * `next/crash-viewer.html?url=…` ↔ `fx-tests crash <taskId>.<retryId> <minidumpId>`.
 *
 * `PARITY.md` §5, for the first of the three migrated pages, and the one where
 * the brief says to "check what is actually comparable rather than forcing it".
 * So the first thing this file does is establish what that is.
 *
 * ## What order parity means here, since there is no ranking
 *
 * Nothing on either side is ranked. A stack is in stack order and the threads
 * are in file order, so "same order, same key, same direction" has no content.
 * What replaces it is **sequence** parity, and there are two sequences:
 *
 * 1. the thread sequence — index, thread id and name, in file order;
 * 2. within each thread, the frame sequence — index, symbol, module, trust,
 *    source location and inlined callees, innermost first.
 *
 * Both are compared position by position over **every thread of both dumps**:
 * 85 threads and 1,348 frames. A stack silently reordered or a thread dropped
 * is the defect that matters for a crash viewer, and it is exactly what a
 * count-only check would miss.
 *
 * ## What is not comparable, and why the CLI is driven with flags
 *
 * The default views are different populations on purpose: the page renders
 * every thread (non-crashing ones truncated to 10 frames with a "Show N more"
 * control that keeps the hidden rows in the DOM), and the CLI defaults to the
 * crashing thread at 20 frames. Comparing those two defaults would compare a
 * truncation against a different truncation and say nothing about the data.
 *
 * So the sequences are compared with the CLI's truncation turned off
 * (`--all-threads --frames 0 --limit 0`), which is the same population the page
 * builds — and the *defaults* are then asserted separately, as the framing
 * difference they are, with both sides' numbers recorded.
 *
 * ## The comparison this file cannot make
 *
 * Neither side is rendered. `next/crash-viewer.ts` turns the view model into
 * elements and `renderText`/`renderMarkdown` turn `CrashJson` into strings;
 * asserting on the first in node needs a DOM shim, and comparing rendered text
 * to rendered HTML would be comparing two presentations rather than two
 * answers. The rendering is `PARITY.md` §4's business.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Frame, StackwalkFile, Thread } from '../lib/formats/stackwalk.ts';
import { parseFileInfo } from '../lib/links.ts';
import { crashSignature } from '../lib/model/crash-signature.ts';
import { type CrashView, type ThreadView, crashView } from '../next/crash-view.ts';
import {
    type Divergence,
    assertDeclaredDivergences,
    assertSameOrder,
    artifactSource,
    fixtureJson,
    invoke,
    json,
} from './parity-harness.ts';

// =========================================================================
// The two dumps
// =========================================================================

/** The artifact paths the CLI builds for the two task IDs used below. */
const ARTIFACTS: Record<string, string> = {
    'TASKCRASH/runs/0/artifacts/public/test_info/dump-crash.json': 'stackwalk-crash.json',
    'TASKHANG/runs/0/artifacts/public/test_info/dump-hang.json': 'stackwalk-hang.json',
};

interface Dump {
    fixture: string;
    taskId: string;
    minidumpId: string;
    /** What the dump is in the corpus for. */
    why: string;
}

/**
 * The corpus: one real crash and one real hang.
 *
 * Two dumps and not one, because they exercise opposite branches on both
 * sides — the hang has unsymbolized frames, inlines, a memory-access record and
 * an instruction-pointer update; the crash has none of those and 59 threads to
 * the hang's 26. A single dump would leave half of each side's code
 * uncompared, and the `???` divergence below appears only in the hang.
 */
const DUMPS: Dump[] = [
    {
        fixture: 'stackwalk-crash.json',
        taskId: 'TASKCRASH',
        minidumpId: 'dump-crash',
        why: '59 threads, a Windows fault, every frame symbolized',
    },
    {
        fixture: 'stackwalk-hang.json',
        taskId: 'TASKHANG',
        minidumpId: 'dump-hang',
        why: '26 threads, a macOS dump taken from outside, 51 unsymbolized frames',
    },
];

/** The CLI's `--json`, narrowed to what is compared. */
interface CliCrash {
    signature: string;
    crashType: string | null;
    instruction: string | null;
    address: { address: string; nullPointer: boolean } | null;
    system: { os: string; osVersion: string; cpuArch: string; cpuCount: number } | null;
    crashingThreadIndex: number | null;
    threadCount: number;
    threadRowCount: number;
    hang: { looksLikeHang: boolean; blockedThreadCount: number };
    threads: {
        index: number;
        name: string | null;
        threadId: number;
        crashing: boolean;
        frameCount: number;
        frames: {
            index: number;
            function: string;
            unsymbolized: boolean;
            file: string | null;
            line: number | null;
            module: string | null;
            trust: string;
            inlines: { function: string | null; file: string | null; line: number | null }[];
        }[];
    }[];
}

/**
 * One `fx-tests crash` invocation.
 *
 * `--all-threads --frames 0 --limit 0` by default here: that is the population
 * the page builds, and comparing the CLI's *default* truncation against the
 * page's *different* default truncation would compare two elisions. The
 * defaults are asserted separately, as framing.
 */
async function cliCrash(dump: Dump, extra: string[] = []): Promise<CliCrash> {
    return json<CliCrash>(
        await invoke(['crash', dump.taskId, dump.minidumpId, '--json', ...extra], {
            taskArtifacts: artifactSource(ARTIFACTS),
        })
    );
}

const FULL = ['--all-threads', '--frames', '0', '--limit', '0'];

/** The page's view for one dump. */
function pageView(dump: Dump): { file: StackwalkFile; view: CrashView } {
    const file = fixtureJson<StackwalkFile>(dump.fixture);
    return { file, view: crashView(file) };
}

/**
 * The page's threads in file order — the sequence the page renders top to
 * bottom.
 *
 * The view splits them into `crashingThread` and `otherThreads` because the
 * former is drawn untruncated and first in the markup, but both carry their
 * `index`, and re-interleaving on it is what makes the two sides' sequences
 * comparable at all.
 *
 * **This normalizes the page's order away, so it cannot police it.** An earlier
 * comment here claimed the rebuild was "not a reordering" on the grounds that
 * `otherThreadViews` walks in order — true of the code as written, and exactly
 * the thing a test should not assume. Rebuilding by index lookup yields
 * 1,2,3,… whatever order the view emitted: measured against a reversed
 * `otherThreadViews`, the view produced 102,101,100,… and this comparison still
 * passed. The preceding test asserts the raw emission for that reason; this one
 * compares the two sides once both are known to be in file order.
 */
function pageThreadsInFileOrder(file: StackwalkFile, view: CrashView): ThreadView[] {
    const byIndex = new Map<number, ThreadView>();
    if (view.crashingThread !== null) {
        byIndex.set(view.crashingThread.index, view.crashingThread);
    }
    for (const thread of view.otherThreads) {
        byIndex.set(thread.index, thread);
    }
    const ordered: ThreadView[] = [];
    for (let index = 0; index < file.threads.length; index++) {
        const thread = byIndex.get(index);
        assert.ok(thread !== undefined, `the page view has no thread #${index}`);
        ordered.push(thread);
    }
    return ordered;
}

// =========================================================================
// 1. Value parity
// =========================================================================

test('the signature is identical, and it is the one thing everything else keys on', async () => {
    // The page's `<h1>`, its `document.title`, and what `fx-tests crashes`
    // groups on. Both sides call `lib/model/crash-signature.ts`, so this is not
    // two computations — which is precisely the claim the migration made, and
    // asserting it here is what keeps a future inline re-implementation on
    // either side from going unnoticed.
    for (const dump of DUMPS) {
        const { file, view } = pageView(dump);
        const result = await cliCrash(dump);
        assert.equal(result.signature, view.signature, dump.fixture);
        assert.equal(result.signature, crashSignature(file), dump.fixture);
    }
    // And pinned as literals, so a change that agreed with itself across all
    // three call sites still fails. These are the strings the old page
    // displayed, quoted from `test/crash-view.test.ts`.
    assert.equal((await cliCrash(DUMPS[0]!)).signature, '@ KiUserCallbackDispatcher');
    assert.equal(
        (await cliCrash(DUMPS[1]!)).signature,
        '@ libsystem_kernel.dylib + 0x0000000000000dfa'
    );
});

test('the system information agrees, field by field', async () => {
    // The page renders four labelled rows; the CLI four named fields. Compared
    // by pulling the page's values back out of its labels, so a row silently
    // dropped from the grid fails rather than being absent from both sides of a
    // loose comparison.
    for (const dump of DUMPS) {
        const { view } = pageView(dump);
        const result = await cliCrash(dump);
        assert.ok(result.system !== null, `${dump.fixture}: the CLI reported no system info`);
        const byLabel = new Map(view.systemInfo.map((field) => [field.label, field.value]));
        assert.equal(byLabel.get('Operating system:'), result.system.os, dump.fixture);
        assert.equal(byLabel.get('OS version:'), result.system.osVersion, dump.fixture);
        assert.equal(byLabel.get('CPU count:'), String(result.system.cpuCount), dump.fixture);
        // The CPU row is the arch plus the vendor string, so the arch is the
        // prefix. Asserted as a prefix and not by splitting, because a change
        // that reordered the row would still contain the arch somewhere.
        assert.ok(
            byLabel.get('CPU:')?.startsWith(`${result.system.cpuArch} `),
            `${dump.fixture}: the CPU row must lead with the arch the CLI reports`
        );
    }
});

test('the crash reason agrees on the fields both sides carry', async () => {
    for (const dump of DUMPS) {
        const { view } = pageView(dump);
        const result = await cliCrash(dump);
        assert.ok(view.crashReason !== null, `${dump.fixture}: the page rendered no crash reason`);
        assert.equal(result.crashType, view.crashReason.type, dump.fixture);
        assert.equal(result.instruction, view.crashReason.instruction, dump.fixture);
        assert.ok(result.address !== null);
        assert.equal(result.address.address, view.crashReason.address, dump.fixture);
        // The null-pointer read: the page renders an offset only when it
        // recognized one, and the CLI carries a boolean. They must agree about
        // whether there was one, and neither fixture has one — asserted so a
        // dump that grows one fails here rather than passing untested.
        assert.equal(
            result.address.nullPointer,
            view.crashReason.nullPointerOffset !== null,
            dump.fixture
        );
        assert.equal(result.address.nullPointer, false, `${dump.fixture}: no null deref expected`);
    }
});

test('the thread count and the crashing thread index agree', async () => {
    for (const dump of DUMPS) {
        const { file, view } = pageView(dump);
        const result = await cliCrash(dump, FULL);
        // Against the fixture as well as against each other, so "both agree"
        // cannot be both having lost the same threads.
        assert.equal(result.threadCount, file.threads.length, dump.fixture);
        assert.equal(result.threads.length, file.threads.length, dump.fixture);
        assert.equal(
            view.otherThreads.length + (view.crashingThread === null ? 0 : 1),
            file.threads.length,
            dump.fixture
        );
        assert.equal(result.crashingThreadIndex, view.crashingThread?.index ?? null, dump.fixture);
    }
    // Both dumps have a crashing thread and more than one thread, so neither
    // branch above is vacuous.
    assert.equal((await cliCrash(DUMPS[0]!, FULL)).threadCount, 59);
    assert.equal((await cliCrash(DUMPS[1]!, FULL)).threadCount, 26);
});

// =========================================================================
// 2. Sequence parity — what "order" means for a stack
// =========================================================================

test('the view emits its non-crashing threads in file order', () => {
    // Asserted *before* the interleaving below, and separately from it, because
    // `pageThreadsInFileOrder` rebuilds the sequence by looking each index up —
    // which restores file order whatever order the view produced, and so cannot
    // fail if the view reorders. Measured: with `otherThreadViews` walking the
    // array reversed, the view emits 102,101,100,… and the rebuild still yields
    // 1,2,3,…, so the interleaved comparison passed against a reversed page.
    // This is the assertion that has to see the raw emission.
    for (const dump of DUMPS) {
        const { file, view } = pageView(dump);
        const crashingIndex = file.crash_info?.crashing_thread;
        const expected = file.threads
            .map((_, index) => index)
            .filter((index) => index !== crashingIndex);
        assert.deepEqual(
            view.otherThreads.map((thread) => thread.index),
            expected,
            `${dump.fixture}: otherThreads is not in file order`
        );
    }
});

test('the thread sequence is identical: index, id and name, in file order', async () => {
    for (const dump of DUMPS) {
        const { file, view } = pageView(dump);
        const result = await cliCrash(dump, FULL);
        const pageThreads = pageThreadsInFileOrder(file, view);

        assertSameOrder(
            pageThreads.map((thread) => `#${thread.index} tid=${thread.threadId} ${thread.name ?? ''}`),
            result.threads.map((thread) => `#${thread.index} tid=${thread.threadId} ${thread.name ?? ''}`),
            `${dump.fixture}: the thread sequences differ`
        );
    }
});

test('every frame of every thread matches, position by position', async () => {
    // The core of this file. 1,348 frames across 85 threads, compared on the
    // five fields both sides carry, in sequence. A stack reordered, a frame
    // dropped, or an inline attributed to the wrong parent all fail here — and
    // none of them would move a count.
    let framesCompared = 0;
    let inlinesCompared = 0;

    for (const dump of DUMPS) {
        const { file, view } = pageView(dump);
        const result = await cliCrash(dump, FULL);
        const pageThreads = pageThreadsInFileOrder(file, view);

        for (const [index, cliThread] of result.threads.entries()) {
            const pageThread = pageThreads[index]!;
            // The page's rows interleave inlines with frames; the frame rows
            // alone are the stack.
            const pageFrames = pageThread.rows.filter((row) => row.kind === 'frame');
            assert.equal(
                pageFrames.length,
                cliThread.frameCount,
                `${dump.fixture} thread #${index}: frame counts differ`
            );
            assert.equal(
                cliThread.frames.length,
                cliThread.frameCount,
                `${dump.fixture} thread #${index}: --frames 0 must not truncate`
            );

            for (const [position, cliFrame] of cliThread.frames.entries()) {
                const pageFrame = pageFrames[position]!;
                framesCompared++;
                assert.equal(
                    pageFrame.number,
                    String(cliFrame.index),
                    `${dump.fixture} thread #${index} position ${position}: frame index`
                );
                // The page's `?? 'unknown'` placeholder is upstream's, and the
                // CLI carries a real null, so the comparison applies it.
                assert.equal(
                    pageFrame.module,
                    cliFrame.module ?? 'unknown',
                    `${dump.fixture} thread #${index} frame ${cliFrame.index}: module`
                );
                assert.equal(
                    pageFrame.trust,
                    cliFrame.trust,
                    `${dump.fixture} thread #${index} frame ${cliFrame.index}: trust`
                );
                if (cliFrame.unsymbolized) {
                    // The declared `???` divergence: the page shows upstream's
                    // placeholder, the CLI a module-plus-offset fallback.
                    assert.equal(pageFrame.functionText, '???');
                } else {
                    assert.equal(
                        pageFrame.functionText,
                        cliFrame.function,
                        `${dump.fixture} thread #${index} frame ${cliFrame.index}: symbol`
                    );
                }

                // Inlined callees, in order and attributed to this frame. The
                // page emits them as rows *before* the frame's own row, so they
                // are read back from there rather than from a field.
                const rowIndex = pageThread.rows.indexOf(pageFrame);
                const pageInlines: string[] = [];
                for (let back = rowIndex - 1; back >= 0; back--) {
                    const row = pageThread.rows[back]!;
                    if (row.kind !== 'inline') {
                        break;
                    }
                    pageInlines.unshift(row.functionText);
                }
                assert.deepEqual(
                    pageInlines,
                    cliFrame.inlines.map((inline) => inline.function ?? '???'),
                    `${dump.fixture} thread #${index} frame ${cliFrame.index}: inlined callees`
                );
                inlinesCompared += pageInlines.length;
            }
        }
    }

    // Pinned, because the value of this test is its breadth: a fixture change
    // that halved the corpus would otherwise leave it passing on half the data.
    assert.equal(framesCompared, 1348, 'the frames compared changed');
    assert.equal(inlinesCompared, 413, 'the inlined callees compared changed');
});

test('the source location is the same file and line, modulo the VCS prefix', async () => {
    // The page strips the `git:host:path:revision` wrapper with `parseFileInfo`
    // (`lib/links.ts:270`) so the cell reads `tools/foo.cpp:249`; the CLI emits
    // the raw string and the line separately. Same location, different
    // presentation, and the reconciliation is `parseFileInfo` — which is
    // `lib/`'s, so this checks that both sides route through it consistently
    // rather than that the two strings happen to match.
    let located = 0;
    let lineZero = 0;

    for (const dump of DUMPS) {
        const { file, view } = pageView(dump);
        const result = await cliCrash(dump, FULL);
        const pageThreads = pageThreadsInFileOrder(file, view);

        for (const [index, cliThread] of result.threads.entries()) {
            const pageFrames = pageThreads[index]!.rows.filter((row) => row.kind === 'frame');
            for (const [position, cliFrame] of cliThread.frames.entries()) {
                const pageFrame = pageFrames[position]!;
                if (cliFrame.file === null || cliFrame.line === null) {
                    assert.equal(
                        pageFrame.locationText,
                        '',
                        `${dump.fixture} thread #${index} frame ${cliFrame.index}: the CLI has no ` +
                            'location and the page shows one'
                    );
                    continue;
                }
                if (cliFrame.line === 0) {
                    // The declared line-0 divergence, counted here so the
                    // allow-list number is measured rather than asserted about.
                    lineZero++;
                    assert.equal(pageFrame.locationText, '');
                    continue;
                }
                located++;
                const info = parseFileInfo(cliFrame.file);
                assert.equal(
                    pageFrame.locationText,
                    `${info === null ? cliFrame.file : info.path}:${cliFrame.line}`,
                    `${dump.fixture} thread #${index} frame ${cliFrame.index}: location`
                );
            }
        }
    }
    assert.ok(located > 500, `only ${located} located frames compared`);
    assert.equal(lineZero, 1, 'the line-0 population changed; re-measure the divergence below');
});

// =========================================================================
// 3. Framing parity
// =========================================================================

test('the two default views are the declared different populations', async () => {
    // Not a bug on either side, and the numbers are asserted so the difference
    // stays a decision rather than becoming drift. The page renders every
    // thread; the CLI renders the crashing one at 20 frames, and says so.
    for (const dump of DUMPS) {
        const { file, view } = pageView(dump);
        const byDefault = await cliCrash(dump);

        assert.equal(byDefault.threads.length, 1, `${dump.fixture}: the default is one thread`);
        assert.equal(byDefault.threadRowCount, 1);
        assert.equal(byDefault.threads[0]!.crashing, true);
        assert.equal(byDefault.threads[0]!.index, view.crashingThread?.index);
        // 20 frames, or the whole stack when it is shorter. Asserted against
        // the fixture's real depth rather than against the constant the command
        // reads, which would pass whatever the constant said.
        const depth = file.crashing_thread?.frames.length ?? 0;
        assert.equal(byDefault.threads[0]!.frames.length, Math.min(20, depth), dump.fixture);
        assert.equal(byDefault.threads[0]!.frameCount, depth, dump.fixture);

        // The page: every thread, and the crashing one untruncated.
        assert.equal(view.otherThreads.length, file.threads.length - 1);
        assert.equal(view.crashingThread?.truncation, null, 'the crashing thread is never elided');
        assert.equal(
            view.crashingThread?.rows.filter((row) => row.kind === 'frame').length,
            depth
        );
    }
});

test('the page hides frames behind a control and keeps them; the CLI omits them', async () => {
    // The truncation difference is not a count: the page's hidden rows are in
    // the list with a `thread-extra-frames` class and a "Show N more" toggle,
    // so a reader can reach them without reloading. The CLI's are gone from the
    // payload and it prints how many. Both are right for their medium, and the
    // check is that neither *loses* the frames: the page's row list is complete
    // and the CLI reports the true `frameCount`.
    for (const dump of DUMPS) {
        const { file, view } = pageView(dump);
        const full = await cliCrash(dump, FULL);
        const byDefault = await cliCrash(dump, ['--all-threads']);

        let truncatedThreads = 0;
        for (const thread of view.otherThreads) {
            const frames = thread.rows.filter((row) => row.kind === 'frame');
            const real = file.threads[thread.index]!.frames.length;
            assert.equal(
                frames.length,
                real,
                `${dump.fixture} thread #${thread.index}: the page's row list must be complete ` +
                    'even where the control hides part of it'
            );
            if (thread.truncation !== null) {
                truncatedThreads++;
                assert.equal(thread.truncation.hiddenFrameCount, real - 10);
                assert.match(thread.truncation.label, /^▸ Show \d+ more frames?$/);
            } else {
                assert.ok(real <= 10);
            }
        }
        assert.ok(truncatedThreads > 0, `${dump.fixture}: no thread is long enough to truncate`);

        // The CLI: 8 frames per thread under --all-threads, and `frameCount`
        // still the truth. Against the fixture, not the constant.
        for (const thread of byDefault.threads) {
            const real = file.threads[thread.index]!.frames.length;
            assert.equal(thread.frameCount, real, `${dump.fixture} thread #${thread.index}`);
            assert.equal(thread.frames.length, Math.min(8, real));
        }
        assert.equal(byDefault.threads.length, full.threads.length);
    }
});

test('the hang assessment is the CLI only, and the page has no counterpart', async () => {
    // Named rather than left implicit: `detectHang` is a whole answer the page
    // does not offer, so "the CLI shows something the page does not" here is a
    // feature and not a parity failure. Asserted because the two dumps land on
    // opposite verdicts, which is what makes the field worth having.
    const crash = await cliCrash(DUMPS[0]!);
    const hang = await cliCrash(DUMPS[1]!);
    assert.equal(crash.hang.looksLikeHang, false);
    assert.equal(hang.hang.looksLikeHang, true);
    // And nothing in the page's view model carries it, which is what makes this
    // a CLI-only field rather than one the comparison forgot.
    const { view } = pageView(DUMPS[1]!);
    assert.equal(
        JSON.stringify(view).includes('looksLikeHang'),
        false,
        'the page view now has a hang field; this is no longer CLI-only'
    );
});

// =========================================================================
// Declared divergences
// =========================================================================

const DIVERGENCES: Divergence[] = [
    {
        what: 'the default view: which threads, how deep',
        reason:
            'The page has a scrollable document and renders all 59 threads with the crashing ' +
            "one untruncated; the CLI has a terminal and renders the crashing thread's first 20 " +
            'frames, with `--all-threads` dropping to 8 because 20 × 59 is a thousand lines of ' +
            'mostly-irrelevant stack (`cli/commands/crash.ts:90`). Neither loses anything: the ' +
            "page's hidden rows are in the DOM behind a toggle, and the CLI prints the true " +
            '`frameCount` and how many it elided. Asserted above with both numbers, so a change ' +
            'to either default is a change to this entry.',
        page: 'every thread; crashing thread untruncated, others 10 frames with a toggle',
        cli: 'the crashing thread only, 20 frames (8 with --all-threads)',
    },
    {
        what: 'the text shown for an unsymbolized frame',
        reason:
            "Upstream's `???` is what the page shows (`next/crash-view.ts:259`) and the CLI " +
            'falls back to `module + offset`. Both are derived from the same null ' +
            '`frame.function`, and the CLI reports `unsymbolized: true` so a consumer can tell ' +
            'the two apart — which is what makes the string a presentation choice rather than a ' +
            'lost fact. The module-plus-offset form is the more useful one in a terminal, where ' +
            'there is no row to hover and no adjacent module column to read; on the page the ' +
            'module already has its own column, so repeating it in the symbol cell would be ' +
            'noise. Measured: 51 of the hang dump\'s 323 frames, 0 of the crash dump\'s 1,025.',
        page: '???',
        cli: 'module + offset, with unsymbolized: true',
    },
    {
        what: 'a frame whose file is recorded with line 0',
        reason:
            "FOUND BY THIS FILE. The page's location cell is gated on `frame.file && frame.line` " +
            '(`next/crash-view.ts:317`), and `0` is falsy, so a frame recording ' +
            '`tools/profiler/core/platform.cpp` at line 0 shows no location at all — while the ' +
            'CLI emits `file` and `line: 0` and its renderer prints `platform.cpp:0`. One frame ' +
            'of the 1,348 in the corpus, so it is narrow, but it is a real disagreement about ' +
            'whether a location was recorded rather than a formatting choice. Left as it is ' +
            'because the fix is in `next/` or `cli/`, outside this change, and because which ' +
            'side is right is arguable: line 0 from a stack walker means "the file is known and ' +
            'the line is not", which the page renders as no location and the CLI as a location ' +
            'of zero. Neither reads as what it means.',
        page: 'no location shown',
        cli: 'file with line 0',
    },
    {
        what: 'the memory-access record and the instruction-pointer update',
        reason:
            'The page renders both in its crash-reason box — the faulting access ' +
            '(`0x00007ffee83df2d8`, 8-byte read) and the update the walker inferred — and the ' +
            "CLI's `CrashJson` carries neither. Not an oversight worth calling a bug: they are " +
            "the last thing read when a stack has already been read, and the command's stated " +
            'purpose (`cli/commands/crash.ts:4`) is to cut the 507 KB dump down to what an ' +
            'agent needs first. `--raw` prints the whole file for the case where they are ' +
            'wanted. Recorded so the omission stays a decision, and so a future addition to ' +
            '`CrashJson` deletes this entry rather than quietly closing it.',
        page: '1 memory access, an instruction-pointer update',
        cli: 'neither field exists',
    },
];

test('every declared divergence still diverges', () => {
    assertDeclaredDivergences('crash', DIVERGENCES);
});

test('the unsymbolized-frame divergence is exactly as large as declared', async () => {
    // The entry says 51 of 323 and 0 of 1,025. Measured here off the fixtures
    // *and* off the CLI, so the two have to agree about which frames are
    // unsymbolized before the count is checked — a `unsymbolized` flag that
    // drifted from `frame.function === null` would fail here first.
    const measured: Record<string, { unsymbolized: number; total: number }> = {};
    for (const dump of DUMPS) {
        const { file } = pageView(dump);
        const result = await cliCrash(dump, FULL);
        let unsymbolized = 0;
        let total = 0;
        for (const thread of result.threads) {
            const real: Thread = file.threads[thread.index]!;
            for (const [position, frame] of thread.frames.entries()) {
                total++;
                const source: Frame = real.frames[position]!;
                assert.equal(
                    frame.unsymbolized,
                    source.function === null,
                    `${dump.fixture} thread #${thread.index} frame ${frame.index}: the CLI's ` +
                        'unsymbolized flag disagrees with the dump'
                );
                if (frame.unsymbolized) {
                    unsymbolized++;
                }
            }
        }
        measured[dump.fixture] = { unsymbolized, total };
    }
    assert.deepEqual(measured, {
        'stackwalk-crash.json': { unsymbolized: 0, total: 1025 },
        'stackwalk-hang.json': { unsymbolized: 51, total: 323 },
    });
});

test('the memory-access divergence is present in the corpus, not hypothetical', async () => {
    // An allow-list entry for something no fixture exercises protects nothing.
    // The hang dump has one memory access and an instruction-pointer update;
    // the crash dump has neither, so the entry is about a real asymmetry rather
    // than about a field that is always empty on both sides.
    const hang = pageView(DUMPS[1]!).view;
    assert.equal(hang.crashReason?.memoryAccesses.length, 1);
    assert.equal(hang.crashReason?.instructionPointerUpdate, '0x00007fff7365b170');

    const crash = pageView(DUMPS[0]!).view;
    assert.equal(crash.crashReason?.memoryAccesses.length, 0);
    assert.equal(crash.crashReason?.instructionPointerUpdate, null);

    // And the CLI's payload carries neither, on the dump that has them.
    const result = await cliCrash(DUMPS[1]!, FULL);
    const keys = Object.keys(result);
    assert.ok(!keys.includes('memoryAccesses'));
    assert.ok(!keys.includes('instructionPointerUpdate'));
});
