/**
 * Exit codes, and the errors that carry them.
 *
 * `CLI.md`'s table is the contract, and the 3/4 split is the part with real
 * consequences: a script needs to tell "try again in a minute" from "this
 * crash dump is never coming back". Collapsing them — which is what a bare
 * `process.exit(1)` on any failure does — makes retry logic impossible to
 * write correctly.
 *
 * Every command signals a non-zero exit by throwing one of these rather than
 * calling `process.exit`, so that `bin/fx-tests.ts` is the only place that
 * knows about the process at all. That is what lets a test run a command and
 * assert on the code without spawning anything.
 */

/** `CLI.md`'s exit-code table, as a type. */
export const ExitCode = {
    /** Success. */
    Success: 0,
    /** Usage error: bad flag, missing argument, `--json` with `--markdown`. */
    Usage: 1,
    /** Not found: no such test, no data for that revision, no such minidump. */
    NotFound: 2,
    /**
     * Upstream **temporarily** unavailable — index unreachable, 5xx, network
     * failure. Retrying may work.
     */
    Upstream: 3,
    /**
     * Data **permanently** gone — an expired Taskcluster artifact. Retrying
     * will not help.
     */
    Gone: 4,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * An error that names the exit code it should produce.
 *
 * The message is printed to stderr as-is, so it is written for a human: it
 * should say what was looked for and, where there is one, what to try next.
 * `CliError` is not for programming mistakes — those should throw a plain
 * `Error` and surface with a stack, because a stack is what a bug report needs.
 */
export class CliError extends Error {
    readonly exitCode: ExitCodeValue;
    /** An optional second paragraph: the suggested next step. */
    readonly hint: string | undefined;

    constructor(exitCode: ExitCodeValue, message: string, hint?: string) {
        super(message);
        this.name = 'CliError';
        this.exitCode = exitCode;
        this.hint = hint;
    }
}

/** A usage error — exit 1. */
export function usageError(message: string, hint?: string): CliError {
    return new CliError(ExitCode.Usage, message, hint);
}

/** A not-found error — exit 2. */
export function notFoundError(message: string, hint?: string): CliError {
    return new CliError(ExitCode.NotFound, message, hint);
}

/** A transient upstream failure — exit 3. */
export function upstreamError(message: string, hint?: string): CliError {
    return new CliError(ExitCode.Upstream, message, hint);
}

/** Permanently missing data — exit 4. */
export function goneError(message: string, hint?: string): CliError {
    return new CliError(ExitCode.Gone, message, hint);
}
