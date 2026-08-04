#!/bin/bash
# Mutation campaign for the try/try.html divergence fixes:
#
#   1. the default ordering — failing executions descending, as the page's
#      `{ column: 'count', ascending: false }` default sorts (try.html:744),
#      with a deterministic path tiebreak the page cannot have
#   2. the rerun sentence scoped to the configurations it applies to, so a
#      perma-fail row does not appear to contradict itself
#
# Same rules as tools/mutations-trybugs.sh, and the same reason for being
# checked in: a mutation score nobody can reproduce is not a number. Each entry
# is one textual substitution that changes behaviour; `tools/mutate.sh` treats
# an absent or ambiguous pattern as a hard error and runs the whole suite.
#
# Usage: tools/mutations-try-ordering.sh [-k]   (-k stops at the first survivor)

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
    echo "===== try-ordering mutation campaign"
    echo "total     $TOTAL"
    echo "killed    $KILLED"
    echo "SURVIVED  $SURVIVED"
    echo "errors    $ERRORS"
    [ -n "$SURVIVOR_LIST" ] && printf '%s' "$SURVIVOR_LIST"
    return 0
}

# --- 1: the default ordering --------------------------------------------

# The whole fix: back to ranking on distinct failing job runs, which is what
# made the section order differ from the page's on every push where the
# harness reran a test.
mutate cli/commands/try.ts \
    '        (a, b) => b.failureCount - a.failureCount || a.path.localeCompare(b.path)' \
    '        (a, b) => b.failedRuns - a.failedRuns || a.path.localeCompare(b.path)' \
    'ranking is on job runs again, not on failing executions'

# The direction. Ascending puts the least interesting failure first.
mutate cli/commands/try.ts \
    '        (a, b) => b.failureCount - a.failureCount || a.path.localeCompare(b.path)' \
    '        (a, b) => a.failureCount - b.failureCount || a.path.localeCompare(b.path)' \
    'the count sorts ascending'

# The tiebreak, which is what makes the output reproducible.
mutate cli/commands/try.ts \
    '        (a, b) => b.failureCount - a.failureCount || a.path.localeCompare(b.path)' \
    '        (a, b) => b.failureCount - a.failureCount' \
    'ties are left in insertion order, as the page leaves them'

# The counter itself: one per failing execution, not one per test.
mutate cli/commands/try.ts \
    '        entry.failureCount++;' \
    '        entry.failureCount = 1;' \
    'every test reports a single failure'

# --- 2: the rerun sentence, scoped --------------------------------------

# The scoping, removed: back to a sentence that names no configuration.
mutate cli/commands/try.ts \
    '    return `Passed when the harness reran it in the same job on ${where} — intermittent there.`;' \
    '    return `Passed when the harness reran it in the same job — intermittent.`;' \
    'the rerun sentence names no configuration'

# The filter that decides which configs go in the sentence.
mutate cli/commands/try.ts \
    '            .filter(([, passed]) => passed)' \
    '            .filter(() => true)' \
    'configs the rerun did not rescue are named as rescued'

# The line is emitted at all.
mutate cli/commands/try.ts \
    '    if (configs.length === 0) {' \
    '    if (configs.length >= 0) {' \
    'the rerun line is never printed'

# The perma-failing config has to be named alongside it, or the row states
# only where the rerun passed and reads as contradicting its own section.
mutate cli/commands/try.ts \
    '                failure.passedOnRerunConfigs.length > 0)' \
    '                false)' \
    'the permanent config is unnamed when the rerun rescued another'

summary
exit $((SURVIVED > 0 ? 1 : 0))
