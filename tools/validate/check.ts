/**
 * The assertion primitives the format checkers are written in.
 *
 * Everything reports rather than throws, so one bad field does not hide the
 * rest of the file: a run over a 97 MB errors file should come back with the
 * complete list of what is wrong with it, not the first problem.
 *
 * Three kinds of output, and the distinction matters:
 *
 *  - **errors** — the declared type is wrong about this file. A field is
 *    missing where the declaration requires it, holds the wrong type, is
 *    `null` where the declaration says it cannot be, or indexes outside its
 *    table.
 *  - **notes** — the census. A field the declaration *permits* to be `null` or
 *    absent was observed so, with a count. This is the `nullable/absent` list
 *    step 0 has to produce.
 *  - **observations** — free-form facts collected for the report (every status
 *    string seen, every marker kind, the `UNKNOWN` census).
 *
 * ### Presence is an argument, not an inference
 *
 * Every primitive takes a `Presence`: `'required'`, `'nullable'`, `'optional'`
 * or `'optional-nullable'`. An unexpected `null` or absence is an **error**; an
 * expected one is a **note**, counted for the census.
 *
 * This started out the other way round — every `null` and every absence was a
 * note, never an error — which was the right default while the shapes were
 * still being discovered, and wrong once they were known. It made the
 * validator unable to fail: deleting the whole top-level `markers` object from
 * an errors file still validated clean, because the absence was merely noted.
 * Three fields in `formats/errors.ts` were left declared non-nullable against
 * a census that recorded thousands of nulls in them, and nothing complained.
 *
 * So the expectations are now written down at each call site and enforced. The
 * census still comes out, because a permitted null is still counted — what
 * changed is that an *un*permitted one now fails.
 */

export interface Note {
    /** Dotted path to the field, with `[]` for array elements. */
    path: string;
    kind: 'null' | 'absent' | 'empty';
}

/**
 * What the declaration says about a field being missing or `null`.
 *
 * - `required` — must be present and non-null. Anything else is an error.
 * - `nullable` — must be present; `null` is permitted and counted.
 * - `optional` — may be absent; if present it must be non-null.
 * - `optional-nullable` — may be absent or `null`.
 */
export type Presence = 'required' | 'nullable' | 'optional' | 'optional-nullable';

/**
 * The `noteCounts` key for a field and kind.
 *
 * Exported rather than inlined at both ends because it was inlined at both
 * ends with different separators, and every count then read back as zero —
 * the kind of bug that makes a census look like an absence.
 */
export function noteKey(field: string, kind: Note['kind']): string {
    return `${field}\u0000${kind}`;
}

export interface CheckError {
    path: string;
    message: string;
}

/**
 * Collects findings for one file. Paths are accumulated as a stack so a check
 * deep inside `testRuns[].[]` does not have to know how it got there — but the
 * *concrete* indices are dropped from the path (`testRuns[]` rather than
 * `testRuns[4711]`), because the interesting unit is the field, not the
 * occurrence, and a per-occurrence path would produce millions of identical
 * notes.
 */
export class Checker {
    readonly errors: CheckError[] = [];
    /** Field path -> kinds observed. Deduplicated; counts are in `noteCounts`. */
    readonly notes = new Map<string, Set<Note['kind']>>();
    readonly noteCounts = new Map<string, number>();
    /** Free-form named sets, e.g. `statuses`, `markerKinds`. */
    readonly observations = new Map<string, Map<string, number>>();

    #path: string[] = [];
    #errorCap = 200;

    /** Runs `body` with `segment` appended to the current path. */
    in<T>(segment: string, body: () => T): T {
        this.#path.push(segment);
        try {
            return body();
        } finally {
            this.#path.pop();
        }
    }

    get path(): string {
        return this.#path.join('');
    }

    error(message: string, segment = ''): void {
        if (this.errors.length >= this.#errorCap) {
            return;
        }
        this.errors.push({ path: this.path + segment, message });
        if (this.errors.length === this.#errorCap) {
            this.errors.push({
                path: '',
                message: `(further errors suppressed after ${this.#errorCap})`,
            });
        }
    }

