import { execFileSync, execSync } from "node:child_process";
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

function getSessionBusEnv(): Record<string, string> {
  const env = { ...process.env };
  if (!env.DBUS_SESSION_BUS_ADDRESS) {
    const uid = process.getuid?.() ?? 1000;
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${uid}/bus`;
  }
  return env;
}

function qdbus(args: string[]): string {
  const env = getSessionBusEnv();
  // Prefer qdbus6, fall back to qdbus
  const commands = ["qdbus6", "qdbus", "qdbus-qt5"];
  let lastError: Error | undefined;
  for (const cmd of commands) {
    try {
      return execFileSync(cmd, args, { encoding: "utf-8", env, timeout: 10000 }).trim();
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError ?? new Error("qdbus not available");
}

function parseDesktopsOutput(output: string): VirtualDesktopInfo[] {
  // qdbus --literal returns something like:
  // [Variant: [Argument: a(uss) {[Argument: (uss) 0, "id", "name"], ...}]]
  const desktops: VirtualDesktopInfo[] = [];

  // Try to extract tuples using regex
  const tupleRegex = /\[Argument:\s*\(uss\)\s*(\d+),\s*"([^"]+)",\s*"([^"]+)"\]/g;
  let match: RegExpExecArray | null;
  let currentId: string | null = null;

  // Also extract current desktop id
  const currentMatch = output.match(/current\s*[=:]\s*"([^"]+)"/);
  if (currentMatch) {
    currentId = currentMatch[1];
  }

  // Better approach: parse the literal output line by line
  const lines = output.split("\n");
  for (const line of lines) {
    const m = /\(uss\)\s*(\d+),\s*"([^"]+)",\s*"([^"]+)"/.exec(line);
    if (m) {
      const index = parseInt(m[1], 10);
      const id = m[2];
      const name = m[3];
      const isCurrent = currentId ? id === currentId : false;
      desktops.push({ index, name: name || String(index + 1), isCurrent });
    }
  }

  // If regex didn't work, try simpler parsing
  if (desktops.length === 0) {
    // Try using dbus-send for cleaner output
    try {
      const env = getSessionBusEnv();
      const dbusOutput = execSync(
        `dbus-send --session --dest=org.kde.KWin --type=method_call --print-reply /VirtualDesktopManager org.freedesktop.DBus.Properties.Get string:org.kde.KWin.VirtualDesktopManager string:desktops`,
        { encoding: "utf-8", env, timeout: 10000 }
      );
      // Parse dbus-send output
      const dbusLines = dbusOutput.split("\n");
      let inArray = false;
      let currentTuple: Partial<VirtualDesktopInfo> = {};
      for (const line of dbusLines) {
        const trimmed = line.trim();
        if (trimmed.includes('array [')) {
          inArray = true;
          continue;
        }
        if (inArray && trimmed.startsWith('struct {')) {
          currentTuple = {};
          continue;
        }
        if (inArray && trimmed.startsWith('}')) {
          if (currentTuple.index !== undefined && currentTuple.name !== undefined) {
            desktops.push(currentTuple as VirtualDesktopInfo);
          }
          currentTuple = {};
          continue;
        }
        if (inArray) {
          const uintMatch = /uint32\s+(\d+)/.exec(trimmed);
          if (uintMatch && currentTuple.index === undefined) {
            currentTuple.index = parseInt(uintMatch[1], 10);
            continue;
          }
          const strMatch = /string\s+"([^"]*)"/.exec(trimmed);
          if (strMatch) {
            if (currentTuple.name === undefined) {
              currentTuple.name = strMatch[1] || String((currentTuple.index ?? 0) + 1);
            }
            continue;
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  return desktops.sort((a, b) => a.index - b.index);
}

function getCurrentDesktopId(): string | null {
  try {
    const output = qdbus([
      "org.kde.KWin",
      "/VirtualDesktopManager",
      "org.freedesktop.DBus.Properties.Get",
      "org.kde.KWin.VirtualDesktopManager",
      "current",
    ]);
    const match = output.match(/"([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
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
  const normalizedPath = trimmedPath.replace(/[/]+$/, "");
  const folderName = nodePath.basename(normalizedPath);
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

function normalizeVirtualDesktopList(value: unknown): VirtualDesktopInfo[] {
  const raw = normalizeArray<{
    index?: unknown;
    Number?: unknown;
    name?: unknown;
    Name?: unknown;
    isCurrent?: unknown;
    Visible?: unknown;
  }>(value);

  const currentId = getCurrentDesktopId();

  return raw
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
  try {
    const output = qdbus([
      "org.kde.KWin",
      "/VirtualDesktopManager",
      "org.freedesktop.DBus.Properties.Get",
      "org.kde.KWin.VirtualDesktopManager",
      "desktops",
    ]);
    const desktops = parseDesktopsOutput(output);
    const currentId = getCurrentDesktopId();

    // Refresh isCurrent based on current desktop id
    // We need to map id to index, so use dbus-send for a cleaner approach
    try {
      const env = getSessionBusEnv();
      const dbusOutput = execSync(
        `dbus-send --session --dest=org.kde.KWin --type=method_call --print-reply /VirtualDesktopManager org.freedesktop.DBus.Properties.Get string:org.kde.KWin.VirtualDesktopManager string:desktops`,
        { encoding: "utf-8", env, timeout: 10000 }
      );

      const parsedDesktops: VirtualDesktopInfo[] = [];
      const lines = dbusOutput.split("\n");
      let inArray = false;
      let currentTuple: Partial<VirtualDesktopInfo> & { id?: string } = {};

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.includes('array [')) {
          inArray = true;
          continue;
        }
        if (inArray && trimmed.startsWith('struct {')) {
          currentTuple = {};
          continue;
        }
        if (inArray && trimmed.startsWith('}')) {
          if (currentTuple.index !== undefined && currentTuple.name !== undefined) {
            parsedDesktops.push({
              index: currentTuple.index,
              name: currentTuple.name,
              isCurrent: currentTuple.id === currentId,
            });
          }
          currentTuple = {};
          continue;
        }
        if (inArray) {
          const uintMatch = /uint32\s+(\d+)/.exec(trimmed);
          if (uintMatch && currentTuple.index === undefined) {
            currentTuple.index = parseInt(uintMatch[1], 10);
            continue;
          }
          const strMatch = /string\s+"([^"]*)"/.exec(trimmed);
          if (strMatch) {
            if (currentTuple.id === undefined) {
              currentTuple.id = strMatch[1];
            } else if (currentTuple.name === undefined) {
              currentTuple.name = strMatch[1] || String((currentTuple.index ?? 0) + 1);
            }
            continue;
          }
        }
      }

      if (parsedDesktops.length > 0) {
        return parsedDesktops.sort((a, b) => a.index - b.index);
      }
    } catch {
      // Fall through to qdbus parsing
    }

    return desktops;
  } catch (error) {
    console.error("[listVirtualDesktops] Error:", error);
    return [];
  }
}

export async function createVirtualDesktop(
  name?: string
): Promise<VirtualDesktopMutationResult> {
  try {
    const requestedName = name?.trim();
    if (name !== undefined && !requestedName) {
      return { success: false, error: "Desktop name is required" };
    }

    const desktopsBefore = await listVirtualDesktops();
    const position = desktopsBefore.length;

    qdbus([
      "org.kde.KWin",
      "/VirtualDesktopManager",
      "org.kde.KWin.VirtualDesktopManager.createDesktop",
      String(position),
      requestedName ?? "",
    ]);

    // Give KWin a moment to create the desktop
    await new Promise((resolve) => setTimeout(resolve, 250));

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

    // Need to find the desktop id for the current desktop
    const env = getSessionBusEnv();
    const dbusOutput = execSync(
      `dbus-send --session --dest=org.kde.KWin --type=method_call --print-reply /VirtualDesktopManager org.freedesktop.DBus.Properties.Get string:org.kde.KWin.VirtualDesktopManager string:desktops`,
      { encoding: "utf-8", env, timeout: 10000 }
    );

    let targetId: string | null = null;
    const lines = dbusOutput.split("\n");
    let inArray = false;
    let currentTuple: { index?: number; id?: string; name?: string } = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes('array [')) {
        inArray = true;
        continue;
      }
      if (inArray && trimmed.startsWith('struct {')) {
        currentTuple = {};
        continue;
      }
      if (inArray && trimmed.startsWith('}')) {
        if (
          currentTuple.index !== undefined &&
          currentTuple.index === validation.currentDesktop.index
        ) {
          targetId = currentTuple.id ?? null;
          break;
        }
        currentTuple = {};
        continue;
      }
      if (inArray) {
        const uintMatch = /uint32\s+(\d+)/.exec(trimmed);
        if (uintMatch && currentTuple.index === undefined) {
          currentTuple.index = parseInt(uintMatch[1], 10);
          continue;
        }
        const strMatch = /string\s+"([^"]*)"/.exec(trimmed);
        if (strMatch) {
          if (currentTuple.id === undefined) {
            currentTuple.id = strMatch[1];
          } else if (currentTuple.name === undefined) {
            currentTuple.name = strMatch[1];
          }
          continue;
        }
      }
    }

    if (!targetId) {
      return {
        success: false,
        error: `Could not find desktop id for "${currentName}"`,
      };
    }

    qdbus([
      "org.kde.KWin",
      "/VirtualDesktopManager",
      "org.kde.KWin.VirtualDesktopManager.setDesktopName",
      targetId,
      validation.normalizedNewName,
    ]);

    await new Promise((resolve) => setTimeout(resolve, 250));

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

    // Use KWin /KWin setCurrentDesktop (1-based index)
    qdbus([
      "org.kde.KWin",
      "/KWin",
      "org.kde.KWin.setCurrentDesktop",
      String(resolved.desktop.index + 1),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 250));

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

    // Use wmctrl to move window to desktop (0-based index for wmctrl -t)
    execSync(
      `wmctrl -i -r ${windowHandle} -t ${resolved.desktop.index}`,
      { encoding: "utf-8", timeout: 5000 }
    );

    await new Promise((resolve) => setTimeout(resolve, 250));

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

  try {
    const desktops = await listVirtualDesktops();
    const currentDesktop = desktops.find((d) => d.isCurrent);

    const results: WindowDesktopInfo[] = [];

    for (const handle of normalizedHandles) {
      try {
        // Use wmctrl -l to get desktop index for window
        const output = execSync("wmctrl -l", { encoding: "utf-8", timeout: 5000 });
        const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);

        for (const line of lines) {
          const parts = line.split(/\s+/);
          if (parts.length < 4) continue;
          const winHandle = parseInt(parts[0], 16);
          if (winHandle !== handle) continue;

          const desktopIndex = parseInt(parts[1], 10);
          const desktop = desktops.find((d) => d.index === desktopIndex);
          if (desktop) {
            results.push({
              handle,
              desktop: desktop.name,
              isCurrentDesktop: desktop.name === currentDesktop?.name,
            });
          }
          break;
        }
      } catch {
        // Ignore per-window errors
      }
    }

    return results;
  } catch {
    return [];
  }
}
