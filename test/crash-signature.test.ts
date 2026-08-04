/**
 * The crash-signature heuristic, against the two real dumps.
 *
 * `PLAN.md` §3 step 5 asks for this specifically: "the signature heuristic must
 * be tested against real dumps (fixtures), because 'skip abort frames, strip
 * parameter lists' is easy to get subtly wrong". The end-to-end command tests
 * exercise the signature on two dumps and are not enough on their own — neither
 * fixture's crashing thread has an abort frame or an inline on it, so the two
 * rules that do the most work are invisible from the command's output.
 *
 * These tests therefore drive the pieces directly, with synthetic frames where
 * the fixtures do not happen to contain the case, and with the fixtures where
 * they do. Every one of them was written after a mutation of the corresponding
 * rule survived the command-level suite.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Frame, StackwalkFile, Thread } from '../lib/formats/stackwalk.ts';
import {
    ABORT_SIGNATURES,
    ABORT_SUBSTRINGS,
    BLOCKED_FRAME_FRAGMENTS,
    UNKNOWN_SIGNATURE,
    crashSignature,
    detectHang,
    faultingAddress,
    flattenFrames,
    frameName,
    isAbortFrame,
    isBlockedThread,
    stripParameters,
} from '../lib/model/crash-signature.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

function fixture(name: string): StackwalkFile {
    return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as StackwalkFile;
}

/** A frame with only the fields the heuristic reads. */
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
        trust: 'context',
        unloaded_modules: null,
        ...partial,
    };
}

/** A dump whose crashing thread has these frames. */
function dumpWith(frames: Frame[]): StackwalkFile {
    const thread: Thread = {
        frame_count: frames.length,
        frames,
        last_error_value: null,
        thread_id: 1,
        thread_name: 'MainThread',
    };
    return {
        crash_info: {
            address: '0x0',
            adjusted_address: null,
            assertion: null,
            crash_inconsistencies: [],
            crashing_thread: 0,
            instruction: null,
            instruction_pointer_update: null,
            memory_accesses: null,
            possible_bit_flips: null,
            type: 'SIGSEGV / SEGV_MAPERR',
        },
        crashing_thread: thread,
        handles: null,
        main_module: 0,
        modules: [],
        modules_contains_cert_info: false,
        pid: 1,
        proc_limits: null,
        soft_errors: null,
        status: 'OK',
        system_info: { cpu_arch: 'amd64', cpu_count: 1, cpu_info: null, cpu_microcode_version: null, os: 'Linux', os_ver: '1' },
        thread_count: 1,
        threads: [thread],
        unloaded_modules: [],
    };
}

// --- parameter stripping -------------------------------------------------

test('stripParameters cuts at the LAST paren, because the group is greedy', () => {
    // Measured against the real behaviour rather than assumed. `/(.*)\(.*\)/`'s
    // first group is greedy, so it takes the last `(` that still has a `)`
    // after it. Making it lazy — the obvious "simplification" — changes both of
    // these, and a mutation doing exactly that survived the command tests.
    assert.equal(stripParameters('@ foo(bar(int), baz)'), '@ foo(bar');
    assert.equal(
        stripParameters('@ std::function<void ()>::operator()() const'),
        '@ std::function<void ()>::operator()'
    );
    // The ordinary case, which a lazy match would also get right — included so
    // the two above are visibly the discriminating ones.
    assert.equal(
        stripParameters('@ mozilla::dom::Selection::AddRange(nsRange&, ErrorResult&)'),
        '@ mozilla::dom::Selection::AddRange'
    );
    // No parentheses: unchanged, not emptied.
    assert.equal(stripParameters('@ KiUserCallbackDispatcher'), '@ KiUserCallbackDispatcher');
});

// --- abort frames --------------------------------------------------------

