import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EDITOR_TITLE_SUFFIXES } from "../core/editor-titles.js";
import type { Monitor, Rect } from "../core/layout-slots.js";

export interface WindowFrame extends Rect {
  handle: number;
  title: string;
  maximized: boolean;
  dpiAware: boolean;
  /** SetWindowPos passes placeWindow needed; 0 for getWindowFrame */
  passes?: number;
}

export interface WindowTarget {
  handle?: number;
  title?: string;
}

const RUN_TIMEOUT_MS = 20000;

const EDITOR_NAMES = EDITOR_TITLE_SUFFIXES.map((name) => JSON.stringify(name)).join(", ");

// Windows PowerShell 5.1 compiles Add-Type code as C# 5, and reads a .ps1 without a BOM
// as ANSI, so this stays ASCII and avoids newer C# syntax. Physical pixels throughout.
export const WINDOWS_LAYOUT_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class RpMonitor {
  public string Name { get; set; }
  public bool Primary { get; set; }
  public int Dpi { get; set; }
  public int X { get; set; }
  public int Y { get; set; }
  public int Width { get; set; }
  public int Height { get; set; }
  public int WorkX { get; set; }
  public int WorkY { get; set; }
  public int WorkWidth { get; set; }
  public int WorkHeight { get; set; }
}

public class RpWindow {
  public long Handle { get; set; }
  public string Title { get; set; }
  public bool Maximized { get; set; }
  public bool DpiAware { get; set; }
  public int Passes { get; set; }
  public int X { get; set; }
  public int Y { get; set; }
  public int Width { get; set; }
  public int Height { get; set; }
}

