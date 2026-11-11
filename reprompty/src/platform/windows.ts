import { execSync } from "node:child_process";
import fs from "node:fs";
import nodePath from "node:path";
import {
  findWindowAgentState,
  getWindowAgentStates,
  type AgentKind,
} from "../core/cdp-client.js";
import {
  getWindowDesktopAssignments,
} from "../core/virtual-desktop-manager.js";
import {
  EDITOR_TITLE_SUFFIXES,
  workspaceNameFromTitle,
} from "../core/editor-titles.js";
import { findFolderByName } from "../core/folder-lookup.js";
import { readSettings } from "../core/settings.js";
import { getCdpPort } from "../core/vscode-paths.js";
import { findExecutable } from "../core/which.js";

export { getCdpPort };

export interface WindowInfo {
  pid: number;
  title: string;
  socketPath: string;
  processName?: string;
}

const VS_CODE_PROCESS_NAMES = new Set(["code", "code.real", "code - insiders", "vscodium"]);
const KILO_CODE_PROCESS_NAMES = new Set(["kilocode"]);
const KIMI_CODE_PROCESS_NAMES = new Set(["kimi-code"]);
const SUPPORTED_EDITOR_PROCESS_NAMES = new Set([
  ...VS_CODE_PROCESS_NAMES,
  ...KILO_CODE_PROCESS_NAMES,
  ...KIMI_CODE_PROCESS_NAMES,
]);
const KILO_PIPE_PREFIXES = ["kilo-ipc-", "kilo-code-", "roo-code-"];

function getWritableTempDir(): string {
  const windowsRoot = process.env.SystemRoot || "C:\\Windows";
  const windowsTemp = nodePath.join(windowsRoot, "Temp").toLowerCase();
  const candidates = [
    process.env.LOCALAPPDATA ? nodePath.join(process.env.LOCALAPPDATA, "Temp") : undefined,
    process.env.USERPROFILE ? nodePath.join(process.env.USERPROFILE, "AppData", "Local", "Temp") : undefined,
    process.env.TEMP,
    process.env.TMP,
    ".",
  ].filter((value): value is string => Boolean(value));

  for (const dir of candidates) {
    try {
      if (dir.toLowerCase() === windowsTemp) {
        continue;
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // Try next candidate
    }
  }

  return ".";
}

export function normalizeEditorProcessName(name?: string | null): string {
  return (name ?? "").trim().replace(/\.exe$/i, "").toLowerCase();
}

export function isSupportedEditorProcessName(name?: string | null): boolean {
  const normalizedName = normalizeEditorProcessName(name);
  return SUPPORTED_EDITOR_PROCESS_NAMES.has(normalizedName);
}

export function fallbackProcessNameFromTitle(title: string): string {
  if (title.includes("Kimi Code")) return "kimi-code";
  if (title.includes("Kilo Code")) return "kilocode";
  return "Code";
}

export function buildKiloPipeCandidates(pid: number): string[] {
  return KILO_PIPE_PREFIXES.map((prefix) => `\\\\.\\pipe\\${prefix}${pid}`);
}

function findLegacyKiloPipeFallback(): string | null {
  try {
    const names = fs
      .readdirSync("\\\\.\\pipe\\")
      .filter((name) =>
        KILO_PIPE_PREFIXES.some((prefix) => name.toLowerCase().startsWith(prefix))
      );
    if (names.length === 1) {
      return `\\\\.\\pipe\\${names[0]}`;
    }
  } catch {
    // Ignore pipe enumeration failures
  }
  return null;
}

export function resolveKiloPipePath(pid: number): string | null {
  const candidates = buildKiloPipeCandidates(pid);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch {
      // Try next candidate
    }
  }

  return findLegacyKiloPipeFallback();
}

export function resolveDetectedWindowProcessName(
  processName: string | null | undefined,
  title: string
): string {
  const trimmedProcessName = (processName ?? "").trim();
  return trimmedProcessName || fallbackProcessNameFromTitle(title);
}

