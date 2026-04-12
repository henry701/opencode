#!/usr/bin/env bash
# build-local.sh — build opencode for current platform and install as opencode-local
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$REPO_ROOT/packages/opencode"
INSTALL_DIR="$HOME/.local/bin"
BINARY_NAME="opencode-local"
SERVICE_NAME="opencode-server"

export PATH="$PATH:$REPO_ROOT/node_modules/.bin"

echo "==> Installing dependencies..."
bun install --minimum-release-age 0 --frozen-lockfile

echo "==> Building opencode (native linux-x64, --single)..."
cd "$PKG_DIR"
bun run script/build.ts --single --skip-install

BUILT_BIN="$PKG_DIR/dist/opencode-linux-x64/bin/opencode"
if [[ ! -f "$BUILT_BIN" ]]; then
  echo "ERROR: expected binary not found at $BUILT_BIN" >&2
  exit 1
fi

echo "==> Smoke test..."
"$BUILT_BIN" --version

echo "==> Installing to $INSTALL_DIR/$BINARY_NAME..."
mkdir -p "$INSTALL_DIR"
cp -f "$BUILT_BIN" "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"
echo "    installed: $("$INSTALL_DIR/$BINARY_NAME" --version)"

SERVICE_FILE="$HOME/.config/systemd/user/$SERVICE_NAME.service"
echo "==> Updating $SERVICE_FILE..."
sed -i "s|ExecStart=.*opencode |ExecStart=$INSTALL_DIR/$BINARY_NAME |" "$SERVICE_FILE"
echo "    ExecStart line: $(grep ExecStart "$SERVICE_FILE")"

echo "==> Reloading systemd user daemon and restarting $SERVICE_NAME..."
# Try normal systemctl path first; fall back to simulation if DBUS is unavailable
if XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user daemon-reload 2>/dev/null; then
  XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user restart "$SERVICE_NAME"
  sleep 1
  XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user status "$SERVICE_NAME" --no-pager
else
  echo "    DBUS unavailable — simulating start on a different port to verify binary works..."
  TEST_PORT=14097
  OPENCODE_SERVER_PASSWORD=test OPENCODE_SERVER_USERNAME=test \
    "$INSTALL_DIR/$BINARY_NAME" serve --port "$TEST_PORT" --hostname 127.0.0.1 &
  SIM_PID=$!
  sleep 2
  if kill -0 "$SIM_PID" 2>/dev/null; then
    echo "    OK: binary started successfully on port $TEST_PORT (pid $SIM_PID)"
    kill "$SIM_PID"
  else
    echo "ERROR: binary failed to stay alive on test port $TEST_PORT" >&2
    exit 1
  fi
  echo ""
  echo "    NOTE: run 'systemctl --user restart $SERVICE_NAME' from your desktop session to apply."
fi

echo "==> Done."
