#!/usr/bin/env node
/**
 * Fails if the committed `bin/fx-tests.js` does not match the sources.
 *
 * The bundle has to be committed — Node refuses to strip types under
 * `node_modules`, so an installed package cannot run from `.ts`, and `prepare`
 * cannot build one because npm runs it in a bare cache clone before
 * devDependencies exist. That makes the bundle the only thing a `npm i -g
 * github:...` user actually executes.
 *
 * Which creates the failure mode this guards: someone edits `cli/` or `lib/`,
 * the test suite passes because it runs the sources, and the installed CLI
 * silently keeps the old behaviour. A committed artefact is only safe if
 * staleness is loud, so this rebuilds to a temporary file and compares.
 *
 * Run by `npm test`. If it fails, the fix is `npm run build`.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const committed = join(root, 'bin', 'fx-tests.js');

let current: Buffer;
try {
    current = readFileSync(committed);
} catch {
    console.error('bin/fx-tests.js is missing. Run `npm run build`.');
    process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), 'fx-tests-bundle-'));
try {
    execFileSync(
        process.execPath,
        ['--experimental-strip-types', join(root, 'tools', 'build-cli.ts')],
        { cwd: root, env: { ...process.env, FX_TESTS_BUILD_OUT: scratch }, stdio: 'pipe' }
    );
    const rebuilt = readFileSync(join(scratch, 'fx-tests.js'));
    if (!rebuilt.equals(current)) {
        console.error(
            'bin/fx-tests.js is stale: it does not match the current sources.\n' +
                'Anyone who installed from git is running the old code. Run `npm run build`\n' +
                'and commit the result.'
        );
        process.exit(1);
    }
    console.log('bin/fx-tests.js matches the sources.');
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
