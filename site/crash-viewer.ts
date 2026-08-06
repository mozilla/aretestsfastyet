/**
 * `crash-viewer.html`, migrated onto `lib/`.
 *
 * The first of the three page migrations `PARITY.md` §3 sequences, and the one
 * that sets the pattern. That pattern is a **three-way split**, and the next
 * two migrations should copy the boundary rather than just the file count:
 *
 * | file | contains | tested by |
 * | --- | --- | --- |
 * | `lib/` | data and derivations: the signature heuristic, URL builders, format helpers | node tests, shared with the CLI |
 * | `site/crash-view.ts` | the view model — every decision, and everything naming an id, a class or a glyph | `test/crash-view.test.ts`, no DOM |
 * | this file | turning those decisions into elements | the browser parity run |
 *
 * **The rule: `lib/` holds data and derivations; the page directory holds the
 * view model.** The question to ask of any given function is *would a non-page
 * consumer want this, and does it name anything about the UI?* — `crash-view.ts`
 * documents how that test was applied here, including the one call that went
 * against the reviewer's suggested split.
 *
 * The reason for splitting the view model out at all is `PARITY.md` §2: a page
 * whose logic is inline has no seam to compare against, and retrofitting one
 * onto a page that gates everything behind a load handler is what made the
 * earlier CLI-vs-page plan expensive. Here the view model *is* the seam, and it
 * is a plain value — which works just as well from `site/` as from `lib/`,
 * since the seam is the module boundary rather than the directory.
 *
 * ## Why this builds elements instead of concatenating HTML
 *
 * The old page builds one long string and assigns it to `innerHTML`. That is
 * what forces its two worst quirks: `onclick="toggleThreadFrames(7)"` attributes
 * needing global functions, and the truncation splice
 * `html = html.slice(0, -16)` that removes a literal `</tbody></table>` so more
 * rows can be appended to the same table (`old/crash-viewer.html:794`).
 *
 * Building nodes removes the need for both — a row is appended to the `tbody`
 * that already exists, and a listener is attached to the element it belongs to.
 * It also removes the whole class of escaping bugs, since `textContent` cannot
 * be confused about a function name containing `<`. The old page escaped
 * carefully and, as far as the corpus shows, correctly; this simply cannot get
 * it wrong.
 *
 * The rendered DOM is held to being the same, not the source. See the parity
 * evidence in the migration report and the divergences listed below.
 *
 * ## Declared divergences from `crash-viewer.html`
 *
 * `PARITY.md` §4: byte-identical is the default and every exception is declared.
 *
 *  1. **The truncation splice is gone** (above). Same resulting DOM — one
 *     table, one `tbody`, the hidden rows inside it — verified by comparing
 *     the rendered row lists of all 61 truncated threads on a real dump.
 *  2. **"Show N more" toggles both ways.** `toggleThreadFrames`
 *     (`old/crash-viewer.html:988`) only ever *adds* the `expanded` class and then
 *     hides its own button, so a thread cannot be re-collapsed without a
 *     reload. Here the control stays and flips between `▸ Show N more` and
 *     `▾ Hide N`. This is a **behaviour change**, argued in `renderThread`.
 *  3. **`instruction_pointer_update` reads `.address`.** Upstream interpolates
 *     the whole `{ address }` object into a template string, so the page shows
 *     `Instruction pointer update: [object Object]`. This is not hypothetical:
 *     it is what `crash-viewer.html` renders today for the mac hang dump
 *     `8EE0FE6C-…` and for `test/fixtures/stackwalk-hang.json`, both of which
 *     record `{"address": "0x00007fff7365b170"}`. A bug fix, and the only
 *     divergence that changes text a reader sees on a non-hang dump.
 *  4. **Clicking a frame opens *that* frame's registers.** Upstream's
 *     `toggleFrameDetails(rowId)` (`old/crash-viewer.html:958`) looks the details
 *     row up with `getElementById`, and the id is `frame-${frame.frame}-details`
 *     — a per-*thread* index. Two rendered threads whose frame 0 carries
 *     registers therefore produce two `id="frame-0-details"`, and
 *     `getElementById` returns the first, so clicking the second thread's row
 *     opens the crashing thread's registers instead.
 *
 *     No dump in `artifacts/dumps/` triggers this: all nine carry registers on
 *     exactly one frame, and none on any `threads[i]`. So it is **not present
 *     in the current corpus** — but it is not unreachable either, because
 *     `minidump-stackwalk` emits `registers` for any thread's context frame.
 *     Built such a dump and confirmed both behaviours in Chrome:
 *
 *     ```
 *     OLD  clicking the other thread's row -> CRASHING thread's registers open
 *     NEW  clicking the other thread's row -> that thread's registers open
 *     ```
 *
 *     `renderFrameRow` closes over the element rather than looking up the id,
 *     so this is fixed by construction. A **bug fix**, and regression-tested in
 *     `test/crash-view.test.ts`.
 *  5. **The hang note is new** — see below. Visually separable on purpose.
 *
 * ## The hang note, which the old page does not have
 *
 * `lib/model/crash-signature.ts` exports `detectHang`, which the CLI uses to
 * report "This looks like a HANG rather than a crash" with its reasoning. The
 * old page has no such feature and would show a hang as an ordinary
 * `EXC_SOFTWARE / SIGABRT` crash, which is exactly the reading `FORMATS.md`
 * warns is wrong.
 *
 * It is added here because the whole point of migrating onto `lib/` is that a
 * page gains what the library already knows. It is a **behaviour change**, so
 * it is confined to one function, one CSS class and one call site, and removing
 * that call restores the old rendering exactly.
 */

