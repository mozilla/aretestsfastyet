/**
 * Hand-rolled argument parsing. No dependency, as `PLAN.md` §3 step 4 asks.
 *
 * The shape is deliberately small: a table of option specs per command, and a
 * parser that rejects anything not in it. Rejecting is the whole point — a
 * parser that ignores unknown flags turns `--covrage` into "the flag did
 * nothing", which reads exactly like "the flag is not implemented", and the
 * user has no way to tell.
 *
 * Three rules that are easy to get wrong and are tested:
 *
 * - `--flag=value` and `--flag value` both work, because both are what people
 *   type. `--flag=value` on a boolean is a usage error rather than a silently
 *   ignored value.
 * - `--no-cache` is its own boolean option, not a generic `--no-` prefix.
 *   A generic prefix would accept `--no-coverage`, which is not a thing.
 * - `--` stops option parsing, so a test path starting with a dash is
 *   reachable. Unlikely, and one line.
 */

import { usageError } from './errors.ts';

/** What kind of value an option takes. */
export type OptionType =
    /** No value: `--json`. Present means true. */
    | 'boolean'
    /** One value: `--limit 5`. */
    | 'string'
    /** One value, parsed as a non-negative integer: `--limit 5`. */
    | 'number'
    /**
     * A comma-separated list, repeatable. `--config a,b --config c` is
     * `['a', 'b', 'c']` — repeating accumulates rather than replacing, which
     * is what `CLI.md`'s "repeatable" `--type` needs and what a shell loop
     * building up a command line expects.
     */
    | 'list';

/** One option a command accepts. */
export interface OptionSpec {
    type: OptionType;
    /** Short help text, for `--help`. */
    describe: string;
    /** The placeholder shown in help for a value-taking option. */
    placeholder?: string;
}

/** The options a command accepts, by long name without the leading dashes. */
export type OptionSpecs = Record<string, OptionSpec>;

/** Parsed arguments: the positionals and the options that were present. */
export interface ParsedArgs {
    positionals: string[];
    /** Only options that actually appeared. Absent means "not given". */
    options: Map<string, boolean | string | number | string[]>;
}

/**
 * Parses `argv` against a spec.
 *
 * Throws a usage error (exit 1) for an unknown option, a missing value, a
 * value on a boolean, or a malformed number.
 */
export function parseArgs(argv: readonly string[], specs: OptionSpecs): ParsedArgs {
    const positionals: string[] = [];
    const options = new Map<string, boolean | string | number | string[]>();
    let optionsEnded = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;

        if (optionsEnded || !arg.startsWith('--')) {
            // A bare `-x` is not a thing this CLI has: every option is long.
            // Rejecting it beats treating it as a positional, because
            // `fx-tests test -c` would otherwise look for a test called `-c`.
            if (!optionsEnded && arg.startsWith('-') && arg.length > 1) {
                throw usageError(
                    `unknown option ${arg}`,
                    'All options are long form, e.g. --config. Run --help for the list.'
                );
            }
            positionals.push(arg);
            continue;
        }

        if (arg === '--') {
            optionsEnded = true;
            continue;
        }

        const equals = arg.indexOf('=');
        const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
        const inlineValue = equals === -1 ? null : arg.slice(equals + 1);

        const spec = specs[name];
        if (spec === undefined) {
            throw usageError(
                `unknown option --${name}`,
                suggestOption(name, specs) ?? 'Run --help for the list of options.'
            );
        }

        if (spec.type === 'boolean') {
            if (inlineValue !== null) {
                throw usageError(
                    `--${name} takes no value, but got --${name}=${inlineValue}`
                );
            }
            options.set(name, true);
            continue;
        }

        let value: string;
        if (inlineValue !== null) {
            value = inlineValue;
        } else {
            const next = argv[i + 1];
            // A missing value is caught here rather than by consuming the next
            // flag: `--limit --json` should complain about --limit, not
            // silently set the limit to the string "--json".
            if (next === undefined || (next.startsWith('--') && next !== '--')) {
                throw usageError(`--${name} requires a value`);
            }
            value = next;
            i++;
        }

        if (spec.type === 'number') {
            const parsed = Number(value);
            if (!Number.isInteger(parsed) || parsed < 0) {
                throw usageError(
                    `--${name} expects a non-negative integer, got "${value}"`
                );
            }
            options.set(name, parsed);
        } else if (spec.type === 'list') {
            const previous = (options.get(name) as string[] | undefined) ?? [];
            const items = value
                .split(',')
                .map((item) => item.trim())
                .filter((item) => item.length > 0);
            options.set(name, [...previous, ...items]);
        } else {
            options.set(name, value);
        }
    }

    return { positionals, options };
}

/**
 * Suggests a close option name for a typo.
 *
 * Edit distance 1 or 2, which covers a transposition, a dropped letter and a
 * doubled one — the mistakes people actually make. Beyond that a suggestion is
 * more likely to mislead than help, so there is none.
 */
export function suggestOption(name: string, specs: OptionSpecs): string | null {
    let best: string | null = null;
    let bestDistance = 3;
    for (const candidate of Object.keys(specs)) {
        const distance = editDistance(name, candidate);
        if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best === null ? null : `Did you mean --${best}?`;
}

/** Levenshtein distance, iterative with a single row. */
function editDistance(a: string, b: string): number {
    if (a === b) {
        return 0;
    }
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(
                current[j - 1]! + 1,
                previous[j]! + 1,
                previous[j - 1]! + cost
            );
        }
        previous = current;
    }
    return previous[b.length]!;
}

// --- typed accessors -----------------------------------------------------

/** A present boolean option, or false. */
export function boolOption(args: ParsedArgs, name: string): boolean {
    return args.options.get(name) === true;
}

/** A present string option, or `undefined`. */
export function stringOption(args: ParsedArgs, name: string): string | undefined {
    const value = args.options.get(name);
    return typeof value === 'string' ? value : undefined;
}

/** A present number option, or `undefined`. */
export function numberOption(args: ParsedArgs, name: string): number | undefined {
    const value = args.options.get(name);
    return typeof value === 'number' ? value : undefined;
}

/** A present list option, or an empty array. */
export function listOption(args: ParsedArgs, name: string): string[] {
    const value = args.options.get(name);
    return Array.isArray(value) ? value : [];
}
