/**
 * `fx-tests crash <task-id> <minidump-id>` — read a processed crash dump.
 *
 * The point is token cost. The raw stackwalk JSON is large and deeply nested —
 * the crash fixture is 507 KB for 59 threads and 1,025 frames — and an agent
 * that fetches it inline spends a great deal of context re-deriving what
 * `crash-viewer.html` already knows how to do. This prints the signature, the
 * crash reason, the faulting address and the frames that matter.
 *
 * ## Hangs invert the defaults
 *
 * A minidump is also how a **hung** process is diagnosed, and that changes what
 * "the interesting part" is. For a crash, one thread matters and deep frames
 * help: the single-thread default is 20. For a deadlock the question is which
 * threads are blocked on each other, so breadth beats depth, and
 * `--all-threads` therefore drops to **8** frames. Twenty frames across forty
 * threads is thousands of lines of mostly-irrelevant stack, which is the
 * opposite of this command's purpose.
 *
 * The two cases are **not distinguishable from `crash_info.type`**. The hang
 * fixture reports `EXC_SOFTWARE / SIGABRT`, exactly as an ordinary abort would;
 * the evidence is breakpad's own frames on top of a thread that was otherwise
 * waiting. So the command reports what it sees as a note and leaves the view to
 * the caller rather than auto-switching, which would hide the frames that
 * disprove the guess.
 *
 * ## Exit 3 against exit 4
 *
 * This is the only command that produces **exit 4**, and the distinction is the
 * reason the code exists: a script needs to tell "try again in a minute" from
 * "this crash dump is never coming back". A 404 on a task artifact is permanent
 * — Taskcluster expired it, or it was never uploaded — while a 5xx or a
 * transport failure is transient.
 *
 * One measured trap: the artifact path is
 * `runs/<retryId>/artifacts/<path>`, and transposing the run segment past
 * `artifacts` answers **403**, not 404. So a 403 must not be mapped to "gone":
 * it is far more likely to be a malformed URL or an auth problem than an
 * expired artifact, and reporting it as permanent would tell a caller to stop
 * retrying something that would work.
 */

import type { Frame, StackwalkFile, Thread } from '../../lib/formats/stackwalk.ts';
import { parseTaskId } from '../../lib/formats/tables.ts';
import {
    type HangAssessment,
    crashSignature,
    detectHang,
    faultingAddress,
    frameName,
    isBlockedThread,
} from '../../lib/model/crash-signature.ts';
import { minidumpJsonUrl } from '../../lib/links.ts';
import {
    DataFetchError,
    DataFileNotFoundError,
    fetchJson,
} from '../../lib/sources/source.ts';
import { taskArtifactName, taskArtifactSource } from '../../lib/sources/http.ts';
import { type OptionSpecs, type ParsedArgs, boolOption, numberOption } from '../args.ts';
import { type CommandContext, emit, progress } from '../context.ts';
import { goneError, upstreamError, usageError } from '../errors.ts';
import { toJson } from '../format/json.ts';
import * as md from '../format/markdown.ts';
import { applyLimit, joinLines, moreLine, truncate } from '../format/text.ts';

/** Options `crash` adds to the globals. */
export const CRASH_OPTIONS: OptionSpecs = {
    'all-threads': {
        type: 'boolean',
        describe: 'Every thread, shallower (8 frames) — the view for a hang.',
    },
    thread: {
        type: 'number',
        placeholder: '<n>',
        describe: 'Show one thread by index instead of the crashing one.',
    },
    frames: {
        type: 'number',
        placeholder: '<n>',
        describe: 'Frames per thread. Default 20, or 8 with --all-threads. 0 for all.',
    },
    raw: { type: 'boolean', describe: 'Print the unprocessed stackwalk JSON.' },
};

/** Frames shown for a single thread: the frames *are* the answer there. */
const DEFAULT_FRAMES_SINGLE = 20;

/**
 * Frames shown per thread with `--all-threads`.
 *
 * `CLI.md` specifies 8, and the arithmetic is the argument: 20 × 40 threads is
 * 800 lines of mostly-irrelevant stack, and a deadlock is read from the top few
 * frames of many threads rather than the depth of one.
 */
const DEFAULT_FRAMES_ALL = 8;

