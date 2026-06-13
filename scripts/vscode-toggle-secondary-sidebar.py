#!/usr/bin/env python3
"""
VS Code: Secondary Side Bar Toggle

Instantly toggles the secondary/auxiliary side bar via Chrome DevTools Protocol,
disables/restores the default Ctrl+Alt+B binding, and can listen for a user-captured
key (e.g. Pause/Break) to trigger the toggle.

# reprompty-mcp: {"toolName":"toggle_secondary_sidebar","label":"Toggle Secondary Side Bar","description":"Toggle VS Code: secondary side bar visibility via CDP","args":["toggle"]}
# reprompty-mcp: {"toolName":"configure_sidebar_key","label":"Configure Sidebar Key","description":"Open UI to capture your special key and start using it","args":["configure"]}
# reprompty-mcp: {"toolName":"disable_ctrl_alt_b","label":"Disable Ctrl+Alt+B","description":"Unbind Ctrl+Alt+B from toggling the secondary side bar","args":["disable_ctrl_alt_b"]}
# reprompty-mcp: {"toolName":"enable_ctrl_alt_b","label":"Enable Ctrl+Alt+B","description":"Restore Ctrl+Alt+B for toggling the secondary side bar","args":["enable_ctrl_alt_b"]}
# reprompty-mcp: {"toolName":"start_sidebar_listener","label":"Start Sidebar Listener","description":"Start listening for the configured key to toggle the side bar","args":["start"]}
# reprompty-mcp: {"toolName":"stop_sidebar_listener","label":"Stop Sidebar Listener","description":"Stop the configured-key listener","args":["stop"]}
# reprompty-mcp: {"toolName":"sidebar_listener_status","label":"Sidebar Listener Status","description":"Show whether the key listener is running","args":["status"]}

Usage:
    python3 vscode-toggle-secondary-sidebar.py toggle
    python3 vscode-toggle-secondary-sidebar.py configure
    python3 vscode-toggle-secondary-sidebar.py disable_ctrl_alt_b
    python3 vscode-toggle-secondary-sidebar.py enable_ctrl_alt_b
    python3 vscode-toggle-secondary-sidebar.py start
    python3 vscode-toggle-secondary-sidebar.py stop
    python3 vscode-toggle-secondary-sidebar.py status
"""

import argparse
import base64
import hashlib
import json
import os
import random
import re
import select
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from typing import Optional, Tuple

# =============================================================================
# Configuration
# =============================================================================

DEFAULT_CDP_PORT = 9222
DEFAULT_KEYBINDINGS_PATH = Path.home() / ".config" / "Code" / "User" / "keybindings.json"
CONFIG_DIR = Path.home() / ".reprompty"
PID_FILE = CONFIG_DIR / "vscode-toggle-secondary-sidebar.pid"
KEY_CONFIG_FILE = CONFIG_DIR / "vscode-sidebar-key.json"
COMMAND_NAME = "View: Toggle Secondary Side Bar Visibility"
COMMAND_ID = "workbench.action.toggleAuxiliaryBar"
DEFAULT_KEY_NAME = "KEY_PAUSE"
DEFAULT_KEY_CODE = 119

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

        response = b""
        while b"\r\n\r\n" not in response:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("WebSocket handshake failed")
            response += chunk

        header, _ = response.split(b"\r\n\r\n", 1)
        if b"101" not in header.split(b"\r\n", 1)[0]:
            raise ConnectionError(f"WebSocket handshake failed: {header.decode(errors='replace')}")

        expected = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        if expected.encode() not in header:
            raise ConnectionError("WebSocket accept key mismatch")

    def send_text(self, text: str):
        data = text.encode("utf-8")
        mask = struct.pack("<I", random.getrandbits(32))
        length = len(data)

        if length < 126:
            header = struct.pack("!BB", 0x81, 0x80 | length)
        elif length < 65536:
            header = struct.pack("!BBH", 0x81, 0x80 | 126, length)
        else:
            header = struct.pack("!BBQ", 0x81, 0x80 | 127, length)

        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(header + mask + masked)

    def recv_text(self, timeout: Optional[float] = None) -> str:
        if timeout is not None:
            self.sock.settimeout(timeout)
        try:
            header = self._recv_exact(2)
        finally:
            self.sock.settimeout(None)

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

        if opcode == 0x08:
            raise ConnectionError("WebSocket closed by server")
        if opcode == 0x09:
            self.sock.sendall(struct.pack("!BB", 0x8A, 0) + payload)
            return self.recv_text()

        if opcode == 0x01:
            return payload.decode("utf-8")
        if opcode == 0x02:
            return payload.decode("utf-8")

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
# CDP helpers
# =============================================================================


