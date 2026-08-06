/**
 * The page's entry point: import the controller and start it.
 *
 * This file exists so that `site/crashes.ts` does not have to start the page
 * merely by being imported. It used to: a bare `setupClickHandlers()` and an
 * awaited IIFE ran at module scope, so any test that imported the controller
 * attached listeners, populated the date selector and fetched data. The result
 * was that `drilldown-render.ts` and the two controllers — 2,598 lines, 60% of
 * the crashes/failures migration — had no test importing them at all, and
 * inverting the page-identity branch in `inlineLinksCell` passed both
 * `npm test` and `tsc`.
 *
 * Splitting the start call into its own module is the smallest fix that keeps
 * both properties: the built page still runs on load, and the controller is an
 * ordinary importable module. The build inlines whichever entry the page's
 * script tag names, so the only cost is this file.
 */

import { start } from './crashes.ts';

await start();
