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

const DEFAULT_SCRIPT_PATH = "C:\\Users\\topem\\scripts\\VSCodeSidePanelLayout\\VSCodeSidePanelLayout.ps1";

const DEFAULT_SLOTS: Omit<LayoutSlot, "id">[] = [
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

export class LayoutManager {
  private configPath: string;
  private configDir: string;
  private config: LayoutsConfig;

  constructor() {
    const homeDir = process.env.USERPROFILE || process.env.HOME || ".";
    this.configDir = path.join(homeDir, ".reprompty");
    this.configPath = path.join(this.configDir, "layouts.json");
    this.config = { version: 1, scriptPath: DEFAULT_SCRIPT_PATH, slots: [] };
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
      scriptPath: DEFAULT_SCRIPT_PATH,
      slots: DEFAULT_SLOTS.map((s) => ({
        ...s,
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
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8");
    } catch (err) {
      console.error("[LayoutManager] Failed to save config:", err);
    }
  }

  listSlots(): LayoutSlot[] {
    return [...this.config.slots];
  }

  getSlot(id: string): LayoutSlot | null {
    return this.config.slots.find((s) => s.id === id) ?? null;
  }

  getSlotByLetter(letter: string): LayoutSlot | null {
    return this.config.slots.find((s) => s.letter.toUpperCase() === letter.toUpperCase()) ?? null;
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

  updateSlot(id: string, updates: Partial<Omit<LayoutSlot, "id">>): LayoutSlot | null {
    const idx = this.config.slots.findIndex((s) => s.id === id);
    if (idx === -1) return null;

    const updated = { ...this.config.slots[idx], ...updates };
    this.config = {
      ...this.config,
      slots: this.config.slots.map((s, i) => (i === idx ? updated : s)),
    };
    this.saveConfig();
    return updated;
  }

  removeSlot(id: string): boolean {
    const before = this.config.slots.length;
    this.config = {
      ...this.config,
      slots: this.config.slots.filter((s) => s.id !== id),
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

  applySlot(id: string, windowTitle?: string): Promise<{ success: boolean; error?: string }> {
    const slot = this.getSlot(id);
    if (!slot) {
      return Promise.resolve({ success: false, error: `Slot not found: ${id}` });
    }
    return this.runLayoutScript(slot.scriptArgs, windowTitle);
  }

  applySlotByLetter(letter: string, windowTitle?: string): Promise<{ success: boolean; error?: string }> {
    const slot = this.getSlotByLetter(letter);
    if (!slot) {
      return Promise.resolve({ success: false, error: `Slot "${letter}" not found` });
    }
    return this.runLayoutScript(slot.scriptArgs, windowTitle);
  }

  private runLayoutScript(args: string[], windowTitle?: string): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const scriptPath = this.config.scriptPath;

      if (!fs.existsSync(scriptPath)) {
        resolve({ success: false, error: `Script not found: ${scriptPath}` });
        return;
      }

      const fullArgs = [...args];
      if (windowTitle) {
        fullArgs.push("-WindowTitle", windowTitle);
      }

      const proc = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", scriptPath, ...fullArgs],
        { detached: true, stdio: "ignore" }
      );

      proc.unref();

      // Don't wait for the script to finish — it's fire-and-forget
      // The PS1 handles its own lifecycle (finds window, moves, resizes panel, exits)
      resolve({ success: true });
    });
  }
}

export const layoutManager = new LayoutManager();
