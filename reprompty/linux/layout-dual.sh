#!/bin/bash
exec python3 "$(dirname "$(readlink -f "$0")")/../../VSCodeSidePanelLayout/linux_layout.py" --once --slot A "$@"
