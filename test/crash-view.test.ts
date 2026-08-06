/**
 * The crash viewer's view model, against the two real dumps.
 *
 * ## Why this imports from `site/`
 *
 * `site/crash-view.ts` is **page-local** — it names element ids, CSS classes
 * and glyphs, so it is the page's, not `lib/`'s (that module's comment gives
 * the rule and how it was applied). A node test importing it is the point:
 * being page-local costs nothing in testability, because the seam is the module
 * boundary rather than the directory.
 *
 * It also enforces something for free. The root tsconfig compiles `test/**` and
 * has **no DOM lib**, so this import is what makes a `document` reach from the
 * view model a compile error — verified by adding one, which fails the root
 * project with TS2584 while the `next` project accepts it.
 *
 * The genuinely shared helpers moved to `lib/` and **their tests moved with
 * them**: `parseFileInfo`, `sourceUrl`, `searchfoxFrameUrl` and
 * `crashStatsSearchUrl` are covered in `test/links.test.ts`, beside the other
 * URL builders. What is left here is what the view model *composes* out of
 * them — which text ends up inside a link and which outside it — because that
 * is the page's decision rather than the builder's.
 *
 * ## What these tests are for, and what they deliberately are not
 *
 * They are **not** DOM tests. `site/crash-viewer.ts` turns the structures below
 * into elements and nothing else, and asserting on that in node needs a DOM
 * shim that is itself a second implementation of the browser — expensive, and
 * it would pass while the real page was blank. The rendering is verified where
 * it actually runs: both pages loaded in a real browser against the same eight
 * dumps, compared node for node (`PARITY.md` §4).
 *
 * What is tested here is everything the renderer cannot get wrong on its own:
 * which rows exist, which are hidden, what each link points at, and what the
 * text says. Those are decisions, they are where a port goes wrong, and they
 * are values.
 *
 * ## The one test that carries the migration
 *
 * `crashView().signature` must equal `crashSignature()` for every dump. The
 * page's whole reason to exist is that signature — it is the `<h1>`, the
 * `document.title`, and what `fx-tests crashes` groups on — and the migration's
 * headline claim is that dropping the page's inline copy of the heuristic
 * changed nothing. That claim is one assertion, and it is below.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    type Frame,
    type StackwalkFile,
    type Thread,
    formatHexOffset,
} from '../lib/formats/stackwalk.ts';
import { crashSignature } from '../lib/model/crash-signature.ts';
import {
    THREAD_FRAME_PREVIEW,
    crashView,
    crashingThreadView,
    frameRows,
    otherThreadViews,
    trustDescription,
} from '../site/crash-view.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

function fixture(name: string): StackwalkFile {
    return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as StackwalkFile;
}

/** A frame with only the fields the view reads. */
function frame(partial: Partial<Frame>): Frame {
    return {
        frame: 0,
        function: null,
        function_offset: null,
        file: null,
        line: null,
        module: null,
        module_offset: null,
        offset: '0x0',
        missing_symbols: false,
        trust: 'cfi',
        unloaded_modules: null,
        ...partial,
    };
}

// --- the signature, which is the whole point -----------------------------

test('the view’s signature IS lib/’s, on both real dumps', () => {
    // The migration's headline claim in one assertion. `crash-viewer.html` had
    // its own transcription of the heuristic (`:501-555`); the page now has
    // none, and this is what says the removal changed nothing.
    for (const name of ['stackwalk-crash.json', 'stackwalk-hang.json']) {
        const file = fixture(name);
        const view = crashView(file);
        assert.equal(view.signature, crashSignature(file), name);
        // …and the two places it is shown are derived from it, not recomputed.
        assert.equal(view.documentTitle, `Crash ${view.signature}`);
    }
});

test('the signatures are the exact strings the old page displayed', () => {
    // Pinned as literals as well as against `crashSignature`, so that a change
    // agreeing with itself across both modules still fails here. These are the
    // strings read out of `crash-viewer.html` in a browser.
    assert.equal(crashView(fixture('stackwalk-crash.json')).signature, '@ KiUserCallbackDispatcher');
    assert.equal(
        crashView(fixture('stackwalk-hang.json')).signature,
        '@ libsystem_kernel.dylib + 0x0000000000000dfa'
    );
});

// --- formatting ----------------------------------------------------------

