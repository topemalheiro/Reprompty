// ============================================================================
// REPROMPTY - Electron Main Process
// ============================================================================

import fs from "node:fs";
import nodePath from "node:path";
import { join } from "node:path";

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

// Use require() to get Electron modules - this works in bundled code
const electron = {
  app: require('electron').app,
  BrowserWindow: require('electron').BrowserWindow,
  Tray: require('electron').Tray,
  Menu: require('electron').Menu,
  nativeImage: require('electron').nativeImage,
  ipcMain: require('electron').ipcMain,
  shell: require('electron').shell
};

console.log("[Main] Using require() electron (real Electron)");
console.log("[Main] nativeImage type:", typeof electron.nativeImage);
console.log("[Main] nativeImage.createFromPath:", typeof electron.nativeImage?.createFromPath);
console.log("[Main] nativeImage.createFromDataURL:", typeof electron.nativeImage?.createFromDataURL);

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
  
  mainWindow = new electron.BrowserWindow({
    width: 900,
    height: 700,
    title: "Reprompty",
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
    // Fallback: 32x32 cyan triangle icon (known working)
    const iconDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAhElEQVRYR+2WMQ6AIAwD+/+P1oGBsVBsbLTc1EtLiJDi7kJb0iHJt7NJ+vLpBwDwLwCA/xIAgH8BAPyXAMD/CgDgvwQA4F8AAP8lAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IXoA7wABVQJYpgAAAABJRU5ErkJggg==";
    
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

// App lifecycle
electron.app.whenReady().then(() => {
  console.log("=== APP READY ===");
  createWindow();
  createTray();
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

// Connection management handlers
// In-memory storage for connections (in production, this would be persisted)
const connections: Array<{id: string; name: string; type: string; config: Record<string, unknown>}> = [];

electron.ipcMain.handle("list-connections", async () => {
  console.log("[IPC] list-connections called, returning:", connections);
  return connections;
});

electron.ipcMain.handle("add-connection", async (_event: any, args: {name: string; type: string; config: Record<string, unknown>}) => {
  const id = Date.now().toString();
  const connection = { id, ...args };
  connections.push(connection);
  console.log("[IPC] add-connection:", connection);
  return connection;
});

electron.ipcMain.handle("remove-connection", async (_event: any, id: string) => {
  const index = connections.findIndex(c => c.id === id);
  if (index !== -1) {
    connections.splice(index, 1);
    console.log("[IPC] remove-connection:", id);
    return true;
  }
  return false;
});

// Handle external links
electron.ipcMain.on("open-external", (_event: any, url: string) => {
  electron.shell.openExternal(url);
});
