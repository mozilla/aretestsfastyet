#!/bin/bash
# Mutation campaign for the per-task-artifact cache and the Treeherder rule.
#
# The bug: `fx-tests try <rev>` re-downloaded every job profile on every run,
# because per-task artifacts bypassed the disk cache entirely. Measured on try
# push 7d16bff8 before the fix — 46 profiles, 828 MB, 48 requests on the warm
# run of which 46 were profiles.
#
# Checked in for the same reason as the other campaigns in this directory: a
# mutation score nobody can reproduce is not a number.
#
# **Run this against a clean tree.** `tools/mutate.sh` decides a mutation was
# caught by looking at whether the suite failed, so a tree that was already
# failing reports every mutation as caught and the campaign is worthless. This
# one was run in a throwaway worktree at the commit under test, verified green
# before the first mutation. That is not a formality: while this was being
# written the shared checkout had another agent's in-flight work in it, and the
# suite in that checkout had 62 failures.
#
# Usage: tools/mutations-artifact-cache.sh [-k]   (-k stops at the first survivor)

cd "$(dirname "$0")/.." || exit 2
# See tools/node-env.sh: resolves node without naming a specific install.
. "$(dirname "$0")/node-env.sh"

STOP_ON_SURVIVOR=0
[ "${1:-}" = "-k" ] && STOP_ON_SURVIVOR=1

TOTAL=0
KILLED=0
SURVIVED=0
ERRORS=0
SURVIVOR_LIST=""

mutate() {
    TOTAL=$((TOTAL + 1))
    tools/mutate.sh "$1" "$2" "$3" "$4"
    case $? in
        0) KILLED=$((KILLED + 1)) ;;
        1)
            SURVIVED=$((SURVIVED + 1))
            SURVIVOR_LIST="${SURVIVOR_LIST}  $4 ($1)"$'\n'
            [ "$STOP_ON_SURVIVOR" = "1" ] && summary && exit 1
            ;;
        *) ERRORS=$((ERRORS + 1)) ;;
    esac
}

summary() {
    echo
    echo "===== artifact-cache mutation campaign"
    echo "total     $TOTAL"
    echo "killed    $KILLED"
    echo "SURVIVED  $SURVIVED"
    echo "errors    $ERRORS"
    [ -n "$SURVIVOR_LIST" ] && printf '%s' "$SURVIVOR_LIST"
    return 0
}

# --- the cache read and write paths -------------------------------------

# The whole bug, reintroduced: never serve a cached artifact.
mutate cli/cache.ts \
    '        const cached = await cache.getArtifact(url);
        if (cached !== null) {
            hooks.onHit?.(url);
            return cached;
        }' \
    '        const cached = null;
        if (cached !== null) {
            hooks.onHit?.(url);
            return cached;
        }' \
    'the artifact cache is never read — the original bug'

# The other half: fetch, use, but never write.
mutate cli/cache.ts \
    '            await cache.putArtifact(url, bytes);' \
    '            void bytes;' \
    'the artifact cache is never written'

# A constant key. Every single-artifact test still passes; two jobs share one
# entry, so one job's profile is served for another's.
mutate cli/cache.ts \
    "    return createHash('sha256').update(\`url:\${url}\`).digest('hex').slice(0, 32);" \
    "    return createHash('sha256').update('url:constant').digest('hex').slice(0, 32);" \
    'every artifact hashes to the same cache entry'

# The prefix that keeps the two key spaces apart.
mutate cli/cache.ts \
    "    return createHash('sha256').update(\`url:\${url}\`).digest('hex').slice(0, 32);" \
    "    return createHash('sha256').update(url).digest('hex').slice(0, 32);" \
    'the artifact key space can collide with the aggregates'

# --- negative caching, which must not happen ----------------------------

# Cache the `null`. A 404 and a 503 are the same value here, so this turns a
# transient outage into a permanent-looking one.
mutate cli/cache.ts \
    '        if (bytes === null) {
            return null;
        }' \
    '        if (bytes === null) {
            await cache.putArtifact(url, new Uint8Array(0));
            return null;
        }' \
    'a failed artifact fetch is cached as an empty entry'

