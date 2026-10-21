#!/bin/bash
# omniagentic-new-task.sh — Start a new Alignerr/OmniAgentic task in one go: copy "0 Example Task",
# open it in a duplicate of the Work workspace on a new virtual desktop, and snap that window to the
# bottom monitors (layout slot A, the Ctrl+Alt+V layout). Bound to Ctrl+Super+S by `register`.
#
# Usage:
#   omniagentic-new-task.sh run        Create the task folder, desktop and window (default)
#   omniagentic-new-task.sh register   Install the .desktop launcher and bind Meta+Ctrl+S to it
#
# reprompty-mcp: {"toolName": "omniagentic_new_task", "label": "New OmniAgentic Task", "description": "Copy 0 Example Task into a new task, open it in a duplicated Work window on a new desktop, and snap it to the bottom monitors", "args": ["run"]}

set -euo pipefail

WORK_DIR="/home/tope/Projects/Work"
TASKS_DIR="$WORK_DIR/Alignerr/Tasks"
TEMPLATE_DIR="$TASKS_DIR/0 Example Task"
LAYOUT_DUAL="/home/tope/Projects/OS-Toolkit/Reprompty/reprompty/linux/layout-dual.sh"
KDOTOOL="$HOME/.local/bin/kdotool"

STATE_DIR="$HOME/.local/share/omniagentic-new-task"
WORKSPACES_DIR="$STATE_DIR/workspaces"
LOG_FILE="$STATE_DIR/new-task.log"
LOCK_FILE="$STATE_DIR/new-task.lock"

DESKTOP_FILE_ID="reprompty-omniagentic-new-task.desktop"
SHORTCUT_NAME="OmniAgentic New Task"
META_CTRL_S=335544403  # Qt key code: Meta (0x10000000) | Ctrl (0x04000000) | Key_S (0x53)

ts() {
    date '+%Y-%m-%d %H:%M:%S'
}

log() {
    echo "[$(ts)] $*"
}

fail() {
    log "ERROR: $*"
    notify-send -a "OmniAgentic" "New task failed" "$*" || true
    exit 1
}

register() {
    local launcher="$HOME/.local/share/applications/$DESKTOP_FILE_ID"
    cat >"$launcher" <<EOF
[Desktop Entry]
Exec=$(realpath "$0") run
Name=$SHORTCUT_NAME
NoDisplay=true
StartupNotify=false
Type=Application
X-KDE-GlobalAccel-CommandShortcut=true
EOF
    # kglobalaccel reads the launcher when the component is first registered, so write it first.
    kbuildsycoca6 >/dev/null 2>&1 || true
    busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel doRegister \
        as 4 "$DESKTOP_FILE_ID" _launch "$SHORTCUT_NAME" "$SHORTCUT_NAME"
    # setShortcut with SetPresent (2) | NoAutoloading (4). setForeignShortcut only stores the key:
    # the action stays inactive and a real key press does nothing (D-Bus invokeShortcut still works).
    busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel setShortcut \
        asaiu 4 "$DESKTOP_FILE_ID" _launch "$SHORTCUT_NAME" "$SHORTCUT_NAME" 1 "$META_CTRL_S" 6 >/dev/null
    log "Bound Meta+Ctrl+S to $launcher"
}

run() {
    mkdir -p "$WORKSPACES_DIR"
    exec > >(tee -a "$LOG_FILE") 2>&1

    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
        log "A new task is already being created; skipping duplicate request"
        exit 0
    fi
    trap 'fail "command failed on line $LINENO"' ERR

    # Never reuse a name: an old .code-workspace may still be open, and `code -n` would just focus
    # that window. A unique name also gives the window a unique title for the layout's panel step.
    local name="New Task" n=1
    while [[ -e "$TASKS_DIR/$name" || -e "$WORKSPACES_DIR/$name.code-workspace" ]]; do
        n=$((n + 1))
        name="New Task $n"
    done

    cp -r "$TEMPLATE_DIR" "$TASKS_DIR/$name"
    local workspace="$WORKSPACES_DIR/$name.code-workspace"
    printf '{\n  "folders": [{ "name": "Work", "path": "%s" }],\n  "settings": {}\n}\n' "$WORK_DIR" >"$workspace"
    log "Created $TASKS_DIR/$name"

    local count desktop
    count=$(qdbus6 org.kde.KWin /VirtualDesktopManager count)
    qdbus6 org.kde.KWin /VirtualDesktopManager createDesktop "$count" "$name" >/dev/null
    desktop=$((count + 1))  # setCurrentDesktop and kdotool number desktops from 1
    sleep 0.25
    qdbus6 org.kde.KWin /KWin org.kde.KWin.setCurrentDesktop "$desktop" >/dev/null
    log "Switched to new desktop $desktop ($name)"

    # Detach code's output: a cold-started VS Code would otherwise hold our stdout open, and
    # Reprompty's MCP runner waits for that pipe to close.
    code -n "$workspace" "$TASKS_DIR/$name/(Gold) Human Support Files/Gold.md" </dev/null >/dev/null 2>&1

    # Poll once a second: every kdotool call loads a KWin script, and Reprompty had to throttle
    # those to stop Plasma crashing. kdotool sometimes prints nothing, so empty means "try again".
    local window=""
    for _ in {1..30}; do
        sleep 1
        window=$("$KDOTOOL" search --title "$name \\(Workspace\\)" 2>/dev/null | head -n 1 || true)
        [[ -n "$window" ]] && break
    done
    [[ -n "$window" ]] || fail "no VS Code window titled '$name (Workspace)' after 30 s"

    "$KDOTOOL" set_desktop_for_window "$window" "$desktop" ||
        log "kdotool could not move $window to desktop $desktop; leaving it where it opened"
    sleep 2  # let the workbench render the secondary side bar before the layout resizes it
    "$LAYOUT_DUAL" --window-handle "$window"
    log "Laid out $window ($name) with slot A"
}

case "${1:-run}" in
    run) run ;;
    register) register ;;
    *)
        echo "Usage: $0 {run|register}" >&2
        exit 1
        ;;
esac
