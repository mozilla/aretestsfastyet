/// <reference lib="dom" />
/**
 * `jsdom`'s surface, as `test/dom-harness.ts` uses it.
 *
 * jsdom ships no `.d.ts` and `@types/jsdom` is not installed, so without this
 * the import is an implicit `any` and `tsc --noEmit` fails under the root
 * project's `strict`. Adding `@types/jsdom` to `package.json` would be the
 * other way, and is **reported rather than done**: this change is confined to
 * `test/`.
 *
 * A standalone `.d.ts` rather than a `declare module` inside the harness,
 * because an augmentation cannot be attached to a module TypeScript already
 * resolves as untyped (`TS2665`) — the declaration has to *be* the module's
 * types, which means a global script file with no top-level import or export.
 *
 * Only the surface the harness uses is declared. That is the safer of the two
 * options rather than a shortcut: `window` is typed as the DOM's own
 * `Window & typeof globalThis`, so every element a test receives is a real
 * `HTMLElement` to the compiler instead of an `any` that would silently accept
 * a misspelt property in an assertion.
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
    }

    export class JSDOM {
        constructor(html: string, options?: JSDOMOptions);
        readonly window: Window & typeof globalThis;
    }
}
