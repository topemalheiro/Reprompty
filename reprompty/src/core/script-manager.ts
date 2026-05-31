import { EventEmitter } from "node:events";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type ScriptType = "powershell" | "pwsh" | "batch" | "vbs" | "executable" | "shell" | "python";
export type ScriptStatus = "stopped" | "running" | "error" | "starting";
export type LayoutRole = "primary" | "secondary" | null;

export interface ScriptMcpAction {
  id: string;
  enabled: boolean;
  toolName: string;
  label: string;
  description: string;
  args: string[];
}

export interface ScriptEntry {
  id: string;
  name: string;
  path: string;
  type: ScriptType;
  args: string[];
  autoStart: boolean;
  layoutRole: LayoutRole;
  mcpActions: ScriptMcpAction[];
  addedAt: string;
}

export interface ScriptInfo extends ScriptEntry {
  status: ScriptStatus;
  pid: number | null;
  exitCode: number | null;
}

interface RunningScript {
  entry: ScriptEntry;
  status: ScriptStatus;
  pid: number | null;
  process: ChildProcess | null;
  outputLines: string[];
  exitCode: number | null;
}

interface ScriptsConfig {
  scripts: ScriptEntry[];
}

export interface ScriptToolRegistration {
  scriptId: string;
  scriptName: string;
  scriptPath: string;
  action: ScriptMcpAction;
}

export interface ScriptActionResult {
  success: boolean;
  scriptName: string;
  toolName: string;
  exitCode: number | null;
  stdout: string[];
  stderr: string[];
  message: string;
}

const MAX_OUTPUT_LINES = 500;
const HEADER_SCAN_LINE_LIMIT = 40;

export const RESERVED_MCP_TOOL_NAMES = [
  "spawn_window",
  "list_spawn_targets",
  "list_virtual_desktops",
  "ensure_virtual_desktop",
  "rename_virtual_desktop",
  "send_prompt",
  "add_connection",
  "list_connections",
  "remove_connection",
  "daisy_chain",
  "list_scripts",
  "run_script",
  "stop_script",
  "apply_layout",
  "list_layout_slots",
  "spawn_and_layout",
  "detect_windows",
  "detect_all_windows",
  "check_cdp",
] as const;

function resolvePowerShellCommand(): string {
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}

function detectScriptType(filePath: string): ScriptType {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ps1":
      return process.platform === "win32" ? "powershell" : "pwsh";
    case ".bat":
    case ".cmd":
      return "batch";
    case ".vbs":
      return "vbs";
    case ".exe":
      return "executable";
    case ".sh":
      return "shell";
    case ".py":
      return "python";
    default:
      return process.platform === "win32" ? "powershell" : "shell";
  }
}

export function normalizeMcpToolName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeActionId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeArgs(args: unknown): string[] {
  if (!Array.isArray(args)) {
    return [];
  }
  return args
    .map((value) => String(value).trim())
    .filter(Boolean);
}

function layoutScriptDefaults(scriptName: string, filePath: string): ScriptMcpAction[] {
  const combined = `${scriptName} ${path.basename(filePath)}`.toLowerCase();
  const looksLikeLayoutScript =
    combined.includes("vscodesidepanellayout") ||
    combined.includes("sidepanellayout");

  if (!looksLikeLayoutScript) {
    return [];
  }

  const isLinuxPython = process.platform !== "win32" && filePath.toLowerCase().endsWith(".py");

  return [
    {
      id: "dual-monitor-layout-bottom",
      enabled: true,
      toolName: "dual_monitor_layout_bottom",
      label: "Dual monitor layout (bottom)",
      description: "Run the Ctrl+Alt+V dual monitor bottom layout",
      args: isLinuxPython ? ["--once", "--dual"] : ["-Once"],
    },
    {
      id: "top-monitors-layout-panel-full",
      enabled: true,
      toolName: "top_monitors_layout_panel_full",
      label: "Top monitors layout (panel full)",
      description: "Run the Ctrl+Alt+N top monitors panel-full layout",
      args: isLinuxPython ? ["--once", "--single"] : ["-SingleOnce"],
    },
  ];
}