test('formatHexOffset keeps a digit when the value is all zeros', () => {
    assert.equal(formatHexOffset('0x000000000000004c'), '0x4c');
    // The case a "simplification" to `0*(.*)` breaks: `.+` must leave one
    // character, so this is `0x0` and not `0x`.
    assert.equal(formatHexOffset('0x0000000000000000'), '0x0');
    assert.equal(formatHexOffset('0x4c'), '0x4c');
    assert.equal(formatHexOffset(null), '');
    assert.equal(formatHexOffset(''), '');
});

test('an unrecognized trust level falls back to itself, not to a placeholder', () => {
    assert.equal(trustDescription('cfi'), 'Call Frame Information - most reliable, from debugging data');
    // The walker may grow a new value; showing it beats hiding it.
    assert.equal(trustDescription('brand_new_kind'), 'brand_new_kind');
    assert.equal(trustDescription(null), '');
});

// --- rows ----------------------------------------------------------------

test('a frame’s inlined callees are rows BEFORE it, sharing its classes', () => {
    const rows = frameRows(
        frame({
            frame: 3,
            function: 'Parent(int)',
            module: 'xul.so',
            inlines: [
                { function: 'Inner()', file: null, line: null },
                { function: 'Middle()', file: null, line: null },
            ],
        }),
        { crashed: true }
    );
    assert.deepEqual(
        rows.map((r) => [r.kind, r.functionText, r.number]),
        [
            ['inline', 'Inner()', ''],
            ['inline', 'Middle()', ''],
            ['frame', 'Parent(int)', '3'],
        ]
    );
    // The whole innermost group is highlighted, inlines included: they are
    // inside the frame, so they crashed too.
    assert.ok(rows.every((r) => r.classes.includes('crashed')));
    // An inline is attributed to its parent's module — it carries none.
    assert.ok(rows.every((r) => r.module === 'xul.so'));
});

test('an inline row carries NO title attribute where a frame row carries an empty one', () => {
    // Three-valued on purpose, and found by diffing the rendered DOM: upstream
    // writes `<td class="frame-trust">inline</td>` for an inline and
    // `title="${...}"` — present but empty — for a frame with unrecognized
    // trust. 15 cells on one real dump differed by exactly this.
    const rows = frameRows(
        frame({ function: 'F()', trust: '', inlines: [{ function: 'I()', file: null, line: null }] })
    );
    assert.equal(rows[0]!.kind, 'inline');
    assert.equal(rows[0]!.trust, 'inline');
    assert.equal(rows[0]!.trustTitle, null, 'an inline row must emit no title attribute');
    assert.equal(rows[1]!.kind, 'frame');
    assert.equal(rows[1]!.trustTitle, '', 'a frame row must emit an empty title, not none');
});

test('an unsymbolized frame shows ??? and links nowhere', () => {
    const [row] = frameRows(frame({ function: null, module: 'libc.so', module_offset: '0x1234' }));
    assert.equal(row!.functionText, '???');
    assert.equal(row!.functionUrl, null);
    // …and a frame with no module at all reads `unknown`, not empty.
    const [bare] = frameRows(frame({ function: null, module: null }));
    assert.equal(bare!.module, 'unknown');
});