# --- immutability: no TTL on an artifact --------------------------------

# Give the artifact the aggregates' TTL. A warm run past 12 hours re-downloads
# 828 MB to learn nothing.
mutate cli/cache.ts \
    '            if (meta === null || !isImmutableKind(meta.kind)) {
                return null;
            }
            return readBytes(hash);' \
    '            if (meta === null || !isImmutableKind(meta.kind)) {
                return null;
            }
            if (now() - Date.parse(meta.fetchedAt) > ttlMs) {
                return null;
            }
            return readBytes(hash);' \
    'a task artifact expires on the aggregate TTL'

# Drop the kind check, so an aggregate entry can be served as immutable — that
# is, served past the TTL it was written under.
mutate cli/cache.ts \
    '            if (meta === null || !isImmutableKind(meta.kind)) {' \
    '            if (meta === null) {' \
    'an aggregate entry is readable as an immutable artifact'

# The kind predicate itself.
mutate cli/cache.ts \
    '    return kind === TASK_ARTIFACT_KIND;' \
    '    return kind !== TASK_ARTIFACT_KIND;' \
    'the immutable-kind test is inverted'

# --- the error types the separate source exists for ---------------------

# Swallow the 404 into a cache miss. `fx-tests crash` would stop reporting
# exit 4 for an expired artifact.
mutate cli/cache.ts \
    '            const bytes = await inner.fetch(name);
            try {
                await cache.putArtifact(key, bytes);' \
    '            let bytes: Uint8Array;
            try {
                bytes = await inner.fetch(name);
            } catch {
                return new Uint8Array(0);
            }
            try {
                await cache.putArtifact(key, bytes);' \
    'the task-artifact source swallows 404 and 5xx alike'

# --- the budget ---------------------------------------------------------

mutate cli/cache.ts \
    '            if (total <= artifactBudgetBytes) {
                return 0;
            }' \
    '            if (total >= 0) {
                return 0;
            }' \
    'pruning never runs, so the artifact cache is unbounded'

# Evict the newest first, which throws away exactly the push you are looking at.
mutate cli/cache.ts \
    '            artifacts.sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt));' \
    '            artifacts.sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt));' \
    'pruning evicts the newest artifacts rather than the oldest'

# Prune the aggregates too, which costs a 13 MB re-download and buys nothing.
mutate cli/cache.ts \
    '            const artifacts = (await self.list()).filter((entry) =>
                isImmutableKind(entry.kind)
            );' \
    '            const artifacts = await self.list();' \
    'pruning evicts the aggregates as well'

# A budget small enough to evict the push that was just fetched.
mutate cli/cache.ts \
    'export const DEFAULT_ARTIFACT_BUDGET_BYTES = 4 * 1024 * 1024 * 1024;' \
    'export const DEFAULT_ARTIFACT_BUDGET_BYTES = 4 * 1024 * 1024;' \
    'the default budget cannot hold one push'

# --- Treeherder: settled, and only settled ------------------------------

# Cache a running push. `try` reads only completed jobs, so this reports the
# failures that had landed by then and calls the rest of the push clean.
mutate cli/cache.ts \
    '            if (!isSettledPush(jobs)) {' \
    '            if (false) {' \
    'a push still running is cached'

# `some` rather than `every`: one finished job makes the whole push settled.
mutate cli/cache.ts \
    "    return jobs.length > 0 && jobs.every((job) => TERMINAL_JOB_STATES.has(job.state));" \
    "    return jobs.length > 0 && jobs.some((job) => TERMINAL_JOB_STATES.has(job.state));" \
    'one completed job makes a whole push settled'

# An empty job list counts as settled, pinning "this push has no jobs".
mutate cli/cache.ts \
    "    return jobs.length > 0 && jobs.every((job) => TERMINAL_JOB_STATES.has(job.state));" \
    "    return jobs.every((job) => TERMINAL_JOB_STATES.has(job.state));" \
    'a push with no jobs at all counts as settled'

