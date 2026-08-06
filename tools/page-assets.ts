/**
 * Finds the sibling files a built page needs next to it, in its markup *and* in
 * its bundled JavaScript.
 *
 * ## The bug this exists for
 *
 * `tools/build-pages.ts` used to discover siblings by scanning the HTML for
 * `src=`/`href=` attributes only. `next/index.ts` fetches its committed backfill
 * from code — `fetch('./mochitest-stats-backfill.json')` — which no attribute
 * mentions, so the file was never copied into `dist-pages/`, the built page's
 * request 404'd, and the page's own best-effort handling turned that into
 * "there is no backfill". Measured on the built page: the mochitest chart showed
 * 68 points from 2026-05-29 instead of 200 from 2026-01-17. Nothing failed; the
 * page just quietly lost six months of history.
 *
 * ## Why the scan is over the bundle, not the source
 *
 * The bundle is what the browser actually runs, so it is what actually issues
 * the requests. Scanning `next/*.ts` instead would miss a fetch that arrives
 * from an imported `lib/` module, and would see one that esbuild tree-shook
 * away. It is also the same string the `</script>` guard checks, so both
 * checks look at the identical artefact.
 *
 * ## Why a required/optional distinction exists
 *
 * `next/index.ts` issues two backfill fetches and only one of the files exists:
 * `ls *-stats-backfill.json` is a single entry, and the xpcshell request has
 * 404'd on every load since the page was written. That is deliberate — the
 * backfill is a repair for a specific mochitest data loss — so "every relative
 * fetch must resolve" would fail the build today and the only available fix
 * would be to weaken it back to a warning.
 *
 * Instead the *page* declares which fetches are allowed to miss, with a
 * `// build-optional: <filename>` comment. Everything else is required and a
 * missing file is a hard error, matching how a missing markup-referenced
 * sibling already behaves. The default is the safe one: a new
 * `fetch('./data.json')` written with no annotation fails the build until the
 * file is committed, which is exactly the failure that was silent before.
 */

/**
 * Sibling assets a page pulls in with a plain tag: `shared.js`, `shared.css`,
 * the favicons, and the rest of the scripts the unmigrated pages share.
 *
 * These are *not* inlined. `shared.js` and friends are loaded by up to 22 pages
 * that are not being migrated, so they stay exactly where they are and keep
 * being served as themselves; a migrated page goes on loading them by name. The
 * duplication the migration removes is the *data* logic — `computeTestStats`,
 * `getChunkIndex` and the rest of `common-test-data.js`, which `lib/` already
 * has typed and tested — not the UI plumbing, which has no `lib/` equivalent
 * and no reason to grow one yet.
 *
 * They do have to be *reachable*, though: the built page sits in `dist-pages/`,
 * so a relative `src="shared.js"` resolves next to it and 404s unless the file
 * is copied there. crash-viewer.html did not catch this because it is entirely
 * self-contained.
 */
const MARKUP_ASSET = /(?:src|href)="(?!https?:|\/\/|\.\/|data:|#)([\w.-]+\.(?:js|css|svg|json))"/g;

/**
 * A `fetch` of a path that resolves next to the page.
 *
 * Only the `./`-prefixed form counts, and that is the whole point of the
 * pattern. A page has three ways to ask for data and they need different
 * treatment:
 *
 * - `fetchData('mochitest-stats.json')` — a published CI artifact, resolved by
 *   `fetch-utils.js` against whatever `?data-source=` says. Never a sibling of
 *   the page, and not matched here because the callee is not `fetch`.
 * - `fetch(url)` / `fetch('https://…')` — a remote or computed URL. Not
 *   matched: no leading `./`, and a non-literal argument cannot be resolved at
 *   build time anyway.
 * - `fetch('./mochitest-stats-backfill.json')` — a committed file that must
 *   travel with the page. This is the one that has to be copied.
 *
 * All three quote styles are accepted because the pattern runs over esbuild's
 * output, and while esbuild normalises to double quotes today, a template
 * literal with no substitution can survive as one.
 */
const FETCH_SIBLING = /fetch\(\s*(["'`])\.\/([\w.-]+)\1\s*\)/g;

/**
 * The marker a page uses to say a fetched sibling may legitimately be absent.
 *
 * Written as a comment naming the file, anywhere in the source that fetches it:
 *
 * ```ts
 * // build-optional: xpcshell-stats-backfill.json — only mochitest has one.
 * const xpcshellBackfill = fetch('./xpcshell-stats-backfill.json');
 * ```
 *
 * The **filename is part of the marker** rather than being inferred from the
 * next line. Position-based matching would break on a marker whose explanation
 * runs to several lines, and reading the name twice is what makes the exemption
 * greppable: `grep -rn build-optional next/` lists every file the build is
 * knowingly allowed to miss, which is a list worth being able to see.
 *
 * The match is against the page's *sources*, not the bundle, because esbuild
 * strips ordinary comments — which is also why `findSiblingAssets` has to be
 * given the sources separately.
 */
const OPTIONAL_DIRECTIVE = /\/\/\s*build-optional:\s*([\w.-]+)/g;

/** One sibling a built page needs, and whether its absence fails the build. */
export interface SiblingAsset {
    name: string;
    /**
     * `false` only for a fetch the page annotated `build-optional`. A missing
     * required sibling is a build error; a missing optional one is copied if
     * present and skipped if not.
     */
    required: boolean;
}

/** Sorted by name, so the build log and the tests have a stable order. */
function sorted(assets: Map<string, boolean>): SiblingAsset[] {
    return [...assets]
        .map(([name, required]) => ({ name, required }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every sibling the built page will ask the server for.
 *
 * @param html the built page, markup and inlined bundle together
 * @param sources the page's own `.ts` sources, for the `build-optional` markers
 *   esbuild strips out of the bundle
 */
export function findSiblingAssets(html: string, sources: readonly string[] = []): SiblingAsset[] {
    const optional = new Set<string>();
    for (const source of sources) {
        OPTIONAL_DIRECTIVE.lastIndex = 0;
        for (const match of source.matchAll(OPTIONAL_DIRECTIVE)) {
            optional.add(match[1]!);
        }
    }

    const assets = new Map<string, boolean>();
    /** `required` accumulates with `||`: one required reference is enough. */
    const want = (name: string, required: boolean): void => {
        assets.set(name, (assets.get(name) ?? false) || required);
    };

    MARKUP_ASSET.lastIndex = 0;
    for (const match of html.matchAll(MARKUP_ASSET)) {
        // A tag requests its file unconditionally, so it is always required.
        want(match[1]!, true);
    }
    FETCH_SIBLING.lastIndex = 0;
    for (const match of html.matchAll(FETCH_SIBLING)) {
        // Group 1 is the quote character the pattern back-references.
        want(match[2]!, !optional.has(match[2]!));
    }
    return sorted(assets);
}
