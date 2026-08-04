/**
 * What a command is given: where to write, where to read data from, and the
 * globals.
 *
 * This is the seam that makes every command testable without a network or a
 * process. `PLAN.md` §3 step 4 asks for "each command against fixtures via the
 * fake source, asserting on `--json` output", and that is only possible if a
 * command never reaches for `process.stdout` or global `fetch` itself.
 *
 * The `stdout`/`stderr` split is a contract rather than a convenience:
 * `CLI.md` says only the requested data goes to stdout, so `> out.md` and a
 * pipe into `jq` both behave. Progress, warnings and the data's provenance all
 * go to stderr. A command that writes a progress line to stdout breaks a
 * pipeline in a way that is only visible to whoever is on the other end of it.
 */

import type { DataSource } from '../lib/sources/source.ts';
import type { TreeherderClient } from '../lib/sources/treeherder.ts';
import type { GlobalOptions } from './options.ts';

/** Where a command writes. */
export interface OutputStreams {
    /** The requested data. Nothing else. */
    out(text: string): void;
    /** Progress, diagnostics, provenance. */
    err(text: string): void;
}

/** Everything a command needs from the outside world. */
export interface CommandContext {
    globals: GlobalOptions;
    streams: OutputStreams;
    /**
     * The source for published index files.
     *
     * Already wrapped in the disk cache unless `--no-cache`, so a command
     * never knows whether it was served from disk. That is deliberate: the
     * cache must not be able to change what a command computes.
     */
    source: DataSource;
    /**
     * A source for a specific task's own artifacts, for `--profiles` and
     * `fx-tests crash`. Separate from `source` because the failure modes
     * differ — an expired artifact is exit 4, a missing index file is not.
     */
    taskArtifacts?: DataSource | undefined;
    /** Treeherder, for `fx-tests try`. Absent when a command does not need it. */
    treeherder?: TreeherderClient | undefined;
    /**
     * Raw HTTP, for the artifacts `fx-tests try` reads per job.
     *
     * `try` fetches one profile per failed job from
     * `firefoxci.taskcluster-artifacts.net`, which is not an index artifact
     * and not a `DataSource` name. Injected so no test hits the network.
     */
    fetchUrl?: ((url: string) => Promise<Uint8Array | null>) | undefined;
}

/** Writes a progress line, unless `--quiet`. */
export function progress(context: CommandContext, message: string): void {
    if (!context.globals.quiet) {
        context.streams.err(`${message}\n`);
    }
}

/** Writes a warning. Warnings ignore `--quiet` — they are not progress. */
export function warn(context: CommandContext, message: string): void {
    context.streams.err(`warning: ${message}\n`);
}

/** Writes the command's output, ensuring exactly one trailing newline. */
export function emit(context: CommandContext, text: string): void {
    if (text.length === 0) {
        return;
    }
    context.streams.out(text.endsWith('\n') ? text : `${text}\n`);
}

/** Collects output into strings, for tests. */
export function captureStreams(): OutputStreams & { stdout: string; stderr: string } {
    const captured = {
        stdout: '',
        stderr: '',
        out(text: string): void {
            captured.stdout += text;
        },
        err(text: string): void {
            captured.stderr += text;
        },
    };
    return captured;
}