import type { StackwalkFile } from '../lib/formats/stackwalk.ts';
import { detectHang } from '../lib/model/crash-signature.ts';
import {
    type CrashView,
    type ExtraData,
    type FrameRow,
    type InfoField,
    type ThreadView,
    crashView,
} from './crash-view.ts';
import { el } from './drilldown-render.ts';

// --- small DOM helpers ---------------------------------------------------

/**
 * A `target="_blank"` link, or a bare text node when there is no URL.
 *
 * ## On attribute order, which differs from the old page
 *
 * Measured on `win32-mfcdm` in Chrome, the first location link:
 *
 * ```
 * OLD  <a href="…#L1338" class="file-link" target="_blank">…</a>   href, class, target
 * NEW  <a class="file-link" href="…#L1338" target="_blank">…</a>   class, href, target
 * ```
 *
 * The order comes from `el()` assigning `className` before `attrs`, and it is
 * **not** matched, deliberately. Attribute order is not part of the DOM a
 * consumer can observe: `getAttribute`, CSS selectors, `.href`, `.className`
 * and the rendered pixels are all identical, and `attributes` order is the only
 * thing that differs. Only a byte-comparison of serialized HTML would notice.
 *
 * So the choice was between contorting the element builder to match a
 * serialization detail, or comparing at the level that actually matters. The
 * parity harness compares the **parsed DOM** — tag, resolved attribute values,
 * child node structure — which is what made the `+offset` defect above visible
 * in the first place; a byte diff of two pages built by different mechanisms
 * (string concatenation vs `createElement`) is noise-dominated and would have
 * buried it. The rule for the next two migrations: hold the parsed DOM
 * identical, not the serialized bytes.
 */
function link(text: string, href: string | null, className: string): Node {
    if (href === null) {
        return document.createTextNode(text);
    }
    return el('a', { class: className, text, attrs: { href, target: '_blank' } });
}

/** A `<div class="container">`, the page's box. */
function container(...children: (Node | null)[]): HTMLElement {
    return el('div', { class: 'container', children });
}

// --- info grids ----------------------------------------------------------

