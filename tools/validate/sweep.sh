#!/bin/sh
# Sweeps published data files past the validator, one file per process
# invocation.
#
# The one-file-per-process rule is the point of this script rather than an
# implementation detail: a full sweep is tens of gigabytes and the mochitest
# errors file alone is ~97 MB/day, so each file is downloaded, validated,
# reported on and deleted before the next is fetched. Peak memory is therefore
# one file, not the sweep.
#
# Results are appended as one JSON object per line to $OUT, which
# tools/validate/report.ts turns into the report.
#
# Usage:
#   tools/validate/sweep.sh [--errors] [--daily] [--buckets] [--all]
#
# With no flags it sweeps the cheap families over every published date. The
# expensive ones (daily ~37 MB/date, errors up to ~97 MB/date) are opt-in
# because a full sweep of them is tens of gigabytes of download.

set -eu

cd "$(dirname "$0")/../.."

: "${NODE:=node}"
OUT="${OUT:-artifacts/sweep-results.jsonl}"
VALIDATOR=artifacts/validate.mjs

SWEEP_ERRORS=0
SWEEP_DAILY=0
SWEEP_BUCKETS=0
for arg in "$@"; do
    case "$arg" in
        --errors) SWEEP_ERRORS=1 ;;
        --daily) SWEEP_DAILY=1 ;;
        --buckets) SWEEP_BUCKETS=1 ;;
        --all) SWEEP_ERRORS=1; SWEEP_DAILY=1; SWEEP_BUCKETS=1 ;;
        *) echo "unknown option: $arg" >&2; exit 1 ;;
    esac
done

mkdir -p artifacts/sweep
npx esbuild tools/validate/main.ts --bundle --platform=node --format=esm \
    --target=node20 --outfile="$VALIDATOR" >/dev/null

# One invocation. Never aborts the sweep: a file that fails to validate is a
# finding, not a reason to stop collecting the rest.
check() {
    "$NODE" "$VALIDATOR" "$@" >>"$OUT" || true
}

DATES=$("$NODE" -e '
fetch("https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/gecko.v2.mozilla-central.latest.source.test-info-xpcshell-timings/artifacts/public/index.json")
  .then(r => r.json()).then(j => console.log(j.dates.join(" ")));
')
echo "dates: $DATES" >&2

check index xpcshell
check manifests manifests

for harness in xpcshell mochitest; do
    check stats "$harness"
    check issues "$harness"
    check issues-with-taskids "$harness"

    if [ "$SWEEP_BUCKETS" -eq 1 ]; then
        # All 64 buckets. Together they are the whole 21-day aggregate.
        for n in $(seq 0 63); do
            check bucket "$harness" "$(printf '%02x' "$n")"
        done
    else
        # Enough buckets to exercise the shape without the full 21-day aggregate.
        for b in 00 01 1f 20 3f; do
            check bucket "$harness" "$b"
        done
    fi

    for date in $DATES; do
        check resources "$harness" "$date"
        if [ "$SWEEP_DAILY" -eq 1 ]; then
            check daily "$harness" "$date"
        fi
        if [ "$SWEEP_ERRORS" -eq 1 ]; then
            check errors "$harness" "$date"
        fi
    done
done

# Minidump-stackwalk artifacts.
#
# Unlike everything above these are per-task, so there is no "every published
# file" to sweep — the set is effectively unbounded and the artifacts expire.
# What the sweep can do is take a sample, discovered the same way the
# dashboards discover them: CRASH status groups carry `minidumps` parallel to
# `taskIdIds`, and the dump lives under that task's `test_info/`.
STACKWALK_SAMPLE="${STACKWALK_SAMPLE:-8}"
echo "sampling $STACKWALK_SAMPLE minidump-stackwalk artifacts" >&2
"$NODE" - "$STACKWALK_SAMPLE" <<'FINDCRASHES' > artifacts/sweep/stackwalk-urls.txt
const limit = Number(process.argv[2] ?? 8);
const INDEX = 'https://firefox-ci-tc.services.mozilla.com/api/index/v1/task';
const QUEUE = 'https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task';
const seen = new Set();
// Walk buckets until enough distinct dumps are found. Crashes cluster, so a
// couple of buckets is usually plenty.
for (let n = 0; n < 64 && seen.size < limit; n++) {
    const name = `xpcshell-${n.toString(16).padStart(2, '0')}.json`;
    const url = `${INDEX}/gecko.v2.mozilla-central.latest.source.test-info-xpcshell-timings/artifacts/public/${name}`;
    const response = await fetch(url);
    if (!response.ok) continue;
    const data = await response.json();
    const statusId = data.tables.statuses.indexOf('CRASH');
    if (statusId < 0) continue;
    for (const perTest of data.testRuns) {
        const group = perTest?.[statusId];
        if (!group?.minidumps) continue;
        for (let i = 0; i < group.minidumps.length && seen.size < limit; i++) {
            const dumps = Array.isArray(group.minidumps[i]) ? group.minidumps[i] : [group.minidumps[i]];
            const tasks = Array.isArray(group.taskIdIds[i]) ? group.taskIdIds[i] : [group.taskIdIds[i]];
            for (let j = 0; j < dumps.length && seen.size < limit; j++) {
                if (!dumps[j]) continue;
                const suffixed = data.tables.taskIds[tasks[j] ?? tasks[0]];
                if (!suffixed) continue;
                const [taskId, retryId = '0'] = suffixed.split('.');
                seen.add(`${QUEUE}/${taskId}/runs/${retryId}/artifacts/public/test_info/${dumps[j]}.json`);
            }
        }
        if (seen.size >= limit) break;
    }
}
console.log([...seen].join('\n'));
FINDCRASHES

while read -r url; do
    [ -z "$url" ] && continue
    check stackwalk stackwalk --url "$url"
done < artifacts/sweep/stackwalk-urls.txt

echo "results in $OUT" >&2
