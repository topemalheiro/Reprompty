import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/setup/cli.ts";
import { backupFiles, fixtureText, listFiles, makeTempHome, writeFile, type TempHome } from "./fixtures/setup/temp-home.ts";

const isWindows = process.platform === "win32";

// Answers like the real server: 26 tools, the version from its package.json.
const FAKE_SERVER = `
const fs = require("fs");
const path = require("path");
const version = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8")).version;
const tools = ["detect_windows", "send_prompt", "spawn_window", "apply_layout", "check_cdp"];
for (let i = tools.length; i < 26; i++) tools.push("tool_" + i);
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "reprompty", version } } });
  if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: tools.map((name) => ({ name })) } });
}).on("close", () => process.exit(0));
`;

let t: TempHome;
let pkg: string;

beforeEach(() => {
  t = makeTempHome();
  pkg = path.join(t.root, "Reprompty", "reprompty");
  writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "reprompty", version: "0.3.0" }));
  writeFile(path.join(pkg, "dist", "mcp", "server.js"), FAKE_SERVER);
  writeFile(path.join(pkg, "skills", "reprompty", "SKILL.md"), "---\nname: reprompty\ndescription: test\n---\n");
});

afterEach(() => {
  t.restore();
});

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  });
  try {
    return { code: await runCli(args), out, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    listFiles(dir).map((file) => [file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")])
  );
}

function seedAgents(): void {
  fs.mkdirSync(t.at(".claude"));
  t.seed("claude.json", ".claude.json");
  t.seed("config.toml", ".codex", "config.toml");
  t.seed("kimi-mcp.json", ".kimi", "mcp.json");
  t.seed("kilo.jsonc", ".config", "kilo", "kilo.jsonc");
  t.seed("argv.json", ".vscode", "argv.json");
  fs.mkdirSync(isWindows ? t.at("AppData", "Roaming", "Code") : t.at(".config", "Code"), { recursive: true });
}

describe("usage", () => {
  it("prints help", async () => {
    const result = await cli("--help");
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^Usage: setup/);
  });

  it.each([["bogus"], ["mcp", "--client", "nope"], ["cdp", "--port", "http"], ["mcp-test", "--args", "[1]"], ["doctor", "--frobnicate"]])(
    "exits 2 for %j",
    async (...args) => {
      const result = await cli(...args, "--root", pkg);
      expect(result.code).toBe(2);
      expect(result.err).not.toBe("");
    }
  );
});

describe("doctor", () => {
  it("prints JSON checks and never writes", async () => {
    seedAgents();
    const before = snapshot(t.home);
    const result = await cli("doctor", "--json", "--root", pkg);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({ version: "0.3.0", kind: "source", appRoot: pkg });
    const byId = Object.fromEntries(report.checks.map((check: { id: string }) => [check.id, check]));
    expect(byId["app.server"].status).toBe("ok");
    expect(byId["app.skill"].status).toBe("ok");
    expect(byId["vscode.port:code"]).toMatchObject({ status: "fail", action: { id: "cdp.enable:code" } });
    expect(byId["mcp:codex"]).toMatchObject({ status: "fail", action: { id: "mcp.register:codex" } });
    expect(byId["mcp:kimi-code"]).toMatchObject({ status: "info", detail: "Not installed" });
    expect(snapshot(t.home)).toEqual(before);
  });

  it("can start the server too", async () => {
    const result = await cli("doctor", "--json", "--deep", "--root", pkg);
    const check = JSON.parse(result.out).checks.find((entry: { id: string }) => entry.id === "app.handshake");
    expect(check).toMatchObject({ status: "ok", detail: "26 tools, version 0.3.0" });
  });

  it("says how to fix what failed", async () => {
    seedAgents();
    const result = await cli("doctor", "--root", pkg);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/FAIL\s+Codex MCP server\s+Not registered/);
    expect(result.out).toMatch(/fix: .* mcp --client codex/);
  });
});