export function parseScriptMcpActionsFromHeader(filePath: string): ScriptMcpAction[] {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const lines = fs
      .readFileSync(filePath, "utf-8")
      .split(/\r?\n/)
      .slice(0, HEADER_SCAN_LINE_LIMIT);

    const results = new Map<string, ScriptMcpAction>();

    for (const line of lines) {
      const match = line.match(/reprompty-mcp:\s*(\{.+\})/i);
      if (!match) {
        continue;
      }

      try {
        const parsed = JSON.parse(match[1]) as Partial<ScriptMcpAction>;
        const normalized = normalizeMcpAction(parsed);
        results.set(normalized.toolName, normalized);
      } catch (err) {
        console.warn("[ScriptManager] Failed to parse reprompty-mcp header:", err);
      }
    }

    return Array.from(results.values());
  } catch (err) {
    console.warn("[ScriptManager] Failed to read script header:", err);
    return [];
  }
}

function normalizeMcpAction(action: Partial<ScriptMcpAction>): ScriptMcpAction {
  const toolName = normalizeMcpToolName(String(action.toolName || ""));
  const label = String(action.label || "").trim();
  const description = String(action.description || "").trim();

  if (!toolName) {
    throw new Error("MCP action tool name is required");
  }
  if (!label) {
    throw new Error(`MCP action "${toolName}" is missing a label`);
  }

  const idSource = String(action.id || toolName);
  const id = normalizeActionId(idSource) || normalizeActionId(toolName);
  if (!id) {
    throw new Error(`MCP action "${toolName}" needs a valid id`);
  }

  return {
    id,
    enabled: action.enabled !== false,
    toolName,
    label,
    description,
    args: normalizeArgs(action.args),
  };
}

function mergeImportedActions(
  existing: ScriptMcpAction[],
  imported: ScriptMcpAction[]
): ScriptMcpAction[] {
  if (imported.length === 0) {
    return existing;
  }

  const merged = new Map<string, ScriptMcpAction>();
  for (const action of existing) {
    merged.set(action.toolName, action);
  }
  for (const action of imported) {
    const prior = merged.get(action.toolName);
    merged.set(action.toolName, prior ? { ...prior, ...action } : action);
  }
  return Array.from(merged.values());
}

function getImportedScriptActions(name: string, filePath: string): ScriptMcpAction[] {
  return [
    ...parseScriptMcpActionsFromHeader(filePath),
    ...layoutScriptDefaults(name, filePath),
  ];
}

