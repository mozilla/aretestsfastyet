/**
 * Rendering a duration as text.
 *
 * A duration formatter is data-shaped — it names no element id, no CSS class
 * and no glyph beyond the em-dash that stands for "no measurement" — so it
 * passes the `lib/` test the migration settled on:
 *
 * > **`lib/` holds data and derivations. The page directory holds the view
 * > model — including anything that names an element id, a CSS class or a
 * > glyph.**
 *
 * It has to be here rather than in `site/` for a second reason: `cli/` and
 * `site/` both need it, and `tsconfig.json` compiles `lib/` and `cli/` against
 * node while `tsconfig.site.json` compiles `site/` against the DOM. `lib/` is
 * the only directory both projects include, so it is the only place one
 * implementation can serve a command and a page at once.
 *
 * ## Why there are two exported functions and not one
 *
 * The tree held **thirteen** duration formatters when this module was written.
 * Grouping them by what they *produce* rather than by what they are *called*
 * gives four families, and only one of those had more than one member that
 * genuinely agreed:
 *
 * | family | output at 60 s / 1 h / 24 h | members |
 * | --- | --- | --- |
 * | **tiered, em-dash for no data** | `1m` / `1h` / `1d` | `issues.html`, `test.html`, `xpcshell-timings.html`, `site/test-view.ts` |
 * | **floored `Xm Ys`, no hour form** | `1m 0s` / `60m 0s` / `1440m 0s` | `manifests.html`, `site/manifests-view.ts` |
 * | **padded `Xm YYs` with an hour form** | `1m 00s` / `1h 00m` / `24h 00m` | `cli/commands/manifests.ts` |
 * | **one-offs, each with a caller-visible quirk** | — | `shared.js`, `xpcshell-histograms.html`, `workers.html`, `job-speed.html`, `resource-use.html`, `reviewbot.html` |
 *
 * The first family is four copies of one function under two names, and
 * `formatDurationMs` below is that function. The third is one caller, and
 * `formatDurationPadded` below is that one. They are **not** merged, and the
 * reason is the standing rule that a shared helper needing three booleans to
 * serve its callers is really several functions: the two differ in the
 * zero/no-data case (em-dash vs a caller-supplied `—`), in whether a zero
 * seconds field is printed at all (`1m` vs `1m 00s`), in whether it is padded,
 * and in where the ladder stops (days vs hours). That is four parameters to
 * save nine lines, and every one of them changes what a reader sees.
 *
 * The second family — the floored `Xm Ys` with no hour form — is left where it
 * is, in `site/manifests-view.ts`. It is a deliberate transcription of
 * `manifests.html` that `test/manifests-parity.test.ts` names as divergence 9,
 * and its floored seconds and missing hour form are the *content* of that
 * divergence. Folding it into either function here would delete the comparison.
 *
 * The one-offs are listed in `formatDurationMs`'s notes with the quirk that
 * keeps each one separate.
 *
 * ## The carry rule
 *
 * The bug that prompted this module was a field printed at its own modulus.
 * `formatDurationPadded`'s original took `Math.floor` of the minutes and then
 * `Math.round` of the leftover seconds, and a rounded remainder can reach its
 * own modulus: `Math.round(119.9 - 1 * 60)` is `60`, so `119,900 ms` printed as
 * `1m 60s`. Measured on the published mochitest manifests file for 2026-08-04,
 * that shape appeared in **73 rendered fields** across the text and Markdown
 * outputs of `fx-tests manifests --limit 0`, the largest being `51m 60s`.
 *
 * The rule is **never round a remainder**, and there are two ways to obey it.
 * `formatDurationPadded` rounds the *total* to whole seconds and then splits,
 * so every field is the remainder of an integer and is in range by
 * construction. `formatDurationMs` floors throughout and rounds nothing, which
 * obeys the rule as completely and is what its four source pages already did —
 * it is left alone rather than converted, for the reason set out on it.
 *
 * So the two functions do not share a splitting helper. Factoring one out was
 * tried; it can only serve both by taking a flag that decides whether to round,
 * and that flag *is* the difference between the two functions.
 */

