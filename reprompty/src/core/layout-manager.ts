import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface LayoutSlot {
  id: string;
  letter: string;
  name: string;
  scriptArgs: string[];
  hotkey: string | null;
  windowX: number;
  windowY: number;
  windowWidth: number;
  windowHeight: number;
  panelWidth: number;
  monitorHint: string;
}

interface LayoutsConfig {
  version: number;
  scriptPath: string;
  slots: LayoutSlot[];
}

export interface LayoutTarget {
  windowTitle?: string;
  windowHandle?: number;
}

export interface LayoutApplyResult {
  success: boolean;
  error?: string;
  exitCode?: number | null;
  logPath?: string;
  windowTitle?: string;
  windowHandle?: number;
}

const IS_WINDOWS = process.platform === "win32";

function getDefaultScriptPath(): string {
  if (IS_WINDOWS) {
    return "C:\\Users\\topem\\scripts\\VSCodeSidePanelLayout\\VSCodeSidePanelLayout.ps1";
  }
  // Linux: prefer the Cython-compiled binary if it's newer than the Python script
  const cythonCandidates = [
    path.join(__dirname, "..", "..", "VSCodeSidePanelLayout", "reprompty-layout-cython"),
    path.join(__dirname, "..", "..", "..", "VSCodeSidePanelLayout", "reprompty-layout-cython"),
    "/home/tope/Projects/OS-Toolkit/Reprompty/VSCodeSidePanelLayout/reprompty-layout-cython",
  ];
  const pythonCandidates = [
    path.join(__dirname, "..", "..", "VSCodeSidePanelLayout", "linux_layout.py"),
    path.join(__dirname, "..", "..", "..", "VSCodeSidePanelLayout", "linux_layout.py"),
    "/home/tope/Projects/OS-Toolkit/Reprompty/VSCodeSidePanelLayout/linux_layout.py",
  ];

  let cythonPath: string | null = null;
  for (const candidate of cythonCandidates) {
    try {
      if (fs.existsSync(candidate)) {
        cythonPath = candidate;
        break;
      }
    } catch {
      // Continue
    }
  }

  let pythonPath: string | null = null;
  for (const candidate of pythonCandidates) {
    try {
      if (fs.existsSync(candidate)) {
        pythonPath = candidate;
        break;
      }
    } catch {
      // Continue to next candidate
    }
  }

  if (cythonPath && pythonPath) {
    try {
      const cythonStat = fs.statSync(cythonPath);
      const pythonStat = fs.statSync(pythonPath);
      if (cythonStat.mtime >= pythonStat.mtime) {
        return cythonPath;
      }
    } catch {
      // fall through
    }
  }

  if (cythonPath) return cythonPath;
  if (pythonPath) return pythonPath;

  return cythonCandidates[0];
}

const LAYOUT_LOG_DIR_NAME = "VSCodeSidePanelLayout";
const LAYOUT_RUN_TIMEOUT_MS = 60000;

function getDefaultSlots(): Omit<LayoutSlot, "id">[] {
  if (IS_WINDOWS) {
    return [
      {
        letter: "A",
        name: "Dual Bottom",
        scriptArgs: ["-Once"],
        hotkey: "Ctrl+Alt+V",
        windowX: 0,
        windowY: 1083,
        windowWidth: 3840,
        windowHeight: 953,
        panelWidth: 1920,
        monitorHint: "DISPLAY5+DISPLAY6 bottom dual monitors",
      },
      {
        letter: "B",
        name: "Top Full Panel",
        scriptArgs: ["-SingleOnce"],
        hotkey: "Ctrl+Alt+N",
        windowX: -1360,
        windowY: 449,
        windowWidth: 3280,
        windowHeight: 583,
        panelWidth: 1920,
        monitorHint: "DISPLAY2+DISPLAY1 top monitors",
      },
    ];
  }
  // Linux defaults – dynamically detected by linux_layout.py via kscreen-doctor.
  // These static values are for UI display; the script computes actual geometry at runtime.
  return [
    {
      letter: "A",
      name: "Dual Bottom",
      scriptArgs: ["--slot", "A"],
      hotkey: "Ctrl+Alt+V",
      windowX: 1360,
      windowY: 1002,
      windowWidth: 3840,
      windowHeight: 1080,
      panelWidth: 1920,
      monitorHint: "HDMI-A-1 + DP-1 bottom dual monitors",
    },
    {
      letter: "B",
      name: "Top Full Panel",
      scriptArgs: ["--slot", "B"],
      hotkey: "Ctrl+Alt+N",
      windowX: 1360,
      windowY: 0,
      windowWidth: 1920,
      windowHeight: 1080,
      panelWidth: 960,
      monitorHint: "HDMI-A-4 top monitor",
    },
  ];
}

