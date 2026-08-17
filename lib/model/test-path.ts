/**
 * Deriving a test path from a profile marker's test id, for both front-ends.
 *
 * A marker names the test the way the harness does: optionally prefixed
 * `<manifest>.toml:`, optionally suffixed `" (finished)"`, and sometimes not a
 * test path at all — a manifest, an xpcshell selftest name, a range marker's text.
 */

/** Why an id yielded no test path. */
export type TestPathDropReason = 'no-id' | 'not-a-test-path';

/**
 * A leading `<manifest>.toml:` / `<manifest>.ini:` prefix.
 *
 * Anchored on the manifest extension, not on the first colon: `http://host:8888/
 * x.html` and `C:/builds/x.js` otherwise lose their head and still end in a test
 * extension, so they come out corrupted rather than dropped. The manifest part
 * must allow `/`; the markers spell it as a full path.
 */
const MANIFEST_PREFIX = /^[^:]+\.(?:toml|ini):/;

/**
 * The marker id with its manifest prefix and `" (finished)"` suffix removed.
 *
 * Split from `isTestFilePath` because the front-ends differ on the filter — the
 * page keeps a crash recorded against a manifest, the CLI drops it — but must not
 * differ on the strip.
 */
export function stripManifestPrefix(id: string): string {
    return id.replace(MANIFEST_PREFIX, '').replace(/\s+\(finished\)$/, '').trim();
}

/**
 * Whether a stripped id looks like a test file the aggregates can name.
 *
 * Excludes `.xml`/`.xht` mochitests, which exist in-tree but in no bucket file:
 * admitting a path central cannot match would turn a visible drop into a silent
 * "never failed".
 */
export function isTestFilePath(path: string): boolean {
    return /\.(js|html|xhtml)$/.test(path);
}

/** The path the aggregates use, from a marker's test id, or `null`. */
export function normalizeTestPath(id: string | null | undefined): string | null {
    if (id === null || id === undefined || id === '') {
        return null;
    }
    const path = stripManifestPrefix(id);
    return isTestFilePath(path) ? path : null;
}

/** Why `normalizeTestPath` returned `null` for this id. */
export function describeTestPathDrop(id: string | null | undefined): TestPathDropReason {
    return id === null || id === undefined || id === '' ? 'no-id' : 'not-a-test-path';
}