/** One `.info-grid`, or `null` when it has no fields. */
function renderInfoGrid(fields: InfoField[]): HTMLElement | null {
    if (fields.length === 0) {
        return null;
    }
    const grid = el('div', { class: 'info-grid' });
    for (const field of fields) {
        grid.append(el('div', { class: 'info-label', text: field.label }));
        grid.append(
            el('div', {
                // The URL row spans the grid's remaining columns; every other
                // value sits in one cell.
                class: field.full === true ? 'info-value-full' : 'info-value',
                text: field.value,
            })
        );
    }
    return grid;
}

/** The collapsed extra-data block, with its own toggle. */
function renderExtraData(view: CrashView): HTMLElement | null {
    const extra = view.extraData;
    if (extra === null) {
        return null;
    }
    const content = el('div', {
        class: 'expandable-content',
        id: 'extra-data-content',
        children: extra.fields.map((field) =>
            el('div', {
                class: 'extra-field',
                children: [
                    el('span', { class: 'extra-field-name', text: `${field.name}:` }),
                    document.createTextNode(' '),
                    el('span', { class: 'extra-field-value', text: field.value }),
                ],
            })
        ),
    });

    const header = el('div', { class: 'expandable-header', text: extra.label });
    header.addEventListener('click', () => {
        const expanded = content.classList.toggle('expanded');
        // Upstream rewrites the marker in place with a string replace. Same
        // two characters, chosen rather than substituted.
        header.textContent = expanded
            ? extra.label.replace('▸', '▾')
            : extra.label;
    });

    return el('div', { class: 'expandable-section', children: [header, content] });
}

// --- the crash reason box ------------------------------------------------

/**
 * The red box above the crashing thread's stack.
 *
 * Node for node against `old/crash-viewer.html:717-753`, whitespace included. Two
 * details here were found by diffing the rendered DOM against the old page's
 * rather than by reading the source, and neither is visible in a screenshot:
 *
 *  - **A space before a `<strong>` belongs to the preceding text node.**
 *    Upstream writes `…${address}` and then ` <strong>`, so the address text
 *    node ends with a space when the null-pointer note follows it and does not
 *    when nothing does. Appending the space as a node of its own splits one
 *    text node into two and changes what both contain.
 *  - **The memory-access lines are indented with `&nbsp;`**, three
 *    non-breaking spaces (U+00A0), not ordinary ones. Ordinary spaces collapse
 *    to a single space under HTML whitespace rules and the indent vanishes.
 */
function renderCrashReason(view: CrashView): HTMLElement | null {
    const reason = view.crashReason;
    if (reason === null) {
        return null;
    }
    const box = el('div', { class: 'crash-reason' });
    const label = (text: string): void => {
        box.append(el('strong', { text }));
    };
    const say = (text: string): void => {
        box.append(document.createTextNode(text));
    };

    if (reason.mozCrashReason !== null) {
        label('MozCrashReason:');
        say(` ${reason.mozCrashReason}`);
        box.append(el('br'));
    }
    label('Type:');
    say(` ${reason.type}`);
    box.append(el('br'));
    label('Address:');

    if (reason.nullPointerOffset === null) {
        say(` ${reason.address}`);
    } else {
        // The one case that changes what a reader should do: a fault at 0x18 is
        // a null dereference of a field at offset 0x18, not a wild pointer. The
        // trailing space is part of this node — see the doc comment.
        say(` ${reason.address} `);
        box.append(
            el('strong', {
                text: `** Null pointer detected with offset: ${reason.nullPointerOffset}`,
                attrs: { style: 'color: #d00;' },
            })
        );
    }

    if (reason.instruction !== null) {
        box.append(el('br'));
        label('Crashing instruction:');
        say(' ');
        box.append(el('code', { text: reason.instruction }));
    }

    if (reason.memoryAccesses.length > 0) {
        box.append(el('br'), el('br'));
        label('Memory accessed by instruction:');
        // Three non-breaking spaces, upstream's `&nbsp;&nbsp;&nbsp;`.
        const indent = '\u00a0\u00a0\u00a0';
        for (const [index, access] of reason.memoryAccesses.entries()) {
            box.append(el('br'));
            say(`${index + 1}. Address: ${access.address}`);
            box.append(el('br'));
            say(`${indent}Size: ${access.size}`);
            box.append(el('br'));
            say(`${indent}Access type: ${access.accessType}`);
        }
    }

    box.append(el('br'));
    if (reason.instructionPointerUpdate !== null) {
        label('Instruction pointer update:');
        say(` ${reason.instructionPointerUpdate}`);
    } else {
        // Said explicitly rather than omitted: that the faulting instruction
        // did not move the instruction pointer is information about the crash.
        say('No instruction pointer update by instruction');
    }
    return box;
}

