#!/bin/bash
# Mutation campaign for the issues-triage and path-column work:
#
#   1. `issues` leads with the component ranking, counting all four outcomes,
#      with the dashboard's denominators
#   2. path/identifier columns size themselves to their content, and recover
#      whatever a cap cuts
#   3. every ranked table names the column it is ordered by
#
# Same rules as the other campaigns, and the same reason for being checked in:
# a mutation score nobody can reproduce is not a number. Each entry is one
# textual substitution that changes behaviour; `tools/mutate.sh` treats an
# absent or ambiguous pattern as a hard error and runs the whole suite.
#
# Usage: tools/mutations-issues-triage.sh [-k]   (-k stops at the first survivor)

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
            SURVIVOR_LIST="$SURVIVOR_LIST
  $4"
            [ "$STOP_ON_SURVIVOR" = "1" ] && summary && exit 1
            ;;
        *) ERRORS=$((ERRORS + 1)) ;;
    esac
}

summary() {
    echo
    echo "=== $KILLED/$TOTAL caught, $SURVIVED survived, $ERRORS errors ==="
    [ -n "$SURVIVOR_LIST" ] && echo "survivors:$SURVIVOR_LIST"
}

# --- the issue definition: all four outcomes, as the page's checkboxes are ---

mutate lib/query/issues.ts \
    "export const DEFAULT_TYPES: readonly IssueType[] = ['fail', 'timeout', 'crash', 'skip'];" \
    "export const DEFAULT_TYPES: readonly IssueType[] = ['fail', 'timeout', 'crash'];" \
    'DEFAULT_TYPES drops skip, the largest of the four'

mutate lib/query/issues.ts \
    "        (types.has('skip') ? counts.skipCount : 0) +" \
    "        0 +" \
    'issueCountOf ignores skips'

mutate lib/query/issues.ts \
    "        (types.has('crash') ? counts.crashCount : 0)" \
    "        0" \
    'issueCountOf ignores crashes'

mutate lib/query/issues.ts \
    "    const rateDenominator = row.runCount + (types.has('skip') ? row.skipCount : 0);" \
    "    const rateDenominator = row.runCount;" \
    'the rate denominator omits skips even when they are counted'

# --- the component ranking, and its denominators ---

mutate lib/query/issues.ts \
    "    out.sort((a, b) => b.issueCount - a.issueCount || a.key.localeCompare(b.key));" \
    "    out.sort((a, b) => b.failRate - a.failRate || a.key.localeCompare(b.key));" \
    'components ranked by fail rate rather than issue count'

mutate lib/query/issues.ts \
    "        group.totalTestCount += 1;
        if (row.issueCount > 0) {
            group.testCount += 1;
        }" \
    "        group.totalTestCount += 1;
        group.testCount += 1;" \
    'testCount counts clean tests too, losing the "out of" distinction'

mutate lib/query/issues.ts \
    "        const denominator = group.runCount + (enabled.has('skip') ? group.skipCount : 0);" \
    "        const denominator = group.runCount;" \
    'the group rate denominator omits skips'

mutate lib/query/issues.ts \
    "    const out = [...groups.values()].filter((group) => group.testCount > 0);" \
    "    const out = [...groups.values()];" \
    'components with no affected test are listed anyway'

mutate lib/query/issues.ts \
    "        if (row.issueCount === 0 && options.keepClean !== true) {" \
    "        if (row.issueCount === 0) {" \
    'keepClean is ignored, narrowing every group denominator'

# --- the CLI defaults ---

mutate cli/commands/issues.ts \
    "    const groupBy = readGroupBy(args, ['component', 'test', 'directory', 'message'], 'component');" \
    "    const groupBy = readGroupBy(args, ['component', 'test', 'directory', 'message'], 'test');" \
    'issues defaults back to the flat per-test list'

