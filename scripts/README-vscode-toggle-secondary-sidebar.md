# VS Code: Secondary Side Bar Toggle

A Reprompty-registered Python script that toggles VS Code:'s secondary/auxiliary side bar via Chrome DevTools Protocol, disables the default `Ctrl+Alt+B` keybinding, and lets you bind any key (e.g. Pause/Break) to trigger the toggle.

## Files

- `vscode-toggle-secondary-sidebar.py` — main script
- `.venv/` — local Python virtual environment with `evdev` (created automatically)

## MCP actions (Reprompty Scripts tab)

| Action | Purpose |
|--------|---------|
| `toggle_secondary_sidebar` | Toggle the secondary side bar |
| `configure_sidebar_key` | Open the key-capture GUI |
| `disable_ctrl_alt_b` | Remove the default `Ctrl+Alt+B` binding |
| `enable_ctrl_alt_b` | Restore the default `Ctrl+Alt+B` binding |
| `start_sidebar_listener` | Start listening for your configured key |
| `stop_sidebar_listener` | Stop the listener |
| `sidebar_listener_status` | Show listener state |

## Requirements

- VS Code: running with CDP enabled on `localhost:9222` (Reprompty/Kilo Code: usually enables this)
- Python 3.10+
- `evdev` is only needed for the key listener; the script installs it into a local `.venv`

## Quick start

1. In Reprompty, click **Configure Sidebar Key**.
2. In the window that opens, click **Capture Key**, then press your special key (e.g. Pause/Break).
3. Click **Apply**. This will:
   - save the key,
   - disable `Ctrl+Alt+B` in VS Code:,
   - start the listener.
4. Press your key — the side bar toggles.

## Manual usage

```bash
cd /home/tope/Projects/OS-Toolkit/Reprompty/scripts

# Toggle the side bar
python3 vscode-toggle-secondary-sidebar.py toggle

# Open the key-capture GUI
python3 vscode-toggle-secondary-sidebar.py configure

# Disable/restore Ctrl+Alt+B
python3 vscode-toggle-secondary-sidebar.py disable_ctrl_alt_b
python3 vscode-toggle-secondary-sidebar.py enable_ctrl_alt_b

# Listener control
python3 vscode-toggle-secondary-sidebar.py start
python3 vscode-toggle-secondary-sidebar.py stop
python3 vscode-toggle-secondary-sidebar.py status
```

## How the key binding works

- The captured key is stored in `~/.reprompty/vscode-sidebar-key.json`.
- The listener grabs all keyboards that expose that key, so the key does not reach other applications.
- You must be in the `input` group (check with `id`) or run with root privileges for the grab to work.

## How Ctrl+Alt+B is disabled

The script edits `~/.config/Code:/User/keybindings.json` and adds a rule that unbinds `Ctrl+Alt+B` from `workbench.action.toggleAuxiliaryBar`. VS Code: usually reloads this file automatically; if not, run **Developer: Reload Window** from the command palette.

## Troubleshooting

- **"No keyboard with KEY_PAUSE found"**: Run `configure` and capture your exact key.
- **"evdev is not installed"**: The script will use `.venv` automatically; if `.venv` is missing, run:
  ```bash
  python3 -m venv .venv
  .venv/bin/pip install evdev
  ```
- **Toggle does nothing**: Make sure VS Code: is focused and no modal/notification is blocking input.
- **Listener permission error**: Add your user to the `input` group and re-login, or run with `sudo`.
