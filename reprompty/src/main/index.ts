// ============================================================================
// REPROMPTY - Electron Main Process
// ============================================================================

import fs from "node:fs";
import nodePath from "node:path";
import { join } from "node:path";
import { scriptManager } from "../core/script-manager.js";
import { spawnTargetManager } from "../core/spawn-target-manager.js";
import { connectionManager } from "../core/connection-manager.js";
import { layoutManager } from "../core/layout-manager.js";
import { listVirtualDesktops } from "../core/virtual-desktop-manager.js";
import { getOrCreateIpcClient, removeIpcClient } from "../core/ipc-client.js";
import type { VSCodeWindowConfig } from "../core/connection-manager.js";
import * as platform from "../platform/index.js";

// CRITICAL EARLY LOG - write directly to stderr to bypass any console override
let logFile: string;

function setupEarlyLogging() {
  try {
    const homeDir = process.env.USERPROFILE || process.env.HOME || ".";
    const logDir = nodePath.join(homeDir, "reprompty-logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    logFile = nodePath.join(logDir, `reprompty-${new Date().toISOString().split('T')[0]}.log`);
    
    const origLog = console.log;
    const origWarn = console.warn;
    const origErr = console.error;

    console.log = (...args: any[]) => {
      const msg = args.map((a: any) => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      const timestamp = new Date().toISOString();
      const logLine = `[${timestamp}] ${msg}\n`;
      try { fs.appendFileSync(logFile!, logLine); } catch { /* ignore */ }
      origLog.apply(console, args);
    };
    console.warn = (...args: any[]) => {
      const msg = args.map((a: any) => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      const timestamp = new Date().toISOString();
      const logLine = `[${timestamp}] WARN: ${msg}\n`;
      try { fs.appendFileSync(logFile!, logLine); } catch { /* ignore */ }
      origWarn.apply(console, args);
    };
    console.error = (...args: any[]) => {
      const msg = args.map((a: any) => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      const timestamp = new Date().toISOString();
      const logLine = `[${timestamp}] ERROR: ${msg}\n`;
      try { fs.appendFileSync(logFile!, logLine); } catch { /* ignore */ }
      origErr.apply(console, args);
    };
    
    console.log("=== EARLY LOGGING SETUP ===");
    console.log("process.resourcesPath:", process.resourcesPath);
    console.log("User home:", homeDir);
    console.log("Log file:", logFile);
    console.log("process.versions.electron:", process.versions?.electron);
  } catch (e) {
    process.stderr.write(`Failed to setup early logging: ${e}\n`);
  }
}

setupEarlyLogging();

// Verify we're actually in Electron
const isInElectron = !!process.versions?.electron;
console.log("[Main] Running in Electron:", isInElectron);
console.log("[Main] Electron version:", process.versions?.electron);

if (!isInElectron) {
  console.error("❌ FATAL: Not running in Electron main process!");
  process.exit(1);
}

// Use a single require('electron') call and destructure
let electronModule = require('electron');

// If ELECTRON_RUN_AS_NODE is set, require('electron') returns the npm package string.
// Detect this and force a re-require after clearing the env var.
if (typeof electronModule === 'string' || !electronModule.app) {
  if (process.env.ELECTRON_RUN_AS_NODE || process.env.ELECTRON_NO_ATTACH_CONSOLE) {
    console.warn('[Main] Detected Electron Node mode (ELECTRON_RUN_AS_NODE is set). Clearing and re-requiring electron...');
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.ELECTRON_NO_ATTACH_CONSOLE;
    // Clear the module cache so require('electron') re-resolves
    delete (require as any).cache[(require as any).resolve('electron')];
    electronModule = require('electron');
  }
}

if (typeof electronModule === 'string' || !electronModule.app) {
  console.error('❌ FATAL: require("electron") returned the npm package string instead of the Electron API.');
  console.error('   This usually means ELECTRON_RUN_AS_NODE is set in the launch environment.');
  console.error('   Value received:', electronModule);
  process.exit(1);
}

const electron = {
  app: electronModule.app,
  BrowserWindow: electronModule.BrowserWindow,
  Tray: electronModule.Tray,
  Menu: electronModule.Menu,
  nativeImage: electronModule.nativeImage,
  ipcMain: electronModule.ipcMain,
  shell: electronModule.shell,
  globalShortcut: (electronModule as any).globalShortcut
};

console.log("[Main] Electron modules loaded");
console.log("[Main] app:", typeof electron.app);
console.log("[Main] nativeImage:", typeof electron.nativeImage);
console.log("[Main] BrowserWindow:", typeof electron.BrowserWindow);

// ============================================================================
// APP SETUP
// ============================================================================

// Only import MCP tools when needed (lazy load)
let runMCPTool: (toolName: string, args: Record<string, unknown>) => Promise<string>;

// Electron main process
let mainWindow: any = null;
let tray: any = null;

const isDev = !electron.app.isPackaged;

function createWindow() {
  console.log("[Main] isDev:", isDev);
  console.log("[Main] app.isPackaged:", electron.app.isPackaged);
  
  // Mouse mascot icon for taskbar
  const mouseIcon = electron.nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAo0lEQVR4nO1VQQ7AIAjz/2/0L9udSYsdsmShybIIFhoRHKOBMOf1+E5wYCBme8sJB2I+hQMF7PoVTmjzqpZMQJQjqy05gU/vgEcq6wJLtjVd2ZEvHZ6AI8m8xIo/LXlEQKoI73KxtSSC1df+rQB2UaV2RAnZOuUUPDtqQRZrS0zEHt0nCWDBU0cwSpTpk0REX8GSYbQSUDKSUSeUvAeNRuNvuAGWDeYFCd9ApQAAAABJRU5ErkJggg==");

  mainWindow = new electron.BrowserWindow({
    width: 900,
    height: 700,
    title: "Reprompty",
    icon: mouseIcon,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, "../preload/index.js"),
      webviewTag: true,
    },
  });

  // Always load production build - don't try to connect to dev server
  mainWindow.loadFile(join(__dirname, "../renderer/index.html"));

  mainWindow.on("close", (event: any) => {
    if (tray) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createTray() {
  console.log("=== CREATE TRAY START ===");
  console.log("[Tray] isDev:", isDev);
  console.log("[Tray] __dirname:", __dirname);
  console.log("[Tray] process.resourcesPath:", process.resourcesPath);
  
  let icon;
  
  // Try multiple icon sources - use createFromPath which handles ICO better
  const iconPaths = [
    join(__dirname, "../../build/icon.ico"),
    join(__dirname, "../../build/icon.png"),
    join(process.resourcesPath, "icon.ico"),
    join(process.resourcesPath, "icon.png"),
  ];
  
  // Try createFromPath for each file (works better with ICO files)
  for (const iconPath of iconPaths) {
    try {
      console.log("[Tray] Trying createFromPath:", iconPath);
      if (fs.existsSync(iconPath)) {
        const size = fs.statSync(iconPath).size;
        console.log("[Tray] File exists, size:", size);
        
        icon = electron.nativeImage.createFromPath(iconPath);
        console.log("[Tray] Created icon from path, size:", icon.getSize(), "isEmpty:", icon.isEmpty());
        
        if (!icon.isEmpty() && icon.getSize().width > 0) {
          console.log("[Tray] ✅ Successfully loaded icon from:", iconPath);
          break;
        } else {
          console.log("[Tray] Icon is empty, trying next source");
        }
      }
    } catch (e) {
      console.log("[Tray] Failed to load from path:", e);
    }
  }
  
  // If no icon loaded, use fallback base64
  if (!icon || icon.isEmpty()) {
    console.log("[Tray] Using fallback base64 icon");
    // Fallback: 32x32 mouse mascot icon (cyan)
    const iconDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAo0lEQVR4nO1VQQ7AIAjz/2/0L9udSYsdsmShybIIFhoRHKOBMOf1+E5wYCBme8sJB2I+hQMF7PoVTmjzqpZMQJQjqy05gU/vgEcq6wJLtjVd2ZEvHZ6AI8m8xIo/LXlEQKoI73KxtSSC1df+rQB2UaV2RAnZOuUUPDtqQRZrS0zEHt0nCWDBU0cwSpTpk0REX8GSYbQSUDKSUSeUvAeNRuNvuAGWDeYFCd9ApQAAAABJRU5ErkJggg==";
    
    try {
      icon = electron.nativeImage.createFromDataURL(iconDataUrl);
      console.log("[Tray] Created from data URL, size:", icon.getSize(), "isEmpty:", icon.isEmpty());
    } catch (e) {
      console.log("[Tray] Error creating from data URL:", e);
    }
  }
  
  const size = icon?.getSize();
  console.log("[Tray] Final icon size:", size);
  console.log("[Tray] Is empty:", icon?.isEmpty());
  
  if (!icon || icon.isEmpty()) {
    console.error("[Tray] ❌ ERROR: Icon is empty! Cannot create tray without valid icon.");
    return; // Don't create tray with empty icon
  }
  
  console.log("[Tray] ✅ Icon loaded successfully");
  console.log("[Tray] Creating new Tray...");
  tray = new electron.Tray(icon);
  console.log("[Tray] ✅ Tray created:", tray);
  
  const contextMenu = electron.Menu.buildFromTemplate([
    {
      label: "Show Reprompty",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        tray?.destroy();
        tray = null;
        electron.app.quit();
      }
    }
  ]);
  
  tray.setToolTip("Reprompty");
  tray.setContextMenu(contextMenu);
  
  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  
  console.log("=== CREATE TRAY END ===");
}

// Forward script events to renderer
scriptManager.on("script-output", (data: any) => {
  mainWindow?.webContents?.send("script-output", data);
});
scriptManager.on("script-status-changed", (data: any) => {
  mainWindow?.webContents?.send("script-status-changed", data);
});

// App lifecycle
electron.app.whenReady().then(() => {
  console.log("=== APP READY ===");
  createWindow();
  createTray();

  // Auto-start registered scripts
  try {
    scriptManager.autoStartScripts();
    console.log("[Main] Script auto-start complete");
  } catch (err) {
    console.error("[Main] Script auto-start failed:", err);
  }

  // Auto-start Llama.cpp presets flagged for startup
  try {
    const config = readLlamaConfig();
    const autostart = Array.isArray(config.autostart) ? (config.autostart as string[]) : [];
    if (autostart.length > 0) {
      console.log("[Main] Auto-starting Llama.cpp presets:", autostart);
      for (const presetName of autostart) {
        try {
          const binary = getLlamaServerPath();
          if (!binary) {
            console.warn(`[Main] Cannot auto-start '${presetName}': llama-server binary not found`);
            continue;
          }
          const presetPath = nodePath.join(LLAMA_PRESETS_DIR, `${presetName}.json`);
          if (!fs.existsSync(presetPath)) {
            console.warn(`[Main] Cannot auto-start '${presetName}': preset file not found`);
            continue;
          }
          // Re-use the existing start logic via IPC isn't possible here,
          // so we inline the spawn directly.
          const preset = JSON.parse(fs.readFileSync(presetPath, "utf-8"));
          if (getRunningServerForPreset(presetName)) {
            console.log(`[Main] Preset '${presetName}' already running, skipping autostart`);
            continue;
          }
          const args = [
            "-m", preset.modelPath,
            "--port", String(preset.port || 8080),
            "-c", String(preset.contextSize || 4096),
            "-t", String(preset.threads || 4),
            "-b", String(preset.batchSize || 512),
            "-ub", String(preset.ubatchSize || 512),
            "--temp", String(preset.temperature ?? 0.8),
            "--top-p", String(preset.topP ?? 0.9),
            "--top-k", String(preset.topK ?? 40),
            "--repeat-penalty", String(preset.repeatPenalty ?? 1.1),
            "-n", String(preset.maxTokens ?? -1),
          ];
          if (preset.gpuLayers) args.push("-ngl", String(preset.gpuLayers));
          if (preset.chatTemplate) args.push("--chat-template", preset.chatTemplate);
          if (preset.extraArgs) args.push(...preset.extraArgs.split(/\s+/).filter(Boolean));
          const logPath = nodePath.join(LLAMA_LOGS_DIR, `${presetName}-${Date.now()}.log`);
          const logFd = fs.openSync(logPath, "a");
          const proc = spawn(binary, args, { detached: true, stdio: ["ignore", logFd, logFd] });
          proc.unref();
          fs.closeSync(logFd);
          const servers = readServersRegistry();
          servers.push({
            pid: proc.pid!,
            port: preset.port || 8080,
            preset: presetName,
            startedAt: new Date().toISOString(),
            logPath,
          });
          writeServersRegistry(servers);
          console.log(`[Main] Auto-started '${presetName}' on port ${preset.port || 8080} (PID ${proc.pid})`);
        } catch (err) {
          console.error(`[Main] Failed to auto-start preset '${presetName}':`, err);
        }
      }
    }
  } catch (err) {
    console.error("[Main] Llama.cpp autostart failed:", err);
  }

  // Register global shortcuts for layout slots (skip on Wayland — Electron's
  // globalShortcut is X11-based and can destabilize Plasma/KWin)
  const isWaylandSession =
    process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY;
  if (!isWaylandSession) {
    try {
      const slots = layoutManager.listSlots();
      for (const slot of slots) {
        if (slot.hotkey) {
          const registered = electron.globalShortcut.register(slot.hotkey, () => {
            console.log(`[GlobalShortcut] Triggered slot ${slot.letter}: ${slot.name}`);
            layoutManager.applySlotByLetter(slot.letter);
          });
          if (registered) {
            console.log(`[GlobalShortcut] Registered ${slot.hotkey} for slot ${slot.letter}`);
          } else {
            console.warn(`[GlobalShortcut] Failed to register ${slot.hotkey} for slot ${slot.letter}`);
          }
        }
      }
    } catch (err) {
      console.error("[GlobalShortcut] Registration failed:", err);
    }
  } else {
    console.log("[GlobalShortcut] Skipping registration on Wayland session");
  }

  // Start window auto-detection polling (every 10 seconds, or disabled via env)
  const pollingDisabled = process.env.REPROMPTY_DISABLE_WINDOW_POLL === "1";
  if (!pollingDisabled) {
    setInterval(async () => {
      try {
        const windows = await platform.detectWindows();
        mainWindow?.webContents?.send("windows-detected", windows);
      } catch {
        // Ignore detection errors during polling
      }
    }, 10000);
  }
});

electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});

electron.app.on("activate", () => {
  if (electron.BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers for MCP tools
electron.ipcMain.handle("run-mcp-tool", async (_event: any, toolName: string, args: Record<string, unknown>) => {
  console.log("[IPC] run-mcp-tool request:", toolName, args);
  if (!runMCPTool) {
    const mcpModule = await import("../mcp/index.js");
    runMCPTool = mcpModule.runMCPTool;
  }
  const result = await runMCPTool(toolName, args);
  console.log("[IPC] run-mcp-tool result:", toolName, result);
  return result;
});

// ============================================================================
// CONNECTION MANAGEMENT IPC HANDLERS (persisted via ConnectionManager)
// ============================================================================

electron.ipcMain.handle("list-connections", async () => {
  return connectionManager.listConnections();
});

electron.ipcMain.handle("add-connection", async (_event: any, args: { name: string; type: string; config: Record<string, unknown> }) => {
  const connection = connectionManager.addConnection(
    args.type as any,
    args.name,
    args.config as any
  );
  console.log("[IPC] add-connection:", connection.id, connection.name);
  return connection;
});

electron.ipcMain.handle("remove-connection", async (_event: any, id: string) => {
  // Clean up any IPC client for this connection
  const conn = connectionManager.getConnection(id);
  if (conn?.type === "vscode-window") {
    const cfg = conn.config as VSCodeWindowConfig;
    if (cfg.socketPath) {
      removeIpcClient(cfg.socketPath);
    }
  }
  return connectionManager.removeConnection(id);
});

// ============================================================================
// SPAWN WINDOW IPC HANDLER
// ============================================================================

// ============================================================================
// WINDOW DETECTION IPC HANDLER
// ============================================================================

electron.ipcMain.handle("detect-windows", async () => {
  try {
    return await platform.detectWindows();
  } catch (err) {
    console.error("[IPC] detect-windows error:", err);
    return [];
  }
});

// ============================================================================
// SEND TO DETECTED WINDOW (no persistent connection needed)
// ============================================================================

electron.ipcMain.handle("send-to-detected", async (_event: any, args: { window: any; prompt: string }) => {
  const win = args.window;
  const prompt = args.prompt;

  // Direct file logging (bypasses console wrapper which may be broken)
  const dbg = (msg: string) => {
    try { fs.appendFileSync(nodePath.join(process.env.USERPROFILE || ".", "reprompty-cdp-debug.log"), `${new Date().toISOString()} ${msg}\n`); } catch {}
  };

  dbg(
    `send-to-detected called: activeAgent=${win.activeAgent} backgroundRoute=${win.backgroundRoute} pipePath=${win.pipePath} handle=${win.handle}`
  );

  // Try background IPC pipe (Kilo Code)
  if (win.backgroundRoute === "ipc-kilo" && win.pipePath) {
    try {
      const client = getOrCreateIpcClient(win.pipePath);
      const ready = await client.waitForReady();
      if (ready) {
        client.sendTaskMessage(prompt);
        return { success: true, method: "background-ipc" };
      }
    } catch (err) {
      console.error("[send-to-detected] IPC failed:", err);
    }
  }

  // Try CDP for the currently active side-panel agent
  if (
    win.backgroundRoute === "cdp-claude" ||
    win.backgroundRoute === "cdp-codex" ||
    win.backgroundRoute === "cdp-kilo" ||
    win.backgroundRoute === "cdp-kimi"
  ) {
    try {
      dbg("Trying CDP...");
      const port = platform.getCdpPort();
      dbg(`CDP port: ${port}`);
      if (port) {
        dbg("Importing cdp-client...");
        const { sendViaAgentCdp } = await import("../core/cdp-client.js");
        dbg(`sendViaAgentCdp imported, calling for ${win.activeAgent}...`);
        const result = await sendViaAgentCdp(port, prompt, {
          agent: win.activeAgent,
          windowTitle: win.title,
        });
        dbg(`CDP result: ${JSON.stringify(result)}`);
        if (result.success) {
          return { success: true, method: win.backgroundRoute };
        }
        dbg("CDP send returned failure, falling through");
      } else {
        dbg("No CDP port available");
      }
    } catch (err) {
      dbg(`CDP error: ${err instanceof Error ? err.stack : String(err)}`);
    }
  }

  return {
    success: false,
    error:
      win.backgroundRoute === "foreground"
        ? "No background route available for this window"
        : `Failed to send via ${win.backgroundRoute}`,
  };
});

electron.ipcMain.handle("spawn-window", async (_event: any, args: { folderPath: string; windowName?: string; desktop?: string; activateDesktop?: boolean }) => {
  try {
    const { callTool } = await import("../mcp/index.js");
    const result = await callTool("spawn_window", {
      folderPath: args.folderPath,
      windowName: args.windowName,
      desktop: args.desktop,
      activateDesktop: args.activateDesktop,
    });
    const payload = result.content[0]?.text ?? "";

    try {
      return JSON.parse(payload);
    } catch {
      return {
        success: false,
        error: payload || "Failed to spawn VS Code window",
      };
    }
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

electron.ipcMain.handle("spawn-targets-list", async () => {
  return spawnTargetManager.listTargets();
});

electron.ipcMain.handle("virtual-desktops-list", async () => {
  return listVirtualDesktops();
});

electron.ipcMain.handle(
  "spawn-targets-add",
  async (
    _event: any,
    args: {
      id?: string;
      label: string;
      folderPath: string;
      windowName?: string;
      desktop?: string;
    }
  ) => {
    return spawnTargetManager.addTarget(args);
  }
);

electron.ipcMain.handle(
  "spawn-targets-update",
  async (_event: any, id: string, updates: Record<string, unknown>) => {
    return spawnTargetManager.updateTarget(id, updates as any);
  }
);

electron.ipcMain.handle("spawn-targets-remove", async (_event: any, id: string) => {
  return spawnTargetManager.removeTarget(id);
});

// ============================================================================
// DAISY CHAIN IPC HANDLER
// ============================================================================

electron.ipcMain.handle("daisy-chain", async (_event: any, args: { prompts: Array<{ connectionId: string; prompt: string }>; continueOnError?: boolean }) => {
  const results: Array<{ connectionId: string; success: boolean; error?: string }> = [];

  for (const item of args.prompts) {
    const conn = connectionManager.getConnection(item.connectionId);
    if (!conn) {
      results.push({ connectionId: item.connectionId, success: false, error: "Connection not found" });
      if (!args.continueOnError) break;
      continue;
    }

    if (conn.type === "vscode-window") {
      const cfg = conn.config as VSCodeWindowConfig;
      try {
        if (cfg.method === "background" && cfg.socketPath) {
          const client = getOrCreateIpcClient(cfg.socketPath);
          const ready = await client.waitForReady();
          if (!ready) throw new Error("IPC client not ready");
          client.sendTaskMessage(item.prompt);
        } else if (cfg.windowHandle) {
          await platform.sendMessageForeground(cfg.windowHandle, item.prompt);
        } else {
          throw new Error("No socketPath or windowHandle");
        }
        results.push({ connectionId: item.connectionId, success: true });
      } catch (err) {
        results.push({ connectionId: item.connectionId, success: false, error: String(err) });
        if (!args.continueOnError) break;
      }
    } else {
      results.push({ connectionId: item.connectionId, success: false, error: `Unsupported type: ${conn.type}` });
      if (!args.continueOnError) break;
    }
  }

  return { results };
});

// Handle external links
electron.ipcMain.on("open-external", (_event: any, url: string) => {
  electron.shell.openExternal(url);
});

// ============================================================================
// SCRIPT MANAGEMENT IPC HANDLERS
// ============================================================================

electron.ipcMain.handle("scripts-list", async () => {
  return scriptManager.listScripts();
});

electron.ipcMain.handle("scripts-add", async (_event: any, args: { name: string; path: string; type?: string; args?: string[] }) => {
  return scriptManager.addScript(args.name, args.path, args.type as any, args.args || []);
});

electron.ipcMain.handle("scripts-remove", async (_event: any, id: string) => {
  return scriptManager.removeScript(id);
});

electron.ipcMain.handle("scripts-run", async (_event: any, id: string) => {
  return scriptManager.runScript(id);
});

electron.ipcMain.handle("scripts-stop", async (_event: any, id: string) => {
  return scriptManager.stopScript(id);
});

electron.ipcMain.handle("scripts-update", async (_event: any, id: string, updates: Record<string, unknown>) => {
  return scriptManager.updateScript(id, updates);
});

electron.ipcMain.handle("scripts-rescan-mcp-actions", async (_event: any, id: string) => {
  return scriptManager.rescanMcpActions(id);
});

electron.ipcMain.handle("scripts-set-layout-role", async (_event: any, id: string, role: string | null) => {
  return scriptManager.setLayoutRole(id, role as any);
});

electron.ipcMain.handle("scripts-get-output", async (_event: any, id: string) => {
  return scriptManager.getOutput(id);
});

electron.ipcMain.handle("scripts-pick-file", async () => {
  const { dialog } = require("electron");
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Scripts", extensions: process.platform === "win32" ? ["ps1", "bat", "cmd", "vbs", "exe"] : ["sh", "py", "bash", "zsh", "ps1"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ============================================================================
// LAYOUT SLOTS IPC HANDLERS
// ============================================================================

electron.ipcMain.handle("layouts-list", async () => {
  return layoutManager.listSlots();
});

electron.ipcMain.handle("layouts-add", async (_event: any, slot: any) => {
  return layoutManager.addSlot(slot);
});

electron.ipcMain.handle("layouts-update", async (_event: any, id: string, updates: any) => {
  return layoutManager.updateSlot(id, updates);
});

electron.ipcMain.handle("layouts-remove", async (_event: any, id: string) => {
  return layoutManager.removeSlot(id);
});

electron.ipcMain.handle("layouts-apply", async (_event: any, id: string) => {
  return layoutManager.applySlot(id);
});

electron.ipcMain.handle("layouts-get-script-path", async () => {
  return layoutManager.getScriptPath();
});

electron.ipcMain.handle("layouts-set-script-path", async (_event: any, scriptPath: string) => {
  layoutManager.setScriptPath(scriptPath);
  return true;
});

// ============================================================================
// PORTAINER PROXY (bypasses renderer self-signed cert restrictions)
// ============================================================================

import https from "node:https";

electron.ipcMain.handle("portainer-fetch", async (_event: any, method: string, url: string, body?: string) => {
  return new Promise<{ ok: boolean; status: number; data: string }>((resolve) => {
    const options = new URL(url);
    const reqOptions: https.RequestOptions = {
      hostname: options.hostname,
      port: options.port,
      path: options.pathname + options.search,
      method: method.toUpperCase(),
      rejectUnauthorized: false,
      headers: {
        "Content-Type": "application/json",
      },
    };

    const req = https.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({ ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode || 0, data });
      });
    });

    req.on("error", (err) => {
      resolve({ ok: false, status: 0, data: String(err) });
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
});

// ============================================================================
// LLAMA.CPP PRESET MANAGEMENT + SERVER CONTROL
// ============================================================================

import os from "node:os";
import { spawn, exec } from "node:child_process";
import net from "node:net";

const REPROMPTY_CONFIG_DIR = nodePath.join(os.homedir(), ".config", "reprompty");
const LLAMA_PRESETS_DIR = nodePath.join(REPROMPTY_CONFIG_DIR, "llama-cpp-presets");
const LLAMA_SERVERS_FILE = nodePath.join(REPROMPTY_CONFIG_DIR, "llama-servers.json");
const LLAMA_CONFIG_FILE = nodePath.join(REPROMPTY_CONFIG_DIR, "llama-config.json");
const LLAMA_LOGS_DIR = nodePath.join(REPROMPTY_CONFIG_DIR, "llama-logs");
const GRAPHITI_COMPOSE_DIR = nodePath.join(os.homedir(), "Projects", "OS-Toolkit", "graphiti-mcp");

function ensureConfigDir() {
  if (!fs.existsSync(REPROMPTY_CONFIG_DIR)) {
    fs.mkdirSync(REPROMPTY_CONFIG_DIR, { recursive: true });
  }
  if (!fs.existsSync(LLAMA_PRESETS_DIR)) {
    fs.mkdirSync(LLAMA_PRESETS_DIR, { recursive: true });
  }
  if (!fs.existsSync(LLAMA_LOGS_DIR)) {
    fs.mkdirSync(LLAMA_LOGS_DIR, { recursive: true });
  }
}

// ============================================================================
// Multi-server registry helpers
// ============================================================================

interface ServerEntry {
  pid: number;
  port: number;
  preset: string;
  startedAt: string;
  logPath?: string;
}

function readServersRegistry(): ServerEntry[] {
  if (!fs.existsSync(LLAMA_SERVERS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(LLAMA_SERVERS_FILE, "utf-8"));
    if (Array.isArray(data)) return data;
    // Legacy single-object format migration
    if (data && typeof data.pid === "number") return [data as ServerEntry];
  } catch {
    // ignore parse errors
  }
  return [];
}

function writeServersRegistry(servers: ServerEntry[]) {
  fs.writeFileSync(LLAMA_SERVERS_FILE, JSON.stringify(servers, null, 2));
}

function isPortListening(port: number): boolean {
  try {
    const conn = net.createConnection({ port, host: "127.0.0.1" });
    conn.destroy();
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(entry: ServerEntry): boolean {
  if (!entry.pid || entry.pid <= 0) {
    // Fallback: check port if PID is invalid
    return isPortListening(entry.port);
  }
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch (err: any) {
    if (err.code === 'EPERM') {
      // Process exists but no signal permission → alive
      return true;
    }
    // ESRCH or other error → process is dead, but verify via port just in case
    return isPortListening(entry.port);
  }
}

function pruneDeadServers(): ServerEntry[] {
  const servers = readServersRegistry();
  const alive: ServerEntry[] = [];
  const dead: ServerEntry[] = [];
  for (const s of servers) {
    if (isProcessAlive(s)) {
      alive.push(s);
    } else {
      dead.push(s);
      console.log(`[Llama] Pruned dead server: ${s.preset} (PID ${s.pid}, port ${s.port})`);
    }
  }
  if (dead.length > 0) {
    console.log(`[Llama] Pruned ${dead.length} dead server(s), ${alive.length} remaining`);
    writeServersRegistry(alive);
  }
  return alive;
}

function getRunningServerForPreset(presetName: string): ServerEntry | undefined {
  return pruneDeadServers().find((s) => s.preset === presetName);
}

async function stopServerByPreset(presetName: string): Promise<boolean> {
  const servers = readServersRegistry();
  const entry = servers.find((s) => s.preset === presetName);
  if (!entry) return false;

  try {
    process.kill(entry.pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      process.kill(entry.pid, 0);
      process.kill(entry.pid, "SIGKILL");
    } catch {}
  } catch {}

  writeServersRegistry(servers.filter((s) => s.preset !== presetName));
  return true;
}

function readLlamaConfig(): Record<string, unknown> {
  if (!fs.existsSync(LLAMA_CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LLAMA_CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeLlamaConfig(config: Record<string, unknown>) {
  fs.writeFileSync(LLAMA_CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getLlamaServerPath(): string | null {
  const config = fs.existsSync(LLAMA_CONFIG_FILE)
    ? JSON.parse(fs.readFileSync(LLAMA_CONFIG_FILE, "utf-8"))
    : {};
  if (config.binaryPath && fs.existsSync(config.binaryPath)) {
    return config.binaryPath;
  }
  const candidates = [
    nodePath.join(os.homedir(), ".local", "bin", "llama-server"),
    "/usr/local/bin/llama-server",
    "/usr/bin/llama-server",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function getHardwareDefaults() {
  const cpus = os.cpus().length;
  const ramBytes = os.totalmem();
  const ramGiB = Math.round(ramBytes / (1024 ** 3));
  return {
    threads: Math.min(cpus, 32),
    contextSize: ramGiB > 100 ? 65536 : 32768,
    batchSize: ramGiB > 50 ? 1024 : 512,
    ubatchSize: 512,
    ramGiB,
    cpus,
  };
}

function createDefaultPresets() {
  ensureConfigDir();
  const hw = getHardwareDefaults();
  const defaults: Record<string, unknown> = {
    "qwen3-embedding:8b": {
      name: "qwen3-embedding:8b",
      modelPath: nodePath.join(os.homedir(), ".local", "share", "models", "qwen3-embedding-8b-q8_0.gguf"),
      modelType: "embedding",
      quantization: "Q8_0",
      port: 8081,
      contextSize: 8192,
      gpuLayers: 0,
      threads: hw.threads,
      batchSize: hw.batchSize,
      ubatchSize: hw.ubatchSize,
      temperature: 0.0,
      topP: 1.0,
      topK: 0,
      repeatPenalty: 1.0,
      maxTokens: -1,
      chatTemplate: "",
      extraArgs: "--embedding",
    },
    "gemma-4-31b-chat": {
      name: "gemma-4-31b-chat",
      modelPath: nodePath.join(os.homedir(), ".local", "share", "models", "gemma-4-31b-it-Q8_0.gguf"),
      modelType: "chat",
      quantization: "Q8_0",
      port: 8082,
      contextSize: hw.contextSize,
      gpuLayers: 0,
      threads: hw.threads,
      batchSize: hw.batchSize,
      ubatchSize: hw.ubatchSize,
      temperature: 0.8,
      topP: 0.9,
      topK: 40,
      repeatPenalty: 1.1,
      maxTokens: -1,
      chatTemplate: "gemma",
      extraArgs: "",
    },
    "qwen3.6-27b-chat": {
      name: "qwen3.6-27b-chat",
      modelPath: nodePath.join(os.homedir(), ".local", "share", "models", "qwen3.6-27b-Q8_0.gguf"),
      modelType: "chat",
      quantization: "Q8_0",
      port: 8083,
      contextSize: hw.contextSize,
      gpuLayers: 0,
      threads: hw.threads,
      batchSize: hw.batchSize,
      ubatchSize: hw.ubatchSize,
      temperature: 0.8,
      topP: 0.9,
      topK: 40,
      repeatPenalty: 1.1,
      maxTokens: -1,
      chatTemplate: "qwen",
      extraArgs: "",
    },
    "vocal-model": {
      name: "vocal-model",
      modelPath: nodePath.join(os.homedir(), ".local", "share", "models", "vocal-model.gguf"),
      modelType: "voice",
      quantization: "Q8_0",
      port: 8084,
      contextSize: 4096,
      gpuLayers: 0,
      threads: hw.threads,
      batchSize: 512,
      ubatchSize: 512,
      temperature: 0.6,
      topP: 0.9,
      topK: 40,
      repeatPenalty: 1.0,
      maxTokens: -1,
      chatTemplate: "",
      extraArgs: "",
    },
  };
  for (const [name, preset] of Object.entries(defaults)) {
    const path = nodePath.join(LLAMA_PRESETS_DIR, `${name}.json`);
    if (!fs.existsSync(path)) {
      fs.writeFileSync(path, JSON.stringify(preset, null, 2));
    }
  }
}

// Llama.cpp IPC handlers
electron.ipcMain.handle("llama-list-presets", async () => {
  ensureConfigDir();
  createDefaultPresets();
  const files = fs.readdirSync(LLAMA_PRESETS_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => f.replace(".json", ""));
});

electron.ipcMain.handle("llama-load-preset", async (_event: any, name: string) => {
  ensureConfigDir();
  const path = nodePath.join(LLAMA_PRESETS_DIR, `${name}.json`);
  if (!fs.existsSync(path)) return null;
  return JSON.parse(fs.readFileSync(path, "utf-8"));
});

electron.ipcMain.handle("llama-save-preset", async (_event: any, name: string, data: unknown) => {
  ensureConfigDir();
  const path = nodePath.join(LLAMA_PRESETS_DIR, `${name}.json`);
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
  return true;
});

electron.ipcMain.handle("llama-delete-preset", async (_event: any, name: string) => {
  const path = nodePath.join(LLAMA_PRESETS_DIR, `${name}.json`);
  if (fs.existsSync(path)) fs.unlinkSync(path);
  return true;
});

electron.ipcMain.handle("llama-start", async (_event: any, presetName: string) => {
  const binary = getLlamaServerPath();
  if (!binary) return { success: false, error: "llama-server not found. Install llama.cpp or set binary path in config." };

  ensureConfigDir();
  const presetPath = nodePath.join(LLAMA_PRESETS_DIR, `${presetName}.json`);
  if (!fs.existsSync(presetPath)) return { success: false, error: `Preset '${presetName}' not found` };
  const preset = JSON.parse(fs.readFileSync(presetPath, "utf-8"));

  // Check if this preset is already running
  const existing = getRunningServerForPreset(presetName);
  if (existing) {
    return { success: false, error: `Preset '${presetName}' is already running on port ${existing.port}. Stop it first.` };
  }

  const args = [
    "-m", preset.modelPath,
    "--port", String(preset.port || 8080),
    "-c", String(preset.contextSize || 4096),
    "-t", String(preset.threads || 4),
    "-b", String(preset.batchSize || 512),
    "-ub", String(preset.ubatchSize || 512),
    "--temp", String(preset.temperature ?? 0.8),
    "--top-p", String(preset.topP ?? 0.9),
    "--top-k", String(preset.topK ?? 40),
    "--repeat-penalty", String(preset.repeatPenalty ?? 1.1),
    "-n", String(preset.maxTokens ?? -1),
  ];
  if (preset.gpuLayers) args.push("-ngl", String(preset.gpuLayers));
  if (preset.chatTemplate) args.push("--chat-template", preset.chatTemplate);
  if (preset.extraArgs) args.push(...preset.extraArgs.split(/\s+/).filter(Boolean));

  const logPath = nodePath.join(LLAMA_LOGS_DIR, `${presetName}-${Date.now()}.log`);
  const logFd = fs.openSync(logPath, "a");
  const proc = spawn(binary, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  proc.unref();
  fs.closeSync(logFd);

  const servers = readServersRegistry();
  servers.push({
    pid: proc.pid!,
    port: preset.port || 8080,
    preset: presetName,
    startedAt: new Date().toISOString(),
    logPath,
  });
  writeServersRegistry(servers);

  return { success: true, pid: proc.pid, port: preset.port || 8080 };
});

electron.ipcMain.handle("llama-stop", async () => {
  const servers = pruneDeadServers();
  for (const entry of servers) {
    try {
      process.kill(entry.pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      try { process.kill(entry.pid, 0); process.kill(entry.pid, "SIGKILL"); } catch {}
    } catch {}
  }
  writeServersRegistry([]);
  return { success: true };
});

electron.ipcMain.handle("llama-stop-preset", async (_event: any, presetName: string) => {
  const stopped = await stopServerByPreset(presetName);
  return { success: stopped };
});

electron.ipcMain.handle("llama-status", async () => {
  // Return raw registry without pruning — pruning happens on start/stop actions
  const servers = readServersRegistry();
  const result: Array<{ running: boolean; pid: number; port: number; preset: string; logPath?: string }> = [];
  for (const s of servers) {
    const alive = isProcessAlive(s);
    result.push({ running: alive, pid: s.pid, port: s.port, preset: s.preset, logPath: s.logPath });
    if (!alive) {
      console.log(`[Llama] Status check found dead server: ${s.preset} (PID ${s.pid}, port ${s.port})`);
    }
  }
  return result;
});

electron.ipcMain.handle("llama-get-autostart", async () => {
  const config = readLlamaConfig();
  return Array.isArray(config.autostart) ? config.autostart : [];
});

electron.ipcMain.handle("llama-set-autostart", async (_event: any, presetName: string, enabled: boolean) => {
  const config = readLlamaConfig();
  const list = Array.isArray(config.autostart) ? [...(config.autostart as string[])] : [];
  const idx = list.indexOf(presetName);
  if (enabled && idx === -1) {
    list.push(presetName);
  } else if (!enabled && idx !== -1) {
    list.splice(idx, 1);
  }
  config.autostart = list;
  writeLlamaConfig(config);
  return list;
});

electron.ipcMain.handle("llama-get-binary-path", async () => {
  return getLlamaServerPath();
});

electron.ipcMain.handle("llama-set-binary-path", async (_event: any, binaryPath: string) => {
  ensureConfigDir();
  const config = fs.existsSync(LLAMA_CONFIG_FILE) ? JSON.parse(fs.readFileSync(LLAMA_CONFIG_FILE, "utf-8")) : {};
  config.binaryPath = binaryPath;
  fs.writeFileSync(LLAMA_CONFIG_FILE, JSON.stringify(config, null, 2));
  return true;
});

// Graphiti MCP IPC handlers
electron.ipcMain.handle("graphiti-start", async () => {
  return new Promise((resolve) => {
    exec("docker compose up -d", { cwd: GRAPHITI_COMPOSE_DIR }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || String(error) });
      } else {
        resolve({ success: true, output: stdout });
      }
    });
  });
});

electron.ipcMain.handle("graphiti-stop", async () => {
  return new Promise((resolve) => {
    exec("docker compose down", { cwd: GRAPHITI_COMPOSE_DIR }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || String(error) });
      } else {
        resolve({ success: true, output: stdout });
      }
    });
  });
});

electron.ipcMain.handle("graphiti-status", async () => {
  return new Promise((resolve) => {
    exec("docker compose ps --format json", { cwd: GRAPHITI_COMPOSE_DIR }, (error, stdout) => {
      if (error) {
        resolve({ running: false });
        return;
      }
      const lines = stdout.trim().split("\n").filter(Boolean);
      const running = lines.some((line) => {
        try {
          const obj = JSON.parse(line);
          return obj.State === "running";
        } catch { return false; }
      });
      resolve({ running });
    });
  });
});

electron.ipcMain.handle("open-path", async (_event, filePath: string) => {
  const result = await electron.shell.openPath(filePath);
  return result;
});

// Allow self-signed certificates for local Portainer
electron.app.on("certificate-error", (event, _webContents, url, _error, _certificate, callback) => {
  if (url.includes("localhost:9443") || url.includes("127.0.0.1:9443")) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

// Clean shutdown - stop all scripts
electron.app.on("before-quit", () => {
  try {
    scriptManager.stopAll();
  } catch {
    // Ignore errors during shutdown
  }
});
