# KDE Bugzilla report template — Cube mouse drag breaks on Wayland multi-screen

**Product:** kdeplasma-addons  
**Component:** kwin effects  
**Summary:** Desktop Cube effect (Super+C) stops responding to mouse drag on Plasma 6 Wayland multi-screen setups

---

## Summary

On KDE Plasma 6 Wayland with multiple monitors and virtual desktops, the Desktop Cube effect (Meta+C / Super+C) stops responding to mouse-drag rotation after the session has been running. The shortcut still activates the effect, the effect remains loaded, and D-Bus invocation returns success, but the cube no longer rotates when dragging the mouse. Only a KWin restart (`kwin_wayland --replace`) or a full reboot restores it.

The issue appears to be triggered or worsened by:
- Sleep / resume cycles
- Display hot-plug / output configuration changes
- Switching virtual desktops while the cube is active

## Steps to Reproduce

1. Start a Plasma 6 Wayland session on a machine with multiple monitors.
2. Enable at least 3 virtual desktops.
3. Enable the Desktop Cube effect (requires `kdeplasma-addons`).
4. Bind the Cube shortcut to `Meta+C`.
5. Use the session normally for several hours, including sleep/resume and/or monitor hot-plug events.
6. Press `Meta+C` and try to rotate the cube by dragging the mouse.

## Observed Result

The cube appears, but mouse drag does not rotate it. Arrow keys may still work.

## Expected Result

Mouse drag should rotate the cube and allow selecting a desktop.

## System Information

- **Operating System:** Arch Linux
- **KDE Plasma Version:** 6.6.5
- **KDE Frameworks Version:** (fill in)
- **Qt Version:** 6.11.1
- **Graphics Platform:** Wayland
- **Monitors:** 3 (multi-screen)
- **Virtual Desktops:** 15

## Additional Information

The cube effect lives in `/usr/share/kwin/effects/cube/` and is implemented in QtQuick3D/QML.

Key files:
- `main.qml` — `SceneEffect` with a single `mainDelegate` created once.
- `CubeCameraController.qml` — contains the `DragHandler` used for mouse rotation.
- `ScreenView.qml` — uses `KWinComponents.SceneView.screen` as `targetScreen`.

### Hypothesis

1. The effect delegate is created once (`property var mainDelegate: Qt.createComponent(...)`). If desktop or screen state changes after the effect is first loaded, the delegate may hold stale `SceneView.screen` or `VirtualDesktopModel` state.
2. On multi-output Wayland, after an output hot-plug or sleep/resume, the `DragHandler` in `CubeCameraController` may stop receiving pointer events because the scene surface it is rendered into no longer matches the surface receiving input.
3. The `activated` / `deactivateTimer` state machine may get stuck in an edge case, leaving the cube visible but unresponsive.

### Related references

- kdeplasma-addons !188 — original cube re-implementation MR: https://invent.kde.org/plasma/kdeplasma-addons/-/merge_requests/188
- KDE Discuss thread where multiple users report the cube stops working until reboot: https://discuss.kde.org/t/plasma-addons-cube-clicking-on-desktop-with-the-middle-mouse-button-should-allow-to-rotate-the-cube/42215

### Attachments

- `kwin-diagnosis-*.txt` — contains `org.kde.KWin.supportInformation()`, loaded effects, shortcut registrations, and recent KWin journal entries.
- `~/.local/share/kwin-shortcut-guard/guard.log` — log of detected state changes and repairs.

Please let me know if additional diagnostics (e.g., `WAYLAND_DEBUG`, QML inspector output, or a screen recording) would help.
