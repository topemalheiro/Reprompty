import { spawn } from "node:child_process";
import { join } from "node:path";
import { execSync } from "node:child_process";

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
            $pid = 0
            [WindowInfo]::GetWindowThreadProcessId($hWnd, [ref]$pid) | Out-Null
            Write-Output "$pid|$title"
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
