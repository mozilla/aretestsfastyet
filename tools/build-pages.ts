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
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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

interface BuiltPage {
    name: string;
    bytes: number;
    inlined: number;
}

/**
 * Bundles one TypeScript entry point into a single string of browser JS.
 *
 * `format: 'esm'` and no `platform: 'node'`: these run in a browser, so a
 * `lib/` module that reached for a node builtin must fail the build here rather
 * than at page load. Nothing in `lib/model` or `lib/formats` imports one today,
 * which is what makes them shareable at all.
 */
async function bundleEntry(entry: string): Promise<string> {
    const result = await build({
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
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

    let output = source;
    for (const [index, match] of entries.entries()) {
        // No escaping pass here: esbuild already emits `<\/script>` for a
        // `</script>` in a string literal, and re-escaping what it produced was
        // both dead code and — when the round-trip guard below undid it — a
        // build failure on any page whose source contains the literal. What is
        // left is the check that this holds, in `checkSafe`.
        output = output.replace(match[0], `<script type="module">\n${bundles[index]!}\n</script>`);
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
    checkSafe(name, bundles);
    await writeFile(join(outDir, name), output);
    return { name, bytes: output.length, inlined };
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
        console.log(`Built ${join(outDir, page.name)} (${kb} kB, ${page.inlined} script inlined)`);
    }
}
