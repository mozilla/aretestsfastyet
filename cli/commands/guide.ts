/**
 * `fx-tests guide` — orientation for an agent, in one read.
 *
 * The reason this exists is that the traps in this data are not discoverable
 * from `--help`. That the errors files are per-date with no aggregate, that a
 * manifest's all-zero durations mean skipped rather than instant, that
 * `issues.json` cannot attribute a failure to a configuration, that a test's
 * overall failure rate understates a single-config perma-fail: an agent that
 * reads this first stops re-deriving them, and one that does not will
 * confidently get them wrong.
 *
 * ## Why the facts are data and the prose is not
 *
 * `CLI.md` is explicit, and it is the whole design of this file:
 *
 * > **Its factual claims should be test assertions, not prose to remember to
 * > update.** "Review it when caveats change" is the mitigation that always
 * > fails.
 *
 * So everything mechanically checkable — which command reads which file, that
 * `errors` defaults to mochitest, what each exit code means, which flags exist
 * — lives in the exported tables below rather than in a string. `test/guide.test.ts`
 * asserts each entry against the **behaviour**: it dispatches the command, reads
 * the real option specs, compares against `ExitCode`. A guide that drifts from
 * the code fails the suite rather than quietly misleading a reader.
 *
 * What stays hand-written is the part no test can check: why a trap matters,
 * and how to approach an investigation. That prose is the reason to have a
 * guide at all — it is also the part that goes stale most slowly, because it
 * describes the shape of the data rather than the shape of the code.
 *
 * Kept well under `profiler-cli guide`'s ~400 lines, per `CLI.md`: long enough
 * to convey the traps, short enough that reading it is cheap.
 */

import { ExitCode } from '../errors.ts';
import type { OptionSpecs, ParsedArgs } from '../args.ts';
import { type CommandContext, emit } from '../context.ts';
import { usageError } from '../errors.ts';
import { toJson } from '../format/json.ts';
import { joinLines } from '../format/text.ts';

/** `guide` takes no options of its own. */
export const GUIDE_OPTIONS: OptionSpecs = {};

/**
 * What one command reads and answers.
 *
 * `reads` is the **file family**, not a filename, and it is asserted against
 * the names the command actually requests from the data source. `defaultsTo`
 * is only set where the default is surprising.
 */
export interface CommandFact {
    name: string;
    reads: string;
    answers: string;
    /** Set where the harness default is not the usual `xpcshell`. */
    defaultHarness?: string;
    /** The default row limit, where the command has one. */
    defaultLimit?: number;
}

/**
 * The per-command table.
 *
 * Every field here is checked by `test/guide.test.ts` against the running
 * code — the command is dispatched against a recording source and the file it
 * asks for is compared with `reads`, the harness it reports with
 * `defaultHarness`, the rows it emits with `defaultLimit`.
 */
export const COMMAND_FACTS: readonly CommandFact[] = [
    {
        name: 'test',
        reads: '{harness}-{bucket}.json',
        answers: 'Is this one test failing, where, since when, and where does it run at all?',
        defaultLimit: 10,
    },
    {
        name: 'try',
        reads: 'Treeherder + {harness}-{bucket}.json',
        answers: 'Which failures in my push are mine, and which already fail on central?',
    },
    {
        name: 'issues',
        reads: '{harness}-issues.json',
        answers: 'What is failing across the tree?',
        defaultLimit: 20,
    },
    {
        name: 'failures',
        reads: '{harness}-issues.json',
        answers: 'Which message is behind many failures? The one-bug-many-tests view.',
        defaultLimit: 20,
    },
    {
        name: 'crashes',
        reads: '{harness}-issues.json',
        answers: 'Which crash signatures are happening, and in how many tests?',
        defaultLimit: 20,
    },
    {
        name: 'skips',
        reads: '{harness}-issues.json',
        answers: 'What is disabled, where, and why?',
        defaultLimit: 20,
    },
    {
        name: 'errors',
        reads: '{harness}-{date}-errors.json',
        answers: 'What is loudest in the logs? Is this message ambient or specific to one test?',
        defaultHarness: 'mochitest',
        defaultLimit: 20,
    },
    {
        name: 'manifests',
        reads: 'manifests.json',
        answers: 'Which manifest is eating a job’s time budget, and on which configs?',
        defaultLimit: 10,
    },
    {
        name: 'crash',
        reads: 'a task’s minidump-stackwalk artifact',
        answers: 'What crashed or deadlocked, and where?',
    },
    {
        name: 'summary',
        reads: '{harness}-stats.json',
        answers: 'The 7-day topline rates, against the prior period.',
    },
    {
        name: 'dates',
        reads: 'index.json',
        answers: 'Which dates have published data?',
    },
    {
        name: 'cache',
        reads: 'the local cache',
        answers: 'What is cached, and how much space is it using?',
    },
];

