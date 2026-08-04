/**
 * Crash signatures, and reading a hang out of a minidump.
 *
 * A **port** of `crash-viewer.html:520`, whose own constants come from
 * Mozilla's `mozcrash.py`. The heuristic is three rules that sound simpler than
 * they are, which is why `PLAN.md` §3 step 5 asks for it to be tested against
 * real dumps rather than reimplemented in a prompt:
 *
 *  1. Flatten each frame's inlined callees **ahead of** the frame itself.
 *  2. Walk the flattened list and take the first frame that is not an
 *     abort/assertion frame.
 *  3. Strip the parameter list, and prefix `@ `.
 *
 * Each rule has a failure mode worth naming.
 *
 * **Inlines first.** An inlined callee is *inside* its parent, so it is the
 * more precise answer. Reading the parent first attributes a crash to the
 * function that inlined it, which is one level too coarse and often names a
 * helper shared by hundreds of call sites. 119 of 1,025 frames in the crash
 * fixture carry inlines.
 *
 * **Abort frames.** A process that aborted has `MOZ_Crash`, `mozalloc_abort`
 * or a Rust panic hook on top, and every crash of that kind would otherwise get
 * the same signature. Two match rules, and both matter: an exact list, and a
 * substring list for the Rust panic machinery whose symbols carry generic
 * parameters that make exact matching hopeless.
 *
 * **Parameter stripping.** `/(.*)\(.*\)/`'s first group is **greedy**, so it
 * cuts at the *last* `(` that still has a `)` after it, not the first. Measured
 * against the real behaviour rather than assumed: `foo(bar(int), baz)` yields
 * `foo(bar`, and `std::function<void ()>::operator()() const` yields
 * `std::function<void ()>::operator()`. Neither is what "strip the parameter
 * list" sounds like, and the second is arguably better than a first-paren cut
 * would give.
 *
 * This is preserved exactly, warts included, because the signature is only
 * useful if it matches the one `crash-viewer.html` shows for the same dump. A
 * lazy match or a cut-at-first-paren would be defensible in isolation and would
 * silently disagree with every signature the dashboards have ever displayed.
 * `test/model.test.ts` pins these two cases for that reason.
 *
 * ## What the signature is *not*
 *
 * It is not Socorro's signature. Socorro applies a much larger set of rules
 * (prefix functions, signature sentinels, normalization of templates). This is
 * the crash-viewer's approximation, and the CLI reports it as such.
 */

import type { Frame, StackwalkFile, Thread } from '../formats/stackwalk.ts';

/**
 * Frames that mean "the process deliberately aborted", not "here is the bug".
 *
 * Copied verbatim from `crash-viewer.html:474`, itself from `mozcrash.py`.
 * Matched **exactly**: these are full symbol names as the walker emits them,
 * parameter lists included, which is why `Abort(char const*)` and
 * `static void Abort(const char *)` both appear — two spellings from two
 * compilers of the same function.
 */
export const ABORT_SIGNATURES: readonly string[] = [
    'Abort(char const*)',
    'RustMozCrash',
    'NS_DebugBreak',
    'core::ops::function::Fn::call',
    'gkrust_shared::panic_hook',
    'mozglue_static::panic_hook',
    'intentional_panic',
    'mozalloc_abort',
    'mozalloc_abort(char const* const)',
    'static void Abort(const char *)',
    'std::sys_common::backtrace::__rust_end_short_backtrace',
    'rust_begin_unwind',
    'MOZ_Crash(char const*, int, char const*)',
    'MOZ_CrashSequence(void*, long)',
    '<alloc::boxed::Box<F,A> as core::ops::function::Fn<Args>>::call',
];

/**
 * Fragments that mark a frame as part of the panic machinery.
 *
 * Substring rather than exact, because the Rust panic path's symbols carry
 * generic parameters and monomorphized type names that differ per build — no
 * exact list could keep up.
 */
export const ABORT_SUBSTRINGS: readonly string[] = [
    '_panic_',
    'core::panic::',
    'core::panicking::',
    'core::result::unwrap_failed',
    'std::panicking::',
];

/** The signature used when no frame yields one. Upstream's literal string. */
export const UNKNOWN_SIGNATURE = '@ Unknown';

