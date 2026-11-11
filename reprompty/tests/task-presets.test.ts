import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ detectWindows: vi.fn(), spawnWindow: vi.fn() }));
const desktops = vi.hoisted(() => ({
  listVirtualDesktops: vi.fn(),
  ensureVirtualDesktop: vi.fn(),
  switchToVirtualDesktop: vi.fn(),
  moveWindowToVirtualDesktop: vi.fn(),
}));

// Windows process names, so the filter runs as it does there ("Code", not "code").
vi.mock("../src/platform/index.ts", async () => {
  const windows = await import("../src/platform/windows.ts");
  return {
    detectWindows: platform.detectWindows,
    spawnWindow: platform.spawnWindow,
    isSupportedEditorProcessName: windows.isSupportedEditorProcessName,
    normalizeEditorProcessName: windows.normalizeEditorProcessName,
  };
});
vi.mock("../src/core/virtual-desktop-manager.ts", () => desktops);

const ENV_KEYS = ["HOME", "USERPROFILE", "APPDATA", "XDG_CONFIG_HOME", "VSCODE_PORTABLE"];
let savedEnv: Record<string, string | undefined>;
let root: string;
let home: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reprompty-presets-"));
  home = folder(root, "home");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = folder(root, "AppData", "Roaming");
  process.env.XDG_CONFIG_HOME = folder(home, ".config");
  delete process.env.VSCODE_PORTABLE;
  for (const mock of [...Object.values(platform), ...Object.values(desktops)]) mock.mockReset();
  // The preset folder is read from HOME when the module loads.
  vi.resetModules();
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

function detected(window: { processName: string; title: string; folderPath: string; desktop?: string }) {
  return {
    pid: 4242,
    handle: 1001,
    isCurrentDesktop: false,
    extension: "unknown",
    activeAgent: "unknown",
    availableAgents: [],
    backgroundRoute: "foreground",
    pipePath: null,
    sendMethod: "foreground",
    ...window,
  };
}

function presetFile(name: string): string {
  return path.join(home, ".config", "reprompty", "presets", `${name}.json`);
}

describe("task preset window filter", () => {
  it("keeps a Windows VS Code window, whose process is named Code", async () => {
    const { isPresetEditorWindow } = await import("../src/core/task-preset-manager.ts");

    expect(isPresetEditorWindow({ processName: "Code", title: "repo - Visual Studio Code" })).toBe(true);
    expect(isPresetEditorWindow({ processName: "Code.exe", title: "Welcome" })).toBe(true);
    expect(isPresetEditorWindow({ processName: "", title: "a.ts - repo - Code - OSS" })).toBe(true);
    expect(
      isPresetEditorWindow({ processName: "", title: "repo - Visual Studio Code - Insiders" })
    ).toBe(true);
    expect(isPresetEditorWindow({ processName: "firefox", title: "Mozilla Firefox" })).toBe(false);
  });
});

describe("task preset folders", () => {
  it("finds a hyphenated project folder from the window title", async () => {
    const plasma = folder(home, "Projects", "KDE-Plasma-on-Wayland");
    const app = folder(home, "code", "my-app");
    const { resolvePresetFolder } = await import("../src/core/task-preset-manager.ts");

    expect(
      resolvePresetFolder({
        folderPath: "main.ts - KDE-Plasma-on-Wayland",
        title: "main.ts - KDE-Plasma-on-Wayland - Visual Studio Code",
      })
    ).toBe(plasma);
    expect(
      resolvePresetFolder({ folderPath: "", title: "● notes.md - my-app - Visual Studio Code - Insiders" })
    ).toBe(app);
    expect(resolvePresetFolder({ title: "missing-repo - Visual Studio Code" })).toBeNull();
  });

  it("keeps a detected folder that is already a full path", async () => {
    const elsewhere = folder(root, "elsewhere", "repo");
    const { resolvePresetFolder } = await import("../src/core/task-preset-manager.ts");

    expect(resolvePresetFolder({ folderPath: elsewhere, title: "repo - Visual Studio Code" })).toBe(
      elsewhere
    );
  });
});

describe("saveTaskPreset and loadTaskPreset", () => {
  it("saves Windows VS Code windows with their folders and desktops", async () => {
    const repo = folder(home, "Projects", "my-hyphen-repo");
    desktops.listVirtualDesktops.mockResolvedValue([
      { index: 0, name: "Main", isCurrent: true },
      { index: 1, name: "Work", isCurrent: false },
    ]);
    platform.detectWindows.mockResolvedValue([
      detected({
        processName: "Code",
        title: "main.ts - my-hyphen-repo - Visual Studio Code",
        folderPath: "main.ts - my-hyphen-repo",
        desktop: "Work",
      }),
      detected({
        processName: "Code",
        title: "not-on-disk - Visual Studio Code",
        folderPath: "not-on-disk",
      }),
    ]);
    const { saveTaskPreset } = await import("../src/core/task-preset-manager.ts");

    const result = await saveTaskPreset("daily");

    const expectedWindows = [
      {
        app: "code",
        folderPath: repo,
        desktopName: "Work",
        windowTitleHint: "main.ts - my-hyphen-repo - Visual Studio Code",
      },
    ];
    expect(result.success).toBe(true);
    expect(result.preset?.windows).toEqual(expectedWindows);
    expect(result.preset?.desktops).toEqual([
      { name: "Main", order: 0 },
      { name: "Work", order: 1 },
    ]);
    expect(JSON.parse(fs.readFileSync(presetFile("daily"), "utf-8")).windows).toEqual(expectedWindows);
  });

  it("spawns only the preset folders that are not open yet", async () => {
    const open = folder(home, "Projects", "my-hyphen-repo");
    const closed = folder(home, "Projects", "other-repo");
    fs.mkdirSync(path.dirname(presetFile("daily")), { recursive: true });
    fs.writeFileSync(
      presetFile("daily"),
      JSON.stringify({
        name: "daily",
        createdAt: "2026-01-01T00:00:00.000Z",
        desktops: [{ name: "Work", order: 0 }],
        windows: [open, closed].map((folderPath) => ({
          app: "code",
          folderPath,
          desktopName: "Work",
          windowTitleHint: `${path.basename(folderPath)} - Visual Studio Code`,
        })),
      })
    );
    desktops.listVirtualDesktops.mockResolvedValue([{ index: 0, name: "Work", isCurrent: true }]);
    platform.detectWindows.mockResolvedValue([
      detected({
        processName: "Code",
        title: "main.ts - my-hyphen-repo - Visual Studio Code",
        folderPath: "main.ts - my-hyphen-repo",
        desktop: "Work",
      }),
    ]);
    platform.spawnWindow.mockResolvedValue({ success: true, message: "spawned" });
    const { loadTaskPreset } = await import("../src/core/task-preset-manager.ts");

    const result = await loadTaskPreset("daily");

    expect(result).toEqual({ success: true, spawned: 1, errors: [] });
    expect(platform.spawnWindow).toHaveBeenCalledTimes(1);
    expect(platform.spawnWindow.mock.calls[0][0]).toBe(closed);
    expect(desktops.ensureVirtualDesktop).not.toHaveBeenCalled();
    expect(desktops.moveWindowToVirtualDesktop).not.toHaveBeenCalled();
  });
});