public static class RpLayout {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string szDevice;
  }

  public delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);
  public delegate bool WindowEnumProc(IntPtr hWnd, IntPtr data);

  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFOEX info);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowEnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);

  const int SW_SHOWNOACTIVATE = 4;
  const uint SWP_NOZORDER_NOACTIVATE_NOOWNERZORDER = 0x0004 | 0x0010 | 0x0200;
  const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  const int DWMWA_CLOAKED = 14;
  static readonly string[] EditorNames = new string[] { ${EDITOR_NAMES} };

  static List<RpMonitor> monitors;
  static List<IntPtr> editorWindows;

  static bool PerMonitorDpi() {
    try {
      return SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero
        || SetThreadDpiAwarenessContext(new IntPtr(-3)) != IntPtr.Zero;
    } catch (EntryPointNotFoundException) {
      return false;
    }
  }

  static int MonitorDpi(IntPtr monitor) {
    try {
      uint dpiX;
      uint dpiY;
      if (GetDpiForMonitor(monitor, 0, out dpiX, out dpiY) == 0) return (int)dpiX;
    } catch (DllNotFoundException) {
    } catch (EntryPointNotFoundException) {
    }
    return 96;
  }

  static bool AddMonitor(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data) {
    MONITORINFOEX info = new MONITORINFOEX();
    info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
    if (!GetMonitorInfoW(monitor, ref info)) return true;
    RpMonitor m = new RpMonitor();
    m.Name = info.szDevice;
    m.Primary = (info.dwFlags & 1) != 0;
    m.Dpi = MonitorDpi(monitor);
    m.X = info.rcMonitor.Left;
    m.Y = info.rcMonitor.Top;
    m.Width = info.rcMonitor.Right - info.rcMonitor.Left;
    m.Height = info.rcMonitor.Bottom - info.rcMonitor.Top;
    m.WorkX = info.rcWork.Left;
    m.WorkY = info.rcWork.Top;
    m.WorkWidth = info.rcWork.Right - info.rcWork.Left;
    m.WorkHeight = info.rcWork.Bottom - info.rcWork.Top;
    monitors.Add(m);
    return true;
  }

  public static List<RpMonitor> Monitors() {
    PerMonitorDpi();
    monitors = new List<RpMonitor>();
    MonitorEnumProc callback = new MonitorEnumProc(AddMonitor);
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
    GC.KeepAlive(callback);
    return monitors;
  }

  static string Title(IntPtr hWnd) {
    int length = GetWindowTextLengthW(hWnd);
    if (length <= 0) return "";
    StringBuilder text = new StringBuilder(length + 1);
    GetWindowTextW(hWnd, text, text.Capacity);
    return text.ToString();
  }

  static bool IsEditor(string title) {
    foreach (string name in EditorNames) {
      if (title.IndexOf(name, StringComparison.Ordinal) >= 0) return true;
    }
    return false;
  }

  // Windows on other virtual desktops are cloaked.
  static bool Cloaked(IntPtr hWnd) {
    int cloaked;
    return DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0;
  }

  static bool AddEditorWindow(IntPtr hWnd, IntPtr data) {
    if (IsWindowVisible(hWnd) && IsEditor(Title(hWnd))) editorWindows.Add(hWnd);
    return true;
  }

  // Visible editor windows on every desktop, most recently active first.
  static List<IntPtr> EditorWindows() {
    editorWindows = new List<IntPtr>();
    WindowEnumProc callback = new WindowEnumProc(AddEditorWindow);
    EnumWindows(callback, IntPtr.Zero);
    GC.KeepAlive(callback);
    return editorWindows;
  }

  static string Quoted(string text) {
    return '"' + text + '"';
  }

  static IntPtr Resolve(long handle, string title) {
    if (handle != 0) {
      IntPtr hWnd = new IntPtr(handle);
      if (!IsWindow(hWnd)) throw new ArgumentException("No window has handle " + handle);
      return hWnd;
    }
    if (String.IsNullOrEmpty(title)) {
      IntPtr foreground = GetForegroundWindow();
      if (foreground != IntPtr.Zero && IsEditor(Title(foreground))) return foreground;
      foreach (IntPtr hWnd in EditorWindows()) {
        if (!Cloaked(hWnd)) return hWnd;
      }
      throw new InvalidOperationException("No VS Code window on this desktop");
    }
    List<IntPtr> exact = new List<IntPtr>();
    List<IntPtr> partial = new List<IntPtr>();
    int elsewhere = 0;
    foreach (IntPtr hWnd in EditorWindows()) {
      string text = Title(hWnd);
      if (Cloaked(hWnd)) {
        if (text == title) elsewhere++;
      } else if (text == title) {
        exact.Add(hWnd);
      } else if (text.IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) {
        partial.Add(hWnd);
      }
    }
    // Otherwise a longer title that contains this one would be moved instead.
    if (exact.Count == 0 && elsewhere > 0) {
      throw new InvalidOperationException("The VS Code window " + Quoted(title) + " is on another desktop; pass its window handle");
    }
    List<IntPtr> matches = exact.Count > 0 ? exact : partial;
    if (matches.Count == 1) return matches[0];
    if (matches.Count == 0) throw new InvalidOperationException("No VS Code window on this desktop matches " + Quoted(title));
    throw new InvalidOperationException(matches.Count + " VS Code windows match " + Quoted(title) + "; pass a window handle");
  }

  // The visible frame; GetWindowRect also counts the invisible resize borders.
  static RECT Frame(IntPtr hWnd) {
    RECT rect;
    if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT))) != 0) {
      GetWindowRect(hWnd, out rect);
    }
    return rect;
  }

  static RpWindow Describe(IntPtr hWnd, bool dpiAware, int passes) {
    RECT frame = Frame(hWnd);
    RpWindow w = new RpWindow();
    w.Handle = hWnd.ToInt64();
    w.Title = Title(hWnd);
    w.Maximized = IsZoomed(hWnd);
    w.DpiAware = dpiAware;
    w.Passes = passes;
    w.X = frame.Left;
    w.Y = frame.Top;
    w.Width = frame.Right - frame.Left;
    w.Height = frame.Bottom - frame.Top;
    return w;
  }

  public static RpWindow Inspect(long handle, string title) {
    bool dpiAware = PerMonitorDpi();
    return Describe(Resolve(handle, title), dpiAware, 0);
  }

  // Never activates the window, so focus and the current desktop stay where the user left them.
  public static RpWindow Place(long handle, string title, int x, int y, int width, int height) {
    bool dpiAware = PerMonitorDpi();
    IntPtr hWnd = Resolve(handle, title);
    // A minimized window that was maximized comes back maximized, hence two tries.
    for (int i = 0; i < 2 && (IsZoomed(hWnd) || IsIconic(hWnd)); i++) {
      ShowWindow(hWnd, SW_SHOWNOACTIVATE);
      Thread.Sleep(100);
    }
    int passes = 0;
    while (passes < 3) {
      passes++;
      RECT outer;
      GetWindowRect(hWnd, out outer);
      RECT frame = Frame(hWnd);
      int left = frame.Left - outer.Left;
      int top = frame.Top - outer.Top;
      int right = outer.Right - frame.Right;
      int bottom = outer.Bottom - frame.Bottom;
      SetWindowPos(hWnd, IntPtr.Zero, x - left, y - top, width + left + right, height + top + bottom,
        SWP_NOZORDER_NOACTIVATE_NOOWNERZORDER);
      // Crossing to a monitor with another DPI makes Chromium resize itself, so check and repeat.
      Thread.Sleep(80);
      frame = Frame(hWnd);
      if (frame.Left == x && frame.Top == y && frame.Right - frame.Left == width && frame.Bottom - frame.Top == height) break;
    }
    return Describe(hWnd, dpiAware, passes);
  }
}
'@
  $req = $env:REPROMPTY_LAYOUT_REQUEST | ConvertFrom-Json
  switch ($req.action) {
    'monitors' { $out = @{ ok = $true; monitors = @([RpLayout]::Monitors()) } }
    'inspect' { $out = @{ ok = $true; window = [RpLayout]::Inspect([long]$req.handle, [string]$req.title) } }
    'place' {
      $window = [RpLayout]::Place([long]$req.handle, [string]$req.title, [int]$req.x, [int]$req.y, [int]$req.width, [int]$req.height)
      $out = @{ ok = $true; window = $window }
    }
    default { throw ('Unknown layout action: ' + $req.action) }
  }
} catch {
  $out = @{ ok = $false; error = $_.Exception.GetBaseException().Message }
}
$out | ConvertTo-Json -Depth 4 -Compress
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Monitors from the PowerShell output: an array, one object, or 5.1's {"value": [...], "Count": n}. */
export function toLayoutMonitors(raw: unknown): Monitor[] {
  const list = isRecord(raw) && Array.isArray(raw.value) ? raw.value : raw;
  const items = Array.isArray(list) ? list : list == null ? [] : [list];
  const monitors: Monitor[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const x = finiteNumber(item.X);
    const y = finiteNumber(item.Y);
    const width = finiteNumber(item.Width);
    const height = finiteNumber(item.Height);
    if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) continue;

    const name = String(item.Name ?? "").replace(/^\\\\\.\\/, "") || `DISPLAY${monitors.length + 1}`;
    const monitor: Monitor = { name, x, y, width, height, primary: item.Primary === true };
    const workX = finiteNumber(item.WorkX);
    const workY = finiteNumber(item.WorkY);
    const workWidth = finiteNumber(item.WorkWidth);
    const workHeight = finiteNumber(item.WorkHeight);
    if (workX !== null && workY !== null && workWidth !== null && workHeight !== null && workWidth > 0 && workHeight > 0) {
      monitor.work = { x: workX, y: workY, width: workWidth, height: workHeight };
    }
    monitors.push(monitor);
  }
  return monitors;
}

