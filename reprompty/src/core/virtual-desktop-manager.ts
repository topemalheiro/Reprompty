import { execFileSync } from "node:child_process";
import fs from "node:fs";
import nodePath from "node:path";

export interface VirtualDesktopInfo {
  index: number;
  name: string;
  isCurrent: boolean;
}

export interface WindowDesktopInfo {
  handle: number;
  desktop: string;
  isCurrentDesktop: boolean;
}

interface RawVirtualDesktop {
  index?: unknown;
  Number?: unknown;
  name?: unknown;
  Name?: unknown;
  isCurrent?: unknown;
  Visible?: unknown;
}

interface RawWindowDesktopInfo {
  handle?: unknown;
  desktop?: unknown;
  isCurrentDesktop?: unknown;
}

function getWritableTempDir(): string {
  const windowsRoot = process.env.SystemRoot || "C:\\Windows";
  const windowsTemp = nodePath.join(windowsRoot, "Temp").toLowerCase();
  const candidates = [
    process.env.LOCALAPPDATA
      ? nodePath.join(process.env.LOCALAPPDATA, "Temp")
      : undefined,
    process.env.USERPROFILE
      ? nodePath.join(process.env.USERPROFILE, "AppData", "Local", "Temp")
      : undefined,
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

function normalizeArray<T>(value: unknown): T[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  return Array.isArray(value) ? (value as T[]) : [value as T];
}

function coerceDesktopName(name: unknown, fallbackIndex: number): string {
  if (typeof name === "string" && name.trim()) {
    return name.trim();
  }

  return String(fallbackIndex + 1);
}

function normalizeDesktopLookupName(name?: string | null): string {
  return (name ?? "").trim().toLowerCase();
}

function runVirtualDesktopJson(scriptBody: string): unknown {
  const tempDir = getWritableTempDir();
  const tempDirEscaped = tempDir.replace(/'/g, "''");
  const ps1Path = nodePath.join(
    tempDir,
    `reprompty-vdesktop-${process.pid}-${Date.now()}.ps1`
  );
  const script = `
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$env:TEMP = '${tempDirEscaped}'
$env:TMP = '${tempDirEscaped}'
Import-Module VirtualDesktop -DisableNameChecking -ErrorAction Stop | Out-Null
${scriptBody}
`;

  fs.writeFileSync(ps1Path, script, "utf-8");

  try {
    const raw = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ps1Path,
      ],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).trim();

    if (!raw) {
      return [];
    }

    return JSON.parse(raw);
  } catch (error: any) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    const message = stderr || stdout || error?.message || String(error);
    throw new Error(message);
  } finally {
    try {
      fs.unlinkSync(ps1Path);
    } catch {
      // Ignore temp file cleanup failures
    }
  }
}

export function normalizeVirtualDesktopList(value: unknown): VirtualDesktopInfo[] {
  return normalizeArray<RawVirtualDesktop>(value)
    .map((desktop) => {
      const rawIndex =
        typeof desktop.index === "number"
          ? desktop.index
          : typeof desktop.Number === "number"
          ? desktop.Number
          : Number.parseInt(String(desktop.index ?? desktop.Number ?? ""), 10);

      if (!Number.isFinite(rawIndex)) {
        return null;
      }

      return {
        index: rawIndex,
        name: coerceDesktopName(desktop.name ?? desktop.Name, rawIndex),
        isCurrent: Boolean(desktop.isCurrent ?? desktop.Visible),
      };
    })
    .filter((desktop): desktop is VirtualDesktopInfo => Boolean(desktop))
    .sort((left, right) => left.index - right.index);
}

