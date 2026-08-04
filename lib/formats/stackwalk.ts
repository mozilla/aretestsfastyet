/**
 * minidump-stackwalk JSON — a symbolized crash or hang report, uploaded per
 * task as `public/test_info/<minidumpId>.json`. Read by `crash-viewer.html`.
 *
 * The only format here that is **not** table-encoded: it is produced by
 * `minidump-stackwalk --json`, not by `fetch-test-data.js`, so it is nested
 * objects and its evolution is not this project's to control. Nearly every
 * field is nullable, and platform-specific blocks (`lsb_release`,
 * `mac_crash_info`, `handles`) are `null` off their platform. Treat every
 * field as optional except `threads` and `thread_count`.
 *
 * The report covers hangs as well as crashes, and **the two are not
 * distinguishable from `crash_info.type`**. The hang fixture
 * (`test/fixtures/stackwalk-hang.json`, macOS, 26 threads) reports
 * `EXC_SOFTWARE / SIGABRT`, which an ordinary abort also reports: the process
 * was killed from outside and breakpad wrote the dump, so the evidence for a
 * hang is that the crashing thread's innermost frames are breakpad's own
 * (`ReceivePort::WaitForMessage`, `CrashGenerationClient::RequestDumpForException`)
 * sitting on top of a thread that was otherwise waiting — here `MainThread`
 * parked in `RunCurrentEventLoopInMode`.
 *
 * The consequence for `fx-tests crash`: a hang's interesting content is the
 * breadth across threads rather than the depth of one, which is why
 * `--all-threads` exists and why it defaults to shallower frames. Since the
 * type cannot be trusted to say which case this is, the command should not
 * try to auto-detect it — let the caller choose the view.
 *
 * The crash fixture (`test/fixtures/stackwalk-crash.json`, Windows, 59
 * threads) is the contrasting case, and it is a useful reminder that the
 * "obvious" fields are not reliable: its `crashing_thread.thread_name` is
 * `null` and its crashing thread has exactly **one** frame.
 */

/** Hex address string, e.g. `"0x00007f7b2e35c7e2"`. */
export type HexAddress = string;

export interface AdjustedAddress {
    /** e.g. `"null-pointer"`. Other kinds exist; do not exhaustively switch. */
    kind: string;
    offset: HexAddress;
}

export interface MemoryAccess {
    access_type: string;
    address: HexAddress;
    size: number;
}

export interface CrashInfo {
    address: HexAddress;
    /** Set when the address is recognizable, e.g. a null-pointer dereference. */
    adjusted_address: AdjustedAddress | null;
    assertion: string | null;
    crash_inconsistencies: string[];
    /** Index into `threads` of the thread that crashed. */
    crashing_thread: number;
    /** Disassembly of the faulting instruction, when available. */
    instruction: string | null;
    instruction_pointer_update: { address: HexAddress } | null;
    memory_accesses: MemoryAccess[] | null;
    possible_bit_flips: unknown;
    /** e.g. `"SIGSEGV / SEGV_MAPERR"`, `"EXCEPTION_BREAKPOINT"`. */
    type: string;
}

/**
 * An inlined frame. Carries no module or offset — it is attributed to the
 * enclosing real frame — which is why the signature heuristic
 * (`crash-viewer.html:520`) flattens inlines ahead of their parent frame.
 */
export interface InlineFrame {
    file: string | null;
    function: string | null;
    line: number | null;
}

export interface Frame {
    /** Position in the thread, 0 = innermost. */
    frame: number;
    /** Symbolized name; `null` when symbols are missing — fall back to module + offset. */
    function: string | null;
    function_offset: HexAddress | null;
    file: string | null;
    line: number | null;
    module: string | null;
    module_offset: HexAddress | null;
    offset: HexAddress;
    missing_symbols: boolean;
    /** Frames inlined into this one, outermost-callee first. */
    inlines?: InlineFrame[];
    /**
     * Documented as appearing on the innermost frame of the crashing thread,
     * but absent from every frame of both dumps checked — treat it as
     * something that may never arrive rather than as the crash's register
     * state.
     */
    registers?: Record<string, HexAddress>;
    /** How the frame was recovered: `"context"`, `"cfi"`, `"scan"`, `"frame_pointer"`. */
    trust: string;
    unloaded_modules: unknown;
}

export interface Thread {
    frame_count: number;
    frames: Frame[];
    last_error_value: unknown;
    thread_id: number;
    /** e.g. `"MainThread"`; `null` for unnamed threads. */
    thread_name: string | null;
    /** Present on `crashing_thread`, absent from entries in `threads`. */
    threads_index?: number;
}

export interface Module {
    base_addr: HexAddress;
    end_addr: HexAddress;
    code_id: string | null;
    cert_subject: string | null;
    corrupt_symbols: boolean | null;
    debug_file: string | null;
    debug_id: string | null;
    filename: string;
    loaded_symbols: boolean | null;
    missing_symbols: boolean | null;
    symbol_url: string | null;
    version: string | null;
}

export interface SystemInfo {
    cpu_arch: string;
    cpu_count: number;
    cpu_info: string | null;
    cpu_microcode_version: string | null;
    /** e.g. `"Windows NT"`, `"Mac OS X"`, `"Linux"`. */
    os: string;
    os_ver: string;
}

export interface StackwalkFile {
    crash_info?: CrashInfo;
    /** A copy of `threads[crash_info.crashing_thread]`, plus `threads_index`. */
    crashing_thread?: Thread;
    handles: unknown;
    linux_memory_map_count?: number;
    lsb_release?: unknown;
    mac_boot_args?: unknown;
    mac_crash_info?: unknown;
    main_module: number;
    modules: Module[];
    modules_contains_cert_info: boolean;
    pid: number;
    proc_limits: unknown;
    soft_errors: unknown;
    /** `"OK"` when the dump was walked successfully. */
    status: string;
    system_info: SystemInfo;
    thread_count: number;
    threads: Thread[];
    unloaded_modules: Module[];
}

/**
 * Strips the leading zeros of one of this format's hex strings:
 * `0x000000000000004c` → `0x4c`.
 *
 * Ported from `formatHexOffset()` (`crash-viewer.html:1081`) including its one
 * surprise: the regex is `/^(0x)0*(.+)$/`, whose `.+` is greedy but must leave
 * at least one character, so `0x0000` becomes `0x0` rather than `0x`. A
 * "simplification" to `0*(.*)` yields `0x` and loses the digit.
 *
 * A function rather than a page's helper because every address in this format
 * is written at full register width — `base_addr`, `function_offset`,
 * `module_offset`, `crash_info.address` — and any consumer printing one wants
 * the same treatment. It names nothing about a UI.
 */
export function formatHexOffset(hex: string | null | undefined): string {
    if (!hex) {
        return '';
    }
    const match = /^(0x)0*(.+)$/.exec(hex);
    return match ? match[1]! + match[2]! : hex;
}
