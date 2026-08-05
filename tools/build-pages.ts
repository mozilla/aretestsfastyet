/**
 * Builds the migrated dashboard pages in `next/` into self-contained HTML.
 *
 * ## Why a build exists here at all, when the other pages have none
 *
 * The dashboards are served exactly as they appear in the tree, and that is
 * worth keeping: editing a page and reloading it is the whole loop, with no
 * toolchain between the author and the browser. The migrated pages give that
 * up for one thing only — being able to `import` the typed, tested code in
 * `lib/` instead of carrying a fourth copy of it inline.
 *
 * The unmigrated pages are untouched by this script. It reads `next/` and
 * writes `dist-pages/`; it never opens a page in the repository root, and
 * nothing it writes lands on top of one. A page is migrated exactly when its
 * source moves into `next/`, so there is no state where the same page has two
 * live definitions.
 *
 * ## Why the output is a single file with everything inlined
 *
 * A page that loads a shared `.js` alongside it can be served a stale copy of
 * one and a fresh copy of the other — the CDN caches them independently, and
 * this project has already lost time to exactly that (a deployed page throwing
 * `ReferenceError` from a cached shared script that no longer matched). Inlining
 * makes a page atomic: one request, one version, no skew possible between the
 * markup and the code it depends on.
 *
 * It also keeps the deployed artefact the same *kind* of thing as the pages it
 * sits next to — a static HTML file with its CSS and JS inside it — so the
 * migration does not change how the site is served.
 */

import { build } from 'esbuild';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(root, 'next');
// Overridable so the freshness check can build to a scratch directory, the
// same arrangement `tools/build-cli.ts` uses.
const outDir = process.env['FX_PAGES_BUILD_OUT'] ?? join(root, 'dist-pages');

/**
 * The marker a source page uses to say "the bundle goes here".
 *
 * A page writes `<script type="module" src="./main.ts"></script>` and the build
 * replaces that whole tag with an inline `<script type="module">` holding the
 * bundled result. Matching the tag rather than a bespoke comment means the
 * source page is still valid HTML that a browser can load directly — see the
 * note on the development loop at the bottom of this file.
 */
const MODULE_SCRIPT = /<script\s+type="module"\s+src="\.\/([\w.-]+\.ts)"\s*><\/script>/g;

/**
 * A page's Web Worker entry points, declared by the page's own markup.
 *
 * A page writes `<!-- worker: ./try-flakiness-worker.ts -->` and the build
 * bundles that entry separately, then makes the bundled source available to the
 * page's module as a string on `globalThis.__workers`. The page builds its
 * `Blob` from that string.
 *
 * ## Why a worker cannot simply be imported
 *
 * A `new Worker(new URL('./w.ts', import.meta.url))` would be a second request
 * for a second file, which is exactly the CDN-skew problem the single-file
 * output exists to prevent (see the note at the top of this file). So the
 * worker's code has to travel *inside* the page, as text.
 *
 * That leaves the question of where the text comes from, and the answer cannot
 * be `.toString()` on the imported functions — which is what `try.html` does
 * today (`try.html:2584`) and what forced this build change. `.toString()`
 * returns the *bundled* source of a function: esbuild has renamed its
 * identifiers, and its transitive dependencies are other renamed functions that
 * a `.toString()` of the top one does not include. The concatenated program
 * would reference names that do not exist in the worker's scope and throw
 * `ReferenceError` on the first message — silently, because the page's `catch`
 * treats a worker error as "no history for these tests".
 *
 * Giving the worker its own entry point makes esbuild's job the ordinary one:
 * it follows the imports, inlines the bodies, and emits a self-contained
 * program. `checkWorkerSelfContained` asserts that it really is.
 */
const WORKER_DIRECTIVE = /<!--\s*worker:\s*\.\/([\w.-]+\.ts)\s*-->/g;

/** The global the built page reads its worker sources off. */
const WORKER_GLOBAL = '__workers';

/**
 * Sibling assets a page pulls in with a plain tag: `shared.js`, `shared.css`,
 * the favicons, and the rest of the scripts the unmigrated pages share.
 *
 * These are *not* inlined. `shared.js` and friends are loaded by up to 22 pages
 * that are not being migrated, so they stay exactly where they are and keep
 * being served as themselves; a migrated page goes on loading them by name. The
 * duplication the migration removes is the *data* logic — `computeTestStats`,
 * `getChunkIndex` and the rest of `common-test-data.js`, which `lib/` already
 * has typed and tested — not the UI plumbing, which has no `lib/` equivalent
 * and no reason to grow one yet.
 *
 * They do have to be *reachable*, though: the built page sits in `dist-pages/`,
 * so a relative `src="shared.js"` resolves next to it and 404s unless the file
 * is copied there. crash-viewer.html did not catch this because it is entirely
 * self-contained.
 */
const SIBLING_ASSET = /(?:src|href)="(?!https?:|\/\/|\.\/|data:|#)([\w.-]+\.(?:js|css|svg|json))"/g;