// --- the hang note (new; see the module comment) -------------------------

/**
 * "This looks like a HANG rather than a crash", when the dump says so.
 *
 * **New in the migrated page.** The old one has no equivalent and renders a
 * hang as an ordinary `EXC_SOFTWARE / SIGABRT` crash — the reading
 * `FORMATS.md` explicitly warns against, since the type cannot tell the two
 * apart. `detectHang` is already in `lib/` and already used by `fx-tests
 * crash`; showing the same conclusion in the viewer is the migration paying
 * for itself.
 *
 * Deliberately one self-contained function returning one element, so that
 * deleting its single call site reverts the behaviour change and nothing else.
 * It reuses `.crash-reason`'s styling with an inline colour override rather
 * than adding a CSS rule, for the same reason: the stylesheet is unchanged from
 * the old page and stays that way.
 *
 * It reports rather than acts: the view does not switch to all-threads on its
 * own, because a wrong auto-detection would hide the frames that disprove it.
 */
function renderHangNote(file: StackwalkFile): HTMLElement | null {
    const hang = detectHang(file);
    if (!hang.looksLikeHang) {
        return null;
    }
    const box = el('div', {
        class: 'crash-reason',
        attrs: { style: 'background: #fff8e1; border-left-color: #f0a000;' },
    });
    box.append(el('strong', { text: 'This looks like a HANG rather than a crash.' }));
    box.append(el('br'));
    box.append(document.createTextNode(`${hang.reason}.`));
    if (hang.parkedIn !== null) {
        box.append(el('br'));
        box.append(
            document.createTextNode(
                `Underneath breakpad, the thread was parked in ${hang.parkedIn}.`
            )
        );
    }
    box.append(el('br'));
    box.append(
        document.createTextNode(
            `${hang.blockedThreadCount} of ${file.threads.length} threads are waiting on a ` +
                'lock or condition variable — a heuristic over the innermost frames, since a ' +
                'minidump records no lock ownership.'
        )
    );
    return box;
}

// --- stack tables --------------------------------------------------------

/** The `<colgroup>` widths, byte-identical to upstream's. */
const STACK_COLUMN_WIDTHS = ['40px', '120px', '50%', '30%', '50px'];

/** The five column headings, and the classes upstream gives them. */
const STACK_HEADERS: [string, string][] = [
    ['#', 'frame-num'],
    ['Module', 'frame-module'],
    ['Function', 'frame-function'],
    ['Location', 'frame-location'],
    ['Trust', 'frame-trust'],
];

/** One thread's stack table, rows and hidden rows alike. */
function renderStackTable(rows: FrameRow[]): HTMLElement {
    const table = el('table', { class: 'stack-table' });

    const colgroup = el('colgroup');
    for (const width of STACK_COLUMN_WIDTHS) {
        colgroup.append(el('col', { attrs: { style: `width: ${width}` } }));
    }
    table.append(colgroup);

    const headRow = el('tr');
    for (const [text, className] of STACK_HEADERS) {
        headRow.append(el('th', { class: className, text }));
    }
    table.append(el('thead', { children: [headRow] }));

    const body = el('tbody');
    for (const row of rows) {
        body.append(...renderFrameRow(row));
    }
    table.append(body);
    return table;
}