function escapePowerShellSingleQuotes(value: string): string {
  return value.replace(/'/g, "''");
}

// The BOM makes Windows PowerShell 5.1 read the script as UTF-8, not the ANSI code page.
function writePowerShellScript(file: string, script: string): void {
  fs.writeFileSync(file, `\uFEFF${script}`, "utf-8");
}

/** VS Code's code.cmd: PATH first, then the usual install folders. */
export function findCodeCmd(): string | null {
  const fromPath = findExecutable("code");
  if (fromPath) return fromPath;

  const env = process.env;
  const installs: Array<[string | undefined, ...string[]]> = [
    [env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "bin", "code.cmd"],
    [env.ProgramFiles, "Microsoft VS Code", "bin", "code.cmd"],
    [env.LOCALAPPDATA, "Programs", "Microsoft VS Code Insiders", "bin", "code-insiders.cmd"],
    [env.ProgramFiles, "Microsoft VS Code Insiders", "bin", "code-insiders.cmd"],
    [env.USERPROFILE, "scoop", "apps", "vscode", "current", "bin", "code.cmd"],
  ];
  for (const [base, ...rest] of installs) {
    if (!base) continue;
    const candidate = nodePath.join(base, ...rest);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Spawn a new VS Code window using the CLI
 */
export function spawnWindow(
  folderPath: string,
  _windowName?: string,
  _desktop?: string
): Promise<{ success: boolean; pid?: number; message: string; desktop?: string }> {
  return (async () => {
    try {
      const codePath = findCodeCmd();
      if (!codePath) {
        return {
          success: false,
          message: "code.cmd not found. Install VS Code or add its bin folder to PATH.",
        };
      }

      const port = readSettings().cdpPort ?? 9222;
      const result = execSync(
        `powershell.exe -NoProfile -Command "& '${escapePowerShellSingleQuotes(codePath)}' --remote-debugging-port=${port} -n '${escapePowerShellSingleQuotes(folderPath)}'"`,
        { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
      ).trim();

      return {
        success: true,
        message: `Spawned VS Code window for ${folderPath}${result ? ` (${result})` : ""}`,
      };
    } catch (error: any) {
      const stderr = error.stderr ? String(error.stderr).trim() : "";
      const msg = stderr || error.message || String(error);
      return {
        success: false,
        message: `Failed to spawn window: ${msg}`,
      };
    }
  })();
}

/**
 * Find a VS Code window by title
 * Returns the PID and socket path if found
 */
export function findWindowByTitle(windowTitle: string): WindowInfo | null {
  try {
    // Use PowerShell to get window info
    const script = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        using System.Text;
        using System.Collections.Generic;
        public class WindowInfo {
          [DllImport("user32.dll")]
          public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
          public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
          [DllImport("user32.dll")]
          public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
          [DllImport("user32.dll")]
          public static extern int GetWindowTextLength(IntPtr hWnd);
          [DllImport("user32.dll")]
          public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        }
"@
      $windows = @()
      $callback = [WindowInfo+EnumWindowsProc]{
        param($hWnd, $lParam)
        $length = [WindowInfo]::GetWindowTextLength($hWnd)
        if ($length -gt 0) {
          $sb = New-Object System.Text.StringBuilder($length + 1)
          [WindowInfo]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
          $title = $sb.ToString()
          if ($title -like "*${windowTitle}*") {
            $wpid = 0
            [WindowInfo]::GetWindowThreadProcessId($hWnd, [ref]$wpid) | Out-Null
            Write-Output "$wpid|$title"
          }
        }
        return $true
      }
      [WindowInfo]::EnumWindows($callback, [IntPtr]::Zero)
    `;

    const result = execSync(`powershell -Command "${script.replace(/"/g, '\\"').replace(/\n/g, " ")}"`, {
      encoding: "utf-8",
      windowsHide: true,
    }).trim();

    if (!result) return null;

    const [pidStr, title] = result.split("|");
    const pid = parseInt(pidStr, 10);

    // Generate socket path based on PID
    const socketPath = `\\\\.\\pipe\\kilo-ipc-${pid}`;

    return {
      pid,
      title,
      socketPath,
    };
  } catch (error) {
    console.error("Error finding window:", error);
    return null;
  }
}

/**
 * Get the default IPC socket path for Kilo Code
 */
export function getDefaultSocketPath(): string {
  return resolveKiloPipePath(process.pid) ?? `\\\\.\\pipe\\kilo-ipc-${process.pid}`;
}

/**
 * List all VS Code / Kilo Code windows
 */
