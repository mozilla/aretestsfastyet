#!/bin/bash
# Mutation campaign for the two try-command bug fixes:
#
#   1. failure messages read off the `TestStatus` markers, and the
#      perma-fail classification asked per configuration
#   2. path columns truncated from the left, so the filename survives
#
# Same rules as tools/mutations-step5.sh, and the same reason for being
# checked in: a mutation score nobody can reproduce is not a number. Each entry
# is one textual substitution that changes behaviour; `tools/mutate.sh` treats
# an absent or ambiguous pattern as a hard error and runs the whole suite.
#
# Usage: tools/mutations-trybugs.sh [-k]   (-k stops at the first survivor)

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
    echo "===== try-bugs mutation campaign"
    echo "total     $TOTAL"
    echo "killed    $KILLED"
    echo "SURVIVED  $SURVIVED"
    echo "errors    $ERRORS"
    [ -n "$SURVIVOR_LIST" ] && printf '%s' "$SURVIVOR_LIST"
    return 0
}

# --- bug 1a: where the failure message comes from -----------------------

# The whole fix, removed: back to reading only the Test marker's own field.
mutate cli/commands/try.ts \
    '            message = messageInRange(fullTestId, start, end) ?? message;' \
    '' \
    'the TestStatus messages are never consulted'

# The precedence: the harness leaves stale text on some Test markers, and
# try.html:983 assigns the TestStatus message *over* it.
mutate cli/commands/try.ts \
    '            message = messageInRange(fullTestId, start, end) ?? message;' \
    '            message = message ?? messageInRange(fullTestId, start, end);' \
    'the Test marker message wins over the TestStatus one'

# The marker *name* is what identifies a TestStatus marker worth reading.
mutate cli/commands/try.ts \
    '        if (nameId !== failStringId && nameId !== errorStringId) {' \
    '        if (nameId !== failStringId) {' \
    'ERROR-named TestStatus markers are dropped'

# The owning test, not merely the time range: two tests overlap under
# parallel execution.
mutate cli/commands/try.ts \
    '            (marker) => marker.test === test && marker.time >= start && marker.time <= end' \
    '            (marker) => marker.time >= start && marker.time <= end' \
    'a neighbouring test’s message is attributed to this one'

# The range bounds, which decide which execution a message belongs to.
mutate cli/commands/try.ts \
    '            (marker) => marker.test === test && marker.time >= start && marker.time <= end' \
    '            (marker) => marker.test === test && marker.time >= start' \
    'a message from a later execution is taken'

# Only failing statuses gather messages.
mutate cli/commands/try.ts \
    "        if (status.startsWith('FAIL') || status.startsWith('TIMEOUT') || status === 'ERROR') {" \
    '        if (true) {' \
    'passes gather a failure message too'

# --- bug 1b: the perma-fail question is per configuration ---------------

# A config with a fully successful run is not perma-failing. There is no
# explicit guard for this — `runsPerJobName` counts successes in the
# denominator, so the run comparison below already excludes it. The mutation
# that belongs here is on the denominator, which is what does the work.
mutate cli/commands/try.ts \
    '            const runsOfConfig = runsPerJobName.get(jobName) ?? 0;' \
    '            const runsOfConfig = entry.failedRunsByJobName.get(jobName)?.size ?? 0;' \
    'the denominator counts only failing runs, so every config perma-fails'

# A config the harness's rerun turned green is not perma-failing.
mutate cli/commands/try.ts \
    '            if (entry.passedOnRerunByJobName.get(jobName) === true) {' \
    '            if (false) {' \
    'a config whose rerun passed still counts as perma-failing'

# Every run of the config, not merely one.
mutate cli/commands/try.ts \
    '            return runsOfConfig > 0 && failed >= runsOfConfig;' \
    '            return runsOfConfig > 0 && failed > 0;' \
    'one failing run of a config is treated as every run'

# The per-config rule itself: back to the whole-test AND.
mutate cli/commands/try.ts \
    '            everyRunFailed: permaFailingConfigs.length > 0,' \
    '            everyRunFailed: permaFailingConfigs.length === jobNames.length,' \
    'a test is only permanent when every config of it is'

# The central check is scoped to the perma-failing configs.
mutate cli/commands/try.ts \
    '                permaConfigNames.has(config.jobName)' \
    '                true' \
    'the central check goes back to spanning every config'

# The chunk suffix has to come off before the names can be compared.
mutate cli/commands/try.ts \
    '                failure.permaFailingConfigs.map(stripChunkSuffix)' \
    '                failure.permaFailingConfigs' \
    'perma-config names are matched without stripping the chunk suffix'

# The conservative fallback when central attributed no runs to those configs.
mutate cli/commands/try.ts \
    '        central.sameMessageFailCountOnPermaConfigs ?? central.sameMessageFailCount;' \
    '        central.sameMessageFailCountOnPermaConfigs ?? 0;' \
    'an unattributable config exonerates nothing at all'

# The uncomparable guard, which the message fix must not have made dead.
mutate cli/commands/try.ts \
    '    if (!failure.messageComparable) {
        return false;
    }
    // Restricted to the configs' \
    '    if (false) {
        return false;
    }
    // Restricted to the configs' \
    'a failure with no message can still be a perma-fail'

# --- bug 2: paths truncate from the left --------------------------------

mutate cli/format/text.ts \
    '            return column?.path === true ? truncatePath(cell, max) : truncate(cell, max);' \
    '            return truncate(cell, max);' \
    'path columns fall back to cutting the filename'

mutate cli/format/text.ts \
    '        if (candidate.length + 2 > maxWidth) {' \
    '        if (candidate.length > maxWidth) {' \
    'the ellipsis prefix is not counted against the budget'

# The basename is what must survive; keeping the head instead loses it.
mutate cli/format/text.ts \
    '        return `…${basename.slice(Math.max(0, basename.length - (maxWidth - 1)))}`;' \
    '        return truncate(basename, maxWidth);' \
    'an over-long basename keeps its head rather than its tail'

# A path that fits is returned untouched, so `…/` means something.
mutate cli/format/text.ts \
    '    if (maxWidth <= 0 || value.length <= maxWidth) {
        return value;
    }
    const segments = value.split(' \
    '    if (maxWidth <= 0) {
        return value;
    }
    const segments = value.split(' \
    'a path that already fits is still marked as cut'

mutate cli/commands/issues.ts \
    '                truncatePath(String(row.test), 62),' \
    '                truncate(String(row.test), 62),' \
    'the issues Test column cuts the filename again'

mutate cli/commands/manifests.ts \
    '                truncatePath(row.manifest, 56),' \
    '                truncate(row.manifest, 56),' \
    'the manifests column cuts the filename again'

summary
[ "$SURVIVED" -eq 0 ] && [ "$ERRORS" -eq 0 ]
