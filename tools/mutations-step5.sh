#!/bin/bash
# The step-5 mutation campaign, driven through tools/mutate.sh.
#
# Checked in rather than kept as a scratch script for one reason: the number a
# campaign produces is only meaningful if the next person can reproduce it.
# Four steps running, a reported mutation score has been wrong, and twice the
# cause was the harness rather than the mutations — most recently because a
# private script ran a subset of the suite. A committed list run through the
# committed harness removes both failure modes.
#
# Each entry is a single textual substitution that changes behaviour in a way a
# correct suite should notice. `tools/mutate.sh` treats an absent or ambiguous
# pattern as a hard error, so a mutation cannot be silently skipped, and it runs
# the whole suite.
#
# Usage: tools/mutations-step5.sh [-k]   (-k stops at the first survivor)

cd "$(dirname "$0")/.." || exit 2
export PATH=/opt/homebrew/Cellar/node@22/22.16.0/bin:$PATH

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
    echo "===== step-5 mutation campaign"
    echo "total     $TOTAL"
    echo "killed    $KILLED"
    echo "SURVIVED  $SURVIVED"
    echo "errors    $ERRORS"
    [ -n "$SURVIVOR_LIST" ] && printf '%s' "$SURVIVOR_LIST"
    return 0
}

# --- lib/formats/errors.ts: the decoder ---------------------------------
mutate lib/formats/errors.ts \
    'forEachDelta(deltas, 0, (taskIdIndex) => {' \
    'deltas.forEach((taskIdIndex) => {' \
    'taskIdIds read as absolute rather than delta-encoded'
mutate lib/formats/errors.ts \
    'totalCount += counts[i]!;' 'totalCount += 1;' \
    'a group total counts entries rather than occurrences'
mutate lib/formats/errors.ts \
    'taskCount: markers.taskIdIds[groupId]!.length,' 'taskCount: 1,' \
    'taskCount hardcoded'
mutate lib/formats/errors.ts \
    'line: messages.lines[messageId] ?? null,' 'line: null,' \
    'a message line is always null'
mutate lib/formats/errors.ts \
    'markerNames: tables.markerNames,' \
    "markerNames: ['C++ warning', 'console.error', 'JavaScript error']," \
    'marker kinds hardcoded instead of read from the file'

# --- lib/query/error-ranking.ts -----------------------------------------
mutate lib/query/error-ranking.ts \
    "const grouping = options.grouping ?? 'location';" \
    "const grouping = options.grouping ?? 'message';" \
    'the default grouping is message rather than location'
mutate lib/query/error-ranking.ts \
    'accumulator.count += group.totalCount;' 'accumulator.count += 1;' \
    'a row counts groups rather than occurrences'
mutate lib/query/error-ranking.ts \
    'testCount: accumulator.perTest.size,' 'testCount: 1,' \
    'the test-spread count is hardcoded'
mutate lib/query/error-ranking.ts \
    '            ? b.testCount - a.testCount || b.count - a.count' \
    '            ? b.count - a.count || b.count - a.count' \
    '--sort tests does nothing'
mutate lib/query/error-ranking.ts \
    'fileCount += group.totalCount;' 'fileCount += 0;' \
    'the file total is always zero'
mutate lib/query/error-ranking.ts \
    "    const prefix = wanted.endsWith('/') ? wanted : \`\${wanted}/\`;
    return path.startsWith(prefix);" \
    '    return path.includes(wanted);' \
    '--test matches any substring'
# The grouping key's separator and absent-sentinel. Both were survivors on the
# first pass: the key is built from invisible control characters, so a
# replacement that collides is easy to write and hard to see.
mutate lib/query/error-ranking.ts \
    "    const absent = '∅';" \
    "    const absent = '';" \
    'the absent-field sentinel becomes the empty string'
mutate lib/query/error-ranking.ts \
    "    const absent = '∅';" \
    "    const absent = ':';" \
    'the absent-field sentinel becomes a character that can occur in data'
