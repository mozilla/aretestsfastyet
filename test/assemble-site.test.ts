/**
 * `tools/assemble-site.ts` — the step that merges the built pages, the
 * unmigrated pages and `old/` into the tree the deploy publishes.
 *
 * ## What is worth testing here, and what is not
 *
 * The page tests answer "does this page compute the right thing". Nothing
 * answered "is the file the page asks for actually in the output", and that gap
 * is where this project's most expensive defect lived: `index.html` fetched a
 * committed backfill that the build never copied, the request 404'd, the page's
 * own error handling turned that into "there is no backfill", and the chart
 * silently lost six months of history. A unit test even asserted the truncated
 * result — correctly, as a test of graceful degradation. The suite was green.
 *
 * So these tests are about **arrangement**. They run the real assembly into a
 * scratch directory and then look in it, and — more importantly — they check
 * that `checkArtifact` *fails* on each way the assembly can come up short. A
 * guard that has never been seen to reject anything is not a guard.
 *
 * The negative cases matter more than the positive one. A clean run passing
 * proves the assembler works today; the breaks prove the check would notice if
 * it stopped.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { EXTRA_DATA, OLD_DIR, checkArtifact, findReferences } from '../tools/assemble-site.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * One real assembly, built once and copied per test.
 *
 * Running `npm run pages` costs a few seconds, and every negative case wants
 * the same starting point with one thing removed — so build it once and `cp -R`
 * it, rather than asserting against a hand-made directory that could drift from
 * what the build actually emits.
 */
let assembled: string;
const scratch: string[] = [];

/** A copy of the assembled tree, for a test that is about to damage it. */
function damaged(): string {
    const dir = mkdtempSync(join(tmpdir(), 'fx-site-break-'));
    scratch.push(dir);
    cpSync(assembled, dir, { recursive: true });
    return dir;
}

before(() => {
    assembled = mkdtempSync(join(tmpdir(), 'fx-site-'));
    scratch.push(assembled);
    const env = { ...process.env, FX_PAGES_BUILD_OUT: assembled, FX_SITE_OUT: assembled };
    const run = (script: string): void => {
        execFileSync(process.execPath, ['--experimental-strip-types', join(ROOT, 'tools', script)], {
            cwd: ROOT,
            env,
            stdio: 'pipe',
        });
    };
    run('build-pages.ts');
    run('assemble-site.ts');
});

