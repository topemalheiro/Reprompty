# Layout shortcuts on KDE Plasma

Bind two keys to Reprompty's layout slots, so one key press puts the focused VS Code window in place:

- Ctrl+Alt+V applies slot A.
- Ctrl+Alt+N applies slot B.

These are ordinary KDE shortcuts, so they work even when Reprompty is closed. Reprompty's own Ctrl+Alt+V/N shortcuts only work on Windows and X11, not in a Plasma Wayland session, which is why KDE needs this setup.

The slots' positions and sizes live in `~/.reprompty/layouts.json`; set them for your monitors there.

## What you need

- `python3` and `kdotool`. `npm run setup -- deps` (in the `reprompty` folder) lists anything that is missing and how to install it.
- VS Code's debugging port turned on (`npm run setup -- cdp`), so the shortcut can set the width of the AI side panel.

## Set them up

### From the app menu entry

`npm run setup` adds Reprompty to your app menu, and its menu entry has an action for each slot:

1. Open **System Settings → Keyboard → Shortcuts**.
2. Click **Add New → Application…**, choose **Reprompty** and click **OK**.
3. Select Reprompty's slot A action, click **Add custom shortcut** and press Ctrl+Alt+V.
4. Do the same for the slot B action with Ctrl+Alt+N, then click **Apply**.

### As commands (from source)

1. Open **System Settings → Keyboard → Shortcuts**.
2. Click **Add New → Command or Script…**, enter the command for slot A below and confirm.
3. Select the new entry, click **Add custom shortcut** and press Ctrl+Alt+V.
4. Do the same for slot B with Ctrl+Alt+N, then click **Apply**.

| Slot | Command |
| --- | --- |
| A | `<Reprompty folder>/reprompty/linux/layout-dual.sh` |
| B | `<Reprompty folder>/reprompty/linux/layout-single.sh` |

`<Reprompty folder>` is the folder you cloned Reprompty into. Use the full path; `realpath reprompty/linux/layout-dual.sh`, run in that folder, prints it.

## How it works

1. KDE's shortcut service (kglobalaccel) catches the key and runs the command from a small launcher file in `~/.local/share/applications/` (marked `X-KDE-GlobalAccel-CommandShortcut=true`), or the app menu entry's action.
2. The command runs Reprompty's layout script, `VSCodeSidePanelLayout/linux_layout.py`, once for that slot.
3. The script reads the slot's position and size from `~/.reprompty/layouts.json`.
4. It finds the focused VS Code window (or, if something else has focus, a VS Code window on the current desktop), moves and resizes it with `kdotool`, and sets the side panel's width through VS Code's debugging port.

| File | What it holds |
| --- | --- |
| `~/.local/share/applications/*.desktop` | The launcher that KDE runs for each shortcut |
| `~/.config/kglobalshortcutsrc` | Which key runs which launcher |
| `~/.reprompty/layouts.json` | The layout slots |
| `reprompty/linux/layout-dual.sh`, `layout-single.sh` | The commands for slots A and B |
| `VSCodeSidePanelLayout/linux_layout.py` | The layout script |

## Troubleshooting

- **The key does nothing, or runs an old command after you edited a launcher by hand.** KDE keeps the command it read when the shortcut was registered. Run `kbuildsycoca6`, then remove the shortcut and add it again, or log out and back in.
- **You want to check the command itself.** Run it in a terminal, for example `<Reprompty folder>/reprompty/linux/layout-dual.sh`, with a VS Code window open on the same desktop, and read what it prints.
- **Another app already uses the key.** Find it with `grep -E "Ctrl\+Alt\+(N|V)" ~/.config/kglobalshortcutsrc` and change one of the two shortcuts in System Settings.
- **The window lands in the wrong place.** Set the slot's `windowX`, `windowY`, `windowWidth` and `windowHeight` for your monitors in `~/.reprompty/layouts.json`.
- **"No VS Code window found".** Open a VS Code window on the current desktop first.
- **The side panel width doesn't change.** Turn on VS Code's debugging port with `npm run setup -- cdp`, then quit VS Code completely and reopen it. The secondary side bar must be open.
- **A window is resized when Reprompty starts.** You also added the layout script in the **Scripts** tab with **Auto** ticked, so it runs at start-up. Untick **Auto**.

More help: [Troubleshooting](../README.md#troubleshooting).
