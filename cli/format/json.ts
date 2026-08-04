/**
 * JSON output.
 *
 * `CLI.md` promises `--json` is a "stable shape, documented per command", so
 * the shapes live with their commands and this module only owns how they are
 * serialized. Two rules:
 *
 * **Pretty-printed by default.** The consumer is either a human reading it or
 * `jq`, and both prefer indentation. The size difference does not matter at
 * the scale a single command emits.
 *
 * **`Map` and `Set` are converted, not dropped.** `JSON.stringify(new Map())`
 * is `{}` — silently empty, which is the failure mode this project keeps
 * finding. Anything holding a collection has to be converted deliberately, and
 * `jsonReplacer` makes the omission loud instead by throwing.
 */

/** Serializes a value as the CLI's JSON output. */
export function toJson(value: unknown): string {
    return JSON.stringify(value, jsonReplacer, 2);
}

/**
 * Refuses to serialize a `Map` or `Set` rather than emitting `{}`.
 *
 * `JSON.stringify` turns both into `{}` with no warning, which produces output
 * that parses, validates as an object, and is empty. A command that wants to
 * emit one has to convert it — `Object.fromEntries` or `[...set]` — and this
 * makes forgetting a crash at development time rather than a silently missing
 * field in someone's pipeline.
 */
export function jsonReplacer(key: string, value: unknown): unknown {
    if (value instanceof Map) {
        throw new Error(
            `refusing to serialize a Map at "${key}" — it would become {}. ` +
                `Convert it with Object.fromEntries() or [...map] first.`
        );
    }
    if (value instanceof Set) {
        throw new Error(
            `refusing to serialize a Set at "${key}" — it would become {}. ` +
                `Convert it with [...set] first.`
        );
    }
    return value;
}

/** A `Map` as a plain object, for embedding in a JSON shape. */
export function mapToObject<V>(map: ReadonlyMap<string, V>): Record<string, V> {
    return Object.fromEntries(map);
}

/** A `Map` as an array of `{ key, count }`, when order matters. */
export function mapToEntries<V>(
    map: ReadonlyMap<string, V>,
    keyName = 'key',
    valueName = 'value'
): Record<string, string | V>[] {
    return [...map].map(([key, value]) => ({ [keyName]: key, [valueName]: value }));
}
