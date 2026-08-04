#!/bin/bash
# Mutation campaign for the `--coverage` universe fix and the `guide` rewrite.
#
# Checked in for the same reason as `tools/mutations-step5.sh`: a mutation score
# is only meaningful if the next person can reproduce it. Each entry is one
# textual substitution that changes behaviour in a way a correct suite should
# notice; `tools/mutate.sh` treats an absent or ambiguous pattern as a hard
# error and runs the whole suite, so nothing can be silently skipped.
#
# What these mutations are aimed at:
#
#  - The **scope** of the never-scheduled universe. This is the change, and the
#    failure mode it fixes is a plausible-looking wrong number, so the tests
#    have to fail when the scope widens, narrows or is dropped.
#  - The **three-way split** in the platform rollup. Folding
#    scheduled-but-skipped into either neighbour loses the only outcome that is
#    someone's work to fix, and both foldings are mutated here.
#  - The **guide's no-snapshot rule**. Reintroducing a measured count must fail,
#    or the rule is a comment rather than a constraint.
#
# Usage: tools/mutations-coverage-guide.sh [-k]   (-k stops at the first survivor)
#
# NOTE: run this against a clean tree. The harness runs the whole suite, so an
# unrelated failing test makes every mutation look caught.

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
    echo "===== coverage/guide mutation campaign"
    echo "total     $TOTAL"
    echo "killed    $KILLED"
    echo "SURVIVED  $SURVIVED"
    echo "errors    $ERRORS"
    [ -n "$SURVIVOR_LIST" ] && printf '%s' "$SURVIVOR_LIST"
    return 0
}

# --- lib/query/coverage.ts: the universe scope --------------------------

# The bug this whole change fixes: without the suite filter the universe is
# every config in the bucket, which is what produced 453 never-scheduled rows.
mutate lib/query/coverage.ts \
    '            .filter((jobName) => inSuites(jobName, suites))' \
    '            .filter((jobName) => true || inSuites(jobName, suites))' \
    'the suite scope is dropped, restoring the whole-bucket universe'

# The opposite error: a scope so narrow nothing is ever reported missing.
mutate lib/query/coverage.ts \
    '    return suite !== null && suites.has(suite);' \
    '    return false;' \
    'the suite scope excludes everything, so no gap is ever found'

# An unparseable job name must not join a catch-all bucket that widens the
# universe to every other unparseable name.
mutate lib/query/coverage.ts \
    '        if (suite !== null) {' \
    '        if (suite !== null || true) {' \
    'a config with no parseable suite widens the scope'

mutate lib/query/coverage.ts \
    '    return suite !== null && suites.has(suite);' \
    '    return suite === null || suites.has(suite);' \
    'a config with no parseable suite counts as in-scope'

# The scope has to be *reported*, not just applied: a count with no stated
# comparison set is the number the reader cannot check.
mutate lib/query/coverage.ts \
    '        universeSuites = [...suites].sort();' \
    '        universeSuites = [];' \
    'the scope is applied but not reported'

# --- lib/query/coverage.ts: the platform rollup -------------------------

mutate lib/query/coverage.ts \
    '        } else {
            entry.skippedCount++;
        }' \
    '        }' \
    'scheduled-but-skipped configs vanish from the rollup'

mutate lib/query/coverage.ts \
    '        } else if (config.runCount > 0) {
            entry.ranCount++;
        } else {
            entry.skippedCount++;
        }' \
    '        } else {
            entry.ranCount++;
        }' \
    'skipped-everywhere is folded into ran, reading as full coverage'

mutate lib/query/coverage.ts \
    '        if (config.state === '"'"'never-scheduled'"'"') {' \
    '        if (config.state === '"'"'never-scheduled'"'"' || config.runCount === 0) {' \
    'skipped-everywhere is folded into never-scheduled'

mutate lib/query/coverage.ts \
    '            entry.neverConfigs.push(config.jobName);' \
    '            entry.neverConfigs.push(config.jobName.split('"'"'/'"'"')[0]!);' \
    'the never-scheduled names lose their suite half'

# --- cli/commands/test.ts: the rendered answer --------------------------

