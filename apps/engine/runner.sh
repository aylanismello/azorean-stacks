#!/bin/bash
# Azorean Stacks persistent engine supervisor.
# Realtime watcher owns acquisition; this process schedules discovery and
# restarts the watcher if it exits.

set -uo pipefail

ENGINE_DIR="/Users/pico/repos/azorean-stacks/apps/engine"
ENV_FILE="${AZOREAN_ENGINE_ENV_FILE:-/Users/pico/.config/azorean-stacks/engine.env}"
LOG_DIR="/Users/pico/.hermes/logs"
LOG_FILE="$LOG_DIR/azorean-engine.log"
STATUS_FILE="/Users/pico/.hermes/data/azorean-engine-status.json"
LOCK_DIR="/tmp/azorean-stacks-engine.lock"
WATCHER_PID=""
JOB_PID=""

mkdir -p "$LOG_DIR" "$(dirname "$STATUS_FILE")"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  existing_pid="$(/bin/cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    printf '[%s] runner already active as PID %s; exiting duplicate\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$existing_pid" >> "$LOG_FILE"
    exit 0
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid"

rotate_log() {
  local size
  size="$(stat -f%z "$LOG_FILE" 2>/dev/null || printf '0')"
  if [ "$size" -gt 5242880 ]; then
    /usr/bin/tail -n 10000 "$LOG_FILE" > "$LOG_FILE.tmp"
    /bin/cp "$LOG_FILE.tmp" "$LOG_FILE"
    /bin/rm -f "$LOG_FILE.tmp"
  fi
}

write_status() {
  local phase="$1"
  local status="$2"
  local watcher_alive=false
  if [ -n "$WATCHER_PID" ] && kill -0 "$WATCHER_PID" 2>/dev/null; then
    watcher_alive=true
  fi
  printf '{"last_run":"%s","phase":"%s","status":"%s","running":%s,"pid":%s,"watcher_pid":%s,"watcher_alive":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$phase" "$status" "$watcher_alive" "$$" "${WATCHER_PID:-null}" "$watcher_alive" > "$STATUS_FILE"
}

load_env() {
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  elif [ -f "$ENGINE_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$ENGINE_DIR/.env"
    set +a
  fi
  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
  export NODE_ENV=production
}

start_watcher() {
  rotate_log
  printf '[%s] starting Realtime watcher\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG_FILE"
  bun run watcher >> "$LOG_FILE" 2>&1 &
  WATCHER_PID=$!
  write_status "watcher" "running"
}

ensure_watcher() {
  if [ -z "$WATCHER_PID" ] || ! kill -0 "$WATCHER_PID" 2>/dev/null; then
    local old_pid="${WATCHER_PID:-none}"
    printf '[%s] watcher PID %s exited; restarting\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$old_pid" >> "$LOG_FILE"
    start_watcher
  fi
}

run_job() {
  local phase="$1"
  shift
  "$@" >> "$LOG_FILE" 2>&1 &
  JOB_PID=$!
  while kill -0 "$JOB_PID" 2>/dev/null; do
    sleep 5
    ensure_watcher
  done
  wait "$JOB_PID"
  local code=$?
  JOB_PID=""
  return "$code"
}

cleanup() {
  write_status "stopped" "stopped"
  if [ -n "$JOB_PID" ] && kill -0 "$JOB_PID" 2>/dev/null; then
    kill "$JOB_PID" 2>/dev/null || true
    wait "$JOB_PID" 2>/dev/null || true
  fi
  if [ -n "$WATCHER_PID" ] && kill -0 "$WATCHER_PID" 2>/dev/null; then
    kill "$WATCHER_PID" 2>/dev/null || true
    wait "$WATCHER_PID" 2>/dev/null || true
  fi
  rm -rf "$LOCK_DIR"
}
handle_signal() {
  exit 0
}
trap cleanup EXIT
trap handle_signal INT TERM

cd "$ENGINE_DIR" || exit 1
load_env
start_watcher

printf '[%s] persistent engine supervisor started (PID %s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" >> "$LOG_FILE"

while true; do
  ensure_watcher
  rotate_log
  write_status "lotradio" "running"
  printf '[%s] refreshing Lot Radio index\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG_FILE"
  if run_job "lotradio" bun run crawl-lotradio --limit 64; then
    :
  else
    code=$?
    printf '[%s] Lot Radio refresh failed with exit %s; retaining existing source data\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" >> "$LOG_FILE"
  fi

  write_status "discovery" "running"
  printf '[%s] starting discovery cycle\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG_FILE"
  if run_job "discovery" bun run discover --once; then
    write_status "idle" "ok"
  else
    code=$?
    printf '[%s] discovery failed with exit %s; retrying next cycle\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" >> "$LOG_FILE"
    write_status "idle" "degraded"
  fi

  # Thirty-minute discovery cadence, with watcher supervision every 30s.
  for _ in $(seq 1 60); do
    sleep 30
    ensure_watcher
  done
done