test('the function offset is OUTSIDE the location link, not part of its text', () => {
    // The regression this pins. An earlier port folded the offset into
    // `locationText`, so it rendered as link text: `+0x4c` became clickable and
    // underlined. The characters on screen were identical, which is why a
    // `textContent` comparison passed and the browser node-level diff did not —
    // it reported 110 differing cells on `win32-mfcdm` alone and 902 on
    // `rustpanic`.
    //
    // Upstream (`crash-viewer.html:924-934`) writes:
    //     <a href=… class="file-link" target="_blank">a/b.cpp:12</a> +0x4c
    // so the two are separate fields here and the renderer appends the second
    // as a bare text node after the `</a>`.
    const [withLine] = frameRows(
        frame({
            function: 'F()',
            file: 'hg:hg.mozilla.org/mozilla-central:a/b.cpp:rev',
            line: 12,
            function_offset: '0x000000000000004c',
        })
    );
    assert.equal(withLine!.locationText, 'a/b.cpp:12', 'the link text is the path and line alone');
    assert.equal(withLine!.locationOffsetText, ' +0x4c', 'the offset is a separate, unlinked field');
    // The leading space belongs to the offset field, because upstream's text
    // node starts with one — a renderer adding its own separator would double it.
    assert.ok(withLine!.locationOffsetText.startsWith(' '));
    assert.ok(
        !withLine!.locationText.includes('+'),
        'an offset inside the link text is the defect this test exists for'
    );

    // Upstream appends the offset only inside the `file && line` branch, so a
    // frame with an offset but no line shows nothing — a bare `+0x4c` in a
    // column headed "Location" reads as a line number.
    const [withoutLine] = frameRows(
        frame({ function: 'F()', file: null, line: null, function_offset: '0x4c' })
    );
    assert.equal(withoutLine!.locationText, '');
    assert.equal(withoutLine!.locationOffsetText, '');

    // A located frame with no offset gets no trailing node at all, rather than
    // a stray ` +`.
    const [noOffset] = frameRows(
        frame({
            function: 'F()',
            file: 'hg:hg.mozilla.org/mozilla-central:a/b.cpp:rev',
            line: 12,
            function_offset: null,
        })
    );
    assert.equal(noOffset!.locationText, 'a/b.cpp:12');
    assert.equal(noOffset!.locationOffsetText, '');

    // An inline row never carries one: upstream's inline branch has no
    // `function_offset` clause.
    //
    // The parent here is deliberately given a *resolvable* location and its own
    // offset. With `file: null` on the parent the assertion below is vacuous —
    // an implementation that wrongly copied the parent's offset onto the inline
    // row would still produce `''`, because the parent has no location to hang
    // one off. Measured: with the parent unlocated, mutating the inline branch
    // to `frameLocationOffsetText(frame)` survived the suite.
    const [inline, parent] = frameRows(
        frame({
            function: 'F()',
            file: 'hg:hg.mozilla.org/mozilla-central:a/parent.cpp:rev',
            line: 99,
            function_offset: '0x000000000000004c',
            inlines: [
                {
                    function: 'I()',
                    file: 'hg:hg.mozilla.org/mozilla-central:a/b.cpp:rev',
                    line: 7,
                },
            ],
        })
    );
    assert.equal(inline!.kind, 'inline');
    assert.equal(inline!.locationText, 'a/b.cpp:7');
    assert.equal(
        inline!.locationOffsetText,
        '',
        'an inline must not inherit its parent’s offset'
    );
    // The parent, in the same call, does carry it — so the empty string above
    // is a decision about inlines and not a function that always returns ''.
    assert.equal(parent!.kind, 'frame');
    assert.equal(parent!.locationText, 'a/parent.cpp:99');
    assert.equal(parent!.locationOffsetText, ' +0x4c');
});

test('only a frame with registers gets a details id, and the pairs are sorted', () => {
    const [plain] = frameRows(frame({ function: 'F()' }));
    assert.equal(plain!.detailsId, null);
    assert.deepEqual(plain!.registers, []);

    const [withRegisters] = frameRows(
        frame({ frame: 0, function: 'F()', registers: { rsp: '0x3', rax: '0x1', rbx: '0x2' } })
    );
    // Upstream's id spelling, which a bookmarked `#frame-0-details` depends on.
    assert.equal(withRegisters!.detailsId, 'frame-0-details');
    assert.deepEqual(withRegisters!.registers, [
        ['rax', '0x1'],
        ['rbx', '0x2'],
        ['rsp', '0x3'],
    ]);
});