/** A frame's row, plus its hidden details row when it has registers. */
function renderFrameRow(row: FrameRow): HTMLElement[] {
    const tr = el('tr', { class: row.classes.join(' ') });

    tr.append(el('td', { class: 'frame-num', text: row.number }));
    tr.append(el('td', { class: 'frame-module', text: row.module }));

    const functionCell = el('td', { class: 'frame-function' });
    functionCell.append(link(row.functionText, row.functionUrl, 'file-link'));
    if (row.functionUrl !== null) {
        // The row toggles registers; the link must navigate instead of doing
        // both. Upstream's `event.stopPropagation()` on the same element.
        //
        // **Not present in the current corpus**, and kept anyway. Reaching it
        // needs one frame with *both* registers and a Searchfox link, and
        // across the nine dumps in `artifacts/dumps/` registers appear only on
        // frame 0 of the crashing thread, whose source reference is one
        // `searchfoxFrameUrl` declines. That is a fact about those dumps, not
        // a proof about the format — a symbolized `hg:` frame carrying the
        // thread context is perfectly legal. Verified against a dump edited to
        // force the case: both pages leave the details row closed when the
        // link is clicked and open it when the row is.
        functionCell.firstElementChild?.addEventListener('click', (event) =>
            event.stopPropagation()
        );
    }
    tr.append(functionCell);

    const locationCell = el('td', { class: 'frame-location' });
    if (row.locationText !== '') {
        // The offset goes **outside** the link (`old/crash-viewer.html:924-934`):
        // upstream closes the `</a>` and only then appends ` +${offset}`, so
        // the offset is neither clickable nor underlined. Folding it into the
        // link text renders the same characters, which is why a `textContent`
        // diff passes and the node-level browser diff does not — it reported
        // 110 differing cells on `win32-mfcdm` and 902 on `rustpanic`.
        //
        // When there is **no** link, upstream concatenates both into one
        // string of HTML, so the parser produces a single text node rather
        // than two. Reproduced: the browser diff distinguishes the two shapes,
        // and `s3:` and absolute-path references (unlinkable, and 4 such cells
        // on `win32-mfcdm`) are the frames that take this branch.
        if (row.locationUrl === null) {
            locationCell.append(
                document.createTextNode(row.locationText + row.locationOffsetText)
            );
        } else {
            locationCell.append(link(row.locationText, row.locationUrl, 'file-link'));
            if (row.locationOffsetText !== '') {
                locationCell.append(document.createTextNode(row.locationOffsetText));
            }
        }
    }
    tr.append(locationCell);

    // `title` is set only when the view model has one. `''` is a value here,
    // not an absence: a real frame's cell carries `title=""` when the trust
    // level is unrecognized, and an inline row's carries no attribute at all.
    // See `FrameRow.trustTitle`.
    const trustCell = el('td', { class: 'frame-trust', text: row.trust });
    if (row.trustTitle !== null) {
        trustCell.setAttribute('title', row.trustTitle);
    }
    tr.append(trustCell);

    if (row.detailsId === null) {
        return [tr];
    }

    const details = el('tr', { class: 'frame-details', id: row.detailsId });
    const cell = el('td', { attrs: { colspan: '5' } });
    cell.append(
        el('div', {
            attrs: { style: 'margin-top: 10px;' },
            children: [el('strong', { text: 'Registers:' })],
        })
    );
    cell.append(
        el('div', {
            class: 'registers',
            children: row.registers.map(([name, value]) =>
                el('div', {
                    class: 'register',
                    children: [
                        el('span', { class: 'register-name', text: name }),
                        document.createTextNode(` = ${value}`),
                    ],
                })
            ),
        })
    );
    details.append(cell);

    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => details.classList.toggle('expanded'));
    return [tr, details];
}

