#!/bin/bash
# kwin-shortcut-guard.sh — Keeps KWin Super+G/W/C shortcuts alive on KDE Wayland multi-desktop setups.
#
# Usage:
#   kwin-shortcut-guard.sh status            Show current shortcut/effect state
#   kwin-shortcut-guard.sh check             Heuristic check for broken cube state
#   kwin-shortcut-guard.sh diagnose          Collect a diagnostic snapshot without repairing
#   kwin-shortcut-guard.sh refresh           Lightweight refresh (re-register + restart kglobalaccel)
#   kwin-shortcut-guard.sh repair            Full repair (refresh + restart kwin_wayland)
#   kwin-shortcut-guard.sh watchdog [secs]   Run refresh every N seconds (default: 300)
#   kwin-shortcut-guard.sh auto_repair [secs] Monitor for triggers and run repair (default: 60)
#
# reprompty-mcp: {"toolName": "kwin_shortcut_status", "label": "KWin Shortcut Status", "description": "Show current state of Super+G/W/C KWin shortcuts", "args": ["status"]}
# reprompty-mcp: {"toolName": "kwin_shortcut_check", "label": "Check KWin Cube Health", "description": "Heuristic check for broken Super+C cube drag state", "args": ["check"]}
# reprompty-mcp: {"toolName": "kwin_shortcut_diagnose", "label": "Collect KWin Diagnosis", "description": "Collect a diagnostic snapshot for upstream KDE bug reporting", "args": ["diagnose"]}
# reprompty-mcp: {"toolName": "kwin_shortcut_refresh", "label": "Refresh KWin Shortcuts", "description": "Lightweight refresh: re-register shortcuts and restart kglobalaccel", "args": ["refresh"]}
# reprompty-mcp: {"toolName": "kwin_shortcut_repair", "label": "Repair KWin Shortcuts", "description": "Full repair: refresh shortcuts and restart kwin_wayland", "args": ["repair"]}
# reprompty-mcp: {"toolName": "kwin_shortcut_auto_repair_start", "label": "Start KWin Auto-Repair", "description": "Monitor for sleep/resume/output changes and auto-repair cube", "args": ["auto_repair", "60"]}
# reprompty-mcp: {"toolName": "kwin_shortcut_watchdog_start", "label": "Start KWin Shortcut Watchdog", "description": "Start background watchdog that refreshes shortcuts every 5 minutes", "args": ["watchdog", "300"]}
# reprompty-mcp: {"toolName": "kwin_shortcut_watchdog_stop", "label": "Stop KWin Watchdog/Auto-Repair", "description": "Stop the background KWin shortcut watchdog or auto-repair daemon", "args": ["stop_watchdog"]}

set -e

# Safety limits for auto_repair mode to avoid restart loops on login/resume.
: "${KSG_STARTUP_GRACE_SECONDS:=300}"   # don't restart kwin_wayland within first N seconds
: "${KSG_HEALTH_FAILURE_THRESHOLD:=3}"  # require N consecutive health failures before full repair
: "${KSG_MAX_REPAIRS_PER_HOUR:=6}"      # hard cap on full repairs to prevent runaway loops

LOG_DIR="$HOME/.local/share/kwin-shortcut-guard"
LOG_FILE="$LOG_DIR/guard.log"
WATCHDOG_PID_FILE="$LOG_DIR/watchdog.pid"
STATE_FILE="$LOG_DIR/state.conf"
DIAG_DIR="$LOG_DIR/diagnostics"
mkdir -p "$LOG_DIR" "$DIAG_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

log_raw() {
    echo "$*" >> "$LOG_FILE"
}

shortcut_registered() {
    local name="$1"
    qdbus6 --literal org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.allShortcutInfos 2>/dev/null \
        | tr ',' '\n' \
        | grep -iE "\"$name\"" >/dev/null 2>&1
}

effect_loaded() {
    local name="$1"
    qdbus6 org.kde.KWin /Effects loadedEffects 2>/dev/null | grep -qiE "^$name$"
}

current_desktop() {
    qdbus6 org.kde.KWin /KWin org.kde.KWin.currentDesktop 2>/dev/null || echo "?"
}