/** The `--json` shape. */
export interface CrashJson {
    taskId: string;
    retryId: number;
    minidumpId: string;
    url: string;
    signature: string;
    /**
     * The crash type as the walker reported it.
     *
     * Not a verdict on crash-versus-hang: the hang fixture reports
     * `EXC_SOFTWARE / SIGABRT`, which an ordinary abort also reports.
     */
    crashType: string | null;
    assertion: string | null;
    instruction: string | null;
    address: {
        address: string;
        kind: string | null;
        offset: string | null;
        nullPointer: boolean;
    } | null;
    system: { os: string; osVersion: string; cpuArch: string; cpuCount: number } | null;
    /** Which thread crashed, and how many there were. */
    crashingThreadIndex: number | null;
    threadCount: number;
    /** What the breakpad-frame heuristic made of it. Never a bare boolean. */
    hang: HangAssessment;
    threads: ThreadJson[];
    /** How many threads matched the view, before `--limit`. */
    threadRowCount: number;
}

interface ThreadJson {
    index: number;
    name: string | null;
    threadId: number;
    crashing: boolean;
    /** Parked on a lock or condition variable — a heuristic, see the model. */
    blocked: boolean;
    frameCount: number;
    frames: FrameJson[];
}

interface FrameJson {
    index: number;
    /** The symbol, or `module + offset` when unsymbolized. */
    function: string;
    /** True when the name is a module-plus-offset fallback. */
    unsymbolized: boolean;
    file: string | null;
    line: number | null;
    module: string | null;
    trust: string;
    /** Functions inlined into this frame, outermost-callee first. */
    inlines: { function: string | null; file: string | null; line: number | null }[];
}

/** Runs the command. */
export async function runCrash(context: CommandContext, args: ParsedArgs): Promise<void> {
    const [rawTaskId, minidumpId] = args.positionals;
    if (rawTaskId === undefined || minidumpId === undefined) {
        // Both required, and `CLI.md` explains why: a minidump ID is always
        // available from wherever the crash was found, and making it optional
        // would mean fetching the task's artifact listing to guess — a round
        // trip to solve a problem the caller does not have.
        throw usageError(
            'crash requires a task ID and a minidump ID',
            'Usage: fx-tests crash <taskId>[.<retryId>] <minidumpId>. ' +
                'Both come from `fx-tests crashes --minidumps` or `fx-tests test --task-ids`.'
        );
    }
    if (args.positionals.length > 2) {
        throw usageError(
            `crash takes two arguments, got ${args.positionals.length}: ` +
                args.positionals.join(', ')
        );
    }

    // `<taskId>.<retryId>` with `.0` implied — already the convention in the
    // data files, so an ID copied from any other command works unchanged.
    const { taskId, retryId } = parseTaskId(rawTaskId);

    const allThreads = boolOption(args, 'all-threads');
    const threadIndex = numberOption(args, 'thread');
    if (allThreads && threadIndex !== undefined) {
        throw usageError(
            '--all-threads and --thread are mutually exclusive',
            '--thread <n> shows one thread; --all-threads shows every thread, shallower.'
        );
    }

    const url = minidumpJsonUrl(taskId, retryId, minidumpId);
    progress(context, `Reading ${minidumpId}.json from task ${taskId}.${retryId}…`);
    const file = await fetchDump(context, taskId, retryId, minidumpId, url);

    if (boolOption(args, 'raw')) {
        emit(context, JSON.stringify(file, null, 2));
        return;
    }

    const crashingIndex = file.crash_info?.crashing_thread ?? null;
    const frameLimit =
        numberOption(args, 'frames') ?? (allThreads ? DEFAULT_FRAMES_ALL : DEFAULT_FRAMES_SINGLE);

    let selected: { thread: Thread; index: number }[];
    if (allThreads) {
        selected = file.threads.map((thread, index) => ({ thread, index }));
    } else if (threadIndex !== undefined) {
        const thread = file.threads[threadIndex];
        if (thread === undefined) {
            throw usageError(
                `no thread #${threadIndex}: the dump has ${file.threads.length} threads (0…${file.threads.length - 1})`
            );
        }
        selected = [{ thread, index: threadIndex }];
    } else {
        // The crashing thread. `crashing_thread` is its own copy of the entry —
        // and the copy is the one that carries `registers`, which `threads[i]`
        // does not — so it is preferred where it exists.
        const thread =
            file.crashing_thread ?? (crashingIndex === null ? undefined : file.threads[crashingIndex]);
        if (thread === undefined) {
            throw upstreamError(
                `the dump for ${minidumpId} records no crashing thread`,
                'Use --all-threads to see every thread, or --raw for the unprocessed JSON.'
            );
        }
        selected = [{ thread, index: crashingIndex ?? 0 }];
    }

    const limit = context.globals.limit;
    const shown = allThreads ? applyLimit(selected, limit ?? 0) : selected;

    const result: CrashJson = {
        taskId,
        retryId,
        minidumpId,
        url,
        signature: crashSignature(file),
        crashType: file.crash_info?.type ?? null,
        assertion: file.crash_info?.assertion ?? null,
        instruction: file.crash_info?.instruction ?? null,
        address: faultingAddress(file),
        system:
            file.system_info === undefined
                ? null
                : {
                      os: file.system_info.os,
                      osVersion: file.system_info.os_ver,
                      cpuArch: file.system_info.cpu_arch,
                      cpuCount: file.system_info.cpu_count,
                  },
        crashingThreadIndex: crashingIndex,
        threadCount: file.threads.length,
        hang: detectHang(file),
        threads: shown.map(({ thread, index }) =>
            toThreadJson(thread, index, index === crashingIndex, frameLimit)
        ),
        threadRowCount: selected.length,
    };

    if (context.globals.format === 'json') {
        emit(context, toJson(result));
        return;
    }
    emit(
        context,
        context.globals.format === 'markdown'
            ? renderMarkdown(result, allThreads)
            : renderText(result, allThreads, frameLimit)
    );
}

