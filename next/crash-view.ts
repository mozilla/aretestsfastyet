/**
 * The crash viewer's **view model**: a stackwalk file reduced to exactly what
 * the page draws, with no DOM in sight.
 *
 * ## Where this lives, and the rule the next two migrations should follow
 *
 * This is **page-local**. It sits in `next/` beside the renderer that consumes
 * it, not in `lib/`, and the boundary it draws is the one `test.html` and
 * `try.html` should copy:
 *
 * > **`lib/` holds data and derivations. The page directory holds the view
 * > model — including anything that names an element id, a CSS class or a
 * > glyph.**
 *
 * It started in `lib/model/`, and the test that moved it is worth stating
 * because it is the test to apply to the next two pages: *would a non-page
 * consumer want this, and does it name anything about the UI?* This module
 * fails both halves. It was imported by exactly one page and one test with no
 * CLI consumer, and it was the only module in `lib/model/` naming element ids
 * (`thread-toggle-${index}`, `frame-${n}-details`), CSS classes (`'crashed'`,
 * `'thread-extra-frames'`) and glyphs (`▸`/`▾`, `"Show N more frames"`). A grep
 * for those scored 16 here and 0 across the other five `lib/model` modules.
 *
 * Left behind in `lib/`, because each is genuinely reusable and names no UI:
 *
 * | moved to | what |
 * | --- | --- |
 * | `lib/links.ts` | `parseFileInfo`, `sourceUrl`, `searchfoxFrameUrl`, `crashStatsSearchUrl` — URL construction, next to the `crashViewerUrl`/`searchfoxUrl` that were already there |
 * | `lib/formats/stackwalk.ts` | `formatHexOffset` — every address in that format is written at full register width, so any consumer printing one wants it |
 *
 * `trustDescription` stayed here, against the reviewer's suggested keep-list.
 * It is prose written for **a tooltip on a column this page draws**: the trust
 * column exists only in the viewer, `fx-tests crash` emits the bare `trust`
 * value, and the strings read as sentences for hovering rather than as data. A
 * non-page consumer wanting to explain a trust level would want a different
 * register of text, so shipping this one in `lib/` would be asserting a reuse
 * nothing has asked for.
 *
 * ## Why the view model exists at all
 *
 * `PARITY.md` §2 asks each migrated page to "expose its view model as a design
 * property" so that old-vs-new and new-vs-CLI can both be compared without
 * retrofitting `window.__parity` getters onto a page that gates everything
 * behind `DOMContentLoaded`. A page that builds strings of HTML directly out of
 * a parsed JSON file has no such seam: the only way to ask what it decided is
 * to read the pixels back.
 *
 * Splitting the decisions from the drawing gives three things the old page
 * could not have:
 *
 *  1. **Every decision is a value a test can assert on** — which frames are
 *     shown, which are hidden behind "Show N more", what each link points at —
 *     without a browser. `test/crash-view.test.ts` runs in node.
 *  2. **The CLI and the page can be compared field by field**, because both now
 *     start from the same typed structures in `lib/` rather than from two
 *     transcriptions of the same heuristic.
 *  3. **The renderer becomes mechanical.** `next/crash-viewer.ts` is a
 *     transliteration of these structures into elements; a bug there is visible
 *     as markup, not as arithmetic.
 *
 * Being page-local costs none of that. The seam is the module boundary, not the
 * directory, and a node test imports `next/crash-view.ts` exactly as easily as
 * it imported `lib/model/crash-view.ts`.
 *
 * ## What is deliberately *not* here
 *
 * HTML escaping, element construction, and event wiring. Those belong to the
 * renderer, and keeping them out is what lets this module be imported by a
 * node test with no DOM — this file must stay DOM-free even though it now sits
 * in the page directory, and `tsconfig.next.json` gives it the DOM lib, so that
 * is a discipline rather than something the compiler enforces.
 *
 * The one place the boundary is subtle is `frameRows()`: it decides row
 * *classes* like `crashed` and `thread-extra-frames`, which look like
 * presentation. They are here because *which* rows are hidden is a behavioural
 * decision the parity comparison must be able to read — the class name is just
 * the channel the old page used to express it, and reproducing the same names
 * is what keeps the CSS unchanged. That those names are here rather than in
 * `lib/` is precisely the point of the move.
 */