/** One thread: its heading, its table, and its "Show N more" control. */
function renderThread(thread: ThreadView): Node[] {
    const nodes: Node[] = [
        el('h4', { text: thread.heading, title: thread.headingTitle }),
        renderStackTable(thread.rows),
    ];

    if (thread.truncation === null) {
        return nodes;
    }

    // **Declared divergence.** `toggleThreadFrames` (`old/crash-viewer.html:988`)
    // only adds `expanded` and then hides its own button, so a thread that has
    // been opened cannot be closed short of reloading the page, and the
    // control that opened it disappears. Measured on the linux-a11y dump: 61
    // of its 102 non-crashing threads are truncated, so on a page already 103
    // stack tables long an accidental click permanently adds rows and removes
    // the only affordance that referred to them.
    //
    // Nothing depends on the one-way behaviour: the class is only read by the
    // `.thread-extra-frames.expanded` CSS rule. So the control stays and flips
    // its own label instead of hiding, which is also what the extra-data
    // toggle two boxes up already does — the old page was inconsistent with
    // itself here.
    const { toggleId, label, hiddenFrameCount } = thread.truncation;
    const toggle = el('p', { class: 'thread-truncate', id: toggleId, text: label });
    toggle.addEventListener('click', () => {
        const table = toggle.previousElementSibling;
        if (!(table instanceof HTMLTableElement)) {
            return;
        }
        const hidden = [...table.querySelectorAll('.thread-extra-frames')];
        const expanding = !hidden[0]?.classList.contains('expanded');
        for (const row of hidden) {
            row.classList.toggle('expanded', expanding);
        }
        toggle.textContent = expanding ? `▾ Hide ${hiddenFrameCount}` : label;
    });
    nodes.push(toggle);
    return nodes;
}

// --- modules -------------------------------------------------------------

/** The loaded-modules table. */
function renderModules(view: CrashView): Node[] {
    if (view.modules.length === 0) {
        return [];
    }
    const table = el('table', { class: 'module-table' });
    const headRow = el('tr');
    for (const heading of ['Name', 'Version', 'Base Address', 'Size']) {
        headRow.append(el('th', { text: heading }));
    }
    table.append(el('thead', { children: [headRow] }));

    const body = el('tbody');
    for (const module of view.modules) {
        body.append(
            el('tr', {
                children: [
                    el('td', { text: module.filename }),
                    el('td', { text: module.version }),
                    el('td', { text: module.baseAddress }),
                    el('td', { text: module.size }),
                ],
            })
        );
    }
    table.append(body);

    return [
        el('h2', { text: `Loaded Modules (${view.modules.length})` }),
        container(table),
    ];
}

// --- the page ------------------------------------------------------------

/** Draws a whole dump into `#output`, and updates the title and heading. */
function display(file: StackwalkFile, url: string | null, extra: ExtraData | null): void {
    const view = crashView(file, { url, extra });
    const output = requireElement('output');
    output.replaceChildren();

    // The signature, in the tab title and the heading. Byte-identical to the
    // old page's is the hard requirement of this migration: it is what a reader
    // groups crashes on and what `fx-tests crashes` prints.
    document.title = view.documentTitle;
    const heading = requireElement('page-title');
    heading.replaceChildren(
        document.createTextNode('Crash '),
        el('a', {
            class: 'crash-signature-link',
            text: view.signature,
            title: 'Search this crash signature in Mozilla Crash Stats',
            attrs: { href: view.crashStatsUrl, target: '_blank' },
        })
    );

    if (view.rawJsonUrl !== null) {
        requireElement('raw-json-link-container').replaceChildren(
            el('a', {
                class: 'raw-json-link',
                text: 'View raw JSON',
                attrs: { href: view.rawJsonUrl, target: '_blank' },
            })
        );
    }

    output.append(
        container(
            renderInfoGrid(view.systemInfo),
            renderInfoGrid(view.processInfo),
            renderExtraData(view)
        )
    );

    if (view.crashReason !== null || view.crashingThread !== null) {
        output.append(el('h2', { text: 'Crashed thread' }));
        const box = container();
        if (view.crashingThread !== null) {
            box.append(el('h4', {
                text: view.crashingThread.heading,
                title: view.crashingThread.headingTitle,
            }));
        }
        // The hang note sits directly above the crash reason it qualifies:
        // "SIGABRT" means something different once this is on screen. Delete
        // this one line to revert the behaviour change (see the module note).
        const hangNote = renderHangNote(file);
        if (hangNote !== null) {
            box.append(hangNote);
        }
        const reason = renderCrashReason(view);
        if (reason !== null) {
            box.append(reason);
        }
        if (view.crashingThread !== null) {
            box.append(renderStackTable(view.crashingThread.rows));
        }
        output.append(box);
    }

    if (view.otherThreads.length > 0) {
        output.append(el('h2', { text: 'Other Threads' }));
        const box = container();
        for (const thread of view.otherThreads) {
            box.append(...renderThread(thread));
        }
        output.append(box);
    }

    output.append(...renderModules(view));
}