after(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** `.html` files directly in a directory of the artifact. */
function pages(dir: string): string[] {
    return readdirSync(dir)
        .filter((name) => name.endsWith('.html'))
        .sort();
}

const sourcePages = (dir: string): string[] => pages(join(ROOT, dir));

// =========================================================================
// The reference scanner
// =========================================================================

describe('findReferences', () => {
    test('finds a page linked from markup, not only an asset', () => {
        // The case that makes assembly step 3 necessary from a second
        // direction: `old/index.html` links `green.html` in its own markup, so
        // `old/` needs the unmigrated pages even ignoring dashboards.js.
        const refs = findReferences('p.html', '<a href="green.html#mochitest">green</a>');
        assert.deepEqual(refs.map((r) => r.target), ['green.html']);
    });

    test('finds a sibling fetched from code, which no tag mentions', () => {
        // The backfill bug's exact shape.
        const refs = findReferences('p.html', `<script>fetch('./data.json')</script>`);
        assert.deepEqual(refs.map((r) => r.target), ['data.json']);
    });

    test('ignores what cannot be a file in the artifact', () => {
        const html = [
            '<a href="https://example.com/x.html">',
            '<a href="//cdn/x.js">',
            '<a href="/absolute.html">',
            '<a href="#anchor">',
            '<a href="?query=1">',
            '<img src="data:image/svg+xml,x">',
            '<a href="${computed}.html">',
        ].join('');
        assert.deepEqual(findReferences('p.html', html), []);
    });

    test('a query or fragment addresses state, not another file', () => {
        const refs = findReferences('p.html', '<a href="test.html?test=x#tab">');
        assert.deepEqual(refs.map((r) => r.target), ['test.html']);
    });

    test('the fetch the site is allowed to 404 is not demanded', () => {
        // No xpcshell backfill has ever existed; only mochitest lost history.
        const html = `<script>fetch('./xpcshell-stats-backfill.json')</script>`;
        assert.deepEqual(findReferences('p.html', html), []);
    });
});

// =========================================================================
// The assembled tree
// =========================================================================

describe('the assembled site', () => {
    test('the root holds every built page and every unmigrated page', () => {
        const built = sourcePages('site');
        const unmigrated = pages(ROOT);
        const root = pages(assembled);
        assert.equal(root.length, built.length + unmigrated.length);
        for (const page of [...built, ...unmigrated]) assert.ok(root.includes(page), page);
    });

    test('old/ is a complete site, not just the nine superseded pages', () => {
        // The step this deploy is most likely to get wrong: `old/` links resolve
        // inside `old/`, so a partial `old/` is a directory of 404s.
        const superseded = sourcePages(OLD_DIR);
        const unmigrated = pages(ROOT);
        const old = pages(join(assembled, OLD_DIR));
        assert.equal(old.length, superseded.length + unmigrated.length);
        for (const page of [...superseded, ...unmigrated]) assert.ok(old.includes(page), page);
    });

    test("old/'s copy of a superseded page is the old one, not the rebuilt one", () => {
        // Both trees have an `index.html` and they must not be the same file:
        // the point of `old/` is that it is the previous implementation.
        const fromOld = readFileSync(join(assembled, OLD_DIR, 'index.html'), 'utf8');
        const fromRoot = readFileSync(join(assembled, 'index.html'), 'utf8');
        assert.notEqual(fromOld, fromRoot);
        assert.equal(fromOld, readFileSync(join(ROOT, OLD_DIR, 'index.html'), 'utf8'));
    });

    test('the assets only unmigrated pages reference are present in both trees', () => {
        // `tools/build-pages.ts` copies what the *migrated* pages need, which is
        // not this set — no migrated page references either of these, so a rule
        // derived from the build's own output would miss both.
        for (const asset of ['common-test-data.js', 'favicon-screenshots.svg']) {
            for (const dir of [assembled, join(assembled, OLD_DIR)]) {
                assert.ok(readFileSync(join(dir, asset)).length > 0, `${dir}/${asset}`);
            }
        }
    });

    test('the committed backfill is in both trees', () => {
        // Its absence from one tree is invisible at runtime: the page treats a
        // 404 as "no backfill" and draws a shorter chart.
        const name = 'mochitest-stats-backfill.json';
        for (const dir of [assembled, join(assembled, OLD_DIR)]) {
            assert.ok(readFileSync(join(dir, name)).length > 0, `${dir}/${name}`);
        }
    });

    test('the markdown docs.html fetches are published', () => {
        // Fetched from a variable, so no scanner finds them and the page would
        // deploy with every document 404ing.
        for (const doc of EXTRA_DATA) {
            assert.ok(readFileSync(join(assembled, doc)).length > 0, doc);
        }
    });

    test('.nojekyll is present, so Pages does not filter the tree', () => {
        assert.equal(readFileSync(join(assembled, '.nojekyll'), 'utf8'), '');
    });

    test('every reference every page makes resolves inside the artifact', async () => {
        assert.deepEqual(await checkArtifact(ROOT, assembled), []);
    });
});

// =========================================================================
// The guard, which is only worth having if it rejects things
// =========================================================================

describe('checkArtifact rejects an incomplete artifact', () => {
    test('when old/ has only the superseded pages', async () => {
        const dir = damaged();
        const built = new Set(sourcePages('site'));
        for (const page of pages(join(dir, OLD_DIR))) {
            if (!built.has(page)) rmSync(join(dir, OLD_DIR, page));
        }
        const problems = await checkArtifact(ROOT, dir);
        assert.match(problems.join('\n'), /old\/ has \d+ pages, expected/);
    });

    test('when an asset copy silently copied nothing', async () => {
        const dir = damaged();
        rmSync(join(dir, OLD_DIR, 'common-test-data.js'));
        const problems = await checkArtifact(ROOT, dir);
        assert.match(problems.join('\n'), /references common-test-data\.js/);
    });

    test('when the committed backfill is missing from old/', async () => {
        // The regression test for the defect this whole guard exists for.
        const dir = damaged();
        rmSync(join(dir, OLD_DIR, 'mochitest-stats-backfill.json'));
        const problems = await checkArtifact(ROOT, dir);
        assert.match(problems.join('\n'), /references mochitest-stats-backfill\.json/);
    });

    test('when a markdown doc is missing', async () => {
        const dir = damaged();
        rmSync(join(dir, EXTRA_DATA[0]!));
        const problems = await checkArtifact(ROOT, dir);
        assert.match(problems.join('\n'), new RegExp(`${basename(EXTRA_DATA[0]!)} is missing`));
    });

    test('when .nojekyll was not written', async () => {
        const dir = damaged();
        rmSync(join(dir, '.nojekyll'));
        const problems = await checkArtifact(ROOT, dir);
        assert.match(problems.join('\n'), /\.nojekyll is missing/);
    });

    test('when the assembly never ran at all', async () => {
        // A directory holding only `npm run pages` output. The most complete
        // version of the failure, and it must report rather than throw.
        const dir = mkdtempSync(join(tmpdir(), 'fx-site-none-'));
        scratch.push(dir);
        writeFileSync(join(dir, 'index.html'), '<html></html>');
        const problems = await checkArtifact(ROOT, dir);
        assert.match(problems.join('\n'), /artifact root has 1 pages/);
        assert.match(problems.join('\n'), /old\/ has 0 pages/);
    });
});