/** One exit code and what it means. Asserted against `ExitCode`. */
export interface ExitCodeFact {
    code: number;
    meaning: string;
}

/**
 * The exit-code table.
 *
 * A contract a script branches on, so the numbers are pinned against
 * `cli/errors.ts` rather than retyped. The 3/4 split is the one with real
 * consequences and the only one with a producer worth naming.
 */
export const EXIT_CODE_FACTS: readonly ExitCodeFact[] = [
    { code: ExitCode.Success, meaning: 'Success.' },
    { code: ExitCode.Usage, meaning: 'Usage error: a bad flag, a missing argument, or a flag this file cannot answer.' },
    { code: ExitCode.NotFound, meaning: 'Not found: no such test, no data for that date or revision.' },
    {
        code: ExitCode.Upstream,
        meaning: 'Upstream temporarily unavailable — network, 5xx, a 403. Retrying may work.',
    },
    {
        code: ExitCode.Gone,
        meaning:
            'Data permanently gone: an expired or never-uploaded Taskcluster artifact. ' +
            'Only `fx-tests crash` produces this. Retrying will not help.',
    },
];

/** A trap: a claim about the data that is easy to get wrong, and its cost. */
export interface TrapFact {
    /** A short slug, so a test can name the trap it is checking. */
    id: string;
    title: string;
    /** What goes wrong if you do not know it. */
    body: string[];
}

/**
 * The traps.
 *
 * Each one is a thing that has actually been got wrong — in this repo, in
 * `FORMATS.md`'s corrections, or in a review of this CLI. The prose is
 * hand-written because "why this matters" is not checkable; the *numbers* in it
 * are measurements, and `test/guide.test.ts` checks the ones that are also
 * asserted elsewhere so the two cannot drift apart.
 */
