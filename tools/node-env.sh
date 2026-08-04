# Puts the project's node on PATH for a non-interactive shell. Source, do not run.
#
# `PLAN.md` §1's prerequisite: node is managed by `fnm`, which puts the active
# binary in a per-shell path that exists only inside an interactive shell. So
# anything non-interactive — a CI job, a git hook, an agent's shell — will not
# find `node` unless it evaluates `fnm env` first.
#
# This used to be a hardcoded `/opt/homebrew/Cellar/node@22/<version>/bin`,
# which was one machine's workaround written into the repo. It breaks when that
# keg is upgraded or absent, and — worse — it silently bypasses the version
# `.node-version` pins, so a script could run against a different node from the
# one `npm test` uses interactively.
#
# The order below is: whatever is already on PATH wins (a caller who set up
# their own environment meant it), then `fnm`, then a clear failure. Naming no
# specific install is the point.

if ! command -v node >/dev/null 2>&1; then
    if command -v fnm >/dev/null 2>&1; then
        # `--use-on-cd` is deliberately omitted: this is a one-shot resolution
        # for this script, not a shell integration.
        eval "$(fnm env 2>/dev/null)" || true
        # `fnm env` exports the multishell path but does not select a version;
        # `.node-version` at the repo root is what pins it.
        fnm use --install-if-missing >/dev/null 2>&1 || true
    fi
fi

if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: no \`node\` on PATH, and \`fnm\` could not provide one." >&2
    echo "       This project needs Node >= 20 (built-in fetch). With fnm:" >&2
    echo "         eval \"\$(fnm env)\" && fnm use" >&2
    echo "       Or put any Node >= 20 on PATH before running this script." >&2
    return 2 2>/dev/null || exit 2
fi