import {
    type Frame,
    type InlineFrame,
    type Module,
    type StackwalkFile,
    type Thread,
    formatHexOffset,
} from '../lib/formats/stackwalk.ts';
import {
    crashStatsSearchUrl,
    parseFileInfo,
    searchfoxFrameUrl,
    sourceUrl,
} from '../lib/links.ts';
import { crashSignature } from '../lib/model/crash-signature.ts';

// --- the trust column's tooltip ------------------------------------------

/**
 * What a `trust` value means, for the column's tooltip.
 *
 * Copied from `getTrustDescription()` (`crash-viewer.html:1063`). An unknown
 * value falls back to itself rather than to a placeholder — the walker may
 * grow a new one, and showing it is better than hiding it.
 *
 * Page-local rather than in `lib/`: these are sentences written to be hovered
 * over a column only this page draws. See the module comment.
 */
export function trustDescription(trust: string | null | undefined): string {
    if (!trust) {
        return '';
    }
    const descriptions: Record<string, string> = {
        cfi: 'Call Frame Information - most reliable, from debugging data',
        frame_pointer: 'Frame pointer - using the frame pointer register',
        context: 'Context - direct context from the stack (leaf frame)',
        scan: 'Stack scanning - least reliable, searching for return addresses',
        cfi_scan: 'CFI with stack scanning fallback',
    };
    return descriptions[trust] ?? trust;
}

// --- rows ----------------------------------------------------------------

/** One rendered row of a stack table: either a real frame or an inlined one. */
export interface FrameRow {
    kind: 'frame' | 'inline';
    /** The `#` column. Empty for an inlined row, as upstream leaves it. */
    number: string;
    module: string;
    /** The symbol, or `???` when the walker had none. Upstream's placeholder. */
    functionText: string;
    /** Searchfox link for the function cell, when the frame is Mozilla code. */
    functionUrl: string | null;
    /** The `path:line` text, or `''` when the frame has no source location. */
    locationText: string;
    /** hg/GitHub link for the location cell. */
    locationUrl: string | null;
    /**
     * The ` +0x51e` suffix, **outside** the location link, or `''`.
     *
     * A separate field rather than part of `locationText` because upstream
     * writes it as a bare text node *after* the `</a>`
     * (`crash-viewer.html:931-933`), so it is neither clickable nor underlined.
     * Folding it into the link text renders the same characters and was
     * therefore invisible to a `textContent` comparison; the browser diff that
     * caught it compares each cell's child nodes, and reported 110 cells
     * differing on `win32-mfcdm` alone.
     *
     * Includes its own leading space, because that space is part of the text
     * node upstream emits and not a separator the renderer adds.
     */
    locationOffsetText: string;
    trust: string;
    /**
     * The trust column's tooltip.
     *
     * Three-valued on purpose, because the old page is: a real frame always
     * carries the attribute — `title=""` when `trust` is unrecognized — while
     * an inline row is written as a bare `<td class="frame-trust">inline</td>`
     * with **no** `title` at all (`crash-viewer.html:897` against `:938`).
     * `null` means "emit no attribute" and `''` means "emit an empty one".
     *
     * The distinction is invisible to a reader and was found by diffing the
     * rendered DOM of both pages: 15 cells on one dump differed by exactly
     * this. Kept rather than normalized, because normalizing it is a change to
     * the markup that no measurement showed a need for.
     */
    trustTitle: string | null;
    /** Row classes, e.g. `crashed`, `thread-extra-frames`. Possibly empty. */
    classes: string[];
    /**
     * The details row's element id, when this frame has registers to show.
     * `null` when it has none, and then the row is not clickable.
     */
    detailsId: string | null;
    /** Sorted `name = value` pairs for the details row. Empty when no registers. */
    registers: [string, string][];
}

