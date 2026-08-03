#!/usr/bin/env bash
# Load session-bus secrets into the CURRENT shell, then target one window.
#
# Usage (inside a Hermes window's persistent bash session):
#   source scripts/load-session-keys.sh          # loads SB1_/SB2_/ORCH_SESSION_KEY
#   target-session SB1                           # exports HERMES_SESSION_KEY=<SB1's key>
#   target-session SB2                           # ...or SB2
#   target-session ORCH                          # ...or ORCH
#   target-session reset                         # blanks HERMES_SESSION_KEY (target self again)
#
# Why source, not exec: the exploit needs HERMES_SESSION_KEY in the AGENT
# PROCESS environment. The Hermes bash session persists across terminal calls,
# so an export here survives into the next notify_on_complete launch. Running
# this as a subprocess (./script) would only set the var in that subprocess and
# the exploit would not see it.
#
# After targeting, launch a trivial background process with notify_on_complete
# from the same window; its completion is delivered to the targeted window.

_SESSION_KEYS_FILE="${HERMES_SESSION_KEYS_FILE:-$(dirname "${BASH_SOURCE[0]}")/../hermes-session-keys.env}"

if [[ -f "$_SESSION_KEYS_FILE" ]]; then
  # set -a makes subsequent assignments export automatically.
  set -a
  # shellcheck disable=SC1090
  source "$_SESSION_KEYS_FILE"
  set +a
else
  echo "session-bus: key file not found at $_SESSION_KEYS_FILE" >&2
fi

target-session() {
  local name="$1"
  case "$name" in
    SB1)  export HERMES_SESSION_KEY="${SB1_SESSION_KEY:-}" ;;
    SB2)  export HERMES_SESSION_KEY="${SB2_SESSION_KEY:-}" ;;
    ORCH) export HERMES_SESSION_KEY="${ORCH_SESSION_KEY:-}" ;;
    reset|"")
          export HERMES_SESSION_KEY=""
          echo "session-bus: HERMES_SESSION_KEY blanked (targets self)"
          return 0 ;;
    *)    echo "session-bus: unknown target '$name' (SB1|SB2|ORCH|reset)" >&2
          return 1 ;;
  esac
  if [[ -z "$HERMES_SESSION_KEY" ]]; then
    echo "session-bus: $name key is empty — fill hermes-session-keys.env" >&2
    return 1
  fi
  echo "session-bus: HERMES_SESSION_KEY set to $name's key ($(echo -n "$HERMES_SESSION_KEY" | head -c 8)…)"
}
