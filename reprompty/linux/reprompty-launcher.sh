#!/bin/bash
# Reprompty launcher for the app menu: runs the app from this source folder.

DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"

# Prevent Electron from running as Node (breaks native modules)
unset ELECTRON_RUN_AS_NODE
unset ELECTRON_NO_ATTACH_CONSOLE

cd "$DIR" || exit 1
if command -v node >/dev/null 2>&1; then
    exec node scripts/launch.cjs "$@"
fi
exec "$DIR/node_modules/electron/dist/electron" . "$@"