/**
 * The rows one frame contributes: its inlined callees first, then itself.
 *
 * Inlines come first because that is where they are in the stack — the same
 * ordering the signature heuristic relies on (`crash-signature.ts`), and
 * showing them after their parent would contradict the signature the page's
 * own `<h1>` displays.
 *
 * ## The frame id, its collision, and the bug the new page fixes
 *
 * `detailsId` is `frame-${frame.frame}-details`, upstream's spelling
 * (`crash-viewer.html:865`). `frame.frame` is the index **within a thread**, so
 * any two rendered threads whose frame 0 carries `registers` produce two
 * elements with `id="frame-0-details"`.
 *
 * **How often that happens in the corpus: never.** Measured across all nine
 * dumps in `artifacts/dumps/` — every one has `registers` on exactly one frame,
 * frame 0 of the `crashing_thread` copy, and on zero frames of any `threads[i]`.
 * So the duplicate id is *not present in the current corpus*. That is a fact
 * about the dumps to hand, not about what the format allows:
 * `minidump-stackwalk` emits `registers` for any thread's context frame, so a
 * dump with them on a non-crashing thread is schema-legal and simply has not
 * turned up yet.
 *
 * **What the two pages then do differs, and the new one is right.** Built such
 * a dump (`artifacts/review-harness/make-defect2.mjs`, registers planted on a
 * non-crashing thread's frame 0) and clicked that thread's register row in
 * Chrome:
 *
 * ```
 * OLD  opens the CRASHING thread's registers   <- wrong thread
 * NEW  opens the clicked thread's registers    <- correct
 * ```
 *
 * The old page's `toggleFrameDetails(rowId)` calls `getElementById`, which
 * returns the **first** match in document order — the crashing thread's block,
 * since it is rendered above "Other Threads". The new renderer closes over the
 * details element it just created, so the id is never looked up and the
 * ambiguity cannot bite. This is a **behaviour change and a bug fix**, listed
 * as such in `next/crash-viewer.ts`'s divergences.
 *
 * The id itself is still emitted with upstream's spelling, so a bookmarked
 * `#frame-0-details` still lands somewhere. `idPrefix` lets a caller that
 * renders two register-bearing threads disambiguate the ids as well; the page
 * passes nothing, because fixing the *click* is what a reader notices and
 * changing the ids would break those bookmarks for no measured gain.
 */
export function frameRows(
    frame: Frame,
    options: { crashed?: boolean; extraClass?: string; idPrefix?: string } = {}
): FrameRow[] {
    const { crashed = false, extraClass = '', idPrefix = '' } = options;
    // Upstream applies the `crashed` class to a frame's inline rows as well as
    // to the frame itself, so the whole innermost group is highlighted.
    const classes = [crashed ? 'crashed' : '', extraClass].filter((c) => c !== '');
    const rows: FrameRow[] = [];

    for (const inline of frame.inlines ?? []) {
        rows.push(inlineRow(frame, inline, classes));
    }

    const registers = frame.registers
        ? // `Object.entries(...).sort()` — upstream sorts the pairs, and
          // `Array.prototype.sort` on `[name, value]` tuples compares their
          // string forms, which orders by name because a register name never
          // contains a comma. Reproduced rather than "fixed" to a key
          // comparator so the order on screen does not move.
          (Object.entries(frame.registers).sort() as [string, string][])
        : [];

    rows.push({
        kind: 'frame',
        number: String(frame.frame),
        module: frame.module ?? 'unknown',
        functionText: frame.function ?? '???',
        functionUrl: searchfoxFrameUrl(frame),
        locationText: frameLocationText(frame),
        locationUrl: frame.file && frame.line ? sourceUrl(frame.file, frame.line) : null,
        locationOffsetText: frameLocationOffsetText(frame),
        trust: frame.trust ?? '',
        trustTitle: trustDescription(frame.trust),
        classes,
        detailsId: frame.registers ? `${idPrefix}frame-${frame.frame}-details` : null,
        registers,
    });
    return rows;
}