/**
 * The display name of a frame: its symbol, or a module-plus-offset fallback.
 *
 * The fallback is what an unsymbolized frame gets, and it is why a signature
 * can read `@ libsystem_kernel.dylib + 0x0000000000000dfa`. 51 of the hang
 * fixture's 323 frames have no `function`, so this is not a rare path.
 *
 * The exact spelling — `${module} + ${module_offset}`, spaces included — is
 * upstream's, and it matters because it ends up in signature strings that a
 * caller may group on.
 *
 * ## Why `||` and not `??`
 *
 * `crash-viewer.html:513` writes `frame.function || …`, and this used to write
 * `??`. The two differ on exactly one input — `function: ""` — where `??` keeps
 * the empty string and `||` falls back to the module. Differential fuzzing of
 * 200,000 synthetic dumps against a verbatim transcription of the original
 * found 6,951 divergences and every one traced to this operator.
 *
 * No real frame has an empty function name: 0 occurrences across 4,899 frames
 * from seven dumps. So this is latent rather than a live bug — and it is fixed
 * anyway, because the whole justification for the parameter-stripping regex's
 * strangeness two functions down is that the port is "preserved exactly, warts
 * included". A port cannot claim that while quietly modernizing an operator;
 * either the contract holds or it does not.
 */
export function frameName(frame: Frame): string {
    // `||`, deliberately, matching upstream on an empty function name.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    return frame.function || `${frame.module} + ${frame.module_offset}`;
}

/**
 * A thread's frames flattened with inlines ahead of their parent.
 *
 * Returns the raw names, `null` included: upstream skips falsy entries when
 * walking, and keeping them here preserves the index correspondence a caller
 * might want. `inlines` is `null` rather than absent on frames that have none —
 * measured on both fixtures, and not what the declaration's `inlines?:`
 * suggests — so `?? []` is load-bearing, not defensive.
 */
export function flattenFrames(frames: readonly Frame[]): (string | null)[] {
    const flattened: (string | null)[] = [];
    for (const frame of frames) {
        for (const inline of frame.inlines ?? []) {
            flattened.push(inline.function);
        }
        flattened.push(frameName(frame));
    }
    return flattened;
}

/** Whether a frame name is an abort/assertion frame rather than the bug. */
export function isAbortFrame(name: string): boolean {
    return (
        ABORT_SIGNATURES.includes(name) ||
        ABORT_SUBSTRINGS.some((fragment) => name.includes(fragment))
    );
}

/**
 * Strips a parameter list, keeping the greedy-match behaviour.
 *
 * `/(.*)\(.*\)/` on `a(b(c), d)` yields `a`, because `.*` is greedy and takes
 * the last `(` it can while still matching a `)` after it. Exported so a test
 * can pin that directly: it is the part of the port most likely to be
 * "simplified" into something that behaves differently on nested parentheses.
 */
export function stripParameters(signature: string): string {
    const match = /(.*)\(.*\)/.exec(signature);
    return match?.[1] ?? signature;
}

/**
 * The crash signature of a dump, as `crash-viewer.html` computes it.
 *
 * Walks the **crashing thread's** flattened frames for the first non-abort one.
 * If every frame is an abort frame, upstream falls back to the first frame
 * rather than reporting nothing, and so does this — a signature naming
 * `MOZ_Crash` is still more useful than `@ Unknown`.
 *
 * Returns `@ Unknown` when there is no crashing thread or it has no frames.
 * Note that a crashing thread with exactly **one** frame is real: the crash
 * fixture is such a dump, so "walk down the stack" cannot assume there is a
 * stack to walk.
 */
export function crashSignature(file: StackwalkFile): string {
    const frames = file.crashing_thread?.frames ?? [];
    const flattened = flattenFrames(frames);

    for (const name of flattened) {
        // Upstream's `if (!func) continue`: a null inline name is skipped
        // rather than becoming the signature.
        if (!name) {
            continue;
        }
        if (!isAbortFrame(name)) {
            return stripParameters(`@ ${name}`);
        }
    }

    // Every frame was an abort frame: fall back to the first, as upstream does.
    const first = flattened[0];
    if (first) {
        return stripParameters(`@ ${first}`);
    }
    return UNKNOWN_SIGNATURE;
}

/** What the faulting address says about the crash. */
export interface FaultingAddress {
    address: string;
    /**
     * The recognized kind, e.g. `null-pointer`. `null` when the walker did not
     * recognize the address — which is the common case: `adjusted_address` is
     * null on both fixtures.
     */
    kind: string | null;
    /** The offset from the recognized base, when there is one. */
    offset: string | null;
    /** True for `kind === 'null-pointer'`, the case worth calling out. */
    nullPointer: boolean;
}