interface BuiltPage {
    name: string;
    bytes: number;
    inlined: number;
    assets: string[];
    /** `name -> bundled bytes`, for the build log. */
    workers: [string, number][];
}

/**
 * Bundles one TypeScript entry point into a single string of browser JS.
 *
 * `format: 'esm'` and no `platform: 'node'`: these run in a browser, so a
 * `lib/` module that reached for a node builtin must fail the build here rather
 * than at page load. Nothing in `lib/model` or `lib/formats` imports one today,
 * which is what makes them shareable at all.
 */
async function bundleEntry(entry: string, format: 'esm' | 'iife' = 'esm'): Promise<string> {
    const result = await build({
        entryPoints: [entry],
        bundle: true,
        // Workers are created from a Blob with no `type: 'module'`, so they are
        // *classic* workers and an `export` at top level is a syntax error in
        // one. `iife` is what makes the bundle a plain program; the page's own
        // script stays `esm` because it is inlined into a module script tag.
        format,
        target: 'es2022',
        platform: 'browser',
        write: false,
        // Not minified, for the same reason the CLI is not: these are read by
        // people debugging a dashboard, and the bytes saved are not worth a
        // stack trace nobody can follow. The pages are small and gzip well.
        minify: false,
        // Inlined into HTML, where a `//# sourceMappingURL` pointing at a file
        // that will not be deployed is worse than no source map at all.
        sourcemap: false,
        external: [],
        logLevel: 'silent',
    });
    const [file] = result.outputFiles ?? [];
    if (file === undefined) {
        throw new Error(`esbuild produced no output for ${entry}`);
    }
    return file.text;
}

/** Builds one page, returning what it produced. */
async function buildPage(name: string): Promise<BuiltPage> {
    const source = await readFile(join(sourceDir, name), 'utf8');

    // Workers first: their source becomes a string constant the page's own
    // bundle reads, so it has to exist before that bundle is spliced in.
    WORKER_DIRECTIVE.lastIndex = 0;
    const workerNames = [...source.matchAll(WORKER_DIRECTIVE)].map((match) => match[1]!);
    const workerSources = await Promise.all(
        workerNames.map((worker) => bundleEntry(join(sourceDir, worker), 'iife'))
    );
    for (const [index, worker] of workerNames.entries()) {
        checkWorkerSelfContained(name, worker, workerSources[index]!);
    }
    const workers: [string, number][] = workerNames.map((worker, index) => [
        worker,
        workerSources[index]!.length,
    ]);

    let inlined = 0;
    const replacements: Promise<string>[] = [];
    // `String.replace` cannot await, so collect the bundles first and splice
    // them in afterwards. The regex is stateful (`g`), hence the explicit reset.
    MODULE_SCRIPT.lastIndex = 0;
    const entries = [...source.matchAll(MODULE_SCRIPT)];
    for (const match of entries) {
        replacements.push(bundleEntry(join(sourceDir, match[1]!)));
    }
    const bundles = await Promise.all(replacements);

    // The prelude that carries the worker sources into the page's module scope.
    // `JSON.stringify` is what makes an arbitrary program safe to embed in a
    // string literal — it escapes the quotes, the backslashes and the newlines,
    // and `checkSafe` separately asserts no `</script` survives anywhere in the
    // emitted script.
    const workerPrelude =
        workerNames.length === 0
            ? ''
            : `globalThis.${WORKER_GLOBAL} = {\n` +
              workerNames
                  .map(
                      (worker, index) =>
                          `  ${JSON.stringify(worker)}: ${JSON.stringify(workerSources[index]!)},`
                  )
                  .join('\n') +
              '\n};\n';

    let output = source;
    for (const [index, match] of entries.entries()) {
        // No escaping pass here: esbuild already emits `<\/script>` for a
        // `</script>` in a string literal, and re-escaping what it produced was
        // both dead code and — when the round-trip guard below undid it — a
        // build failure on any page whose source contains the literal. What is
        // left is the check that this holds, in `checkSafe`.
        output = output.replace(
            match[0],
            `<script type="module">\n${workerPrelude}${bundles[index]!}\n</script>`
        );
        inlined++;
    }

    if (inlined === 0) {
        // A page in `next/` that inlines nothing is almost certainly a typo in
        // the script tag rather than a page that genuinely needs no code — and
        // it would deploy as a blank dashboard.
        throw new Error(
            `${name} has no <script type="module" src="./*.ts"> tag, so nothing was inlined. ` +
                'A migrated page is expected to import from lib/; check the tag spelling.'
        );
    }

    // Validate before writing, not after. Writing first means a build that
    // fails still replaces the previous good artefact with the broken one, so
    // the deploy ships it and the non-zero exit is the only clue.
    checkSafe(name, [...bundles, ...workerSources]);
    await writeFile(join(outDir, name), output);
    const assets = await copyAssets(name, output);
    return { name, bytes: output.length, inlined, assets, workers };
}