function toWindowFrame(raw: unknown): WindowFrame {
  const window = isRecord(raw) ? raw : {};
  const handle = finiteNumber(window.Handle);
  const x = finiteNumber(window.X);
  const y = finiteNumber(window.Y);
  const width = finiteNumber(window.Width);
  const height = finiteNumber(window.Height);
  if (handle === null || x === null || y === null || width === null || height === null) {
    throw new Error("Windows layout returned no window");
  }
  return {
    handle,
    title: typeof window.Title === "string" ? window.Title : "",
    maximized: window.Maximized === true,
    dpiAware: window.DpiAware === true,
    passes: finiteNumber(window.Passes) ?? 0,
    x,
    y,
    width,
    height,
  };
}

function layoutTempDir(): string {
  const systemTemp = path.join(process.env.SystemRoot || "C:\\Windows", "Temp").toLowerCase();
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp") : undefined,
    process.env.TEMP,
    process.env.TMP,
    os.tmpdir(),
  ];
  for (const dir of candidates) {
    // Windows' own Temp passes the access check but is admin-only.
    if (!dir || dir.toLowerCase() === systemTemp) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // Try the next one
    }
  }
  return os.tmpdir();
}

let lastStamp = 0;

async function runLayoutScript(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (process.platform !== "win32") {
    throw new Error("Native layouts only run on Windows");
  }
  const tempDir = layoutTempDir();
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  const ps1Path = path.join(tempDir, `reprompty-layout-${process.pid}-${lastStamp}.ps1`);
  fs.writeFileSync(ps1Path, WINDOWS_LAYOUT_SCRIPT.replace(/\r?\n/g, "\r\n"), "utf-8");

  try {
    const { error, stdout, stderr } = await new Promise<{
      error: (Error & { killed?: boolean; code?: unknown }) | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1Path],
        {
          windowsHide: true,
          timeout: RUN_TIMEOUT_MS,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          // Add-Type compiles in TEMP, which must be writable.
          env: { ...process.env, TEMP: tempDir, TMP: tempDir, REPROMPTY_LAYOUT_REQUEST: JSON.stringify(request) },
        },
        (err, out, errOut) => resolve({ error: err, stdout: String(out ?? ""), stderr: String(errOut ?? "") })
      );
    });

    const lastLine = stdout
      .split(/\r?\n/)
      .map((line) => line.replace(/^\uFEFF/, "").trim())
      .filter(Boolean)
      .pop();
    let reply: unknown = null;
    try {
      reply = lastLine ? JSON.parse(lastLine) : null;
    } catch {
      reply = null;
    }

    if (!isRecord(reply)) {
      if (error?.killed) throw new Error(`Windows layout timed out after ${RUN_TIMEOUT_MS / 1000} s`);
      const detail = stderr.trim() || lastLine || error?.message || "no output";
      throw new Error(`Windows layout failed: ${detail}`);
    }
    if (reply.ok !== true) {
      throw new Error(typeof reply.error === "string" && reply.error ? reply.error : "Windows layout failed");
    }
    return reply;
  } finally {
    try {
      fs.unlinkSync(ps1Path);
    } catch {
      // Already gone
    }
  }
}