active_output() {
    qdbus6 org.kde.KWin /KWin org.kde.KWin.activeOutputName 2>/dev/null || echo "?"
}

desktop_count() {
    qdbus6 org.kde.KWin /KWin org.kde.KWin.desktops 2>/dev/null | wc -w || echo "?"
}

kwin_support_info() {
    qdbus6 org.kde.KWin /KWin org.kde.KWin.supportInformation 2>/dev/null || echo "(failed)"
}

recent_kwin_errors() {
    journalctl --user -u plasma-kwin.service --since "5 minutes ago" --no-pager 2>/dev/null \
        | grep -iE "(error|warn|fail|cube|effect|input|drag|touch|shortcut)" \
        || true
}

recent_system_resume() {
    # Look for recent suspend/resume markers in system journal.
    journalctl --system --since "10 minutes ago" --no-pager 2>/dev/null \
        | grep -iE "(system-suspend|systemd-sleep|handling system-suspend|thaw|resume)" \
        || true
}

show_status() {
    echo "=== KWin Shortcut Guard Status ==="
    echo "Current desktop: $(current_desktop)"
    echo "Active output: $(active_output)"
    echo "Desktop count: $(desktop_count)"
    echo ""
    echo "Shortcut registrations:"
    for s in "Grid View" "Overview" "Cube"; do
        if shortcut_registered "$s"; then
            echo "  $s: registered"
        else
            echo "  $s: NOT REGISTERED"
        fi
    done
    echo ""
    echo "Loaded effects:"
    for e in cube windowview overview; do
        if effect_loaded "$e"; then
            echo "  $e: loaded"
        else
            echo "  $e: NOT LOADED"
        fi
    done
    echo ""
    echo "Recent KWin warnings/errors (last 5 min):"
    recent_kwin_errors | tail -10 || echo "  (none)"
    echo ""
    echo "Log file: $LOG_FILE"
}

check_health() {
    local broken_reasons=""

    if ! shortcut_registered "Cube"; then
        broken_reasons="$broken_reasons; Cube shortcut not registered"
    fi

    if ! effect_loaded "cube"; then
        broken_reasons="$broken_reasons; Cube effect not loaded"
    fi

    # NOTE: journal-based heuristics (recent KWin errors / system resume) are intentionally
    # excluded from the automated health check. They produce false positives at startup and
    # cause the guard to restart KWin in a loop, crashing Plasma. Use them only in manual
    # `check` / `diagnose` commands.

    if [ -n "$broken_reasons" ]; then
        echo "HEALTH: BROKEN (${broken_reasons#; })"
        log "Health check: BROKEN (${broken_reasons#; })"
        return 1
    else
        echo "HEALTH: OK"
        return 0
    fi
}

startup_grace_remaining() {
    local start_time_file="$LOG_DIR/auto-repair-start.time"
    if [ ! -f "$start_time_file" ]; then
        echo "0"
        return
    fi
    local start_ts now_ts elapsed remaining
    start_ts=$(cat "$start_time_file")
    now_ts=$(date +%s)
    elapsed=$(( now_ts - start_ts ))
    remaining=$(( KSG_STARTUP_GRACE_SECONDS - elapsed ))
    if [ "$remaining" -lt 0 ]; then
        echo "0"
    else
        echo "$remaining"
    fi
}

repair_count_this_hour() {
    local count=0
    if [ -f "$LOG_FILE" ]; then
        count=$(grep -cE "\[$(date '+%Y-%m-%d %H'):.*Repairing KWin shortcuts" "$LOG_FILE" 2>/dev/null || true)
    fi
    echo "${count:-0}"
}

ensure_shortcuts_configured() {
    kwriteconfig6 --file kwinrc --group Plugins --key cubeEnabled true
    kwriteconfig6 --file kwinrc --group Plugins --key gridEnabled true
    kwriteconfig6 --file kwinrc --group Plugins --key overviewEnabled true

    kwriteconfig6 --file kglobalshortcutsrc --group kwin --key "Grid View" "Meta+G,Meta+G,Toggle Grid View"
    kwriteconfig6 --file kglobalshortcutsrc --group kwin --key "Overview" "Meta+W,Meta+W,Toggle Overview"
    kwriteconfig6 --file kglobalshortcutsrc --group kwin --key "Cube" "Meta+C,Meta+C,Toggle Cube"
}

