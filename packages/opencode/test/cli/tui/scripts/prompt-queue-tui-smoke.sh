#!/usr/bin/env bash
# Smoke driver for deferred prompt queue through the same HTTP API the TUI uses.
#
# Required env:
#   OPENCODE_SERVER_URL  — e.g. http://127.0.0.1:4096 from `opencode serve`
#   OPENCODE_DIRECTORY   — workspace directory (x-opencode-directory header)
#
# Optional env:
#   OPENCODE_SESSION_ID  — existing session; created when unset
#   OPENCODE_ARTIFACT_DIR — writes session-id.txt, queued.txt, tui-attach.txt
#   OPENCODE_QUEUE_ONLY=1 — only queue deferred messages (open turn started elsewhere)
#   OPENCODE_SKIP_ATTACH=1 — skip `script` capture of `opencode attach`
#   OPENCODE_CLI_ENTRY   — path to src/index.ts (defaults below)
#
set -euo pipefail

SERVER_URL="${OPENCODE_SERVER_URL:?OPENCODE_SERVER_URL is required}"
DIRECTORY="${OPENCODE_DIRECTORY:?OPENCODE_DIRECTORY is required}"
ARTIFACT_DIR="${OPENCODE_ARTIFACT_DIR:-$(mktemp -d)}"
CLI_ENTRY="${OPENCODE_CLI_ENTRY:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)/src/index.ts}"

mkdir -p "$ARTIFACT_DIR"

api() {
  local method=$1
  local path=$2
  shift 2
  curl -sfS -X "$method" "${SERVER_URL}${path}" \
    -H "content-type: application/json" \
    -H "x-opencode-directory: ${DIRECTORY}" \
    "$@"
}

session_id() {
  if [[ -n "${OPENCODE_SESSION_ID:-}" ]]; then
    printf '%s' "$OPENCODE_SESSION_ID"
    return
  fi
  api POST /session -d '{"title":"prompt-queue-tui-smoke"}' | jq -er '.id'
}

queue_deferred() {
  local sid=$1
  local text=$2
  api POST "/session/${sid}/message" -d "$(
    jq -nc --arg t "$text" '{
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      delivery: "deferred",
      parts: [{ type: "text", text: $t }]
    }'
  )" >/dev/null
}

start_open_async() {
  local sid=$1
  api POST "/session/${sid}/prompt_async" -d '{
    "agent": "build",
    "model": { "providerID": "test", "modelID": "test-model" },
    "parts": [{ "type": "text", "text": "open turn" }]
  }' >/dev/null
}

attach_capture() {
  local sid=$1
  local out="${ARTIFACT_DIR}/tui-attach.txt"
  if [[ "${OPENCODE_SKIP_ATTACH:-}" == "1" ]]; then
    printf 'attach skipped\n' >"$out"
    return 0
  fi
  if ! command -v script >/dev/null 2>&1; then
    printf 'attach skipped: script(1) not found\n' >"$out"
    return 0
  fi
  timeout 6 script -qefc \
    "cd '${DIRECTORY}' && exec bun run --conditions=browser '${CLI_ENTRY}' attach '${SERVER_URL}' --session '${sid}'" \
    "$out" 2>/dev/null || true
}

main() {
  local sid
  sid="$(session_id)"
  printf '%s\n' "$sid" >"${ARTIFACT_DIR}/session-id.txt"

  if [[ "${OPENCODE_QUEUE_ONLY:-}" != "1" ]]; then
    start_open_async "$sid"
    sleep 0.15
  fi

  queue_deferred "$sid" "queue-one"
  queue_deferred "$sid" "queue-two"
  queue_deferred "$sid" "queue-three"
  printf 'queued\n' >"${ARTIFACT_DIR}/queued.txt"

  attach_capture "$sid"
}

main "$@"