/** One inlined callee's row. */
function inlineRow(frame: Frame, inline: InlineFrame, classes: string[]): FrameRow {
    const hasLocation = Boolean(inline.file && inline.line);
    const info = hasLocation ? parseFileInfo(inline.file) : null;
    return {
        kind: 'inline',
        // Upstream leaves the number cell empty on an inline row: an inlined
        // callee has no frame index of its own.
        number: '',
        // The inline is attributed to its parent's module, because an inlined
        // frame carries none of its own (`stackwalk.ts`).
        module: frame.module ?? 'unknown',
        functionText: inline.function ?? '???',
        functionUrl: searchfoxFrameUrl(inline),
        locationText: hasLocation ? `${info ? info.path : inline.file}:${inline.line}` : '',
        locationUrl: hasLocation ? sourceUrl(inline.file, inline.line) : null,
        // An inline row never carries an offset: upstream's inline branch has
        // no `function_offset` clause at all (`crash-viewer.html:884-894`), and
        // an inlined callee has no offset of its own to report.
        locationOffsetText: '',
        // Not a trust level the walker reported — upstream writes the literal
        // word in the trust column to mark the row as an inline, and writes
        // the cell with no `title` attribute at all. See `trustTitle`.
        trust: 'inline',
        trustTitle: null,
        classes,
        detailsId: null,
        registers: [],
    };
}

/**
 * The **linked** part of the location cell: `path:line`, with no offset.
 *
 * The offset is `locationOffsetText`, a separate field, because upstream emits
 * it outside the `<a>` — see that field's comment.
 */
function frameLocationText(frame: Frame): string {
    if (!frame.file || !frame.line) {
        return '';
    }
    const info = parseFileInfo(frame.file);
    return `${info ? info.path : frame.file}:${frame.line}`;
}

/**
 * The ` +offset` text node that follows the location link.
 *
 * Upstream appends `function_offset` **only inside** the `file && line` branch
 * (`crash-viewer.html:924-934`), so an unsymbolized frame with an offset but no
 * source line shows nothing rather than a bare `+0x4c`. Preserved: the offset
 * on its own, in a column headed "Location", would read as a line number.
 */
function frameLocationOffsetText(frame: Frame): string {
    if (!frame.file || !frame.line || !frame.function_offset) {
        return '';
    }
    return ` +${formatHexOffset(frame.function_offset)}`;
}

// --- threads -------------------------------------------------------------

/**
 * How many frames a non-crashing thread shows before "Show N more".
 *
 * Upstream's 10 (`crash-viewer.html:786`). The crashing thread is never
 * truncated: it is why the page was opened.
 */
export const THREAD_FRAME_PREVIEW = 10;

/** One thread as the page draws it. */
export interface ThreadView {
    /** Index into `threads`, which is what the `#N` heading shows. */
    index: number;
    threadId: number | string;
    name: string | null;
    crashing: boolean;
    /** The `#3 - MainThread` / `#3 - tid: 1234` heading text. */
    heading: string;
    /** The heading's tooltip, always `tid: …`. */
    headingTitle: string;
    /** Every row, preview and hidden alike, in display order. */
    rows: FrameRow[];
    /**
     * The "Show N more frames" control, or `null` when the thread is short
     * enough to show whole.
     */
    truncation: { toggleId: string; label: string; hiddenFrameCount: number } | null;
}

/**
 * A thread's heading, matching upstream's two spellings.
 *
 * A named thread reads `#3 - MainThread`; an unnamed one repeats the tid,
 * `#3 - tid: 1234`. `thread_id` is `unknown` when absent — a string where a
 * number is expected, and upstream's literal (`crash-viewer.html:707`), which
 * matters because it lands in the tooltip.
 */
function threadHeading(thread: Thread, index: number): { heading: string; title: string } {
    // `||` rather than `??`: upstream's, and it makes thread id 0 read as
    // `unknown`. Measured: 0 of the 699 threads across the nine dumps in
    // `artifacts/dumps/` have a falsy `thread_id` — the ids are OS handles — so
    // the difference is not present in the current corpus. Kept for the same
    // reason `frameName`'s `||` is kept: the port's contract is upstream's
    // behaviour, and modernizing one operator quietly is what makes the rest of
    // that claim unverifiable.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    const tid = thread.thread_id || 'unknown';
    return {
        heading: `#${index}${thread.thread_name ? ` - ${thread.thread_name}` : ` - tid: ${tid}`}`,
        title: `tid: ${tid}`,
    };
}