/**
 * Fails the build if a worker bundle still needs something from outside itself.
 *
 * This is the check that the worker problem is actually solved. A worker created
 * from a `Blob` runs as a classic script with no module loader and no access to
 * the page's scope, so a surviving `import` is not a slow path — it is a
 * `SyntaxError` at worker construction, which surfaces as an `error` event the
 * page turns into "no data for these tests".
 *
 * Both directions are checked because they fail differently: an `import` means
 * esbuild did not bundle (wrong format or an `external`), while an `export`
 * means it emitted an ES module, which a classic worker also refuses to parse.
 */
function checkWorkerSelfContained(page: string, worker: string, bundle: string): void {
    // Anchored to a line start, so `import(` inside a string or a comment
    // mentioning the word does not trip it. esbuild emits statements at column
    // zero of their own line in the `iife` output.
    const bare = /^(?:import|export)\b/m.exec(bundle);
    if (bare !== null) {
        const line = bundle.slice(0, bare.index).split('\n').length;
        throw new Error(
            `${page}: the worker bundle ${worker} still has a top-level ` +
                `'${bare[0]}' at line ${line}. A Blob worker is a classic script — it ` +
                'cannot resolve an import and cannot parse an export, so this would fail ' +
                'at worker construction and the page would silently show no data. ' +
                'Check that the entry point is bundled with format: iife and no externals.'
        );
    }
}

/**
 * Copies the sibling files a built page references, so its relative URLs work.
 *
 * A missing one is a hard error rather than a warning: the symptom of a page
 * that cannot load `shared.js` is a dashboard that renders its markup and then
 * does nothing, which looks far more like a data problem than a build problem.
 */
async function copyAssets(name: string, html: string): Promise<string[]> {
    SIBLING_ASSET.lastIndex = 0;
    const wanted = [...new Set([...html.matchAll(SIBLING_ASSET)].map((match) => match[1]!))];
    for (const asset of wanted) {
        try {
            await copyFile(join(root, asset), join(outDir, asset));
        } catch (error) {
            throw new Error(
                `${name} references ${asset}, which is not in the repository root: ${String(error)}`
            );
        }
    }
    return wanted.sort();
}

/**
 * Fails the build if an inlined bundle would not survive being put inside HTML.
 *
 * The CLI build has an equivalent guard for a reason that applies here twice
 * over: it once emitted a file with two shebang lines, reported success, and
 * shipped something Node refused to parse. A page is worse — the only symptom
 * of a bundle mangled on its way into the HTML is a blank dashboard and a
 * console error nobody is watching for.
 *
 * Two distinct checks, because they fail differently:
 *
 * 1. **No unescaped `</script>`.** This is the one that silently truncates: the
 *    HTML parser closes the tag at the first occurrence wherever it appears,
 *    leaving valid-looking markup whose script stops mid-statement. esbuild
 *    escapes these itself, so this asserts that guarantee rather than
 *    re-implementing it — an earlier version escaped again and then "verified"
 *    the result by undoing esbuild's escaping, which failed every build of a
 *    page whose source contained the literal string.
 * 2. **The bundle parses.** Catches a corrupt splice from any other cause.
 */
function checkSafe(name: string, bundles: readonly string[]): void {
    for (const bundle of bundles) {
        // Deliberately assembled so this source file does not itself contain
        // the literal sequence it is looking for.
        const closing = '</' + 'script';
        const at = bundle.indexOf(closing);
        if (at !== -1) {
            throw new Error(
                `${name}: the bundle contains an unescaped ${closing}>, which would close the ` +
                    `tag early and truncate the page's script (at offset ${at}: ` +
                    `${JSON.stringify(bundle.slice(Math.max(0, at - 40), at + 40))}). esbuild ` +
                    'normally escapes this; something downstream of it has not.'
            );
        }
        try {
            // `new Function` parses without executing. The async wrapper is
            // what lets a bundle using top-level await through — esbuild emits
            // one for any page that fetches its data at module scope.
            new Function(`return async () => {${bundle}}`);
        } catch (error) {
            throw new Error(`${name}: the inlined bundle does not parse: ${String(error)}`);
        }
    }
}

const sources = (await readdir(sourceDir).catch(() => [])).filter((name) => name.endsWith('.html'));
if (sources.length === 0) {
    console.log('No pages in next/ yet; nothing to build.');
} else {
    await mkdir(outDir, { recursive: true });
    const built: BuiltPage[] = [];
    for (const name of sources) {
        built.push(await buildPage(name));
    }
    for (const page of built) {
        const kb = (page.bytes / 1024).toFixed(1);
        const assets = page.assets.length > 0 ? `, ${page.assets.length} assets copied` : '';
        const workers = page.workers
            .map(([worker, bytes]) => `, ${worker} worker ${(bytes / 1024).toFixed(1)} kB`)
            .join('');
        console.log(
            `Built ${join(outDir, page.name)} (${kb} kB, ${page.inlined} script inlined${workers}${assets})`
        );
    }
}