test('two register-bearing threads collide on frame-0-details, which is why the id is not the handle', () => {
    // The dump this needs is **not present in the current corpus** — all nine
    // dumps in `artifacts/dumps/` carry registers on exactly one frame (frame 0
    // of the `crashing_thread` copy) and on none of any `threads[i]`. It is not
    // unreachable, though: `minidump-stackwalk` emits `registers` for any
    // thread's context frame, so this constructs one.
    //
    // What it pins is the *reason* the renderer closes over the details element
    // instead of calling `getElementById(detailsId)`. In a browser, with two
    // `id="frame-0-details"` elements, `getElementById` returns the first in
    // document order — the crashing thread's, rendered above "Other Threads" —
    // so the old page opens the WRONG thread's registers when the second
    // thread's row is clicked. Measured in Chrome on exactly such a dump:
    //
    //   OLD  clicking the other thread's row -> CRASHING thread's registers
    //   NEW  clicking the other thread's row -> that thread's registers
    //
    // This test asserts the collision is real (so the fix is not decorative);
    // that the fix works is a DOM behaviour, verified in the browser run.
    const file = fixture('stackwalk-crash.json');
    const crashingIndex = file.crash_info!.crashing_thread;
    const other = crashingIndex === 0 ? 1 : 0;
    file.threads[other]!.frames[0]!.registers = { rip: '0xDEAD', rax: '0xBEEF' };

    const crashingRows = crashingThreadView(file)!.rows;
    const otherRows = otherThreadViews(file).find((v) => v.index === other)!.rows;

    const crashingIds = crashingRows.map((r) => r.detailsId).filter((id) => id !== null);
    const otherIds = otherRows.map((r) => r.detailsId).filter((id) => id !== null);
    assert.deepEqual(crashingIds, ['frame-0-details']);
    assert.deepEqual(otherIds, ['frame-0-details']);
    // The same id, on two rows the page renders together: an id lookup cannot
    // tell them apart, and the renderer must not use one.
    assert.deepEqual(
        crashingIds,
        otherIds,
        'the ids collide — a getElementById-based toggle would open the wrong thread'
    );
    // The registers behind each are different, which is what a reader loses.
    assert.deepEqual(
        otherRows.find((r) => r.detailsId !== null)!.registers,
        [
            ['rax', '0xBEEF'],
            ['rip', '0xDEAD'],
        ],
        'the other thread has its own registers, so opening the crashing thread’s is a real loss'
    );

    // `idPrefix` is the escape hatch for a caller that wants unique ids.
    const [prefixed] = frameRows(frame({ frame: 0, registers: { rax: '0x1' } }), {
        idPrefix: 'thread-3-',
    });
    assert.equal(prefixed!.detailsId, 'thread-3-frame-0-details');
});

// --- threads -------------------------------------------------------------

test('the crashing thread is never truncated and comes from the copy with registers', () => {
    const file = fixture('stackwalk-hang.json');
    const view = crashingThreadView(file)!;
    assert.equal(view.truncation, null, 'the thread the page was opened for is shown whole');
    assert.equal(view.crashing, true);

    // Every frame is present. Rows ≥ frames because inlines add rows.
    const frameCount = view.rows.filter((r) => r.kind === 'frame').length;
    assert.equal(frameCount, file.crashing_thread!.frames.length);
    assert.equal(frameCount, 56);

    // Rendered from `crashing_thread`, not `threads[i]`: only that copy carries
    // registers, and rendering from the array silently drops the expansion.
    const index = file.crash_info!.crashing_thread;
    assert.equal(
        file.threads[index]!.frames.filter((f) => f.registers !== undefined).length,
        0,
        'threads[] has no registers — so the view must not be built from it'
    );
    assert.equal(view.rows.filter((r) => r.detailsId !== null).length, 1);
});

test('only the innermost frame is highlighted, and by position', () => {
    const view = crashingThreadView(fixture('stackwalk-hang.json'))!;
    const highlighted = view.rows.filter((r) => r.classes.includes('crashed'));
    // The first frame's group only — here one frame with no inlines.
    assert.ok(highlighted.length >= 1);
    assert.equal(view.rows[0]!.classes.includes('crashed'), true);
    assert.equal(view.rows[view.rows.length - 1]!.classes.includes('crashed'), false);
});

test('the preview is 10 frames — pinned as a literal, not read off the constant', () => {
    // `THREAD_FRAME_PREVIEW` is asserted to BE 10 rather than used to compute
    // the expectation. Deriving the expectation from the constant makes the
    // test agree with whatever the constant says: changing it to 9 left the
    // whole suite green, because every assertion moved with it.
    assert.equal(THREAD_FRAME_PREVIEW, 10);

    const file = fixture('stackwalk-crash.json');
    const views = otherThreadViews(file);
    const byIndex = new Map(views.map((v) => [v.index, v]));

    // The boundary, and what actually kills a 10→9 mutation: thread #13 has
    // exactly 10 frames, so it must show all ten and offer no toggle. At a
    // preview of 9 it would hide one and grow a "Show 1 more frame" control.
    assert.equal(file.threads[13]!.frames.length, 10, 'fixture: #13 is the boundary thread');
    const boundary = byIndex.get(13)!;
    assert.equal(boundary.truncation, null, 'a thread of exactly 10 frames must not truncate');
    assert.equal(boundary.rows.filter((r) => r.kind === 'frame').length, 10);
    assert.equal(boundary.rows.filter((r) => r.classes.includes('thread-extra-frames')).length, 0);

    // …and one thread on the other side of the boundary, pinned by hand.
    // #5 has 12 frames: 10 shown, 2 hidden, plural label.
    assert.equal(file.threads[5]!.frames.length, 12, 'fixture: #5 has 12 frames');
    const over = byIndex.get(5)!;
    assert.equal(
        over.rows.filter((r) => r.kind === 'frame' && !r.classes.includes('thread-extra-frames'))
            .length,
        10
    );
    assert.equal(over.truncation!.hiddenFrameCount, 2);
    assert.equal(over.truncation!.label, '▸ Show 2 more frames');
    assert.equal(over.truncation!.toggleId, 'thread-toggle-5');

    // Across the whole fixture: 47 threads truncate and 11 do not, at a
    // preview of 10. Both counts move if the constant does.
    assert.equal(views.length, 58);
    assert.equal(views.filter((v) => v.truncation !== null).length, 47);
    assert.equal(views.filter((v) => v.truncation === null).length, 11);
});