/**
 * The crashing thread's view: every frame, none hidden.
 *
 * Uses `file.crashing_thread` rather than `threads[crashing_thread]` because
 * only that copy carries `registers` — measured across eight dumps, `threads[i]`
 * never does, so rendering from the array would silently drop the register
 * expansion that is the point of clicking a frame.
 */
export function crashingThreadView(file: StackwalkFile): ThreadView | null {
    const thread = file.crashing_thread;
    if (thread === undefined) {
        return null;
    }
    // Upstream's `?? 0`: the heading says `#0` when the dump records no index.
    const index = file.crash_info?.crashing_thread ?? 0;
    const { heading, title } = threadHeading(thread, index);
    return {
        index,
        threadId: thread.thread_id,
        name: thread.thread_name,
        crashing: true,
        heading,
        headingTitle: title,
        rows: thread.frames.flatMap((frame, position) =>
            // Only the innermost frame is highlighted, and by *position* in the
            // rendered list rather than by `frame.frame` — upstream keys on the
            // loop index (`crash-viewer.html:864`).
            frameRows(frame, { crashed: position === 0 })
        ),
        truncation: null,
    };
}

/**
 * The non-crashing threads, in file order, each truncated to 10 frames.
 *
 * The crashing thread is skipped by **index**, matching upstream
 * (`crash-viewer.html:772`): `crash_info.crashing_thread` is an index into
 * `threads`, and comparing thread objects would not work because
 * `crashing_thread` is a separate copy.
 *
 * ## Truncation, without the string surgery
 *
 * Upstream renders the first 10 frames, then removes the trailing
 * `</tbody></table>` with `html.slice(0, -16)` so the hidden rows can be
 * appended into the same table (`crash-viewer.html:794`). That is a **declared
 * divergence**: here the rows are simply one list carrying a `classes` entry,
 * and the renderer emits one table. The rendered DOM is the same — one table,
 * one tbody, the extra rows inside it — which the parity comparison checks
 * directly rather than taking on trust.
 *
 * The count in the label is the number of **frames** hidden, not rows: a hidden
 * frame with three inlines contributes four rows but counts once, because
 * that is what upstream counts (`frames.length - 10`) and what a reader means
 * by "1 more frame".
 */
export function otherThreadViews(file: StackwalkFile): ThreadView[] {
    const crashingIndex = file.crash_info?.crashing_thread;
    const views: ThreadView[] = [];

    for (const [index, thread] of file.threads.entries()) {
        if (index === crashingIndex) {
            continue;
        }
        const { heading, title } = threadHeading(thread, index);
        const truncated = thread.frames.length > THREAD_FRAME_PREVIEW;
        const preview = truncated ? thread.frames.slice(0, THREAD_FRAME_PREVIEW) : thread.frames;
        const hidden = truncated ? thread.frames.slice(THREAD_FRAME_PREVIEW) : [];
        const hiddenFrameCount = hidden.length;

        views.push({
            index,
            threadId: thread.thread_id,
            name: thread.thread_name,
            crashing: false,
            heading,
            headingTitle: title,
            rows: [
                ...preview.flatMap((frame) => frameRows(frame)),
                ...hidden.flatMap((frame) => frameRows(frame, { extraClass: 'thread-extra-frames' })),
            ],
            truncation: truncated
                ? {
                      toggleId: `thread-toggle-${index}`,
                      label: `▸ Show ${hiddenFrameCount} more frame${hiddenFrameCount > 1 ? 's' : ''}`,
                      hiddenFrameCount,
                  }
                : null,
        });
    }
    return views;
}

// --- the whole page ------------------------------------------------------

/** A label/value pair in one of the two info grids. */
export interface InfoField {
    label: string;
    value: string;
    /** True for the URL row, which spans the grid's remaining columns. */
    full?: boolean;
}

