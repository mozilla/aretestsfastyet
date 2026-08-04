#!/bin/bash
# Mutation campaign for `--coverage` and the `guide` rewrite.
#
# Checked in for the same reason as `tools/mutations-step5.sh`: a mutation score
# is only meaningful if the next person can reproduce it. Each entry is one
# textual substitution that changes behaviour in a way a correct suite should
# notice; `tools/mutate.sh` treats an absent or ambiguous pattern as a hard
# error and runs the whole suite, so nothing can be silently skipped.
#
# What these mutations are aimed at:
#
#  - **Only what the data records.** `--coverage` reports the configs the test
#    was scheduled on and nothing else, so a mutation that invents a row must
#    fail. This is the change: the never-scheduled universe is gone, because
#    enumerating configs that do not exist has no principled boundary.
#  - The **ran/skipped split** in the platform rollup. Folding
#    scheduled-but-skipped into ran loses the only outcome that is someone's
#    work to fix, and dropping it loses it too; both are mutated here.
#  - **No row for a platform with nothing scheduled.** A zero row is the old
#    "these suites do not run on android" line under another name.
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

# --- lib/query/coverage.ts: only what the data records -----------------

# The property that replaced the never-scheduled universe: every row is a
# config the test's own runs name. A mutation that adds a row from anywhere
# else must fail, or the guarantee is a comment.
mutate lib/query/coverage.ts \
    '        for (const target of targets) {' \
    '        for (const target of [...targets, { jobName: "test-ios-18/opt-mochitest-plain", count: 0 }]) {' \
    'a config the test never ran on is added to the matrix'

# --- lib/query/coverage.ts: the platform rollup -------------------------

mutate lib/query/coverage.ts \
    '        if (config.runCount > 0) {
            entry.ranCount++;
        } else {
            entry.skippedCount++;
        }' \
    '        entry.ranCount++;' \
    'skipped-everywhere is folded into ran, reading as full coverage'

mutate lib/query/coverage.ts \
    '        } else {
            entry.skippedCount++;
        }' \
    '        }' \
    'scheduled-but-skipped configs vanish from the rollup'

# A platform with nothing scheduled must produce no row. The mutation adds one
# for every platform the parser knows, which is the old "0 configs" line back.
mutate lib/query/coverage.ts \
    '    const byPlatform = new Map<string, CoveragePlatform>();' \
    '    const byPlatform = new Map<string, CoveragePlatform>([["mac", { platform: "mac", ranCount: 0, skippedCount: 0 }]]);' \
    'a platform with nothing scheduled gets a zero row'

# `platformsInFile` backs the default view's "not android" clause, and
# `unknown` is a parse failure rather than a platform.
mutate lib/query/coverage.ts \
    '        if (os !== '"'"'unknown'"'"') {' \
    '        if (true) {' \
    'a job name that does not parse becomes a platform called "unknown"'

# --- cli/commands/test.ts: the rendered answer --------------------------

# The requirement: usable at a glance, without --limit 0.
mutate cli/commands/test.ts \
    '    lines.push(...renderScheduledPlatforms(coverage));' \
    '' \
    'the platform rollup is not printed at all'

mutate cli/commands/test.ts \
    '                ? '"'"' — scheduled here, but skipped on every config'"'"'' \
    "                ? ''" \
    'a platform where the test is disabled everywhere stops saying so'

mutate cli/commands/test.ts \
    '                  ? ` — ${entry.skippedCount} scheduled but skipped`' \
    "                  ? ''" \
    'a platform row stops reporting its skipped configs'

# The rollup counts scheduled configs, not configs that ran: collapsing the two
# loses the Android-is-disabled-here answer entirely.
mutate cli/commands/test.ts \
    '        const total = entry.ranCount + entry.skippedCount;' \
    '        const total = entry.ranCount;' \
    'the rollup denominator drops the skipped configs'

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
