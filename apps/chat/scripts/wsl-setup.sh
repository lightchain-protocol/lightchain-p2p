#!/usr/bin/env bash
#
# Builds the workspace inside WSL, so `wsl-peer.mjs` can run there as a genuine
# second machine. Run once; re-run to pick up changes.
#
#     wsl -d Ubuntu -e bash scripts/wsl-setup.sh
#
# The source is copied from the Windows disk rather than cloned. Cloning would
# be tidier, but git over HTTPS to GitHub hangs indefinitely from inside WSL on
# at least one machine this was written on, while the npm registry answers
# normally — and the tree is right there on /mnt/c either way.
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# WSL puts the Windows PATH on the end of its own, so a bare `npm` can resolve
# to npm.exe — which runs, reports a version, and then cannot find node.
command -v node >/dev/null || {
  echo "no linux node found. Install one with nvm:" >&2
  echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash" >&2
  echo "  nvm install --lts" >&2
  exit 1
}

SRC="${LCAI_SRC:-/mnt/c/Users/PC/Desktop/PEAR Open Source/dev/lightchain-p2p}"
REPO="$HOME/lc/lightchain-p2p"

[ -d "$SRC" ] || {
  echo "cannot find the source at $SRC" >&2
  echo "set LCAI_SRC to the repository's path under /mnt/c" >&2
  exit 1
}

corepack enable pnpm >/dev/null 2>&1 || npm install -g pnpm >/dev/null 2>&1 || true
echo "--- node $(node --version), pnpm $(pnpm --version)"

echo "--- copying the source"
rm -rf "$REPO"
mkdir -p "$REPO"
# Everything except what gets rebuilt. Windows node_modules would be actively
# harmful: the native addons are compiled for the wrong platform.
tar -C "$SRC" \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=.turbo \
  --exclude=dist \
  --exclude=shots \
  --exclude=.tmp \
  -cf - . | tar -C "$REPO" -xf -

cd "$REPO"
echo "--- installing"
pnpm install --silent

echo "--- building"
pnpm build >/dev/null

echo "--- ready: $REPO"