test('isAbortFrame matches the exact list and the substring list', () => {
    // Exact entries are full symbol names including their parameter lists, so
    // a prefix match would not do.
    assert.ok(isAbortFrame('MOZ_Crash(char const*, int, char const*)'));
    assert.ok(isAbortFrame('mozalloc_abort'));
    assert.ok(isAbortFrame('RustMozCrash'));
    // Substrings exist for the Rust panic machinery, whose symbols carry
    // monomorphized type names no exact list could keep up with.
    assert.ok(isAbortFrame('core::panicking::panic_fmt'));
    assert.ok(isAbortFrame('std::panicking::rust_panic_with_hook'));
    assert.ok(isAbortFrame('gkrust::some_panic_handler'));
    // And ordinary frames are not abort frames, or the rule would eat the
    // whole stack.
    assert.ok(!isAbortFrame('mozilla::dom::Selection::AddRange'));
    assert.ok(!isAbortFrame('KiUserCallbackDispatcher'));
    assert.ok(!isAbortFrame('RunCurrentEventLoopInMode'));
});

test('the abort lists are non-empty and are actually consulted', () => {
    // A mutation replacing the substring check with `false` survived the
    // command tests, because neither fixture has a Rust panic on its crashing
    // thread. This is the assertion that notices.
    assert.ok(ABORT_SIGNATURES.length > 10);
    assert.ok(ABORT_SUBSTRINGS.length > 0);
    for (const fragment of ABORT_SUBSTRINGS) {
        assert.ok(
            isAbortFrame(`prefix${fragment}suffix`),
            `${fragment} is in the list but does not match`
        );
    }
    for (const name of ABORT_SIGNATURES) {
        assert.ok(isAbortFrame(name), `${name} is in the list but does not match`);
    }
});

test('crashSignature skips abort frames to reach the first meaningful one', () => {
    const dump = dumpWith([
        frame({ frame: 0, function: 'mozalloc_abort' }),
        frame({ frame: 1, function: 'MOZ_Crash(char const*, int, char const*)' }),
        frame({ frame: 2, function: 'core::panicking::panic_fmt' }),
        frame({ frame: 3, function: 'mozilla::dom::Document::Foo(int)' }),
        frame({ frame: 4, function: 'nsGlobalWindow::Bar()' }),
    ]);
    // Not `@ mozalloc_abort`: skipping the abort frames is the whole point, and
    // without it every abort in the tree gets the same signature.
    assert.equal(crashSignature(dump), '@ mozilla::dom::Document::Foo');
});

test('crashSignature falls back to the first frame when all of them abort', () => {
    const dump = dumpWith([
        frame({ frame: 0, function: 'mozalloc_abort' }),
        frame({ frame: 1, function: 'RustMozCrash' }),
    ]);
    // Upstream's fallback: a signature naming the abort is still more useful
    // than `@ Unknown`.
    assert.equal(crashSignature(dump), '@ mozalloc_abort');
});

test('crashSignature is @ Unknown only when there is nothing at all', () => {
    assert.equal(crashSignature(dumpWith([])), UNKNOWN_SIGNATURE);
});

// --- inlines -------------------------------------------------------------

test('flattenFrames puts inlined callees BEFORE their parent', () => {
    const frames = [
        frame({
            frame: 0,
            function: 'Parent()',
            inlines: [
                { function: 'InnerMost()', file: null, line: null },
                { function: 'Middle()', file: null, line: null },
            ],
        }),
        frame({ frame: 1, function: 'Caller()' }),
    ];
    // An inlined callee is *inside* its parent, so it is the more precise
    // answer. Reversing this attributes the crash to the function that inlined
    // it — one level too coarse, and often a helper shared by hundreds of call
    // sites.
    assert.deepEqual(flattenFrames(frames), [
        'InnerMost()',
        'Middle()',
        'Parent()',
        'Caller()',
    ]);
});

test('the signature comes from an inlined callee, not its parent', () => {
    const dump = dumpWith([
        frame({
            frame: 0,
            function: 'mozilla::Outer(int)',
            inlines: [{ function: 'mozilla::Inlined(char)', file: null, line: null }],
        }),
    ]);
    assert.equal(crashSignature(dump), '@ mozilla::Inlined');
});

test('a null inline name is skipped rather than becoming the signature', () => {
    const dump = dumpWith([
        frame({
            frame: 0,
            function: 'mozilla::Real()',
            inlines: [{ function: null, file: null, line: null }],
        }),
    ]);
    assert.equal(crashSignature(dump), '@ mozilla::Real');
});

