import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InstallContext } from "../src/setup/context.ts";
import { linuxDeps, linuxInstallHint, sessionType } from "../src/setup/deps.ts";
import {
  desktopEntryPath,
  desktopEntryText,
  installDesktopEntry,
  managedDesktopEntryExists,
  removeDesktopEntry,
} from "../src/setup/desktop-entry.ts";
import { makeTempHome, writeFile, type TempHome } from "./fixtures/setup/temp-home.ts";

const isLinux = process.platform === "linux";
// A 32x32 PNG header is enough for the size check.
const PNG_32 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR", "latin1"),
  Buffer.from([0, 0, 0, 32, 0, 0, 0, 32, 8, 6, 0, 0, 0]),
]);

let t: TempHome;

beforeEach(() => {
  t = makeTempHome();
  process.env.XDG_DATA_HOME = t.at("data");
});

afterEach(() => {
  t.restore();
});

function sourceInstall(): InstallContext {
  const root = path.join(t.root, "My Projects", "Reprompty", "reprompty");
  for (const name of ["reprompty-launcher.sh", "layout-dual.sh", "layout-single.sh"]) {
    writeFile(path.join(root, "linux", name), "#!/bin/sh\n", 0o755);
  }
  writeFile(path.join(root, "build-resources", "icon.png"), PNG_32);
  return {
    kind: "source",
    version: "0.3.0",
    appRoot: root,
    serverJs: path.join(root, "dist", "mcp", "server.js"),
    skillFile: path.join(root, "skills", "reprompty", "SKILL.md"),
    layoutScript: null,
    runtime: null,
  };
}

describe.skipIf(!isLinux)("desktop entry", () => {
  it("quotes the AppImage path for the Exec key", () => {
    const ctx: InstallContext = {
      ...sourceInstall(),
      kind: "appimage",
      appImage: '/home/example/My Apps/Re"prompty$ 100%.AppImage',
    };
    const text = desktopEntryText(ctx)!;
    expect(text).toContain('Exec="/home/example/My Apps/Re\\\\"prompty\\\\$ 100%%.AppImage" --no-sandbox %U\n');
  });

  it("runs the launcher and the layout scripts of a source install", () => {
    const ctx = sourceInstall();
    const result = installDesktopEntry(ctx);
    expect(result).toMatchObject({ ok: true, changed: true });
    const text = fs.readFileSync(desktopEntryPath(), "utf-8");
    const launcher = path.join(ctx.appRoot, "linux", "reprompty-launcher.sh");
    expect(text).toContain(`Exec="${launcher}"\n`);
    expect(text).toContain("Actions=layout-dual;layout-single;\n");
    expect(text).toContain(`[Desktop Action layout-dual]\nName=Two-monitor layout\nExec="${path.join(ctx.appRoot, "linux", "layout-dual.sh")}"`);
    expect(text).toContain("X-Reprompty-Managed=true");
    expect(fs.existsSync(t.at("data", "icons", "hicolor", "32x32", "apps", "reprompty.png"))).toBe(true);
    expect(managedDesktopEntryExists()).toBe(true);
    expect(installDesktopEntry(ctx).changed).toBe(false);
  });

  it("leaves a hand-made menu entry alone", () => {
    writeFile(t.at("data", "applications", "Reprompty.desktop"), "[Desktop Entry]\nName=Reprompty\nExec=/opt/x\n");
    writeFile(t.at("data", "applications", "reprompty-layout.desktop"), "[Desktop Entry]\nName=Reprompty\nNoDisplay=true\n");
    const result = installDesktopEntry(sourceInstall());
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(result.message).toMatch(/Reprompty\.desktop already adds Reprompty to the app menu/);
    expect(fs.existsSync(desktopEntryPath())).toBe(false);
  });

  it("doesn't count hidden entries as the menu entry", () => {
    writeFile(t.at("data", "applications", "reprompty-layout.desktop"), "[Desktop Entry]\nName=Reprompty\nNoDisplay=true\n");
    expect(installDesktopEntry(sourceInstall()).changed).toBe(true);
  });

  it("never overwrites a reprompty.desktop it didn't make", () => {
    const file = writeFile(desktopEntryPath(), "[Desktop Entry]\nName=Mine\n");
    expect(installDesktopEntry(sourceInstall()).changed).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe("[Desktop Entry]\nName=Mine\n");
    expect(removeDesktopEntry().changed).toBe(false);
  });

  it("only reports on a dry run", () => {
    const result = installDesktopEntry(sourceInstall(), { dryRun: true });
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(result.message).toMatch(/^Would create/);
    expect(fs.existsSync(desktopEntryPath())).toBe(false);
    expect(fs.existsSync(t.at("data", "icons"))).toBe(false);
  });
});

describe("Linux dependencies", () => {
  function tool(name: string): void {
    writeFile(path.join(t.bin, process.platform === "win32" ? `${name}.cmd` : name), "#!/bin/sh\n", 0o755);
  }

  it("prints pacman and AUR commands on Arch", () => {
    tool("pacman");
    tool("yay");
    const missing = linuxDeps({ XDG_SESSION_TYPE: "wayland" }).filter((dep) => !dep.found);
    expect(missing.map((dep) => dep.id)).toEqual(["kdotool", "qdbus", "dbus-send", "python3", "kscreen-doctor", "wl-copy", "wtype"]);
    expect(linuxInstallHint(missing)).toEqual([
      "sudo pacman -S --needed qt6-tools dbus python libkscreen wl-clipboard wtype",
      "yay -S kdotool",
    ]);
  });

  it("labels the apt names as best effort and builds kdotool with cargo", () => {
    tool("apt-get");
    const missing = linuxDeps({ XDG_SESSION_TYPE: "wayland" }).filter((dep) => dep.id === "kdotool" || dep.id === "wl-copy");
    expect(linuxInstallHint(missing)).toEqual([
      "sudo apt install wl-clipboard   # best effort: names vary by release",
      "cargo install kdotool",
    ]);
  });

  it("checks the X tools instead on X11", () => {
    const ids = linuxDeps({ XDG_SESSION_TYPE: "x11" }).map((dep) => dep.id);
    expect(ids).toContain("xdotool");
    expect(ids).not.toContain("kdotool");
    expect(sessionType({ WAYLAND_DISPLAY: "wayland-0" })).toBe("wayland");
    expect(sessionType({})).toBe("unknown");
  });

  it("finds kdotool in ~/.cargo/bin", () => {
    if (process.platform === "win32") return;
    writeFile(t.at(".cargo", "bin", "kdotool"), "#!/bin/sh\n", 0o755);
    expect(linuxDeps({ XDG_SESSION_TYPE: "wayland" }).find((dep) => dep.id === "kdotool")?.found).toBe(
      t.at(".cargo", "bin", "kdotool")
    );
  });

  it("prints nothing when nothing is missing", () => {
    expect(linuxInstallHint([])).toEqual([]);
  });
});
