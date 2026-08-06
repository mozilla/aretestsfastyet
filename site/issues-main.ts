/**
 * The page's entry point: import the controller and start it.
 *
 * This file exists so that `site/issues.ts` does not start the page merely by
 * being imported. `site/crashes-main.ts` records why that matters — a
 * controller that runs at module scope cannot be imported by a test, which is
 * how an earlier migration ended up with 2,598 lines no test covered.
 */

import { start } from './issues.ts';

await start();
