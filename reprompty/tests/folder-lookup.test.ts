import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findFolderByName } from "../src/core/folder-lookup.ts";
import { vscodeVariants } from "../src/core/vscode-paths.ts";

const ENV_KEYS = ["HOME", "USERPROFILE", "APPDATA", "XDG_CONFIG_HOME", "VSCODE_PORTABLE"];
let savedEnv: Record<string, string | undefined>;
let root: string;
let home: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reprompty-folders-"));
  home = path.join(root, "home");
  fs.mkdirSync(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = path.join(home, "AppData", "Roaming");
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  delete process.env.VSCODE_PORTABLE;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function folder(...parts: string[]): string {
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveSpawnTarget(folderPath: string): void {
  const file = path.join(home, ".reprompty", "spawn-targets.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const target = { id: "t", label: "t", folderPath, addedAt: "2026-01-01T00:00:00.000Z" };
  fs.writeFileSync(file, JSON.stringify({ targets: [target] }));
}

function openInVsCode(dir: string, entry: string, usedAt: Date): void {
  const userDataDir = vscodeVariants()[0].userDataDir;
  const entryDir = folder(userDataDir, "User", "workspaceStorage", entry);
  const workspace = JSON.stringify({ folder: pathToFileURL(dir).href });
  fs.writeFileSync(path.join(entryDir, "workspace.json"), workspace);
  fs.utimesSync(entryDir, usedAt, usedAt);
}

describe("findFolderByName", () => {
  it("finds a folder saved as a spawn target, ignoring case", () => {
    const target = folder(root, "elsewhere", "My-Repo");
    folder(home, "Projects", "My-Repo");
    saveSpawnTarget(target);
    expect(findFolderByName("my-repo")).toBe(target);
  });

  it("finds a folder opened in VS Code, the most recent first", () => {
    const older = folder(root, "old", "Data Pipeline");
    const newer = folder(root, "new", "Data Pipeline");
    openInVsCode(older, "aaaa", new Date("2026-01-01T10:00:00Z"));
    openInVsCode(newer, "bbbb", new Date("2026-01-02T10:00:00Z"));
    expect(findFolderByName("Data Pipeline")).toBe(newer);
  });

  it("searches the project folders and one level below them", () => {
    const direct = folder(home, "code", "tool-box");
    const nested = folder(home, "Projects", "Group", "Deep-Repo");
    const underHome = folder(home, "Documents", "notes");
    expect(findFolderByName("tool-box")).toBe(direct);
    expect(findFolderByName("deep-repo")).toBe(nested);
    expect(findFolderByName("notes")).toBe(underHome);
  });

  it("skips saved folders that no longer exist", () => {
    saveSpawnTarget(path.join(root, "deleted", "app"));
    const app = folder(home, "dev", "app");
    expect(findFolderByName("app")).toBe(app);
  });

  it("doesn't look inside hidden folders", () => {
    folder(home, ".cache", "reprompty");
    expect(findFolderByName("reprompty")).toBeNull();
  });

  it.runIf(process.platform === "linux")("prefers an exact-case match", () => {
    folder(home, "Projects", "demo");
    const exact = folder(home, "Projects", "Demo");
    expect(findFolderByName("Demo")).toBe(exact);
  });

  it("prefers an exact-case match anywhere over an earlier one ignoring case", () => {
    const saved = folder(root, "saved", "Reprompty");
    saveSpawnTarget(saved);
    const exact = folder(home, "work", "reprompty");
    expect(findFolderByName("reprompty")).toBe(exact);
    expect(findFolderByName("REPROMPTY")).toBe(saved);
  });

  it("returns null for unknown or blank names", () => {
    expect(findFolderByName("no-such-folder")).toBeNull();
    expect(findFolderByName("  ")).toBeNull();
  });
});