function sanitizeScriptEntry(
  entry: Partial<ScriptEntry>,
  options: { importActions?: boolean } = {}
): ScriptEntry {
  const name = String(entry.name || "").trim();
  const filePath = String(entry.path || "").replace(/^["']|["']$/g, "").trim();
  if (!name) {
    throw new Error("Script name is required");
  }
  if (!filePath) {
    throw new Error("Script path is required");
  }

  const baseActions = Array.isArray(entry.mcpActions) ? entry.mcpActions : [];
  const normalizedBaseActions = baseActions.map((action) => normalizeMcpAction(action));
  const mergedActions = options.importActions
    ? mergeImportedActions(normalizedBaseActions, getImportedScriptActions(name, filePath))
    : normalizedBaseActions;

  return {
    id: entry.id || crypto.randomUUID(),
    name,
    path: filePath,
    type: entry.type || detectScriptType(filePath),
    args: normalizeArgs(entry.args),
    autoStart: Boolean(entry.autoStart),
    layoutRole: entry.layoutRole ?? null,
    mcpActions: mergedActions,
    addedAt: entry.addedAt || new Date().toISOString(),
  };
}

export class ScriptManager extends EventEmitter {
  private scripts: Map<string, RunningScript> = new Map();
  private configPath: string;
  private configDir: string;

  constructor() {
    super();
    const homeDir = process.env.USERPROFILE || process.env.HOME || ".";
    this.configDir = path.join(homeDir, ".reprompty");
    this.configPath = path.join(this.configDir, "scripts.json");
    this.loadConfig();
  }

  private loadConfig(): void {
    try {
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
      }

      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, "utf-8");
        const config: ScriptsConfig = JSON.parse(raw);
        for (const savedEntry of config.scripts ?? []) {
          const entry = sanitizeScriptEntry(savedEntry, { importActions: true });
          this.scripts.set(entry.id, {
            entry,
            status: "stopped",
            pid: null,
            process: null,
            outputLines: [],
            exitCode: null,
          });
        }
      } else {
        this.saveConfig();
      }
    } catch (err) {
      console.error("[ScriptManager] Failed to load config:", err);
    }
  }

  private saveConfig(): void {
    try {
      const config: ScriptsConfig = {
        scripts: Array.from(this.scripts.values()).map((running) => running.entry),
      };
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf-8");
    } catch (err) {
      console.error("[ScriptManager] Failed to save config:", err);
    }
  }

  private validateMcpActionToolNames(entry: ScriptEntry, excludingScriptId?: string): void {
    const seen = new Set<string>();
    for (const action of entry.mcpActions) {
      if (RESERVED_MCP_TOOL_NAMES.includes(action.toolName as (typeof RESERVED_MCP_TOOL_NAMES)[number])) {
        throw new Error(`"${action.toolName}" is reserved for a built-in MCP tool`);
      }
      if (seen.has(action.toolName)) {
        throw new Error(`Duplicate MCP tool name "${action.toolName}" within script "${entry.name}"`);
      }
      seen.add(action.toolName);
    }

    const registrations = this.listGeneratedMcpTools();
    for (const registration of registrations) {
      if (registration.scriptId === excludingScriptId) {
        continue;
      }
      const incoming = entry.mcpActions.find(
        (action) => action.toolName === registration.action.toolName
      );
      if (incoming) {
        throw new Error(
          `MCP tool name "${incoming.toolName}" is already used by script "${registration.scriptName}"`
        );
      }
    }
  }

  addScript(
    name: string,
    filePath: string,
    type?: ScriptType,
    args: string[] = []
  ): ScriptEntry {
    const entry = sanitizeScriptEntry(
      {
      name,
      path: filePath,
      type: type || detectScriptType(filePath),
      args,
      autoStart: false,
      layoutRole: null,
      mcpActions: [],
      },
      { importActions: true }
    );

    this.validateMcpActionToolNames(entry);

    this.scripts.set(entry.id, {
      entry,
      status: "stopped",
      pid: null,
      process: null,
      outputLines: [],
      exitCode: null,
    });

    this.saveConfig();
    this.emit("script-added", entry);
    return entry;
  }

  removeScript(id: string): boolean {
    const running = this.scripts.get(id);
    if (!running) {
      return false;
    }

    if (running.status === "running") {
      this.stopScript(id);
    }

    this.scripts.delete(id);
    this.saveConfig();
    this.emit("script-removed", id);
    return true;
  }

  updateScript(id: string, updates: Partial<ScriptEntry>): ScriptEntry | null {
    const running = this.scripts.get(id);
    if (!running) {
      return null;
    }

    const updated = sanitizeScriptEntry(
      {
        ...running.entry,
        ...updates,
        id,
        addedAt: running.entry.addedAt,
      },
      { importActions: false }
    );
    this.validateMcpActionToolNames(updated, id);

    this.scripts.set(id, { ...running, entry: updated });
    this.saveConfig();
    return updated;
  }

  rescanMcpActions(id: string): ScriptEntry | null {
    const running = this.scripts.get(id);
    if (!running) {
      return null;
    }

    const imported = getImportedScriptActions(running.entry.name, running.entry.path);
    const mergedActions = mergeImportedActions(running.entry.mcpActions, imported);
    return this.updateScript(id, { mcpActions: mergedActions });
  }

  listScripts(): ScriptInfo[] {
    return Array.from(this.scripts.values()).map((running) => ({
      ...running.entry,
      status: running.status,
      pid: running.pid,
      exitCode: running.exitCode,
    }));
  }

  listGeneratedMcpTools(): ScriptToolRegistration[] {
    const registrations: ScriptToolRegistration[] = [];

    for (const running of this.scripts.values()) {
      for (const action of running.entry.mcpActions) {
        if (!action.enabled) {
          continue;
        }
        registrations.push({
          scriptId: running.entry.id,
          scriptName: running.entry.name,
          scriptPath: running.entry.path,
          action,
        });
      }
    }

    return registrations.sort((a, b) =>
      a.action.toolName.localeCompare(b.action.toolName)
    );
  }

  findGeneratedMcpTool(toolName: string): ScriptToolRegistration | null {
    const normalizedToolName = normalizeMcpToolName(toolName);
    return (
      this.listGeneratedMcpTools().find(
        (registration) => registration.action.toolName === normalizedToolName
      ) || null
    );
  }

  findByIdOrName(idOrName: string): ScriptEntry | null {
    const byId = this.scripts.get(idOrName);
    if (byId) {
      return byId.entry;
    }

    const byName = Array.from(this.scripts.values()).find(
      (running) => running.entry.name.toLowerCase() === idOrName.toLowerCase()
    );
    return byName ? byName.entry : null;
  }

  private buildSpawnArgs(
    entry: ScriptEntry,
    extraArgs: string[] = []
  ): { command: string; args: string[] } {
    const allArgs = [...entry.args, ...extraArgs];

    switch (entry.type) {
      case "powershell":
        return {
          command: "powershell.exe",
          args: [
            "-ExecutionPolicy",
            "Bypass",
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-File",
            entry.path,
            ...allArgs,
          ],
        };
      case "pwsh":
        return {
          command: "pwsh",
          args: [
            "-ExecutionPolicy",
            "Bypass",
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-File",
            entry.path,
            ...allArgs,
          ],
        };
      case "batch":
        return {
          command: "cmd.exe",
          args: ["/c", entry.path, ...allArgs],
        };
      case "vbs":
        return {
          command: "cscript.exe",
          args: ["//Nologo", entry.path, ...allArgs],
        };
      case "executable":
        return {
          command: entry.path,
          args: allArgs,
        };
      case "shell":
        return {
          command: "bash",
          args: [entry.path, ...allArgs],
        };
      case "python":
        return {
          command: "python3",
          args: [entry.path, ...allArgs],
        };
    }
  }

  runScript(id: string): boolean {
    const running = this.scripts.get(id);
    if (!running) {
      return false;
    }
    if (running.status === "running") {
      return true;
    }

    const { command, args } = this.buildSpawnArgs(running.entry);

    try {
      running.status = "starting";
      running.exitCode = null;
      running.outputLines = [];
      this.emitStatus(id, "starting");

      const spawnOptions: Parameters<typeof spawn>[2] = {
        stdio: ["ignore", "pipe", "pipe"],
      };
      if (process.platform === "win32") {
        spawnOptions.windowsHide = true;
      }
      const proc = spawn(command, args, spawnOptions);

      running.process = proc;
      running.pid = proc.pid || null;
      running.status = "running";
      this.emitStatus(id, "running", proc.pid);

      proc.stdout?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter((line) => line.trim());
        for (const line of lines) {
          this.appendOutput(id, "stdout", line);
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter((line) => line.trim());
        for (const line of lines) {
          this.appendOutput(id, "stderr", line);
        }
      });

      proc.on("close", (code: number | null) => {
        const latest = this.scripts.get(id);
        if (latest) {
          latest.status = code === 0 || code === null ? "stopped" : "error";
          latest.exitCode = code;
          latest.process = null;
          latest.pid = null;
          this.emitStatus(id, latest.status);
          this.emit("script-exit", { scriptId: id, exitCode: code });
        }
      });

      proc.on("error", (err: Error) => {
        const latest = this.scripts.get(id);
        if (latest) {
          latest.status = "error";
          latest.process = null;
          latest.pid = null;
          this.appendOutput(id, "stderr", `Process error: ${err.message}`);
          this.emitStatus(id, "error");
        }
      });

      return true;
    } catch (err) {
      running.status = "error";
      running.process = null;
      running.pid = null;
      this.appendOutput(id, "stderr", `Spawn failed: ${err}`);
      this.emitStatus(id, "error");
      return false;
    }
  }

  async runGeneratedMcpTool(toolName: string): Promise<ScriptActionResult> {
    const registration = this.findGeneratedMcpTool(toolName);
    if (!registration) {
      return {
        success: false,
        scriptName: "",
        toolName: normalizeMcpToolName(toolName),
        exitCode: null,
        stdout: [],
        stderr: [],
        message: `Unknown generated MCP tool: ${toolName}`,
      };
    }

    const running = this.scripts.get(registration.scriptId);
    if (!running) {
      return {
        success: false,
        scriptName: registration.scriptName,
        toolName: registration.action.toolName,
        exitCode: null,
        stdout: [],
        stderr: [],
        message: `Script "${registration.scriptName}" is no longer registered`,
      };
    }

    if (running.status === "running") {
      return {
        success: false,
        scriptName: registration.scriptName,
        toolName: registration.action.toolName,
        exitCode: null,
        stdout: [],
        stderr: [],
        message: `Script "${registration.scriptName}" is already running`,
      };
    }

    const { command, args } = this.buildSpawnArgs(running.entry, registration.action.args);
    this.appendOutput(
      registration.scriptId,
      "stdout",
      `[MCP:${registration.action.toolName}] Starting with args: ${registration.action.args.join(" ")}`
    );

    return new Promise<ScriptActionResult>((resolve) => {
      const stdout: string[] = [];
      const stderr: string[] = [];

      try {
        const spawnOptions: Parameters<typeof spawn>[2] = {
          stdio: ["ignore", "pipe", "pipe"],
        };
        if (process.platform === "win32") {
          spawnOptions.windowsHide = true;
        }
        const proc = spawn(command, args, spawnOptions);

        proc.stdout?.on("data", (data: Buffer) => {
          const lines = data.toString().split("\n").filter((line) => line.trim());
          for (const line of lines) {
            stdout.push(line);
            this.appendOutput(
              registration.scriptId,
              "stdout",
              `[MCP:${registration.action.toolName}] ${line}`
            );
          }
        });

        proc.stderr?.on("data", (data: Buffer) => {
          const lines = data.toString().split("\n").filter((line) => line.trim());
          for (const line of lines) {
            stderr.push(line);
            this.appendOutput(
              registration.scriptId,
              "stderr",
              `[MCP:${registration.action.toolName}] ${line}`
            );
          }
        });

        proc.on("error", (err: Error) => {
          const line = `[MCP:${registration.action.toolName}] Process error: ${err.message}`;
          stderr.push(line);
          this.appendOutput(registration.scriptId, "stderr", line);
          resolve({
            success: false,
            scriptName: registration.scriptName,
            toolName: registration.action.toolName,
            exitCode: null,
            stdout,
            stderr,
            message: `Failed to run ${registration.action.toolName}: ${err.message}`,
          });
        });

        proc.on("close", (code: number | null) => {
          const success = code === 0 || code === null;
          const message = success
            ? `Ran ${registration.action.toolName} via ${registration.scriptName}`
            : `Generated MCP tool ${registration.action.toolName} failed with exit code ${code}`;

          this.appendOutput(
            registration.scriptId,
            success ? "stdout" : "stderr",
            `[MCP:${registration.action.toolName}] Completed with exit code ${code ?? 0}`
          );

          resolve({
            success,
            scriptName: registration.scriptName,
            toolName: registration.action.toolName,
            exitCode: code,
            stdout,
            stderr,
            message,
          });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.appendOutput(
          registration.scriptId,
          "stderr",
          `[MCP:${registration.action.toolName}] Spawn failed: ${message}`
        );
        resolve({
          success: false,
          scriptName: registration.scriptName,
          toolName: registration.action.toolName,
          exitCode: null,
          stdout,
          stderr: [...stderr, message],
          message: `Failed to run ${registration.action.toolName}: ${message}`,
        });
      }
    });
  }

  stopScript(id: string): boolean {
    const running = this.scripts.get(id);
    if (!running?.process || running.status !== "running") {
      return false;
    }

    const pid = running.pid;

    try {
      running.process.kill();
    } catch {
      // Ignore kill errors, will force-kill below.
    }

    setTimeout(() => {
      const latest = this.scripts.get(id);
      if (latest && latest.status === "running" && pid) {
        try {
          if (process.platform === "win32") {
            execSync(`taskkill /PID ${pid} /T /F`, {
              windowsHide: true,
              stdio: "ignore",
            });
          } else {
            execSync(`kill -9 ${pid}`, { stdio: "ignore" });
          }
          latest.status = "stopped";
          latest.process = null;
          latest.pid = null;
          this.emitStatus(id, "stopped");
        } catch {
          // Process may have already exited.
        }
      }
    }, 3000);

    return true;
  }

  setLayoutRole(id: string, role: LayoutRole): boolean {
    const target = this.scripts.get(id);
    if (!target) {
      return false;
    }

    if (role !== null) {
      for (const [otherId, other] of this.scripts) {
        if (otherId !== id && other.entry.layoutRole === role) {
          other.entry = { ...other.entry, layoutRole: null };
        }
      }
    }

    target.entry = { ...target.entry, layoutRole: role };
    this.saveConfig();
    return true;
  }

  getLayoutScript(role: "primary" | "secondary"): ScriptEntry | null {
    const found = Array.from(this.scripts.values()).find(
      (running) => running.entry.layoutRole === role
    );
    return found ? found.entry : null;
  }

  getOutput(id: string, limit?: number): string[] {
    const running = this.scripts.get(id);
    if (!running) {
      return [];
    }
    const lines = running.outputLines;
    return limit ? lines.slice(-limit) : lines;
  }

  autoStartScripts(): void {
    const autoStartEntries = Array.from(this.scripts.values()).filter(
      (running) => running.entry.autoStart
    );

    let delay = 0;
    for (const running of autoStartEntries) {
      setTimeout(() => {
        console.log(`[ScriptManager] Auto-starting: ${running.entry.name}`);
        this.runScript(running.entry.id);
      }, delay);
      delay += 100;
    }
  }

  stopAll(): void {
    for (const [id, running] of this.scripts) {
      if (running.status === "running") {
        console.log(`[ScriptManager] Stopping: ${running.entry.name}`);
        this.stopScript(id);
      }
    }
  }

  private appendOutput(
    id: string,
    stream: "stdout" | "stderr",
    line: string
  ): void {
    const running = this.scripts.get(id);
    if (!running) {
      return;
    }

    running.outputLines.push(line);
    if (running.outputLines.length > MAX_OUTPUT_LINES) {
      running.outputLines.splice(0, running.outputLines.length - MAX_OUTPUT_LINES);
    }

    this.emit("script-output", {
      scriptId: id,
      stream,
      line,
      timestamp: new Date().toISOString(),
    });
  }

  private emitStatus(id: string, status: ScriptStatus, pid?: number | null): void {
    this.emit("script-status-changed", {
      scriptId: id,
      status,
      pid: pid ?? null,
    });
  }
}

export const scriptManager = new ScriptManager();