describe("all", () => {
  it("--dry-run lists the files it would change and writes nothing", async () => {
    seedAgents();
    const before = snapshot(t.home);
    const result = await cli("all", "--dry-run", "--root", pkg);
    expect(result.code).toBe(0);
    const sep = path.sep;
    for (const line of [
      `Would change ~${sep}.vscode${sep}argv.json: add "remote-debugging-port": "9222"`,
      `Would change ~${sep}.claude.json: add mcpServers.reprompty`,
      `Would change ~${sep}.codex${sep}config.toml: add [mcp_servers.reprompty]`,
      `Would change ~${sep}.kimi${sep}mcp.json: add mcpServers.reprompty`,
      `Would change ~${sep}.config${sep}kilo${sep}kilo.jsonc: add mcp.servers.reprompty`,
      `Would create ~${sep}.claude${sep}skills${sep}reprompty${sep}SKILL.md`,
    ]) {
      expect(result.out).toContain(line);
    }
    expect(result.out).toMatch(/Dry run: \d+ files would change\. Nothing was written\./);
    expect(result.out).not.toContain("github-token");
    expect(snapshot(t.home)).toEqual(before);
  });

  it("--dry-run --json lists the files", async () => {
    seedAgents();
    const result = await cli("all", "--dry-run", "--json", "--root", pkg);
    const report = JSON.parse(result.out);
    expect(report.dryRun).toBe(true);
    expect(report.files).toContain(t.at(".codex", "config.toml"));
    expect(backupFiles(t.home)).toEqual([]);
  });

  // On Windows this would install the VirtualDesktop module.
  it.skipIf(isWindows)("sets everything up once; the second run has nothing to do", async () => {
    seedAgents();
    const first = await cli("all", "--yes", "--root", pkg);
    expect(first.code).toBe(0);
    expect(first.out).toContain("Backups are in");
    expect(fs.readFileSync(t.at(".codex", "config.toml"), "utf-8")).toContain("[mcp_servers.reprompty]");
    const after = snapshot(t.home);

    const second = await cli("all", "--yes", "--root", pkg);
    expect(second.code).toBe(0);
    expect(second.out).toContain("Everything is already set up.");
    expect(snapshot(t.home)).toEqual(after);
  });
});

describe("mcp", () => {
  it("--print shows the config without writing it", async () => {
    seedAgents();
    const before = snapshot(t.home);
    const result = await cli("mcp", "--print", "--client", "codex", "--root", pkg);
    expect(result.code).toBe(0);
    expect(result.out).toContain("[mcp_servers.reprompty]");
    expect(result.out).toContain(JSON.stringify(path.join(pkg, "dist", "mcp", "server.js")));
    expect(snapshot(t.home)).toEqual(before);
  });

  it("registers and removes one client", async () => {
    seedAgents();
    expect((await cli("mcp", "--client", "kimi-cli", "--root", pkg)).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(t.at(".kimi", "mcp.json"), "utf-8")).mcpServers.reprompty).toBeDefined();
    expect((await cli("mcp", "--client", "kimi-cli", "--remove", "--root", pkg)).code).toBe(0);
    expect(fs.readFileSync(t.at(".kimi", "mcp.json"), "utf-8")).toBe(fixtureText("kimi-mcp.json"));
  });
});

describe("mcp-test", () => {
  it("passes against this install's server", async () => {
    const result = await cli("mcp-test", "--root", pkg);
    expect(result.out).toContain("Server:   reprompty 0.3.0");
    expect(result.out).toContain("MCP test passed.");
    expect(result.code).toBe(0);
  });

  it("can test any server file", async () => {
    const server = writeFile(path.join(t.root, "elsewhere", "server.js"), FAKE_SERVER.replace(/const version = .*\n/, 'const version = "9.9.9";\n'));
    const result = await cli("mcp-test", "--server", server, "--root", pkg);
    expect(result.out).toContain("Version:  not checked");
    expect(result.code).toBe(0);
  });

  it("tests the command a client registered", async () => {
    seedAgents();
    await cli("mcp", "--client", "codex", "--root", pkg);
    const result = await cli("mcp-test", "--registered", "codex", "--root", pkg);
    expect(result.code).toBe(0);
    expect((await cli("mcp-test", "--registered", "kimi-code", "--root", pkg)).code).toBe(1);
  });

  it("fails when the server isn't built", async () => {
    fs.rmSync(path.join(pkg, "dist"), { recursive: true });
    const result = await cli("mcp-test", "--root", pkg);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/server\.js is missing; build it with npm run build:mcp/);
  });
});