/** Shows an error in the output area, as the old page does. */
function showError(message: string, detail?: string): void {
    const box = el('div', { class: 'error', text: message });
    if (detail !== undefined) {
        box.append(el('br'), el('br'), document.createTextNode(detail));
    }
    requireElement('output').replaceChildren(box);
}

/** An element that the page's own markup guarantees exists. */
function requireElement(id: string): HTMLElement {
    const node = document.getElementById(id);
    if (node === null) {
        throw new Error(`${id} is missing from the page`);
    }
    return node;
}

/**
 * Loads a dump from `?url=`, with its optional `.extra` sidecar.
 *
 * The sidecar is fetched from the same URL with `.json` replaced by `.extra`,
 * and **a missing one is not an error**: the harness uploads it for some
 * crashes and not others, and the page must render either way. Both the
 * non-OK response and a rejected fetch resolve to `null`, matching
 * `old/crash-viewer.html:600`.
 *
 * The two are fetched concurrently rather than in sequence — upstream's
 * `Promise.all` — because the sidecar is small and serializing them would
 * double the time to first paint on a 900 kB dump.
 */
async function loadFromUrl(url: string): Promise<void> {
    requireElement('output').replaceChildren(
        el('p', { text: 'Loading crash dump from URL...' })
    );

    const extraUrl = url.replace(/\.json$/, '.extra');
    try {
        const [file, extra] = await Promise.all([
            fetch(url).then((response) => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return response.json() as Promise<StackwalkFile>;
            }),
            fetch(extraUrl)
                .then((response) => (response.ok ? (response.json() as Promise<ExtraData>) : null))
                .catch(() => null),
        ]);
        display(file, url, extra);
    } catch (error) {
        showError(
            `Error loading crash dump: ${error instanceof Error ? error.message : String(error)}`,
            `URL: ${url}`
        );
    }
}

/** Wires the file picker and the `?url=` parameter. */
function main(): void {
    const picker = document.getElementById('jsonFile');
    if (picker instanceof HTMLInputElement) {
        picker.addEventListener('change', () => {
            const file = picker.files?.[0];
            if (file === undefined) {
                return;
            }
            const reader = new FileReader();
            reader.addEventListener('load', () => {
                try {
                    display(JSON.parse(String(reader.result)) as StackwalkFile, null, null);
                } catch (error) {
                    showError(
                        `Error parsing JSON: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            });
            reader.readAsText(file);
        });
    }

    const crashUrl = new URLSearchParams(window.location.search).get('url');
    if (crashUrl !== null && crashUrl !== '') {
        // The picker is hidden rather than removed, matching the old page: the
        // dump is already chosen, and an empty file input above it reads as an
        // invitation to replace it.
        const fileInput = document.querySelector('.file-input');
        if (fileInput instanceof HTMLElement) {
            fileInput.style.display = 'none';
        }
        void loadFromUrl(crashUrl);
    }
}

// The old page wires the picker immediately and defers the `?url=` fetch to
// `window.onload`. A module script is deferred by definition, so the DOM is
// already parsed here and both can happen at once.
main();
