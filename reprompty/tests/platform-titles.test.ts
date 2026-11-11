import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => ({ execSync: vi.fn(), execFileSync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execSync: exec.execSync,
  execFileSync: exec.execFileSync,
}));

const isWindows = process.platform === "win32";
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "PATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "VSCODE_PORTABLE",
  "REPROMPTY_KDOTOOL",
];
let savedEnv: Record<string, string | undefined>;
let root: string;
let home: string;
let pathDir: string;
let localAppData: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reprompty-platform-"));
  home = folder(root, "home");
  pathDir = folder(root, "bin");
  localAppData = folder(root, "AppData", "Local");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PATH = pathDir;
  process.env.APPDATA = folder(root, "AppData", "Roaming");
  process.env.LOCALAPPDATA = localAppData;
  process.env.ProgramFiles = folder(root, "Program Files");
  process.env.XDG_CONFIG_HOME = folder(home, ".config");
  process.env.XDG_RUNTIME_DIR = folder(root, "run");
  process.env.XDG_SESSION_TYPE = "wayland";
  delete process.env.VSCODE_PORTABLE;
  delete process.env.REPROMPTY_KDOTOOL;
  exec.execSync.mockReset();
  exec.execFileSync.mockReset();
  exec.execFileSync.mockImplementation(() => {
    throw new Error("qdbus is not available in tests");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function folder(...parts: string[]): string {
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  return file;
}

interface FakeWindow {
  handle: string;
  title: string;
  pid: number;
  comm: string;
}

// kdotool and ps as linux.ts calls them; kdotool search patterns are case-insensitive regexes.
function fakeKdotool(windows: FakeWindow[]): string[] {
  process.env.REPROMPTY_KDOTOOL = touch(path.join(root, "tools", "kdotool"));
  const commands: string[] = [];
  const byHandle = (handle: string) => {
    const found = windows.find((window) => window.handle === handle);
    if (!found) throw new Error(`no window ${handle}`);
    return found;
  };
  exec.execSync.mockImplementation((command: string) => {
    commands.push(command);
    let match = command.match(/ search --title (".*") --limit 0$/);
    if (match) {
      const pattern = new RegExp(JSON.parse(match[1]) as string, "i");
      return windows
        .filter((window) => pattern.test(window.title))
        .map((window) => `${window.handle}\n`)
        .join("");
    }
    match = command.match(/ (getwindowname|getwindowpid|get_desktop_for_window) (\{.+\})$/);
    if (match) {
      const window = byHandle(match[2]);
      if (match[1] === "getwindowname") return `${window.title}\n`;
      if (match[1] === "getwindowpid") return `${window.pid}\n`;
      return "1\n";
    }
    match = command.match(/^ps -p (\d+) -o comm=$/);
    if (match) {
      const window = windows.find((candidate) => candidate.pid === Number(match![1]));
      if (window) return `${window.comm}\n`;
    }
    throw new Error(`unexpected command: ${command}`);
  });
  return commands;
}

describe("Linux editor window detection", () => {
  it("finds VS Code, Insiders, Code - OSS and VSCodium windows through kdotool", async () => {
    const commands = fakeKdotool([
      { handle: "{0001}", title: "main.ts - repo-a - Visual Studio Code", pid: 100, comm: "code" },
      {
        handle: "{0002}",
        title: "notes.md - my-app - Visual Studio Code - Insiders",
        pid: 200,
        comm: "code-insiders",
      },
      {
        handle: "{0003}",
        title: "● index.ts - KDE-Plasma-on-Wayland - Code - OSS",
        pid: 300,
        comm: "code-oss",
      },
      { handle: "{0004}", title: "repo-d - VSCodium", pid: 400, comm: "codium" },
      { handle: "{0005}", title: "Visual Studio Code tips - Mozilla Firefox", pid: 500, comm: "firefox" },
    ]);
    const { detectWindows } = await import("../src/platform/linux.ts");

    const detected = await detectWindows({ force: true });

    expect(detected.map((w) => [w.kdotoolHandle, w.folderPath, w.processName])).toEqual([
      ["{0001}", "main.ts - repo-a", "code"],
      ["{0002}", "notes.md - my-app", "code-insiders"],
      ["{0003}", "● index.ts - KDE-Plasma-on-Wayland", "code-oss"],
      ["{0004}", "repo-d", "codium"],
    ]);
    const searches = commands.filter((command) => command.includes(" search --title "));
    expect(searches.some((command) => command.includes('"Code - OSS"'))).toBe(true);
    expect(searches.some((command) => command.includes("Code:"))).toBe(false);
  });

  it("names editor processes found by ps without a colon in the title", async () => {
    exec.execSync.mockImplementation((command: string) => {
      if (command === "ps -eo pid,comm,args") {
        return [
          "    PID COMMAND         COMMAND",
          "   4242 code            /usr/share/code/code --new-window /home/u/Projects/my-repo",
          "   4243 code            /usr/share/code/code --type=zygote",
          "   5000 firefox         /usr/lib/firefox/firefox",
        ].join("\n");
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { detectWindows } = await import("../src/platform/linux.ts");

    const detected = await detectWindows({ force: true });

    expect(detected.map((w) => [w.pid, w.title, w.folderPath])).toEqual([
      [4242, "my-repo - Visual Studio Code", "my-repo"],
    ]);
  });

  it("resolves a window's folder from its title, hyphenated names included", async () => {
    const plasma = folder(home, "Projects", "KDE-Plasma-on-Wayland");
    const repo = folder(home, "code", "repo");
    const { getWorkspacePathFromPid } = await import("../src/platform/linux.ts");

    expect(getWorkspacePathFromPid(0, "main.ts - KDE-Plasma-on-Wayland - Visual Studio Code")).toBe(
      plasma
    );
    expect(getWorkspacePathFromPid(0, "a.ts - repo - Code - OSS")).toBe(repo);
    expect(getWorkspacePathFromPid(0, "missing - Visual Studio Code - Insiders")).toBeNull();
  });

  it.skipIf(isWindows)("spawns the first VS Code CLI on PATH with shell-safe quoting", async () => {
    const codeOss = touch(path.join(pathDir, "code-oss"));
    exec.execSync.mockReturnValue("");
    const { spawnWindow } = await import("../src/platform/linux.ts");

    const result = await spawnWindow("/home/u/it's a repo");

    expect(result.success).toBe(true);
    expect(result.message).toBe("Spawned VS Code window for /home/u/it's a repo");
    expect(exec.execSync.mock.calls[0][0]).toBe(
      `'${codeOss}' --remote-debugging-port=9222 -n '/home/u/it'\\''s a repo' &`
    );
  });

  it("leaves the session environment alone off Linux", async () => {
    const { ensureLinuxSessionEnv } = await import("../src/platform/linux.ts");
    delete process.env.XDG_SESSION_TYPE;
    delete process.env.DISPLAY;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      ensureLinuxSessionEnv();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(process.env.XDG_SESSION_TYPE).toBeUndefined();
    expect(process.env.DISPLAY).toBeUndefined();
  });
});

describe("Windows editor window detection", () => {
  it("lists every VS Code family window and reads PowerShell output as UTF-8", async () => {
    const scripts: string[] = [];
    exec.execSync.mockImplementation((command: string) => {
      const match = command.match(/^powershell .* -File "(.+)"$/);
      if (!match) throw new Error(`unexpected command: ${command}`);
      scripts.push(fs.readFileSync(match[1], "utf-8"));
      return [
        "1001|200|Code|main.ts - repo-a - Visual Studio Code",
        "1002|300|Code - Insiders|notes.md - my-app - Visual Studio Code - Insiders",
        "1003|400|VSCodium|repo-d - VSCodium",
        "1004|500|firefox|Visual Studio Code tips - Mozilla Firefox",
        "True",
      ].join("\r\n");
    });
    const { detectWindows } = await import("../src/platform/windows.ts");

    const detected = await detectWindows();

    expect(detected.map((w) => [w.handle, w.folderPath, w.processName])).toEqual([
      [1001, "main.ts - repo-a", "Code"],
      [1002, "notes.md - my-app", "Code - Insiders"],
      [1003, "repo-d", "VSCodium"],
    ]);
    const powershellCall = exec.execSync.mock.calls.find(([command]) => command.startsWith("powershell"));
    expect(powershellCall?.[1]).toMatchObject({ windowsHide: true });
    expect(scripts[0].startsWith("\uFEFF")).toBe(true);
    expect(scripts[0]).toContain("[Console]::OutputEncoding = [Text.Encoding]::UTF8");
    expect(scripts[0]).toContain('$title -like "*Code - OSS*"');
    expect(scripts[0]).toContain('$title -like "*VSCodium*"');
  });

  it("finds code.cmd on PATH first, then in the usual install folders", async () => {
    const { findCodeCmd } = await import("../src/platform/windows.ts");
    expect(findCodeCmd()).toBeNull();

    const scoop = touch(path.join(home, "scoop", "apps", "vscode", "current", "bin", "code.cmd"));
    expect(findCodeCmd()).toBe(scoop);

    const insiders = touch(
      path.join(localAppData, "Programs", "Microsoft VS Code Insiders", "bin", "code-insiders.cmd")
    );
    expect(findCodeCmd()).toBe(insiders);

    const user = touch(path.join(localAppData, "Programs", "Microsoft VS Code", "bin", "code.cmd"));
    expect(findCodeCmd()).toBe(user);

    const onPath = touch(path.join(pathDir, isWindows ? "code.cmd" : "code"));
    expect(findCodeCmd()).toBe(onPath);
  });

  it("starts code.cmd hidden, with single quotes escaped and the saved port", async () => {
    const codeCmd = touch(path.join(localAppData, "Programs", "Microsoft VS Code", "bin", "code.cmd"));
    folder(home, ".reprompty");
    fs.writeFileSync(path.join(home, ".reprompty", "settings.json"), JSON.stringify({ cdpPort: 9333 }));
    exec.execSync.mockReturnValue("");
    const { spawnWindow } = await import("../src/platform/windows.ts");

    const result = await spawnWindow("C:\\Users\\example\\it's here");

    expect(result.success).toBe(true);
    const [command, options] = exec.execSync.mock.calls[0];
    expect(command).toBe(
      `powershell.exe -NoProfile -Command "& '${codeCmd}' --remote-debugging-port=9333 -n 'C:\\Users\\example\\it''s here'"`
    );
    expect(options.windowsHide).toBe(true);
  });

  it("explains a missing code.cmd", async () => {
    const { spawnWindow } = await import("../src/platform/windows.ts");
    const result = await spawnWindow("C:\\repo");
    expect(result).toEqual({
      success: false,
      message: "code.cmd not found. Install VS Code or add its bin folder to PATH.",
    });
    expect(exec.execSync).not.toHaveBeenCalled();
  });

  it("resolves a window's folder from its title", async () => {
    const repo = folder(home, "Projects", "my-hyphen-repo");
    const { getWorkspacePathFromPid } = await import("../src/platform/windows.ts");
    expect(getWorkspacePathFromPid(1, "a.ts - my-hyphen-repo - Visual Studio Code")).toBe(repo);
    expect(getWorkspacePathFromPid(1)).toBeNull();
  });
});

describe("Windows virtual desktops", () => {
  const MISSING =
    "Virtual desktops need the VirtualDesktop PowerShell module. Open Reprompty → Setup → Install, or run Install-Module VirtualDesktop -Scope CurrentUser.";

  it("explains how to install the VirtualDesktop module when it is missing", async () => {
    exec.execFileSync.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("-Command")) return "no\r\n";
      throw new Error("the desktop script must not run");
    });
    vi.resetModules();
    const desktops = await import("../src/core/virtual-desktop-manager-windows.ts");

    expect(desktops.VIRTUAL_DESKTOP_MODULE_MISSING).toBe(MISSING);
    await expect(desktops.listVirtualDesktops()).rejects.toThrow(MISSING);
    expect(await desktops.createVirtualDesktop("Work")).toEqual({ success: false, error: MISSING });
    expect(await desktops.moveWindowToVirtualDesktop(1001, "Work")).toMatchObject({
      success: false,
      error: MISSING,
    });
    // Checked once, then cached
    expect(exec.execFileSync).toHaveBeenCalledTimes(1);
    expect(exec.execFileSync.mock.calls[0][2]).toMatchObject({ windowsHide: true });
  });

  it("runs the desktop script hidden once the module is installed", async () => {
    const scripts: string[] = [];
    exec.execFileSync.mockImplementation(
      (_file: string, args: string[], options: { windowsHide?: boolean }) => {
        expect(options.windowsHide).toBe(true);
        if (args.includes("-Command")) return "yes\r\n";
        scripts.push(fs.readFileSync(args[args.length - 1], "utf-8"));
        return '\uFEFF[{"index":0,"name":"Main","isCurrent":true},{"index":1,"name":"Música","isCurrent":false}]\r\n';
      }
    );
    vi.resetModules();
    const desktops = await import("../src/core/virtual-desktop-manager-windows.ts");

    expect(await desktops.listVirtualDesktops()).toEqual([
      { index: 0, name: "Main", isCurrent: true },
      { index: 1, name: "Música", isCurrent: false },
    ]);
    expect(scripts[0].startsWith("\uFEFF")).toBe(true);
    expect(scripts[0]).toContain("[Console]::OutputEncoding = [Text.Encoding]::UTF8");
  });
});