export function buildLayoutRunLogPath(
  baseDir: string,
  date = new Date(),
  suffix = crypto.randomUUID().slice(0, 8)
): string {
  const stamp = date
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  return path.join(baseDir, `layout-run-${stamp}-${suffix}.log`);
}

export function createLayoutRunLogPath(date = new Date()): string {
  const baseDir = path.join(
    process.env.LOCALAPPDATA ||
      process.env.USERPROFILE ||
      process.env.HOME ||
      ".",
    LAYOUT_LOG_DIR_NAME
  );

  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  return buildLayoutRunLogPath(baseDir, date);
}

export class LayoutManager {
  private configPath: string;
  private configDir: string;
  private config: LayoutsConfig;

  constructor() {
    const homeDir = process.env.USERPROFILE || process.env.HOME || ".";
    this.configDir = path.join(homeDir, ".reprompty");
    this.configPath = path.join(this.configDir, "layouts.json");
    this.config = { version: 1, scriptPath: getDefaultScriptPath(), slots: [] };
    this.loadConfig();
  }

  private loadConfig(): void {
    try {
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
      }

      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, "utf-8");
        this.config = JSON.parse(raw);
      } else {
        this.seedDefaults();
      }
    } catch (err) {
      console.error("[LayoutManager] Failed to load config:", err);
      this.seedDefaults();
    }
  }

  private seedDefaults(): void {
    this.config = {
      version: 1,
      scriptPath: getDefaultScriptPath(),
      slots: getDefaultSlots().map((slot) => ({
        ...slot,
        id: crypto.randomUUID(),
      })),
    };
    this.saveConfig();
  }

  private saveConfig(): void {
    try {
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
      }
      fs.writeFileSync(
        this.configPath,
        JSON.stringify(this.config, null, 2),
        "utf-8"
      );
    } catch (err) {
      console.error("[LayoutManager] Failed to save config:", err);
    }
  }

  listSlots(): LayoutSlot[] {
    return [...this.config.slots];
  }

  getSlot(id: string): LayoutSlot | null {
    return this.config.slots.find((slot) => slot.id === id) ?? null;
  }

  getSlotByLetter(letter: string): LayoutSlot | null {
    return (
      this.config.slots.find(
        (slot) => slot.letter.toUpperCase() === letter.toUpperCase()
      ) ?? null
    );
  }

  addSlot(slot: Omit<LayoutSlot, "id">): LayoutSlot {
    const newSlot: LayoutSlot = {
      ...slot,
      id: crypto.randomUUID(),
    };
    this.config = {
      ...this.config,
      slots: [...this.config.slots, newSlot],
    };
    this.saveConfig();
    return newSlot;
  }

  updateSlot(
    id: string,
    updates: Partial<Omit<LayoutSlot, "id">>
  ): LayoutSlot | null {
    const index = this.config.slots.findIndex((slot) => slot.id === id);
    if (index === -1) {
      return null;
    }

    const updated = { ...this.config.slots[index], ...updates };
    this.config = {
      ...this.config,
      slots: this.config.slots.map((slot, slotIndex) =>
        slotIndex === index ? updated : slot
      ),
    };
    this.saveConfig();
    return updated;
  }

  removeSlot(id: string): boolean {
    const before = this.config.slots.length;
    this.config = {
      ...this.config,
      slots: this.config.slots.filter((slot) => slot.id !== id),
    };
    if (this.config.slots.length < before) {
      this.saveConfig();
      return true;
    }
    return false;
  }

  getScriptPath(): string {
    return this.config.scriptPath;
  }

  setScriptPath(scriptPath: string): void {
    this.config = { ...this.config, scriptPath };
    this.saveConfig();
  }

  applySlot(id: string, target: LayoutTarget = {}): Promise<LayoutApplyResult> {
    const slot = this.getSlot(id);
    if (!slot) {
      return Promise.resolve({ success: false, error: `Slot not found: ${id}` });
    }
    return this.runLayoutScript(slot.scriptArgs, target);
  }

  applySlotByLetter(
    letter: string,
    target: LayoutTarget = {}
  ): Promise<LayoutApplyResult> {
    const slot = this.getSlotByLetter(letter);
    if (!slot) {
      return Promise.resolve({
        success: false,
        error: `Slot "${letter}" not found`,
      });
    }
    return this.runLayoutScript(slot.scriptArgs, target);
  }

  private runLayoutScript(
    args: string[],
    target: LayoutTarget = {}
  ): Promise<LayoutApplyResult> {
    return new Promise((resolve) => {
      const scriptPath = this.config.scriptPath;
      if (!fs.existsSync(scriptPath)) {
        resolve({ success: false, error: `Script not found: ${scriptPath}` });
        return;
      }

      const fullArgs = [...args];
      if (
        typeof target.windowHandle === "number" &&
        Number.isFinite(target.windowHandle) &&
        target.windowHandle > 0
      ) {
        fullArgs.push(IS_WINDOWS ? "-WindowHandle" : "--window-handle", String(target.windowHandle));
      } else if (!IS_WINDOWS && target.kdotoolHandle) {
        fullArgs.push("--window-handle", target.kdotoolHandle);
      } else if (target.windowTitle) {
        fullArgs.push(IS_WINDOWS ? "-WindowTitle" : "--window-title", target.windowTitle);
      }



      const logPath = createLayoutRunLogPath();
      fullArgs.push(IS_WINDOWS ? "-LogPath" : "--log-path", logPath);

      let command: string;
      let spawnArgs: string[];
      let spawnOptions: Parameters<typeof spawn>[2];

      if (IS_WINDOWS) {
        command = "powershell.exe";
        spawnArgs = [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-WindowStyle",
          "Hidden",
          "-File",
          scriptPath,
          ...fullArgs,
        ];
        spawnOptions = {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        };
      } else {
        const isPython = scriptPath.endsWith(".py");
        const isSh = scriptPath.endsWith(".sh");
        if (!isPython && !isSh) {
          // Cython-compiled binary: run directly, no --log-path
          command = scriptPath;
          spawnArgs = fullArgs.filter((arg, i, arr) => {
            // Filter out --log-path and its value
            if (arr[i - 1] === "--log-path") return false;
            if (arg === "--log-path" || arg === "-LogPath") return false;
            return true;
          });
        } else {
          command = isPython ? "python3" : "bash";
          spawnArgs = [scriptPath, ...fullArgs];
        }
        spawnOptions = {
          stdio: ["ignore", "pipe", "pipe"],
        };
      }

      const proc = spawn(command, spawnArgs, spawnOptions);

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      let finished = false;

      const finish = (result: LayoutApplyResult) => {
        if (finished) {
          return;
        }

        finished = true;
        clearTimeout(timeout);
        resolve({
          ...result,
          logPath,
          windowHandle: target.windowHandle,
          windowTitle: target.windowTitle,
        });
      };

      proc.stdout?.on("data", (data: Buffer) => {
        stdoutLines.push(
          ...data
            .toString()
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
        );
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderrLines.push(
          ...data
            .toString()
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
        );
      });

      proc.on("error", (err) => {
        finish({
          success: false,
          error: `Failed to start layout script: ${err.message}`,
          exitCode: null,
        });
      });

      proc.on("close", (code) => {
        if (code === 0) {
          finish({ success: true, exitCode: code });
          return;
        }

        const combinedOutput = [...stderrLines, ...stdoutLines].join(" ").trim();
        finish({
          success: false,
          exitCode: code,
          error:
            combinedOutput ||
            `Layout script exited with code ${code ?? "unknown"}`,
        });
      });

      const timeout = setTimeout(() => {
        proc.kill();
        finish({
          success: false,
          exitCode: null,
          error: `Layout script timed out after ${LAYOUT_RUN_TIMEOUT_MS}ms`,
        });
      }, LAYOUT_RUN_TIMEOUT_MS);
    });
  }
}

export const layoutManager = new LayoutManager();
