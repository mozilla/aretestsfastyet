/**
 * Bundles the CLI into `bin/fx-tests.js`.
 *
 * One esbuild call, no config file. `PLAN.md` §2 picks esbuild precisely so
 * that the build is a line rather than a directory, and the CLI's needs are
 * simpler than the pages': one entry point, Node platform, no minification.
 *
 * **Not minified, and no inlining of anything else.** The pages minify because
 * load time over the wire is what they are judged on; a local CLI is read from
 * disk and the only thing minification would cost is a readable stack trace
 * when something throws. Source maps are emitted for the same reason.
 *
 * ## Why the shipped entry is bundled at all
 *
 * The sources import each other with `.ts` extensions and rely on Node's
 * type-stripping, which is behind `--experimental-strip-types` on Node 22 and
 * prints a warning on every run. Neither is acceptable for something with a
 * `bin` entry, so the published artefact is plain JavaScript with the types
 * stripped ahead of time. `bin/fx-tests` (no extension) keeps the
 * no-build-step development loop working — see below.
 */

import { build } from 'esbuild';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// `tools/check-bundle-fresh.ts` builds to a scratch directory to compare
// against the committed bundle, so the destination has to be overridable.
// `dist/`, not `bin/`: npm packs the checkout itself for a git dependency, and
// on that path it dropped the whole of `bin/` because the generated dev entry
// point inside it is gitignored — installing a package with no binary and
// linking a command that did not exist. `dist/` holds only committed artefacts,
// so nothing in it is ignored and there is no directory-level interaction to
// get wrong. The dev entry point stays in `bin/`, gitignored, where it belongs.
const outDir = process.env['FX_TESTS_BUILD_OUT'] ?? join(root, 'dist');
const outFile = join(outDir, 'fx-tests.js');

await mkdir(outDir, { recursive: true });

const result = await build({
    entryPoints: [join(root, 'cli', 'bin', 'fx-tests.ts')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: true,
    // Everything is first-party; there are no runtime dependencies to keep
    // external. If one ever appears, this is where it would be listed, and
    // leaving it out would silently inline someone else's package.
    external: [],
    // No shebang banner: `cli/bin/fx-tests.ts` already starts with one and
    // esbuild preserves it, so adding a banner produced a file with two —
    // which Node rejects, because only the first line may be a shebang. The
    // bundle was unrunnable and `npm run bundle` reported success.
    logLevel: 'info',
});

if (result.errors.length > 0) {
    process.exitCode = 1;
} else {
    await chmod(outFile, 0o755);
    await smokeTest(outFile);
}

/**
 * Runs the built artefact once, so a bundle that cannot start fails the build.
 *
 * Added after a real occurrence: the shebang banner above produced a file with
 * two shebang lines, which Node refuses to parse. esbuild reported success,
 * `npm run bundle` exited 0, and the only symptom was that the shipped binary
 * did not run at all. A build that can produce an unrunnable artefact and call
 * it a success is worth one subprocess to prevent.
 *
 * `--version` is the cheapest command that exercises module loading end to
 * end: it parses every import in the bundle before printing.
 */
async function smokeTest(file: string): Promise<void> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    try {
        const { stdout } = await promisify(execFile)(process.execPath, [file, '--version']);
        if (!/\d+\.\d+\.\d+/.test(stdout)) {
            throw new Error(`--version printed ${JSON.stringify(stdout)}`);
        }
        console.log(`Smoke test passed: ${file} --version -> ${stdout.trim()}`);
    } catch (error) {
        console.error(`Smoke test FAILED: the built CLI does not run.\n${String(error)}`);
        process.exitCode = 1;
    }
}

/**
 * The development entry point: runs the TypeScript sources directly.
 *
 * `PLAN.md` §2 promises the edit-reload loop survives the introduction of a
 * build, and for the CLI that means `./bin/fx-tests` runs what is in `cli/`
 * right now — no rebuild between an edit and a run. The built `.js` next to it
 * is what `npm install -g` gets.
 *
 * Written by the build rather than checked in so that the two cannot drift:
 * they are generated from the same place, and the shebang wrapper is three
 * lines of shell that would otherwise be a file nobody remembers to update.
 */
// Skipped for a scratch build (the freshness check): the dev entry belongs
// next to the real bundle, and rewriting it from a temporary directory would
// point it at the wrong sources.
const devEntry = join(root, 'bin', 'fx-tests');
if (process.env['FX_TESTS_BUILD_OUT'] === undefined) {
    // bin/ is gitignored in full, so it may not exist in a fresh checkout.
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(
        devEntry,
        `#!/bin/sh
# Development entry point: runs the TypeScript sources directly, so an edit in
# cli/ takes effect with no rebuild. Generated by tools/build-cli.ts.
# The built, dependency-free artefact is bin/fx-tests.js next to this file.
exec node --experimental-strip-types --no-warnings=ExperimentalWarning \\
    "$(dirname "$0")/../cli/bin/fx-tests.ts" "$@"
`
    );
    await chmod(devEntry, 0o755);
}

console.log(`Built ${outFile}`);
console.log(`Wrote ${devEntry} (development entry point, runs cli/ sources directly)`);
