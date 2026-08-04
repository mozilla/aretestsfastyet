/**
 * The global options from `CLI.md`'s table, and the semantics that go with
 * them.
 *
 * Three things here are more than plumbing, and each is a trap `CLI.md` calls
 * out:
 *
 * - **`--json` with `--markdown` is a usage error**, not one silently winning.
 *   A script that passes both has a bug, and picking a winner hides it.
 * - **Harness detection is a heuristic that fails quietly**, so the inference
 *   is recorded (`inferred: true`) and the not-found message says so.
 * - **`--day` and `--since` are filters on the file the command already
 *   reads**, not a reason to fetch a different one, and they are mutually
 *   exclusive.
 */

import { type ParsedArgs, boolOption, listOption, numberOption, stringOption } from './args.ts';
import { type OptionSpecs } from './args.ts';
import { usageError } from './errors.ts';

/** Which harness's data files to read. */
export type Harness = 'xpcshell' | 'mochitest';

/** Where data is read from. */
export type DataSourceChoice = 'central' | 'try' | 'local';

/** How output is rendered. */
export type OutputFormat = 'text' | 'json' | 'markdown';

/** The globals every command shares. */
export interface GlobalOptions {
    format: OutputFormat;
    /** `undefined` means "not given" — the command infers or defaults. */
    harness: Harness | undefined;
    /** True when `--harness` was not given and the harness was inferred. */
    limit: number | undefined;
    config: string[];
    excludeConfig: string[];
    day: string | undefined;
    since: number | undefined;
    dataSource: DataSourceChoice;
    cacheDir: string | undefined;
    noCache: boolean;
    quiet: boolean;
}

/** The option specs every command accepts, from `CLI.md`'s global table. */
export const GLOBAL_OPTION_SPECS: OptionSpecs = {
    harness: {
        type: 'string',
        placeholder: '<xpcshell|mochitest>',
        describe: 'Which harness’s data to read. Inferred from the test path by default.',
    },
    json: { type: 'boolean', describe: 'Emit JSON instead of text.' },
    markdown: { type: 'boolean', describe: 'Emit Markdown, for pasting into a bug or PR.' },
    limit: { type: 'number', placeholder: '<n>', describe: 'Max rows. 0 means no limit.' },
    config: {
        type: 'list',
        placeholder: '<list>',
        describe: 'Comma-separated job-name substrings to include.',
    },
    'exclude-config': {
        type: 'list',
        placeholder: '<list>',
        describe: 'Comma-separated substrings to exclude, applied after --config.',
    },
    day: {
        type: 'string',
        placeholder: '<date>',
        describe: 'Restrict to one day (YYYY-MM-DD, today, yesterday).',
    },
    since: {
        type: 'number',
        placeholder: '<n>',
        describe: 'Restrict to the last n days of the window.',
    },
    'data-source': {
        type: 'string',
        placeholder: '<central|try|local>',
        describe: 'Where to read data from. Default central.',
    },
    'cache-dir': {
        type: 'string',
        placeholder: '<path>',
        describe: 'On-disk cache directory. Default ~/.cache/fx-tests.',
    },
    'no-cache': { type: 'boolean', describe: 'Ignore and do not write the cache.' },
    quiet: { type: 'boolean', describe: 'Suppress progress output on stderr.' },
    help: { type: 'boolean', describe: 'Show this help.' },
};

/**
 * Reads the globals out of parsed arguments, validating the combinations.
 *
 * Every rejection here is a usage error, and every one of them is a case where
 * carrying on would produce output that looks right.
 */
