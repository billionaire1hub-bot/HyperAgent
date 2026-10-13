#!/bin/bash
# Railway start script: runs the compiled API server directly.
set -e

# Always run from the repo root, regardless of where we're invoked from.
cd "$(dirname "${BASH_SOURCE[0]}")"

# --- Resolve `node` if it isn't already on PATH (Railpack/mise/nvm/corepack) ---
if ! command -v node >/dev/null 2>&1; then
  # Common install locations (Railpack uses mise; others use /usr/local, nvm, etc.)
  for dir in \
    "$HOME/.local/share/mise/shims" \
    /mise/shims \
    /root/.local/share/mise/shims \
    /usr/local/bin \
    /usr/bin \
    "$HOME/.volta/bin" \
    "$HOME/.local/bin"; do
    if [ -x "$dir/node" ]; then
      export PATH="$dir:$PATH"
      break
    fi
  done
fi

# Versioned installs (mise installs dir, nvm) - pick the newest if still missing.
if ! command -v node >/dev/null 2>&1; then
  for pattern in \
    "$HOME/.local/share/mise/installs/node/*/bin" \
    /mise/installs/node/*/bin \
    "$HOME/.nvm/versions/node/*/bin"; do
    # shellcheck disable=SC2086
    latest="$(ls -d $pattern 2>/dev/null | sort -V | tail -n 1)"
    if [ -n "$latest" ] && [ -x "$latest/node" ]; then
      export PATH="$latest:$PATH"
      break
    fi
  done
fi

# Corepack shims (pnpm/yarn) - enable if available; never fatal.
if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "start.sh: FATAL: 'node' not found on PATH (PATH=$PATH)" >&2
  exit 127
fi

SERVER="artifacts/api-server/dist/index.mjs"
if [ ! -f "$SERVER" ]; then
  echo "start.sh: FATAL: $SERVER not found. Did the build step (pnpm build) run?" >&2
  exit 1
fi

echo "start.sh: using node $(command -v node) ($(node --version))"
exec node "$SERVER"
