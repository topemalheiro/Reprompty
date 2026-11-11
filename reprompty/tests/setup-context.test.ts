import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectInstallContext } from "../src/setup/context.ts";
import { makeTempHome, writeFile, type TempHome } from "./fixtures/setup/temp-home.ts";

const isWindows = process.platform === "win32";
const platform = isWindows ? "win32" : "linux";

let t: TempHome;

beforeEach(() => {
  t = makeTempHome();
});

afterEach(() => {
  t.restore();
});

function packageAt(root: string, version = "0.3.0"): string {
  writeFile(path.join(root, "package.json"), JSON.stringify({ name: "reprompty", version }));
  return root;
}

describe("detectInstallContext", () => {
  it("source checkout", () => {
    const root = packageAt(path.join(t.root, "Reprompty", "reprompty"));
    writeFile(path.join(root, "layout", "linux_layout.py"), "");
    const binary = isWindows ? "electron.exe" : "electron";
    writeFile(path.join(root, "node_modules", "electron", "path.txt"), binary);
    writeFile(path.join(root, "node_modules", "electron", "dist", binary), "", 0o755);

    const ctx = detectInstallContext({ root, platform, env: {}, electron: false });
    expect(ctx).toEqual({
      kind: "source",
      version: "0.3.0",
      appRoot: root,
      serverJs: path.join(root, "dist", "mcp", "server.js"),
      skillFile: path.join(root, "skills", "reprompty", "SKILL.md"),
      layoutScript: path.join(root, "layout", "linux_layout.py"),
      runtime: path.join(root, "node_modules", "electron", "dist", binary),
    });
  });

  it("source checkout without a downloaded Electron or a layout script", () => {
    const root = packageAt(path.join(t.root, "reprompty"));
    const ctx = detectInstallContext({ root, platform, env: {}, electron: false });
    expect(ctx).toMatchObject({ kind: "source", runtime: null, layoutScript: null });
  });

  it("installed Windows app", () => {
    const root = "C:\\Users\\example\\AppData\\Local\\Programs\\reprompty\\resources\\app";
    const execPath = "C:\\Users\\example\\AppData\\Local\\Programs\\reprompty\\Reprompty.exe";
    const ctx = detectInstallContext({ root, platform: "win32", env: {}, electron: true, execPath });
    expect(ctx).toMatchObject({
      kind: "installed",
      runtime: execPath,
      serverJs: `${root}\\dist\\mcp\\server.js`,
      skillFile: `${root}\\skills\\reprompty\\SKILL.md`,
    });
  });

  it.skipIf(isWindows)("unpacked Linux build run with plain node finds its binary", () => {
    const dir = path.join(t.root, "linux-unpacked");
    const root = packageAt(path.join(dir, "resources", "app"));
    writeFile(path.join(dir, "reprompty"), "", 0o755);
    const ctx = detectInstallContext({ root, platform: "linux", env: {}, electron: false });
    expect(ctx).toMatchObject({ kind: "unpacked", runtime: path.join(dir, "reprompty") });
  });

  it.skipIf(isWindows)("AppImage, only when running from inside its mount", () => {
    const mount = path.join(t.root, ".mount_Reprompty");
    const root = packageAt(path.join(mount, "resources", "app"));
    const env = { APPIMAGE: "/home/example/Apps/Reprompty.AppImage", APPDIR: mount };
    expect(detectInstallContext({ root, platform: "linux", env, electron: true, execPath: `${mount}/reprompty` })).toMatchObject({
      kind: "appimage",
      appImage: "/home/example/Apps/Reprompty.AppImage",
    });

    // A program started from the AppImage inherits APPIMAGE.
    const other = packageAt(path.join(t.root, "Reprompty", "reprompty"));
    expect(detectInstallContext({ root: other, platform: "linux", env, electron: false }).kind).toBe("source");
  });

  it("reads the version from the package", () => {
    const root = packageAt(path.join(t.root, "reprompty"), "1.2.3");
    expect(detectInstallContext({ root, platform, env: {} }).version).toBe("1.2.3");
  });
});
