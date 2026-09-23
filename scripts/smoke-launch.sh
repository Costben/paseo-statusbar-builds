#!/usr/bin/env bash
# Launches a packaged Paseo.app the way dyld sees it, and fails if it cannot start.
#
# Why a launch and not just a signature check: macOS resolves the Electron
# Framework at load time and refuses to load nested code that is not signed by
# the same identity as the process. A bundle can pass every static assertion —
# `codesign --verify --deep --strict`, the nested-signer comparison — and still
# die right here with `different Team IDs`. That is exactly how the first
# self-signed build shipped: green in CI, dead on the user's Mac, and invisible
# to every check that only reads the bundle.
#
# ELECTRON_RUN_AS_NODE=1 runs the binary as Node instead of opening a window: a
# second Paseo GUI on a machine that is already running one is not something a
# build or an audit should cause.
#
# Usage: scripts/smoke-launch.sh <path/to/Paseo.app>

set -euo pipefail

app="${1:?usage: smoke-launch.sh <path/to/Paseo.app>}"
exe="$app/Contents/MacOS/Paseo"
if [ ! -x "$exe" ]; then
  echo "::error::no executable at $exe"
  exit 1
fi

# Captured to a file rather than piped: an early-exiting `grep -q` upstream of
# this would trip `pipefail` and fail a build that actually passed.
probe="$(mktemp -t paseo-smoke)"
trap 'rm -f "$probe"' EXIT

ELECTRON_RUN_AS_NODE=1 "$exe" -e 'console.log(1)' > "$probe" 2>&1 &
app_pid=$!

# Bounded: a launch that hangs is a failure, not a reason to spend the job's
# whole timeout waiting for it.
( sleep "${SMOKE_TIMEOUT_SECONDS:-60}"; kill -9 "$app_pid" 2>/dev/null ) &
watchdog_pid=$!

set +e
wait "$app_pid"
status=$?
set -e
# Reaped explicitly so the shell does not print its own "Terminated" notice over
# the probe output when the watchdog is the one that stopped it.
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true

cat "$probe"
if [ "$status" -ne 0 ]; then
  echo "::error::$app exited $status without starting — dyld could not load its own frameworks, or it hung."
  exit 1
fi
if ! grep -qx '1' "$probe"; then
  echo "::error::$app started but the probe printed nothing."
  exit 1
fi
echo "$app loads its own frameworks and runs."
