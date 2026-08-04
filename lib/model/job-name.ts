/**
 * Job names: chunk stripping, and pulling the platform and build type out.
 *
 * A Taskcluster test job name looks like
 * `test-linux2404-64-ccov/opt-xpcshell-23`, which is four things run together:
 *
 * | part | example | what it is |
 * | --- | --- | --- |
 * | kind | `test` | `test`, `build`, … |
 * | platform | `linux2404-64-ccov` | OS, bitness and build variant |
 * | build type | `opt` | `opt` or `debug`, after the `/` |
 * | suite | `xpcshell` | the test suite, plus variant suffixes |
 * | chunk | `23` | the chunk number, when the suite is chunked |
 *
 * ## Chunk stripping is load-bearing
 *
 * The 21-day aggregates store job names **already chunk-stripped**; the daily
 * files keep the chunk. `manifests.json` carries both in the same file, and
 * `FORMATS.md` measured the consequence: `runs.jobNameIds[i]` and
 * `tasks.jobName[runs.taskIds[i]]` index the same table and look
 * interchangeable, but differed on 360,373 of 433,836 runs on 2026-08-03 —
 * and agreed on all 433,836 after stripping a trailing `-<digits>`.
 *
 * So this is not cosmetic tidying. Aggregating per configuration wants the
 * stripped name and identifying an individual job wants the chunked one, and
 * using the wrong one silently splits or merges configurations.
 *
 * ## Why stripping is anchored after the `/`
 *
 * `common-test-data.js:80` applies `/-\d+$/` to the whole name. That is
 * correct for every name in the data, because the chunk is always last — but
 * plenty of *platforms* also end in digits (`linux2404-64`,
 * `windows11-32-25h2`, `macosx1470-64`), so a name with no suite part at all
 * would lose a piece of its platform. Anchoring the strip to the part after
 * the `/` makes that impossible rather than merely unobserved. Checked against
 * the 414 distinct job names in the fixtures: the two rules agree on all of
 * them, so this is a narrowing of when the rule applies, not a change of
 * answer.
 *
 * Suffixes that are not numbers (`-msix`, `-swr`, `-no-nv`, `-nofis`) name
 * real configuration variants and are kept — they are the difference between
 * two configs, not two chunks of one.
 */

/**
 * Strips the trailing chunk number from a job name so every chunk of a config
 * aggregates together.
 *
 * `test-linux2404-64-ccov/opt-xpcshell-23` → `test-linux2404-64-ccov/opt-xpcshell`.
 * A name with no chunk, or no `/`, is returned unchanged.
 */
export function stripChunkSuffix(jobName: string): string {
    const slash = jobName.indexOf('/');
    if (slash === -1) {
        // No build-type separator: nothing here is known to be a chunk, and
        // guessing would risk eating part of a platform that ends in digits.
        return jobName;
    }
    const head = jobName.slice(0, slash + 1);
    const tail = jobName.slice(slash + 1);
    return head + tail.replace(/-\d+$/, '');
}

/** The chunk number in a job name, or `null` when it carries none. */
export function chunkNumber(jobName: string): number | null {
    const slash = jobName.indexOf('/');
    if (slash === -1) {
        return null;
    }
    const match = /-(\d+)$/.exec(jobName.slice(slash + 1));
    return match ? Number(match[1]) : null;
}

/** Whether two job names name the same configuration, ignoring chunking. */
export function sameConfiguration(a: string, b: string): boolean {
    return stripChunkSuffix(a) === stripChunkSuffix(b);
}

/** A job name broken into its parts. */
export interface ParsedJobName {
    /** The whole name, unchanged. */
    raw: string;
    /** The name with any chunk suffix removed — the configuration identity. */
    configuration: string;
    /** `test`, `build`, … — the part before the first `-`. `null` if absent. */
    kind: string | null;
    /**
     * The platform as written, e.g. `linux2404-64-ccov`. `null` when the name
     * does not have the `<kind>-<platform>/<buildtype>-...` shape.
     */
    platform: string | null;
    /** The coarse OS: `linux`, `windows`, `mac`, `android`, or `null`. */
    os: OperatingSystem | null;
    /** `opt`, `debug`, or whatever came first after the `/`. `null` if absent. */
    buildType: string | null;
    /**
     * The suite and its variant suffixes, chunk removed: `xpcshell`,
     * `mochitest-browser-chrome-swr`. `null` when there is no `/`.
     */
    suite: string | null;
    /** The chunk number, or `null`. */
    chunk: number | null;
}

/** The coarse operating-system buckets the dashboards group by. */
export type OperatingSystem = 'linux' | 'windows' | 'mac' | 'android';

/**
 * Splits a job name into its parts.
 *
 * Every field is nullable rather than defaulted: a name that does not parse is
 * reported as not parsing, which is what lets a caller notice that job names
 * have changed shape instead of quietly grouping everything under `unknown`.
 * `shared.js:71` returns the literal string `'unknown'` for the platform,
 * which then appears in output as though it were a platform.
 */
export function parseJobName(jobName: string): ParsedJobName {
    const slash = jobName.indexOf('/');
    const configuration = stripChunkSuffix(jobName);
    const chunk = chunkNumber(jobName);

    if (slash === -1) {
        return {
            raw: jobName,
            configuration,
            kind: firstSegment(jobName),
            platform: null,
            os: null,
            buildType: null,
            suite: null,
            chunk,
        };
    }

    const head = jobName.slice(0, slash);
    const tail = jobName.slice(slash + 1).replace(/-\d+$/, '');
    const dash = head.indexOf('-');
    const kind = dash === -1 ? null : head.slice(0, dash);
    const platform = dash === -1 ? null : head.slice(dash + 1);
    const tailDash = tail.indexOf('-');
    const buildType = tailDash === -1 ? tail : tail.slice(0, tailDash);
    const suite = tailDash === -1 ? null : tail.slice(tailDash + 1);

    return {
        raw: jobName,
        configuration,
        kind,
        platform,
        os: platform === null ? null : operatingSystem(platform),
        buildType: buildType === '' ? null : buildType,
        suite,
        chunk,
    };
}

/**
 * The coarse OS a platform string names, or `null` when it names none this
 * function recognizes.
 *
 * Android is checked first because Android platforms carry their own naming
 * (`android-em-14-x86_64`, `android-hw-a55-14-0-aarch64`) and would otherwise
 * fall through. `shared.js:71` makes the same ordering choice, for the same
 * reason.
 */
export function operatingSystem(platform: string): OperatingSystem | null {
    if (platform.includes('android')) {
        return 'android';
    }
    if (platform.includes('linux')) {
        return 'linux';
    }
    // `win32`, `win64`, `windows10`, `windows11` — matching the prefix rather
    // than the full word is what covers all of them.
    if (platform.includes('win')) {
        return 'windows';
    }
    if (platform.includes('macos') || platform.includes('osx')) {
        return 'mac';
    }
    return null;
}

/** The part of a name before the first `-`, or `null` when there is none. */
function firstSegment(name: string): string | null {
    const dash = name.indexOf('-');
    return dash === -1 ? null : name.slice(0, dash);
}