mutate lib/query/error-ranking.ts \
    "                \`\${part(message.kind)}\${part(message.text)}\` +
                \`\${part(message.file)}\${part(message.line)}\`" \
    "                \`\${part(message.kind)}\${part(message.text)}\`" \
    'location grouping ignores file and line'
mutate lib/query/error-ranking.ts \
    "    const SEPARATOR = '';" \
    "    const SEPARATOR = ':';" \
    'the key separator becomes a character that can occur in data'

# --- lib/formats/manifests.ts -------------------------------------------
mutate lib/formats/manifests.ts \
    "configuration: at(file.jobNames, runs.jobNameIds[i]!, 'jobNames')," \
    "configuration: at(file.jobNames, taskJobNameId, 'jobNames')," \
    'aggregation keys on the chunked task job name'
mutate lib/formats/manifests.ts \
    'duration: runs.durations[i]!,' 'duration: runs.durations[i]! || 1,' \
    'zero durations become 1ms'

# --- lib/query/manifest-stats.ts: the all-zero rule ---------------------
mutate lib/query/manifest-stats.ts \
    'const skipped = durations.every((duration) => duration === 0);' \
    'const skipped = durations.some((duration) => duration === 0);' \
    'the skip rule uses some() rather than every()'
mutate lib/query/manifest-stats.ts \
    'const skipped = durations.every((duration) => duration === 0);' \
    'const skipped = false;' \
    'the skip rule is disabled, so zeros become real durations'
mutate lib/query/manifest-stats.ts \
    '                    durations: null,
                });
                continue;' \
    '                    durations: summarize(durations),
                });
                continue;' \
    'a skipped config reports a zero median rather than nothing'
mutate lib/query/manifest-stats.ts \
    '    const aMedian = a.durations?.median ?? -1;
    const bMedian = b.durations?.median ?? -1;' \
    '    const aMedian = a.durations?.median ?? Infinity;
    const bMedian = b.durations?.median ?? Infinity;' \
    'skipped configs sort first rather than last'
mutate lib/query/manifest-stats.ts \
    '        if (row.durations === null) {
            return -1;
        }' \
    '        if (row.durations === null) {
            return Infinity;
        }' \
    'manifests skipped everywhere sort first'
mutate lib/query/manifest-stats.ts \
    'const rank = Math.ceil(q * sorted.length);' \
    'const rank = Math.floor(q * sorted.length);' \
    'the quantile is off by one'

# --- lib/model/crash-signature.ts ---------------------------------------
mutate lib/model/crash-signature.ts \
    '        for (const inline of frame.inlines ?? []) {
            flattened.push(inline.function);
        }
        flattened.push(frameName(frame));' \
    '        flattened.push(frameName(frame));
        for (const inline of frame.inlines ?? []) {
            flattened.push(inline.function);
        }' \
    'inlines are flattened after their parent rather than before'
mutate lib/model/crash-signature.ts \
    'const match = /(.*)\\(.*\\)/.exec(signature);' \
    'const match = /(.*?)\\(.*\\)/.exec(signature);' \
    'parameter stripping is made lazy'
mutate lib/model/crash-signature.ts \
    'if (!isAbortFrame(name)) {' 'if (true) {' \
    'abort frames are no longer skipped'
mutate lib/model/crash-signature.ts \
    'ABORT_SUBSTRINGS.some((fragment) => name.includes(fragment))' 'false' \
    'abort substring matching is disabled'
mutate lib/model/crash-signature.ts \
    "    return frame.function || \`\${frame.module} + \${frame.module_offset}\`;" \
    "    return frame.function ?? \`\${frame.module} + \${frame.module_offset}\`;" \
    'frameName uses ?? rather than ||, diverging on an empty function name'
mutate lib/model/crash-signature.ts \
    "nullPointer: adjusted?.kind === 'null-pointer'," 'nullPointer: false,' \
    'null-pointer detection is disabled'
mutate lib/model/crash-signature.ts \
    'if (!hasBreakpadFrames(crashing)) {' 'if (false) {' \
    'hang detection always fires'
mutate lib/model/crash-signature.ts \
    '        if (frame.function === null) {
            continue;
        }' \
    '' \
    'parkedIn stops at an unsymbolized frame'
mutate lib/model/crash-signature.ts \
    'thread.frames.slice(0, BLOCKED_FRAME_DEPTH)' 'thread.frames' \
    'blocked detection scans the whole stack'
mutate lib/model/crash-signature.ts \
    "    'MutexImpl::lock',
" '' \
    'a blocked-frame fragment is dropped'

# --- cli/commands/errors.ts ---------------------------------------------
mutate cli/commands/errors.ts \
    "const harness: Harness = context.globals.harness ?? 'mochitest';" \
    "const harness: Harness = context.globals.harness ?? 'xpcshell';" \
    'errors defaults to xpcshell'
mutate cli/commands/errors.ts \
    "failingTestsOnly: harness === 'xpcshell'," 'failingTestsOnly: false,' \
    'the xpcshell sampling bias is never reported'
mutate cli/commands/errors.ts \
    'const DEFAULT_LIMIT = 20;' 'const DEFAULT_LIMIT = 5;' \
    'the default row limit changes'
mutate cli/commands/errors.ts \
    'if (context.globals.since !== undefined) {' 'if (false) {' \
    '--since is silently ignored'
mutate cli/commands/errors.ts \
    '!decoded.markerNames.includes(kindOption)' 'false' \
    'an unknown --kind yields an empty ranking rather than an error'

# --- cli/commands/manifests.ts ------------------------------------------
mutate cli/commands/manifests.ts \
    "        case 's':
        case undefined:
        default:
            return amount * 1000;" \
    "        case 's':
        case undefined:
        default:
            return amount;" \
    'a bare --slower-than is read as milliseconds'
mutate cli/commands/manifests.ts \
    'if (context.globals.day !== undefined || context.globals.since !== undefined) {' \
    'if (false) {' \
    '--day and --since are silently ignored'
mutate cli/commands/manifests.ts \
    "    if (ms === null || ms === undefined) {
        return '—';
    }" \
    "    if (ms === null || ms === undefined) {
        return '0ms';
    }" \
    'an absent duration renders as zero'

# --- cli/commands/crash.ts ----------------------------------------------
mutate cli/commands/crash.ts \
    'const DEFAULT_FRAMES_ALL = 8;' 'const DEFAULT_FRAMES_ALL = 20;' \
    '--all-threads uses 20 frames'
mutate cli/commands/crash.ts \
    'const DEFAULT_FRAMES_SINGLE = 20;' 'const DEFAULT_FRAMES_SINGLE = 8;' \
    'the single-thread default is shallower'
mutate cli/commands/crash.ts \
    'throw goneError(' 'throw upstreamError(' \
    'a missing artifact exits 3 rather than 4'
mutate cli/commands/crash.ts \
    'error.status === 403' 'error.status === 404' \
    'the 403 hint is re-keyed to 404, so a 403 gets the generic message'
mutate cli/commands/crash.ts \
    'taskArtifactName(taskId, retryId, `public/test_info/${minidumpId}.json`)' \
    'taskArtifactName(taskId, 0, `public/test_info/${minidumpId}.json`)' \
    'the retry is ignored in the artifact URL'
mutate cli/commands/crash.ts \
    'if (allThreads && threadIndex !== undefined) {' 'if (false) {' \
    '--all-threads with --thread is accepted'

# --- cli/commands/issues.ts ---------------------------------------------
mutate cli/commands/issues.ts \
    '        !canAttributeConfigs(file)
    ) {' \
    '        false
    ) {' \
    '--config is accepted on issues.json'
mutate cli/commands/issues.ts \
    'if (wantMinidumps && !query.header.recordsMinidumps) {' 'if (false) {' \
    '--minidumps is accepted on issues.json'
mutate cli/commands/issues.ts \
    "return file.family !== 'issues';" 'return true;' \
    'recordsMinidumps is always true'
mutate cli/commands/issues.ts \
    'canAttributeConfigs: canAttributeConfigs(file),' 'canAttributeConfigs: true,' \
    'the header claims configurations are attributable'
# The prose half of the same guard. Only the --config usage error was tested on
# the first pass, so the notice could be corrupted with the suite green.
mutate cli/commands/issues.ts \
    "            '  This file records no job names, so nothing here can be broken down by ' +
                'configuration.'" \
    "            '  (nothing to report here)'" \
    'the no-job-names notice is replaced by something uninformative'
mutate cli/commands/issues.ts \
    '    if (!header.canAttributeConfigs) {' '    if (false) {' \
    'the no-job-names notice is never printed'
mutate cli/commands/issues.ts \
    "        return ['fail', 'timeout', 'crash'];" \
    "        return ['fail', 'timeout', 'crash', 'skip'];" \
    'the default --type includes skip'
mutate cli/commands/issues.ts \
    "    const runIfIsUpstreamFiltered = query.file.family !== 'daily';" \
    '    const runIfIsUpstreamFiltered = false;' \
    'the run-if asymmetry note is wrong for aggregates'

# --- cli/commands/guide.ts ----------------------------------------------
mutate cli/commands/guide.ts \
    "        defaultHarness: 'mochitest'," '' \
    'the guide drops the errors-defaults-to-mochitest fact'
mutate cli/commands/guide.ts \
    "        reads: '{harness}-{date}-errors.json'," \
    "        reads: '{harness}-issues.json'," \
    'the guide says errors reads the issues file'
mutate cli/commands/guide.ts \
    "        reads: 'manifests.json'," "        reads: '{harness}-stats.json'," \
    'the guide says manifests reads the stats file'
mutate cli/commands/guide.ts \
    '        code: ExitCode.Gone,' '        code: 99,' \
    'the guide states an exit code that does not exist'
mutate cli/commands/guide.ts \
    "        id: 'errors-window'," "        id: 'errors-window-renamed'," \
    'the guide drops the errors-window trap'
mutate cli/commands/guide.ts \
    "'fx-tests test <path> --coverage'," "'fx-tests test <path> --covrage'," \
    'a guide workflow typos a real flag'

summary
[ "$SURVIVED" -eq 0 ] && [ "$ERRORS" -eq 0 ]
