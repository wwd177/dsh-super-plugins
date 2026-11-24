#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
INSTALL_MJS="$SCRIPT_DIR/scripts/install.mjs"

if [ ! -f "$INSTALL_MJS" ]; then
  echo "[ERROR] Missing installer script: $INSTALL_MJS" >&2
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -ge 22 ] 2>/dev/null; then
    exec node "$INSTALL_MJS" "$@"
  fi
fi

# Fallback to DeepSeek Harness bundled Electron runtime on macOS / Linux when system Node >=22 is absent
for BIN in \
  "${DSH_INSTALL_DIR:-}/Contents/MacOS/DeepSeek Harness" \
  "${DSH_INSTALL_DIR:-}/deepseek-harness" \
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  "$HOME/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  "/opt/DeepSeek Harness/deepseek-harness" \
  "/opt/deepseek-harness/deepseek-harness" \
  "/usr/lib/deepseek-harness/deepseek-harness"
do
  if [ -n "$BIN" ] && [ -x "$BIN" ]; then
    ELECTRON_RUN_AS_NODE=1 exec "$BIN" "$INSTALL_MJS" "$@"
  fi
done

echo "[ERROR] Neither Node.js (>=22) nor DeepSeek Harness executable was found. Install Node.js >=22 or set DSH_INSTALL_DIR." >&2
exit 1