def find_vscode_websocket(cdp_port: int = DEFAULT_CDP_PORT) -> str:
    """Find the CDP WebSocket URL for a VS Code: window."""
    url = f"http://localhost:{cdp_port}/json/list"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        raise RuntimeError(f"Cannot reach CDP at {url}: {e}")

    for item in data:
        title = item.get("title", "")
        if item.get("type") == "page" and "Visual Studio Code" in title:
            return item["webSocketDebuggerUrl"]

    raise RuntimeError("No VS Code: page found on CDP")


def focus_vscode_window():
    """Best-effort focus of the active VS Code: window using kdotool/xdotool."""
    for tool in ["kdotool", "xdotool"]:
        path = subprocess.run(["which", tool], capture_output=True, text=True).stdout.strip()
        if not path:
            continue
        try:
            if tool == "kdotool":
                result = subprocess.run(
                    [path, "search", "--name", "Visual Studio Code"],
                    capture_output=True, text=True, timeout=5
                )
                ids = [x for x in result.stdout.strip().splitlines() if x.strip()]
                if ids:
                    subprocess.run([path, "windowactivate", ids[0]], capture_output=True, timeout=5)
                    return
            else:
                result = subprocess.run(
                    [path, "search", "--name", "Visual Studio Code"],
                    capture_output=True, text=True, timeout=5
                )
                ids = [x for x in result.stdout.strip().splitlines() if x.strip()]
                if ids:
                    subprocess.run([path, "windowactivate", ids[0]], capture_output=True, timeout=5)
                    return
        except Exception:
            continue


def send_key_event(ws: MinimalWebSocket, msg_id: int, type_: str, key: str, code: str,
                   windows_vk: int, native_vk: int, modifiers: int = 0):
    params = {
        "type": type_,
        "key": key,
        "code": code,
        "windowsVirtualKeyCode": windows_vk,
        "nativeVirtualKeyCode": native_vk,
        "modifiers": modifiers,
    }
    ws.send_text(json.dumps({"id": msg_id, "method": "Input.dispatchKeyEvent", "params": params}))


def toggle_secondary_side_bar(cdp_port: int = DEFAULT_CDP_PORT) -> bool:
    """Toggle the secondary side bar via CDP command palette."""
    focus_vscode_window()
    time.sleep(0.05)

    ws_url = find_vscode_websocket(cdp_port)
    ws = MinimalWebSocket(ws_url, timeout=10.0)

    try:
        ws.send_text(json.dumps({"id": 1, "method": "Runtime.enable"}))
        ws.recv_text(timeout=2.0)

        msg_id = 2

        # Ctrl+Shift+P
        send_key_event(ws, msg_id, "rawKeyDown", "Control", "ControlLeft", 17, 17, 2)
        msg_id += 1
        send_key_event(ws, msg_id, "rawKeyDown", "Shift", "ShiftLeft", 16, 16, 2 | 8)
        msg_id += 1
        send_key_event(ws, msg_id, "rawKeyDown", "p", "KeyP", 80, 80, 2 | 8)
        msg_id += 1
        send_key_event(ws, msg_id, "keyUp", "p", "KeyP", 80, 80, 2 | 8)
        msg_id += 1
        send_key_event(ws, msg_id, "keyUp", "Shift", "ShiftLeft", 16, 16, 2)
        msg_id += 1
        send_key_event(ws, msg_id, "keyUp", "Control", "ControlLeft", 17, 17, 0)
        msg_id += 1

        time.sleep(0.25)

        ws.send_text(json.dumps({"id": msg_id, "method": "Input.insertText", "params": {"text": COMMAND_NAME}}))
        msg_id += 1

        time.sleep(0.2)

        send_key_event(ws, msg_id, "rawKeyDown", "Enter", "Enter", 13, 13, 0)
        msg_id += 1
        send_key_event(ws, msg_id, "keyUp", "Enter", "Enter", 13, 13, 0)
        msg_id += 1

        time.sleep(0.1)
        return True
    finally:
        ws.close()