    note(kind: Note['kind'], segment = ''): void {
        const field = this.path + segment;
        let kinds = this.notes.get(field);
        if (!kinds) {
            kinds = new Set();
            this.notes.set(field, kinds);
        }
        kinds.add(kind);
        const key = noteKey(field, kind);
        this.noteCounts.set(key, (this.noteCounts.get(key) ?? 0) + 1);
    }

    /** Records `value` under the named observation set, counting occurrences. */
    observe(set: string, value: string, count = 1): void {
        let bag = this.observations.get(set);
        if (!bag) {
            bag = new Map();
            this.observations.set(set, bag);
        }
        bag.set(value, (bag.get(value) ?? 0) + count);
    }

    // --- presence ----------------------------------------------------------

    /**
     * Decides whether a value is worth type-checking, and records the verdict.
     *
     * Returns `true` when the caller should go on to check the type, `false`
     * when the value was `null`/`undefined` — noted if `presence` permits it,
     * errored if it does not.
     *
     * Every primitive below funnels through here, so there is exactly one
     * place that decides what an unexpected absence means.
     */
    #present(value: unknown, presence: Presence, segment: string): boolean {
        if (value === undefined) {
            if (presence === 'optional' || presence === 'optional-nullable') {
                this.note('absent', segment);
            } else {
                this.error('required field is absent', segment);
            }
            return false;
        }
        if (value === null) {
            if (presence === 'nullable' || presence === 'optional-nullable') {
                this.note('null', segment);
            } else {
                this.error('field is null but the declaration says it cannot be', segment);
            }
            return false;
        }
        return true;
    }

    // --- scalar checks -----------------------------------------------------

    /** Asserts a finite number. Returns false if it was absent or not one. */
    number(value: unknown, segment = '', presence: Presence = 'required'): value is number {
        if (!this.#present(value, presence, segment)) {
            return false;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            return true;
        }
        this.error(`expected a number, got ${describe(value)}`, segment);
        return false;
    }

    integer(value: unknown, segment = '', presence: Presence = 'required'): value is number {
        if (!this.number(value, segment, presence)) {
            return false;
        }
        if (!Number.isInteger(value)) {
            this.error(`expected an integer, got ${value}`, segment);
            return false;
        }
        return true;
    }

    string(value: unknown, segment = '', presence: Presence = 'required'): value is string {
        if (!this.#present(value, presence, segment)) {
            return false;
        }
        if (typeof value === 'string') {
            return true;
        }
        this.error(`expected a string, got ${describe(value)}`, segment);
        return false;
    }

    boolean(value: unknown, segment = '', presence: Presence = 'required'): value is boolean {
        if (!this.#present(value, presence, segment)) {
            return false;
        }
        if (typeof value === 'boolean') {
            return true;
        }
        this.error(`expected a boolean, got ${describe(value)}`, segment);
        return false;
    }

    /** A `YYYY-MM-DD` date string. */
    date(value: unknown, segment = '', presence: Presence = 'required'): value is string {
        if (!this.string(value, segment, presence)) {
            return false;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            this.error(`expected a YYYY-MM-DD date, got ${JSON.stringify(value)}`, segment);
            return false;
        }
        return true;
    }

    /** An ISO timestamp, as `metadata.generatedAt` carries. */
    timestamp(value: unknown, segment = '', presence: Presence = 'required'): value is string {
        if (!this.string(value, segment, presence)) {
            return false;
        }
        if (Number.isNaN(Date.parse(value))) {
            this.error(`expected a parseable timestamp, got ${JSON.stringify(value)}`, segment);
            return false;
        }
        return true;
    }

    object(
        value: unknown,
        segment = '',
        presence: Presence = 'required'
    ): value is Record<string, unknown> {
        if (!this.#present(value, presence, segment)) {
            return false;
        }
        if (typeof value === 'object' && !Array.isArray(value)) {
            return true;
        }
        this.error(`expected an object, got ${describe(value)}`, segment);
        return false;
    }

    /**
     * An array. An empty one is noted, not errored — several tables are
     * legitimately empty (`tables.crashSignatures` in a bucket that saw no
     * crash), and the census is where that belongs.
     */
    array(value: unknown, segment = '', presence: Presence = 'required'): value is unknown[] {
        if (!this.#present(value, presence, segment)) {
            return false;
        }
        if (Array.isArray(value)) {
            if (value.length === 0) {
                this.note('empty', segment);
            }
            return true;
        }
        this.error(`expected an array, got ${describe(value)}`, segment);
        return false;
    }

    /**
     * A table index: an integer in `[0, limit)`. This is the check the plan
     * singles out — a stale index is the failure mode a truncated fixture
     * would never reveal.
     */
    index(value: unknown, limit: number, table: string, segment = ''): value is number {
        if (!this.integer(value, segment)) {
            return false;
        }
        if (value < 0 || value >= limit) {
            this.error(`index ${value} out of range for ${table} (length ${limit})`, segment);
            return false;
        }
        return true;
    }

    /**
     * A string table: an array of strings, required and non-nullable in every
     * file family. Returns the strings, so callers can both length-check
     * indices against it and read the values.
     */
    stringTable(value: unknown, segment = '', presence: Presence = 'required'): string[] {
        if (!this.array(value, segment, presence)) {
            return [];
        }
        const out: string[] = [];
        for (const entry of value) {
            if (typeof entry !== 'string') {
                this.error(`expected a string table entry, got ${describe(entry)}`, `${segment}[]`);
                out.push('');
            } else {
                out.push(entry);
            }
        }
        return out;
    }

    /**
     * An array of table indices.
     *
     * `elements` says whether an individual entry may be `null` — which is a
     * different question from whether the array itself may be absent, hence
     * the two parameters. Getting these the wrong way round is how
     * `messages.componentIds` stayed declared non-nullable against a census
     * recording 5,207 nulls in it.
     */
    indexArray(
        value: unknown,
        limit: number,
        table: string,
        segment = '',
        elements: Presence = 'required',
        presence: Presence = 'required'
    ): void {
        if (!this.array(value, segment, presence)) {
            return;
        }
        for (const entry of value) {
            if (entry === null || entry === undefined) {
                this.#present(entry, elements, `${segment}[]`);
                continue;
            }
            this.index(entry, limit, table, `${segment}[]`);
        }
    }

    numberArray(
        value: unknown,
        segment = '',
        {
            nonNegative = false,
            elements = 'required' as Presence,
            presence = 'required' as Presence,
        } = {}
    ): void {
        if (!this.array(value, segment, presence)) {
            return;
        }
        for (const entry of value) {
            if (entry === null || entry === undefined) {
                this.#present(entry, elements, `${segment}[]`);
                continue;
            }
            if (!this.number(entry, `${segment}[]`)) {
                continue;
            }
            if (nonNegative && entry < 0) {
                this.error(`expected a non-negative number, got ${entry}`, `${segment}[]`);
            }
        }
    }

    /** Asserts every listed array has the same length; reports the mismatch. */
    parallel(arrays: Record<string, unknown>, segment = ''): number | undefined {
        const lengths: [string, number][] = [];
        for (const [name, value] of Object.entries(arrays)) {
            if (Array.isArray(value)) {
                lengths.push([name, value.length]);
            }
        }
        const first = lengths[0];
        if (!first) {
            return undefined;
        }
        const mismatched = lengths.filter(([, length]) => length !== first[1]);
        if (mismatched.length > 0) {
            const summary = lengths.map(([name, length]) => `${name}=${length}`).join(' ');
            this.error(`parallel arrays disagree on length: ${summary}`, segment);
        }
        return first[1];
    }

    /** Reports any key of `value` not in `known` — the "anything unexpected" rule. */
    noExtraKeys(value: Record<string, unknown>, known: readonly string[], segment = ''): void {
        for (const key of Object.keys(value)) {
            if (!known.includes(key)) {
                this.error(
                    `unexpected key ${JSON.stringify(key)} (${describe(value[key])})`,
                    segment
                );
            }
        }
    }
}

function describe(value: unknown): string {
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return `array(${value.length})`;
    }
    if (typeof value === 'object') {
        return `object{${Object.keys(value).slice(0, 5).join(',')}}`;
    }
    if (typeof value === 'string') {
        return `string(${JSON.stringify(value.slice(0, 40))})`;
    }
    return `${typeof value}(${String(value)})`;
}
