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
 * ## The rule, and the hole in it
 *
 * Verbatim from `detectHarness()` (`common-test-data.js:9`), including its
 * shape:
 *
 * | filename | harness |
 * | --- | --- |
 * | `browser_*.js` | mochitest |
 * | `test_*.html` | mochitest |
 * | everything else | **xpcshell** |
 *
 * The last row is the hole and it is load-bearing. `test_*.js` is what an
 * xpcshell test is called *and* what a mochitest-plain test is called, so a
 * mochitest-plain `test_foo.js` is classified xpcshell and the file it points
 * at does not contain the test. That failure is invisible — it looks exactly
 * like a typo — which is why both consumers have a fallback: `fx-tests test`
 * says the harness was inferred in its not-found message, and `test.html`
 * retries the *other* harness's bucket at the same index
 * (`test.html:3058-3072`) before giving up.
 *
 * Reproduced rather than improved for the reason `cli/options.ts` gave when it
 * held this: the CLI and the dashboards disagreeing about which file to read
 * would be worse than the heuristic being imperfect. Changing it here would
 * change it for both at once, which is the point of it being in one place, but
 * it is still a behaviour change and not one this migration makes.
 */

/** Which harness's data files describe a test. */
export type Harness = 'xpcshell' | 'mochitest';

/**
 * The harness a test path implies.
 *
 * Never fails: an unrecognized filename is xpcshell, matching upstream. See
 * the module comment for why that default is a hole and what covers it.
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

/** The other harness — what to try when a lookup misses. */
export function otherHarness(harness: Harness): Harness {
    return harness === 'xpcshell' ? 'mochitest' : 'xpcshell';
}
