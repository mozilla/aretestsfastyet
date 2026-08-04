/**
 * Plain-text output primitives.
 *
 * `CLI.md`'s design goal is "output for reading, not parsing": compact, no
 * colour required, no ASCII-art tables that wrap at 80 columns. So the table
 * here is space-aligned columns with no borders, which degrades gracefully
 * when a cell is too wide instead of breaking the frame.
 *
 * The other rule this module enforces is **context-window frugality**: a
 * truncated list says what it truncated. `… 47 more (--limit 0 for all)` is
 * one line and it is the difference between a caller knowing there is more and
 * a caller concluding there is not.
 */

/** A column of a text table. */
export interface Column {
    header: string;
    /** Right-align, for numbers. Default left. */
    align?: 'left' | 'right';
    /**
     * Truncate cells to this width, with an ellipsis. Omit for no limit.
     *
     * Only the message column normally needs one, and `CLI.md` is explicit
     * that truncation must be visible — the `…` is that signal.
     */
    maxWidth?: number;
    /**
     * Treat cells as slash-separated paths, so `maxWidth` drops leading
     * directories rather than the basename. See `truncatePath()`.
     */
    path?: boolean;
}

/**
 * Renders aligned columns.
 *
 * The last column is not padded, so a long message does not leave trailing
 * spaces on every line.
 */
export function table(
    columns: readonly Column[],
    rows: readonly (readonly string[])[],
    indent = '  '
): string[] {
    if (rows.length === 0) {
        return [];
    }
    const cells = rows.map((row) =>
        row.map((cell, i) => {
            const column = columns[i];
            const max = column?.maxWidth;
            if (max === undefined) {
                return cell;
            }
            return column?.path === true ? truncatePath(cell, max) : truncate(cell, max);
        })
    );
    const widths = columns.map((column, i) =>
        Math.max(
            column.header.length,
            ...cells.map((row) => (row[i] ?? '').length)
        )
    );

    const line = (values: readonly string[]): string => {
        const parts: string[] = [];
        for (let i = 0; i < columns.length; i++) {
            const value = values[i] ?? '';
            const isLast = i === columns.length - 1;
            if (isLast) {
                parts.push(columns[i]!.align === 'right' ? value.padStart(widths[i]!) : value);
            } else {
                parts.push(
                    columns[i]!.align === 'right'
                        ? value.padStart(widths[i]!)
                        : value.padEnd(widths[i]!)
                );
            }
        }
        return (indent + parts.join('  ')).trimEnd();
    };

    return [line(columns.map((c) => c.header)), ...cells.map(line)];
}

/** Truncates with a trailing `…`, so the cut is visible. */
export function truncate(value: string, maxWidth: number): string {
    if (maxWidth <= 0 || value.length <= maxWidth) {
        return value;
    }
    return `${value.slice(0, Math.max(0, maxWidth - 1))}…`;
}

/**
 * Truncates a slash-separated path by dropping **leading directories**.
 *
 * `truncate()` cuts the tail, which for a path removes the only part that
 * identifies it. `browser/extensions/formautofill/test/browser/browser_ml_heu…`
 * cannot be pasted into `fx-tests test`, cannot be grepped for, and cannot be
 * told apart from its neighbours — and feeding the next command is what this
 * output is for. The basename is what a reader recognises and what every other
 * command accepts as an argument, so it is the part that survives.
 *
 * The result is `…/` plus as many trailing segments as fit:
 *
 * ```
 * …/test/browser/browser_ml_heuristics.js
 * ```
 *
 * A basename longer than the budget on its own is still cut from the tail —
 * there is nothing else to drop — but that is a rare filename, not the common
 * case of a deep directory. Paths that fit are returned untouched, so the
 * `…/` prefix is itself the signal that something was dropped.
 */
