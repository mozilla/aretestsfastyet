/**
 * Which harness ran a test, inferred from its filename.
 *
 * A data derivation with no UI in it, which is why it lives here rather than in
 * a page or a command: `site/test.ts` uses it to pick which bucket file to
 * fetch, `fx-tests test` uses it to pick which one to read, and `fx-tests try`
 * uses it to classify a failure. Three consumers of one rule.
 *
 * It was in `cli/options.ts` until `test.html` was migrated. Moving it was
 * forced rather than tidy-minded: a page cannot import `cli/options.ts`, which
 * pulls in the argument parser and the usage-error machinery, so the choice was
 * to move it or to have a fourth copy. `cli/options.ts` re-exports it so no
 * command changed.
 *
 * ## The rule
 *
 * | filename | harness |
 * | --- | --- |
 * | `*.html`, `*.xhtml` | mochitest |
 * | `browser_*.js` | mochitest |
 * | everything else | xpcshell |
 *
 * Measured over all 128 bucket files on 2026-11-15, it is right for every test
 * in the aggregates: mochitest holds `test_*.html` (11,334), `browser_*.js`
 * (9,578) and `test_*.xhtml` (768); xpcshell holds only `.js`, `test_*.js`
 * (4,953) and other names (152). So the lookups read one harness's file and
 * do not retry the other: a miss there is a test the data does not hold.
 *
 * Upstream's rule (`common-test-data.js:9`) had `test_*.html` only and sent
 * every `.xhtml` to xpcshell; the retry under the other harness that both
 * front-ends then needed is what `fx-tests try` lacked on try push
 * f26b22875bff, where four chrome `.xhtml` tests read "no central data".
 *
 * Directories have no filename and also fall to xpcshell.
 */

import { isTestFilePath } from './test-path.ts';

/** Which harness's data files describe a test. */
export type Harness = 'xpcshell' | 'mochitest';

/**
 * The harness a test path implies.
 *
 * Never fails: an unrecognized filename, or a directory, is xpcshell.
 */
export function detectHarness(testPath: string): Harness {
    const fileName = testPath.split('/').pop() ?? testPath;
    if (fileName.endsWith('.html') || fileName.endsWith('.xhtml')) {
        return 'mochitest';
    }
    if (fileName.startsWith('browser_') && fileName.endsWith('.js')) {
        return 'mochitest';
    }
    return 'xpcshell';
}

/**
 * Whether a path names a directory rather than a test file.
 *
 * `isTestFilePath` is the same test `lib/model/test-path.ts` applies to a
 * marker's id, reused rather than re-spelled: "ends in a test extension" is one
 * rule and two copies of it could disagree about `.xhtml`.
 */
export function isDirectoryPath(path: string): boolean {
    return !isTestFilePath(path);
}

/**
 * The harnesses to read, split by whether their file has to be there.
 *
 * The split is the point. `required` is the harness the caller asked about, one
 * way or another, so a missing or unreadable file for it is the error it always
 * was. A `speculative` one was added by this module's own guess, and its file
 * not being published is not something the reader did wrong — it means "no data
 * from that harness", which is a case the caller already handles.
 */
export interface HarnessesToQuery {
    required: Harness;
    speculative: Harness[];
}

/**
 * Which harnesses a tree-wide command must read for a path filter.
 *
 * `detectHarness` classifies on a **filename**, and a directory has none, so it
 * falls through to its xpcshell default. On a mochitest-only directory that made
 * `fx-tests failures --path <dir>` and `fx-tests flaky <dir>` search the wrong
 * file, come back empty, and tell the reader to look for a typo that was not
 * there — the directory really is mochitest and really does have failures.
 *
 * There is nothing in the aggregates to infer a directory's harness from: which
 * harness runs a folder is in its manifests, and the CLI has no
 * mozilla-central checkout. So the resolution is to *ask both* and let the data
 * answer — the caller prints whichever came back non-empty, or both when both
 * did, and only reports the typo when neither did.
 *
 * An explicit `--harness` is always honoured alone: the reader named the file.
 * A path naming a test **file** keeps the single xpcshell default these
 * commands already had — `fx-tests test` is the per-file view, and it resolves a
 * file across both harnesses through `lib/query/test-lookup.ts`. Only the
 * directory case widens here.
 */
export function harnessesForPathFilter(
    pathPrefix: string | undefined,
    explicit: Harness | undefined
): HarnessesToQuery {
    if (explicit !== undefined) {
        return { required: explicit, speculative: [] };
    }
    // `''` is absent, not "the tree root": `--path ''` selects every test, which
    // is what omitting `--path` already means, and the two must not differ in
    // what they download. Without this an empty string reaches `isDirectoryPath`,
    // which calls it a directory and doubles the fetch for an identical query.
    if (pathPrefix === undefined || pathPrefix === '' || !isDirectoryPath(pathPrefix)) {
        return { required: 'xpcshell', speculative: [] };
    }
    return { required: 'xpcshell', speculative: ['mochitest'] };
}

/** One aggregate a command read, for the messages that must name them all. */
export interface SearchedFile {
    harness: string;
    testCount: number;
}

/**
 * "4,911 tests in xpcshell-issues.json", or both files when both were read.
 *
 * The not-found messages exist so a reader can tell a clean tree from a mistyped
 * `--path`, and they can only do that if they name the population that was
 * actually searched. Once `harnessesForPathFilter` widens a directory query to
 * two aggregates, a message naming one of them is a false sentence — so the
 * phrase is built here, once, and every message that carries it takes the same
 * list. Four call sites across `failures` and `flaky`'s three views.
 *
 * `formatCount` is passed in rather than done here: thousands separators are a
 * presentation rule and `cli/format/text.ts` owns it, which a `lib/` module
 * cannot import. Reimplementing `toLocaleString('en-US')` here would be a second
 * copy of that rule, free to drift from the one every other number goes through.
 */
export function describeSearchedFiles(
    files: readonly SearchedFile[],
    formatCount: (value: number) => string
): string {
    return files
        .map((file) => `${formatCount(file.testCount)} tests in ${file.harness}-issues.json`)
        .join(' and ');
}
