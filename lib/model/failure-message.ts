/**
 * Normalizing a failure message so two runs of the same failure group together.
 *
 * One function, and the reason it is its own module: it was written twice with
 * a one-line difference, and the difference decided whether a Windows failure
 * and a Linux failure of the same test were one message or two.
 *
 * ## The substitutions, and what each is for
 *
 * A raw failure message carries per-run detritus. Left in, every occurrence of
 * one failure becomes its own message, which defeats two things at once: the
 * grouping that puts one row under one heading, and the same-message comparison
 * against central that decides whether a push's failure is a known intermittent
 * or something this push broke. The three substitutions strip a task number, a
 * rejection timestamp, and an elapsed time. `old/try.html:865`.
 *
 * ## The line ending, which is the divergence this module closes
 *
 * `cli/commands/try.ts` normalized CRLF to LF first; `site/try.ts` did not, and
 * compensated at one of its two call sites — the `Test` marker (`:450`), not
 * the `TestStatus` marker (`:425`) that overrides it for FAIL, TIMEOUT and
 * ERROR and is therefore the common path. `old/try.html:948` and `:973` have
 * the identical asymmetry, so the page is a faithful port and the CLI is where
 * the behaviour changed.
 *
 * **The CLI's is the correct one**, and not merely because it is the newer.
 * The `Rejection date` pattern is anchored on `\n`, so on CRLF input the `\r`
 * survives as the last character of the preceding line. Measured on the two
 * spellings of one logical failure:
 *
 * ```
 * LF   input 'uncaught rejection\nRejection date: …\nstack frame'
 * CRLF input 'uncaught rejection\r\nRejection date: …\r\nstack frame'
 *
 * with the CRLF pass:     both -> 'uncaught rejection\nstack frame'   (1 group)
 * without it:  LF   -> 'uncaught rejection\nstack frame'
 *              CRLF -> 'uncaught rejection\r\nstack frame'            (2 groups)
 * ```
 *
 * A test that fails the same way on Windows and on Linux is one failure. The
 * page split it in two, and the split is invisible in the output: two rows that
 * look identical, because the only difference is a control character. That is
 * also the shape that defeats the central comparison, where the push's message
 * is matched against a stored one that may have either ending.
 *
 * ## `null` in, `null` out
 *
 * The two callers disagreed here too — the CLI returned `null` for `null` and
 * threw a `TypeError` on `undefined`; the page returned `undefined` for both.
 * The signature accepts either spelling of absence and returns `null`, so a
 * caller cannot get a `TypeError` out of a missing message, and there is one
 * spelling of "no message" downstream rather than two that compare unequal.
 */

/**
 * Strips the per-run parts of a failure message.
 *
 * Returns `null` when there is no message, for either spelling of absence.
 */
export function normalizeMessage(message: string | null | undefined): string | null {
    if (message === null || message === undefined) {
        return null;
    }
    return (
        message
            // First, so the patterns below see one line ending. See the module
            // comment: doing this last, or not at all, leaves a `\r` that makes
            // the same failure two messages across platforms.
            .replace(/\r\n/g, '\n')
            .replace(/task_\d+/g, 'task_id')
            .replace(/\nRejection date: [^\n]+/g, '')
            .replace(/Test ran for \d+s/g, 'Test ran for Xs')
    );
}
