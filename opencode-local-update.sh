#!/usr/bin/env bash
# opencode-local-update.sh — pull, build, install opencode-local; skip if already on same commit.
# Invoked by opencode-local-build.service. Not committed to the repo.
set -euo pipefail

REPO_ROOT="/home/henry/My_Programming/OpenSourceCopies/opencode"
PKG_DIR="$REPO_ROOT/packages/opencode"
INSTALL_DIR="$HOME/.local/bin"
BINARY_NAME="opencode-local"
SERVICE_NAME="opencode-server"
STAMP_FILE="$HOME/.local/share/opencode-local-build.stamp"

export PATH="$INSTALL_DIR:/usr/local/bin:/usr/bin:/bin:$REPO_ROOT/node_modules/.bin"
export SSH_AUTH_SOCK="/run/user/$(id -u)/ssh-tpm-agent.sock"

cd "$REPO_ROOT"

echo "==> Fetching henry701/dev..."
git fetch henry701 dev 2>&1

REMOTE_HASH=$(git rev-parse henry701/dev)
REMOTE_SHORT=$(git rev-parse --short henry701/dev)

# Duplicate detection: compare against last installed commit
LAST_HASH=""
[[ -f "$STAMP_FILE" ]] && LAST_HASH=$(cat "$STAMP_FILE")

if [[ "$REMOTE_HASH" == "$LAST_HASH" ]]; then
  echo "==> Already on $REMOTE_SHORT — nothing to do."
  exit 0
fi

echo "==> New commit detected: $REMOTE_SHORT (was: ${LAST_HASH:0:9:-none})"
echo "==> Resetting to henry701/dev..."
git checkout dev
git reset --hard henry701/dev

echo "==> Installing dependencies..."
cd "$REPO_ROOT"
bun install 2>&1 | tail -3

echo "==> Building (native linux-x64, --single)..."
cd "$PKG_DIR"
bun run script/build.ts --single

BUILT_BIN="$PKG_DIR/dist/opencode-linux-x64/bin/opencode"
[[ ! -f "$BUILT_BIN" ]] && { echo "ERROR: binary not found at $BUILT_BIN" >&2; exit 1; }

echo "==> Smoke test..."
"$BUILT_BIN" --version

echo "==> Installing to $INSTALL_DIR/$BINARY_NAME..."
mkdir -p "$INSTALL_DIR"
cp -f "$BUILT_BIN" "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"
echo "    installed: $("$INSTALL_DIR/$BINARY_NAME" --version)"

echo "==> Restarting $SERVICE_NAME..."
XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user restart "$SERVICE_NAME"
sleep 1
XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user status "$SERVICE_NAME" --no-pager | tail -4

# Stamp the successfully installed commit
echo "$REMOTE_HASH" > "$STAMP_FILE"
echo "==> Done — stamped $REMOTE_SHORT"
