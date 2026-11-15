/**
 * `lib/query/bucket-lookup.ts`: the file choice `try.html` and `fx-tests try`
 * share. The read is faked, so this pins the policy alone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bucketFileSuffix, bucketIndexForPath } from '../lib/formats/buckets.ts';
import { lookupInBuckets } from '../lib/query/bucket-lookup.ts';

const XHTML = 'toolkit/content/tests/chrome/test_menupopup_scroll_amount.xhtml';
const JS = 'netwerk/test/unit/test_cookies.js';
const GONE = 'dom/base/test/test_removed.html';

const fileOf = (harness: string, path: string): string =>
    `${harness}-${bucketFileSuffix(bucketIndexForPath(path))}.json`;

test('each test is read from its own harness\'s file, once', async () => {
    const reads: string[] = [];
    const missed = await lookupInBuckets([XHTML, JS, GONE], {
        pathOf: (path) => path,
        read: async (file) => {
            reads.push(file.filename);
            return file.items.filter((path) => path === GONE);
        },
    });
    assert.deepEqual(missed, [GONE]);
    assert.deepEqual(
        [...reads].sort(),
        [...new Set([fileOf('mochitest', XHTML), fileOf('xpcshell', JS), fileOf('mochitest', GONE)])].sort()
    );
});

test('no more than `concurrency` files are read at once', async () => {
    const paths = Array.from({ length: 40 }, (_, i) => `dir${i}/test_${i}.html`);
    let active = 0;
    let peak = 0;
    await lookupInBuckets(paths, {
        pathOf: (path) => path,
        concurrency: 3,
        read: async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 1));
            active--;
            return [];
        },
    });
    assert.equal(peak, 3);
});
