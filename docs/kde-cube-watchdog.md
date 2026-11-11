# KWin Cube (Super+C) Watchdog for KDE Plasma 6 Wayland

## What this is

A Reprompty-managed guard script that works around a known KDE Plasma 6 / KWin Wayland bug where the **Desktop Cube effect** (`Super+C`) stops responding to mouse drag on multi-screen, multi-desktop setups.

The shortcut still fires, the effect is still loaded, and D-Bus reports success — but the cube no longer rotates with the mouse. A KWin restart (or reboot) temporarily fixes it.

## Known upstream issue

- The cube effect was re-implemented in QtQuick3D in `kdeplasma-addons` (see [kdeplasma-addons !188](https://invent.kde.org/plasma/kdeplasma-addons/-/merge_requests/188)).
- Multiple users report the cube stops working after sleep/resume or after the session has been running, and only a reboot/KWin restart restores it.
- KDE Discuss thread: [Plasma Addons: Cube — middle-mouse rotate discussion](https://discuss.kde.org/t/plasma-addons-cube-clicking-on-desktop-with-the-middle-mouse-button-should-allow-to-rotate-the-cube/42215)

## How the guard helps

The script `scripts/kwin-shortcut-guard.sh` is registered in Reprompty and exposes these MCP actions:

| Action | What it does |
|--------|--------------|
| `kwin_shortcut_status` | Show current shortcut/effect state |
| `kwin_shortcut_check` | Heuristic health check for the cube |
| `kwin_shortcut_refresh` | Re-register shortcuts and restart `plasma-kglobalaccel` |
| `kwin_shortcut_repair` | Full repair: refresh + `kwin_wayland --replace` |
| `kwin_shortcut_auto_repair_start` | Start background auto-repair monitor |
| `kwin_shortcut_watchdog_start` | Start 5-minute lightweight refresh watchdog |
| `kwin_shortcut_watchdog_stop` | Stop any background guard process |

By default the script auto-starts in **auto-repair** mode. It polls every 60 seconds and:

- Runs a **lightweight refresh** when it detects an output or virtual-desktop change.
- Runs a **full repair** when it detects recent KWin errors or a system resume event.

This does not fix the root cause inside KDE, but it automatically restores Super+C mouse drag when the trigger conditions occur.

## Logs and diagnostics

- Guard log: `~/.local/share/kwin-shortcut-guard/guard.log`
- Diagnostic snapshots: `~/.local/share/kwin-shortcut-guard/diagnostics/kwin-diagnosis-*.txt`

These files are also collected before every full repair and are useful for upstream KDE bug reports.

## Manual repair

If Super+C is broken right now and the auto-repair has not triggered yet, run the **Repair KWin Shortcuts** action in Reprompty. It will restart KWin and should restore the cube.

## Root cause

The cube effect is implemented in QML under `/usr/share/kwin/effects/cube/`. The most likely causes are:

1. The effect delegate is created once and may hold stale `SceneView.screen` / `VirtualDesktopModel` state after output/desktop changes.
2. The `DragHandler` in `CubeCameraController.qml` may stop receiving pointer events on multi-output Wayland after a screen hot-plug or sleep/resume.
3. The `activated` / `deactivateTimer` state machine may get stuck in an edge case.

A proper fix requires changes in `kdeplasma-addons`. The Reprompty guard is a workaround until that happens.