# =============================================================================
# Keybinding helpers
# =============================================================================


def load_keybindings(path: Path) -> list:
    if not path.exists():
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception as e:
        raise RuntimeError(f"Failed to read {path}: {e}")


def save_keybindings(path: Path, data: list):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4)


def disable_ctrl_alt_b(path: Optional[Path] = None):
    target = Path(path) if path else DEFAULT_KEYBINDINGS_PATH
    bindings = load_keybindings(target)

    for entry in bindings:
        if isinstance(entry, dict) and entry.get("key") == "ctrl+alt+b" and entry.get("command") == f"-{COMMAND_ID}":
            print(f"Ctrl+Alt+B is already disabled in {target}")
            return

    bindings.append({
        "key": "ctrl+alt+b",
        "command": f"-{COMMAND_ID}",
    })
    save_keybindings(target, bindings)
    print(f"Disabled Ctrl+Alt+B for secondary side bar in {target}")
    print("VS Code: should reload keybindings automatically. If not, reload the window (Ctrl+Shift+P → 'Developer: Reload Window').")


def enable_ctrl_alt_b(path: Optional[Path] = None):
    target = Path(path) if path else DEFAULT_KEYBINDINGS_PATH
    bindings = load_keybindings(target)

    new_bindings = [
        entry for entry in bindings
        if not (isinstance(entry, dict) and entry.get("key") == "ctrl+alt+b" and entry.get("command") == f"-{COMMAND_ID}")
    ]

    if len(new_bindings) == len(bindings):
        print(f"Ctrl+Alt+B was not disabled in {target}")
        return

    save_keybindings(target, new_bindings)
    print(f"Restored Ctrl+Alt+B for secondary side bar in {target}")
    print("VS Code: should reload keybindings automatically. If not, reload the window (Ctrl+Shift+P → 'Developer: Reload Window').")


# =============================================================================
# Config helpers
# =============================================================================


def load_key_config() -> Tuple[str, int]:
    if KEY_CONFIG_FILE.exists():
        try:
            data = json.loads(KEY_CONFIG_FILE.read_text())
            return data.get("key_name", DEFAULT_KEY_NAME), int(data.get("key_code", DEFAULT_KEY_CODE))
        except Exception:
            pass
    return DEFAULT_KEY_NAME, DEFAULT_KEY_CODE


def save_key_config(key_name: str, key_code: int):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    KEY_CONFIG_FILE.write_text(json.dumps({"key_name": key_name, "key_code": key_code}, indent=2))


# =============================================================================
# Listener daemon
# =============================================================================


def get_script_path() -> Path:
    return Path(__file__).resolve()


def get_venv_python() -> Optional[str]:
    venv = get_script_path().parent / ".venv" / "bin" / "python"
    if venv.is_file():
        return str(venv)
    return None


def read_pid() -> Optional[int]:
    if not PID_FILE.exists():
        return None
    try:
        return int(PID_FILE.read_text().strip())
    except Exception:
        return None


def write_pid(pid: int):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    PID_FILE.write_text(str(pid))


def clear_pid():
    if PID_FILE.exists():
        PID_FILE.unlink()


def is_process_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def listener_status():
    pid = read_pid()
    if pid is None:
        print("Sidebar key listener is not running")
        return
    if is_process_running(pid):
        key_name, key_code = load_key_config()
        print(f"Sidebar key listener is running (PID {pid}), listening for {key_name} (code {key_code})")
    else:
        print(f"Sidebar key listener PID {pid} is stale")
        clear_pid()


def stop_listener():
    pid = read_pid()
    if pid is None:
        print("Sidebar key listener is not running")
        return
    if is_process_running(pid):
        try:
            os.kill(pid, 15)
            for _ in range(20):
                if not is_process_running(pid):
                    break
                time.sleep(0.1)
        except ProcessLookupError:
            pass
        print(f"Stopped sidebar key listener (PID {pid})")
    else:
        print(f"Sidebar key listener PID {pid} was already dead")
    clear_pid()


