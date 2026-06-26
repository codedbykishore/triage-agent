#!/usr/bin/env bash
#
# demo-terminal.sh — Live demo wiring for the Auto-Triage Agent.
#
# Starts the Agent Controller inside a persistent tmux session and serves that
# session to the browser with ttyd, so judges can watch the Kiro agent triage
# an incident in real time. The controller streams each Kiro run's output to
# its own stdout (see src/kiroRunner.js), which tmux captures and ttyd renders.
#
# The web terminal is READ-ONLY by default: ttyd only accepts keyboard input
# when started with -W/--writable, which we deliberately omit so an audience
# member cannot type into the live agent. Override with TTYD_WRITABLE=1 if you
# need an interactive session.
#
# Usage:
#   ./scripts/demo-terminal.sh            # controller in tmux + read-only ttyd
#
# Environment:
#   PORT            App/webhook port (default 3000; passed through to server.js)
#   TTYD_PORT       Web terminal port (default 7681)
#   TMUX_SESSION    tmux session name (default "triage")
#   TTYD_WRITABLE   set to 1 to allow browser keyboard input (default off)
#   KIRO_STREAM_OUTPUT  set to "false" to suppress live Kiro echo (default on)

set -euo pipefail

TTYD_PORT="${TTYD_PORT:-7681}"
TMUX_SESSION="${TMUX_SESSION:-triage}"

# Resolve the project root (parent of this scripts/ directory) so the script
# works regardless of the current working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

for bin in tmux ttyd node; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "demo-terminal: required command '$bin' not found on PATH" >&2
    exit 1
  fi
done

# Start (or reuse) a detached tmux session running the controller. We force
# streaming on so the agent's work is visible in the session.
if tmux has-session -t "${TMUX_SESSION}" 2>/dev/null; then
  echo "demo-terminal: reusing existing tmux session '${TMUX_SESSION}'"
else
  echo "demo-terminal: starting controller in tmux session '${TMUX_SESSION}'"
  tmux new-session -d -s "${TMUX_SESSION}" \
    "cd '${PROJECT_ROOT}' && KIRO_STREAM_OUTPUT='${KIRO_STREAM_OUTPUT:-true}' node src/server.js"
fi

# Build the ttyd argument array. Read-only unless explicitly made writable.
ttyd_args=(--port "${TTYD_PORT}")
if [ "${TTYD_WRITABLE:-0}" = "1" ]; then
  ttyd_args+=(--writable)
  echo "demo-terminal: WARNING — web terminal is WRITABLE; the audience can type into the agent"
else
  echo "demo-terminal: web terminal is read-only"
fi

echo "demo-terminal: serving tmux session '${TMUX_SESSION}' at http://0.0.0.0:${TTYD_PORT}"
exec ttyd "${ttyd_args[@]}" tmux attach -t "${TMUX_SESSION}"
