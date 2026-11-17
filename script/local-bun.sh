#!/usr/bin/env bash

use_repo_bun() {
  local repo="$1" pin version cache archive platform current
  pin="$(node -p 'require(process.argv[1]).packageManager' "$repo/package.json")"
  if [[ ! "$pin" =~ ^bun@([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$ ]]; then
    echo "ERROR: package.json must pin an exact Bun version; found: $pin" >&2
    return 1
  fi
  version="${BASH_REMATCH[1]}"
  current="$(command -v bun || true)"
  if [[ -n "$current" && "$("$current" --version)" == "$version" ]]; then
    current="$(dirname "$current")"
    export PATH="$current:$PATH"
    return 0
  fi

  cache="${XDG_CACHE_HOME:-$HOME/.cache}/opencode-local/bun/$version"
  mkdir -p "$cache"
  (
    set -euo pipefail
    flock 9
    if [[ -x "$cache/bin/bun" && "$("$cache/bin/bun" --version)" == "$version" ]]; then
      exit 0
    fi
    case "$(uname -s)-$(uname -m)" in
      Linux-x86_64) platform=linux-x64 ;;
      *) echo "ERROR: automatic local Bun installation supports Linux x86_64 only" >&2; exit 1 ;;
    esac
    archive="bun-$platform.zip"
    local tmp base checksum
    tmp="$(mktemp -d "$cache/.download.XXXXXX")"
    trap 'rm -rf -- "$tmp"' EXIT
    base="https://github.com/oven-sh/bun/releases/download/bun-v$version"
    echo "==> Installing repository-pinned Bun $version..."
    curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 -o "$tmp/$archive" "$base/$archive"
    curl -fsSL --retry 3 --connect-timeout 15 --max-time 60 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
    checksum="$(awk -v name="$archive" '$2 == name || $2 == "*" name { print $1 }' "$tmp/SHASUMS256.txt")"
    [[ "$checksum" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "ERROR: missing Bun archive checksum" >&2; exit 1; }
    (cd "$tmp" && printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -)
    unzip -p "$tmp/$archive" "bun-$platform/bun" > "$tmp/bun"
    chmod +x "$tmp/bun"
    [[ "$("$tmp/bun" --version)" == "$version" ]] || { echo "ERROR: downloaded Bun version does not match $pin" >&2; exit 1; }
    mkdir -p "$cache/bin"
    mv -f "$tmp/bun" "$cache/bin/bun"
  ) 9>"$cache/install.lock"
  export PATH="$cache/bin:$PATH"
}
