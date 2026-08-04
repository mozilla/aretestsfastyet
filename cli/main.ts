/**
 * Command dispatch, and the process-level concerns `bin/fx-tests.ts` needs but
 * commands must not have.
 *
 * Split from `bin/` so that `run()` is callable from a test with injected
 * streams and an injected `DataSource`, and returns an exit code rather than
 * calling `process.exit`. Every command test in this repo goes through here,
 * which is what makes the dispatch, the global-option validation and the exit
 * codes tested rather than merely present.
 */

import { GLOBAL_OPTION_SPECS, readGlobalOptions } from './options.ts';
import { type OptionSpecs, parseArgs, boolOption } from './args.ts';
import { type DiskCache, cachedSource, defaultCacheDir, diskCache } from './cache.ts';
import type { CommandContext, OutputStreams } from './context.ts';
import { CliError, ExitCode, type ExitCodeValue, usageError } from './errors.ts';
import { CACHE_OPTIONS, runCache } from './commands/cache.ts';
import { CRASH_OPTIONS, runCrash } from './commands/crash.ts';
import { runDates } from './commands/dates.ts';
import { ERRORS_OPTIONS, runErrors } from './commands/errors.ts';
import {
    CRASHES_OPTIONS,
    FAILURES_OPTIONS,
    ISSUES_OPTIONS,
    SKIPS_OPTIONS,
    runCrashes,
    runFailures,
    runIssues,
    runSkips,
} from './commands/issues.ts';
import { MANIFESTS_OPTIONS, runManifests } from './commands/manifests.ts';
import { SUMMARY_OPTIONS, runSummary } from './commands/summary.ts';
import { TEST_OPTIONS, runTest } from './commands/test.ts';
import { TRY_OPTIONS, runTry } from './commands/try.ts';
import {
    DataFetchError,
    DataFileNotFoundError,
    type DataSource,
} from '../lib/sources/source.ts';
import { httpSource, taskArtifactSource } from '../lib/sources/http.ts';
import { PushNotFoundError, TreeherderError, treeherderClient } from '../lib/sources/treeherder.ts';

/** One command's registration. */
interface CommandSpec {
    name: string;
    summary: string;
    usage: string;
    options: OptionSpecs;
    run(context: CommandContext, args: ReturnType<typeof parseArgs>): Promise<void>;
}

/** Commands implemented in step 4. Step 5 adds the rest. */
const COMMANDS: CommandSpec[] = [
    {
        name: 'test',
        summary: 'Everything about one test: is it failing, where, and since when.',
        usage: 'fx-tests test <path> [options]',
        options: TEST_OPTIONS,
        run: runTest,
    },
    {
        name: 'try',
        summary: 'Triage a Try push: which failures are caused by the patch.',
        usage: 'fx-tests try <revision> [options]',
        options: TRY_OPTIONS,
        run: runTry,
    },
    {
        name: 'issues',
        summary: 'What is failing right now, across the tree.',
        usage: 'fx-tests issues [options]',
        options: ISSUES_OPTIONS,
        run: runIssues,
    },
    {
        name: 'failures',
        summary: 'Failing runs grouped by message — the one-bug-many-tests view.',
        usage: 'fx-tests failures [options]',
        options: FAILURES_OPTIONS,
        run: runFailures,
    },
    {
        name: 'crashes',
        summary: 'Crashes grouped by signature, with the minidumps to read them.',
        usage: 'fx-tests crashes [options]',
        options: CRASHES_OPTIONS,
        run: runCrashes,
    },
    {
        name: 'skips',
        summary: 'What is disabled and where. Excludes run-if by default.',
        usage: 'fx-tests skips [options]',
        options: SKIPS_OPTIONS,
        run: runSkips,
    },
    {
        name: 'errors',
        summary: 'What is loudest in the test logs on one day. Defaults to mochitest.',
        usage: 'fx-tests errors [options]',
        options: ERRORS_OPTIONS,
        run: runErrors,
    },
    {
        name: 'manifests',
        summary: 'Which manifest is eating a job’s time budget, and on which configs.',
        usage: 'fx-tests manifests [name] [options]',
        options: MANIFESTS_OPTIONS,
        run: runManifests,
    },
    {
        name: 'crash',
        summary: 'Read a processed crash or hang dump: signature, reason, thread stacks.',
        usage: 'fx-tests crash <taskId>[.<retryId>] <minidumpId> [options]',
        options: CRASH_OPTIONS,
        run: runCrash,
    },
    {
        name: 'summary',
        summary: 'The 7-day topline rates, per harness, against the prior period.',
        usage: 'fx-tests summary [options]',
        options: SUMMARY_OPTIONS,
        run: runSummary,
    },
    {
        name: 'dates',
        summary: 'Which dates have published data.',
        usage: 'fx-tests dates [options]',
        options: {},
        run: runDates,
    },
    {
        name: 'cache',
        summary: 'Inspect or clear the on-disk cache.',
        usage: 'fx-tests cache [--clear] [--size]',
        options: CACHE_OPTIONS,
        // Bound in `run()`, which is where the cache is constructed.
        run: async () => {
            throw new Error('cache is dispatched separately');
        },
    },
];