/**
 * A duration in milliseconds, with the unit chosen by magnitude.
 *
 * The shape four pages independently arrived at, verbatim from
 * `test.html:552`, `issues.html:683` and `xpcshell-timings.html:400`, which are
 * character-for-character identical apart from `test.html` writing the em-dash
 * as `—`; `site/test-view.ts:1866` was the transcription of the first.
 *
 * | input | output |
 * | --- | --- |
 * | no data, or exactly `0` | `—` |
 * | under a second | `750ms` |
 * | under a minute | `1.5s` |
 * | under an hour | `2m`, or `2m 30s` |
 * | under a day | `3h`, or `3h 15m` |
 * | a day or more | `2d`, or `2d 4h` |
 *
 * A subordinate field is omitted when it is zero, so an exact hour is `1h` and
 * not `1h 0m`. `ms === 0` is an em-dash rather than `0ms` because a run
 * recorded as taking zero milliseconds is a measurement that did not happen —
 * upstream's meaning, kept.
 *
 * ## The six formatters this deliberately does not replace
 *
 * Each differs from this one in something a caller can see, so each stayed
 * where it was:
 *
 * - **`shared.js:106` `formatDurationS`** takes *seconds*, and always prints
 *   both fields: `0m 30s`, never `30.0s`. Its two callers (`builds.html`,
 *   `shared.js:150`) put it in a table column where a bare `30s` would not line
 *   up. It also has no sub-second, day or em-dash case.
 * - **`xpcshell-histograms.html:176` `formatDurationMs`** is this function with
 *   the hour and day tiers deleted, so an hour is `60m` and a day is `1440m`.
 *   That is a drifted copy rather than a considered choice, but it is a page
 *   with no build step and changing it changes its axis labels.
 * - **`workers.html:283` `formatDuration`** produces clock time — `1:30`,
 *   `2:05:09` — and returns `—` for `null` while formatting `0` as `0.0s`.
 *   Different notation entirely.
 * - **`job-speed.html:1089` `formatTime`** prints a whole number of seconds
 *   without a decimal (`30s`, not `30.0s`) and has a **half-minute** form:
 *   `90,000 ms` is `1.5m`. Nothing else in the tree does that.
 * - **`resource-use.html:437` `formatTime`** always prints both fields of a
 *   minute value (`1m 0s`) and stops at hours, so a day is `24h 0m`.
 * - **`reviewbot.html:447` `formatDuration`** takes *minutes*, spells the unit
 *   `min`, and prints every field down to seconds: `1h 5min 3s`.
 *
 * None of the six can produce a field at its own modulus: each floors its
 * subordinate field, which is why the carry bug reached only the CLI. Checked
 * by sweeping every integer millisecond from `0` to three days against all
 * thirteen.
 *
 * ## This function floors, and is deliberately left flooring
 *
 * `formatDurationPadded` below rounds; this one does not. The difference is
 * intentional, and it is the reason the two are not one function.
 *
 * Flooring is not the carry bug. The carry bug was a value printed at its own
 * modulus — `1m 60s` is not a duration anyone can read — and flooring cannot
 * produce one, because a floored remainder is always strictly below its
 * divisor. Flooring only ever renders a value slightly *short*: `60,500 ms`
 * reads `1m` rather than `1m 1s`, which this form can afford precisely because
 * it omits a zero subordinate field and so never claimed the second digit.
 *
 * Rounding it instead was tried and measured: it changes **2,484,000 of the
 * 259,200,000** integer millisecond values below three days, **1.0%**, and
 * every one of those is a cell on `test.html` in daily use. Changing 1% of a
 * live page's cells is not in scope for a carry fix, and it would be a change
 * the brief did not ask for and no measurement calls wrong.
 *
 * So the two functions differ in their rounding, and that difference is the
 * reason they are two functions rather than one with a flag.
 */
