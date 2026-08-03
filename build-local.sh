#!/usr/bin/env bash
# build-local.sh - build opencode for current platform and install as opencode-local.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$REPO_ROOT/packages/opencode"
INSTALL_DIR="$HOME/.local/bin"
BINARY_NAME="opencode-local"
SERVICE_NAME="opencode-server"
BACKEND_SERVICE_NAME="opencode-backend"
RESTART_SERVICE=1

usage() {
  cat <<EOF
Usage: $0 [--no-restart-service]

Options:
  --no-restart-service  Install the binary without reloading, restarting, or
                        simulation-starting the user service.

Environment:
  OPENCODE_LOCAL_NO_RESTART=1 has the same effect as --no-restart-service.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-restart-service | --no-restart | --skip-restart)
      RESTART_SERVICE=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "${OPENCODE_LOCAL_NO_RESTART:-}" == "1" || "${OPENCODE_LOCAL_SKIP_RESTART:-}" == "1" ]]; then
  RESTART_SERVICE=0
fi

export PATH="$PATH:$REPO_ROOT/node_modules/.bin"

echo "==> Installing dependencies..."
bun install --minimum-release-age 0 --frozen-lockfile

echo "==> Regenerating JavaScript SDK..."
bun "$REPO_ROOT/packages/sdk/js/script/build.ts"

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
if [[ -f "$SERVICE_FILE" ]]; then
  echo "==> Updating $SERVICE_FILE..."
  sed -i "s|ExecStart=.*opencode |ExecStart=$INSTALL_DIR/$BINARY_NAME |" "$SERVICE_FILE"
  echo "    ExecStart line: $(grep ExecStart "$SERVICE_FILE")"
else
  echo "==> Service file not found at $SERVICE_FILE; skipping service file update."
fi

if [[ "$RESTART_SERVICE" == "0" ]]; then
  echo "==> Skipping service reload/restart because --no-restart-service was set."
  echo "==> Done."
  exit 0
fi

echo "==> Reloading systemd user daemon and restarting $BACKEND_SERVICE_NAME and $SERVICE_NAME..."
if XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user daemon-reload 2>/dev/null; then
  XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user restart "$BACKEND_SERVICE_NAME" "$SERVICE_NAME"
  sleep 1
  XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user status "$BACKEND_SERVICE_NAME" "$SERVICE_NAME" --no-pager
else
  echo "    DBUS unavailable - simulating start on a different port to verify binary works..."
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
  echo "    NOTE: run 'systemctl --user restart $BACKEND_SERVICE_NAME $SERVICE_NAME' from your desktop session to apply."
fi

echo "==> Done."
