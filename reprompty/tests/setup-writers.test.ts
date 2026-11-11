import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readArgvPort } from "../src/core/vscode-paths.ts";
import { clientStatus, registerClient, unregisterClient } from "../src/setup/clients.ts";
import type { McpLaunch } from "../src/setup/launch.ts";
import { removeCdpPort, setCdpPort } from "../src/setup/vscode.ts";
import { backupFiles, fixtureText, makeTempHome, writeFile, type TempHome } from "./fixtures/setup/temp-home.ts";

const isWindows = process.platform === "win32";

const nodeLaunch: McpLaunch = {
  command: "/opt/node/bin/node",
  args: ["/home/example/Reprompty/reprompty/dist/mcp/server.js"],
  env: {},
};

const electronLaunch: McpLaunch = {
  command: "/opt/Reprompty/reprompty",
  args: ["/opt/Reprompty/resources/app/dist/mcp/server.js"],
  env: { ELECTRON_RUN_AS_NODE: "1" },
};

let t: TempHome;

beforeEach(() => {
  t = makeTempHome();
});

afterEach(() => {
  t.restore();
});

function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

function json(file: string): Record<string, any> {
  return parse(read(file), [], { allowTrailingComma: true });
}

function commentLines(text: string): string[] {
  return text.split("\n").filter((line) => /^\s*(\/\/|\/\*|#)/.test(line) || /\/\/ /.test(line));
}

describe("argv.json debugging port", () => {
  it("adds the port as a string and keeps every comment", () => {
    const argv = t.seed("argv.json", ".vscode", "argv.json");
    const result = setCdpPort(argv, "9222");
    expect(result).toMatchObject({ ok: true, changed: true, files: [argv] });

    const text = read(argv);
    expect(text).toContain('"remote-debugging-port": "9222"');
    expect(json(argv)["remote-debugging-port"]).toBe("9222");
    expect(readArgvPort(argv)).toBe("9222");
    for (const line of commentLines(fixtureText("argv.json"))) expect(text).toContain(line);
    expect(json(argv)["crash-reporter-id"]).toBe("00000000-1111-2222-3333-444444444444");
  });

  it("changes nothing and makes no backup on a second run", () => {
    const argv = t.seed("argv.json", ".vscode", "argv.json");
    setCdpPort(argv, "9222");
    const after = read(argv);
    expect(backupFiles(t.home)).toHaveLength(1);

    const again = setCdpPort(argv, "9222");
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(read(argv)).toBe(after);
    expect(backupFiles(t.home)).toHaveLength(1);
  });

  it("rewrites a numeric port as a string", () => {
    const argv = writeFile(t.at(".vscode", "argv.json"), '{\n\t"remote-debugging-port": 9222 // number\n}\n');
    expect(setCdpPort(argv, "9222").changed).toBe(true);
    expect(json(argv)["remote-debugging-port"]).toBe("9222");
  });

  it("creates VS Code's default file when there is none", () => {
    const argv = t.at(".vscode", "argv.json");
    const result = setCdpPort(argv, "9333");
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(result.message).toMatch(/^Created/);
    expect(read(argv)).toMatch(/^\/\/ This configuration file allows you to pass permanent command line arguments/);
    expect(readArgvPort(argv)).toBe("9333");
    expect(backupFiles(t.home)).toHaveLength(0);
  });

  it("leaves a broken file alone", () => {
    const argv = writeFile(t.at(".vscode", "argv.json"), '{ "enable-crash-reporter": true "oops" }');
    const result = setCdpPort(argv, "9222");
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("oops");
    expect(read(argv)).toBe('{ "enable-crash-reporter": true "oops" }');
    expect(backupFiles(t.home)).toHaveLength(0);
  });

  it("only reports what would change on a dry run", () => {
    const argv = t.seed("argv.json", ".vscode", "argv.json");
    const result = setCdpPort(argv, "9222", { dryRun: true });
    expect(result).toMatchObject({ ok: true, changed: true, files: [argv] });
    expect(result.message).toBe('Would change ~/.vscode/argv.json: add "remote-debugging-port": "9222"'.replace(/\//g, path.sep));
    expect(read(argv)).toBe(fixtureText("argv.json"));
    expect(backupFiles(t.home)).toHaveLength(0);
  });

  it("rejects ports that aren't numbers", () => {
    const argv = t.seed("argv.json", ".vscode", "argv.json");
    expect(setCdpPort(argv, "92a2").ok).toBe(false);
    expect(setCdpPort(argv, "70000").ok).toBe(false);
    expect(read(argv)).toBe(fixtureText("argv.json"));
  });

  it("removes the port and keeps the comments", () => {
    const argv = t.seed("argv.json", ".vscode", "argv.json");
    setCdpPort(argv, "9222");
    expect(removeCdpPort(argv).changed).toBe(true);
    expect(readArgvPort(argv)).toBeNull();
    for (const line of commentLines(fixtureText("argv.json"))) expect(read(argv)).toContain(line);
    expect(removeCdpPort(argv).changed).toBe(false);
  });
});

describe("Codex config.toml", () => {
  it("adds only the reprompty table; comments and other tables stay", async () => {
    const config = t.seed("config.toml", ".codex", "config.toml");
    const result = await registerClient("codex", electronLaunch);
    expect(result).toMatchObject({ ok: true, changed: true, files: [config] });

    const original = fixtureText("config.toml");
    expect(read(config)).toBe(
      original +
        [
          "",
          "[mcp_servers.reprompty]",
          'command = "/opt/Reprompty/reprompty"',
          'args = ["/opt/Reprompty/resources/app/dist/mcp/server.js"]',
          'env = { ELECTRON_RUN_AS_NODE = "1" }',
          "tool_timeout_sec = 120",
          "",
        ].join("\n")
    );
    expect(clientStatus("codex", electronLaunch).state).toBe("registered");
  });

  it("changes nothing on a second run", async () => {
    const config = t.seed("config.toml", ".codex", "config.toml");
    await registerClient("codex", nodeLaunch);
    const after = read(config);
    const again = await registerClient("codex", nodeLaunch);
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(read(config)).toBe(after);
    expect(backupFiles(t.home)).toHaveLength(1);
  });

  it("replaces a quoted header in place and keeps the keys it doesn't manage", async () => {
    const config = t.seed("config-quoted.toml", ".codex", "config.toml");
    expect(clientStatus("codex", nodeLaunch).state).toBe("different");
    await registerClient("codex", nodeLaunch);
    expect(read(config)).toBe(
      [
        "# Codex settings",
        'model = "gpt-5-codex"',
        "",
        "[mcp_servers.reprompty]",
        'command = "/opt/node/bin/node"',
        'args = ["/home/example/Reprompty/reprompty/dist/mcp/server.js"]',
        "tool_timeout_sec = 120",
        "startup_timeout_sec = 30",
        "",
        "# Another server after ours",
        "[mcp_servers.docs]",
        'command = "docs-mcp"',
        "",
      ].join("\n")
    );
  });

  it("replaces the table together with its env subtable", async () => {
    const config = t.seed("config-env-subtable.toml", ".codex", "config.toml");
    expect(clientStatus("codex", electronLaunch)).toMatchObject({ state: "different" });
    await registerClient("codex", electronLaunch);
    const text = read(config);
    expect(text).not.toContain("[mcp_servers.reprompty.env]");
    expect(text).not.toContain("OLD_SETTING");
    expect(text).toContain('env = { ELECTRON_RUN_AS_NODE = "1" }');
    expect(text.endsWith('# Notes about the next server\n[mcp_servers.other]\ncommand = "other-mcp"\nargs = ["--stdio"]\n')).toBe(true);
    expect(clientStatus("codex", electronLaunch).state).toBe("registered");
  });

  it.each(["config-inline.toml", "config-dotted.toml"])("refuses to edit %s", async (fixture) => {
    const config = t.seed(fixture, ".codex", "config.toml");
    const result = await registerClient("codex", nodeLaunch);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/by hand/);
    expect(read(config)).toBe(fixtureText(fixture));
    expect(backupFiles(t.home)).toHaveLength(0);
  });

  it("uses CODEX_HOME", async () => {
    process.env.CODEX_HOME = t.at("codex-home");
    fs.mkdirSync(process.env.CODEX_HOME);
    await registerClient("codex", nodeLaunch);
    expect(read(t.at("codex-home", "config.toml"))).toContain("[mcp_servers.reprompty]");
  });

  it("removes only its table", async () => {
    const config = t.seed("config.toml", ".codex", "config.toml");
    await registerClient("codex", electronLaunch);
    expect((await unregisterClient("codex")).changed).toBe(true);
    expect(read(config)).toBe(fixtureText("config.toml"));
  });
});

describe("Kilo CLI kilo.jsonc", () => {
  it("adds mcp.servers.reprompty and keeps other keys and comments", async () => {
    const config = t.seed("kilo.jsonc", ".config", "kilo", "kilo.jsonc");
    const result = await registerClient("kilo-cli", electronLaunch);
    expect(result).toMatchObject({ ok: true, changed: true });

    const after = json(config);
    expect(after.mcp.servers.reprompty).toEqual({
      type: "local",
      command: ["/opt/Reprompty/reprompty", "/opt/Reprompty/resources/app/dist/mcp/server.js"],
      environment: { ELECTRON_RUN_AS_NODE: "1" },
    });
    const { mcp: _mcp, ...rest } = after;
    expect(rest).toEqual(parse(fixtureText("kilo.jsonc")));
    for (const line of commentLines(fixtureText("kilo.jsonc"))) expect(read(config)).toContain(line.trim());

    expect((await registerClient("kilo-cli", electronLaunch)).changed).toBe(false);
    expect(backupFiles(t.home)).toHaveLength(1);
  });

  it("moves the deprecated flat entry to mcp.servers", async () => {
    const config = writeFile(
      t.at(".config", "kilo", "kilo.jsonc"),
      '{\n  // mine\n  "mcp": {\n    "reprompty": { "type": "local", "command": ["node", "/old/server.js"] },\n    "docs": { "type": "remote", "url": "https://example.com/mcp" }\n  }\n}\n'
    );
    expect(clientStatus("kilo-cli", nodeLaunch).state).toBe("different");
    await registerClient("kilo-cli", nodeLaunch);
    const after = json(config);
    expect(after.mcp.reprompty).toBeUndefined();
    expect(after.mcp.docs).toEqual({ type: "remote", url: "https://example.com/mcp" });
    expect(after.mcp.servers.reprompty.command).toEqual([nodeLaunch.command, ...nodeLaunch.args]);
    expect(read(config)).toContain("// mine");
  });

  it("isn't detected without a kilo config", () => {
    expect(clientStatus("kilo-cli", nodeLaunch)).toMatchObject({ installed: false, configPath: null });
  });
});

describe("JSON configs with other servers", () => {
  it("Claude Code (no CLI): adds the entry and leaves the rest of ~/.claude.json alone", async () => {
    const config = t.seed("claude.json", ".claude.json");
    fs.mkdirSync(t.at(".claude"));
    const result = await registerClient("claude", nodeLaunch);
    expect(result).toMatchObject({ ok: true, changed: true, files: [config] });

    const before = JSON.parse(fixtureText("claude.json"));
    const after = json(config);
    expect(after.mcpServers.reprompty).toEqual({ type: "stdio", ...nodeLaunch });
    expect(after.mcpServers.github).toEqual(before.mcpServers.github);
    const { mcpServers: _a, ...restAfter } = after;
    const { mcpServers: _b, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
    expect(clientStatus("claude", nodeLaunch).state).toBe("registered");

    expect((await registerClient("claude", nodeLaunch)).changed).toBe(false);
    expect(backupFiles(t.home)).toHaveLength(1);
  });

  it("Kimi CLI: adds the entry next to the other servers", async () => {
    const config = t.seed("kimi-mcp.json", ".kimi", "mcp.json");
    await registerClient("kimi-cli", electronLaunch);
    const after = json(config);
    const before = JSON.parse(fixtureText("kimi-mcp.json"));
    expect(after.mcpServers.context7).toEqual(before.mcpServers.context7);
    expect(after.mcpServers.playwright).toEqual(before.mcpServers.playwright);
    expect(after.mcpServers.reprompty).toEqual(electronLaunch);
    expect((await registerClient("kimi-cli", electronLaunch)).changed).toBe(false);
  });

  it("Kimi Code: creates mcp.json, readable only by the user", async () => {
    process.env.KIMI_CODE_HOME = t.at("kimi-code-home");
    fs.mkdirSync(process.env.KIMI_CODE_HOME);
    const result = await registerClient("kimi-code", nodeLaunch);
    const config = t.at("kimi-code-home", "mcp.json");
    expect(result.message).toMatch(/^Created/);
    expect(json(config)).toEqual({ mcpServers: { reprompty: nodeLaunch } });
    if (!isWindows) expect(fs.statSync(config).mode & 0o777).toBe(0o600);
    expect(backupFiles(t.home)).toHaveLength(0);
  });

  it("Kilo Code: sets a 120 s timeout and keeps the tool approvals", async () => {
    const userData = isWindows ? ["AppData", "Roaming", "Code"] : [".config", "Code"];
    const config = t.seed(
      "kilo-mcp_settings.json",
      ...userData,
      "User",
      "globalStorage",
      "kilocode.kilo-code",
      "settings",
      "mcp_settings.json"
    );
    const status = clientStatus("kilo", nodeLaunch);
    expect(status).toMatchObject({ installed: true, state: "different", configPath: config });
    expect(status.detail).toContain("command node -> /opt/node/bin/node");

    await registerClient("kilo", nodeLaunch);
    const after = json(config);
    const before = JSON.parse(fixtureText("kilo-mcp_settings.json"));
    expect(after.mcpServers.filesystem).toEqual(before.mcpServers.filesystem);
    expect(after.mcpServers.reprompty).toEqual({
      ...nodeLaunch,
      timeout: 120,
      alwaysAllow: ["detect_windows", "list_virtual_desktops"],
    });
    expect(clientStatus("kilo", nodeLaunch).state).toBe("registered");
  });

  it("refuses a config that isn't valid JSON and never prints its content", async () => {
    const config = writeFile(t.at(".kimi", "mcp.json"), '{ "mcpServers": { "secret-token-123" } }');
    const status = clientStatus("kimi-cli", nodeLaunch);
    expect(status.error).toMatch(/syntax error at line 1/);
    const result = await registerClient("kimi-cli", nodeLaunch);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("secret-token-123");
    expect(read(config)).toBe('{ "mcpServers": { "secret-token-123" } }');
  });

  it("removes only its own entry", async () => {
    const config = t.seed("kimi-mcp.json", ".kimi", "mcp.json");
    await registerClient("kimi-cli", nodeLaunch);
    expect((await unregisterClient("kimi-cli")).changed).toBe(true);
    expect(json(config)).toEqual(JSON.parse(fixtureText("kimi-mcp.json")));
  });
});

describe.skipIf(isWindows)("Claude Code through its CLI", () => {
  function fakeClaude(failAdd = false): string {
    const log = path.join(t.root, "claude-calls.jsonl");
    const script = `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const file = require("path").join(process.env.HOME, ".claude.json");
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : {};
config.mcpServers = config.mcpServers || {};
if (args[1] === "remove") {
  if (!config.mcpServers[args[4]]) process.exit(1);
  delete config.mcpServers[args[4]];
} else if (args[1] === "add-json") {
  if (${failAdd} || config.mcpServers[args[4]]) process.exit(1);
  config.mcpServers[args[4]] = JSON.parse(args[5]);
}
fs.writeFileSync(file, JSON.stringify(config, null, 2));
`;
    writeFile(path.join(t.bin, "claude"), script, 0o755);
    return log;
  }

  function calls(log: string): string[][] {
    return fs.existsSync(log) ? read(log).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  }

  it("replaces the entry with claude mcp remove and add-json", async () => {
    const log = fakeClaude();
    const config = t.seed("claude.json", ".claude.json");
    writeFile(config, JSON.stringify({ ...JSON.parse(fixtureText("claude.json")), mcpServers: { reprompty: { command: "/old" } } }));

    const result = await registerClient("claude", electronLaunch);
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(calls(log)).toEqual([
      ["mcp", "remove", "--scope", "user", "reprompty"],
      ["mcp", "add-json", "--scope", "user", "reprompty", JSON.stringify({ type: "stdio", ...electronLaunch })],
    ]);
    expect(json(config).mcpServers.reprompty).toEqual({ type: "stdio", ...electronLaunch });
    expect(backupFiles(t.home)).toHaveLength(1);

    expect((await registerClient("claude", electronLaunch)).changed).toBe(false);
    expect(calls(log)).toHaveLength(2);
  });

  it("only says what it would run on a dry run", async () => {
    const log = fakeClaude();
    const config = t.seed("claude.json", ".claude.json");
    const result = await registerClient("claude", nodeLaunch, { dryRun: true });
    expect(result.message).toMatch(/^Would change .*\.claude\.json: add mcpServers\.reprompty, through .*claude mcp add-json$/);
    expect(calls(log)).toHaveLength(0);
    expect(read(config)).toBe(fixtureText("claude.json"));
  });

  it("edits ~/.claude.json itself when the CLI fails", async () => {
    fakeClaude(true);
    const config = t.seed("claude.json", ".claude.json");
    const result = await registerClient("claude", nodeLaunch);
    expect(result.ok).toBe(true);
    expect(json(config).mcpServers.reprompty).toEqual({ type: "stdio", ...nodeLaunch });
    expect(json(config).mcpServers.github).toEqual(JSON.parse(fixtureText("claude.json")).mcpServers.github);
  });

  it("finds the CLI bundled with the newest Claude Code extension", async () => {
    const extensions = t.at(".vscode", "extensions");
    for (const version of ["2.1.9", "2.1.10"]) {
      writeFile(
        path.join(extensions, `anthropic.claude-code-${version}-linux-x64`, "resources", "native-binary", "claude"),
        `#!/bin/sh\necho ${version} >> ${JSON.stringify(path.join(t.root, "which.txt"))}\nexit 1\n`,
        0o755
      );
    }
    t.seed("claude.json", ".claude.json");
    await registerClient("claude", nodeLaunch);
    expect(read(path.join(t.root, "which.txt")).trim()).toBe("2.1.10");
  });
});

describe("backups", () => {
  it("are made only when a file changes, readable only by the user", async () => {
    t.seed("config.toml", ".codex", "config.toml");
    t.seed("kimi-mcp.json", ".kimi", "mcp.json");
    const argv = t.seed("argv.json", ".vscode", "argv.json");
    await registerClient("codex", nodeLaunch);
    await registerClient("kimi-cli", nodeLaunch);
    setCdpPort(argv, "9222");
    const first = backupFiles(t.home);
    expect(first).toHaveLength(3);
    if (!isWindows) for (const file of first) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(read(first.find((file) => file.endsWith("argv.json"))!)).toBe(fixtureText("argv.json"));

    await registerClient("codex", nodeLaunch);
    await registerClient("kimi-cli", nodeLaunch);
    setCdpPort(argv, "9222");
    expect(backupFiles(t.home)).toEqual(first);
  });
});
