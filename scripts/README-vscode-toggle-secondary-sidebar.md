# VS Code: Secondary Side Bar Toggle

A Reprompty-registered Python script that toggles VS Code:'s secondary/auxiliary side bar via Chrome DevTools Protocol, optionally disables the default `Ctrl+Alt+B` keybinding, and can listen for the **Pause/Break** key to trigger the toggle.

## Files

- `vscode-toggle-secondary-sidebar.py` — main script
- `.venv/` — local Python virtual environment with `evdev` (created automatically on first `start`)

## MCP actions (Reprompty Scripts tab)

The script exposes these actions automatically through `# reprompty-mcp:` header comments:

| Action | Purpose |
|--------|---------|
| `toggle_secondary_sidebar` | Toggle the secondary side bar |
| `disable_ctrl_alt_b` | Remove the default `Ctrl+Alt+B` binding |
| `enable_ctrl_alt_b` | Restore the default `Ctrl+Alt+B` binding |
| `start_pause_break_listener` | Start listening for Pause/Break |
| `stop_pause_break_listener` | Stop the listener |
| `pause_break_listener_status` | Show listener state |

## Requirements

- VS Code: running with CDP enabled on `localhost:9222` (Reprompty/Kilo Code: usually enables this)
- Python 3.10+
- `evdev` is only needed for the Pause/Break listener; the script installs it into a local `.venv`

## Manual usage

```bash
cd /home/tope/Projects/OS-Toolkit/Reprompty/scripts

# Toggle the side bar
python3 vscode-toggle-secondary-sidebar.py toggle

# Disable/restore Ctrl+Alt+B
python3 vscode-toggle-secondary-sidebar.py disable_ctrl_alt_b
python3 vscode-toggle-secondary-sidebar.py enable_ctrl_alt_b

# Pause/Break listener
python3 vscode-toggle-secondary-sidebar.py start
python3 vscode-toggle-secondary-sidebar.py stop
python3 vscode-toggle-secondary-sidebar.py status
```

## Pause/Break listener notes

- The listener grabs all keyboards that expose `KEY_PAUSE`, so the key does not reach other applications.
- You must be in the `input` group (check with `id`) or run the script with root privileges.
- If `evdev` is missing, the script will create/use `.venv` and install it automatically.

## Alternative: KDE global shortcut

If you prefer not to use the evdev listener, bind the `toggle_secondary_sidebar` MCP action (or the raw script) to a KDE global shortcut:

1. Open **System Settings → Shortcuts → Custom Shortcuts**.
2. Add a new global shortcut → command/URL.
3. Set the trigger to Pause/Break.
4. Set the command to:
   ```bash
   python3 /home/tope/Projects/OS-Toolkit/Reprompty/scripts/vscode-toggle-secondary-sidebar.py toggle
   ```
5. Run `disable_ctrl_alt_b` once so only your shortcut toggles the side bar.

## Troubleshooting

- **"No VS Code: page found on CDP"**: Make sure VS Code: is running and CDP is enabled on port 9222.
- **Toggle does nothing**: Ensure the VS Code: window is not showing a modal or notification that would steal input.
- **Listener fails with permission error**: Add your user to the `input` group and re-login, or run with `sudo`.
