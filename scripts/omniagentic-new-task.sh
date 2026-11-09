#!/bin/bash
# omniagentic-new-task.sh — Start a new Alignerr/OmniAgentic task in one go: copy "0 Example Task"
# to "<n> New Task" (n = one past the highest numbered task, so tasks sort chronologically) with a
# Video Instructions.md skeleton, open it in a duplicate of the Work workspace on a new virtual
# desktop, and snap that window to the bottom monitors (layout slot A, the Ctrl+Alt+V layout).
# Bound to Ctrl+Super+S by `register`, through `shortcut`: while a Spite VS Code window is focused,
# the key opens a new Spite desktop instead (spite-macros new-desktop). `run-light` (Ctrl+Super+Q)
# makes the task folder and its virtual desktop but opens no window, for working in the one VS Code
# window already open.
#
# Usage:
#   omniagentic-new-task.sh run          Create the task folder, desktop and window (default)
#   omniagentic-new-task.sh run-light    Create the task folder and a new desktop; no new window
#   omniagentic-new-task.sh shortcut     Ctrl+Super+S: `run`, or a new Spite desktop from a Spite window
#   omniagentic-new-task.sh register     Install both .desktop launchers and bind Meta+Ctrl+S / Meta+Ctrl+Q
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

DESKTOP_FILE_ID="reprompty-new-task-or-spite-desktop.desktop"
SHORTCUT_NAME="OmniAgentic New Task or Spite Desktop"
# Meta+Ctrl+S's launcher before the Spite dispatch. kglobalaccel keeps the Exec it read when a
# component was first registered, so the dispatch needed a new launcher instead of an edited one.
OLD_DESKTOP_FILE_ID="reprompty-omniagentic-new-task.desktop"
SPITE_MACROS="$HOME/.local/bin/spite-macros"
LIGHT_DESKTOP_FILE_ID="reprompty-omniagentic-new-task-light.desktop"
LIGHT_SHORTCUT_NAME="OmniAgentic New Task (no window)"
META_CTRL_S=335544403  # Qt key code: Meta (0x10000000) | Ctrl (0x04000000) | Key_S (0x53)
META_CTRL_Q=335544401  # ... | Key_Q (0x51)

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

bind_shortcut() {
    local id="$1" name="$2" subcommand="$3" key="$4" label="$5"
    local launcher="$HOME/.local/share/applications/$id"
    cat >"$launcher" <<EOF
[Desktop Entry]
Exec=$(realpath "$0") $subcommand
Name=$name
NoDisplay=true
StartupNotify=false
Type=Application
X-KDE-GlobalAccel-CommandShortcut=true
EOF
    # kglobalaccel reads the launcher when the component is first registered, so write it first.
    kbuildsycoca6 >/dev/null 2>&1 || true
    busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel doRegister \
        as 4 "$id" _launch "$name" "$name"
    # setShortcut with SetPresent (2) | NoAutoloading (4). setForeignShortcut only stores the key:
    # the action stays inactive and a real key press does nothing (D-Bus invokeShortcut still works).
    busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel setShortcut \
        asaiu 4 "$id" _launch "$name" "$name" 1 "$key" 6 >/dev/null
    log "Bound $label to $launcher"
}

register() {
    busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel unregister \
        ss "$OLD_DESKTOP_FILE_ID" _launch >/dev/null
    bind_shortcut "$DESKTOP_FILE_ID" "$SHORTCUT_NAME" shortcut "$META_CTRL_S" Meta+Ctrl+S
    bind_shortcut "$LIGHT_DESKTOP_FILE_ID" "$LIGHT_SHORTCUT_NAME" run-light "$META_CTRL_Q" Meta+Ctrl+Q
}

