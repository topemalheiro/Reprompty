import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { vscodeVariants } from "./vscode-paths.js";

const RECENT_FOLDERS_TTL_MS = 30_000;
const PROJECT_DIRS = ["Projects", "projects", "dev", "work", "src", "code", "repos"];

let recentFoldersCache: { key: string; at: number; folders: string[] } | null = null;

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// Read directly: importing spawn-target-manager would create its config on import.
function spawnTargetFolders(): string[] {
  try {
    const file = path.join(os.homedir(), ".reprompty", "spawn-targets.json");
    const targets = (JSON.parse(fs.readFileSync(file, "utf-8")) as { targets?: unknown }).targets;
    if (!Array.isArray(targets)) return [];
    return targets
      .map((target) => (target as { folderPath?: unknown } | null)?.folderPath)
      .filter((folder): folder is string => typeof folder === "string" && path.isAbsolute(folder));
  } catch {
    return [];
  }
}

// Folders opened in VS Code, most recently used first.
function recentVsCodeFolders(): string[] {
  const storageDirs = [
    ...new Set(
      vscodeVariants().map((variant) => path.join(variant.userDataDir, "User", "workspaceStorage"))
    ),
  ];
  const key = storageDirs.join("\n");
  const now = Date.now();
  if (recentFoldersCache?.key === key && now - recentFoldersCache.at < RECENT_FOLDERS_TTL_MS) {
    return recentFoldersCache.folders;
  }

  const found: Array<{ folder: string; usedAt: number }> = [];
  for (const storageDir of storageDirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(storageDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryDir = path.join(storageDir, entry);
      try {
        const raw = fs.readFileSync(path.join(entryDir, "workspace.json"), "utf-8");
        const uri: unknown = JSON.parse(raw)?.folder;
        if (typeof uri !== "string" || !uri.startsWith("file:")) continue;
        found.push({ folder: fileURLToPath(uri), usedAt: fs.statSync(entryDir).mtimeMs });
      } catch {
        // No workspace.json, a multi-root workspace, or a remote folder
      }
    }
  }

  const folders = found.sort((a, b) => b.usedAt - a.usedAt).map((item) => item.folder);
  recentFoldersCache = { key, at: now, folders };
  return folders;
}

function childFolders(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

// Folders in home and the usual project folders, then one level below those.
function projectRootFolders(): string[] {
  const home = os.homedir();
  const roots = [home, ...PROJECT_DIRS.map((dir) => path.join(home, dir))];
  const firstLevel = [...new Set(roots.flatMap(childFolders))];
  const parents = firstLevel.filter((dir) => {
    const base = path.basename(dir);
    return !base.startsWith(".") && base !== "node_modules" && !roots.includes(dir);
  });
  return [...firstLevel, ...parents.flatMap(childFolders)];
}

/**
 * Find a project folder from its name (as shown in an editor title): saved spawn
 * targets first, then folders opened in VS Code, then the usual project folders.
 * A match in the exact case wins over one that ignores case.
 */
export function findFolderByName(name: string): string | null {
  const wanted = name.trim();
  if (!wanted) return null;
  const lower = wanted.toLowerCase();
  const sources = [spawnTargetFolders, recentVsCodeFolders, projectRootFolders];
  const lists: string[][] = [];
  const passes = [
    (base: string) => base === wanted,
    (base: string) => base.toLowerCase() === lower,
  ];
  for (const matches of passes) {
    for (let i = 0; i < sources.length; i++) {
      lists[i] ??= sources[i]();
      const found = lists[i].find(
        (candidate) => matches(path.basename(candidate)) && isDirectory(candidate)
      );
      if (found) return found;
    }
  }
  return null;
}
