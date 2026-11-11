import * as http from "node:http";
import * as path from "node:path";
import { groupTargetsByPage, mapTargetUrlToAgent, type CdpTarget } from "../core/cdp-client.js";
import { readDevToolsActivePort, vscodeVariants, type VsCodeVariantId } from "../core/vscode-paths.js";
import { findExecutable } from "../core/which.js";
import { displayPath, isDirectory, type ActionResult } from "./context.js";
import { commitWrite, parseJsonc, readTextFile, setJsoncValue, type TextFile } from "./fs-safe.js";

export const DEFAULT_CDP_PORT = "9222";
export const CDP_SECURITY_NOTE = "Any program on this computer can control VS Code through this port.";
export const CDP_RESTART_HINT = "Quit VS Code completely and reopen it.";

const PORT_KEY = "remote-debugging-port";

const COMMANDS: Record<VsCodeVariantId, string[]> = {
  code: ["code"],
  insiders: ["code-insiders"],
  oss: ["code-oss"],
  vscodium: ["codium", "vscodium"],
};

// What VS Code writes when argv.json is missing.
const DEFAULT_ARGV = [
  "// This configuration file allows you to pass permanent command line arguments to VS Code.",
  "// Only a subset of arguments is currently supported to reduce the likelihood of breaking",
  "// the installation.",
  "//",
  "// PLEASE DO NOT CHANGE WITHOUT UNDERSTANDING THE IMPACT",
  "//",
  "// NOTE: Changing this file requires a restart of VS Code.",
  "{",
  "\t// Use software rendering instead of hardware accelerated rendering.",
  "\t// This can help in cases where you see rendering issues in VS Code.",
  '\t// "disable-hardware-acceleration": true',
  "}",
  "",
].join("\n");

