#!/bin/bash
LOG=/tmp/layout-single.log
echo "$(date '+%Y-%m-%d %H:%M:%S') WRAPPER SINGLE CALLED with args: $@" >> "$LOG"
python3 "/home/tope/Projects/OS-Toolkit/Reprompty/VSCodeSidePanelLayout/linux_layout.py" --once --slot B "$@" >> "$LOG" 2>&1
echo "$(date '+%Y-%m-%d %H:%M:%S') WRAPPER SINGLE EXIT: $?" >> "$LOG"
