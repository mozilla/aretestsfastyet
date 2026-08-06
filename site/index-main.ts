/**
 * The page's entry point: import the controller and start it.
 *
 * This file exists so that `site/index.ts` does not start the page merely by
 * being imported — the property `site/crashes-main.ts` documents, and the one
 * that makes `test/index-page.test.ts` able to drive the landing page under
 * jsdom at all. Without it, importing the controller would render the dashboard
 * teaser, attach the observer and fetch two artifacts.
 *
 * It matters more here than on the other pages. This page's charts are
 * *entirely* driven by an `IntersectionObserver`, which jsdom does not
 * implement, so a controller that started on import would attach nothing a test
 * could reach and would fetch on every import besides.
 */

import { start } from './index.ts';

await start();