/**
 * Fetches and parses the dump, mapping its failures onto `CLI.md`'s exit codes.
 *
 * The 3/4 split, which is the whole reason exit 4 exists:
 *
 * - **404 → exit 4.** The artifact is not there and will not become there.
 *   Taskcluster expires artifacts, and a dump for an old task is permanently
 *   gone. Retrying is pointless and the message says so.
 * - **403 → exit 3, explicitly not 4.** Measured 2026-08-04: transposing the
 *   run segment past `artifacts` in the URL answers 403 rather than 404. A 403
 *   is therefore far more likely to be a malformed request or an auth problem
 *   than an expired artifact, and calling it permanent would tell a caller to
 *   stop retrying something that would have worked.
 * - **Anything else → exit 3.** 5xx, timeouts, DNS: try again.
 */
async function fetchDump(
    context: CommandContext,
    taskId: string,
    retryId: number,
    minidumpId: string,
    url: string
): Promise<StackwalkFile> {
    // `main.ts` always populates this; the fallback keeps the command usable
    // from a caller that built its own context.
    const source = context.taskArtifacts ?? taskArtifactSource({ fetch: nodeFetch });
    // `runs/<retryId>/artifacts/<path>` — the run segment precedes `artifacts`.
    // Transposing them answers 403, so `taskArtifactName()` owns the order and
    // a test asserts it agrees with `lib/links.ts`.
    const name = taskArtifactName(taskId, retryId, `public/test_info/${minidumpId}.json`);
    try {
        return await fetchJson<StackwalkFile>(source, name);
    } catch (error) {
        if (error instanceof DataFileNotFoundError) {
            throw goneError(
                `no minidump ${minidumpId} on task ${taskId}.${retryId}: the artifact is not there.`,
                'Taskcluster expires artifacts, so a dump from an old task is permanently gone — ' +
                    'retrying will not help. Check the task ID and retry number, and that the ' +
                    'crash recorded a minidump at all (some do not).'
            );
        }
        if (error instanceof DataFetchError) {
            // Deliberately not exit 4. See the doc comment: a 403 is what a
            // transposed artifact path answers, not what an expired one does.
            throw upstreamError(
                `could not fetch ${url}: ${error.message}`,
                error.status === 403
                    ? 'A 403 here is usually a malformed artifact path or an auth problem rather ' +
                      'than an expired artifact, which answers 404. Retrying may work.'
                    : 'This looks transient — retrying may work.'
            );
        }
        throw error;
    }
}

/** Node's `fetch`, narrowed to the shape `taskArtifactSource` takes. */
async function nodeFetch(url: string): Promise<{
    ok: boolean;
    status: number;
    url: string;
    arrayBuffer(): Promise<ArrayBuffer>;
}> {
    const response = await fetch(url);
    return {
        ok: response.ok,
        status: response.status,
        url: response.url,
        arrayBuffer: () => response.arrayBuffer(),
    };
}

