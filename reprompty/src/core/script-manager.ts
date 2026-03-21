import { EventEmitter } from "node:events";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type ScriptType = "powershell" | "batch" | "vbs" | "executable";
export type ScriptStatus = "stopped" | "running" | "error" | "starting";
export type LayoutRole = "primary" | "secondary" | null;

export interface ScriptEntry {
  id: string;
  name: string;
  path: string;
  type: ScriptType;
  args: string[];
  autoStart: boolean;
  layoutRole: LayoutRole;
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

const MAX_OUTPUT_LINES = 500;

function detectScriptType(filePath: string): ScriptType {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ps1": return "powershell";
    case ".bat":
    case ".cmd": return "batch";
    case ".vbs": return "vbs";
    case ".exe": return "executable";
    default: return "powershell";
  }
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
        for (const entry of config.scripts) {
          // Sanitize paths on load
          entry.path = entry.path.replace(/^["']|["']$/g, "");
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
        scripts: Array.from(this.scripts.values()).map((r) => r.entry),
      };
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf-8");
    } catch (err) {
      console.error("[ScriptManager] Failed to save config:", err);
    }
  }

  addScript(
    name: string,
    filePath: string,
    type?: ScriptType,
    args: string[] = []
  ): ScriptEntry {
    const id = crypto.randomUUID();
    // Strip wrapping quotes from file picker paths
    const cleanPath = filePath.replace(/^["']|["']$/g, "");
    const entry: ScriptEntry = {
      id,
      name,
      path: cleanPath,
      type: type || detectScriptType(filePath),
      args,
      autoStart: false,
      layoutRole: null,
      addedAt: new Date().toISOString(),
    };

    this.scripts.set(id, {
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
    if (!running) return false;

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
    if (!running) return null;

    const updated: ScriptEntry = { ...running.entry, ...updates, id };
    this.scripts.set(id, { ...running, entry: updated });
    this.saveConfig();
    return updated;
  }

  listScripts(): ScriptInfo[] {
    return Array.from(this.scripts.values()).map((r) => ({
      ...r.entry,
      status: r.status,
      pid: r.pid,
      exitCode: r.exitCode,
    }));
  }

  findByIdOrName(idOrName: string): ScriptEntry | null {
    const byId = this.scripts.get(idOrName);
    if (byId) return byId.entry;

    const byName = Array.from(this.scripts.values()).find(
      (r) => r.entry.name.toLowerCase() === idOrName.toLowerCase()
    );
    return byName ? byName.entry : null;
  }

  private buildSpawnArgs(entry: ScriptEntry): { command: string; args: string[] } {
    switch (entry.type) {
      case "powershell":
        return {
          command: "powershell.exe",
          args: [
            "-ExecutionPolicy", "Bypass",
            "-NoProfile",
            "-WindowStyle", "Hidden",
            "-File", entry.path,
            ...entry.args,
          ],
        };
      case "batch":
        return {
          command: "cmd.exe",
          args: ["/c", entry.path, ...entry.args],
        };
      case "vbs":
        return {
          command: "cscript.exe",
          args: ["//Nologo", entry.path, ...entry.args],
        };
      case "executable":
        return {
          command: entry.path,
          args: [...entry.args],
        };
    }
  }

  runScript(id: string): boolean {
    const running = this.scripts.get(id);
    if (!running) return false;
    if (running.status === "running") return true;

    const { command, args } = this.buildSpawnArgs(running.entry);

    try {
      running.status = "starting";
      running.exitCode = null;
      running.outputLines = [];
      this.emitStatus(id, "starting");

      const proc = spawn(command, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      running.process = proc;
      running.pid = proc.pid || null;
      running.status = "running";
      this.emitStatus(id, "running", proc.pid);

      proc.stdout?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter((l) => l.trim());
        for (const line of lines) {
          this.appendOutput(id, "stdout", line);
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter((l) => l.trim());
        for (const line of lines) {
          this.appendOutput(id, "stderr", line);
        }
      });

      proc.on("close", (code: number | null) => {
        const r = this.scripts.get(id);
        if (r) {
          r.status = code === 0 || code === null ? "stopped" : "error";
          r.exitCode = code;
          r.process = null;
          r.pid = null;
          this.emitStatus(id, r.status);
          this.emit("script-exit", { scriptId: id, exitCode: code });
        }
      });

      proc.on("error", (err: Error) => {
        const r = this.scripts.get(id);
        if (r) {
          r.status = "error";
          r.process = null;
          r.pid = null;
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

  stopScript(id: string): boolean {
    const running = this.scripts.get(id);
    if (!running?.process || running.status !== "running") return false;

    const pid = running.pid;

    try {
      running.process.kill();
    } catch {
      // Ignore kill errors, will force-kill below
    }

    setTimeout(() => {
      const r = this.scripts.get(id);
      if (r && r.status === "running" && pid) {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, {
            windowsHide: true,
            stdio: "ignore",
          });
          r.status = "stopped";
          r.process = null;
          r.pid = null;
          this.emitStatus(id, "stopped");
        } catch {
          // Process may have already exited
        }
      }
    }, 3000);

    return true;
  }

  setLayoutRole(id: string, role: LayoutRole): boolean {
    const target = this.scripts.get(id);
    if (!target) return false;

    // Clear any existing script with this role
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
      (r) => r.entry.layoutRole === role
    );
    return found ? found.entry : null;
  }

  getOutput(id: string, limit?: number): string[] {
    const running = this.scripts.get(id);
    if (!running) return [];
    const lines = running.outputLines;
    return limit ? lines.slice(-limit) : lines;
  }

  autoStartScripts(): void {
    const autoStartEntries = Array.from(this.scripts.values())
      .filter((r) => r.entry.autoStart);

    let delay = 0;
    for (const r of autoStartEntries) {
      setTimeout(() => {
        console.log(`[ScriptManager] Auto-starting: ${r.entry.name}`);
        this.runScript(r.entry.id);
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

  private appendOutput(id: string, stream: "stdout" | "stderr", line: string): void {
    const running = this.scripts.get(id);
    if (!running) return;

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

// Singleton instance
export const scriptManager = new ScriptManager();