/**
 * Reads the faulting address and what the walker made of it
 * (`crash-viewer.html:729`).
 *
 * The null-pointer case is singled out because it is the one that changes what
 * a reader should do: a fault at `0x18` is a null dereference of a field at
 * offset 0x18, not a wild pointer, and that points straight at a missing null
 * check. Other `kind`s exist and are passed through rather than switched on.
 */
export function faultingAddress(file: StackwalkFile): FaultingAddress | null {
    const info = file.crash_info;
    if (info === undefined) {
        return null;
    }
    const adjusted = info.adjusted_address;
    return {
        address: info.address,
        kind: adjusted?.kind ?? null,
        offset: adjusted?.offset ?? null,
        nullPointer: adjusted?.kind === 'null-pointer',
    };
}

// --- hangs ---------------------------------------------------------------

/**
 * Frames that mean "breakpad is taking this dump", not "this is the crash".
 *
 * The evidence that a dump is a **hang** rather than a crash. `FORMATS.md` is
 * explicit that `crash_info.type` cannot make the distinction: the hang fixture
 * reports `EXC_SOFTWARE / SIGABRT`, exactly as an ordinary abort would. What
 * distinguishes it is these frames sitting on top of a thread that was
 * otherwise waiting — the process was killed from outside and breakpad wrote
 * the dump in a signal handler.
 */
export const BREAKPAD_FRAME_FRAGMENTS: readonly string[] = [
    'google_breakpad::',
    'ExceptionHandler::WriteMinidumpWithException',
    'CrashGenerationClient::RequestDumpForException',
    'ReceivePort::WaitForMessage',
];

/**
 * Function fragments that mean a thread is parked on a **lock or condition
 * variable** — waiting for another thread, rather than merely idle.
 *
 * This list is narrower than it first was. A first version also matched the
 * OS-level wait primitives (`ZwWaitFor*`, `NtWaitForSingleObject`,
 * `epoll_wait`, `kevent`, …), and the distinction it drops is real: a thread in
 * `epoll_wait` is waiting for the world, while a thread in `MutexImpl::lock` is
 * waiting for a peer, and only the second can be part of a cycle.
 *
 * ## What the narrowing actually buys, measured
 *
 * Less than an earlier version of this comment claimed. It quoted the two
 * fixtures — 2 of 59 against a broad 57, and 5 of 26 against 6 — and concluded
 * "5 of 26 is a lead and 53 of 59 is a shrug". Across seven real dumps the
 * narrowed rule marks **2%, 3%, 19%, 19%, 58%, 62% and 77%** of threads. On
 * roughly half of them it is nearly as noisy as the rule it replaced.
 *
 * So the honest claim is narrower than the tidy one: the narrowing never makes
 * the marker *worse*, it is decisive on some dumps, and on others a process
 * genuinely has most of its threads waiting on Gecko locks and no
 * frame-matching rule can change that. Read the count against the thread total
 * before reading the markers — which is why the command always prints both.
 *
 * And it remains a **heuristic**. A minidump records no lock ownership, so this
 * cannot prove a cycle; it points at threads worth reading. The command says so
 * in as many words rather than leaving the marker to imply more than it knows.
 */
export const BLOCKED_FRAME_FRAGMENTS: readonly string[] = [
    // Mozilla's own synchronization primitives — the highest-signal entries,
    // because reaching one means Gecko code is waiting on Gecko code.
    'ConditionVariableImpl::wait',
    'MutexImpl::lock',
    'Monitor::Wait',
    'ReentrantMonitor::Wait',
    'CondVar::Wait',
    'MonitorAutoLock',
    'OffTheBooksMutex::Lock',
    // Platform mutex and condition-variable waits.
    'RtlSleepConditionVariableSRW',
    'SleepConditionVariableSRW',
    'RtlEnterCriticalSection',
    'EnterCriticalSection',
    '__psynch_cvwait',
    '__psynch_mutexwait',
    'pthread_cond_wait',
    'pthread_cond_timedwait',
    'pthread_mutex_lock',
    'futex_wait',
    // Cross-process message waits, which is how an IPC deadlock presents.
    'WaitForMessage',
    'WaitForReplyMessage',
];

/**
 * How many innermost frames are examined for a wait primitive.
 *
 * Only the innermost few: every thread in a running process has a lock
 * somewhere down its stack, so a full-stack scan would mark all of them and the
 * marker would carry no information.
 */
const BLOCKED_FRAME_DEPTH = 4;

