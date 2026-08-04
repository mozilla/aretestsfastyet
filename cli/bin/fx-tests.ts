#!/usr/bin/env node
/**
 * The `fx-tests` entry point.
 *
 * Deliberately thin: everything testable lives in `cli/main.ts`, and this file
 * owns only what a process owns — argv, the real streams, and the exit code.
 * That split is what lets every command test call `run()` directly with
 * captured streams and a fake `DataSource`, with no subprocess and no network.
 *
 * `process.exitCode` is set rather than `process.exit()` being called, so
 * buffered stdout is flushed before the process ends. `process.exit()` on a
 * pipe truncates output, which for a command whose whole purpose is to be
 * piped into `jq` or redirected to a file would be a bug that only appears
 * under load.
 */

import { run } from '../main.ts';

const exitCode = await run({
    argv: process.argv.slice(2),
    streams: {
        out(text: string): void {
            process.stdout.write(text);
        },
        err(text: string): void {
            process.stderr.write(text);
        },
    },
});

process.exitCode = exitCode;
