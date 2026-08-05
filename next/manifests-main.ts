/**
 * The page's entry point: import the controller and start it.
 *
 * This file exists so that `next/manifests.ts` does not start the page merely
 * by being imported — the property `next/crashes-main.ts` records the reason
 * for, and the reason `test/manifests-page.test.ts` can drive the controller
 * under jsdom at all.
 */

import { start } from './manifests.ts';

await start();
