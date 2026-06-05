# Reprompty Skill

You have access to the Reprompty MCP server which provides tools for multi-window AI agent orchestration on Linux (KDE Wayland).

## Available Tools

### Window Detection
- `detect_windows` — Detect all VS Code: windows with their agents (Kilo/Kimi/Claude/Codex)
- `detect_all_windows` — Detect ALL visible windows
- `check_cdp` — Check if CDP is available for background sending

### Window Spawning
- `spawn_window` — Spawn VS Code: from target alias or folder path
- `spawn_and_layout` — Spawn + apply layout slot in one call
- `list_spawn_targets` — List saved spawn aliases

### Virtual Desktops
- `list_virtual_desktops` — List KDE desktops
- `ensure_virtual_desktop` — Create desktop if missing
- `rename_virtual_desktop` — Rename a desktop

### Layout
- `apply_layout` — Apply layout slot (A, B, or named) to a window
- `list_layout_slots` — List available slots

### Prompt Sending
- `send_prompt` — Send prompt to a connection (background, no focus)
- `add_connection` — Add a window connection
- `list_connections` — List connections
- `remove_connection` — Remove a connection
- `daisy_chain` — Chain prompts across multiple windows

### Scripts
- `list_scripts` — List registered scripts
- `run_script` — Run a script
- `stop_script` — Stop a script

## Key Behaviors

- **Desktop-aware spawns** stay on current desktop by default. Use `activateDesktop: true` to switch first.
- **Background send** uses CDP (no window focus). Falls back to foreground (clipboard + keys) if CDP fails.
- **Kimi windows** use textarea inject + Enter key for submission.
- **Layout Slot A** = dual monitor bottom. **Slot B** = top full panel.

## Example Workflows

Spawn a project on a new desktop:
```
ensure_virtual_desktop({"name": "Aperant-MCP"})
spawn_window({"target": "aperant", "desktop": "Aperant-MCP"})
```

Spawn + layout:
```
spawn_and_layout({"target": "voxtype", "slot": "A", "desktop": "VoxType"})
```

Send to detected window:
```
detect_windows() → find window → add_connection() → send_prompt()
```