test('truncation counts FRAMES, not rows, and drops none of them', () => {
    const file = fixture('stackwalk-crash.json');
    const views = otherThreadViews(file);
    // The crashing thread is skipped by index, so exactly one thread is absent.
    assert.equal(views.length, file.threads.length - 1);
    assert.ok(views.every((v) => !v.crashing));
    assert.ok(views.every((v) => v.index !== file.crash_info!.crashing_thread));

    for (const view of views) {
        const thread = file.threads[view.index]!;
        const visible = view.rows.filter((r) => !r.classes.includes('thread-extra-frames'));
        const hidden = view.rows.filter((r) => r.classes.includes('thread-extra-frames'));
        const visibleFrames = visible.filter((r) => r.kind === 'frame').length;

        if (view.truncation === null) {
            assert.ok(thread.frames.length <= 10, `#${view.index} untruncated but long`);
            assert.equal(hidden.length, 0);
            assert.equal(visibleFrames, thread.frames.length);
            continue;
        }
        assert.equal(visibleFrames, 10, `#${view.index} preview`);
        // The label counts hidden *frames*; a hidden frame with three inlines
        // is four rows but one frame, and "1 more frame" is what a reader means.
        assert.equal(view.truncation.hiddenFrameCount, thread.frames.length - 10);
        assert.equal(
            hidden.filter((r) => r.kind === 'frame').length,
            view.truncation.hiddenFrameCount
        );
        // Nothing is dropped: preview + hidden is the whole thread.
        assert.equal(
            visibleFrames + view.truncation.hiddenFrameCount,
            thread.frames.length,
            `#${view.index} loses frames`
        );
    }
});

test('the "Show N more" label is singular for exactly one hidden frame', () => {
    // The singular case is **not present in the fixture** — no thread in
    // `stackwalk-crash.json` has exactly 11 frames, so the smallest hidden
    // count is 2. The earlier version of this test derived its expected plural
    // from the label under test (`count === 1 ? … : …`), so it asserted
    // "whatever the label says, say that", and `> 1` → `> 0` survived.
    //
    // Built here instead, at the three counts that matter.
    const threadOf = (frameCount: number): Thread => ({
        frame_count: frameCount,
        frames: Array.from({ length: frameCount }, (_unused, index) =>
            frame({ frame: index, function: `F${index}()` })
        ),
        last_error_value: null,
        thread_id: 4242,
        thread_name: 'Worker',
    });
    const labelFor = (frameCount: number): string | null => {
        const file = fixture('stackwalk-crash.json');
        // Index 1 so it is never the crashing thread (index 0).
        file.threads = [file.threads[0]!, threadOf(frameCount)];
        return otherThreadViews(file)[0]!.truncation?.label ?? null;
    };

    // 11 frames -> exactly 1 hidden -> singular. This is the assertion the
    // `> 1` → `> 0` mutation fails.
    assert.equal(labelFor(11), '▸ Show 1 more frame');
    // 12 -> 2 hidden -> plural.
    assert.equal(labelFor(12), '▸ Show 2 more frames');
    // 10 -> nothing hidden -> no control at all.
    assert.equal(labelFor(10), null);

    // The toggle ids are the thread indices, which is what upstream's
    // `thread-toggle-<idx>` spelling means and what a saved link would use.
    const file = fixture('stackwalk-crash.json');
    for (const view of otherThreadViews(file)) {
        if (view.truncation !== null) {
            assert.equal(view.truncation.toggleId, `thread-toggle-${view.index}`);
        }
    }
});

