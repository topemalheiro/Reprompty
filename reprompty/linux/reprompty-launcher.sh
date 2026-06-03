#!/bin/bash
# Reprompty launcher — runs from source so updates are picked up immediately

export PATH="$HOME/.local/node/bin:$PATH"
REPO_DIR="/home/tope/Projects/OS-Toolkit/Reprompty/reprompty"

cd "$REPO_DIR" || exit 1
exec npx electron . "$@"
