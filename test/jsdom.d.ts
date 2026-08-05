/// <reference lib="dom" />
/**
 * `jsdom`'s surface, as `test/dom-harness.ts` uses it.
 *
 * jsdom ships no `.d.ts`, so without this the import is an implicit `any` and
 * `tsc --noEmit` fails under the root project's `strict`.
 *
 * ## `@types/jsdom` was allowed, evaluated, and deliberately not taken
 *
 * Adding it as a devDependency is permitted (jsdom is approved for tests, not
 * for the build), so this is a judgement rather than a restriction. Both were
 * installed and measured on 2026-08-05:
 *
 * | | this file | `@types/jsdom` |
 * | --- | --- | --- |
 * | latest version | — | **28.0.3** |
 * | installed jsdom | 29.1.1 | 29.1.1 — **no `@types/jsdom@29` is published** |
 * | `window.documentzzz`, a misspelling | **`TS2551`, with a suggestion** | accepted, typed `any` |
 * | packages added | 0 | 4 (`@types/jsdom`, `@types/tough-cookie`, `parse5`, `undici-types`) |
 *
 * The usual argument for the real package is that it is more accurate and does
 * not drift. Here it inverts on both halves. It *is* drifted — a full major
 * behind the jsdom actually installed, with no 29.x to move to — and it is less
 * accurate for this codebase's purpose, because `DOMWindow` is declared with
 * `[key: string]: any` (`@types/jsdom/index.d.ts:190`). That index signature
 * turns every property access on `window` into `any`, which is the single thing
 * this file exists to prevent: `test/dom-harness.ts` hands tests elements off
 * `window`, and an `any` there means a misspelt property in an assertion
 * silently passes. Verified both directions rather than assumed — the row above
 * is the same probe compiled against each.
 *
 * Both typecheck clean, so this is not a correctness forced move; it is the
 * stricter option with no supply-chain cost, and it is re-decidable the moment
 * `@types/jsdom@29` ships.
 *
 * ## What this deliberately does not cover
 *
 * Only the surface the test harnesses call: the `JSDOM` constructor, three of
 * its options, and `.window`. **Not** covered, and each would be a compile
 * error rather than a silent `any` if a test reached for it —
 * `JSDOM.fromFile`/`fromURL`, `serialize()`, `nodeLocation()`, `virtualConsole`,
 * `CookieJar`/`ResourceLoader`, `runScripts: undefined`'s other modes beyond the
 * two listed, and every constructor option no harness passes (`referrer`,
 * `contentType`, `storageQuota`, …). Adding one is a two-line edit here; the
 * point is that the list of what the tests depend on stays readable.
 *
 * A standalone `.d.ts` rather than a `declare module` inside the harness,
 * because an augmentation cannot be attached to a module TypeScript already
 * resolves as untyped (`TS2665`) — the declaration has to *be* the module's
 * types, which means a global script file with no top-level import or export.
 *
 * `window` is typed as the DOM's own `Window & typeof globalThis`, so every
 * element a test receives is a real `HTMLElement` to the compiler.
 */
declare module 'jsdom' {
    interface JSDOMOptions {
        /** Sets `location`, and with it `?kind=` and the `#hash`. */
        url?: string;
        /**
         * `'outside-only'` gives the window a working `eval` — which is how the
         * harness loads the six shared `<script src=…>` files — without letting
         * jsdom run inline event-handler attributes. See the note on the 🐛
         * button in `test/failures-page.test.ts`.
         */
        runScripts?: 'outside-only' | 'dangerously';
        /**
         * Turns on `requestAnimationFrame`, which is off by default.
         *
         * Needed by `test/index-page.test.ts`: the landing page defers its
         * whole render into an animation frame (`index.html:766`), so without
         * this `start()` throws `requestAnimationFrame is not a function` and
         * nothing renders. Enabling it keeps the page's real
         * frame-then-timeout sequencing under test rather than stubbing it.
         */
        pretendToBeVisual?: boolean;
    }

    export class JSDOM {
        constructor(html: string, options?: JSDOMOptions);
        readonly window: Window & typeof globalThis;
    }
}