/** One thread's JSON. */
function toThreadJson(
    thread: Thread,
    index: number,
    crashing: boolean,
    frameLimit: number
): ThreadJson {
    const frames = frameLimit === 0 ? thread.frames : thread.frames.slice(0, frameLimit);
    return {
        index,
        // `null` is real and common: the crash fixture's own crashing thread is
        // unnamed, so this must not be defaulted to a placeholder that reads
        // like a name.
        name: thread.thread_name,
        threadId: thread.thread_id,
        crashing,
        blocked: isBlockedThread(thread),
        frameCount: thread.frames.length,
        frames: frames.map(toFrameJson),
    };
}

/** One frame's JSON. */
function toFrameJson(frame: Frame): FrameJson {
    return {
        index: frame.frame,
        function: frameName(frame),
        unsymbolized: frame.function === null,
        file: frame.file,
        line: frame.line,
        module: frame.module,
        trust: frame.trust,
        // `inlines` is `null` rather than absent on frames that have none —
        // measured on both fixtures, and not what the declaration suggests.
        inlines: (frame.inlines ?? []).map((inline) => ({
            function: inline.function,
            file: inline.file,
            line: inline.line,
        })),
    };
}

// --- rendering -----------------------------------------------------------

/** Plain text. */
function renderText(result: CrashJson, allThreads: boolean, frameLimit: number): string {
    const lines: (string | null)[] = [];

    lines.push(`Crash ${result.signature}`);
    if (result.crashType !== null) {
        lines.push(`  Type:    ${result.crashType}`);
    }
    if (result.address !== null) {
        lines.push(
            `  Address: ${result.address.address}` +
                (result.address.nullPointer
                    ? `  ** null pointer with offset ${result.address.offset ?? '0x0'}`
                    : result.address.kind !== null
                      ? `  ** ${result.address.kind}${result.address.offset === null ? '' : ` with offset ${result.address.offset}`}`
                      : '')
        );
    }
    if (result.assertion !== null) {
        lines.push(`  Assertion: ${result.assertion}`);
    }
    if (result.instruction !== null) {
        lines.push(`  Instruction: ${result.instruction}`);
    }
    if (result.system !== null) {
        lines.push(
            `  System:  ${result.system.os} ${result.system.osVersion}, ` +
                `${result.system.cpuArch}, ${result.system.cpuCount} CPUs`
        );
    }
    lines.push(`  Task:    ${result.taskId}.${result.retryId}  dump ${result.minidumpId}`);

    // The hang note. Reported rather than acted on: the type cannot distinguish
    // a hang from an abort, so the command says what it sees and leaves the
    // view to the caller.
    if (result.hang.looksLikeHang) {
        lines.push('');
        lines.push('This looks like a HANG rather than a crash.');
        lines.push(`  ${result.hang.reason}.`);
        if (result.hang.parkedIn !== null) {
            lines.push(`  Underneath breakpad, the thread was parked in ${result.hang.parkedIn}.`);
        }
        lines.push(
            `  ${result.hang.blockedThreadCount} of ${result.threadCount} threads are waiting on ` +
                'a lock or condition variable.'
        );
        if (!allThreads) {
            lines.push(
                '  A deadlock is read across threads rather than down one — try --all-threads.'
            );
        }
    }

    lines.push('');
    if (allThreads) {
        lines.push(
            `${result.threadCount} threads.` +
                (result.hang.blockedThreadCount > 0
                    ? ` Waiting on a lock: ${blockedList(result)}  (see ** markers)`
                    : ' None are waiting on a lock.')
        );
        lines.push(
            '  "blocked" is a heuristic over the innermost frames — a minidump records no lock'
        );
        lines.push('  ownership, so this points at threads worth reading, not at a proven cycle.');
        lines.push('');
    }

    for (const thread of result.threads) {
        lines.push(...renderThread(thread, allThreads));
        lines.push('');
    }
    lines.push(moreLine(result.threadRowCount, result.threads.length));

    if (!allThreads && result.threadCount > 1) {
        const others = result.threadCount - 1;
        lines.push(
            `${others} other thread${others === 1 ? '' : 's'} ` +
                '(--all-threads to show, --thread <n> for one)'
        );
    }
    const truncated = result.threads.filter(
        (thread) => frameLimit !== 0 && thread.frameCount > thread.frames.length
    );
    if (truncated.length > 0) {
        lines.push(
            `Frames truncated to ${frameLimit} per thread (--frames <n>, or --frames 0 for all).`
        );
    }
    return joinLines(lines);
}

