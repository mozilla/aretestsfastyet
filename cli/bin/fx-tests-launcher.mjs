#!/usr/bin/env node
/**
 * The installed entry point, and the reason `npm i -g github:…` needs no build.
 *
 * `bin/fx-tests.js` is esbuild output and gitignored, so a git-URL install has
 * no bundle. Building during `prepare` does not work either: for a global git
 * install npm runs `prepare` in a bare cache clone *before* devDependencies
 * exist, so esbuild is not importable and the install fails outright.
 *
 * Node can run the TypeScript sources directly, so the install does not need a
 * bundler at all. This launcher re-executes the real entry point with type
 * stripping enabled: `--experimental-strip-types` on Node 22, where it is
 * off by default, and nothing on Node 23+, where it is on and the flag has
 * been removed. Detecting by version rather than by trying and catching keeps
 * the failure mode a clear error instead of a confusing syntax error.
 *
 * The cost is one extra process per invocation, which is milliseconds against
 * commands that download megabytes. `npm run build` still produces the
 * single-file bundle for anyone who wants it.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./fx-tests.ts', import.meta.url));
const major = Number(process.versions.node.split('.')[0]);

if (Number.isNaN(major) || major < 20) {
    process.stderr.write(
        `fx-tests requires Node 20 or newer (found ${process.versions.node}).\n`
    );
    process.exit(1);
}

// Node 22 hides type stripping behind a flag and warns about it; 23 and later
// enable it by default and reject the flag, so passing it there is an error.
const flags =
    major >= 23
        ? ['--no-warnings=ExperimentalWarning']
        : ['--experimental-strip-types', '--no-warnings=ExperimentalWarning'];

const result = spawnSync(process.execPath, [...flags, entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
});

if (result.error !== undefined) {
    process.stderr.write(`fx-tests could not start: ${result.error.message}\n`);
    process.exit(1);
}

// Preserve a signal death as a signal-shaped exit rather than reporting 0.
process.exit(result.status === null ? 1 : result.status);