/**
 * Commands `CLI.md` specifies that step 5 will add.
 *
 * Exported so a test can assert the *behaviour* — a documented but unlanded
 * command says so rather than "unknown command" — without naming a specific
 * one. A test pinned to a name fails the day someone implements it, which is
 * the wrong signal entirely; this list shrank twice while step 4 was being
 * reviewed.
 */
export const PLANNED_COMMANDS: Record<string, string> = {
    guide: 'orientation for an agent',
};

/** What `run()` needs from its caller. */
export interface RunOptions {
    argv: readonly string[];
    streams: OutputStreams;
    /**
     * Overrides the data source. Tests pass a `memorySource`; the real CLI
     * leaves it undefined and gets an HTTP source wrapped in the disk cache.
     */
    source?: DataSource | undefined;
    /** Overrides the cache, for tests and for `--cache-dir`. */
    cache?: DiskCache | undefined;
    /** Overrides Treeherder, for `fx-tests try` tests. */
    treeherder?: CommandContext['treeherder'];
    /** Overrides per-URL artifact fetching, for `fx-tests try` tests. */
    fetchUrl?: CommandContext['fetchUrl'];
    /** Overrides the per-task artifact source, for `fx-tests crash` tests. */
    taskArtifacts?: CommandContext['taskArtifacts'];
    /**
     * Test-only: overrides how `fx-tests test` loads a timing file.
     *
     * See `LoadedTimingFile` in `cli/context.ts`. Production leaves it unset.
     */
    loadTimingFile?: CommandContext['loadTimingFile'];
    /** The version reported by `--version`. */
    version?: string | undefined;
}

/** The package version, as `--version` reports it. */
export const VERSION = '0.0.0';

/**
 * Runs one invocation and returns its exit code.
 *
 * Never throws for an expected failure: a `CliError` becomes a message on
 * stderr and its code. An unexpected error is re-thrown with its stack, since
 * that is a bug and a stack is what a bug report needs.
 */
export async function run(options: RunOptions): Promise<ExitCodeValue> {
    const { streams } = options;
    try {
        return await dispatch(options);
    } catch (error) {
        if (error instanceof CliError) {
            streams.err(`fx-tests: ${error.message}\n`);
            if (error.hint !== undefined) {
                streams.err(`${error.hint}\n`);
            }
            return error.exitCode;
        }
        // The library's error types carry the same distinction `CLI.md`'s exit
        // codes do, so they are mapped here rather than caught in every
        // command. A 404 on an index file is data that was never published
        // (exit 2); a transport failure or a 5xx is "try again" (exit 3).
        if (error instanceof DataFileNotFoundError) {
            streams.err(`fx-tests: ${error.message}\n`);
            return ExitCode.NotFound;
        }
        if (error instanceof DataFetchError) {
            streams.err(`fx-tests: ${error.message}\n`);
            return ExitCode.Upstream;
        }
        if (error instanceof PushNotFoundError) {
            streams.err(`fx-tests: ${error.message}\n`);
            return ExitCode.NotFound;
        }
        if (error instanceof TreeherderError) {
            streams.err(`fx-tests: ${error.message}\n`);
            return ExitCode.Upstream;
        }
        throw error;
    }
}

