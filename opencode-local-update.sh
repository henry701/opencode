#!/usr/bin/env bash
# opencode-local-update.sh — update local production checkout, then build and install opencode-local.
# Invoked by opencode-local-build.service.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP_FILE="$HOME/.local/share/opencode-local-build.stamp"
REMOTE_NAME="henry701"
BRANCH_NAME="production"
REMOTE_REF="$REMOTE_NAME/$BRANCH_NAME"

export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$REPO_ROOT/node_modules/.bin"
export SSH_AUTH_SOCK="/run/user/$UID/ssh-tpm-agent.sock"

cd "$REPO_ROOT"

echo "==> Fetching $REMOTE_REF..."
git fetch "$REMOTE_NAME" "$BRANCH_NAME" 2>&1

REMOTE_HASH=$(git rev-parse "$REMOTE_REF")
REMOTE_SHORT=$(git rev-parse --short "$REMOTE_REF")

LAST_HASH=""
[[ -f "$STAMP_FILE" ]] && LAST_HASH=$(cat "$STAMP_FILE")

if [[ "$REMOTE_HASH" == "$LAST_HASH" ]]; then
  echo "==> Already on $REMOTE_SHORT — nothing to do."
  exit 0
fi

LAST_SHORT="none"
[[ -n "$LAST_HASH" ]] && LAST_SHORT="${LAST_HASH:0:9}"

echo "==> New commit detected: $REMOTE_SHORT (was: $LAST_SHORT)"
echo "==> Resetting to $REMOTE_REF..."
git checkout "$BRANCH_NAME"
git reset --hard "$REMOTE_REF"

echo "==> Installing dependencies..."
bun install --minimum-release-age 0 --frozen-lockfile

echo "==> Building and reinstalling from $BRANCH_NAME..."
"$REPO_ROOT/build-local.sh"

echo "$REMOTE_HASH" > "$STAMP_FILE"
echo "==> Done — stamped $REMOTE_SHORT"