/** The `#0, #7, #12` list of blocked threads. */
function blockedList(result: CrashJson): string {
    const blocked = result.threads.filter((thread) => thread.blocked).map((t) => `#${t.index}`);
    return blocked.length === 0 ? '(none in this view)' : blocked.slice(0, 12).join(', ');
}

/** One thread's header and frames. */
function renderThread(thread: ThreadJson, allThreads: boolean): string[] {
    const lines: string[] = [];
    const label = thread.name ?? `tid ${thread.threadId}`;
    const header = allThreads
        ? ` #${thread.index}  ${label}`
        : `${thread.crashing ? 'Crashing thread' : 'Thread'} #${thread.index} (${label})`;
    lines.push(header + (thread.blocked ? '   ** blocked' : ''));

    for (const frame of thread.frames) {
        const where =
            frame.file !== null && frame.line !== null
                ? `  ${shortenSourceFile(frame.file)}:${frame.line}`
                : '';
        lines.push(
            `  ${String(frame.index).padStart(3)}  ${truncate(frame.function, 88)}${where}`
        );
        // Inlined callees are printed under their parent because that is where
        // they are — and because the signature is taken from them first, so a
        // reader who wants to know why the signature says what it does needs to
        // see them.
        for (const inline of frame.inlines) {
            lines.push(
                `       └ inlined: ${truncate(inline.function ?? '(unnamed)', 78)}` +
                    (inline.file !== null && inline.line !== null
                        ? `  ${shortenSourceFile(inline.file)}:${inline.line}`
                        : '')
            );
        }
    }
    if (thread.frameCount > thread.frames.length) {
        lines.push(`       … ${thread.frameCount - thread.frames.length} more frames`);
    }
    return lines;
}

/**
 * Shortens a source path for display.
 *
 * The walker emits `git:github.com/mozilla-firefox/firefox:layout/base/x.cpp:<sha>`,
 * which is 100 characters of which the useful 20 are in the middle. Reduced to
 * the repository path.
 */
export function shortenSourceFile(file: string): string {
    const match = /^(?:git|hg|s3):[^:]+:([^:]+):/.exec(file);
    return match?.[1] ?? file;
}

/** Markdown, for pasting into a bug. */
function renderMarkdown(result: CrashJson, allThreads: boolean): string {
    const lines: (string | null)[] = [];
    lines.push(md.heading(result.signature, 1));
    lines.push('');
    const facts: [string, string][] = [];
    if (result.crashType !== null) {
        facts.push(['Type', md.code(result.crashType)]);
    }
    if (result.address !== null) {
        facts.push([
            'Address',
            md.code(result.address.address) +
                (result.address.nullPointer
                    ? ` — **null pointer** with offset ${result.address.offset ?? '0x0'}`
                    : ''),
        ]);
    }
    if (result.system !== null) {
        facts.push(['System', `${result.system.os} ${result.system.osVersion}, ${result.system.cpuArch}`]);
    }
    facts.push(['Task', md.code(`${result.taskId}.${result.retryId}`)]);
    facts.push(['Dump', md.code(result.minidumpId)]);
    lines.push(...md.table([{ header: 'Field' }, { header: 'Value' }], facts));

    if (result.hang.looksLikeHang) {
        lines.push('');
        lines.push(
            `**This looks like a hang rather than a crash.** ${result.hang.reason}` +
                (result.hang.parkedIn === null
                    ? '.'
                    : `, parked in ${md.code(result.hang.parkedIn)}.`)
        );
    }

    for (const thread of result.threads) {
        lines.push('');
        lines.push(
            md.heading(
                `#${thread.index} ${thread.name ?? `tid ${thread.threadId}`}` +
                    (thread.crashing ? ' (crashing)' : '') +
                    (thread.blocked ? ' — blocked' : '')
            )
        );
        lines.push('');
        lines.push('```');
        for (const frame of thread.frames) {
            lines.push(
                `${String(frame.index).padStart(3)}  ${frame.function}` +
                    (frame.file !== null && frame.line !== null
                        ? `  ${shortenSourceFile(frame.file)}:${frame.line}`
                        : '')
            );
        }
        if (thread.frameCount > thread.frames.length) {
            lines.push(`… ${thread.frameCount - thread.frames.length} more frames`);
        }
        lines.push('```');
    }
    void allThreads;
    return joinLines(lines);
}