restart_kglobalaccel() {
    log "Restarting plasma-kglobalaccel..."
    systemctl restart --user plasma-kglobalaccel.service
    sleep 1
}

restart_kwin() {
    log "Restarting kwin_wayland..."
    kwin_wayland --replace &
    sleep 2
}

collect_diagnostics() {
    local stamp
    stamp="$(date +%Y%m%d-%H%M%S)"
    local out="$DIAG_DIR/kwin-diagnosis-$stamp.txt"
    {
        echo "=== KWin Cube Diagnostic Snapshot ==="
        echo "Timestamp: $(date)"
        echo "Current desktop: $(current_desktop)"
        echo "Active output: $(active_output)"
        echo "Desktop count: $(desktop_count)"
        echo ""
        echo "--- Loaded effects ---"
        qdbus6 org.kde.KWin /Effects loadedEffects 2>/dev/null || true
        echo ""
        echo "--- Cube effect loaded? ---"
        qdbus6 org.kde.KWin /Effects org.kde.kwin.Effects.isEffectLoaded cube 2>/dev/null || true
        echo ""
        echo "--- KWin shortcut registrations ---"
        qdbus6 --literal org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.allShortcutInfos 2>/dev/null \
            | tr ',' '\n' \
            | grep -iE '"(Grid View|Overview|Cube)"' -A8 || echo "(not found)"
        echo ""
        echo "--- Recent KWin journal (last 50 lines) ---"
        journalctl --user -u plasma-kwin.service -n 50 --no-pager 2>/dev/null || true
        echo ""
        echo "--- System resume events (last 30 min) ---"
        journalctl --system --since "30 minutes ago" --no-pager 2>/dev/null \
            | grep -iE "(system-suspend|systemd-sleep|handling system-suspend|thaw|resume)" || true
        echo ""
        echo "--- KWin support information ---"
        kwin_support_info
    } > "$out"
    log "Diagnostics written to: $out"
    echo "$out"
}

cmd_refresh() {
    log "Refreshing KWin shortcuts (lightweight)..."
    ensure_shortcuts_configured
    restart_kglobalaccel
    log "Refresh complete."
}

cmd_repair() {
    log "Repairing KWin shortcuts (full)..."
    local diag_file
    diag_file=$(collect_diagnostics)
    ensure_shortcuts_configured
    restart_kglobalaccel
    restart_kwin
    log "Repair complete. Diagnostics collected before repair: $diag_file"
}

cmd_check() {
    log "Running KWin cube health check..."
    check_health
}

cmd_diagnose() {
    log "Collecting KWin diagnostic snapshot..."
    local diag_file
    diag_file=$(collect_diagnostics)
    echo "Diagnostic snapshot: $diag_file"
}

save_state() {
    local output="$(active_output)"
    local desktop="$(current_desktop)"
    local count="$(desktop_count)"
    cat > "$STATE_FILE" <<EOF
output=$output
desktop=$desktop
desktopCount=$count
timestamp=$(date -Iseconds)
EOF
}

read_state_key() {
    local key="$1"
    if [ -f "$STATE_FILE" ]; then
        grep "^${key}=" "$STATE_FILE" 2>/dev/null | cut -d'=' -f2- || echo ""
    else
        echo ""
    fi
}

state_changed() {
    local prev_output prev_desktop prev_count
    prev_output=$(read_state_key output)
    prev_desktop=$(read_state_key desktop)
    prev_count=$(read_state_key desktopCount)

    local cur_output cur_desktop cur_count
    cur_output=$(active_output)
    cur_desktop=$(current_desktop)
    cur_count=$(desktop_count)

    if [ "$prev_output" != "$cur_output" ] || [ "$prev_desktop" != "$cur_desktop" ] || [ "$prev_count" != "$cur_count" ]; then
        log "State change detected: output=$prev_output->$cur_output desktop=$prev_desktop->$cur_desktop count=$prev_count->$cur_count"
        return 0
    fi
    return 1
}