run() {
    local light=0
    [[ "${1:-}" == --light ]] && light=1
    mkdir -p "$WORKSPACES_DIR"
    exec > >(tee -a "$LOG_FILE") 2>&1

    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
        log "A new task is already being created; skipping duplicate request"
        exit 0
    fi
    trap 'fail "command failed on line $LINENO"' ERR

    # Number the task one past the highest "<n> " prefix in Tasks, so the folders sort by date.
    local n=0 dir
    for dir in "$TASKS_DIR"/*/; do
        if [[ $(basename "$dir") =~ ^([0-9]+)\  ]] && ((10#${BASH_REMATCH[1]} >= n)); then
            n=$((10#${BASH_REMATCH[1]} + 1))
        fi
    done

    # Never reuse a name: an old .code-workspace may still be open, and `code -n` would just focus
    # that window. A unique name also gives the window a unique title for the layout's panel step.
    local name="$n New Task"
    while [[ -e "$TASKS_DIR/$name" || -e "$WORKSPACES_DIR/$name.code-workspace" ]]; do
        n=$((n + 1))
        name="$n New Task"
    done

    cp -r "$TEMPLATE_DIR" "$TASKS_DIR/$name"

    # The recording aid that the deliverables step fills in; never uploaded. A template copy wins.
    local instructions="$TASKS_DIR/$name/Video Instructions.md"
    if [[ ! -e "$instructions" ]]; then
        cat >"$instructions" <<'EOF'
# Video instructions (not uploaded)

Not uploaded, and not to be recorded: keep OBS's Top-Left source hidden while this is open (the
opener hides it).

## Files to open and show (in Problem Files)

| File | Lines | What it shows |
|---|---|---|

## Show on screen (not in the files)

## What the rubric needs the video to ask for
EOF
    fi

    log "Created $TASKS_DIR/$name"

    local count desktop previous=""
    count=$(qdbus6 org.kde.KWin /VirtualDesktopManager count)
    qdbus6 org.kde.KWin /VirtualDesktopManager createDesktop "$count" "$name" >/dev/null
    desktop=$((count + 1))  # setCurrentDesktop and kdotool number desktops from 1
    if background; then
        previous=$("$KDOTOOL" getactivewindow 2>/dev/null || true)
        log "Created desktop $desktop ($name) without switching to it (run by an agent)"
    else
        sleep 0.25
        qdbus6 org.kde.KWin /KWin org.kde.KWin.setCurrentDesktop "$desktop" >/dev/null
        log "Switched to new desktop $desktop ($name)"
    fi

    if ((light)); then
        notify-send -a "OmniAgentic" "New task: $name" "Folder created, on its own new desktop" || true
        return 0
    fi

    local workspace="$WORKSPACES_DIR/$name.code-workspace"
    printf '{\n  "folders": [{ "name": "Work", "path": "%s" }],\n  "settings": {}\n}\n' "$WORK_DIR" >"$workspace"

    # Detach code's output: a cold-started VS Code would otherwise hold our stdout open, and
    # Reprompty's MCP runner waits for that pipe to close.
    code -n "$workspace" "$TASKS_DIR/$name/(Gold) Human Support Files/Gold.md" </dev/null >/dev/null 2>&1

    # Poll once a second: every kdotool call loads a KWin script, and Reprompty had to throttle
    # those to stop Plasma crashing. kdotool sometimes prints nothing, so empty means "try again".
    local window=""
    for _ in {1..30}; do
        sleep 1
        # Anchored, so "4 New Task" can't match a "14 New Task (Workspace)" window.
        window=$("$KDOTOOL" search --title "(^|- )$name \\(Workspace\\)" 2>/dev/null | head -n 1 || true)
        [[ -n "$window" ]] && break
    done
    [[ -n "$window" ]] || fail "no VS Code window titled '$name (Workspace)' after 30 s"

    sleep 2  # let the workbench render the secondary side bar before the layout resizes it
    "$LAYOUT_DUAL" --window-handle "$window"
    log "Laid out $window ($name) with slot A"
    "$KDOTOOL" set_desktop_for_window "$window" "$desktop" ||
        log "kdotool could not move $window to desktop $desktop; leaving it where it opened"
    if background; then
        give_focus_back "$previous"
    fi
}

background() {
    [[ "${REPROMPTY_BACKGROUND:-}" == 1 ]]
}

give_focus_back() {
    local window=$1 current
    [[ -n "$window" ]] || return 0
    current=$(qdbus6 org.kde.KWin /KWin org.kde.KWin.currentDesktop 2>/dev/null || true)
    [[ -n "$current" && "$("$KDOTOOL" get_desktop_for_window "$window" 2>/dev/null || true)" == "$current" ]] ||
        return 0
    "$KDOTOOL" windowactivate "$window" >/dev/null 2>&1 || true
    log "Gave focus back to $window"
}

# A focused Spite VS Code window gets a new Spite desktop instead of a new task.
shortcut() {
    if "$SPITE_MACROS" focused; then
        exec "$SPITE_MACROS" new-desktop
    fi
    run
}

case "${1:-run}" in
    run) run ;;
    run-light) run --light ;;
    shortcut) shortcut ;;
    register) register ;;
    *)
        echo "Usage: $0 {run|run-light|shortcut|register}" >&2
        exit 1
        ;;
esac