export function resolveVirtualDesktopByName(
  desktops: VirtualDesktopInfo[],
  requestedName: string
): { desktop?: VirtualDesktopInfo; error?: string } {
  const normalizedName = normalizeDesktopLookupName(requestedName);
  if (!normalizedName) {
    return { error: "Desktop name is required" };
  }

  const matches = desktops.filter(
    (desktop) => normalizeDesktopLookupName(desktop.name) === normalizedName
  );

  if (matches.length === 1) {
    return { desktop: matches[0] };
  }

  if (matches.length > 1) {
    return {
      error: `Desktop "${requestedName}" matched multiple desktops`,
    };
  }

  const available = desktops.map((desktop) => desktop.name).join(", ");
  return {
    error: available
      ? `Desktop "${requestedName}" not found. Available: ${available}`
      : `Desktop "${requestedName}" not found`,
  };
}

export async function listVirtualDesktops(): Promise<VirtualDesktopInfo[]> {
  const result = runVirtualDesktopJson(`
$desktops = Get-DesktopList | ForEach-Object {
  [pscustomobject]@{
    index = [int]$_.Number
    name = if ([string]::IsNullOrWhiteSpace($_.Name)) { [string]([int]$_.Number + 1) } else { [string]$_.Name }
    isCurrent = [bool]$_.Visible
  }
}
$desktops | ConvertTo-Json -Compress
`);

  return normalizeVirtualDesktopList(result);
}

export async function switchToVirtualDesktop(
  requestedName: string
): Promise<{ success: boolean; desktop?: VirtualDesktopInfo; error?: string }> {
  try {
    const desktops = await listVirtualDesktops();
    const resolved = resolveVirtualDesktopByName(desktops, requestedName);
    if (!resolved.desktop) {
      return { success: false, error: resolved.error };
    }

    if (resolved.desktop.isCurrent) {
      return { success: true, desktop: resolved.desktop };
    }

    runVirtualDesktopJson(`
$desktop = Get-Desktop -Index ${resolved.desktop.index}
Switch-Desktop -Desktop $desktop -NoAnimation
Start-Sleep -Milliseconds 250
[pscustomobject]@{ success = $true } | ConvertTo-Json -Compress
`);

    const refreshedDesktops = await listVirtualDesktops();
    const refreshed = resolveVirtualDesktopByName(
      refreshedDesktops,
      requestedName
    );

    return {
      success: true,
      desktop: refreshed.desktop ?? resolved.desktop,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getWindowDesktopAssignments(
  handles: number[]
): Promise<WindowDesktopInfo[]> {
  const normalizedHandles = Array.from(
    new Set(
      handles.filter(
        (handle) => Number.isFinite(handle) && Number.isInteger(handle) && handle > 0
      )
    )
  );

  if (normalizedHandles.length === 0) {
    return [];
  }

  const result = runVirtualDesktopJson(`
$handles = @(${normalizedHandles.join(", ")})
$desktopList = Get-DesktopList
$results = foreach ($handle in $handles) {
  try {
    $desktop = Get-DesktopFromWindow -Hwnd ([IntPtr]$handle)
    if ($null -eq $desktop) {
      continue
    }

    $index = Get-DesktopIndex -Desktop $desktop
    $selected = $desktopList | Where-Object { [int]$_.Number -eq [int]$index } | Select-Object -First 1
    if ($null -eq $selected) {
      continue
    }

    [pscustomobject]@{
      handle = [int64]$handle
      desktop = if ([string]::IsNullOrWhiteSpace($selected.Name)) { [string]([int]$selected.Number + 1) } else { [string]$selected.Name }
      isCurrentDesktop = [bool]$selected.Visible
    }
  } catch {
    continue
  }
}
$results | ConvertTo-Json -Compress
`);

  return normalizeArray<RawWindowDesktopInfo>(result)
    .map((entry) => {
      const handle = Number.parseInt(String(entry.handle ?? ""), 10);
      const desktop =
        typeof entry.desktop === "string" ? entry.desktop.trim() : "";

      if (!Number.isFinite(handle) || !desktop) {
        return null;
      }

      return {
        handle,
        desktop,
        isCurrentDesktop: Boolean(entry.isCurrentDesktop),
      };
    })
    .filter((entry): entry is WindowDesktopInfo => Boolean(entry));
}
