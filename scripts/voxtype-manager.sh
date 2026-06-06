#!/bin/bash
# reprompty-mcp: {"toolName": "voxtype_status", "label": "VoxType Status", "description": "Show status of VoxType Live and system VoxType", "args": ["status"]}
# reprompty-mcp: {"toolName": "voxtype_start_live", "label": "Start VoxType Live", "description": "Start VoxType Live streaming dictation", "args": ["start_live"]}
# reprompty-mcp: {"toolName": "voxtype_stop_live", "label": "Stop VoxType Live", "description": "Stop VoxType Live streaming dictation", "args": ["stop_live"]}

PYTHON="/home/tope/Projects/OS-Toolkit/GitHubGrid/.venv/bin/python"
LIVE_SCRIPT="/home/tope/Projects/OS-Toolkit/VoxType/voxtype-live/voxtype-live.py"

case "${1:-status}" in
  status)
    echo "=== VoxType Status ==="
    echo ""
    echo "System VoxType (push-to-talk):"
    systemctl --user is-active voxtype 2>/dev/null && echo "  Status: RUNNING" || echo "  Status: STOPPED"
    echo ""
    echo "VoxType Live (streaming):"
    LIVE_PID=$(pgrep -f "voxtype-live.py" | head -1)
    if [ -n "$LIVE_PID" ]; then
      echo "  Status: RUNNING (PID: $LIVE_PID)"
      MODEL=$(ps -fp "$LIVE_PID" -o args= 2>/dev/null | grep -oP 'model/\S+' | head -1 || echo "")
      if [ -n "$MODEL" ]; then
        echo "  Model: $MODEL"
      fi
    else
      echo "  Status: STOPPED"
    fi
    echo ""
    echo "Configured model directory: ~/tools/nerd-dictation/model/"
    ;;
  start_live)
    LIVE_PID=$(pgrep -f "voxtype-live.py" | head -1)
    if [ -n "$LIVE_PID" ]; then
      echo "VoxType Live is already running (PID: $LIVE_PID)"
      exit 0
    fi
    echo "Starting VoxType Live..."
    nohup "$PYTHON" "$LIVE_SCRIPT" >/dev/null 2>&1 &
    sleep 1
    NEW_PID=$(pgrep -f "voxtype-live.py" | head -1)
    if [ -n "$NEW_PID" ]; then
      echo "VoxType Live started (PID: $NEW_PID)"
    else
      echo "Failed to start VoxType Live"
      exit 1
    fi
    ;;
  stop_live)
    LIVE_PID=$(pgrep -f "voxtype-live.py" | head -1)
    if [ -n "$LIVE_PID" ]; then
      echo "Stopping VoxType Live (PID: $LIVE_PID)..."
      kill "$LIVE_PID" 2>/dev/null
      sleep 1
      if pgrep -f "voxtype-live.py" >/dev/null; then
        kill -9 "$LIVE_PID" 2>/dev/null
      fi
      echo "VoxType Live stopped"
    else
      echo "VoxType Live is not running"
    fi
    ;;
  *)
    echo "Usage: $0 {status|start_live|stop_live}"
    exit 1
    ;;
esac
