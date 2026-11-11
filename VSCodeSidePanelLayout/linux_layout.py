#!/usr/bin/env python3
"""
Linux layout script for VS Code window positioning and side panel resizing.
Uses Chrome DevTools Protocol (CDP) for cursor-free sash drag, with fallback
to state.vscdb modification. Supports KDE multi-monitor via kscreen-doctor.

# reprompty-mcp: {"toolName":"dual_monitor_layout_bottom","label":"Dual monitor layout (bottom)","description":"Run the Ctrl+Alt+V dual monitor bottom layout","args":["--once","--dual"]}
# reprompty-mcp: {"toolName":"top_monitors_layout_panel_full","label":"Top monitors layout (panel full)","description":"Run the Ctrl+Alt+N top monitors panel-full layout","args":["--once","--single"]}

Usage:
    python3 linux_layout.py --once --dual
    python3 linux_layout.py --once --single
    python3 linux_layout.py --once --dual --window-title "MyProject"
    python3 linux_layout.py --once --single --window-handle 12345678
    python3 linux_layout.py --once --dual --panel-left
    python3 linux_layout.py --once --dual --panel-right
"""

import argparse
import base64
import hashlib
import json
import os
import random
import re
import shutil
import sqlite3
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request
from typing import Optional, Dict, Any, Tuple

# =============================================================================
# Session environment restoration
# =============================================================================

def ensure_linux_session_env():
    """Restore XDG_/WAYLAND_/DBUS_ env vars stripped by some launchers."""
    uid = os.getuid()
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime_dir:
        runtime_dir = f"/run/user/{uid}"
        if os.path.isdir(runtime_dir):
            os.environ["XDG_RUNTIME_DIR"] = runtime_dir

    if not os.environ.get("DBUS_SESSION_BUS_ADDRESS") and runtime_dir:
        bus_path = os.path.join(runtime_dir, "bus")
        if os.path.exists(bus_path):
            os.environ["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={bus_path}"

    if not os.environ.get("XDG_SESSION_TYPE"):
        wayland_socket = os.path.join(runtime_dir or f"/run/user/{uid}", "wayland-0")
        if os.path.exists(wayland_socket):
            os.environ["XDG_SESSION_TYPE"] = "wayland"
            if not os.environ.get("WAYLAND_DISPLAY"):
                os.environ["WAYLAND_DISPLAY"] = "wayland-0"
        else:
            os.environ["XDG_SESSION_TYPE"] = "x11"
            if not os.environ.get("DISPLAY"):
                os.environ["DISPLAY"] = ":0"


# Global lock so the daemon processes one layout request at a time.
_layout_lock = threading.Lock()

# =============================================================================
# Minimal stdlib WebSocket client for CDP
# =============================================================================

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class MinimalWebSocket:
    """A minimal WebSocket client using only Python stdlib."""

    def __init__(self, url: str, timeout: float = 10.0):
        self.url = url
        self.timeout = timeout
        self.sock: Optional[socket.socket] = None
        self._connect()

    def _connect(self):
        m = re.match(r"ws://([^/:]+)(?::(\d+))?(.*)", self.url)
        if not m:
            raise ValueError(f"Unsupported WebSocket URL: {self.url}")
        host = m.group(1)
        port = int(m.group(2)) if m.group(2) else 80
        path = m.group(3) or "/"

        self.sock = socket.create_connection((host, port), timeout=self.timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        handshake = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"\r\n"
        )
        self.sock.sendall(handshake.encode("ascii"))

        # Read HTTP response
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("WebSocket handshake failed")
            response += chunk

        header, _ = response.split(b"\r\n\r\n", 1)
        if b"101" not in header.split(b"\r\n", 1)[0]:
            raise ConnectionError(f"WebSocket handshake failed: {header.decode()}")

        # Validate accept key
        expected = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        if expected.encode() not in header:
            raise ConnectionError("WebSocket accept key mismatch")

    def send_text(self, text: str):
        data = text.encode("utf-8")
        mask = struct.pack("<I", random.getrandbits(32))
        length = len(data)

        # First byte: FIN=1, opcode=1 (text)
        # Second byte: MASK=1, length
        if length < 126:
            header = struct.pack("!BB", 0x81, 0x80 | length)
        elif length < 65536:
            header = struct.pack("!BBH", 0x81, 0x80 | 126, length)
        else:
            header = struct.pack("!BBQ", 0x81, 0x80 | 127, length)

        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(header + mask + masked)

    def recv_text(self) -> str:
        # Read frame header
        header = self._recv_exact(2)
        b1, b2 = header[0], header[1]
        fin = (b1 >> 7) & 1
        opcode = b1 & 0x0F
        masked = (b2 >> 7) & 1
        length = b2 & 0x7F

        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8))[0]

        if masked:
            mask = self._recv_exact(4)
            payload = self._recv_exact(length)
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        else:
            payload = self._recv_exact(length)

        if opcode == 0x08:  # close
            raise ConnectionError("WebSocket closed by server")
        if opcode == 0x09:  # ping
            # Send pong
            self.sock.sendall(struct.pack("!BB", 0x8A, 0) + payload)
            return self.recv_text()

        if opcode == 0x01:  # text
            return payload.decode("utf-8")
        if opcode == 0x02:  # binary
            return payload.decode("utf-8")

        # For other opcodes (continuation), try to receive more
        if not fin:
            return self.recv_text()
        return ""

    def _recv_exact(self, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("WebSocket connection closed unexpectedly")
            buf += chunk
        return buf

    def close(self):
        if self.sock:
            try:
                self.sock.sendall(struct.pack("!BB", 0x88, 0))
            except Exception:
                pass
            self.sock.close()
            self.sock = None


# =============================================================================
# Logging
# =============================================================================

def log(msg: str, log_file: Optional[str] = None):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line)
    if log_file:
        with open(log_file, "a") as f:
            f.write(line + "\n")


# =============================================================================
# Monitor geometry detection
# =============================================================================