export function readGlobalOptions(args: ParsedArgs): GlobalOptions {
    const wantsJson = boolOption(args, 'json');
    const wantsMarkdown = boolOption(args, 'markdown');
    if (wantsJson && wantsMarkdown) {
        throw usageError(
            '--json and --markdown are mutually exclusive',
            'Pick one: --json for a stable machine-readable shape, --markdown for pasting into a bug.'
        );
    }

    const harnessValue = stringOption(args, 'harness');
    if (harnessValue !== undefined && harnessValue !== 'xpcshell' && harnessValue !== 'mochitest') {
        throw usageError(
            `--harness expects xpcshell or mochitest, got "${harnessValue}"`
        );
    }

    const day = stringOption(args, 'day');
    const since = numberOption(args, 'since');
    if (day !== undefined && since !== undefined) {
        throw usageError(
            '--day and --since are mutually exclusive',
            '--day restricts to one day; --since restricts to the last n days.'
        );
    }
    if (since !== undefined && since < 1) {
        throw usageError(`--since expects at least 1 day, got ${since}`);
    }

    const dataSourceValue = stringOption(args, 'data-source') ?? 'central';
    if (
        dataSourceValue !== 'central' &&
        dataSourceValue !== 'try' &&
        dataSourceValue !== 'local'
    ) {
        throw usageError(
            `--data-source expects central, try or local, got "${dataSourceValue}"`
        );
    }

    return {
        format: wantsJson ? 'json' : wantsMarkdown ? 'markdown' : 'text',
        harness: harnessValue,
        limit: numberOption(args, 'limit'),
        config: listOption(args, 'config'),
        excludeConfig: listOption(args, 'exclude-config'),
        day,
        since,
        dataSource: dataSourceValue,
        cacheDir: stringOption(args, 'cache-dir'),
        noCache: boolOption(args, 'no-cache'),
        quiet: boolOption(args, 'quiet'),
    };
}

/**
 * The harness a test path implies, and whether it was inferred.
 *
 * Reuses `detectHarness()`'s rules verbatim (`common-test-data.js:9`) rather
 * than improving on them, because the CLI and the dashboards disagreeing about
 * which file to read would be worse than the heuristic being imperfect.
 *
 * The rules, and the hole in them: `browser_*.js` and `test_*.html` are
 * mochitest, **everything else is xpcshell** — including `test_*.js`, which a
 * mochitest-plain test is also called. That misclassification is invisible: the
 * CLI reads xpcshell data, finds no such test, and reports the same thing it
 * would for a typo. `harnessMissHint()` is what turns that dead end into a next
 * step, and `inferred` is what tells a command to use it.
 */
export function detectHarness(testPath: string): Harness {
    const fileName = testPath.split('/').pop() ?? testPath;
    if (fileName.startsWith('browser_') && fileName.endsWith('.js')) {
        return 'mochitest';
    }
    if (fileName.startsWith('test_') && fileName.endsWith('.html')) {
        return 'mochitest';
    }
    return 'xpcshell';
}

/** The harness to use for a path, honouring an explicit `--harness`. */
export function resolveHarness(
    testPath: string,
    explicit: Harness | undefined
): { harness: Harness; inferred: boolean } {
    if (explicit !== undefined) {
        return { harness: explicit, inferred: false };
    }
    return { harness: detectHarness(testPath), inferred: true };
}

/**
 * The message a lookup miss produces, with the inference made explicit.
 *
 * `CLI.md` gives the wording, and the reason for it: the symptom of a
 * misclassified `test_foo.js` is indistinguishable from a typo, so the message
 * has to name the harness it searched and offer the other one. Only when the
 * harness was *inferred* — if the user asked for xpcshell explicitly, telling
 * them the harness was inferred would be a lie.
 */
export function harnessMissHint(harness: Harness, inferred: boolean): string | undefined {
    if (!inferred) {
        return undefined;
    }
    const other: Harness = harness === 'xpcshell' ? 'mochitest' : 'xpcshell';
    const article = other === 'xpcshell' ? 'an' : 'a';
    return `If this is ${article} ${other} test, retry with --harness ${other}.`;
}

/** The "No such test in X data" line, with the inference noted. */
export function harnessMissMessage(
    testPath: string,
    harness: Harness,
    inferred: boolean
): string {
    return (
        `No such test in ${harness} data` +
        (inferred ? ' (harness inferred from filename)' : '') +
        `: ${testPath}`
    );
}
