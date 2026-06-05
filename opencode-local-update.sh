#!/usr/bin/env bash
# opencode-local-update.sh - build and install the currently checked-out production branch.
# Invoked manually or by opencode-local-build.service. This script pulls the current upstream with --ff-only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRANCH_NAME="production"

export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$REPO_ROOT/node_modules/.bin"
export SSH_AUTH_SOCK="/run/user/$UID/ssh-tpm-agent.sock"

cd "$REPO_ROOT"

CURRENT_BRANCH="$(git branch --show-current)"

if [[ "$CURRENT_BRANCH" != "$BRANCH_NAME" ]]; then
  echo "ERROR: current branch is '$CURRENT_BRANCH'; checkout '$BRANCH_NAME' before building." >&2
  exit 1
fi

if ! UPSTREAM_REF="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)"; then
  echo "ERROR: branch '$BRANCH_NAME' has no upstream configured." >&2
  exit 1
fi

UPSTREAM_REMOTE="${UPSTREAM_REF%%/*}"
UPSTREAM_BRANCH="${UPSTREAM_REF#*/}"

if [[ "$UPSTREAM_BRANCH" != "$BRANCH_NAME" ]]; then
  echo "ERROR: upstream branch is '$UPSTREAM_BRANCH'; expected '$BRANCH_NAME'." >&2
  exit 1
fi

echo "==> Pulling $UPSTREAM_REF..."
git pull --ff-only "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"

HEAD_HASH="$(git rev-parse HEAD)"
HEAD_SHORT="$(git rev-parse --short HEAD)"

echo "==> Building current $BRANCH_NAME checkout at $HEAD_SHORT ($HEAD_HASH)..."
echo "==> Building and reinstalling from $BRANCH_NAME..."
"$REPO_ROOT/build-local.sh" "$@"