export function formatDurationMs(ms: number, hasData = true): string {
    if (!hasData || ms === 0) {
        return '—';
    }
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }
    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    if (ms < 3_600_000) {
        const minutes = Math.floor(ms / 60_000);
        const seconds = Math.floor((ms % 60_000) / 1000);
        return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
    }
    if (ms < 86_400_000) {
        const hours = Math.floor(ms / 3_600_000);
        const minutes = Math.floor((ms % 3_600_000) / 60_000);
        return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
    }
    const days = Math.floor(ms / 86_400_000);
    const hours = Math.floor((ms % 86_400_000) / 3_600_000);
    return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/**
 * A duration in milliseconds with its subordinate field padded to two digits,
 * or `—` when there is none.
 *
 * `cli/commands/manifests.ts`'s form, and the one the carry bug was found in.
 * The padding is what the tiered form above does not have and cannot grow: this
 * renders into a fixed-width table where `1m 5s` and `1m 45s` must occupy the
 * same width, and it always prints the subordinate field for the same reason —
 * an exact minute is `1m 00s`, not `1m`.
 *
 * | input | output |
 * | --- | --- |
 * | `null` or `undefined` | `—` |
 * | under a second | `750ms` |
 * | under a minute | `1.5s` |
 * | under an hour | `1m 00s`, `59m 59s` |
 * | an hour or more | `1h 00m`, `24h 00m` |
 *
 * `0` renders as `0ms` here and as an em-dash in `formatDurationMs`, and the
 * disagreement is deliberate because the two callers encode "absent"
 * differently. This one is handed `null` for it: `DurationStats` is `null` for
 * a manifest skipped on every configuration, which is what the em-dash means in
 * this table. A literal `0` reaching this function is therefore a *measured*
 * zero, and printing it as `0ms` is correct. It is not hypothetical — the
 * published file for 2026-08-04 holds 34 of them, all in `min` or `median`
 * (24 and 10), against 136,170 nulls. The pages have no such null and spell
 * "not measured" as a literal `0`, which is why the other function em-dashes
 * it. Two spellings of absent, and they are not the same value.
 *
 * There is **no day tier, and the hours field does not reset at 24**, which is
 * load-bearing rather than an omission. The longest value the manifests file
 * produces is a per-manifest `total`, and on 2026-08-04 the largest is
 * 106,663,719 ms — **29.63 hours**, on
 * `browser/components/tabbrowser/test/browser/tabs/browser.toml`. That renders
 * `29h 37m`. Wrapping at 24 would make it `1d 5h`, which is a worse answer for
 * the question this column exists to answer: how much machine time the manifest
 * costs per day.
 *
 * ## Rounding, and the carry the rounding used to cause
 *
 * This form always prints its subordinate field, so unlike `formatDurationMs`
 * it cannot hide a rounding decision by omitting a zero — and it rounds, so a
 * reader sizing a timeout is not told a value is smaller than it is.
 *
 * The rounding has to happen **before** the split. The original computed
 * `Math.floor` of the minutes and then `Math.round` of the leftover seconds,
 * and a rounded remainder can reach its own modulus: `Math.round(119.9 - 60)`
 * is `60`, so `119,900 ms` printed `1m 60s`. Rounding the total first leaves
 * every field the remainder of an integer, so `total % 60` is in `0…59` by
 * construction and no carry is possible at any level.
 *
 * The tier is chosen from the **rounded** total for the same reason. Choosing
 * it from the raw milliseconds is the mirror-image bug: `3,599,900 ms` is under
 * an hour and would take the minutes branch, but rounds to `3600` seconds, so
 * `Math.floor(3600 / 60) % 60` is `0` and the value would print `0m 00s`.
 *
 * ## The hour form now rounds its minutes too, which the original did not
 *
 * A second behaviour change, smaller and worth naming rather than discovering.
 * The original reached the hour branch with an already-floored minute count, so
 * `3,659,500 ms` — 60.99 minutes — printed `1h 00m`, losing very nearly a whole
 * minute. Rounding the total first makes it `1h 01m`.
 *
 * Both changes were measured by sweeping every integer millisecond from `0` to
 * three days: 259,200,000 values, of which 2,159,500 differ from the original
 * — **29,500 carry fixes** and **2,130,000 minute-rounding fixes**, and nothing
 * in a third category. On the published mochitest manifests file for
 * 2026-08-04 the minute rounding moves **4** cells, the largest
 * `8,279,653 ms` from `2h 17m` to `2h 18m`. Every one is nearer the true value.
 */
export function formatDurationPadded(ms: number | null | undefined): string {
    if (ms === null || ms === undefined) {
        return '—';
    }
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }
    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    // Round to whole seconds first, then split. Never the other way round.
    const total = Math.round(ms / 1000);
    if (total < 3600) {
        return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
    }
    const minutes = Math.floor(total / 60) % 60;
    return `${Math.floor(total / 3600)}h ${String(minutes).padStart(2, '0')}m`;
}