test('frame.inlines is null rather than absent on the real dumps', () => {
    // Contradicts the `inlines?: InlineFrame[]` declaration, and it matters:
    // `?? []` handles null, `?.` alone would not, and a `for…of null` throws.
    const crash = fixture('stackwalk-crash.json');
    const withNullInlines = crash.threads
        .flatMap((thread) => thread.frames)
        .filter((f) => f.inlines === null);
    assert.ok(withNullInlines.length > 0, 'expected null inlines in the fixture');
    // And flattening a thread full of them does not throw.
    assert.ok(flattenFrames(crash.threads[0]!.frames).length > 0);
});

// --- the fixtures --------------------------------------------------------

test('the crash fixture yields the signature crash-viewer would', () => {
    const crash = fixture('stackwalk-crash.json');
    assert.equal(crashSignature(crash), '@ KiUserCallbackDispatcher');
    // Its crashing thread is unnamed and has exactly one frame — both real, and
    // both cases a "walk down the stack" implementation gets wrong.
    assert.equal(crash.crashing_thread?.thread_name, null);
    assert.equal(crash.crashing_thread?.frames.length, 1);
});

test('the hang fixture falls back to module + offset for an unsymbolized frame', () => {
    const hang = fixture('stackwalk-hang.json');
    // The exact spelling matters: it ends up in a signature a caller may group
    // on, and it is upstream's, spaces included.
    assert.equal(crashSignature(hang), '@ libsystem_kernel.dylib + 0x0000000000000dfa');
    assert.equal(
        frameName(hang.crashing_thread!.frames[0]!),
        'libsystem_kernel.dylib + 0x0000000000000dfa'
    );
});

test('frameName prefers the symbol and falls back to module + offset', () => {
    assert.equal(frameName(frame({ function: 'Foo()' })), 'Foo()');
    assert.equal(
        frameName(frame({ function: null, module: 'xul.dll', module_offset: '0x1234' })),
        'xul.dll + 0x1234'
    );
});

// --- faulting address ----------------------------------------------------

test('faultingAddress reports a null-pointer dereference as such', () => {
    const dump = dumpWith([frame({ function: 'Foo()' })]);
    dump.crash_info!.address = '0x0000000000000018';
    dump.crash_info!.adjusted_address = { kind: 'null-pointer', offset: '0x18' };
    const address = faultingAddress(dump);
    // The case that changes what a reader should do: a fault at 0x18 is a null
    // dereference of a field at offset 0x18, not a wild pointer.
    assert.equal(address?.nullPointer, true);
    assert.equal(address?.kind, 'null-pointer');
    assert.equal(address?.offset, '0x18');
});

test('faultingAddress does not claim a null pointer for another kind', () => {
    const dump = dumpWith([frame({ function: 'Foo()' })]);
    dump.crash_info!.adjusted_address = { kind: 'heap-corruption', offset: '0x8' };
    const address = faultingAddress(dump);
    assert.equal(address?.nullPointer, false);
    // Other kinds are passed through rather than switched on.
    assert.equal(address?.kind, 'heap-corruption');
});

test('faultingAddress reports the real dumps, neither of which is adjusted', () => {
    for (const name of ['stackwalk-crash.json', 'stackwalk-hang.json']) {
        const address = faultingAddress(fixture(name));
        assert.ok(address !== null);
        assert.equal(address.kind, null, `${name} should have no adjusted address`);
        assert.equal(address.nullPointer, false);
        assert.match(address.address, /^0x[0-9a-f]+$/);
    }
});

// --- hangs and blocked threads -------------------------------------------

test('detectHang distinguishes the hang from the crash', () => {
    const hang = detectHang(fixture('stackwalk-hang.json'));
    assert.equal(hang.looksLikeHang, true);
    assert.equal(hang.parkedIn, 'RunCurrentEventLoopInMode');

    const crash = detectHang(fixture('stackwalk-crash.json'));
    assert.equal(crash.looksLikeHang, false);
    assert.equal(crash.parkedIn, null);
    // Both reasons are populated: the note is printed either way.
    assert.ok(crash.reason.length > 0);
});

