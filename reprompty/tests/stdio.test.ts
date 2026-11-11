import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const pkgRoot = path.resolve(__dirname, "..");

let esbuild: typeof import("esbuild") | null = null;
try {
  esbuild = await import("esbuild");
} catch {
  console.warn("Skipping the MCP stdio test: esbuild is not installed (run npm install in reprompty/).");
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// Laid out like the package (dist/mcp/server.js beside package.json), so the
// server finds its version the way an installed copy does.
async function buildServer(): Promise<string> {
  const root = makeTempDir("reprompty-mcp-bundle-");
  const outfile = path.join(root, "dist", "mcp", "server.js");
  await esbuild!.build({
    entryPoints: [path.join(pkgRoot, "src", "mcp", "server.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    mainFields: ["module", "main"],
    external: ["electron"],
    outfile,
    logLevel: "silent",
  });
  fs.copyFileSync(path.join(pkgRoot, "package.json"), path.join(root, "package.json"));
  return outfile;
}

function runServer(
  serverJs: string,
  input: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const home = makeTempDir("reprompty-mcp-home-");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverJs], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`The MCP server did not exit. stderr:\n${stderr}`));
    }, 30_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

describe.skipIf(!esbuild)("MCP server over stdio", () => {
  it("writes only JSON-RPC to stdout", async () => {
    const serverJs = await buildServer();
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "reprompty-tests", version: "0.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ];
    const input = requests.map((request) => JSON.stringify(request)).join("\n") + "\n";

    const { code, stdout, stderr } = await runServer(serverJs, input);

    expect(code, stderr).toBe(0);
    const lines = stdout.split("\n").filter((line) => line.trim());
    for (const line of lines) {
      expect(() => JSON.parse(line), `stdout line is not JSON: ${line}`).not.toThrow();
    }
    const responses = lines.map((line) => JSON.parse(line));
    expect(responses.map((response) => response.id)).toEqual([1, 2]);

    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf-8"));
    expect(responses[0].result.serverInfo).toEqual({ name: "reprompty", version: pkg.version });
    expect(responses[1].result.tools.length).toBeGreaterThanOrEqual(26);

    // The server does log; it has to go to stderr.
    expect(stderr).toContain("[Reprompty MCP] Server started on stdio");
  }, 60_000);
});