function targetRequest(target: WindowTarget): { handle: number; title: string } {
  const handle = typeof target.handle === "number" && Number.isFinite(target.handle) && target.handle > 0 ? target.handle : 0;
  return { handle, title: target.title ?? "" };
}

/** Monitors in physical pixels, work areas included. */
export async function listMonitors(): Promise<Monitor[]> {
  const reply = await runLayoutScript({ action: "monitors" });
  return toLayoutMonitors(reply.monitors);
}

/**
 * Moves a VS Code window so its visible frame is exactly rect, without activating it.
 * With no handle or title: the focused VS Code window, else the most recent one on this desktop.
 */
export async function placeWindow(target: WindowTarget, rect: Rect): Promise<WindowFrame> {
  const values = [rect.x, rect.y, rect.width, rect.height].map(Math.round);
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) {
    throw new Error(`Invalid window rectangle: ${JSON.stringify(rect)}`);
  }
  const [x, y, width, height] = values;
  const reply = await runLayoutScript({ action: "place", ...targetRequest(target), x, y, width, height });
  return toWindowFrame(reply.window);
}

export async function getWindowFrame(target: WindowTarget): Promise<WindowFrame> {
  const reply = await runLayoutScript({ action: "inspect", ...targetRequest(target) });
  return toWindowFrame(reply.window);
}