export const TRAPS: readonly TrapFact[] = [
    {
        id: 'errors-window',
        title: 'The errors files exist for only about 5 of the 21 dates',
        body: [
            '`index.json` lists 21 dates and the index task publishes 21 daily files and 21',
            'resources files — but only about five `{harness}-{date}-errors.json`. A date being',
            'in `fx-tests dates` does **not** mean it has errors data.',
            '',
            'This is why `fx-tests errors` discovers its own window instead of trusting',
            '`index.json`, and why the "was this error here when the test was passing?" workflow —',
            'run the command for two dates and compare — only works inside those few days. Ask for',
            'a date outside them and you get exit 2 with the list of dates that do have data,',
            'rather than an empty result you might read as "no errors that day".',
        ],
    },
    {
        id: 'errors-harness',
        title: '`errors` defaults to mochitest, and the xpcshell file is a biased sample',
        body: [
            'Every other command defaults to xpcshell. `errors` does not, and the reason is not',
            'size: xpcshell runs its tests in parallel, so a test’s stdout cannot be emitted as it',
            'is produced and is replayed **only when the test fails**. The xpcshell errors file is',
            'therefore limited to failing tests’ output.',
            '',
            'That is a biased population, not a smaller sample of the same one. Ranking it answers',
            '"what do failing tests print", which is a fine question — just not "what is noisy in',
            'CI", which is what someone reading a ranking assumes. `--harness xpcshell` still works',
            'and the output says what it is.',
        ],
    },
    {
        id: 'manifest-zero-durations',
        title: 'All-zero manifest durations mean skipped, not instant',
        body: [
            'A manifest whose durations are **all zero** on a configuration was skipped there. It',
            'did not run in no time. Measured on one day: 71,272 of 433,836 runs recorded a zero',
            'duration, about a sixth of the file.',
            '',
            'Read them as real durations and every skipped config becomes the fastest one in the',
            'table, which exactly inverts the answer to "which config is worst". `fx-tests',
            'manifests` reports such a pair with no statistics at all rather than zeros, sorts it',
            'last, and lists it under "Skipped on".',
            '',
            'The rule is `every`, not `any`: a config with some zero and some non-zero durations',
            'ran, and those zeros are runs that finished under the timer’s resolution.',
        ],
    },
    {
        id: 'issues-attribution',
        title: '`issues.json` cannot tell you which configuration failed',
        body: [
            'The tree-wide file is small — a couple of megabytes — because it discarded all',
            'attribution: no task IDs, no job names, no minidump IDs. So "which config?" and',
            '"which dump?" have no answer there, and that is different from the answer being',
            '"none".',
            '',
            '`issues`, `failures`, `crashes` and `skips` therefore **refuse** `--config` and',
            '`--minidumps` rather than returning an empty table, because a filter that silently',
            'matches nothing looks exactly like a clean tree. For per-config detail, use',
            '`fx-tests test <path>`, which reads a bucket file and does have it.',
        ],
    },
    {
        id: 'perma-fail-rate',
        title: 'An overall failure rate hides a single-config perma-fail',
        body: [
            'A test that fails **every time** on one platform and passes everywhere else still',
            'reads as a couple of percent overall, because the rate divides failures from every',
            'config by runs from every config.',
            '',
            'That is why `fx-tests test` leads with a per-config table and a verdict rather than a',
            'single number, and why "0.4% failure rate" is not evidence that a test is healthy.',
        ],
    },
    {
        id: 'run-if',
        title: '`run-if` is not a disabled test, and the two file families disagree',
        body: [
            'A `skip-if` means the test should run here and is turned off — usually work someone',
            'owes. A `run-if` means the test is scoped to another platform, so it not running here',
            'is the annotation working.',
            '',
            'The asymmetry is the trap: the 21-day aggregates **already dropped** `run-if` skips',
            'upstream, while the daily files keep them — on one measured day they were 63.6% of all',
            'skipped runs. So the same question gets an answer 2.7× larger depending on which file',
            'it was asked of, and a skip count from one family must not be compared with one from',
            'the other.',
        ],
    },
    {
        id: 'never-sum-families',
        title: 'Never add totals from two file families together',
        body: [
            '`{harness}-issues.json`, `{harness}-issues-with-taskids.json` and the 64 bucket files',
            'are three encodings of the *same* 21 days, with byte-identical per-status totals.',
            'Summing them multiplies the population by the number of ways it was encoded — a',
            'previous revision of this project’s own format notes quoted a figure about 4× too',
            'large by doing exactly that.',
            '',
            'The daily files are a fourth encoding and are **not** interchangeable with the',
            'aggregates either: besides the `run-if` difference above, the two disagree on which',
            'jobs ran at all.',
        ],
    },
    {
        id: 'weekend-volume',
        title: 'Weekend counts are a fraction of weekday counts',
        body: [
            'Push volume drops several-fold at weekends: 103.2M markers on one Thursday against',
            '39.1M on the following Sunday, a factor of 2.6. Any absolute count from a Saturday or',
            'Sunday is not comparable with one from a weekday.',
            '',
            'Every command prints the weekday next to a date for this reason. When comparing two',
            'days, compare like with like, and prefer rates to counts.',
        ],
    },
    {
        id: 'hang-not-type',
        title: 'A hang is not distinguishable from a crash by its crash type',
        body: [
            'A minidump is also how a hung process is diagnosed, and `crash_info.type` will not',
            'tell you which you have: a real hang reports `EXC_SOFTWARE / SIGABRT`, exactly as an',
            'ordinary abort does. The evidence is breakpad’s own frames sitting on top of a thread',
            'that was otherwise waiting.',
            '',
            '`fx-tests crash` says when it sees that shape, and leaves the view to you rather than',
            'switching automatically. For a hang use `--all-threads`, which drops to 8 frames per',
            'thread: a deadlock is diagnosed by breadth across threads, not depth in one.',
        ],
    },
    {
        id: 'profiles-not-derivable',
        title: 'A per-test profile URL cannot be guessed',
        body: [
            'Two kinds of profile, with different availability. The **resource-usage** profile is',
            'one per job at a fixed path, derivable from the task ID alone — that is the one that',
            'shows whether a timeout was the test being slow or the machine saturated.',
            '',
            'The **per-test failure profile** is uploaded only when a test fails, and its filename',
            'is not derivable: it appears in the failure message as "profile uploaded in',
            'profile_<name>.json" and nowhere else. Where no profile was named, no URL is emitted —',
            'the CLI does not guess a filename, and neither should you.',
        ],
    },
];