test('a thread heading repeats the tid only when the thread is unnamed', () => {
    const file = fixture('stackwalk-crash.json');
    for (const view of [...otherThreadViews(file), crashingThreadView(file)!]) {
        assert.equal(view.headingTitle, `tid: ${view.threadId}`);
        assert.equal(
            view.heading,
            view.name === null ? `#${view.index} - tid: ${view.threadId}` : `#${view.index} - ${view.name}`
        );
    }
    // The crash fixture's crashing thread is unnamed — a real case, and the
    // one a "just show the name" implementation renders as `#0 - null`.
    assert.equal(crashingThreadView(file)!.name, null);
    assert.match(crashingThreadView(file)!.heading, /^#0 - tid: \d+$/);
});

// --- the whole view ------------------------------------------------------

test('the sidecar is optional, and the fields it fills fall back sanely', () => {
    const file = fixture('stackwalk-crash.json');

    const without = crashView(file);
    assert.equal(without.extraData, null, 'no sidecar means no collapsed block at all');
    assert.equal(without.crashReason!.mozCrashReason, null);
    // A dump with no sidecar is the main process by default.
    assert.equal(without.processInfo[0]!.value, 'main');
    assert.ok(!without.processInfo.some((f) => f.label === 'URL:'));

    const withExtra = crashView(file, {
        extra: {
            MozCrashReason: 'MOZ_RELEASE_ASSERT(x)',
            RemoteType: 'web',
            ProcessType: 'tab',
            URL: 'https://example.com/page',
            Foo: 'bar',
            Nested: { a: 1 },
        },
    });
    assert.equal(withExtra.crashReason!.mozCrashReason, 'MOZ_RELEASE_ASSERT(x)');
    // `RemoteType` wins over `ProcessType` where both are present.
    assert.equal(withExtra.processInfo[0]!.value, 'web');
    const urlField = withExtra.processInfo.find((f) => f.label === 'URL:')!;
    assert.equal(urlField.value, 'https://example.com/page');
    assert.equal(urlField.full, true, 'the URL row spans the grid');
    // The four fields shown above are not repeated in the collapsed block.
    assert.deepEqual(
        withExtra.extraData!.fields.map((f) => f.name),
        ['Foo', 'Nested']
    );
    assert.equal(withExtra.extraData!.label, '▸ Show all extra data (2 fields)');
    // An object value is pretty-printed rather than shown as [object Object].
    assert.equal(withExtra.extraData!.fields[1]!.value, '{\n  "a": 1\n}');
});

test('a sidecar with nothing new to say produces no collapsed block', () => {
    // Every field already displayed above, so there is nothing left — and an
    // empty "Show all extra data (0 fields)" toggle would be worse than none.
    const view = crashView(fixture('stackwalk-crash.json'), {
        extra: { MozCrashReason: 'x', ProcessType: 'tab' },
    });
    assert.equal(view.extraData, null);
});

test('instruction_pointer_update reads .address rather than the object', () => {
    // Declared divergence 4. The old page interpolates the object and renders
    // `[object Object]`, which the browser comparison caught on a real dump.
    const hang = fixture('stackwalk-hang.json');
    assert.equal(crashView(hang).crashReason!.instructionPointerUpdate, '0x00007fff7365b170');
    // Null stays null: the page then says so in words, which is information
    // about the faulting instruction rather than missing data.
    assert.equal(
        crashView(fixture('stackwalk-crash.json')).crashReason!.instructionPointerUpdate,
        null
    );
});

test('the null-pointer note appears only for that adjusted kind', () => {
    const file = fixture('stackwalk-crash.json');
    assert.equal(crashView(file).crashReason!.nullPointerOffset, null);

    file.crash_info!.adjusted_address = { kind: 'null-pointer', offset: '0x18' };
    assert.equal(crashView(file).crashReason!.nullPointerOffset, '0x18');
    // Another kind is not a null pointer, and must not borrow the red note.
    file.crash_info!.adjusted_address = { kind: 'heap-corruption', offset: '0x8' };
    assert.equal(crashView(file).crashReason!.nullPointerOffset, null);
});

test('the Linux distribution is merged into the OS row, and only on Linux', () => {
    const file = fixture('stackwalk-crash.json');
    // Windows: no lsb_release, so the OS row is the OS alone.
    assert.equal(crashView(file).systemInfo[0]!.value, 'Windows NT');

    (file as { lsb_release?: unknown }).lsb_release = { description: 'Ubuntu 24.04.1 LTS' };
    assert.equal(crashView(file).systemInfo[0]!.value, 'Windows NT - Ubuntu 24.04.1 LTS');
    // Without a description the parts are joined with upstream's separators,
    // which is why a partial record can read with a doubled space.
    (file as { lsb_release?: unknown }).lsb_release = { id: 'Ubuntu', release: '24.04' };
    assert.equal(crashView(file).systemInfo[0]!.value, 'Windows NT - Ubuntu 24.04 - ');
});

test('the module table formats base addresses and tolerates missing fields', () => {
    const view = crashView(fixture('stackwalk-crash.json'));
    assert.equal(view.modules.length, 101);

    // All four columns of one row, pinned as literals. Two of them — version
    // and size — were previously asserted nowhere at all, so replacing either
    // with a constant went unnoticed.
    assert.deepEqual(view.modules[0], {
        filename: 'xpcshell.exe',
        version: '155.0.0.848',
        // `0x003e0000` with its leading zeros stripped.
        baseAddress: '0x3e0000',
        // Every module in every dump in the corpus records `size: null` — the
        // walker does not emit the field for these builds — so `''` is what
        // this column actually shows. Pinned so a constant cannot hide here.
        size: '',
    });

    // A different row, so a single hard-coded row cannot satisfy the column.
    assert.equal(view.modules[1]!.version, '10.0.26100.7920');
    assert.notEqual(view.modules[0]!.version, view.modules[1]!.version);
    assert.notEqual(view.modules[0]!.baseAddress, view.modules[1]!.baseAddress);
    // 20 distinct versions across 101 modules: the column varies with its
    // input, which a constant does not.
    assert.equal(new Set(view.modules.map((m) => m.version)).size, 20);
    assert.equal(new Set(view.modules.map((m) => m.baseAddress)).size, 101);

    for (const module of view.modules) {
        // Leading zeros stripped, and never left as a bare `0x`.
        if (module.baseAddress !== '') {
            assert.match(module.baseAddress, /^0x[0-9a-f]+$/);
        }
    }
});

test('a module with no filename reads "unknown", and the other columns tolerate absence', () => {
    // Constructed, because **0 of the 101 fixture modules has a falsy
    // filename** — the earlier `filename.length > 0` loop was therefore
    // vacuous, and `|| 'unknown'` → `|| ''` survived it.
    const file = fixture('stackwalk-crash.json');
    file.modules = [
        // Every field absent or empty: the row a "just read the fields"
        // implementation renders as four blanks.
        {
            base_addr: '',
            end_addr: '',
            filename: '',
            version: null,
        } as unknown as (typeof file.modules)[number],
        // A fully-populated row, including the `size` the walker omits in the
        // corpus, so the column is exercised with a real value at least once.
        {
            base_addr: '0x0000000000401000',
            end_addr: '0x0000000000502000',
            filename: 'libxul.so',
            version: '155.0.0.848',
            size: 1052672,
        } as unknown as (typeof file.modules)[number],
    ];
    const [blank, full] = crashView(file).modules;

    assert.equal(blank!.filename, 'unknown', 'an empty filename must read "unknown", not ""');
    assert.equal(blank!.version, '');
    assert.equal(blank!.baseAddress, '');
    assert.equal(blank!.size, '');

    assert.equal(full!.filename, 'libxul.so');
    assert.equal(full!.version, '155.0.0.848');
    assert.equal(full!.baseAddress, '0x401000');
    assert.equal(full!.size, '1052672', 'a size the walker does emit must be shown');
});

test('a dump with no crash_info still renders what it has', () => {
    // Every field of a stackwalk file is nullable (`stackwalk.ts`), and a view
    // that throws on one is a blank page rather than a partial one.
    const file = fixture('stackwalk-crash.json');
    delete file.crash_info;
    const view = crashView(file);
    assert.equal(view.crashReason, null);
    // With no `crash_info.crashing_thread`, the heading falls back to #0 and
    // no thread is skipped from the "other threads" list.
    assert.equal(view.crashingThread!.index, 0);
    assert.equal(view.otherThreads.length, file.threads.length);
    assert.ok(view.signature.startsWith('@ '));
});
