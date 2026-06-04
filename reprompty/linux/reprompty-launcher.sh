#!/bin/bash
# Reprompty launcher — runs from source so updates are picked up immediately

export PATH="$HOME/.local/node/bin:$PATH"
REPO_DIR="/home/tope/Projects/OS-Toolkit/Reprompty/reprompty"

# Prevent Electron from running as Node (breaks native modules)
unset ELECTRON_RUN_AS_NODE
unset ELECTRON_NO_ATTACH_CONSOLE

cd "$REPO_DIR" || exit 1
exec npx electron . "$@"