cmd_watchdog() {
    local interval="${1:-300}"
    log "Starting KWin shortcut watchdog (interval: ${interval}s)..."
    cmd_stop_watchdog >/dev/null 2>&1 || true
    echo $$ > "$WATCHDOG_PID_FILE"

    while true; do
        cmd_refresh
        log "Watchdog sleeping for ${interval}s..."
        sleep "$interval"
    done
}

cmd_auto_repair() {
    local interval="${1:-60}"
    log "Starting KWin auto-repair monitor (interval: ${interval}s, startup grace: ${KSG_STARTUP_GRACE_SECONDS}s, health threshold: ${KSG_HEALTH_FAILURE_THRESHOLD})..."
    cmd_stop_watchdog >/dev/null 2>&1 || true
    echo $$ > "$WATCHDOG_PID_FILE"
    date +%s > "$LOG_DIR/auto-repair-start.time"

    save_state
    local health_failures=0
    local first_iteration=true

    while true; do
        local state_trigger=false
        local health_broken=false

        if $first_iteration; then
            # On the first iteration, record current state without treating it as a change.
            first_iteration=false
            save_state
        elif state_changed; then
            state_trigger=true
            save_state
        fi

        if ! check_health >/dev/null 2>&1; then
            health_broken=true
        fi

        if $health_broken; then
            health_failures=$((health_failures + 1))
            log "Health failure ${health_failures}/${KSG_HEALTH_FAILURE_THRESHOLD}"

            local grace
            grace=$(startup_grace_remaining)
            local repairs
            repairs=$(repair_count_this_hour)

            if [ "$grace" -gt 0 ]; then
                log "Startup grace active (${grace}s remaining): using lightweight refresh only"
                cmd_refresh
            elif [ "$repairs" -ge "$KSG_MAX_REPAIRS_PER_HOUR" ]; then
                log "Reached max full repairs this hour (${KSG_MAX_REPAIRS_PER_HOUR}); using lightweight refresh only"
                cmd_refresh
            elif [ "$health_failures" -lt "$KSG_HEALTH_FAILURE_THRESHOLD" ]; then
                log "Health threshold not reached: using lightweight refresh only"
                cmd_refresh
            else
                log "Auto-repair triggered: health check failed ${health_failures} times"
                cmd_repair
                health_failures=0
            fi
            save_state
        else
            health_failures=0
            if $state_trigger; then
                log "Auto-repair triggered: output/desktop state changed"
                cmd_refresh
                save_state
            fi
        fi

        sleep "$interval"
    done
}

cmd_stop_watchdog() {
    if [ -f "$WATCHDOG_PID_FILE" ]; then
        local pid
        pid="$(cat "$WATCHDOG_PID_FILE")"
        if kill -0 "$pid" 2>/dev/null; then
            log "Stopping watchdog (PID: $pid)..."
            kill "$pid" 2>/dev/null || true
            sleep 1
            if kill -0 "$pid" 2>/dev/null; then
                kill -9 "$pid" 2>/dev/null || true
            fi
            echo "Watchdog stopped."
        else
            echo "Watchdog not running."
        fi
        rm -f "$WATCHDOG_PID_FILE"
    else
        echo "Watchdog PID file not found."
    fi
}

case "${1:-status}" in
    status)
        show_status
        ;;
    check)
        cmd_check
        ;;
    diagnose)
        cmd_diagnose
        ;;
    refresh)
        cmd_refresh
        ;;
    repair)
        cmd_repair
        ;;
    watchdog)
        cmd_watchdog "${2:-300}"
        ;;
    auto_repair)
        cmd_auto_repair "${2:-60}"
        ;;
    stop_watchdog)
        cmd_stop_watchdog
        ;;
    *)
        echo "Usage: $0 {status|check|diagnose|refresh|repair|watchdog [secs]|auto_repair [secs]|stop_watchdog}"
        exit 1
        ;;
esac
