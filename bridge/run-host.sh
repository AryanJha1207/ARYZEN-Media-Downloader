#!/bin/sh
# Launched by the browser via the native messaging manifest.
# Resolves its own location: no dependence on $HOME or the environment.
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$SELF_DIR/../runtime/python/bin/python3" ]; then
  exec "$SELF_DIR/../runtime/python/bin/python3" "$SELF_DIR/umd_host.py"
fi
exec python3 "$SELF_DIR/umd_host.py"