/** The red box above the crashing thread's stack. */
export interface CrashReasonView {
    /** From the `.extra` sidecar, when it recorded one. */
    mozCrashReason: string | null;
    type: string;
    address: string;
    /** Set only for a recognized null-pointer dereference. */
    nullPointerOffset: string | null;
    instruction: string | null;
    memoryAccesses: { address: string; size: number; accessType: string }[];
    /**
     * `null` when the walker reported none, and the page then says so
     * explicitly rather than omitting the line — an absent update is
     * information about the faulting instruction, not missing data.
     */
    instructionPointerUpdate: string | null;
}

/** The collapsed "all extra data" block. */
export interface ExtraDataView {
    /** Fields not already shown above, in the sidecar's own order. */
    fields: { name: string; value: string }[];
    /** `▸ Show all extra data (N fields)`. */
    label: string;
}

/** One row of the loaded-modules table. */
export interface ModuleRow {
    filename: string;
    version: string;
    baseAddress: string;
    size: string;
}

/** Everything the page draws, derived once. */
export interface CrashView {
    signature: string;
    /** `Crash @ foo` — the `document.title`. */
    documentTitle: string;
    crashStatsUrl: string;
    /** The `?url=` the dump came from, for the "View raw JSON" link. */
    rawJsonUrl: string | null;
    systemInfo: InfoField[];
    processInfo: InfoField[];
    extraData: ExtraDataView | null;
    crashReason: CrashReasonView | null;
    crashingThread: ThreadView | null;
    otherThreads: ThreadView[];
    modules: ModuleRow[];
}

/**
 * The `.extra` sidecar: an arbitrary key/value annotation file the harness
 * uploads next to the dump. Values are usually strings but not always.
 */
export type ExtraData = Record<string, unknown>;

/**
 * Fields the page shows in the grids above, so the collapsed block does not
 * repeat them. Upstream's list (`crash-viewer.html:676`), unchanged.
 */
const DISPLAYED_EXTRA_FIELDS = ['MozCrashReason', 'ProcessType', 'RemoteType', 'URL'];

/**
 * Builds the whole view.
 *
 * `extra` is optional because the sidecar is: it is fetched alongside the dump
 * and a 404 is normal, not an error (`crash-viewer.html:600`). Everything that
 * reads it therefore has a no-sidecar branch, and the smallest dump in the
 * corpus exercises it.
 */
export function crashView(
    file: StackwalkFile,
    options: { url?: string | null; extra?: ExtraData | null } = {}
): CrashView {
    const { url = null, extra = null } = options;
    const signature = crashSignature(file);

    return {
        signature,
        documentTitle: `Crash ${signature}`,
        crashStatsUrl: crashStatsSearchUrl(signature),
        rawJsonUrl: url,
        systemInfo: systemInfoFields(file),
        processInfo: processInfoFields(file, extra),
        extraData: extraDataView(extra),
        crashReason: crashReasonView(file, extra),
        crashingThread: crashingThreadView(file),
        otherThreads: otherThreadViews(file),
        modules: moduleRows(file),
    };
}

/**
 * The first grid: OS, CPU, versions.
 *
 * Empty when the dump has no `system_info`, and the page then omits the grid
 * entirely rather than drawing four empty rows.
 */
function systemInfoFields(file: StackwalkFile): InfoField[] {
    const info = file.system_info as StackwalkFile['system_info'] | undefined;
    if (info === undefined) {
        return [];
    }

    // The Linux distribution is merged into the OS row rather than given one of
    // its own. `lsb_release` is `null` off Linux, so this is the only row whose
    // content is platform-dependent.
    let os = info.os;
    const lsb = file.lsb_release as
        | { description?: string; id?: string; release?: string; codename?: string }
        | null
        | undefined;
    if (lsb) {
        os += lsb.description
            ? ` - ${lsb.description}`
            : // Upstream's `|| ''` on each part, so a distribution recording
              // only some of them still renders — with the separators, which is
              // why this can read `Linux -  24.04 - `.
              ` - ${lsb.id ?? ''} ${lsb.release ?? ''} - ${lsb.codename ?? ''}`;
    }

    return [
        { label: 'Operating system:', value: os },
        { label: 'CPU:', value: `${info.cpu_arch} - ${info.cpu_info ?? ''}` },
        { label: 'OS version:', value: info.os_ver },
        { label: 'CPU count:', value: String(info.cpu_count) },
    ];
}