def find_keyboards_with_key(key_code: int):
    """Return a list of evdev devices that expose the given key code."""
    try:
        import evdev
    except ImportError:
        raise RuntimeError(
            "evdev is not installed. Run:\n"
            "  python3 -m venv /path/to/venv\n"
            "  /path/to/venv/bin/pip install evdev"
        )

    keyboards = []
    for device_path in evdev.list_devices():
        try:
            dev = evdev.InputDevice(device_path)
            caps = dev.capabilities().get(evdev.ecodes.EV_KEY, [])
            if key_code in caps:
                keyboards.append(dev)
        except Exception:
            continue
    return keyboards


def listen_loop():
    """Run the evdev listener. Meant to be called in a daemon process."""
    try:
        import evdev
    except ImportError:
        print("evdev is not installed; cannot start listener", file=sys.stderr)
        sys.exit(1)

    key_name, key_code = load_key_config()
    keyboards = find_keyboards_with_key(key_code)
    if not keyboards:
        print(f"No keyboard with {key_name} (code {key_code}) found", file=sys.stderr)
        sys.exit(1)

    for dev in keyboards:
        try:
            dev.grab()
        except Exception as e:
            print(f"Could not grab {dev.path}: {e}", file=sys.stderr)

    python = sys.executable
    script = get_script_path()

    print(f"Listening for {key_name} (code {key_code}) on {len(keyboards)} keyboard(s)...")
    sys.stdout.flush()

    fds = {dev.fd: dev for dev in keyboards}
    while True:
        try:
            readable, _, _ = select.select(list(fds.keys()), [], [], 1.0)
            for fd in readable:
                dev = fds[fd]
                try:
                    for event in dev.read():
                        if (
                            event.type == evdev.ecodes.EV_KEY
                            and event.code == key_code
                            and event.value == 1
                        ):
                            try:
                                subprocess.run([python, str(script), "toggle"], check=False, timeout=10)
                            except Exception as e:
                                print(f"Toggle failed: {e}", file=sys.stderr)
                except OSError as e:
                    print(f"Device {dev.path} disconnected: {e}", file=sys.stderr)
                    del fds[fd]
                    if not fds:
                        print("All keyboards disconnected; exiting", file=sys.stderr)
                        sys.exit(1)
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"Listener error: {e}", file=sys.stderr)


def start_listener():
    pid = read_pid()
    if pid is not None and is_process_running(pid):
        key_name, _ = load_key_config()
        print(f"Sidebar key listener already running (PID {pid}), listening for {key_name}")
        return

    try:
        import evdev  # noqa: F401
    except ImportError:
        venv_python = get_venv_python()
        if venv_python:
            print(f"Restarting with venv python: {venv_python}")
            os.execv(venv_python, [venv_python, str(get_script_path()), "start"])
        print("evdev is not installed. Please install it (see README).", file=sys.stderr)
        sys.exit(1)

    pid = os.fork()
    if pid > 0:
        write_pid(pid)
        key_name, _ = load_key_config()
        print(f"Started sidebar key listener (PID {pid}), listening for {key_name}")
        return

    os.setsid()
    try:
        sys.stdin.close()
    except Exception:
        pass
    sys.stdout.flush()
    sys.stderr.flush()
    listen_loop()


# =============================================================================
# Key-capture GUI
# =============================================================================


def ensure_venv():
    """Re-exec with venv python if evdev is missing."""
    try:
        import evdev  # noqa: F401
        return
    except ImportError:
        venv_python = get_venv_python()
        if venv_python:
            os.execv(venv_python, [venv_python, str(get_script_path()), "configure"])
        print("evdev is not installed. Cannot open key capture UI.", file=sys.stderr)
        sys.exit(1)