# Treat `running` as terminal, which is the near-miss version of the rule.
mutate cli/cache.ts \
    "const TERMINAL_JOB_STATES: ReadonlySet<string> = new Set(['completed']);" \
    "const TERMINAL_JOB_STATES: ReadonlySet<string> = new Set(['completed', 'running']);" \
    'a running job counts as terminal'

# Never read the cached job list.
mutate cli/cache.ts \
    '            const cached = await cache.getPushJobs(key);' \
    '            const cached = null;' \
    'the cached job list is never read'

# One key for every push: push 1's jobs served for push 2.
mutate cli/cache.ts \
    '            const key = `treeherder:jobs:${pushId}`;' \
    "            const key = 'treeherder:jobs';" \
    'every push shares one job-list entry'

# The settled-push entry never expires, so a retrigger is invisible forever.
mutate cli/cache.ts \
    '            if (!Number.isFinite(age) || age < 0 || age > SETTLED_PUSH_TTL_MS) {
                return null;
            }
            return readBytes(hash);' \
    '            void age;
            return readBytes(hash);' \
    'a settled push is cached forever, so a retrigger is never seen'

mutate cli/cache.ts \
    'export const SETTLED_PUSH_TTL_MS = 24 * 60 * 60 * 1000;' \
    'export const SETTLED_PUSH_TTL_MS = 24 * 60 * 60 * 1000 * 365;' \
    'the settled-push TTL is a year rather than a day'

# --- --no-cache and --cache-dir -----------------------------------------

mutate cli/main.ts \
    '    if (globals.noCache) {
        return http;
    }
    return cachedArtifactFetcher(http, cache, {' \
    '    if (false) {
        return http;
    }
    return cachedArtifactFetcher(http, cache, {' \
    '--no-cache still caches artifacts'

mutate cli/main.ts \
    '    const source = taskArtifactSource({ fetch: http });
    if (globals.noCache) {
        return source;
    }' \
    '    const source = taskArtifactSource({ fetch: http });
    if (false) {
        return source;
    }' \
    '--no-cache still caches crash dumps'

mutate cli/main.ts \
    '    const client = treeherderClient({ fetch: http });
    if (globals.noCache) {
        return client;
    }' \
    '    const client = treeherderClient({ fetch: http });
    if (false) {
        return client;
    }' \
    '--no-cache still caches the job list'

# The artifact cache must use the cache `--cache-dir` built, not a fresh
# default one — which would write to the developer's real cache directory.
mutate cli/main.ts \
    '    return cachedArtifactFetcher(http, cache, {' \
    '    return cachedArtifactFetcher(http, diskCache(), {' \
    'artifacts are cached in the default directory, ignoring --cache-dir'

# --- the URL the cache keys on ------------------------------------------

# Drop the retry from the artifact URL: two runs of one task share an entry.
mutate lib/sources/http.ts \
    '    return `${root}/api/queue/v1/task/${name.index}/${name.filename}`;' \
    "    return \`\${root}/api/queue/v1/task/\${name.index}/\${name.filename.replace(/runs\\/\\d+/, 'runs/0')}\`;" \
    'the retry number is dropped from the artifact URL'

# --- what `fx-tests cache` reports --------------------------------------

mutate cli/commands/cache.ts \
    '    const artifacts = entries.filter((entry) => isImmutableKind(entry.kind));' \
    '    const artifacts = entries;' \
    'the task-artifact total counts every entry'

mutate cli/commands/cache.ts \
    '    const match = /\/task\/([^/]+)\/runs\/(\d+)\/artifacts\/(.+)$/.exec(key);' \
    '    const match = null;' \
    'the listing shows the raw URL, so every artifact row looks alike'

mutate cli/commands/cache.ts \
    '    return `${match[1]}.${match[2]} ${match[3]}`;' \
    '    return `${match[3]}`;' \
    'the listing drops the task ID, which is the identifying part'

summary
[ "$SURVIVED" -eq 0 ] && [ "$ERRORS" -eq 0 ]