/** Parses, builds the context, and hands off to a command. */
async function dispatch(options: RunOptions): Promise<ExitCodeValue> {
    const argv = [...options.argv];
    const { streams } = options;

    // `--version` and a bare `--help` are answered before a command is
    // required, because both are reasonable things to ask with no command.
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
        streams.out(topLevelHelp());
        return ExitCode.Success;
    }
    if (argv[0] === '--version' || argv[0] === '-v') {
        streams.out(`${options.version ?? VERSION}\n`);
        return ExitCode.Success;
    }

    const commandName = argv[0]!;
    if (commandName.startsWith('-')) {
        throw usageError(
            `expected a command, got the option ${commandName}`,
            'Usage: fx-tests <command> [options]. Run --help for the list.'
        );
    }

    const command = COMMANDS.find((candidate) => candidate.name === commandName);
    if (command === undefined) {
        const planned = PLANNED_COMMANDS[commandName];
        if (planned !== undefined) {
            // A command `CLI.md` documents but that is not built yet gets its
            // own message. "Unknown command" would be wrong — the user read
            // the spec correctly — and would send them looking for a typo.
            throw usageError(
                `\`${commandName}\` (${planned}) is specified in docs/CLI.md but not implemented yet`,
                'Implemented so far: ' + COMMANDS.map((c) => c.name).join(', ') + '.'
            );
        }
        throw usageError(
            `unknown command "${commandName}"`,
            'Available: ' + COMMANDS.map((c) => c.name).join(', ') + '. Run --help for details.'
        );
    }

    const specs: OptionSpecs = { ...GLOBAL_OPTION_SPECS, ...command.options };
    const args = parseArgs(argv.slice(1), specs);

    if (boolOption(args, 'help')) {
        streams.out(commandHelp(command, specs));
        return ExitCode.Success;
    }

    const globals = readGlobalOptions(args);

    if (globals.dataSource === 'local' && options.source === undefined) {
        // Deliberately refused rather than silently reading `./data/`: the
        // dashboards' `?data-source=local` reads files served next to the
        // page, which has no CLI equivalent, and guessing a directory would
        // read someone else's data without saying so.
        throw usageError(
            '--data-source local is not supported by the CLI',
            'The dashboards read ./data/ relative to the page. Use --data-source central or try.'
        );
    }

    const cache =
        options.cache ??
        diskCache(
            globals.cacheDir === undefined ? {} : { directory: globals.cacheDir }
        );

    const context: CommandContext = {
        globals,
        streams,
        source: options.source ?? buildSource(globals, cache, streams),
        ...(options.treeherder === undefined
            ? { treeherder: treeherderClient({ fetch: nodeFetch }) }
            : { treeherder: options.treeherder }),
        ...(options.fetchUrl === undefined
            ? { fetchUrl: nodeFetchBytes }
            : { fetchUrl: options.fetchUrl }),
        // Per-task artifacts are their own source, deliberately not the disk
        // cache's: `PLAN.md` §4 calls this a new dependency shape, and its
        // failure modes differ — an expired artifact is exit 4 while a missing
        // index file is exit 2. Injected so `fx-tests crash` is testable
        // without a network.
        ...(options.taskArtifacts === undefined
            ? { taskArtifacts: taskArtifactSource({ fetch: nodeFetch }) }
            : { taskArtifacts: options.taskArtifacts }),
        ...(options.loadTimingFile === undefined
            ? {}
            : { loadTimingFile: options.loadTimingFile }),
    };

    if (command.name === 'cache') {
        await runCache(context, args, cache);
        return ExitCode.Success;
    }

    await command.run(context, args);
    return ExitCode.Success;
}

/** The real data source: HTTP, wrapped in the disk cache unless `--no-cache`. */
function buildSource(
    globals: ReturnType<typeof readGlobalOptions>,
    cache: DiskCache,
    streams: OutputStreams
): DataSource {
    const http = httpSource({
        fetch: nodeFetch,
        repository: globals.dataSource === 'try' ? 'try' : 'mozilla-central',
    });
    if (globals.noCache) {
        return http;
    }
    return cachedSource(http, cache, {
        onMiss: globals.quiet
            ? undefined
            : (name) => streams.err(`Fetching ${name.filename}…\n`),
        onWarning: (message) => streams.err(`warning: ${message}\n`),
    });
}

/** Node's `fetch`, narrowed to the `FetchLike` the library takes. */
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

/** Fetches a URL's bytes, or `null` on 404. For `fx-tests try`'s profiles. */
async function nodeFetchBytes(url: string): Promise<Uint8Array | null> {
    const response = await fetch(url);
    if (!response.ok) {
        return null;
    }
    return new Uint8Array(await response.arrayBuffer());
}

/** The top-level `--help` text. */
export function topLevelHelp(): string {
    const width = Math.max(...COMMANDS.map((c) => c.name.length));
    const lines = [
        'fx-tests — command-line access to the Firefox test-health data',
        '',
        'Usage: fx-tests <command> [options]',
        '',
        'Commands:',
        ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
        '',
        'Planned (docs/CLI.md, not implemented yet):',
        `  ${Object.keys(PLANNED_COMMANDS).join(', ')}`,
        '',
        'Run `fx-tests <command> --help` for a command’s options.',
        'Global options are documented in docs/CLI.md.',
        '',
    ];
    return lines.join('\n');
}

/** One command's `--help` text. */
function commandHelp(command: CommandSpec, specs: OptionSpecs): string {
    const names = Object.entries(specs).map(([name, spec]) => {
        const placeholder = spec.placeholder === undefined ? '' : ` ${spec.placeholder}`;
        return { flag: `--${name}${placeholder}`, describe: spec.describe };
    });
    const width = Math.max(...names.map((entry) => entry.flag.length));
    return [
        `${command.usage}`,
        '',
        command.summary,
        '',
        'Options:',
        ...names.map((entry) => `  ${entry.flag.padEnd(width)}  ${entry.describe}`),
        '',
        `Cache: ${defaultCacheDir()}`,
        '',
    ].join('\n');
}