export function listWindows(): WindowInfo[] {
  const windows: WindowInfo[] = [];

  try {
    // Get all supported editor processes.
    const result = execSync(
      'powershell -Command "Get-Process -Name Code,Code.real,kilocode -ErrorAction SilentlyContinue | Select-Object Id,ProcessName | ConvertTo-Json"',
      { encoding: "utf-8", windowsHide: true }
    );

    const processes = JSON.parse(result || "[]");
    const procs = Array.isArray(processes) ? processes : [processes];

    for (const proc of procs) {
      if (!isSupportedEditorProcessName(proc.ProcessName)) {
        continue;
      }

      windows.push({
        pid: proc.Id,
        title: proc.ProcessName,
        socketPath: resolveKiloPipePath(proc.Id) ?? `\\\\.\\pipe\\kilo-ipc-${proc.Id}`,
        processName: proc.ProcessName,
      });
    }
  } catch {
    // No processes found
  }

  return windows;
}

/**
 * Send a message to a window via foreground clipboard+SendKeys (fallback method).
 * Uses PowerShell Win32 APIs to focus the window, paste, and press Enter.
 */
export async function sendMessageForeground(
  windowHandle: number,
  message: string
): Promise<boolean> {
  try {
    const tempDir = getWritableTempDir();
    const msgFile = nodePath.join(tempDir, `reprompty-msg-${Date.now()}.txt`);
    const ps1File = nodePath.join(tempDir, `reprompty-send-${Date.now()}.ps1`);
    const tempDirEscaped = tempDir.replace(/\\/g, "\\\\").replace(/'/g, "''");
    fs.writeFileSync(msgFile, message, "utf-8");

    const script = `
$env:TEMP = '${tempDirEscaped}'
$env:TMP = '${tempDirEscaped}'
$Handle = ${windowHandle}
$MessageFile = '${msgFile.replace(/\\/g, "\\\\").replace(/'/g, "''")}'
$Message = Get-Content -Path $MessageFile -Raw -Encoding UTF8
Remove-Item -Path $MessageFile -Force -ErrorAction SilentlyContinue

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Send {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
}
"@

if (-not [Win32Send]::IsWindow([IntPtr]$Handle)) {
  Write-Error "Invalid window handle"
  exit 1
}

$original = [Win32Send]::GetForegroundWindow()
Set-Clipboard -Value $Message
[Win32Send]::SetForegroundWindow([IntPtr]$Handle) | Out-Null
Start-Sleep -Milliseconds 150

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 50

if ($original -ne [IntPtr]::Zero -and $original -ne [IntPtr]$Handle) {
  Start-Sleep -Milliseconds 100
  [Win32Send]::SetForegroundWindow($original) | Out-Null
}

Write-Output "sent"
`;

    writePowerShellScript(ps1File, script);

    const result = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1File}"`,
      { encoding: "utf-8", timeout: 10000, windowsHide: true }
    ).trim();

    // Clean up ps1 file
    try { fs.unlinkSync(ps1File); } catch { /* ignore */ }

    return result.includes("sent");
  } catch (err) {
    console.error("[sendMessageForeground] Error:", err);
    return false;
  }
}

/**
 * Stub for executeCommandForeground on Windows.
 * Not yet implemented — falls back to returning false.
 */
export async function executeCommandForeground(
  _windowHandle: number,
  _command: string
): Promise<boolean> {
  console.warn("[executeCommandForeground] Not implemented on Windows");
  return false;
}

/**
 * Resolve the folder of a VS Code window from the folder named in its title.
 */
export function getWorkspacePathFromPid(_pid: number, windowTitle?: string): string | null {
  const name = windowTitle ? workspaceNameFromTitle(windowTitle) : null;
  return name ? findFolderByName(name) : null;
}

// ============================================================================
// WINDOW AUTO-DETECTION
// ============================================================================

export interface DetectedWindow {
  pid: number;
  handle: number;
  title: string;
  folderPath: string;
  processName: string;
  desktop?: string;
  isCurrentDesktop?: boolean;
  extension: AgentKind;
  activeAgent: AgentKind;
  availableAgents: Array<Exclude<AgentKind, "unknown">>;
  backgroundRoute: "ipc-kilo" | "cdp-kilo" | "cdp-claude" | "cdp-codex" | "cdp-kimi" | "foreground";
  pipePath: string | null;
  sendMethod: "background" | "foreground";
  /** KDE Wayland kdotool UUID handle (if available) */
  kdotoolHandle?: string;
}

