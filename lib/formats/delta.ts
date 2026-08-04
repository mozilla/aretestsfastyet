/**
 * Delta decoding.
 *
 * Four fields in the published files are delta-encoded, and all four use the
 * same scheme: entry `i` holds the increment from entry `i-1`, and the first
 * entry holds the increment from a base that depends on the field.
 *
 * | field | base | unit |
 * | --- | --- | --- |
 * | `statusGroup.days` | day 0, the *oldest* day the file covers | days |
 * | `statusGroup.timestamps` (daily files) | `metadata.startTime` | seconds |
 * | `jobs.startTimes` (resource files) | the start of the file's date | seconds |
 * | `markers[].taskIdIds` (errors files) | 0 | table index |
 *
 * The day encoding is the one that trips people up: day 0 is the oldest day,
 * so a "recent" filter is `day >= totalDays - n`, not `day < n`. The decoders
 * here return absolute values so callers never have to remember that a raw
 * array is relative.
 */

/**
 * Decodes a delta-encoded array into absolute values.
 *
 * `base` is added to the first entry, so `decodeDeltas([5, 1], 100)` is
 * `[105, 106]`. The default base of 0 is what `days` and the errors files'
 * `taskIdIds` want; the daily files' `timestamps` want `metadata.startTime`.
 */
export function decodeDeltas(deltas: readonly number[], base = 0): number[] {
    const out = new Array<number>(deltas.length);
    let value = base;
    for (let i = 0; i < deltas.length; i++) {
        value += deltas[i]!;
        out[i] = value;
    }
    return out;
}

/**
 * Re-encodes absolute values as deltas, the inverse of `decodeDeltas`.
 *
 * Nothing in the library needs to write these files; this exists so the
 * round-trip can be property-tested, which is the cheapest way to be sure the
 * decoder's base handling is right.
 */
export function encodeDeltas(values: readonly number[], base = 0): number[] {
    const out = new Array<number>(values.length);
    let previous = base;
    for (let i = 0; i < values.length; i++) {
        out[i] = values[i]! - previous;
        previous = values[i]!;
    }
    return out;
}

/**
 * Walks a delta-encoded array without allocating the decoded one.
 *
 * A bucket file's `days` arrays are walked once per query over hundreds of
 * thousands of entries, and there is no reason to materialize an array per
 * group only to read each value once.
 */
export function forEachDelta(
    deltas: readonly number[],
    base: number,
    fn: (value: number, index: number) => void
): void {
    let value = base;
    for (let i = 0; i < deltas.length; i++) {
        value += deltas[i]!;
        fn(value, i);
    }
}
