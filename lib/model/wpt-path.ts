/**
 * The paths of web-platform-tests, as mozilla-central's `testing/timings` writes
 * them: wptrunner's URL, `/close-watcher/basic.html?dialog`, becomes a repository
 * path that keeps the variant, `testing/web-platform/tests/…/basic.html?dialog`.
 */

/** Where the upstream tests are, and where `/` of the wpt server points. */
export const WPT_TESTS_ROOT = 'testing/web-platform/tests';

/** Where Mozilla's own tests are, served under `/_mozilla/`. */
export const WPT_MOZILLA_TESTS_ROOT = 'testing/web-platform/mozilla/tests';

export const WPT_ROOT = 'testing/web-platform/';

const MOZILLA_URL_PREFIX = '/_mozilla/';

export function isWptPath(path: string): boolean {
    return path.startsWith(WPT_ROOT);
}

/** "/dom/a.html?x" -> "testing/web-platform/tests/dom/a.html?x", or `null`. */
export function wptRepoPath(id: string): string | null {
    // The ids of the other harnesses never start with `/`.
    if (!id.startsWith('/')) {
        return null;
    }
    if (id.startsWith(MOZILLA_URL_PREFIX)) {
        return `${WPT_MOZILLA_TESTS_ROOT}/${id.slice(MOZILLA_URL_PREFIX.length)}`;
    }
    return `${WPT_TESTS_ROOT}${id}`;
}

/** "a/b.html?c#d" -> "a/b.html" */
export function stripWptVariant(path: string): string {
    const variantStart = path.search(/[?#]/);
    return variantStart === -1 ? path : path.slice(0, variantStart);
}

/** A wpt path splits before its variant, which can contain a `/`: `a.html?u=/b.html`. */
export function splitTestPath(path: string): { directory: string; name: string } {
    const end = isWptPath(path) ? stripWptVariant(path).length : path.length;
    const slash = path.lastIndexOf('/', end);
    return slash === -1
        ? { directory: '', name: path }
        : { directory: path.slice(0, slash), name: path.slice(slash + 1) };
}

/** A test, not a directory: a wpt test can have any extension (`.svg`, `.py`…). */
export function isWptTestPath(path: string): boolean {
    if (!isWptPath(path)) {
        return false;
    }
    const fileName = stripWptVariant(path).split('/').pop() ?? '';
    return /\.[A-Za-z0-9]+$/.test(fileName);
}

/**
 * The source file of a wpt test ("foo.any.worker.html?x" -> "foo.any.js"), as in
 * testing/web-platform/tests/tools/manifest/sourcefile.py.
 */
export function wptSourceFile(testPath: string): string {
    return stripWptVariant(testPath)
        .replace(/\.any(?:\.[\w-]+)?\.html$/, '.any.js')
        .replace(/\.(window|worker|extension)\.html$/, '.$1.js');
}
