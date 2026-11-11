import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { detectInstallContext, type InstallContext } from "../src/setup/context.ts";
import { desktopEntryPath, installDesktopEntry } from "../src/setup/desktop-entry.ts";
import {
  appImageWrapper,
  appImageWrapperPath,
  mcpHandshake,
  REQUIRED_TOOLS,
  resolveMcpLaunch,
  syncAppImageRuntime,
} from "../src/setup/launch.ts";
import { makeTempHome, writeFile, type TempHome } from "./fixtures/setup/temp-home.ts";

const isWindows = process.platform === "win32";

let t: TempHome;

beforeEach(() => {
  t = makeTempHome();
  process.env.XDG_DATA_HOME = t.at("data");
});

afterEach(() => {
  t.restore();
});

function context(kind: InstallContext["kind"], fields: Partial<InstallContext> = {}): InstallContext {
  const root = "/home/example/Reprompty/reprompty";
  return {
    kind,
    version: "0.3.0",
    appRoot: root,
    serverJs: `${root}/dist/mcp/server.js`,
    skillFile: `${root}/skills/reprompty/SKILL.md`,
    layoutScript: `${root}/layout/linux_layout.py`,
    runtime: null,
    ...fields,
  };
}

describe("resolveMcpLaunch", () => {
  it("source install: the node found on PATH", () => {
    const find = vi.fn(() => "/usr/bin/node");
    const ctx = context("source", { runtime: "/home/example/Reprompty/reprompty/node_modules/electron/dist/electron" });
    expect(resolveMcpLaunch(ctx, { findExecutable: find, electron: true })).toEqual({
      command: "/usr/bin/node",
      args: ["/home/example/Reprompty/reprompty/dist/mcp/server.js"],
      env: {},
    });
    expect(find).toHaveBeenCalledWith("node");
  });

  it("source install without node on PATH: the running node", () => {
    const ctx = context("source");
    const launch = resolveMcpLaunch(ctx, { findExecutable: () => null, electron: false, execPath: "/opt/node/bin/node" });
    expect(launch).toEqual({ command: "/opt/node/bin/node", args: [ctx.serverJs], env: {} });
  });

  it("source install without node, inside Electron: the repo's Electron as node", () => {
    const runtime = "/home/example/Reprompty/reprompty/node_modules/electron/dist/electron";
    const ctx = context("source", { runtime });
    const launch = resolveMcpLaunch(ctx, { findExecutable: () => null, electron: true, execPath: runtime });
    expect(launch).toEqual({ command: runtime, args: [ctx.serverJs], env: { ELECTRON_RUN_AS_NODE: "1" } });
  });

  it("source install with nothing to run it: plain node", () => {
    const launch = resolveMcpLaunch(context("source"), { findExecutable: () => null, electron: true });
    expect(launch.command).toBe("node");
  });

  it("Windows install: Reprompty.exe as node", () => {
    const app = "C:\\Users\\example\\AppData\\Local\\Programs\\reprompty";
    const ctx = context("installed", {
      appRoot: `${app}\\resources\\app`,
      serverJs: `${app}\\resources\\app\\dist\\mcp\\server.js`,
      runtime: `${app}\\Reprompty.exe`,
    });
    const find = vi.fn(() => "C:\\Program Files\\nodejs\\node.exe");
    expect(resolveMcpLaunch(ctx, { findExecutable: find, electron: true })).toEqual({
      command: `${app}\\Reprompty.exe`,
      args: [`${app}\\resources\\app\\dist\\mcp\\server.js`],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(find).not.toHaveBeenCalled();
  });

  it("unpacked Linux build: its reprompty binary as node", () => {
    const ctx = context("unpacked", {
      appRoot: "/opt/rp/linux-unpacked/resources/app",
      serverJs: "/opt/rp/linux-unpacked/resources/app/dist/mcp/server.js",
      runtime: "/opt/rp/linux-unpacked/reprompty",
    });
    expect(resolveMcpLaunch(ctx, { findExecutable: () => "/usr/bin/node" })).toEqual({
      command: "/opt/rp/linux-unpacked/reprompty",
      args: ["/opt/rp/linux-unpacked/resources/app/dist/mcp/server.js"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });

  it("AppImage: the fixed wrapper in the data folder", () => {
    const ctx = context("appimage", { appImage: "/home/example/Apps/Reprompty.AppImage", runtime: "/tmp/.mount_x/reprompty" });
    expect(resolveMcpLaunch(ctx, { findExecutable: () => "/usr/bin/node" })).toEqual({
      command: path.join(t.at("data"), "reprompty", "bin", "reprompty-mcp"),
      args: [],
      env: {},
    });
  });
});

describe.skipIf(isWindows)("syncAppImageRuntime", () => {
  function mountedApp(): { mount: string; ctx: InstallContext } {
    const mount = path.join(t.root, ".mount_Reprompty");
    const app = path.join(mount, "resources", "app");
    writeFile(path.join(app, "dist", "mcp", "server.js"), "console.log('server');\n");
    writeFile(path.join(app, "layout", "linux_layout.py"), "print('layout')\n");
    writeFile(path.join(app, "package.json"), '{ "name": "reprompty", "version": "0.3.0" }\n');
    return { mount, ctx: appImageContext(mount, path.join(t.root, "Apps", "Reprompty's 0.3.0.AppImage")) };
  }

  function appImageContext(mount: string, appImage: string): InstallContext {
    return detectInstallContext({
      root: path.join(mount, "resources", "app"),
      platform: "linux",
      env: { APPIMAGE: appImage, APPDIR: mount },
      electron: true,
      execPath: path.join(mount, "reprompty"),
    });
  }

  it("copies the server out of the mount and writes the wrapper", () => {
    const { mount, ctx } = mountedApp();
    expect(ctx.kind).toBe("appimage");
    const wrapper = syncAppImageRuntime(ctx);
    expect(wrapper).toBe(appImageWrapperPath());
    expect(fs.statSync(wrapper).mode & 0o777).toBe(0o755);

    const base = path.join(t.at("data"), "reprompty");
    for (const file of ["dist/mcp/server.js", "layout/linux_layout.py", "package.json"]) {
      expect(fs.readFileSync(path.join(base, file), "utf-8")).toBe(
        fs.readFileSync(path.join(mount, "resources", "app", file), "utf-8")
      );
    }
    expect(fs.readFileSync(wrapper, "utf-8")).toBe(appImageWrapper(ctx.appImage!));
    expect(fs.readFileSync(wrapper, "utf-8")).toContain(`APPIMAGE_PATH='${t.root}/Apps/Reprompty'\\''s 0.3.0.AppImage'`);
  });

  it("runs the AppImage in node mode, with quoting that survives odd names", () => {
    const { ctx } = mountedApp();
    writeFile(ctx.appImage!, '#!/bin/sh\necho "$ELECTRON_RUN_AS_NODE|$1|$2"\n', 0o755);
    const wrapper = syncAppImageRuntime(ctx);
    const out = execFileSync("/bin/sh", [wrapper, "two words"], { encoding: "utf-8" }).trim();
    const [asNode, server, arg] = out.split("|");
    expect(asNode).toBe("1");
    expect(server).toBe(path.join(t.at("data"), "reprompty", "dist", "mcp", "server.js"));
    expect(arg).toBe("two words");
  });

  it("leaves unchanged files alone and follows a moved AppImage", () => {
    const { mount, ctx } = mountedApp();
    const wrapper = syncAppImageRuntime(ctx);
    const copied = path.join(t.at("data"), "reprompty", "dist", "mcp", "server.js");
    const old = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(copied, old, old);
    fs.utimesSync(wrapper, old, old);
    syncAppImageRuntime(ctx);
    expect(fs.statSync(copied).mtimeMs).toBe(old.getTime());
    expect(fs.statSync(wrapper).mtimeMs).toBe(old.getTime());

    installDesktopEntry(ctx);
    const moved = appImageContext(mount, path.join(t.root, "Moved", "Reprompty.AppImage"));
    syncAppImageRuntime(moved);
    expect(fs.readFileSync(wrapper, "utf-8")).toContain(`APPIMAGE_PATH='${t.root}/Moved/Reprompty.AppImage'`);
    expect(fs.readFileSync(desktopEntryPath(), "utf-8")).toContain(`Exec=${t.root}/Moved/Reprompty.AppImage --no-sandbox %U`);
  });
});

describe("mcpHandshake", () => {
  const TOOLS = [...REQUIRED_TOOLS, ...Array.from({ length: 21 }, (_, i) => `tool_${i}`)];

  function fakeServer(o: { name?: string; version?: string; tools?: string[]; noise?: boolean; linger?: boolean; crash?: boolean } = {}): string {
    const script = `
const readline = require("readline");
${o.crash ? 'process.stderr.write("boom\\n"); process.exit(3);' : ""}
${o.noise ? 'process.stdout.write("starting up\\n");' : ""}
${o.linger ? "setInterval(() => {}, 1000);" : ""}
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: ${JSON.stringify(o.name ?? "reprompty")}, version: ${JSON.stringify(o.version ?? "0.3.0")} } } });
  if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: ${JSON.stringify(o.tools ?? TOOLS)}.map((name) => ({ name })) } });
  if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "called " + m.params.name + " " + JSON.stringify(m.params.arguments) }] } });
}).on("close", () => { ${o.linger ? "" : "process.exit(0);"} });
`;
    return writeFile(path.join(t.root, `server-${Math.random().toString(36).slice(2)}.js`), script);
  }

  const run = (server: string, extra: Parameters<typeof mcpHandshake>[1] = {}) =>
    mcpHandshake({ command: process.execPath, args: [server], env: {} }, { timeoutMs: 10_000, ...extra });

  it("passes for a server that meets every criterion", async () => {
    const result = await run(fakeServer(), { expectVersion: "0.3.0" });
    expect(result).toMatchObject({ ok: true, name: "reprompty", version: "0.3.0", tools: 26, problems: [] });
  });

  it("checks the version against package.json", async () => {
    const result = await run(fakeServer({ version: "0.2.0" }), { expectVersion: "0.3.0" });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["Version 0.2.0 differs from package.json (0.3.0)"]);
  });

  it("fails on stdout lines that aren't JSON", async () => {
    const result = await run(fakeServer({ noise: true }));
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["stdout line 1 isn't JSON: starting up"]);
  });

  it("needs 26 tools including the main ones", async () => {
    const result = await run(fakeServer({ tools: ["detect_windows", "send_prompt"] }));
    expect(result.problems).toEqual([
      "2 tools, expected at least 26",
      "Missing tools: spawn_window, apply_layout, check_cdp",
    ]);
  });

  it("needs the right server name", async () => {
    const result = await run(fakeServer({ name: "other" }));
    expect(result.problems).toEqual(["Server name is other, expected reprompty"]);
  });

  it("fails when the server doesn't exit after stdin closes", async () => {
    const result = await run(fakeServer({ linger: true }), { exitTimeoutMs: 300 });
    expect(result.problems).toEqual(["Didn't exit within 0.3 s after stdin closed"]);
  });

  it("reports a server that crashes, with its last stderr lines", async () => {
    const result = await run(fakeServer({ crash: true }));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("The server stopped (exit code 3)");
    expect(result.stderr).toBe("boom");
  });

  it("reports a command that doesn't exist", async () => {
    const result = await mcpHandshake({ command: path.join(t.root, "missing-node"), args: [], env: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Can't start /);
  });

  it("can call one tool", async () => {
    const result = await run(fakeServer(), { call: "detect_windows", args: { all: true } });
    expect(result.ok).toBe(true);
    expect(result.result).toBe('called detect_windows {"all":true}');
  });
});
