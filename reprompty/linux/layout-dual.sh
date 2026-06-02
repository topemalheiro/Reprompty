#!/bin/bash
LOG=/tmp/layout-dual.log
echo "$(date '+%Y-%m-%d %H:%M:%S') WRAPPER DUAL CALLED with args: $@" >> "$LOG"
python3 "/home/tope/Projects/OS-Toolkit/Reprompty/VSCodeSidePanelLayout/linux_layout.py" --once --slot A "$@" >> "$LOG" 2>&1
echo "$(date '+%Y-%m-%d %H:%M:%S') WRAPPER DUAL EXIT: $?" >> "$LOG"
