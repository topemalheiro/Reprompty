import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const isWindows = process.platform === "win32";

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (!isWindows) fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsExtensions(): string[] {
  return (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
}

// On Windows a bare name only matches with a PATHEXT extension: VS Code's bin
// folder also holds an extensionless `code` shell script that Windows can't run.
function candidateFiles(file: string): string[] {
  if (!isWindows) return [file];
  const extensions = windowsExtensions();
  if (extensions.includes(path.extname(file).toLowerCase())) return [file];
  return extensions.map((ext) => file + ext);
}

function pathDirs(): string[] {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

/**
 * Find an executable by name. Names are tried in order; for each one the
 * extraDirs are searched first, then PATH.
 */
export function findExecutable(names: string | string[], extraDirs: string[] = []): string | null {
  const dirs = [...extraDirs.filter(Boolean), ...pathDirs()];
  for (const name of Array.isArray(names) ? names : [names]) {
    if (!name) continue;
    const hasDir = name.includes("/") || (isWindows && name.includes("\\"));
    const files = hasDir ? [path.resolve(name)] : dirs.map((dir) => path.join(dir, name));
    for (const file of files) {
      const found = candidateFiles(file).find(isExecutableFile);
      if (found) return found;
    }
  }
  return null;
}

export function findKdotool(): string | null {
  const fromEnv = process.env.REPROMPTY_KDOTOOL;
  if (fromEnv && isExecutableFile(fromEnv)) return fromEnv;

  const home = os.homedir();
  const fallbacks = [
    path.join(home, ".cargo", "bin", "kdotool"),
    path.join(home, ".local", "bin", "kdotool"),
  ];
  return findExecutable("kdotool") ?? fallbacks.find(isExecutableFile) ?? null;
}