/**
 * Whether a thread looks parked waiting on another thread.
 *
 * See `BLOCKED_FRAME_FRAGMENTS` for why this is deliberately narrower than
 * "the thread is in a wait state".
 */
export function isBlockedThread(thread: Thread): boolean {
    return thread.frames.slice(0, BLOCKED_FRAME_DEPTH).some((frame) => {
        const name = frameName(frame);
        return BLOCKED_FRAME_FRAGMENTS.some((fragment) => name.includes(fragment));
    });
}

/** Whether a thread's innermost frames are breakpad's own dump-writing path. */
export function hasBreakpadFrames(thread: Thread): boolean {
    return thread.frames.slice(0, 8).some((frame) => {
        const name = frameName(frame);
        return BREAKPAD_FRAME_FRAGMENTS.some((fragment) => name.includes(fragment));
    });
}

/** What `detectHang` concluded, and on what evidence. */
export interface HangAssessment {
    /** True when the dump looks like an externally-killed hang. */
    looksLikeHang: boolean;
    /** The reason, for the output. Always populated. */
    reason: string;
    /** The frame below breakpad's, which is what the process was actually doing. */
    parkedIn: string | null;
    /** How many threads look parked on a wait primitive. */
    blockedThreadCount: number;
}

/**
 * Whether a dump looks like a hang rather than a crash.
 *
 * **Not** from `crash_info.type`, which cannot tell them apart: the hang
 * fixture and an ordinary abort both report `EXC_SOFTWARE / SIGABRT`
 * (`FORMATS.md`). The evidence is breakpad's own frames on top of the crashing
 * thread, with something that was waiting underneath them.
 *
 * Reported as a note rather than used to switch the output automatically.
 * `lib/formats/stackwalk.ts` argues the command should let the caller choose
 * the view, because a wrong auto-detection would hide the frames that disprove
 * it — this says what it sees and leaves `--all-threads` to the caller.
 */
export function detectHang(file: StackwalkFile): HangAssessment {
    const crashing = file.crashing_thread;
    const blockedThreadCount = file.threads.filter(isBlockedThread).length;

    if (crashing === undefined) {
        return {
            looksLikeHang: false,
            reason: 'no crashing thread recorded',
            parkedIn: null,
            blockedThreadCount,
        };
    }
    if (!hasBreakpadFrames(crashing)) {
        return {
            looksLikeHang: false,
            reason:
                'the crashing thread’s innermost frames are not breakpad’s, so this looks like ' +
                'a real fault rather than a dump taken from outside',
            parkedIn: null,
            blockedThreadCount,
        };
    }

    // Below breakpad's frames is what the thread was actually doing — on the
    // hang fixture, `RunCurrentEventLoopInMode`. That frame is the finding.
    const parkedIn = firstNonBreakpadFrame(crashing);
    return {
        looksLikeHang: true,
        reason:
            'breakpad’s own frames are on top of the crashing thread, so the dump was written ' +
            'on request rather than at a fault — the signature of a process killed from outside',
        parkedIn,
        blockedThreadCount,
    };
}

/**
 * What the thread was doing underneath breakpad's handler.
 *
 * Walks past breakpad's frames, past the signal trampoline, and past
 * **unsymbolized** frames, to the first frame with a real function name. That
 * last condition is the one that took a measurement to get right: on the hang
 * fixture the frames immediately below `_sigtramp` are unsymbolized
 * `CoreFoundation + 0x...` entries, and returning one of those reports the
 * module a hang happened in rather than what it was waiting on. Skipping them
 * reaches `RunCurrentEventLoopInMode`, which is the actual finding.
 *
 * `null` when nothing symbolized remains, rather than a module-plus-offset
 * string: "parked in CoreFoundation + 0x83ef4" tells a reader nothing they can
 * act on, and saying nothing is more honest than saying that.
 */
function firstNonBreakpadFrame(thread: Thread): string | null {
    for (const frame of thread.frames) {
        const name = frameName(frame);
        if (BREAKPAD_FRAME_FRAGMENTS.some((fragment) => name.includes(fragment))) {
            continue;
        }
        // The signal trampoline is the boundary between breakpad's handler and
        // the parked stack; naming it as "what it was doing" is uninformative.
        if (name.includes('_sigtramp')) {
            continue;
        }
        // An unsymbolized frame names a module, not a function. See above.
        if (frame.function === null) {
            continue;
        }
        return name;
    }
    return null;
}
