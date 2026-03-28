import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import nodePath from "node:path";

export interface WindowInfo {
  pid: number;
  title: string;
  socketPath: string;
}

/**
 * Spawn a new VS Code window using the CLI
 */
export async function spawnWindow(
  folderPath: string,
  windowName?: string
): Promise<{ success: boolean; pid?: number; message: string }> {
  try {
    // Use VS Code CLI to open a new window
    const args = ["--folder-uri", folderPath];
    
    if (windowName) {
      // Try to set window title (not directly supported, but we can try)
    }

    const proc = spawn("code", args, {
      detached: true,
      stdio: "ignore",
    });

    proc.unref();

    return {
      success: true,
      pid: proc.pid,
      message: `Spawned VS Code window for ${folderPath}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to spawn window: ${error}`,
    };
  }
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
  return `\\\\.\\pipe\\kilo-ipc-${process.pid}`;
}

/**
 * List all VS Code / Kilo Code windows
 */
export function listWindows(): WindowInfo[] {
  const windows: WindowInfo[] = [];

  try {
    // Get all processes named "Code" or "kilocode"
    const result = execSync(
      'powershell -Command "Get-Process -Name Code,kilocode -ErrorAction SilentlyContinue | Select-Object Id,ProcessName | ConvertTo-Json"',
      { encoding: "utf-8" }
    );

    const processes = JSON.parse(result || "[]");
    const procs = Array.isArray(processes) ? processes : [processes];

    for (const proc of procs) {
      windows.push({
        pid: proc.Id,
        title: proc.ProcessName,
        socketPath: `\\\\.\\pipe\\kilo-ipc-${proc.Id}`,
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
    // Write message to a temp file to avoid quoting issues
    const tempDir = process.env.TEMP || process.env.TMP || ".";
    const tempFile = nodePath.join(tempDir, `reprompty-msg-${Date.now()}.txt`);
    fs.writeFileSync(tempFile, message, "utf-8");

    const script = `
      $Handle = ${windowHandle}
      $MessageFile = '${tempFile.replace(/'/g, "''")}'
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

    const result = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"').replace(/\n/g, " ")}"`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();

    return result === "sent";
  } catch (err) {
    console.error("[sendMessageForeground] Error:", err);
    return false;
  }
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
  extension: "kilo-code" | "claude-code" | "unknown";
  pipePath: string | null;
  sendMethod: "background" | "foreground";
}

/**
 * Auto-detect all VS Code / Kilo Code windows with their capabilities.
 * Enumerates windows via Win32 API, extracts folder from title, probes for IPC pipes.
 * Uses a temp .ps1 file to avoid cmd.exe escaping issues with $ variables.
 */
export function detectWindows(): DetectedWindow[] {
  try {
    const tempDir = process.env.TEMP || process.env.TMP || ".";
    const ps1File = nodePath.join(tempDir, "reprompty-detect.ps1");

    const script = `
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
  if ($title -like "*Visual Studio Code*" -or $title -like "*Kilo Code*") {
    $wpid = [uint32]0
    [WinDetect]::GetWindowThreadProcessId($hWnd, [ref]$wpid) | Out-Null
    $handleInt = $hWnd.ToInt64()
    $script:results.Add("$handleInt|$wpid|$title") | Out-Null
  }
  return $true
}
[void][WinDetect]::EnumWindows($callback, [IntPtr]::Zero)
$results | ForEach-Object { Write-Output $_ }
`;

    fs.writeFileSync(ps1File, script, "utf-8");

    const raw = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1File}"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();

    if (!raw) return [];

    const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l && l !== "True" && l.includes("|"));
    const seen = new Set<number>();
    const results: DetectedWindow[] = [];

    for (const line of lines) {
      const parts = line.split("|");
      if (parts.length < 3) continue;

      const handle = parseInt(parts[0], 10);
      const pid = parseInt(parts[1], 10);
      const title = parts.slice(2).join("|");

      // Deduplicate by PID (multiple windows from same process)
      if (seen.has(pid)) continue;
      seen.add(pid);

      // Extract folder from title: "folder - Visual Studio Code" or "folder - Kilo Code"
      const titleMatch = title.match(/^(.+?)\s+-\s+(Visual Studio Code|Kilo Code)/);
      const folderPath = titleMatch ? titleMatch[1].trim() : "";
      const isKilo = title.includes("Kilo Code");
      const processName = isKilo ? "kilocode" : "Code";

      // Probe for IPC pipe
      const pipePath = `\\\\.\\pipe\\kilo-ipc-${pid}`;
      let pipeExists = false;
      try {
        // Check if pipe exists by trying to stat it
        fs.accessSync(pipePath);
        pipeExists = true;
      } catch {
        // Pipe doesn't exist or not accessible
      }

      const extension: DetectedWindow["extension"] = pipeExists
        ? "kilo-code"
        : isKilo
        ? "kilo-code"
        : "claude-code";

      const sendMethod: DetectedWindow["sendMethod"] =
        pipeExists ? "background" : "foreground";

      results.push({
        pid,
        handle,
        title,
        folderPath,
        processName,
        extension,
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

/**
 * Get the CDP (Chrome DevTools Protocol) port from VS Code's DevToolsActivePort file.
 * Returns null if not available.
 */
export function getCdpPort(): number | null {
  try {
    const appData = process.env.APPDATA;
    if (!appData) return null;

    const portFile = nodePath.join(appData, "Code", "DevToolsActivePort");
    if (!fs.existsSync(portFile)) return null;

    const content = fs.readFileSync(portFile, "utf-8").trim();
    const port = parseInt(content.split("\n")[0], 10);
    return isNaN(port) ? null : port;
  } catch {
    return null;
  }
}