# The requirement the review set: usable at a glance, without --limit 0.
mutate cli/commands/test.ts \
    '    lines.push(...renderCoverageScope(coverage, limit));' \
    '' \
    'the platform rollup is not printed at all'

mutate cli/commands/test.ts \
    '            `(${truncate(suites.join('"'"', '"'"'), 100)}). Configs running other suites cannot ` +' \
    '            `. Configs running other suites cannot ` +' \
    'the scope line stops naming the suites it compared against'

# The default must not become the old dump.
mutate cli/commands/test.ts \
    '    if (limit === 0) {' \
    '    if (limit >= 0) {' \
    'the never-scheduled names are printed by default again'

mutate cli/commands/test.ts \
    '                : ` — ${notes.join('"'"', '"'"')}`;' \
    "                : '';" \
    'a platform row stops saying what is missing on it'

# The cost of scoping: a platform the suites do not reach must be named, not
# omitted, or "does this run on Android" is answered wrongly by silence.
mutate cli/commands/test.ts \
    '    for (const platform of coverage.absentPlatforms) {
        if (!covered.has(platform)) {' \
    '    for (const platform of []) {
        if (!covered.has(platform)) {' \
    'a platform the suites do not reach is silently omitted'

# …and the de-duplication that stops it contradicting a row above it.
mutate cli/commands/test.ts \
    '        if (!covered.has(platform)) {' \
    '        if (true) {' \
    'a platform gets both a coverage row and an "unreachable" line'

mutate cli/commands/test.ts \
    '        result.coverage = buildCoverage(coverage, result.reach?.absentPlatforms ?? []);' \
    '        result.coverage = buildCoverage(coverage, []);' \
    'the coverage block loses the measured absent platforms'

# --- cli/commands/guide.ts: the no-snapshot rule ------------------------

# The exact class of claim the review objected to. If these survive, the rule
# is a comment rather than a constraint.
mutate cli/commands/guide.ts \
    '            '"'"'A date in `fx-tests dates` does **not** mean it has errors data, and which dates do'"'"',' \
    '            '"'"'The errors files exist for only about 5 of the 21 dates, so a date in dates does'"'"',' \
    'a date census is reintroduced into the errors-window trap'

mutate cli/commands/guide.ts \
    "            'it did not run in no time. Read as real durations, every skipped config becomes'," \
    "            'it did not run: 71,272 of 433,836 runs recorded a zero duration on one day.'," \
    'a raw measured count is reintroduced'

mutate cli/commands/guide.ts \
    "            'Push volume drops several-fold at weekends, so an absolute count from a Saturday'," \
    "            'Push volume drops 2.6% at weekends, so an absolute count from a Saturday'," \
    'a one-day percentage is reintroduced'

# The cut that must stay cut.
mutate cli/commands/guide.ts \
    '        lines.push(`  ${fact.name.padEnd(width)}  ${fact.answers}`);' \
    '        lines.push(`  ${fact.name.padEnd(width)}  ${fact.answers} reads {harness}-{bucket}.json`);' \
    'the per-command file annotations come back into the prose'

# The length budget, which is the constraint the 400-line one failed to be.
mutate cli/commands/guide.ts \
    "    lines.push('TRAPS');" \
    "    lines.push('TRAPS'); for (let i = 0; i < 120; i++) lines.push('padding');" \
    'the guide grows past its line budget'

# The traps CLI.md names as the reason to have a guide at all.
mutate cli/commands/guide.ts \
    "        id: 'perma-fail-rate'," \
    "        id: 'perma-fail-rate-renamed'," \
    'the guide drops the perma-fail-rate trap'

mutate cli/commands/guide.ts \
    "        title: 'A per-test profile URL cannot be guessed'," \
    "        title: 'A per-test profile URL is derivable from the task ID'," \
    'the profiles trap states the opposite of the truth'

# The redirection that replaced the quoted count has to actually point at the
# command that knows.
mutate cli/commands/guide.ts \
    "            'changes — so do not carry a number for it. \`fx-tests errors\` discovers and prints'," \
    "            'changes — so do not carry a number for it. The window is discovered and printed'," \
    'the errors-window trap stops naming the command that reports the window'

summary
[ "$SURVIVED" -eq 0 ] && [ "$ERRORS" -eq 0 ]
