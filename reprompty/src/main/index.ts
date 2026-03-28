// ============================================================================
// REPROMPTY - Electron Main Process
// ============================================================================

import fs from "node:fs";
import nodePath from "node:path";
import { join } from "node:path";
import { scriptManager } from "../core/script-manager.js";
import { connectionManager } from "../core/connection-manager.js";
import { getOrCreateIpcClient, removeIpcClient } from "../core/ipc-client.js";
import type { VSCodeWindowConfig } from "../core/connection-manager.js";

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
const electronModule = require('electron');
const electron = {
  app: electronModule.app,
  BrowserWindow: electronModule.BrowserWindow,
  Tray: electronModule.Tray,
  Menu: electronModule.Menu,
  nativeImage: electronModule.nativeImage,
  ipcMain: electronModule.ipcMain,
  shell: electronModule.shell
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

  // Start window auto-detection polling (every 5 seconds)
  setInterval(async () => {
    try {
      const { detectWindows } = await import("../platform/windows.js");
      const windows = detectWindows();
      mainWindow?.webContents?.send("windows-detected", windows);
    } catch {
      // Ignore detection errors during polling
    }
  }, 5000);
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
  if (!runMCPTool) {
    const mcpModule = await import("../mcp/index.js");
    runMCPTool = mcpModule.runMCPTool;
  }
  return runMCPTool(toolName, args);
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
    const { detectWindows } = await import("../platform/windows.js");
    return detectWindows();
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

  dbg(`send-to-detected called: extension=${win.extension} pipePath=${win.pipePath} handle=${win.handle}`);

  // Try background IPC pipe (Kilo Code)
  if (win.pipePath) {
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

  // Try CDP (Claude Code)
  if (win.extension === "claude-code" || !win.pipePath) {
    try {
      dbg("Trying CDP...");
      const { getCdpPort } = await import("../platform/windows.js");
      const port = getCdpPort();
      dbg(`CDP port: ${port}`);
      if (port) {
        dbg("Importing cdp-client...");
        const { sendViaCdp } = await import("../core/cdp-client.js");
        dbg("sendViaCdp imported, calling...");
        const result = await sendViaCdp(port, prompt, win.title);
        dbg(`CDP result: ${JSON.stringify(result)}`);
        if (result.success) {
          return { success: true, method: "background-cdp" };
        }
        dbg("CDP send returned failure, falling through");
      } else {
        dbg("No CDP port available");
      }
    } catch (err) {
      dbg(`CDP error: ${err instanceof Error ? err.stack : String(err)}`);
    }
  }

  return { success: false, error: "CDP send failed - no foreground fallback" };
});

electron.ipcMain.handle("spawn-window", async (_event: any, args: { folderPath: string; windowName?: string }) => {
  try {
    const { spawnWindow } = await import("../platform/windows.js");
    return spawnWindow(args.folderPath, args.windowName);
  } catch (err) {
    return { success: false, error: String(err) };
  }
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
          const { sendMessageForeground } = await import("../platform/windows.js");
          await sendMessageForeground(cfg.windowHandle, item.prompt);
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
      { name: "Scripts", extensions: ["ps1", "bat", "cmd", "vbs", "exe"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Clean shutdown - stop all scripts
electron.app.on("before-quit", () => {
  try {
    scriptManager.stopAll();
  } catch {
    // Ignore errors during shutdown
  }
});
