#!/bin/bash
set -euo pipefail

LABEL="com.byungsker.fieldnotes"
PORT="4177"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/Fieldnotes"
NODE_BIN="$(command -v node || true)"
USER_ID="$(id -u)"

fail() {
  printf 'Install stopped: %s\n' "$1" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail "This installer is for macOS user LaunchAgents."
[[ -n "$NODE_BIN" ]] || fail "Node.js was not found in this shell's PATH."
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"
[[ -f "$PROJECT_ROOT/dist/server/index.js" ]] || fail "Production server build is missing. Run npm run build first."

if launchctl print "gui/$USER_ID/$LABEL" >/dev/null 2>&1; then
  fail "$LABEL is already registered in this login session. Inspect it before reinstalling."
fi
[[ ! -e "$PLIST_PATH" ]] || fail "$PLIST_PATH already exists. Inspect it before reinstalling."

LISTENERS="$(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
[[ -z "$LISTENERS" ]] || fail "Port $PORT is already in use by PID(s): $LISTENERS. Stop the existing app before installing."

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
chmod 700 "$LOG_DIR"
touch "$LOG_DIR/stdout.log" "$LOG_DIR/stderr.log"
chmod 600 "$LOG_DIR/stdout.log" "$LOG_DIR/stderr.log"

PROJECT_ROOT="$PROJECT_ROOT" NODE_BIN="$NODE_BIN" PLIST_PATH="$PLIST_PATH" LOG_DIR="$LOG_DIR" \
  /usr/bin/python3 - <<'PY'
import os
import plistlib

label = "com.byungsker.fieldnotes"
project_root = os.environ["PROJECT_ROOT"]
node_bin = os.environ["NODE_BIN"]
log_dir = os.environ["LOG_DIR"]
plist_path = os.environ["PLIST_PATH"]

plist = {
    "Label": label,
    "ProgramArguments": [
        node_bin,
        "--env-file-if-exists=.env",
        "dist/server/index.js",
    ],
    "WorkingDirectory": project_root,
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 10,
    "ProcessType": "Background",
    "StandardOutPath": os.path.join(log_dir, "stdout.log"),
    "StandardErrorPath": os.path.join(log_dir, "stderr.log"),
}

with open(plist_path, "xb") as output:
    plistlib.dump(plist, output)
os.chmod(plist_path, 0o600)
PY

launchctl enable "gui/$USER_ID/$LABEL"
if ! launchctl bootstrap "gui/$USER_ID" "$PLIST_PATH"; then
  fail "launchctl bootstrap failed. The plist was preserved at $PLIST_PATH for inspection."
fi

for _ in $(seq 1 30); do
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    launchctl print "gui/$USER_ID/$LABEL" >/dev/null || fail "The listener started but launchctl cannot inspect the job."
    printf 'Installed %s for the current user.\n' "$LABEL"
    printf 'Project: %s\n' "$PROJECT_ROOT"
    printf 'Plist: %s\n' "$PLIST_PATH"
    printf 'Listener: 127.0.0.1:%s\n' "$PORT"
    printf 'Logs: %s\n' "$LOG_DIR"
    exit 0
  fi
  sleep 1
done

fail "The LaunchAgent did not open port $PORT within 30 seconds. Inspect $LOG_DIR/stderr.log and launchctl print gui/$USER_ID/$LABEL."