def get_monitor_geometry(log_file: Optional[str] = None) -> list:
    """Detect monitor layout using kscreen-doctor --json (KDE)."""
    try:
        result = subprocess.run(
            ["kscreen-doctor", "--json"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr)

        data = json.loads(result.stdout)
        outputs = data.get("outputs", [])
        monitors = []
        for out in outputs:
            if not out.get("enabled") or not out.get("connected"):
                continue
            pos = out.get("pos", {})
            size = out.get("size", {})
            # kscreen-doctor reports `pos` in LOGICAL coordinates but `size` in
            # PHYSICAL (mode) pixels. Mixing the two silently breaks every
            # geometry calculation the moment any output is not at 100% scale:
            # a 1920px-wide panel at 1.2 scale occupies only 1600 logical px, so
            # the next monitor's `pos.x` is 1600 further along, not 1920.
            # Normalise to logical here so the rest of the module has one unit.
            try:
                scale = float(out.get("scale") or 1.0)
            except (TypeError, ValueError):
                scale = 1.0
            if scale <= 0:
                scale = 1.0
            monitors.append({
                "name": out.get("name", "unknown"),
                "x": pos.get("x", 0),
                "y": pos.get("y", 0),
                "width": round(size.get("width", 1920) / scale),
                "height": round(size.get("height", 1080) / scale),
                "scale": scale,
            })

        # Sort left-to-right by x position
        monitors.sort(key=lambda m: m["x"])
        log(f"Detected {len(monitors)} monitor(s): {monitors}", log_file)
        return monitors
    except Exception as e:
        log(f"Monitor detection failed: {e}, using fallback", log_file)
        return [{"name": "fallback", "x": 0, "y": 0, "width": 1920, "height": 1080}]


def compute_layout(monitors: list, layout_mode: str, panel_side: str) -> dict:
    """Compute target window geometry based on monitors and layout mode."""
    if not monitors:
        monitors = [{"x": 0, "y": 0, "width": 1920, "height": 1080}]

    # Sort monitors by area descending for single layout preference
    monitors_by_area = sorted(monitors, key=lambda m: m["width"] * m["height"], reverse=True)

    if layout_mode == "dual" and len(monitors) >= 2:
        # Find the best pair of adjacent monitors
        # Prefer same-size monitors, then largest total area
        best_pair = None
        best_score = -1
        for i in range(len(monitors)):
            for j in range(i + 1, len(monitors)):
                left = monitors[i]
                right = monitors[j]
                # Check if they're adjacent horizontally (left edge of right == right edge of left)
                if abs((left["x"] + left["width"]) - right["x"]) < 10 or abs((right["x"] + right["width"]) - left["x"]) < 10:
                    same_size = (left["width"] == right["width"] and left["height"] == right["height"])
                    y_aligned = abs(left["y"] - right["y"]) < 100
                    total_area = left["width"] * left["height"] + right["width"] * right["height"]
                    score = (1000000 if same_size else 0) + (500000 if y_aligned else 0) + total_area
                    if score > best_score:
                        best_score = score
                        # Ensure left is the leftmost monitor
                        if left["x"] <= right["x"]:
                            best_pair = (left, right)
                        else:
                            best_pair = (right, left)
        # Fallback to first adjacent pair or first two
        if best_pair is None:
            for i in range(len(monitors) - 1):
                left = monitors[i]
                right = monitors[i + 1]
                if abs((left["x"] + left["width"]) - right["x"]) < 10:
                    best_pair = (left, right)
                    break
        if best_pair is None:
            best_pair = (monitors[0], monitors[1])
        left, right = best_pair
        target_x = left["x"]
        target_y = min(left["y"], right["y"])
        target_w = (right["x"] + right["width"]) - left["x"]
        target_h = max(left["y"] + left["height"], right["y"] + right["height"]) - target_y
        panel_w = left["width"]
    elif layout_mode == "single" and len(monitors) >= 1:
        # Use largest monitor
        m = monitors_by_area[0]
        target_x = m["x"]
        target_y = m["y"]
        target_w = m["width"]
        target_h = m["height"]
        panel_w = m["width"] // 2
    else:
        # Default single monitor
        m = monitors_by_area[0]
        target_x = m["x"]
        target_y = m["y"]
        target_w = m["width"]
        target_h = m["height"]
        panel_w = m["width"] // 2

    return {
        "x": target_x,
        "y": target_y,
        "width": target_w,
        "height": target_h,
        "panel_width": panel_w,
        "panel_side": panel_side,
    }


# =============================================================================
# Tool detection
# =============================================================================

KDOTOOL_PATH = (
    os.environ.get("REPROMPTY_KDOTOOL")
    or shutil.which("kdotool")
    or os.path.expanduser("~/.local/bin/kdotool")
)


def _has_kdotool() -> bool:
    return os.path.isfile(KDOTOOL_PATH) and os.access(KDOTOOL_PATH, os.X_OK)


def _has_xdotool() -> bool:
    try:
        env = os.environ.copy()
        result = subprocess.run(["xdotool", "version"], capture_output=True, timeout=2, env=env)
        return result.returncode == 0
    except Exception:
        return False


# =============================================================================
# Window finding
# =============================================================================

def get_active_window(log_file: Optional[str] = None) -> Optional[Tuple[str, str]]:
    """Get the currently active/focused window ID and title."""
    # Try kdotool first (KDE Wayland native)
    if _has_kdotool():
        wid = _kdotool_query(["getactivewindow"], log_file)
        if wid and wid.startswith("{"):
            title = get_window_title(wid)
            if title:
                return (wid, title)
            log(f"Active window {wid} reported no title", log_file)

    # Fallback to xdotool (X11/XWayland)
    if _has_xdotool():
        env = os.environ.copy()
        try:
            result = subprocess.run(
                ["xdotool", "getactivewindow"],
                capture_output=True, text=True, timeout=5, env=env
            )
            if result.returncode == 0:
                wid = result.stdout.strip()
                if wid:
                    title_result = subprocess.run(
                        ["xdotool", "getwindowname", wid],
                        capture_output=True, text=True, timeout=2, env=env
                    )
                    if title_result.returncode == 0:
                        title = title_result.stdout.strip()
                        # Require a non-empty title, exactly as the kdotool branch
                        # above already does. On Wayland this xdotool answers with a
                        # bogus XWayland id (2097152) whose name is empty; accepting
                        # it shadowed the real active window and sent
                        # find_vscode_window() down its desktop-blind search path,
                        # which is what made layouts land on the wrong virtual
                        # desktop and drag the session along with them.
                        if title:
                            return (wid, title)
                        log(
                            f"xdotool getactivewindow returned {wid} with an empty "
                            "title; ignoring it",
                            log_file,
                        )
        except Exception as e:
            log(f"xdotool getactivewindow error: {e}", log_file)

    return None


def get_current_desktop(log_file: Optional[str] = None) -> Optional[int]:
    """Number of the virtual desktop the user is currently on, or None."""
    out = _kdotool_query(["get_desktop"], log_file)
    try:
        return int(out) if out is not None else None
    except ValueError:
        return None


def get_desktop_for_window(wid: str, log_file: Optional[str] = None) -> Optional[int]:
    """Number of the virtual desktop a window lives on, or None."""
    if not wid.startswith("{"):
        return None
    out = _kdotool_query(["get_desktop_for_window", wid], log_file)
    try:
        return int(out) if out is not None else None
    except ValueError:
        return None


def find_vscode_window(title: Optional[str] = None, handle: Optional[str] = None, log_file: Optional[str] = None) -> Optional[str]:
    """Find VS Code window id using kdotool (Wayland) or xdotool (X11).
    When no specific title or handle is given, prefers the currently active window."""
    if handle is not None:
        return handle

    search_terms = [title] if title else ["Visual Studio Code", "Kilo Code", "Kimi Code", "VSCodium", "Code - OSS"]

    # If no specific title/handle requested, try active window first
    if not title and not handle:
        active = get_active_window(log_file)
        if not active:
            log("Could not determine the active window, falling back to search", log_file)
        if active:
            wid, active_title = active
            if any(term in active_title for term in search_terms):
                log(f"Using active window: {wid} ('{active_title}')", log_file)
                return wid
            else:
                log(f"Active window '{active_title}' is not a VS Code editor, falling back to search", log_file)

    # Try kdotool first (KDE Wayland native)
    if _has_kdotool():
        # Scope the search to the desktop the user is actually looking at. Doing
        # this in the query rather than filtering afterwards is what makes the
        # result correct on EVERY exit below: the single-match shortcut and the
        # first-match fallback can then only ever yield a current-desktop window.
        # Filtering later left both of those paths free to return a window from
        # another desktop, and windowactivate would then drag the session there.
        current_desktop = get_current_desktop()
        scope = ["--desktop", str(current_desktop)] if current_desktop is not None else []

        all_matches = []
        for search_term in search_terms:
            try:
                result = subprocess.run(
                    [KDOTOOL_PATH, "search"] + scope + ["--title", search_term],
                    capture_output=True, text=True, timeout=5
                )
                if result.returncode == 0:
                    for line in result.stdout.strip().split("\n"):
                        wid = line.strip()
                        if wid and wid.startswith("{") and wid not in [m[0] for m in all_matches]:
                            wtitle = get_window_title(wid)
                            if wtitle and any(term in wtitle for term in search_terms):
                                all_matches.append((wid, wtitle))
            except Exception as e:
                log(f"kdotool search error: {e}")

        if all_matches:
            # The search was already scoped to the current desktop, so every match
            # is a valid target and no post-filtering is needed. (This replaces a
            # filter that ran get_desktop_for_window per candidate and was bypassed
            # entirely whenever exactly one window matched.)
            log(
                f"Using VS Code window on desktop {current_desktop}: "
                f"{all_matches[0][0]} ('{all_matches[0][1]}')",
                log_file,
            )
            return all_matches[0][0]

        if scope:
            # kdotool worked and simply found nothing here. Do NOT fall through to
            # the xdotool branch below: it searches every desktop and returns an
            # integer X11 id, which move_window's `wid.startswith("{")` test then
            # routes down the xdotool path, silently no-opping on a Wayland window.
            # Better to do nothing and say so than to act on the wrong desktop.
            log(
                f"No VS Code window on desktop {current_desktop}; doing nothing",
                log_file,
            )
            return None

    # Fallback to xdotool (X11/XWayland)
    if _has_xdotool():
        env = os.environ.copy()
        for search_term in search_terms:
            try:
                result = subprocess.run(
                    ["xdotool", "search", "--name", search_term],
                    capture_output=True, text=True, timeout=5, env=env
                )
                if result.returncode == 0:
                    lines = [l.strip() for l in result.stdout.strip().split("\n") if l.strip()]
                    for line in lines:
                        try:
                            wid = int(line)
                            name_result = subprocess.run(
                                ["xdotool", "getwindowname", str(wid)],
                                capture_output=True, text=True, timeout=2, env=env
                            )
                            if name_result.returncode == 0:
                                name = name_result.stdout.strip()
                                if any(k in name for k in ["Visual Studio Code", "Kilo Code", "Kimi Code", "VSCodium", "Code - OSS"]):
                                    return str(wid)
                        except Exception:
                            continue
            except Exception as e:
                log(f"xdotool search error: {e}")

    return None


# =============================================================================
# Window manipulation
# =============================================================================

def _kdotool_query(args: list, log_file: Optional[str] = None,
                   attempts: int = 4, delay: float = 0.06) -> Optional[str]:
    """Run a read-only kdotool query, retrying while it answers with nothing.

    kdotool drives KWin by loading a throwaway KWin script per invocation and
    reading its reply back over D-Bus. That handshake races: measured on this
    machine, `kdotool get_desktop` returns an EMPTY string roughly 40% of the
    time, with exit status 0. Every symptom traced back to this -- an empty
    get_desktop dropped the --desktop scope and let the search pick a window on
    another virtual desktop, and an empty getwindowname made get_active_window
    fall through to xdotool's bogus XWayland id. Retrying turns a coin-flip into
    a reliable answer; four attempts makes an all-empty run about 0.4^4 ~= 2.5%,
    and each retry costs ~60ms only on the failing path.

    Returns the stripped stdout, or None if every attempt came back empty.
    """
    if not _has_kdotool():
        return None
    for attempt in range(attempts):
        try:
            result = subprocess.run(
                [KDOTOOL_PATH] + args,
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0:
                out = result.stdout.strip()
                if out:
                    return out
        except Exception as e:
            log(f"kdotool {' '.join(args)} error: {e}", log_file)
            return None
        if attempt < attempts - 1:
            time.sleep(delay)
    log(f"kdotool {' '.join(args)} returned empty {attempts}x", log_file)
    return None


def get_window_title(wid: str) -> Optional[str]:
    """Get the title of a window using kdotool or xdotool."""
    is_kdotool = wid.startswith("{")
    if is_kdotool and _has_kdotool():
        title = _kdotool_query(["getwindowname", wid])
        if title:
            return title
        # Deliberately do NOT fall through to xdotool for a kdotool window id:
        # xdotool cannot address Wayland windows and answers about an unrelated
        # XWayland one.
        return None
    # Fallback to xdotool
    env = os.environ.copy()
    try:
        result = subprocess.run(
            ["xdotool", "getwindowname", str(wid)],
            capture_output=True, text=True, timeout=5, env=env
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return None


def move_window(wid: str, x: int, y: int, width: int, height: int, log_file: Optional[str] = None) -> bool:
    """Move and resize a window using kdotool (Wayland) or xdotool (X11)."""
    is_kdotool = wid.startswith("{")

    if is_kdotool and _has_kdotool():
        try:
            # Unmaximize/unfullscreen first, otherwise KWin ignores geometry changes.
            subprocess.run(
                [
                    KDOTOOL_PATH,
                    "windowstate", "--remove", "MAXIMIZED", "--remove", "FULLSCREEN", wid,
                ],
                capture_output=True, timeout=5,
            )
            time.sleep(0.05)
            # KDE 6: windowsize requires the window to be active first, but
            # windowmove must happen BEFORE activation to avoid desktop-switch drift.
            # Chain move + activate + resize in a single kdotool invocation
            # so KWin applies them atomically — no visible "middle point"
            # kdotool's windowactivate SWITCHES virtual desktop when the target
            # lives on another one -- "If the window is on another desktop, we
            # will switch to that desktop" (kdotool --help). A layout request must
            # never move the user, so drop the activate in that case. Reordering
            # move-before-activate (below) only ever fixed geometry drift; it does
            # not stop the switch.
            window_desktop = get_desktop_for_window(wid, log_file)
            current_desktop = get_current_desktop(log_file)
            cross_desktop = (
                window_desktop is not None
                and current_desktop is not None
                and window_desktop != current_desktop
            )

            cmd = [KDOTOOL_PATH, "windowmove", wid, str(x), str(y)]
            if cross_desktop:
                log(
                    f"Window {wid} is on desktop {window_desktop} but the current "
                    f"desktop is {current_desktop}; skipping activate so the "
                    "session stays put",
                    log_file,
                )
            else:
                cmd += ["windowactivate", wid]
            cmd += ["windowsize", wid, str(width), str(height)]

            subprocess.run(cmd, capture_output=True, timeout=5)
            log(f"Moved window {wid} to {x},{y} size {width}x{height}", log_file)
            return True
        except Exception as e:
            log(f"ERROR moving window with kdotool: {e}", log_file)
            return False

    # Fallback to xdotool (X11/XWayland)
    env = os.environ.copy()
    try:
        subprocess.run(["xdotool", "windowmove", str(wid), str(x), str(y)], capture_output=True, timeout=5, env=env)
        subprocess.run(["xdotool", "windowsize", str(wid), str(width), str(height)], capture_output=True, timeout=5, env=env)
        log(f"Moved window {wid} to {x},{y} size {width}x{height}", log_file)
        return True
    except Exception as e:
        log(f"ERROR moving window with xdotool: {e}", log_file)
        return False


def trigger_layout_refresh(wid: str, log_file: Optional[str] = None) -> bool:
    """Trigger VS Code to recalculate layout by briefly resizing the window."""
    is_kdotool = wid.startswith("{")

    try:
        if is_kdotool and _has_kdotool():
            result = subprocess.run(
                [KDOTOOL_PATH, "getwindowgeometry", wid],
                capture_output=True, text=True, timeout=5
            )
            # Parse: "Window {uuid}\n  Position: x,y\n  Geometry: wxh"
            w, h = 1920, 1080
            for line in result.stdout.strip().split("\n"):
                if "Geometry:" in line:
                    parts = line.split("Geometry:")[1].strip().split("x")
                    if len(parts) == 2:
                        w, h = int(parts[0]), int(parts[1])
                    break
            # Resize by 1 pixel and back using direct UUID
            subprocess.run(
                [KDOTOOL_PATH, "windowsize", wid, str(w + 1), str(h)],
                capture_output=True, timeout=2
            )
            time.sleep(0.05)
            subprocess.run(
                [KDOTOOL_PATH, "windowsize", wid, str(w), str(h)],
                capture_output=True, timeout=2
            )
        else:
            env = os.environ.copy()
            result = subprocess.run(
                ["xdotool", "getwindowgeometry", str(wid)],
                capture_output=True, text=True, timeout=5, env=env
            )
            if result.returncode != 0:
                return False
            for line in result.stdout.strip().split("\n"):
                if "Geometry:" in line:
                    size = line.split("Geometry: ")[1]
                    w, h = map(int, size.split("x"))
                    break
            subprocess.run(["xdotool", "windowsize", str(wid), str(w + 1), str(h)], capture_output=True, timeout=2, env=env)
            time.sleep(0.05)
            subprocess.run(["xdotool", "windowsize", str(wid), str(w), str(h)], capture_output=True, timeout=2, env=env)

        log("Triggered layout refresh", log_file)
        return True
    except Exception as e:
        log(f"ERROR triggering layout refresh: {e}", log_file)
        return False


# =============================================================================
# state.vscdb fallback
# =============================================================================

def get_state_db_path() -> str:
    home = os.environ.get("HOME", ".")
    candidates = [
        os.path.join(home, ".config", "Code", "User", "globalStorage", "state.vscdb"),
        os.path.join(home, ".config", "VSCodium", "User", "globalStorage", "state.vscdb"),
        os.path.join(home, ".config", "Code - OSS", "User", "globalStorage", "state.vscdb"),
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    raise FileNotFoundError("VS Code state database not found")


def set_auxiliary_bar_width(width: int, log_file: Optional[str] = None) -> bool:
    try:
        db_path = get_state_db_path()
        conn = sqlite3.connect(db_path)
        try:
            cur = conn.cursor()
            cur.execute(
                "UPDATE ItemTable SET value = ? WHERE key = 'workbench.auxiliaryBar.size'",
                (str(width),),
            )
            size_updated = cur.rowcount
            cur.execute(
                "UPDATE ItemTable SET value = ? WHERE key = 'workbench.auxiliaryBar.lastNonMaximizedSize'",
                (str(width),),
            )
            conn.commit()

            if size_updated == 0:
                log(f"WARNING: key 'workbench.auxiliaryBar.size' not found", log_file)
                return False

            log(f"Set auxiliaryBar.size = {width}", log_file)
            return True
        finally:
            conn.close()
    except Exception as e:
        log(f"ERROR setting auxiliary bar width: {e}", log_file)
        return False


# =============================================================================
# CDP (Chrome DevTools Protocol)
# =============================================================================

# Global persistent CDP WebSocket cache for daemon mode
_cdp_websockets: Dict[str, MinimalWebSocket] = {}

# What the last successful apply established, so the zoom watcher can restore it.
# Guarded by _layout_lock. Keys: title, panel_side, fraction, dpr.
_last_sash_state: Optional[dict] = None

def _get_cached_ws(ws_url: str) -> Optional[MinimalWebSocket]:
    ws = _cdp_websockets.get(ws_url)
    if ws and ws.sock:
        return ws
    return None

def _cache_ws(ws_url: str, ws: MinimalWebSocket) -> None:
    _cdp_websockets[ws_url] = ws

def _strip_jsonc(text: str) -> str:
    """argv.json is JSONC: drop // and /* */ comments and trailing commas, keeping strings."""
    text = re.sub(r'("(?:\\.|[^"\\])*")|//[^\n]*|/\*.*?\*/', lambda m: m.group(1) or "", text, flags=re.S)
    return re.sub(r'("(?:\\.|[^"\\])*")|,(\s*[}\]])', lambda m: m.group(1) or m.group(2), text)

def get_cdp_port() -> int:
    """Get CDP port from DevToolsActivePort or argv.json."""
    home = os.environ.get("HOME", ".")

    # Try DevToolsActivePort files first
    candidates = [
        os.path.join(home, ".config", "Code", "DevToolsActivePort"),
        os.path.join(home, ".config", "VSCodium", "DevToolsActivePort"),
        os.path.join(home, ".config", "Code - OSS", "DevToolsActivePort"),
    ]
    for port_file in candidates:
        if os.path.exists(port_file):
            try:
                with open(port_file, "r") as f:
                    port = int(f.readline().strip())
                    if port > 0:
                        return port
            except Exception:
                pass

    # Fallback to argv.json
    argv_candidates = [
        os.path.join(home, ".vscode", "argv.json"),
        os.path.join(home, ".vscode-oss", "argv.json"),
        os.path.join(home, ".vscode-insiders", "argv.json"),
        os.path.join(home, ".config", "VSCodium", "argv.json"),
        os.path.join(home, ".config", "Code - OSS", "argv.json"),
    ]
    for argv_file in argv_candidates:
        if os.path.exists(argv_file):
            try:
                with open(argv_file, "r", encoding="utf-8") as f:
                    data = json.loads(_strip_jsonc(f.read()))
                port = data.get("remote-debugging-port")
                if port:
                    return int(str(port))
            except Exception:
                pass

    return 9222


def get_cdp_targets(port: int, log_file: Optional[str] = None) -> list:
    """Fetch CDP target list from http://localhost:<port>/json."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/json")
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            targets = [t for t in data if t.get("type") == "page"]
            log(f"CDP: {len(targets)} page target(s) on port {port}", log_file)
            return targets
    except Exception as e:
        log(f"CDP: Failed to fetch targets on port {port}: {e}", log_file)
        if isinstance(getattr(e, "reason", e), ConnectionRefusedError):
            warn_no_cdp(port)
        return []


def warn_no_cdp(port: int):
    """Notify (at most every 30 min) when VS Code runs without its debug port.

    Happens when VS Code relaunches itself while the old instance still holds
    the port: the new one starts without CDP, so sash and zoom silently fail.
    """
    if subprocess.run(["pgrep", "-x", "code"], capture_output=True).returncode != 0:
        return
    stamp = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "reprompty-no-cdp-warned")
    try:
        if time.time() - os.path.getmtime(stamp) < 1800:
            return
    except OSError:
        pass
    open(stamp, "w").close()
    subprocess.run(["notify-send", "-a", "Reprompty", "-i", "dialog-warning",
                    "VS Code has no debug port",
                    f"Nothing on port {port}, so sash snapping and zoom can't work. "
                    "Fully quit VS Code (File > Exit) and reopen it."],
                   capture_output=True)


def find_matching_target(targets: list, window_title: Optional[str] = None) -> Optional[dict]:
    """Find the CDP target matching the given window title."""
    workbench_targets = [t for t in targets if "workbench" in t.get("url", "")]

    if window_title:
        # Exact match
        for t in targets:
            if t.get("title") == window_title:
                return t
        # Partial match
        for t in targets:
            if window_title in t.get("title", ""):
                return t

    # Fallback to first workbench target
    if workbench_targets:
        return workbench_targets[0]

    # Last resort: first page target
    if targets:
        return targets[0]

    return None


def cdp_send(ws: MinimalWebSocket, method: str, params: dict) -> dict:
    """Send a CDP command and wait for the response."""
    msg_id = random.randint(1, 1000000)
    msg = json.dumps({"id": msg_id, "method": method, "params": params})
    ws.send_text(msg)

    while True:
        response = ws.recv_text()
        try:
            data = json.loads(response)
            if data.get("id") == msg_id:
                return data
        except Exception:
            continue


def get_auxiliary_bar_sash_position(ws: MinimalWebSocket) -> Optional[dict]:
    """Query the DOM to find the auxiliary bar sash position and side."""
    js = """
(() => {
    const debug = [];
    const auxBar = document.getElementById('workbench.parts.auxiliarybar');
    if (!auxBar) return JSON.stringify({ error: 'no-auxiliary-bar', debug: ['auxBar element not found'] });

    const auxRect = auxBar.getBoundingClientRect();
    // Which edge of the window is the bar docked against? Compare the gap on
    // each side rather than testing the bar's left edge against the midpoint:
    // a wide right-hand panel starts at or before the centre, so the midpoint
    // test flips to LEFT exactly when the panel is half the window or wider.
    const gapLeft = auxRect.left;
    const gapRight = window.innerWidth - auxRect.right;
    const isLeft = gapLeft <= gapRight;
    debug.push('auxBar: left=' + Math.round(auxRect.left) + ' top=' + Math.round(auxRect.top) + ' w=' + Math.round(auxRect.width) + ' h=' + Math.round(auxRect.height));
    debug.push('auxBar side=' + (isLeft ? 'LEFT' : 'RIGHT') + ' gapL=' + Math.round(gapLeft) + ' gapR=' + Math.round(gapRight));

    if (auxRect.width === 0) return JSON.stringify({ error: 'auxiliary-bar-hidden', auxBarWidth: 0, debug: debug });

    const allSashes = document.querySelectorAll('.monaco-sash');
    const vertSashes = document.querySelectorAll('.monaco-sash.vertical');
    debug.push('sashes: total=' + allSashes.length + ' vertical=' + vertSashes.length);

    let bestSash = null;
    let bestDist = Infinity;
    for (const s of vertSashes) {
        const r = s.getBoundingClientRect();
        const sashCenter = r.left + r.width / 2;
        const dist = isLeft
            ? Math.abs(sashCenter - (auxRect.left + auxRect.width))
            : Math.abs(sashCenter - auxRect.left);
        debug.push('  sash: x=' + Math.round(r.left) + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height) + ' dist=' + Math.round(dist));
        if (dist < bestDist) {
            bestDist = dist;
            bestSash = s;
        }
    }
    if (!bestSash || bestDist > 20) return JSON.stringify({ error: 'no-sash-found', bestDist: bestDist, debug: debug });

    const sr = bestSash.getBoundingClientRect();
    debug.push('bestSash: left=' + Math.round(sr.left) + ' w=' + Math.round(sr.width) + ' dist=' + Math.round(bestDist));

    return JSON.stringify({
        sashX: Math.round(sr.left + sr.width / 2),
        sashY: Math.round(sr.top + sr.height / 2),
        sashTop: Math.round(sr.top),
        sashBottom: Math.round(sr.bottom),
        auxBarLeft: Math.round(auxRect.left),
        auxBarWidth: Math.round(auxRect.width),
        windowWidth: window.innerWidth,
        devicePixelRatio: window.devicePixelRatio,
        isLeft: isLeft,
        debug: debug
    });
})()
"""
    resp = cdp_send(ws, "Runtime.evaluate", {"expression": js, "returnByValue": True})
    result = resp.get("result", {}).get("result", {})
    value = result.get("value")
    if not value:
        return None
    try:
        return json.loads(value)
    except Exception:
        return None


def wait_for_viewport_settle(
    ws: MinimalWebSocket,
    log_file: Optional[str] = None,
    timeout: float = 1.5,
    interval: float = 0.05,
) -> Optional[int]:
    """Block until window.innerWidth stops changing, then return it.

    move_window() returns as soon as KWin has accepted the geometry, but the
    renderer reflows asynchronously, so window.innerWidth can still report the
    PREVIOUS window's width for a beat afterwards. Positioning the sash against
    that stale number puts it off by the ratio between the old and new widths --
    e.g. moving 3280 -> 3200 at 1.2 zoom left the sash ~33px right of centre.

    Two consecutive equal reads is enough; the reflow is a single synchronous
    layout pass, not a gradual animation.
    """
    deadline = time.time() + timeout
    previous = None
    while time.time() < deadline:
        resp = cdp_send(ws, "Runtime.evaluate",
                        {"expression": "window.innerWidth", "returnByValue": True})
        current = resp.get("result", {}).get("result", {}).get("value")
        if not isinstance(current, (int, float)):
            return None
        current = int(current)
        if previous is not None and current == previous:
            return current
        previous = current
        time.sleep(interval)

    log(f"CDP: viewport still changing after {timeout}s, using {previous}", log_file)
    return previous


def cdp_drag_sash(ws: MinimalWebSocket, from_x: int, from_y: int, to_x: int, to_y: int):
    """Drag the sash from one position to another via CDP mouse events.
    Single instant move — matches Windows PowerShell behaviour."""
    # Move physical cursor away from sash to avoid interference
    # with synthetic CDP mouse events
    try:
        subprocess.run(
            ["ydotool", "mousemove", "0", "0"],
            capture_output=True, timeout=2
        )
    except Exception:
        pass
    # Mouse pressed at sash
    cdp_send(ws, "Input.dispatchMouseEvent", {
        "type": "mousePressed",
        "x": from_x,
        "y": from_y,
        "button": "left",
        "clickCount": 1,
    })
    # Single instant move to target (no interpolation)
    cdp_send(ws, "Input.dispatchMouseEvent", {
        "type": "mouseMoved",
        "x": to_x,
        "y": from_y,
        "button": "left",
    })
    # Release at target
    cdp_send(ws, "Input.dispatchMouseEvent", {
        "type": "mouseReleased",
        "x": to_x,
        "y": from_y,
        "button": "left",
        "clickCount": 1,
    })


def set_auxiliary_bar_width_cdp(
    target_width: int = 0,
    window_title: Optional[str] = None,
    expected_window_width: int = 0,
    panel_side: str = "right",
    log_file: Optional[str] = None,
    panel_fraction: Optional[float] = None,
    sash_fraction: Optional[float] = None,
) -> bool:
    """Resize auxiliary bar via CDP sash drag. Returns True on success."""
    log("Resizing auxiliary bar via CDP...", log_file)

    port = get_cdp_port()
    targets = get_cdp_targets(port, log_file)
    target = find_matching_target(targets, window_title)

    if not target:
        log("CDP: No suitable target found", log_file)
        return False

    ws_url = target.get("webSocketDebuggerUrl")
    if not ws_url:
        log("CDP: Target has no WebSocket URL", log_file)
        return False

    ws = None
    cached = False
    try:
        ws = _get_cached_ws(ws_url)
        if ws:
            log(f"CDP: Reusing cached connection to {target.get('title', 'unknown')}", log_file)
            cached = True
        else:
            ws = MinimalWebSocket(ws_url)
            _cache_ws(ws_url, ws)
            log(f"CDP: Connected to {target.get('title', 'unknown')}", log_file)

        # Let the renderer finish reflowing after the window move before reading
        # any geometry off it -- see wait_for_viewport_settle().
        wait_for_viewport_settle(ws, log_file)

        sash_info = get_auxiliary_bar_sash_position(ws)
        if not sash_info or sash_info.get("error"):
            err = sash_info.get("error") if sash_info else "no response"
            log(f"CDP: Sash error: {err}", log_file)
            return False

        current_sash_x = sash_info["sashX"]
        sash_y = sash_info["sashY"]

        # Where the bar actually is beats where the config thinks it should be:
        # the user can move it (workbench.action.moveSideBarLeft/Right) without
        # the layout slots knowing. panel_side is only a fallback for when the
        # DOM query could not tell us.
        detected_left = sash_info.get("isLeft")
        if detected_left is None:
            is_left = (panel_side == "left")
        else:
            is_left = bool(detected_left)

        # window.innerWidth: CSS pixels of the live renderer viewport. This is the
        # only width that shares units with the CDP mouse coordinates dispatched
        # below, and it already accounts for BOTH VS Code's zoom level and the
        # output's scale factor.
        viewport_width = sash_info["windowWidth"]

        # Work in fractions, never absolute pixels. `target_width` and
        # `expected_window_width` are KWin LOGICAL pixels; their ratio is
        # unit-free and stays correct at any zoom and any scale. Feeding the
        # logical width straight in as a CDP coordinate (what this did before)
        # only happens to work at zoom level 0 on a 1.0-scale output -- at 1.2
        # zoom the sash overshoots by exactly that factor, which is what made it
        # drift off-centre on every zoom step.
        # Pin the SASH's offset from the window's left edge, not the panel's share
        # of the window. The two are only interchangeable on a symmetric span: if
        # the window covers monitors of different widths (1360 + 1920 here), the
        # panel is a different width depending on which side it is docked to,
        # while the seam it should align with never moves. Storing the panel's
        # share therefore throws the sash off the seam the moment the side bar is
        # moved to the other side.
        if sash_fraction is not None:
            frac = float(sash_fraction)
        else:
            panel_frac = panel_fraction
            if panel_frac is None:
                ref_width = expected_window_width if expected_window_width > 0 else viewport_width
                panel_frac = (target_width / ref_width) if ref_width > 0 else 0.5
            panel_frac = min(max(float(panel_frac), 0.0), 1.0)
            frac = panel_frac if is_left else (1.0 - panel_frac)

        frac = min(max(frac, 0.0), 1.0)
        target_sash_x = round(viewport_width * frac)

        side_str = "LEFT" if is_left else "RIGHT"
        log(
            f"CDP: Sash at X={current_sash_x}, target X={target_sash_x} "
            f"(sash={frac:.4f} of viewport {viewport_width}px, panel on {side_str})",
            log_file,
        )

        # Remember what this apply asked for, so the watcher can restore it after
        # the viewport changes size (zoom) or the panel is moved to the other side.
        global _last_sash_state
        _last_sash_state = {
            "title": window_title,
            "sash_fraction": frac,
            "dpr": sash_info.get("devicePixelRatio"),
            "is_left": is_left,
        }

        if abs(current_sash_x - target_sash_x) <= 5:
            log("CDP: Already at target position", log_file)
            return True

        log(f"CDP: Dragging sash from X={current_sash_x} to X={target_sash_x}", log_file)
        cdp_drag_sash(ws, current_sash_x, sash_y, target_sash_x, sash_y)
        time.sleep(0.1)

        # Verify
        verify = get_auxiliary_bar_sash_position(ws)
        if verify and not verify.get("error"):
            new_width = verify["auxBarWidth"]
            log(f"CDP: Auxiliary bar resized to {new_width}px", log_file)
            return True

        log("CDP: Drag sent (verification skipped)", log_file)
        return True

    except Exception as e:
        log(f"CDP error: {e}", log_file)
        if ws and ws_url in _cdp_websockets:
            del _cdp_websockets[ws_url]
        return False
    finally:
        if ws and not cached:
            ws.close()


# =============================================================================
# Main
# =============================================================================

def load_slot_from_config(slot_letter: str, log_file: Optional[str] = None) -> Optional[dict]:
    """Load layout coordinates from ~/.reprompty/layouts.json."""
    try:
        home = os.environ.get("HOME", ".")
        config_path = os.path.join(home, ".reprompty", "layouts.json")
        if not os.path.exists(config_path):
            return None
        with open(config_path, "r") as f:
            data = json.load(f)
        for slot in data.get("slots", []):
            if slot.get("letter") == slot_letter:
                return {
                    "x": slot.get("windowX", 0),
                    "y": slot.get("windowY", 0),
                    "width": slot.get("windowWidth", 1920),
                    "height": slot.get("windowHeight", 1080),
                    "panel_width": slot.get("panelWidth", 960),
                    # Optional. When present it wins over panelWidth, because a
                    # fraction survives monitor rescales and zoom changes that
                    # an absolute pixel count does not.
                    "panel_fraction": slot.get("panelFraction"),
                    # Preferred over both: the sash's offset from the window's
                    # left edge. Unlike a panel share it does not change when the
                    # side bar is moved to the opposite side, so it keeps the
                    # sash on a monitor seam even when the monitors differ in
                    # width. See set_auxiliary_bar_width_cdp().
                    "sash_fraction": slot.get("sashFraction"),
                }
        return None
    except Exception as e:
        log(f"Failed to load slot {slot_letter} from layouts.json: {e}", log_file)
        return None


# =============================================================================
# Daemon mode
# =============================================================================

def build_args_from_json(cmd: dict) -> argparse.Namespace:
    """Build an argparse Namespace from a JSON command dict."""
    ns = argparse.Namespace()
    ns.once = True
    ns.daemon = False
    ns.dual = cmd.get("mode") == "dual"
    ns.single = cmd.get("mode") == "single"
    ns.slot = cmd.get("slot")
    ns.window_title = cmd.get("window_title")
    ns.window_handle = cmd.get("window_handle")
    ns.log_path = None
    ns.panel_left = cmd.get("panel_side") == "left"
    ns.panel_right = cmd.get("panel_side") != "left"
    ns.cdp_port = None
    ns.x = cmd.get("x")
    ns.y = cmd.get("y")
    ns.width = cmd.get("width")
    ns.height = cmd.get("height")
    ns.panel_width = cmd.get("panel_width")
    return ns


def run_layout(args: argparse.Namespace) -> dict:
    """Run the layout engine with the given args. Returns a result dict."""
    log_file = args.log_path
    panel_side = "left" if args.panel_left else "right"

    # Load layout: slot config > auto-detect > fallback
    if args.slot:
        layout = load_slot_from_config(args.slot, log_file)
        if layout:
            log(f"Loaded slot {args.slot} from layouts.json", log_file)
        else:
            log(f"Slot {args.slot} not found in layouts.json, falling back to auto-detect", log_file)
            layout = None
    else:
        layout = None

    if not layout:
        monitors = get_monitor_geometry(log_file)
        layout_mode = "dual" if args.dual else "single"
        layout = compute_layout(monitors, layout_mode, panel_side)

    # Apply CLI overrides
    if args.x is not None:
        layout["x"] = args.x
    if args.y is not None:
        layout["y"] = args.y
    if args.width is not None:
        layout["width"] = args.width
    if args.height is not None:
        layout["height"] = args.height
    if args.panel_width is not None:
        layout["panel_width"] = args.panel_width
        # An explicit width on the command line is a deliberate override, so drop
        # any stored fraction -- otherwise the fraction would win and silently
        # ignore the flag, which makes --panel-width useless for testing.
        layout["panel_fraction"] = None
        layout["sash_fraction"] = None

    log(
        f"Layout: x={layout['x']} y={layout['y']} w={layout['width']} h={layout['height']} "
        f"panel={layout['panel_width']} sash_fraction={layout.get('sash_fraction')} "
        f"panel_fraction={layout.get('panel_fraction')} side={panel_side}",
        log_file,
    )

    handle = args.window_handle if args.window_handle else None
    wid = find_vscode_window(title=args.window_title, handle=handle, log_file=log_file)
    if not wid:
        return {"ok": False, "error": "No VS Code window found"}

    log(f"Found window: {wid}", log_file)

    resolved_title = args.window_title
    if not resolved_title:
        resolved_title = get_window_title(wid)
        if resolved_title:
            log(f"Resolved window title: {resolved_title}", log_file)

    if not move_window(wid, layout["x"], layout["y"], layout["width"], layout["height"], log_file):
        return {"ok": False, "error": "Failed to move window"}

    cdp_success = set_auxiliary_bar_width_cdp(
        target_width=layout["panel_width"],
        window_title=resolved_title,
        expected_window_width=layout["width"],
        panel_side=panel_side,
        log_file=log_file,
        panel_fraction=layout.get("panel_fraction"),
        sash_fraction=layout.get("sash_fraction"),
    )

    if cdp_success:
        log("CDP resize succeeded.", log_file)
    else:
        log("CDP resize failed, falling back to state.vscdb...", log_file)
        db_updated = set_auxiliary_bar_width(layout["panel_width"], log_file)
        if db_updated:
            log("Panel width set in state DB.", log_file)
        else:
            log("WARNING: state DB fallback also failed.", log_file)
        trigger_layout_refresh(wid, log_file)

    log("Layout applied successfully", log_file)
    return {
        "ok": True,
        "message": f"Moved window to {layout['x']},{layout['y']} size {layout['width']}x{layout['height']}"
    }


def zoom_watcher_loop(interval: float = 0.5):
    """Keep the sash on its mark when the window changes out from under it.

    Two things move the sash without anyone asking:

    * Zoom. VS Code stores the auxiliary bar as an ABSOLUTE pixel width, so
      zooming changes the viewport's CSS width while the bar keeps its size --
      the sash's fraction of the window shifts on every zoom step.
    * Moving the side bar to the other side (Ctrl+Alt+~ /
      workbench.action.moveSideBarLeft/Right). VS Code preserves the bar's
      WIDTH across the move, so on a window spanning unequal monitors the sash
      lands nowhere near the seam it came from.

    Watching devicePixelRatio and the docked side (rather than a resize event)
    means this fires for every zoom path -- keyboard, Ctrl+scroll, the menu --
    and never when the user deliberately drags the sash themselves, since a
    manual drag changes neither signal.
    """
    global _last_sash_state

    while True:
        time.sleep(interval)
        state = _last_sash_state
        if not state:
            continue

        ws_url = None
        try:
            port = get_cdp_port()
            targets = get_cdp_targets(port)
            target = find_matching_target(targets, state.get("title"))
            if not target:
                continue
            ws_url = target.get("webSocketDebuggerUrl")
            if not ws_url:
                continue

            ws = _get_cached_ws(ws_url)
            if not ws:
                ws = MinimalWebSocket(ws_url)
                _cache_ws(ws_url, ws)

            probe = cdp_send(ws, "Runtime.evaluate", {
                "expression": """(() => {
                    const b = document.getElementById('workbench.parts.auxiliarybar');
                    if (!b) return null;
                    const r = b.getBoundingClientRect();
                    if (r.width === 0) return null;
                    return JSON.stringify({
                        dpr: window.devicePixelRatio,
                        isLeft: r.left <= (window.innerWidth - r.right)
                    });
                })()""",
                "returnByValue": True,
            })
            raw = probe.get("result", {}).get("result", {}).get("value")
            if not raw:
                continue
            now = json.loads(raw)

            dpr_before, side_before = state.get("dpr"), state.get("is_left")
            zoom_changed = (
                isinstance(now.get("dpr"), (int, float))
                and isinstance(dpr_before, (int, float))
                and abs(now["dpr"] - dpr_before) > 1e-6
            )
            side_changed = (
                isinstance(side_before, bool)
                and bool(now.get("isLeft")) != side_before
            )
            if not (zoom_changed or side_changed):
                continue

            reason = "zoom" if zoom_changed else "side bar moved"
            log(f"{reason} detected, restoring sash to {state['sash_fraction']:.4f}")

            # Serialise against a layout request landing at the same moment.
            with _layout_lock:
                set_auxiliary_bar_width_cdp(
                    window_title=state.get("title"),
                    sash_fraction=state["sash_fraction"],
                )

            # The apply above rewrote _last_sash_state; carry the fraction we
            # intended forward so repeated zooming keeps converging on the
            # slot's value rather than drifting a little further each time.
            if _last_sash_state:
                _last_sash_state["sash_fraction"] = state["sash_fraction"]

        except Exception as e:
            log(f"Zoom watcher error: {e}")
            # A dead socket is the usual cause; drop it so the next pass redials.
            if ws_url and ws_url in _cdp_websockets:
                del _cdp_websockets[ws_url]


def daemon_main():
    """Run as a background daemon listening on a Unix domain socket."""
    ensure_linux_session_env()
    socket_path = os.path.join(
        os.environ.get("XDG_RUNTIME_DIR", "/tmp"),
        "reprompty",
        "daemon.sock"
    )
    os.makedirs(os.path.dirname(socket_path), exist_ok=True)
    if os.path.exists(socket_path):
        os.unlink(socket_path)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(socket_path)
    server.listen(5)
    log(f"Daemon listening on {socket_path}")

    watcher = threading.Thread(target=zoom_watcher_loop, name="zoom-watcher", daemon=True)
    watcher.start()
    log("Zoom watcher started")

    try:
        while True:
            conn, _ = server.accept()
            try:
                data = b""
                while b"\n" not in data:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    data += chunk
                if not data:
                    continue
                line = data.decode("utf-8").split("\n")[0].strip()
                cmd = json.loads(line)
                if cmd.get("cmd") == "ping":
                    resp = {"ok": True, "message": "pong"}
                elif cmd.get("cmd") == "list_windows":
                    with _layout_lock:
                        wins = []
                        for w in find_vscode_window_list():
                            wins.append({
                                "uuid": w[0],
                                "caption": w[1],
                            })
                    resp = {"ok": True, "message": f"{len(wins)} window(s) found", "data": wins}
                else:
                    with _layout_lock:
                        args = build_args_from_json(cmd)
                        resp = run_layout(args)
                conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
            except Exception as e:
                try:
                    conn.sendall((json.dumps({"ok": False, "error": str(e)}) + "\n").encode("utf-8"))
                except Exception:
                    pass
            finally:
                conn.close()
    except KeyboardInterrupt:
        pass
    finally:
        server.close()
        if os.path.exists(socket_path):
            os.unlink(socket_path)


def find_vscode_window_list() -> list:
    """Return a list of (uuid_or_id, caption) for all VS Code windows."""
    results = []
    if _has_kdotool():
        for term in ["Visual Studio Code", "Kilo Code", "Kimi Code", "VSCodium", "Code - OSS"]:
            try:
                proc = subprocess.run(
                    [KDOTOOL_PATH, "search", "--title", term],
                    capture_output=True, text=True, timeout=5
                )
                if proc.returncode == 0:
                    for line in proc.stdout.strip().split("\n"):
                        line = line.strip()
                        if line:
                            title = get_window_title(line)
                            if title:
                                results.append((line, title))
            except Exception:
                pass
    return results


def try_daemon_socket(args: argparse.Namespace) -> Optional[dict]:
    """Try to send the layout command to the running daemon socket.
    Returns the daemon's response dict, or None if daemon is not available."""
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR") or "/tmp"
    socket_path = os.path.join(runtime_dir, "reprompty", "daemon.sock")
    if not os.path.exists(socket_path):
        return None

    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(3)
        s.connect(socket_path)

        cmd: dict = {}
        if args.slot:
            cmd["slot"] = args.slot
        if args.dual:
            cmd["mode"] = "dual"
        if args.single:
            cmd["mode"] = "single"
        if args.window_title:
            cmd["window_title"] = args.window_title
        if args.window_handle:
            cmd["window_handle"] = args.window_handle
        if args.panel_left:
            cmd["panel_side"] = "left"
        elif args.panel_right:
            cmd["panel_side"] = "right"
        if args.x is not None:
            cmd["x"] = args.x
        if args.y is not None:
            cmd["y"] = args.y
        if args.width is not None:
            cmd["width"] = args.width
        if args.height is not None:
            cmd["height"] = args.height
        if args.panel_width is not None:
            cmd["panel_width"] = args.panel_width

        s.sendall((json.dumps(cmd) + "\n").encode())

        data = b""
        while b"\n" not in data:
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk

        s.close()
        if data:
            return json.loads(data.decode().strip())
    except Exception:
        pass
    return None


def main():
    ensure_linux_session_env()
    parser = argparse.ArgumentParser(description="VS Code Linux Layout")
    parser.add_argument("--once", action="store_true", help="Run once and exit")
    parser.add_argument("--daemon", action="store_true", help="Run as background daemon listening on Unix socket")
    parser.add_argument("--dual", action="store_true", help="Dual monitor layout")
    parser.add_argument("--single", action="store_true", help="Single monitor layout")
    parser.add_argument("--slot", type=str, default=None, help="Load coordinates from layouts.json slot (A or B)")
    parser.add_argument("--window-title", type=str, default=None)
    parser.add_argument("--window-handle", type=str, default=None, help="Window ID (xdotool integer or kdotool UUID)")
    parser.add_argument("--log-path", type=str, default=None)
    parser.add_argument("--panel-left", action="store_true", help="Panel on left side")
    parser.add_argument("--panel-right", action="store_true", help="Panel on right side (default)")
    parser.add_argument("--cdp-port", type=int, default=None, help="CDP port override")
    parser.add_argument("--x", type=int, default=None, help="Override window X position")
    parser.add_argument("--y", type=int, default=None, help="Override window Y position")
    parser.add_argument("--width", type=int, default=None, help="Override window width")
    parser.add_argument("--height", type=int, default=None, help="Override window height")
    parser.add_argument("--panel-width", type=int, default=None, help="Override panel width")
    args = parser.parse_args()

    if args.daemon:
        daemon_main()
        return

    # Try daemon socket first for instant, serialized execution
    daemon_resp = try_daemon_socket(args)
    if daemon_resp is not None:
        print(json.dumps(daemon_resp))
        sys.exit(0 if daemon_resp.get("ok") else 1)

    result = run_layout(args)
    if result.get("ok"):
        log(result.get("message", "Done"), args.log_path)
        sys.exit(0)
    else:
        log(f"ERROR: {result.get('error', 'Unknown error')}", args.log_path)
        sys.exit(1)


if __name__ == "__main__":
    main()