export interface VsCodeVariantInfo {
  id: VsCodeVariantId;
  label: string;
  installed: boolean;
  argvPath: string;
  userDataDir: string;
  command: string | null;
  /** "remote-debugging-port" in argv.json */
  port: string | null;
  /** Written as a number, which VS Code ignores */
  portIsNumber: boolean;
  /** Why argv.json couldn't be read */
  argvError: string | null;
  /** The port in DevToolsActivePort, left by the last start with a debugging port */
  activePort: number | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function windowsCodeDirs(id: VsCodeVariantId): string[] {
  if (process.platform !== "win32") return [];
  const folder = { code: "Microsoft VS Code", insiders: "Microsoft VS Code Insiders", vscodium: "VSCodium", oss: null }[id];
  if (!folder) return [];
  const roots = [path.join(process.env.LOCALAPPDATA ?? "", "Programs"), process.env.ProgramFiles ?? ""];
  return roots.filter((root) => path.isAbsolute(root)).map((root) => path.join(root, folder, "bin"));
}

function readArgv(argvPath: string): { file: TextFile | null; value: Record<string, unknown> | null; error: string | null } {
  let file: TextFile | null;
  try {
    file = readTextFile(argvPath);
  } catch (err) {
    return { file: null, value: null, error: `can't read it (${errorMessage(err)})` };
  }
  if (!file) return { file: null, value: null, error: null };
  const parsed = parseJsonc(file.text);
  if (parsed.error) return { file, value: null, error: parsed.error };
  return { file, value: parsed.value as Record<string, unknown>, error: null };
}

/** One entry per VS Code build; the Flatpak shares argv.json with the regular one. */
export function listVsCodeVariants(): VsCodeVariantInfo[] {
  const byId = new Map<VsCodeVariantId, VsCodeVariantInfo>();
  for (const variant of vscodeVariants()) {
    const hasData = isDirectory(variant.userDataDir);
    const existing = byId.get(variant.id);
    if (existing) {
      if (!existing.installed && hasData) {
        existing.installed = true;
        existing.label = variant.label;
        existing.userDataDir = variant.userDataDir;
        existing.activePort = readDevToolsActivePort(variant.userDataDir);
      }
      continue;
    }
    const command = findExecutable(COMMANDS[variant.id], windowsCodeDirs(variant.id));
    const argv = readArgv(variant.argvPath);
    const raw = argv.value?.[PORT_KEY];
    byId.set(variant.id, {
      id: variant.id,
      label: variant.label,
      installed: hasData || command !== null,
      argvPath: variant.argvPath,
      userDataDir: variant.userDataDir,
      command,
      port: typeof raw === "string" || typeof raw === "number" ? String(raw) : null,
      portIsNumber: typeof raw === "number",
      argvError: argv.error,
      activePort: readDevToolsActivePort(variant.userDataDir),
    });
  }
  return [...byId.values()];
}

export function isValidPort(port: string): boolean {
  return /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
}

/** Writes "remote-debugging-port" as a string (VS Code ignores a number), keeping comments. */
export function setCdpPort(argvPath: string, port: string = DEFAULT_CDP_PORT, o: { dryRun?: boolean } = {}): ActionResult {
  const where = displayPath(argvPath);
  if (!isValidPort(port)) return { ok: false, changed: false, message: `${port} isn't a port number (1-65535)` };
  const argv = readArgv(argvPath);
  if (argv.error) {
    return {
      ok: false,
      changed: false,
      message: `Can't use ${where} (${argv.error}). Fix it with the VS Code command "Preferences: Configure Runtime Arguments" and try again.`,
    };
  }
  const current = argv.value?.[PORT_KEY];
  if (current === port) {
    return { ok: true, changed: false, message: `${where} already sets the debugging port to ${port}` };
  }

  const text = argv.file?.text ?? DEFAULT_ARGV;
  const after = setJsoncValue(text, [PORT_KEY], port);
  const how =
    current === undefined
      ? `add "${PORT_KEY}": "${port}"`
      : `change "${PORT_KEY}" from ${JSON.stringify(current)} to "${port}"`;
  try {
    const { backup } = commitWrite(argvPath, argv.file, after, o);
    const verb = argv.file ? (o.dryRun ? "Would change" : "Changed") : o.dryRun ? "Would create" : "Created";
    return {
      ok: true,
      changed: true,
      message: `${verb} ${where}: ${how}`,
      files: [argvPath],
      backups: backup ? [backup] : [],
      next: CDP_RESTART_HINT,
    };
  } catch (err) {
    return { ok: false, changed: false, message: `Couldn't write ${where}: ${errorMessage(err)}` };
  }
}

export function removeCdpPort(argvPath: string, o: { dryRun?: boolean } = {}): ActionResult {
  const where = displayPath(argvPath);
  const argv = readArgv(argvPath);
  if (argv.error) return { ok: false, changed: false, message: `Can't use ${where} (${argv.error}); not changed` };
  if (!argv.file || argv.value?.[PORT_KEY] === undefined) {
    return { ok: true, changed: false, message: `${where} doesn't set a debugging port` };
  }
  try {
    const after = setJsoncValue(argv.file.text, [PORT_KEY], undefined);
    const { backup } = commitWrite(argvPath, argv.file, after, o);
    return {
      ok: true,
      changed: true,
      message: `${o.dryRun ? "Would change" : "Changed"} ${where}: remove "${PORT_KEY}"`,
      files: [argvPath],
      backups: backup ? [backup] : [],
      next: CDP_RESTART_HINT,
    };
  } catch (err) {
    return { ok: false, changed: false, message: `Couldn't write ${where}: ${errorMessage(err)}` };
  }
}

export interface CdpLiveResult {
  ok: boolean;
  /** VS Code windows answering on the port */
  windows: number;
  /** Agent panels open in them: claude-code, codex, kilo-code, kimi-code */
  agents: string[];
  error?: string;
}

/** Asks VS Code on the port for its windows and agent panels (one HTTP request). */
export function cdpLive(port: number, timeoutMs = 2000): Promise<CdpLiveResult> {
  return new Promise((resolve) => {
    const failed = (error: string) => resolve({ ok: false, windows: 0, agents: [], error });
    const req = http.get({ host: "127.0.0.1", port, path: "/json/list", timeout: timeoutMs }, (res) => {
      let data = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return failed("the answer isn't from VS Code");
        }
        const targets = (Array.isArray(parsed) ? parsed : []).filter(
          (target): target is CdpTarget => typeof target?.id === "string" && typeof target?.type === "string"
        );
        const groups = groupTargetsByPage(targets);
        const agents = new Set(
          groups.flatMap((group) => group.iframes.map((target) => mapTargetUrlToAgent(target.url)))
        );
        agents.delete("unknown");
        resolve({ ok: true, windows: groups.length, agents: [...agents] });
      });
    });
    req.on("timeout", () => req.destroy(new Error("no answer")));
    req.on("error", (err: NodeJS.ErrnoException) =>
      failed(err.code === "ECONNREFUSED" ? "nothing answers on this port" : err.message)
    );
  });
}