/** A worked investigation. Prose by design: none of it is checkable. */
interface Workflow {
    title: string;
    steps: string[];
}

const WORKFLOWS: readonly Workflow[] = [
    {
        title: 'A test failed on my Try push',
        steps: [
            'fx-tests try <revision> --perma-only',
            '    Perma-fails are the ones that fail in every run on a config *and* were not',
            '    failing on central. Those are almost certainly yours. Everything else needs',
            '    the comparison below before you believe it.',
            '',
            'fx-tests test <path>',
            '    The verdict line answers "is this mine". Note whether it passed when the',
            '    harness reran it in the same job — that alone is often the whole answer — and',
            '    whether it fails only in parallel, which points at a race with its neighbours',
            '    rather than at the test.',
            '',
            'fx-tests test <path> --coverage',
            '    Before concluding a platform is unaffected, check the test runs there at all.',
            '    The default view lists only failing configs, so "no Android row" and "passes on',
            '    Android" look identical without this.',
        ],
    },
    {
        title: 'A job is timing out',
        steps: [
            'fx-tests manifests --job <config> --sort median',
            '    Narrows it to a manifest. Remember the all-zero rule: a manifest with no',
            '    duration shown did not run on that config.',
            '',
            'fx-tests test <path> --durations',
            '    The manifest view cannot say whether a slow manifest is one slow test or a',
            '    thousand cheap ones — it has no per-test durations. This is where that is',
            '    answered, for the tests in the manifest you found.',
            '',
            'fx-tests test <path> --profiles',
            '    The resource-usage profile distinguishes "the test is slow" from "the machine',
            '    was saturated". Feed the raw URL to profiler-cli.',
        ],
    },
    {
        title: 'Reduce CI log noise',
        steps: [
            'fx-tests errors --limit 20',
            '    Mochitest on the most recent day with data. A handful of messages account for',
            '    most of the volume, so the top of this list is most of the work.',
            '',
            '    Read the `tests` column, not just the count. A message in thousands of tests is',
            '    ambient — fixing it is a broad win but tells you nothing about any one test. A',
            '    message in one test is specific, and is a candidate cause for that test.',
            '',
            'fx-tests errors --message "<text>" --limit 3',
            '    Narrows to one message and lists the tests emitting it, so you can tell which',
            '    of the two you have.',
            '',
            'fx-tests errors --day <a> ... then --day <b>',
            '    A single day’s file has no day axis and cannot say whether an error was present',
            '    when a test was passing. Comparing two days is how that is answered — both',
            '    weekdays, and both inside the errors window.',
        ],
    },
    {
        title: 'A test is crashing',
        steps: [
            'fx-tests test <path>',
            '    Confirms it crashes and on which configs, and prints the signatures.',
            '',
            'fx-tests test <path> --task-ids',
            '    Gets you a task ID and, where the dump was uploaded, a minidump ID. Not every',
            '    crash has one: a dump that was never uploaded still counts as a crash.',
            '',
            'fx-tests crash <taskId> <minidumpId>',
            '    The symbolized report: signature, crash reason, faulting address, and the',
            '    crashing thread. If the address is flagged as a null pointer with an offset,',
            '    that offset is the field being dereferenced.',
            '',
            '    Exit 4 means the artifact is gone for good — Taskcluster expires them — and',
            '    retrying will not help. Exit 3 means try again.',
        ],
    },
];

