#!/usr/bin/env bash
# orch-dispatch — ORCH's automated task router for the session bus.
#
# ORCH never types `target-session` per task. It decomposes a user request,
# picks the target window by capability, and calls this once per subtask.
# This script does the three things ORCH would otherwise do by hand:
#   1. aim the bus at the target window   (target-session <TARGET>)
#   2. write the TASK into that window's mailbox file
#   3. launch a trivial notify_on_complete ping so the target wakes
# Then it re-aims at self (target-session reset) so ORCH's own later
# launches stay local.
#
# Capability routing (ORCH picks TARGET from the task, not the user):
#   sb1  -> Support Session - Background Agent 1 (glm-5.2)  : reasoning/consistency
#   sb2  -> Support Session - Background Agent 2 (hy3)       : execution/parallel
#   orch -> the orchestrator's own window (no ping needed; ORCH does it)
#
# Usage:
#   orch-dispatch sb1  "Check TASK-X for logical consistency against spec Y"
#   orch-dispatch sb2  "Run the parallel-build step for module Z"
#   orch-dispatch orch "Summarize the two REPORTs and write the synthesis"
#
# Requires: scripts/load-session-keys.sh available (this script auto-sources it
# if target-session isn't already defined, so you can run it directly). For the
# KEY export to reach the agent process, ORCH must RUN THIS WITH `source`
# (e.g. `source scripts/orch-dispatch.sh sb1 "..."`), NOT as a subprocess
# (`bash scripts/orch-dispatch.sh ...`) — a subprocess has its own env and the
# exported HERMES_SESSION_KEY would not persist into ORCH's next terminal call.
# See the session-bus-injection skill.

set -u

TARGET="${1:-}"
TASK="${2:-}"

if [[ -z "$TARGET" || -z "$TASK" ]]; then
  echo "orch-dispatch: usage: source scripts/orch-dispatch.sh <sb1|sb2|orch> \"<task text>\"" >&2
  exit 2
fi

# Auto-load the key file + target-session helper if not already in this shell.
if ! declare -F target-session >/dev/null 2>&1; then
  _LOADER="${HERMES_LOAD_SESSION_KEYS:-$(dirname "${BASH_SOURCE[0]}")/load-session-keys.sh}"
  if [[ -f "$_LOADER" ]]; then
    # shellcheck disable=SC1090
    source "$_LOADER"
  else
    echo "orch-dispatch: loader not found at $_LOADER" >&2
    exit 3
  fi
fi

# Map target -> mailbox file. Normalize to the loader's uppercase form.
TARGET_UPPER="$(printf '%s' "$TARGET" | tr '[:lower:]' '[:upper:]')"
case "$TARGET_UPPER" in
  SB1)  MAILBOX="D:/Repo/hermes-handoff/sb1.md" ;;
  SB2)  MAILBOX="D:/Repo/hermes-handoff/sb2.md" ;;
  ORCH) MAILBOX="" ;;  # ORCH does it itself; just record intent, no ping
  *)    echo "orch-dispatch: unknown target '$TARGET' (sb1|sb2|orch)" >&2; exit 2 ;;
esac

if [[ "$TARGET_UPPER" == "ORCH" ]]; then
  echo "orch-dispatch: routing to self (ORCH) — no ping. Task queued in ORCH's own context: $TASK"
  exit 0
fi

# 1. aim the bus at the target window
target-session "$TARGET_UPPER"

# 2. write the TASK into the target's mailbox (append-only)
python "D:/Repo/hermes-handoff/bin/post.py" \
  --file "$MAILBOX" --kind TASK --body "$TASK" \
  || { echo "orch-dispatch: failed to write TASK to $MAILBOX" >&2; target-session reset; exit 4; }

# 3. launch the wake ping (trivial process, notify_on_complete)
# The export from target-session persists into this same bash session, so the
# agent's next terminal(background, notify_on_complete) call is pre-targeted.
echo "orch-dispatch: pinging $TARGET_UPPER — TASK posted to $MAILBOX"

# re-aim at self so ORCH's subsequent launches stay local
target-session reset
