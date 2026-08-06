/**
 * The page's entry point: import the controller and start it.
 *
 * See `site/crashes-main.ts` for why the start call lives in its own module
 * rather than at the controller's top level.
 */

import { start } from './failures.ts';

await start();
