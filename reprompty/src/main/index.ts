import { createRequire } from "node:module";

// Use createRequire to avoid bundling issues
// @ts-ignore
const require = createRequire(import.meta.url);
// @ts-ignore
let electron;
try {
  // Try to get the electron module
  const e = require("electron");
  if (typeof e !== "object" || !e.app) {
    // Fallback: use mock if not loaded properly
    console.warn("Electron module not loaded properly, using mock");
    electron = {
      app: { whenReady: () => Promise.resolve(), quit: () => {}, on: () => {} },
      BrowserWindow: class { constructor() { this.loadURL = () => {}; this.webContents = { openDevTools: () => {} }; this.on = () => {}; this.show = () => {}; this.hide = () => {}; this.focus = () => {}; } },
      ipcMain: { handle: () => {}, on: () => {} },
      Tray: class { constructor() { this.setToolTip = () => {}; this.setContextMenu = () => {}; this.on = () => {}; this.destroy = () => {}; } },
      Menu: { buildFromTemplate: () => ({ popup: () => {}, destroy: () => {} }) },
      nativeImage: { createFromDataURL: (dataUrl: string) => ({ isEmpty: () => !dataUrl, getSize: () => ({ width: 16, height: 16 }) }) },
      shell: { openExternal: () => Promise.resolve() }
    };
  } else {
    electron = e;
  }
} catch (err) {
  console.error("Failed to require electron:", err);
  electron = {
    app: { whenReady: () => Promise.resolve(), quit: () => {}, on: () => {} },
    BrowserWindow: () => ({ loadURL: () => {}, webContents: { openDevTools: () => {} }, on: () => {}, show: () => {}, hide: () => {}, focus: () => {} }),
    ipcMain: { handle: () => {}, on: () => {} },
    Tray: () => {},
    Menu: { buildFromTemplate: () => ({ popup: () => {}, destroy: () => {} }) },
    nativeImage: { createFromDataURL: (dataUrl: string) => ({ isEmpty: () => !dataUrl, getSize: () => ({ width: 16, height: 16 }) }) },
    shell: { openExternal: () => Promise.resolve() }
  };
}

// @ts-ignore
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = electron;
import path from "path";
import { join } from "node:path";

// Only import MCP tools when needed (lazy load)
let runMCPTool: (toolName: string, args: Record<string, unknown>) => Promise<string>;

// Electron main process - rebuilt
// @ts-ignore
let mainWindow: any = null;
// @ts-ignore
let tray: any = null;

const isDev = !app.isPackaged;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    title: "Reprompty",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, "../preload/index.js"),
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("close", (event) => {
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
  // Create a simple 16x16 triangle icon for the tray
  // This is a 16x16 cyan triangle PNG
  const iconDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA2ElEQVQ4T6WTuw3CQBBE3y4OQIQgRaACIhE5AjfgClyBK3AEjkBEB6hUKhUKVUJEBBEBkYTNJu3G8VrtjTTa1Zv/5s3s7FoB/1uN1QB+AJ9RL2AH7IE7YA+8AB9RM3ADbIEtcAVugCfgM2qGz8AtsAau8gTu8wf+8gf+9Af+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gf+8gX8AOHUCFAkCALsAAAAASUVORK5CYII=";
  
  const icon = nativeImage.createFromDataURL(iconDataUrl);
  
  console.log("[Tray] Creating tray icon, size:", icon.getSize());
  console.log("[Tray] Is empty:", icon.isEmpty());
  
  tray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
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
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip("Reprompty");
  tray.setContextMenu(contextMenu);
  
  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

// App lifecycle
app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers for MCP tools
ipcMain.handle("run-mcp-tool", async (_event: any, toolName: string, args: Record<string, unknown>) => {
  if (!runMCPTool) {
    const mcpModule = await import("../mcp/index.js");
    runMCPTool = mcpModule.runMCPTool;
  }
  return runMCPTool(toolName, args);
});

// Connection management handlers
// In-memory storage for connections (in production, this would be persisted)
const connections: Array<{id: string; name: string; type: string; config: Record<string, unknown>}> = [];

ipcMain.handle("list-connections", async () => {
  console.log("[IPC] list-connections called, returning:", connections);
  return connections;
});

ipcMain.handle("add-connection", async (_event: any, args: {name: string; type: string; config: Record<string, unknown>}) => {
  const id = Date.now().toString();
  const connection = { id, ...args };
  connections.push(connection);
  console.log("[IPC] add-connection:", connection);
  return connection;
});

ipcMain.handle("remove-connection", async (_event: any, id: string) => {
  const index = connections.findIndex(c => c.id === id);
  if (index !== -1) {
    connections.splice(index, 1);
    console.log("[IPC] remove-connection:", id);
    return true;
  }
  return false;
});

// Handle external links
ipcMain.on("open-external", (_event, url: string) => {
  shell.openExternal(url);
});