export function resolveBackgroundRoute(
  activeAgent: AgentKind,
  availableAgents: Array<Exclude<AgentKind, "unknown">>,
  pipeExists: boolean
): DetectedWindow["backgroundRoute"] {
  if (activeAgent === "kilo-code" && pipeExists) {
    return "ipc-kilo";
  }
  if (activeAgent === "kilo-code" && availableAgents.includes("kilo-code")) {
    return "cdp-kilo";
  }
  if (activeAgent === "kimi-code" && availableAgents.includes("kimi-code")) {
    return "cdp-kimi";
  }
  if (activeAgent === "codex" && availableAgents.includes("codex")) {
    return "cdp-codex";
  }
  if (activeAgent === "claude-code" && availableAgents.includes("claude-code")) {
    return "cdp-claude";
  }
  // When agent is unknown, prefer Kilo Code as the "start with" agent
  if (activeAgent === "unknown" && availableAgents.includes("kilo-code")) {
    return "cdp-kilo";
  }
  if (activeAgent === "unknown" && availableAgents.includes("kimi-code")) {
    return "cdp-kimi";
  }
  if (activeAgent === "unknown" && availableAgents.includes("codex")) {
    return "cdp-codex";
  }
  return "foreground";
}

/**
 * Auto-detect all VS Code / Kilo Code windows with their capabilities.
 * Enumerates windows via Win32 API, extracts folder from title, probes for IPC pipes.
 * Uses a temp .ps1 file to avoid cmd.exe escaping issues with $ variables.
 */
// options.force mirrors the Linux signature; there is no result cache here to bypass.
export async function detectWindows(_options: { force?: boolean } = {}): Promise<DetectedWindow[]> {
  try {
    const tempDir = getWritableTempDir();
    const ps1File = nodePath.join(tempDir, "reprompty-detect.ps1");
    const tempDirEscaped = tempDir.replace(/\\/g, "\\\\").replace(/'/g, "''");
    const titleFilter = EDITOR_TITLE_SUFFIXES.map((suffix) => `$title -like "*${suffix}*"`).join(" -or ");

    const script = `
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$env:TEMP = '${tempDirEscaped}'
$env:TMP = '${tempDirEscaped}'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinDetect {
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@
$results = [System.Collections.ArrayList]::new()
$callback = [WinDetect+EnumWindowsProc]{
  param($hWnd, $lParam)
  if (-not [WinDetect]::IsWindowVisible($hWnd)) { return $true }
  $length = [WinDetect]::GetWindowTextLength($hWnd)
  if ($length -le 0) { return $true }
  $sb = New-Object System.Text.StringBuilder($length + 1)
  [WinDetect]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
  $title = $sb.ToString()
  if (${titleFilter}) {
    $wpid = [uint32]0
    [WinDetect]::GetWindowThreadProcessId($hWnd, [ref]$wpid) | Out-Null
    $handleInt = $hWnd.ToInt64()
    $processName = ""
    try {
      $processName = (Get-Process -Id $wpid -ErrorAction Stop).ProcessName
    } catch {
      $processName = ""
    }
    $global:results.Add("$handleInt|$wpid|$processName|$title") | Out-Null
  }
  return $true
}
[void][WinDetect]::EnumWindows($callback, [IntPtr]::Zero)
$results | ForEach-Object { Write-Output $_ }
`;

    writePowerShellScript(ps1File, script);

    const raw = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1File}"`,
      { encoding: "utf-8", timeout: 10000, windowsHide: true }
    ).trim();

    if (!raw) return [];

    const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l && l !== "True" && l.includes("|"));
    const seen = new Set<number>();
    const results: DetectedWindow[] = [];
    const port = getCdpPort();
    const agentStates = port ? await getWindowAgentStates(port).catch(() => []) : [];
    const desktopAssignments = await getWindowDesktopAssignments(
      lines
        .map((line) => Number.parseInt(line.split("|")[0] ?? "", 10))
        .filter((handle) => Number.isFinite(handle) && handle > 0)
    ).catch(() => []);
    const desktopByHandle = new Map(
      desktopAssignments.map((assignment) => [assignment.handle, assignment])
    );

    for (const line of lines) {
      const parts = line.split("|");
      if (parts.length < 4) continue;

      const handle = parseInt(parts[0], 10);
      const pid = parseInt(parts[1], 10);
      const rawProcessName = parts[2].trim();
      const title = parts.slice(3).join("|");

      // Deduplicate by window handle (same PID can have multiple windows)
      if (seen.has(handle)) continue;
      seen.add(handle);

      if (rawProcessName && !isSupportedEditorProcessName(rawProcessName)) {
        continue;
      }

      // Extract folder from title: "folder - Visual Studio Code" or "folder - Kilo Code" or "folder - Kimi Code"
      const titleMatch = title.match(/^(.+?)\s+-\s+(Visual Studio Code|Kilo Code|Kimi Code|VSCodium|Code - OSS)/);
      const folderPath = titleMatch ? titleMatch[1].trim() : "";
      const processName = resolveDetectedWindowProcessName(rawProcessName, title);
      const normalizedProcessName = normalizeEditorProcessName(processName);
      const isKilo = normalizedProcessName === "kilocode" || title.includes("Kilo Code");
      const isKimi = title.includes("Kimi Code");

      // Probe for IPC pipe (supports Kilo and legacy Roo pipe naming)
      const pipePath = resolveKiloPipePath(pid);
      const pipeExists = Boolean(pipePath);

      const agentState = findWindowAgentState(agentStates, title);
      const activeAgent = agentState?.activeAgent ?? "unknown";
      const availableAgents = agentState?.availableAgents ?? [];
      const legacyExtension: DetectedWindow["extension"] = pipeExists
        ? "kilo-code"
        : isKilo
        ? "kilo-code"
        : isKimi
        ? "kimi-code"
        : "unknown";
      const backgroundRoute = resolveBackgroundRoute(
        activeAgent,
        availableAgents,
        pipeExists
      );
      const desktopAssignment = desktopByHandle.get(handle);
      const sendMethod: DetectedWindow["sendMethod"] =
        backgroundRoute === "foreground" ? "foreground" : "background";
      const extension: DetectedWindow["extension"] =
        activeAgent === "unknown" ? legacyExtension : activeAgent;

      results.push({
        pid,
        handle,
        title,
        folderPath,
        processName,
        desktop: desktopAssignment?.desktop,
        isCurrentDesktop: desktopAssignment?.isCurrentDesktop,
        extension,
        activeAgent,
        availableAgents,
        backgroundRoute,
        pipePath: pipeExists ? pipePath : null,
        sendMethod,
      });
    }

    return results;
  } catch (err) {
    console.error("[detectWindows] Error:", err);
    return [];
  }
}

