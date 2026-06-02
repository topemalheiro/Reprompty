# Linux Global Shortcuts Setup

## When to use this skill

When the user needs to set up, fix, or understand KDE global shortcuts for Reprompty layout scripts on Linux (KDE Plasma / Wayland).

## How the shortcut chain works

1. **KDE intercepts the keypress** (`Ctrl+Alt+V` / `Ctrl+Alt+N`) via `kglobalaccel`
2. **KDE looks up the `.desktop` file** registered for that shortcut:
   - `~/.local/share/applications/reprompty-layout-dual.desktop`
   - `~/.local/share/applications/reprompty-layout-single.desktop`
3. **KDE executes the `Exec=` line** from the `.desktop` file
4. **The wrapper script runs** (`reprompty/linux/layout-dual.sh` or `layout-single.sh`)
5. **The wrapper calls `linux_layout.py --once --slot A` (or `B`)**
6. **The script reads coordinates from `~/.reprompty/layouts.json`**
7. **The script resizes the VS Code: side panel and moves the window** via Chrome DevTools Protocol (CDP)

## Key files

| File | Purpose |
|---|---|
| `~/.reprompty/layouts.json` | Slot coordinates (`windowX`, `windowY`, `windowWidth`, `windowHeight`, `panelWidth`) and `scriptArgs` |
| `~/.reprompty/scripts.json` | Script metadata. **Must have `"autoStart": false`** so Reprompty does not resize VS Code: on launch |
| `reprompty/linux/layout-dual.sh` | Wrapper that calls `linux_layout.py --once --slot A` |
| `reprompty/linux/layout-single.sh` | Wrapper that calls `linux_layout.py --once --slot B` |
| `~/.config/kglobalshortcutsrc` | KDE shortcut registry: maps keys to `.desktop` files |
| `~/.config/khotkeysrc` | Legacy KDE shortcut fallback with direct commands |
| `~/.local/share/applications/reprompty-layout-*.desktop` | `.desktop` files that KDE executes when shortcuts are pressed |

## Common issues and fixes

### Shortcuts do nothing

KDE's `kglobalaccel` daemon caches `.desktop` file `Exec=` lines in memory. After editing `.desktop` files, **a Plasma session restart (log out / back in) is required**.

### Shortcut runs old command (ignores `.desktop` file updates)

Same cause: KDE cache. Verify with:

```bash
# Check what the .desktop file actually contains
grep "^Exec=" ~/.local/share/applications/reprompty-layout-dual.desktop

# Check systemd transient services (shows what KDE actually executed)
ls -lt /run/user/1000/systemd/transient/app-reprompty*
```

If the transient service shows an old command, restart the session.

### "No VS Code: window found"

The `linux_layout.py` script searches for a VS Code: window to apply the layout to. Make sure VS Code: is open before pressing the shortcut.

### Reprompty resizes VS Code: on launch

Check `~/.reprompty/scripts.json`:

```json
"autoStart": false
```

If it is `true`, the layout script starts when Reprompty opens and immediately resizes the active VS Code: window.

### Layout goes to wrong position

The script uses the exact coordinates from `~/.reprompty/layouts.json` when called with `--slot A` or `--slot B`. Verify the slot values:

```bash
cat ~/.reprompty/layouts.json | jq '.slots[] | {letter, windowX, windowY, windowWidth, windowHeight, panelWidth}'
```

### Shortcut conflicts with other apps (e.g., Spectacle)

Check `~/.config/kglobalshortcutsrc` for duplicate shortcut assignments:

```bash
grep "Ctrl+Alt+N\|Ctrl+Alt+V" ~/.config/kglobalshortcutsrc
```

If another app (like Spectacle) claims the same key, remove or reassign it.

## How to add or change shortcuts

1. Edit the `.desktop` files in `~/.local/share/applications/`
2. Update `~/.config/kglobalshortcutsrc` if needed
3. Update `~/.config/khotkeysrc` as fallback
4. **Log out and back in** for KDE to pick up the changes
5. Test the shortcut with a VS Code: window open
