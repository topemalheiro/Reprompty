import * as fs from "node:fs";
import * as path from "node:path";
import { spawnWindow, detectWindows } from "../platform/index.js";
import {
  listVirtualDesktops,
  ensureVirtualDesktop,
  switchToVirtualDesktop,
  moveWindowToVirtualDesktop,
} from "./virtual-desktop-manager.js";
import type { VirtualDesktopInfo } from "./virtual-desktop-manager.js";

const PRESET_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".config",
  "reprompty",
  "presets"
);

function ensurePresetDir(): void {
  if (!fs.existsSync(PRESET_DIR)) {
    fs.mkdirSync(PRESET_DIR, { recursive: true });
  }
}

function getPresetPath(name: string): string {
  return path.join(PRESET_DIR, `${name}.json`);
}

export interface PresetWindow {
  app: "code";
  folderPath: string;
  desktopName: string;
  windowTitleHint: string;
}

export interface TaskPreset {
  name: string;
  createdAt: string;
  desktops: Array<{ name: string; order: number }>;
  windows: PresetWindow[];
}

export interface SavePresetResult {
  success: boolean;
  preset?: TaskPreset;
  error?: string;
}

export interface LoadPresetResult {
  success: boolean;
  spawned: number;
  errors: string[];
}

/**
 * Parse a VS Code: window title to extract the folder name.
 * Examples:
 *   "Welcome - kilocode-legacy - Visual Studio Code:"
 *   "main.ts - KDE-Plasma-on-Wayland - Visual Studio Code:"
 */
function parseFolderFromWindowTitle(title: string): string | null {
  // Match "... - FolderName - Visual Studio Code:" or "FolderName - Visual Studio Code:"
  const match = title.match(/(?:^|.*?\s-\s)([^\-]+?)\s+-\s+Visual Studio Code:/);
  if (match) {
    return match[1].trim();
  }
  // Also try "FolderName - Code:" (insiders, codium variants)
  const match2 = title.match(/(?:^|.*?\s-\s)([^\-]+?)\s+-\s+(?:Visual Studio )?Code:/i);
  if (match2) {
    return match2[1].trim();
  }
  return null;
}

/**
 * Detect the full folder path for a VS Code: window by matching title against known projects.
 */
async function resolveFolderPath(
  title: string,
  pid: number
): Promise<string | null> {
  const folderName = parseFolderFromWindowTitle(title);
  if (!folderName) return null;

  // Try to get cwd from /proc/{pid}/cwd on Linux
  try {
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    if (cwd && path.basename(cwd) === folderName) {
      return cwd;
    }
  } catch {
    // ignore
  }

  // Fallback: search common project directories
  const searchRoots = [
    path.join(process.env.HOME || ".", "Projects"),
    path.join(process.env.HOME || ".", "projects"),
    path.join(process.env.HOME || "."),
  ];
  for (const root of searchRoots) {
    if (!fs.existsSync(root)) continue;
    const candidates = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of candidates) {
      if (entry.isDirectory() && entry.name === folderName) {
        return path.join(root, entry.name);
      }
      // Also check one level deeper (e.g., OS-Toolkit/Reprompty)
      if (entry.isDirectory()) {
        const subPath = path.join(root, entry.name);
        try {
          const subEntries = fs.readdirSync(subPath, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isDirectory() && sub.name === folderName) {
              return path.join(subPath, sub.name);
            }
          }
        } catch {
          // ignore
        }
      }
    }
  }

  return null;
}

export async function saveTaskPreset(name: string): Promise<SavePresetResult> {
  try {
    ensurePresetDir();

    const [desktops, windows] = await Promise.all([
      listVirtualDesktops(),
      detectWindows(),
    ]);

    const desktopMap = new Map<number, VirtualDesktopInfo>();
    desktops.forEach((d, i) => desktopMap.set(i, d));

    const presetWindows: PresetWindow[] = [];
    for (const w of windows) {
      if (w.processName !== "code" && !w.title.includes("Visual Studio Code:")) {
        continue;
      }
      const folderPath = w.folderPath || (await resolveFolderPath(w.title, w.pid));
      if (!folderPath) continue;

      presetWindows.push({
        app: "code",
        folderPath,
        desktopName: w.desktop || "",
        windowTitleHint: w.title,
      });
    }

    const preset: TaskPreset = {
      name,
      createdAt: new Date().toISOString(),
      desktops: desktops.map((d, i) => ({
        name: d.name || `Desktop ${i + 1}`,
        order: i,
      })),
      windows: presetWindows,
    };

    fs.writeFileSync(getPresetPath(name), JSON.stringify(preset, null, 2));
    return { success: true, preset };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loadTaskPreset(name: string): Promise<LoadPresetResult> {
  const errors: string[] = [];
  let spawned = 0;

  try {
    const presetPath = getPresetPath(name);
    if (!fs.existsSync(presetPath)) {
      return { success: false, spawned: 0, errors: [`Preset "${name}" not found`] };
    }

    const preset: TaskPreset = JSON.parse(fs.readFileSync(presetPath, "utf-8"));

    // Ensure all desktops exist
    const existingDesktops = await listVirtualDesktops();
    const existingNames = new Set(existingDesktops.map((d) => d.name));
    for (const desktop of preset.desktops) {
      if (!existingNames.has(desktop.name)) {
        const result = await ensureVirtualDesktop(desktop.name);
        if (!result.success) {
          errors.push(`Failed to create desktop "${desktop.name}": ${result.error || "unknown"}`);
        }
      }
    }

    // Detect currently open VS Code: windows to avoid duplicates
    const currentWindows = await detectWindows();
    const openFolders = new Set(
      currentWindows
        .filter((w) => w.processName === "code" || w.title.includes("Visual Studio Code:"))
        .map((w) => w.folderPath)
        .filter(Boolean)
    );

    // Spawn missing windows
    for (const w of preset.windows) {
      if (openFolders.has(w.folderPath)) {
        continue; // already open
      }

      const result = await spawnWindow(w.folderPath, w.windowTitleHint, w.desktopName);
      if (result.success) {
        spawned++;
      } else {
        errors.push(`Failed to spawn "${w.folderPath}": ${result.message}`);
      }
    }

    // Move windows to their assigned desktops (best-effort)
    const refreshedWindows = await detectWindows();
    for (const w of preset.windows) {
      const match = refreshedWindows.find(
        (cw) =>
          (cw.folderPath === w.folderPath || cw.title.includes(path.basename(w.folderPath))) &&
          cw.desktop !== w.desktopName
      );
      if (match && w.desktopName && match.handle) {
        try {
          await moveWindowToVirtualDesktop(match.handle, w.desktopName);
        } catch (e) {
          errors.push(
            `Failed to move window "${w.folderPath}" to desktop "${w.desktopName}": ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    }

    return { success: errors.length === 0 || spawned > 0, spawned, errors };
  } catch (error) {
    return {
      success: false,
      spawned,
      errors: [
        ...errors,
        error instanceof Error ? error.message : String(error),
      ],
    };
  }
}

export function listTaskPresets(): string[] {
  ensurePresetDir();
  try {
    return fs
      .readdirSync(PRESET_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.basename(f, ".json"));
  } catch {
    return [];
  }
}

export function deleteTaskPreset(name: string): { success: boolean; error?: string } {
  const presetPath = getPresetPath(name);
  if (!fs.existsSync(presetPath)) {
    return { success: false, error: `Preset "${name}" not found` };
  }
  try {
    fs.unlinkSync(presetPath);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
