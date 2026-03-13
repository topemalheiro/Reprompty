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
      nativeImage: { createFromDataURL: () => ({ isEmpty: () => false, getSize: () => ({ width: 0, height: 0 }) }) },
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
    nativeImage: { createFromDataURL: () => ({ isEmpty: () => false, getSize: () => ({ width: 0, height: 0 }) }) },
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
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const isDev = true;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    title: "Reprompty",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, "preload.js"),
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
  // Create a simple 16x16 cyan square icon for the tray
  // This is valid PNG base64 data for a 16x16 cyan/teal colored square
  const iconDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAH0lEQVQ4T2NkYGD4z0ABYBw1gGE0DBhGwwBm0ACGYRQMAADt9Qf/WqLbFwAAAABJRU5ErkJggg==";
  
  const icon = nativeImage.createFromDataURL(iconDataUrl);
  
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
ipcMain.handle("run-mcp-tool", async (_event, toolName: string, args: Record<string, unknown>) => {
  if (!runMCPTool) {
    const mcpModule = await import("../mcp/index.js");
    runMCPTool = mcpModule.runTool;
  }
  return runMCPTool(toolName, args);
});

// Handle external links
ipcMain.on("open-external", (_event, url: string) => {
  shell.openExternal(url);
});