mutate cli/commands/issues.ts \
    "    const sort = readSort(args, ['issues', 'rate', 'count', 'name'], 'issues');" \
    "    const sort = readSort(args, ['issues', 'rate', 'count', 'name'], 'rate');" \
    'issues defaults to rate rather than issue count'

mutate cli/commands/issues.ts \
    "        ...(grouped && minRate === undefined ? { keepClean: true } : {})," \
    "        ...(false ? { keepClean: true } : {})," \
    'the grouped views stop keeping clean tests for the denominator'

mutate cli/commands/issues.ts \
    "        sorted.sort((a, b) => b.issueCount - a.issueCount || a.fullPath.localeCompare(b.fullPath));" \
    "        sorted.sort((a, b) => a.fullPath.localeCompare(b.fullPath));" \
    '--sort issues on the per-test view orders by name instead'

# --- path columns size themselves, and recover what the cap cuts ---

mutate cli/format/text.ts \
    "                  Math.max(0, ...rows.map((row) => (row[i] ?? '').length))" \
    "                  56" \
    'the path column returns to a hardcoded 56 columns'

mutate cli/format/text.ts \
    "export const PATH_COLUMN_CAP = 128;" \
    "export const PATH_COLUMN_CAP = 40;" \
    'the cap is tight enough to cut real paths'

mutate cli/format/text.ts \
    "            const cut = truncatePath(cell, max);" \
    "            const cut = truncate(cell, max);" \
    'a path is cut from the tail, losing the filename'

mutate cli/format/text.ts \
    "            if (cut !== cell && !shortened.includes(cell)) {" \
    "            if (false && cut !== cell && !shortened.includes(cell)) {" \
    'shortened paths are never collected, so none can be recovered'

mutate cli/format/text.ts \
    "        \`\${indent}full paths (\${shortenedPaths.length} shortened above):\`," \
    "        \`\${indent}full paths:\`," \
    'the recovery block stops saying how many were shortened'

mutate cli/format/text.ts \
    "    if (shortenedPaths.length === 0) {
        return [];
    }" \
    "    if (shortenedPaths.length === 0) {
        return ['  full paths (0 shortened above):'];
    }" \
    'the recovery block is printed even when nothing was cut'

mutate cli/format/text.ts \
    "    lines.push(...fullPathLines(rendered.shortenedPaths, indent));" \
    "    lines.push();" \
    'tableSection drops the recovery block'

# --- the sort marker ---

mutate cli/format/text.ts \
    "    return \`\${column.header} \${column.sort === 'desc' ? '▼' : '▲'}\`;" \
    "    return column.header;" \
    'the sort marker is never rendered'

mutate cli/format/text.ts \
    "    return \`\${column.header} \${column.sort === 'desc' ? '▼' : '▲'}\`;" \
    "    return \`\${column.header} \${column.sort === 'desc' ? '▲' : '▼'}\`;" \
    'the ascending and descending markers are swapped'

mutate cli/format/markdown.ts \
    "            escapeCell(c.sort === undefined ? c.header : \`\${c.header} \${c.sort === 'desc' ? '▼' : '▲'}\`)" \
    "            escapeCell(c.header)" \
    'Markdown drops the sort marker'

# Two call sites share this line (the per-test and the grouped renderer), so
# the mutation is applied to the enclosing comment's unique neighbour instead.
mutate cli/commands/issues.ts \
    "        // \`name\` sorts ascending (A→Z); the numeric orders are descending.
        ...(header === sortColumn ? { sort: result.sort === 'name' ? 'asc' : 'desc' } : {})," \
    "        ...(header === sortColumn ? { sort: 'desc' } : {})," \
    'the per-test marker claims descending even for --sort name'

# --- the empty state ---

mutate cli/commands/issues.ts \
    "        \`No \${subject} matched. Searched \${searched} over \` +" \
    "        \`No \${subject} matched.\` + (false ? \`Searched \${searched} over \` : '') +" \
    'the empty state stops naming the population it searched'

summary
[ "$SURVIVED" -gt 0 ] && exit 1
exit 0