/** The second grid: process type, pid, and the page URL from the sidecar. */
function processInfoFields(file: StackwalkFile, extra: ExtraData | null): InfoField[] {
    // `RemoteType` names a content process's flavour (`web`, `privilegedabout`)
    // and is absent on the parent, where `ProcessType` answers instead; a dump
    // with neither is the main process. Upstream's `||` chain, which also means
    // an empty `RemoteType` falls through to `ProcessType`.
    const processType =
        (extra?.['RemoteType'] as string | undefined) ||
        (extra?.['ProcessType'] as string | undefined) ||
        'main';

    const fields: InfoField[] = [
        { label: 'Process type:', value: processType },
        { label: 'Process PID:', value: String(file.pid) },
    ];
    if (extra?.['URL']) {
        fields.push({ label: 'URL:', value: String(extra['URL']), full: true });
    }
    return fields;
}

/** The collapsed block, or `null` when there is nothing left to show. */
function extraDataView(extra: ExtraData | null): ExtraDataView | null {
    if (extra === null) {
        return null;
    }
    const fields = Object.entries(extra)
        .filter(([key]) => !DISPLAYED_EXTRA_FIELDS.includes(key))
        .map(([name, value]) => ({
            name,
            // An object value is pretty-printed rather than shown as
            // `[object Object]`. Upstream's `JSON.stringify(value, null, 2)`.
            value: typeof value === 'object' && value !== null
                ? JSON.stringify(value, null, 2)
                : String(value),
        }));
    if (fields.length === 0) {
        return null;
    }
    return { fields, label: `▸ Show all extra data (${fields.length} fields)` };
}

/** The red box, or `null` when the dump records no `crash_info`. */
function crashReasonView(file: StackwalkFile, extra: ExtraData | null): CrashReasonView | null {
    const info = file.crash_info;
    if (info === undefined) {
        return null;
    }
    return {
        mozCrashReason: (extra?.['MozCrashReason'] as string | undefined) ?? null,
        type: info.type,
        address: info.address,
        nullPointerOffset:
            info.adjusted_address?.kind === 'null-pointer' ? info.adjusted_address.offset : null,
        instruction: info.instruction,
        memoryAccesses: (info.memory_accesses ?? []).map((access) => ({
            address: access.address,
            size: access.size,
            accessType: access.access_type,
        })),
        instructionPointerUpdate:
            // The field is `{ address }`, and upstream interpolates the object
            // itself into a template string — so `crash-viewer.html` renders
            // `Instruction pointer update: [object Object]` for every dump
            // that has one. Measured in a browser against the mac hang dump
            // 8EE0FE6C-…, and reproduced by `stackwalk-hang.json`, which
            // records `{"address": "0x00007fff7365b170"}`. Reading `.address`
            // is a declared divergence and a bug fix; see
            // `next/crash-viewer.ts`.
            info.instruction_pointer_update === null
                ? null
                : (info.instruction_pointer_update.address ??
                  String(info.instruction_pointer_update)),
    };
}

/** The loaded-modules table. */
function moduleRows(file: StackwalkFile): ModuleRow[] {
    return (file.modules ?? []).map((module: Module) => ({
        filename: module.filename || 'unknown',
        version: module.version ?? '',
        baseAddress: module.base_addr ? formatHexOffset(module.base_addr) : '',
        // `size` is not in the declared `Module` shape but the walker emits it,
        // and upstream reads it. `?? ''` where it is absent, matching
        // upstream's falsy check.
        size:
            (module as unknown as { size?: number }).size === undefined ||
            !(module as unknown as { size?: number }).size
                ? ''
                : String((module as unknown as { size?: number }).size),
    }));
}
