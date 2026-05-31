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

export interface VirtualDesktopMutationResult {
  success: boolean;
  desktop?: VirtualDesktopInfo;
  error?: string;
}

export interface EnsureVirtualDesktopResult extends VirtualDesktopMutationResult {
  created: boolean;
}

export interface MoveWindowToVirtualDesktopResult
  extends VirtualDesktopMutationResult {
  handle?: number;
  isCurrentDesktop?: boolean;
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

function escapePowerShellSingleQuotes(value: string): string {
  return value.replace(/'/g, "''");
}

export function deriveVirtualDesktopName(
  preferredLabel?: string | null,
  folderPath?: string | null
): string | undefined {
  const trimmedLabel = (preferredLabel ?? "").trim();
  if (trimmedLabel) {
    return trimmedLabel;
  }

  const trimmedPath = (folderPath ?? "").trim();
  if (!trimmedPath) {
    return undefined;
  }

  const normalizedPath = trimmedPath.replace(/[\\/]+$/, "");
  const folderName =
    nodePath.win32.basename(normalizedPath) ||
    nodePath.posix.basename(normalizedPath);
  const trimmedFolderName = folderName.trim();
  return trimmedFolderName || undefined;
}

export function makeUniqueVirtualDesktopName(
  desktops: VirtualDesktopInfo[],
  requestedName: string
): string {
  const baseName = requestedName.trim();
  if (!baseName) {
    throw new Error("Desktop name is required");
  }

  const existingNames = new Set(
    desktops.map((desktop) => normalizeDesktopLookupName(desktop.name))
  );
  if (!existingNames.has(normalizeDesktopLookupName(baseName))) {
    return baseName;
  }

  let suffix = 2;
  while (
    existingNames.has(normalizeDesktopLookupName(`${baseName} ${suffix}`))
  ) {
    suffix += 1;
  }

  return `${baseName} ${suffix}`;
}

export function planEnsureVirtualDesktop(
  desktops: VirtualDesktopInfo[],
  requestedName: string
): { existingDesktop?: VirtualDesktopInfo; shouldCreate: boolean; error?: string } {
  const normalizedName = normalizeDesktopLookupName(requestedName);
  if (!normalizedName) {
    return { shouldCreate: false, error: "Desktop name is required" };
  }

  const matches = desktops.filter(
    (desktop) => normalizeDesktopLookupName(desktop.name) === normalizedName
  );

  if (matches.length === 1) {
    return { existingDesktop: matches[0], shouldCreate: false };
  }

  if (matches.length > 1) {
    return {
      shouldCreate: false,
      error: `Desktop "${requestedName}" matched multiple desktops`,
    };
  }

  return { shouldCreate: true };
}

export function validateVirtualDesktopRename(
  desktops: VirtualDesktopInfo[],
  currentName: string,
  newName: string
): {
  currentDesktop?: VirtualDesktopInfo;
  normalizedNewName?: string;
  noChange?: boolean;
  error?: string;
} {
  const currentResolution = resolveVirtualDesktopByName(desktops, currentName);
  if (!currentResolution.desktop) {
    return { error: currentResolution.error };
  }

  const normalizedNewName = newName.trim();
  if (!normalizedNewName) {
    return { error: "New desktop name is required" };
  }

  const currentNormalizedName = normalizeDesktopLookupName(
    currentResolution.desktop.name
  );
  const nextNormalizedName = normalizeDesktopLookupName(normalizedNewName);
  if (currentNormalizedName === nextNormalizedName) {
    return {
      currentDesktop: currentResolution.desktop,
      normalizedNewName,
      noChange: true,
    };
  }

  const destinationMatches = desktops.filter(
    (desktop) => normalizeDesktopLookupName(desktop.name) === nextNormalizedName
  );
  if (destinationMatches.length > 0) {
    return { error: `Desktop "${normalizedNewName}" already exists` };
  }

  return {
    currentDesktop: currentResolution.desktop,
    normalizedNewName,
  };
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

export async function createVirtualDesktop(
  name?: string
): Promise<VirtualDesktopMutationResult> {
  try {
    const requestedName = name?.trim();
    if (name !== undefined && !requestedName) {
      return { success: false, error: "Desktop name is required" };
    }

    runVirtualDesktopJson(`
$newDesktop = New-Desktop
if ('${escapePowerShellSingleQuotes(requestedName ?? "")}' -ne '') {
  $newDesktop = Set-DesktopName -Desktop $newDesktop -Name '${escapePowerShellSingleQuotes(
    requestedName ?? ""
  )}' -PassThru
}
Start-Sleep -Milliseconds 250
[pscustomobject]@{ success = $true } | ConvertTo-Json -Compress
`);

    const desktops = await listVirtualDesktops();
    const createdDesktop = requestedName
      ? resolveVirtualDesktopByName(desktops, requestedName).desktop
      : [...desktops].sort((left, right) => right.index - left.index)[0];

    if (!createdDesktop) {
      return {
        success: false,
        error: requestedName
          ? `Created desktop "${requestedName}" could not be resolved`
          : "Created desktop could not be resolved",
      };
    }

    return { success: true, desktop: createdDesktop };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function ensureVirtualDesktop(
  requestedName: string
): Promise<EnsureVirtualDesktopResult> {
  try {
    const desktops = await listVirtualDesktops();
    const plan = planEnsureVirtualDesktop(desktops, requestedName);

    if (plan.error) {
      return { success: false, created: false, error: plan.error };
    }

    if (plan.existingDesktop) {
      return {
        success: true,
        created: false,
        desktop: plan.existingDesktop,
      };
    }

    const created = await createVirtualDesktop(requestedName);
    return {
      ...created,
      created: created.success,
    };
  } catch (error) {
    return {
      success: false,
      created: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function renameVirtualDesktop(
  currentName: string,
  newName: string
): Promise<VirtualDesktopMutationResult> {
  try {
    const desktops = await listVirtualDesktops();
    const validation = validateVirtualDesktopRename(
      desktops,
      currentName,
      newName
    );

    if (validation.error) {
      return { success: false, error: validation.error };
    }

    if (!validation.currentDesktop || !validation.normalizedNewName) {
      return { success: false, error: "Desktop rename could not be prepared" };
    }

    if (validation.noChange) {
      return {
        success: true,
        desktop: {
          ...validation.currentDesktop,
          name: validation.normalizedNewName,
        },
      };
    }

    runVirtualDesktopJson(`
$desktop = Get-Desktop -Index ${validation.currentDesktop.index}
Set-DesktopName -Desktop $desktop -Name '${escapePowerShellSingleQuotes(
      validation.normalizedNewName
    )}' | Out-Null
Start-Sleep -Milliseconds 250
[pscustomobject]@{ success = $true } | ConvertTo-Json -Compress
`);

    const refreshedDesktops = await listVirtualDesktops();
    const refreshed = resolveVirtualDesktopByName(
      refreshedDesktops,
      validation.normalizedNewName
    );
    if (!refreshed.desktop) {
      return {
        success: false,
        error:
          refreshed.error ||
          `Renamed desktop "${validation.normalizedNewName}" could not be resolved`,
      };
    }

    return {
      success: true,
      desktop: refreshed.desktop,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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

export async function moveWindowToVirtualDesktop(
  windowHandle: number,
  requestedName: string
): Promise<MoveWindowToVirtualDesktopResult> {
  try {
    if (!Number.isFinite(windowHandle) || !Number.isInteger(windowHandle) || windowHandle <= 0) {
      return { success: false, error: "Window handle must be a positive integer" };
    }

    const desktops = await listVirtualDesktops();
    const resolved = resolveVirtualDesktopByName(desktops, requestedName);
    if (!resolved.desktop) {
      return {
        success: false,
        handle: windowHandle,
        error: resolved.error,
      };
    }

    runVirtualDesktopJson(`
$desktop = Get-Desktop -Index ${resolved.desktop.index}
Move-Window -Desktop $desktop -Hwnd ([IntPtr]${windowHandle}) | Out-Null
Start-Sleep -Milliseconds 250
[pscustomobject]@{ success = $true } | ConvertTo-Json -Compress
`);

    const refreshedDesktops = await listVirtualDesktops();
    const refreshedDesktop =
      resolveVirtualDesktopByName(refreshedDesktops, requestedName).desktop ??
      resolved.desktop;
    const assignments = await getWindowDesktopAssignments([windowHandle]);
    const assignment = assignments.find((entry) => entry.handle === windowHandle);

    return {
      success: true,
      handle: windowHandle,
      desktop: refreshedDesktop,
      isCurrentDesktop:
        assignment?.isCurrentDesktop ?? refreshedDesktop?.isCurrent ?? false,
    };
  } catch (error) {
    return {
      success: false,
      handle: windowHandle,
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
