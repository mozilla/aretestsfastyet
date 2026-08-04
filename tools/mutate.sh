#!/bin/bash
# Apply one source mutation, run the CLI tests, restore, report.
#
# Written after the step-4 review found the previous ad-hoc version silently
# under-reporting: when a pattern matched more than once it printed a "??" line
# and moved on, and those were counted as if they had been tested. They had
# not. This version treats an ambiguous or absent pattern as a HARD ERROR with
# a non-zero exit, so a mutation cannot be quietly skipped.
#
# Usage: tools/mutate.sh <file> <old> <new> <description>
# Exit:  0 mutation was caught (good), 1 it survived (a test gap), 2 setup error.

set -u
cd "$(dirname "$0")/.." || exit 2
export PATH=/opt/homebrew/Cellar/node@22/22.16.0/bin:$PATH

FILE="$1"; OLD="$2"; NEW="$3"; DESC="$4"

if [ ! -f "$FILE" ]; then
    echo "ERROR  $DESC — no such file: $FILE"
    exit 2
fi

BACKUP=$(mktemp)
cp "$FILE" "$BACKUP"
restore() { cp "$BACKUP" "$FILE"; rm -f "$BACKUP"; }

python3 - "$FILE" "$OLD" "$NEW" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
count = text.count(old)
if count != 1:
    print(f"pattern occurs {count} times, need exactly 1", file=sys.stderr)
    sys.exit(9)
open(path, 'w').write(text.replace(old, new))
PY
if [ $? -ne 0 ]; then
    restore
    echo "ERROR  $DESC — pattern not unique or not found"
    exit 2
fi

FAILED=$(node --experimental-strip-types --test test/cli.test.ts 2>&1 \
    | grep '^# fail' | awk '{print $3}')
restore

if [ -z "$FAILED" ]; then
    echo "ERROR  $DESC — test run produced no result"
    exit 2
fi
if [ "$FAILED" = "0" ]; then
    echo "SURVIVED  $DESC"
    exit 1
fi
echo "caught($FAILED)  $DESC"
exit 0
