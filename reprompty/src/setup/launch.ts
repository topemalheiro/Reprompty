import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { findExecutable } from "../core/which.js";
import { appImageRuntimeDir, type InstallContext } from "./context.js";
import { installDesktopEntry, managedDesktopEntryExists } from "./desktop-entry.js";
import { copyFileAtomic, readTextFile, writeFileAtomic } from "./fs-safe.js";

export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface LaunchOptions {
  findExecutable?: (names: string | string[]) => string | null;
  execPath?: string;
  electron?: boolean;
}

export const SERVER_NAME = "reprompty";
export const MIN_TOOLS = 26;
export const REQUIRED_TOOLS = ["detect_windows", "send_prompt", "spawn_window", "apply_layout", "check_cdp"];

const PROTOCOL_VERSION = "2024-11-05";
const EXIT_TIMEOUT_MS = 10_000;

export function appImageWrapperPath(): string {
  return path.join(appImageRuntimeDir(), "bin", "reprompty-mcp");
}

/** The command agents run to start this install's MCP server. */
export function resolveMcpLaunch(ctx: InstallContext, o: LaunchOptions = {}): McpLaunch {
  const find = o.findExecutable ?? findExecutable;
  const electron = o.electron ?? Boolean(process.versions.electron);
  const execPath = o.execPath ?? process.execPath;
  const runAsNode = (runtime: string): McpLaunch => ({
    command: runtime,
    args: [ctx.serverJs],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });

  if (ctx.kind === "appimage") return { command: appImageWrapperPath(), args: [], env: {} };
  if (ctx.kind !== "source" && ctx.runtime) return runAsNode(ctx.runtime);

  // Under plain Node the running binary works even when PATH doesn't list it.
  const node = find("node") ?? (electron ? null : execPath);
  if (node) return { command: node, args: [ctx.serverJs], env: {} };
  if (ctx.runtime) return runAsNode(ctx.runtime);
  return { command: "node", args: [ctx.serverJs], env: {} };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// No external commands: some agents start MCP servers with a trimmed PATH.
export function appImageWrapper(appImage: string, dir = appImageRuntimeDir()): string {
  return [
    "#!/bin/sh",
    `APPIMAGE_PATH=${shellQuote(appImage)}`,
    `DIR=${shellQuote(dir)}`,
    '[ -x "$APPIMAGE_PATH" ] && ELECTRON_RUN_AS_NODE=1 exec "$APPIMAGE_PATH" "$DIR/dist/mcp/server.js" "$@"',
    'exec node "$DIR/dist/mcp/server.js" "$@"',
    "",
  ].join("\n");
}

/**
 * Copy the MCP server out of the AppImage mount and point the wrapper at the
 * current AppImage, so registrations survive moving or upgrading it.
 * Returns the wrapper's path.
 */
export function syncAppImageRuntime(ctx: InstallContext): string {
  if (!ctx.appImage) throw new Error("Reprompty isn't running from an AppImage");
  const base = appImageRuntimeDir();
  const copies: Array<[string, string]> = [
    [ctx.serverJs, path.join(base, "dist", "mcp", "server.js")],
    [path.join(ctx.appRoot, "package.json"), path.join(base, "package.json")],
  ];
  if (ctx.layoutScript) copies.push([ctx.layoutScript, path.join(base, "layout", "linux_layout.py")]);
  for (const [from, to] of copies) copyFileAtomic(from, to);

  const wrapper = appImageWrapperPath();
  const text = appImageWrapper(ctx.appImage);
  if (readTextFile(wrapper)?.text !== text) writeFileAtomic(wrapper, text, { mode: 0o755 });
  if ((fs.statSync(wrapper).mode & 0o777) !== 0o755) fs.chmodSync(wrapper, 0o755);

  if (managedDesktopEntryExists()) installDesktopEntry(ctx);
  return wrapper;
}

export interface HandshakeOptions {
  call?: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
  /** The version the server must report; null or undefined skips the check */
  expectVersion?: string | null;
  /** How long the server may take to exit once stdin closes */
  exitTimeoutMs?: number;
}

export interface HandshakeResult {
  ok: boolean;
  name?: string;
  version?: string;
  tools?: number;
  toolNames?: string[];
  result?: string;
  error?: string;
  /** Criteria the server missed */
  problems: string[];
  /** The last lines the server wrote to stderr, when something went wrong */
  stderr?: string;
}

interface RpcMessage {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shorten(text: string, max = 100): string {
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

function resultText(result: Record<string, unknown> | undefined): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .map((item) => (item && typeof item === "object" && typeof item.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Start the server, run initialize and tools/list (and optionally one tool),
 * close stdin and check the MCP test criteria.
 */
export async function mcpHandshake(l: McpLaunch, o: HandshakeOptions = {}): Promise<HandshakeResult> {
  const problems: string[] = [];
  const out: HandshakeResult = { ok: false, problems };
  const timeoutMs = o.timeoutMs ?? 30_000;
  const exitTimeoutMs = o.exitTimeoutMs ?? EXIT_TIMEOUT_MS;

  let child: ChildProcess;
  try {
    child = spawn(l.command, l.args, {
      env: { ...process.env, ...l.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    out.error = `Can't start ${l.command}: ${errorMessage(err)}`;
    return out;
  }

  const stderrTail: string[] = [];
  const pending = new Map<unknown, { resolve: (m: RpcMessage) => void; reject: (e: Error) => void }>();
  let exited = false;
  let failure: Error | null = null;
  let exitWaiter: (() => void) | null = null;
  let lineNumber = 0;
  let buffer = "";

  const failAll = (err: Error) => {
    failure ??= err;
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
  };

  child.on("error", (err) => failAll(new Error(`Can't start ${l.command}: ${err.message}`)));
  child.on("exit", (code, signal) => {
    exited = true;
    exitWaiter?.();
    // Answers can still sit in the pipe when the process is already gone.
    const stopped = () => failAll(new Error(`The server stopped (${signal ?? `exit code ${code}`})`));
    if (child.stdout!.readableEnded) return stopped();
    child.stdout!.once("end", stopped);
    setTimeout(stopped, 500).unref();
  });
  child.stdin!.on("error", () => {});
  child.stderr!.setEncoding("utf-8");
  child.stderr!.on("data", (chunk: string) => {
    stderrTail.push(...chunk.split(/\r?\n/).filter(Boolean));
    stderrTail.splice(0, Math.max(0, stderrTail.length - 20));
  });
  child.stdout!.setEncoding("utf-8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      lineNumber++;
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        problems.push(`stdout line ${lineNumber} isn't JSON: ${shorten(line)}`);
        continue;
      }
      if (message && typeof message === "object" && pending.has(message.id)) {
        pending.get(message.id)!.resolve(message);
        pending.delete(message.id);
      }
    }
  });

  const send = (message: Record<string, unknown>) => child.stdin!.write(JSON.stringify(message) + "\n");
  const request = (id: number, method: string, params: Record<string, unknown>, ms: number) =>
    new Promise<RpcMessage>((resolve, reject) => {
      if (failure) return reject(failure);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`No answer to ${method} within ${Math.round(ms / 1000)} s`));
      }, ms);
      pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  const waitForExit = (ms: number) =>
    new Promise<boolean>((resolve) => {
      if (exited) return resolve(true);
      const timer = setTimeout(() => resolve(false), ms);
      exitWaiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });

  try {
    const init = await request(
      1,
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "reprompty-setup", version: "1.0.0" },
      },
      timeoutMs
    );
    if (init.error) throw new Error(`initialize failed: ${init.error.message ?? "unknown error"}`);
    const info = init.result?.serverInfo as { name?: unknown; version?: unknown } | undefined;
    out.name = typeof info?.name === "string" ? info.name : undefined;
    out.version = typeof info?.version === "string" ? info.version : undefined;
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const list = await request(2, "tools/list", {}, timeoutMs);
    if (list.error) throw new Error(`tools/list failed: ${list.error.message ?? "unknown error"}`);
    const tools = Array.isArray(list.result?.tools) ? (list.result!.tools as Array<{ name?: unknown }>) : [];
    out.toolNames = tools.map((tool) => tool?.name).filter((name): name is string => typeof name === "string");
    out.tools = out.toolNames.length;

    if (o.call) {
      const called = await request(
        3,
        "tools/call",
        { name: o.call, arguments: o.args ?? {} },
        Math.max(timeoutMs, 120_000)
      );
      if (called.error) {
        problems.push(`${o.call} failed: ${called.error.message ?? "unknown error"}`);
      } else {
        out.result = resultText(called.result);
        if (called.result?.isError) problems.push(`${o.call} returned an error`);
      }
    }
  } catch (err) {
    out.error = errorMessage(err);
  }

  if (out.error) {
    if (!exited) child.kill();
  } else {
    child.stdin!.end();
    if (!(await waitForExit(exitTimeoutMs))) {
      problems.push(`Didn't exit within ${exitTimeoutMs / 1000} s after stdin closed`);
      child.kill();
    }
  }

  if (!out.error) {
    if (out.name !== SERVER_NAME) problems.push(`Server name is ${out.name ?? "missing"}, expected ${SERVER_NAME}`);
    if (o.expectVersion && out.version !== o.expectVersion) {
      problems.push(`Version ${out.version ?? "missing"} differs from package.json (${o.expectVersion})`);
    }
    if ((out.tools ?? 0) < MIN_TOOLS) problems.push(`${out.tools ?? 0} tools, expected at least ${MIN_TOOLS}`);
    const missing = REQUIRED_TOOLS.filter((name) => !out.toolNames?.includes(name));
    if (missing.length > 0) problems.push(`Missing tools: ${missing.join(", ")}`);
  }
  if (out.error && stderrTail.length > 0) out.stderr = stderrTail.slice(-5).map((line) => shorten(line, 300)).join("\n");
  out.ok = !out.error && problems.length === 0;
  return out;
}
