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
#   OPENCODE_EDIT_FIRST=1 — edit the first queued message and save it with Return
#   OPENCODE_SKIP_ATTACH=1 — skip `script` capture of `opencode attach`
#   OPENCODE_CLI_ENTRY   — path to src/index.ts (defaults below)
#
set -euo pipefail

SERVER_URL="${OPENCODE_SERVER_URL:?OPENCODE_SERVER_URL is required}"
DIRECTORY="${OPENCODE_DIRECTORY:?OPENCODE_DIRECTORY is required}"
ARTIFACT_DIR="${OPENCODE_ARTIFACT_DIR:-$(mktemp -d)}"
CLI_ENTRY="${OPENCODE_CLI_ENTRY:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)/src/index.ts}"
CLI_CWD="$(cd "$(dirname "$CLI_ENTRY")/.." && pwd)"

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

queue_prompt() {
  local sid=$1
  local text=$2
  api POST "/session/${sid}/queue" -d "$(
    jq -nc --arg t "$text" '{
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
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
  if [[ "${OPENCODE_EDIT_FIRST:-}" == "1" ]]; then
    coproc ATTACH {
      timeout --kill-after=2 15 script -qefc \
        "cd '${CLI_CWD}' && exec bun run --conditions=browser '${CLI_ENTRY}' attach '${SERVER_URL}' --session '${sid}' --dir '${DIRECTORY}'" \
        "$out" >/dev/null 2>&1
    }
    local ready=0
    for _ in {1..60}; do
      if grep -aq "messages queued" "$out"; then
        ready=1
        break
      fi
      sleep 0.2
    done
    if [[ "$ready" != "1" ]]; then
      kill "$ATTACH_PID" 2>/dev/null || true
      wait "$ATTACH_PID" 2>/dev/null || true
      return 1
    fi
    printf '\033[1;3A' >&"${ATTACH[1]}"
    for _ in {1..10}; do
      grep -aq "Editing queued message" "$out" && break
      sleep 0.1
    done
    if ! grep -aq "Editing queued message" "$out"; then
      printf '\033[57352;3u' >&"${ATTACH[1]}"
      for _ in {1..10}; do
        grep -aq "Editing queued message" "$out" && break
        sleep 0.1
      done
    fi
    if ! grep -aq "Editing queued message" "$out"; then
      kill "$ATTACH_PID" 2>/dev/null || true
      wait "$ATTACH_PID" 2>/dev/null || true
      return 1
    fi
    printf '%s' '-edited' >&"${ATTACH[1]}"
    sleep 0.2
    printf '\r' >&"${ATTACH[1]}"

    local edited=0
    for _ in {1..40}; do
      if api GET "/session/${sid}/queue" | jq -e \
        'length == 3 and .[0].text == "queue-one-edited"' >/dev/null; then
        edited=1
        break
      fi
      sleep 0.2
    done
    kill "$ATTACH_PID" 2>/dev/null || true
    wait "$ATTACH_PID" 2>/dev/null || true
    [[ "$edited" == "1" ]]
    return
  fi

  timeout --kill-after=2 6 script -qefc \
    "cd '${CLI_CWD}' && exec bun run --conditions=browser '${CLI_ENTRY}' attach '${SERVER_URL}' --session '${sid}' --dir '${DIRECTORY}'" \
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

  queue_prompt "$sid" "queue-one"
  queue_prompt "$sid" "queue-two"
  queue_prompt "$sid" "queue-three"
  printf 'queued\n' >"${ARTIFACT_DIR}/queued.txt"

  attach_capture "$sid"

  if [[ "${OPENCODE_EDIT_FIRST:-}" == "1" ]]; then
    api GET "/session/${sid}/queue" | jq -er \
      'length == 3 and .[0].text == "queue-one-edited"' >/dev/null
    printf 'queue-one-edited\n' >"${ARTIFACT_DIR}/edited.txt"
  fi
}

main "$@"