export function truncatePath(value: string, maxWidth: number): string {
    if (maxWidth <= 0 || value.length <= maxWidth) {
        return value;
    }
    const segments = value.split('/');
    // Grow the tail one segment at a time while it still fits under the
    // budget, which the `…/` prefix eats two characters of.
    let kept = '';
    for (let i = segments.length - 1; i >= 0; i--) {
        const candidate = segments.slice(i).join('/');
        if (candidate.length + 2 > maxWidth) {
            break;
        }
        kept = candidate;
    }
    if (kept === '') {
        // Not even the basename fits. Keep its tail rather than its head: a
        // filename's distinguishing part is usually at the end
        // (`…_forms.html` vs `…_form.html`).
        const basename = segments[segments.length - 1] ?? value;
        return `…${basename.slice(Math.max(0, basename.length - (maxWidth - 1)))}`;
    }
    return `…/${kept}`;
}

/**
 * The "… n more" line for a truncated list, or `null` when nothing was cut.
 *
 * `CLI.md` specifies both the wording and the reason: an agent pasting output
 * into a prompt has to know the list is partial, and the flag that lifts the
 * limit belongs in the same line as the count.
 */
export function moreLine(total: number, shown: number, indent = '  '): string | null {
    const hidden = total - shown;
    if (hidden <= 0) {
        return null;
    }
    return `${indent}… ${hidden} more (--limit 0 for all)`;
}

/**
 * Applies a limit, returning the rows to show.
 *
 * `0` means everything, per `CLI.md`. `undefined` means the command's default,
 * which is the caller's to supply — a limit of "whatever the command thinks"
 * cannot live here.
 */
export function applyLimit<T>(items: readonly T[], limit: number | undefined): T[] {
    if (limit === undefined || limit === 0) {
        return [...items];
    }
    return items.slice(0, limit);
}

/** A percentage with one decimal, or `—` when there is no rate to state. */
export function percent(value: number | null | undefined, digits = 1): string {
    if (value === null || value === undefined) {
        return '—';
    }
    return `${value.toFixed(digits)}%`;
}

/** A signed percentage-point delta, or `=` when it is zero, `—` when unknown. */
export function delta(value: number | null | undefined, digits = 2): string {
    if (value === null || value === undefined) {
        return '—';
    }
    if (Math.abs(value) < 0.005) {
        return '=';
    }
    return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

/** A count with thousands separators. */
export function count(value: number): string {
    return value.toLocaleString('en-US');
}

/**
 * A date with its weekday.
 *
 * Every command that names a date prints the weekday with it, because
 * `CLI.md` and `FORMATS.md` both make the same point: push volume drops
 * several-fold at weekends (measured 2.6×), so an absolute count from a
 * Saturday is not comparable with one from a Thursday. The weekday is the
 * cheapest possible warning about that, and it is why this is a shared
 * function rather than each command formatting a date its own way.
 */
export function dateWithWeekday(date: string): string {
    const weekday = weekdayOf(date);
    return weekday === null ? date : `${date} (${weekday})`;
}

/** The weekday name of a `YYYY-MM-DD` date, or `null` if it is not one. */
export function weekdayOf(date: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return null;
    }
    // Parsed as UTC deliberately: these dates are calendar labels from the
    // data, not instants, and a local-time parse shifts them by a day for
    // anyone west of UTC.
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][parsed.getUTCDay()]!;
}

/** Whether a date falls on a Saturday or Sunday. */
export function isWeekend(date: string): boolean {
    const weekday = weekdayOf(date);
    return weekday === 'Sat' || weekday === 'Sun';
}

/** Joins sections, collapsing runs of blank lines. */
export function joinLines(lines: readonly (string | null)[]): string {
    const out: string[] = [];
    for (const line of lines) {
        if (line === null) {
            continue;
        }
        if (line === '' && (out.length === 0 || out[out.length - 1] === '')) {
            continue;
        }
        out.push(line);
    }
    while (out.length > 0 && out[out.length - 1] === '') {
        out.pop();
    }
    return out.join('\n');
}

/** A byte count in the largest unit that keeps it readable. */
export function bytes(value: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let scaled = value;
    let unit = 0;
    while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024;
        unit++;
    }
    return `${unit === 0 ? scaled : scaled.toFixed(1)} ${units[unit]}`;
}