export interface AllWindowInfo {
  handle: number;
  pid: number;
  title: string;
  processName: string;
}

/**
 * Detect ALL visible windows on the desktop (not just editors).
 */
export function detectAllWindows(): AllWindowInfo[] {
  const windows: AllWindowInfo[] = [];

  try {
    const tempDir = getWritableTempDir();
    const ps1File = nodePath.join(tempDir, "reprompty-detect-all.ps1");
    const tempDirEscaped = tempDir.replace(/\\/g, "\\\\").replace(/'/g, "''");

    const script = `
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$env:TEMP = '${tempDirEscaped}'
$env:TMP = '${tempDirEscaped}'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinDetectAll {
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@
$results = [System.Collections.ArrayList]::new()
$callback = [WinDetectAll+EnumWindowsProc]{
  param($hWnd, $lParam)
  if (-not [WinDetectAll]::IsWindowVisible($hWnd)) { return $true }
  $length = [WinDetectAll]::GetWindowTextLength($hWnd)
  if ($length -le 0) { return $true }
  $sb = New-Object System.Text.StringBuilder($length + 1)
  [WinDetectAll]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
  $title = $sb.ToString()
  $wpid = [uint32]0
  [WinDetectAll]::GetWindowThreadProcessId($hWnd, [ref]$wpid) | Out-Null
  $processName = ""
  try {
    $processName = (Get-Process -Id $wpid -ErrorAction Stop).ProcessName
  } catch {
    $processName = ""
  }
  $global:results.Add("$($hWnd.ToInt64())|$wpid|$processName|$title") | Out-Null
  return $true
}
[void][WinDetectAll]::EnumWindows($callback, [IntPtr]::Zero)
$results | ForEach-Object { Write-Output $_ }
`;

    writePowerShellScript(ps1File, script);

    const raw = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1File}"`,
      { encoding: "utf-8", timeout: 10000, windowsHide: true }
    ).trim();

    if (!raw) return [];

    const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l && l !== "True" && l.includes("|"));

    for (const line of lines) {
      const parts = line.split("|");
      if (parts.length < 4) continue;

      const handle = parseInt(parts[0], 10);
      const pid = parseInt(parts[1], 10);
      const processName = parts[2].trim();
      const title = parts.slice(3).join("|");

      if (!title.trim()) continue;

      windows.push({
        handle,
        pid,
        title,
        processName: processName || "unknown",
      });
    }
  } catch (err) {
    console.error("[detectAllWindows] Error:", err);
  }

  return windows;
}