test('the hang is not detectable from crash_info.type', () => {
    // The finding this whole mode exists for. If a future implementation
    // switched to reading the type, this is what would notice.
    const hang = fixture('stackwalk-hang.json');
    assert.equal(hang.crash_info?.type, 'EXC_SOFTWARE / SIGABRT');
    const abort = dumpWith([frame({ function: 'mozalloc_abort' })]);
    abort.crash_info!.type = 'EXC_SOFTWARE / SIGABRT';
    // Same type, opposite verdict.
    assert.equal(detectHang(hang).looksLikeHang, true);
    assert.equal(detectHang(abort).looksLikeHang, false);
});

test('isBlockedThread matches a lock wait and not a bare scheduler wait', () => {
    const locked: Thread = {
        frame_count: 1,
        frames: [frame({ function: 'mozilla::detail::MutexImpl::lock()' })],
        last_error_value: null,
        thread_id: 1,
        thread_name: 'Worker',
    };
    assert.ok(isBlockedThread(locked));

    // Matching every OS wait primitive marked 53 of the crash fixture's 59
    // threads — accurate and useless, since in an idle process nearly every
    // thread is parked in the scheduler. These must NOT count.
    for (const fn of ['ZwWaitForWorkViaWorkerFactory', 'epoll_wait', 'kevent', 'NtDelayExecution']) {
        const idle: Thread = {
            frame_count: 1,
            frames: [frame({ function: fn })],
            last_error_value: null,
            thread_id: 2,
            thread_name: 'Idle',
        };
        assert.ok(!isBlockedThread(idle), `${fn} must not count as blocked`);
    }
});

test('every blocked fragment actually matches, so the list is not decorative', () => {
    // A mutation deleting one fragment survived the command tests, because the
    // fixtures do not exercise every entry. This makes the list itself the
    // contract.
    for (const fragment of BLOCKED_FRAME_FRAGMENTS) {
        const thread: Thread = {
            frame_count: 1,
            frames: [frame({ function: `some::prefix::${fragment}(int)` })],
            last_error_value: null,
            thread_id: 3,
            thread_name: 'T',
        };
        assert.ok(isBlockedThread(thread), `${fragment} is listed but does not match`);
    }
    assert.ok(BLOCKED_FRAME_FRAGMENTS.length >= 15, 'the list should cover both platforms');
    // The Mozilla primitives are the highest-signal entries and must be there:
    // reaching one means Gecko code is waiting on Gecko code.
    for (const required of ['MutexImpl::lock', 'CondVar::Wait', 'Monitor::Wait']) {
        assert.ok(
            BLOCKED_FRAME_FRAGMENTS.includes(required),
            `${required} must stay in the blocked list`
        );
    }
});

test('blocked detection looks only at the innermost frames', () => {
    const deep: Thread = {
        frame_count: 8,
        frames: [
            frame({ function: 'RunningCode()' }),
            frame({ function: 'MoreRunningCode()' }),
            frame({ function: 'StillRunning()' }),
            frame({ function: 'AndMore()' }),
            frame({ function: 'AndMore2()' }),
            // Deep in the stack, so not what the thread is doing now. Every
            // thread in a running process has a lock somewhere down its stack.
            frame({ function: 'mozilla::detail::MutexImpl::lock()' }),
        ],
        last_error_value: null,
        thread_id: 4,
        thread_name: 'Busy',
    };
    assert.ok(!isBlockedThread(deep));
});

test('the fixtures give discriminating blocked counts', () => {
    const crash = fixture('stackwalk-crash.json');
    const hang = fixture('stackwalk-hang.json');
    const crashBlocked = crash.threads.filter(isBlockedThread).length;
    const hangBlocked = hang.threads.filter(isBlockedThread).length;
    // 2 of 59 and 5 of 26. The point is that these are small: 53 of 59 is a
    // shrug, and a marker on 90% of threads distinguishes nothing.
    assert.equal(crashBlocked, 2);
    assert.equal(hangBlocked, 5);
    assert.ok(crashBlocked < crash.threads.length / 4);
});
