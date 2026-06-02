#!/bin/bash
# Reprompty launcher for Linux KDE

export PATH="$HOME/.local/node/bin:$PATH"
REPO_DIR="/home/tope/Projects/OS-Toolkit/Reprompty/reprompty"
RELEASE_EXE="$REPO_DIR/release9/linux-unpacked/reprompty"

if [ -x "$RELEASE_EXE" ]; then
    exec "$RELEASE_EXE" "$@"
else
    cd "$REPO_DIR" || exit 1
    exec npx electron . "$@"
fi