/** Runs the command. */
export function runGuide(context: CommandContext, args: ParsedArgs): Promise<void> {
    if (args.positionals.length > 0) {
        throw usageError(
            `guide takes no arguments, got "${args.positionals[0]}"`,
            'Run `fx-tests guide` and read all of it.'
        );
    }
    if (context.globals.format === 'json') {
        // The tables, so a tool can consume the same facts the prose states.
        emit(
            context,
            toJson({
                commands: COMMAND_FACTS,
                exitCodes: EXIT_CODE_FACTS,
                traps: TRAPS.map((trap) => ({ id: trap.id, title: trap.title })),
            })
        );
        return Promise.resolve();
    }
    emit(context, render());
    return Promise.resolve();
}

/** The whole guide. */
export function render(): string {
    const lines: (string | null)[] = [];

    lines.push('fx-tests — what this data can and cannot tell you');
    lines.push('');
    lines.push('Read this once before using the other commands. The traps below are not');
    lines.push('discoverable from --help, and every one of them has been got wrong in practice.');
    lines.push('');
    lines.push('Everything is read-only. There is no writing to CI, Bugzilla or Treeherder.');

    lines.push('');
    lines.push('THE COMMANDS');
    lines.push('');
    const width = Math.max(...COMMAND_FACTS.map((fact) => fact.name.length));
    for (const fact of COMMAND_FACTS) {
        lines.push(`  ${fact.name.padEnd(width)}  ${fact.answers}`);
        lines.push(`  ${' '.repeat(width)}  reads ${fact.reads}`);
        if (fact.defaultHarness !== undefined) {
            lines.push(
                `  ${' '.repeat(width)}  defaults to --harness ${fact.defaultHarness} — see the traps`
            );
        }
    }

    lines.push('');
    lines.push('THE WINDOW');
    lines.push('');
    lines.push('The index publishes a rolling 21 days. Older data is not fetchable today: it');
    lines.push('still exists in Taskcluster for about a year, but reaching it means resolving');
    lines.push('historical index tasks, which nothing does yet. A date outside the window is');
    lines.push('exit 2, naming the window.');
    lines.push('');
    lines.push('Inside the window, --day and --since are filters on the file a command already');
    lines.push('reads, not a reason to fetch a different one. They cost nothing extra.');
    lines.push('');
    lines.push('`errors` and `manifests` are the exceptions, and both for the same underlying');
    lines.push('reason — they are per-date files rather than aggregates. See the traps.');

    lines.push('');
    lines.push('TRAPS');
    for (const trap of TRAPS) {
        lines.push('');
        lines.push(`  ${trap.title}`);
        for (const line of trap.body) {
            lines.push(line === '' ? '' : `    ${line}`);
        }
    }

    lines.push('');
    lines.push('WORKED INVESTIGATIONS');
    for (const workflow of WORKFLOWS) {
        lines.push('');
        lines.push(`  ${workflow.title}`);
        for (const step of workflow.steps) {
            lines.push(step === '' ? '' : `    ${step}`);
        }
    }

    lines.push('');
    lines.push('EXIT CODES');
    lines.push('');
    for (const fact of EXIT_CODE_FACTS) {
        lines.push(`  ${fact.code}  ${fact.meaning}`);
    }
    lines.push('');
    lines.push('  The 3/4 split exists so a script can tell "try again in a minute" from "this');
    lines.push('  dump is never coming back". `fx-tests try` exits 0 whether or not it found');
    lines.push('  failures: the failures are the answer, not an error.');

    lines.push('');
    lines.push('OUTPUT');
    lines.push('');
    lines.push('  --json for a stable shape, --markdown for pasting into a bug. Only the');
    lines.push('  requested data goes to stdout; progress and warnings go to stderr, so');
    lines.push('  redirecting and piping both behave.');
    lines.push('');
    lines.push('  Commands default to a small number of rows and say what they truncated');
    lines.push('  (`… 47 more (--limit 0 for all)`). If a list looks short, check for that line');
    lines.push('  before concluding it is complete.');

    return joinLines(lines);
}
