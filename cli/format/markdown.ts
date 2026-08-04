/**
 * Markdown output primitives.
 *
 * `--markdown` exists for one use: pasting a result into a bug or a PR. That
 * shapes two decisions here.
 *
 * **Cells are escaped.** A failure message routinely contains `|`, and an
 * unescaped one silently splits a row into extra columns — the table still
 * renders, so the corruption is invisible until someone reads the numbers.
 * Backticks and newlines have the same problem.
 *
 * **Nothing is truncated by default at this layer.** The command decides how
 * many rows to emit; Markdown is for a document rather than a terminal, so the
 * column-width truncation that plain text needs would only lose information
 * here. The `… n more` line is still emitted, because a partial list must say
 * so in every format.
 */

/** A Markdown table column. */
export interface MarkdownColumn {
    header: string;
    align?: 'left' | 'right';
}

/** Renders a Markdown table, or nothing when there are no rows. */
export function table(
    columns: readonly MarkdownColumn[],
    rows: readonly (readonly string[])[]
): string[] {
    if (rows.length === 0) {
        return [];
    }
    const header = `| ${columns.map((c) => escapeCell(c.header)).join(' | ')} |`;
    const rule = `| ${columns
        .map((c) => (c.align === 'right' ? '---:' : '---'))
        .join(' | ')} |`;
    const body = rows.map(
        (row) =>
            `| ${columns
                .map((_, i) => escapeCell(row[i] ?? ''))
                .join(' | ')} |`
    );
    return [header, rule, ...body];
}

/**
 * Escapes a table cell.
 *
 * `|` becomes `\|` and newlines become `<br>`, because a raw newline in a cell
 * ends the row. A failure message with an embedded stack trace is the common
 * case and the one that breaks a table most thoroughly.
 */
export function escapeCell(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, '<br>');
}

/** A fenced code block. */
export function fence(content: string, language = ''): string[] {
    return ['```' + language, content, '```'];
}

/** An ATX heading. */
export function heading(text: string, level = 2): string {
    return `${'#'.repeat(level)} ${text}`;
}

/** Inline code, for a path or an identifier. */
export function code(value: string): string {
    return `\`${value.replace(/`/g, '‘')}\``;
}

/** A bullet, indented by nesting depth. */
export function bullet(text: string, depth = 0): string {
    return `${'  '.repeat(depth)}- ${text}`;
}

/** The "… n more" line, as Markdown. */
export function moreLine(total: number, shown: number): string | null {
    const hidden = total - shown;
    if (hidden <= 0) {
        return null;
    }
    return `_… ${hidden} more (\`--limit 0\` for all)_`;
}