def run_key_capture_gui():
    """Open a PyQt6 window that captures the next key press via evdev."""
    ensure_venv()

    try:
        from PyQt6.QtWidgets import QApplication, QWidget, QVBoxLayout, QLabel, QPushButton, QHBoxLayout
        from PyQt6.QtCore import QTimer, Qt
    except ImportError as e:
        print(f"PyQt6 is not available: {e}. Cannot open key capture UI.", file=sys.stderr)
        sys.exit(1)

    import evdev

    app = QApplication(sys.argv)
    window = QWidget()
    window.setWindowTitle("Configure Sidebar Toggle Key")
    window.setMinimumSize(500, 220)

    current_key_name, current_key_code = load_key_config()

    layout = QVBoxLayout()

    status_label = QLabel(f"Current key: {current_key_name} (code {current_key_code})")
    status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
    layout.addWidget(status_label)

    instruction_label = QLabel("Click 'Capture Key', then press the key you want to use.")
    instruction_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
    instruction_label.setWordWrap(True)
    layout.addWidget(instruction_label)

    btn_layout = QHBoxLayout()
    capture_btn = QPushButton("Capture Key")
    apply_btn = QPushButton("Apply")
    close_btn = QPushButton("Close")
    btn_layout.addWidget(capture_btn)
    btn_layout.addWidget(apply_btn)
    btn_layout.addWidget(close_btn)
    layout.addLayout(btn_layout)

    window.setLayout(layout)

    devices = []
    capturing = {"active": False}
    captured = {"name": None, "code": None}
    timer = QTimer()

    def refresh_devices():
        for dev in devices:
            try:
                dev.ungrab()
            except Exception:
                pass
        devices.clear()
        for path in evdev.list_devices():
            try:
                devices.append(evdev.InputDevice(path))
            except Exception:
                pass

    def stop_capture():
        capturing["active"] = False
        timer.stop()
        for dev in devices:
            try:
                dev.ungrab()
            except Exception:
                pass

    def poll_for_key():
        if not capturing["active"]:
            return
        fds = {dev.fd: dev for dev in devices}
        if not fds:
            instruction_label.setText("No input devices found.")
            stop_capture()
            return
        readable, _, _ = select.select(list(fds.keys()), [], [], 0.05)
        for fd in readable:
            dev = fds[fd]
            try:
                for event in dev.read():
                    if event.type == evdev.ecodes.EV_KEY and event.value == 1:
                        key_name = evdev.ecodes.KEY.get(event.code, f"KEY_{event.code}")
                        captured["name"] = key_name
                        captured["code"] = event.code
                        status_label.setText(f"Captured: {key_name} (code {event.code})")
                        instruction_label.setText("Key captured. Click Apply to use it.")
                        stop_capture()
                        return
            except Exception:
                pass

    def on_capture():
        refresh_devices()
        for dev in devices:
            try:
                dev.grab()
            except Exception:
                pass
        capturing["active"] = True
        instruction_label.setText("Listening... press your key now.")
        status_label.setText("Waiting for key press...")
        timer.timeout.connect(poll_for_key)
        timer.start(50)

    def on_apply():
        if captured["name"] is None:
            instruction_label.setText("No key captured yet. Click Capture Key first.")
            return
        save_key_config(captured["name"], captured["code"])
        instruction_label.setText(f"Saved {captured['name']}. Disabling Ctrl+Alt+B and starting listener...")
        app.processEvents()
        try:
            disable_ctrl_alt_b()
            stop_listener()
            start_listener()
            instruction_label.setText(f"Done. {captured['name']} now toggles the side bar.")
        except Exception as e:
            instruction_label.setText(f"Error: {e}")

    def on_close():
        stop_capture()
        window.close()

    capture_btn.clicked.connect(on_capture)
    apply_btn.clicked.connect(on_apply)
    close_btn.clicked.connect(on_close)

    window.show()
    app.exec()


# =============================================================================
# CLI
# =============================================================================


def main():
    parser = argparse.ArgumentParser(
        description="Toggle VS Code: secondary side bar via CDP and bind a custom key."
    )
    parser.add_argument(
        "action",
        nargs="?",
        choices=["toggle", "configure", "disable_ctrl_alt_b", "enable_ctrl_alt_b", "start", "stop", "status"],
        default="toggle",
        help="Action to perform (default: toggle)",
    )
    parser.add_argument("--cdp-port", type=int, default=DEFAULT_CDP_PORT, help="CDP port (default: 9222)")
    parser.add_argument("--keybindings", type=Path, default=None, help="Path to keybindings.json")

    args = parser.parse_args()

    if args.action == "toggle":
        if toggle_secondary_side_bar(args.cdp_port):
            print("Toggled secondary side bar")
    elif args.action == "configure":
        run_key_capture_gui()
    elif args.action == "disable_ctrl_alt_b":
        disable_ctrl_alt_b(args.keybindings)
    elif args.action == "enable_ctrl_alt_b":
        enable_ctrl_alt_b(args.keybindings)
    elif args.action == "start":
        start_listener()
    elif args.action == "stop":
        stop_listener()
    elif args.action == "status":
        listener_status()


if __name__ == "__main__":
    main()
