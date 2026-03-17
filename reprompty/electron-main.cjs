// ============================================================================
// REPROMPTY - Electron Main Process
// ============================================================================

const fs = require("fs");
const path = require("path");

// ============================================================================
// EARLY LOGGING
// ============================================================================

let logFile;

function setupEarlyLogging() {
  try {
    const homeDir = process.env.USERPROFILE || process.env.HOME || ".";
    const logDir = path.join(homeDir, "reprompty-logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    logFile = path.join(logDir, `reprompty-${new Date().toISOString().split('T')[0]}.log`);
    
    const origLog = console.log;
    const origWarn = console.warn;
    const origErr = console.error;

    console.log = (...args) => {
      const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      const timestamp = new Date().toISOString();
      const logLine = `[${timestamp}] ${msg}\n`;
      try { fs.appendFileSync(logFile, logLine); } catch { /* ignore */ }
      origLog.apply(console, args);
    };
    console.warn = (...args) => {
      const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      const timestamp = new Date().toISOString();
      const logLine = `[${timestamp}] WARN: ${msg}\n`;
      try { fs.appendFileSync(logFile, logLine); } catch { /* ignore */ }
      origWarn.apply(console, args);
    };
    console.error = (...args) => {
      const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      const timestamp = new Date().toISOString();
      const logLine = `[${timestamp}] ERROR: ${msg}\n`;
      try { fs.appendFileSync(logFile, logLine); } catch { /* ignore */ }
      origErr.apply(console, args);
    };
    
    console.log("=== EARLY LOGGING SETUP ===");
    console.log("Log file:", logFile);
  } catch (e) {
    process.stderr.write(`Failed to setup early logging: ${e}\n`);
  }
}

setupEarlyLogging();

// ============================================================================
// GET ELECTRON - Try multiple methods
// ============================================================================

let app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell;

function getElectron() {
  // Method 1: Try electron-binding (internal Electron API)
  try {
    const electronDir = path.dirname(require.resolve("electron"));
    const bindingPath = path.join(electronDir, "dist", process.platform + "-" + process.arch, "electron-binding.node");
    console.log("[Main] Trying electron-binding at:", bindingPath);
    
    if (fs.existsSync(bindingPath)) {
      const binding = require(bindingPath);
      app = binding('app');
      BrowserWindow = binding('browser_window');
      Tray = binding('tray');
      Menu = binding('menu');
      nativeImage = binding('native_image');
      ipcMain = binding('ipc_main');
      shell = binding('shell');
      console.log("[Main] ✅ Loaded via electron-binding!");
      return true;
    }
  } catch(e) {
    console.log("[Main] electron-binding failed:", e.message);
  }

  // Method 2: Use eval with special require (for bundled code)
  try {
    // eslint-disable-next-line no-eval
    const electron = eval("require('electron')");
    console.log("[Main] eval require('electron') returns:", typeof electron);
    
    if (electron && typeof electron === 'object') {
      app = electron.app;
      BrowserWindow = electron.BrowserWindow;
      Tray = electron.Tray;
      Menu = electron.Menu;
      nativeImage = electron.nativeImage;
      ipcMain = electron.ipcMain;
      shell = electron.shell;
      console.log("[Main] ✅ Loaded via eval require!");
      return true;
    }
  } catch(e) {
    console.log("[Main] eval require failed:", e.message);
  }

  // Method 3: Check if globals are available (should work in normal Electron main)
  console.log("[Main] Checking for electron globals...");
  console.log("[Main] typeof app:", typeof app);
  console.log("[Main] typeof global.app:", typeof global.app);
  
  if (typeof app !== 'undefined') {
    console.log("[Main] ✅ Electron globals available directly!");
    return true;
  }

  return false;
}

const gotElectron = getElectron();
console.log("[Main] Got electron:", gotElectron);
console.log("[Main] app:", !!app, "Tray:", !!Tray, "nativeImage:", !!nativeImage);

if (!gotElectron || !app || !Tray || !nativeImage) {
  console.error("❌ FATAL: Could not get Electron APIs!");
  process.exit(1);
}

console.log("[Main] ✅ Electron APIs obtained successfully!");

// ============================================================================
// APP SETUP
// ============================================================================

// Lazy load MCP tools
let runMCPTool;

// Main process state
let mainWindow = null;
let tray = null;

const isDev = !app.isPackaged;

function createWindow() {
  console.log("[Main] isDev:", isDev);
  
  const basePath = isDev ? __dirname : path.join(__dirname, "dist");
  
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    title: "Reprompty",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(basePath, "preload/index.js"),
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(basePath, "renderer/index.html"));
  }

  mainWindow.on("close", (event) => {
    if (tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createTray() {
  console.log("=== CREATE TRAY START ===");
  
  let icon;
  
  try {
    let iconPath;
    if (isDev) {
      iconPath = path.join(__dirname, "build/icon.ico");
    } else {
      iconPath = path.join(path.dirname(process.execPath), "resources/icon.ico");
    }
    
    console.log("[Tray] Looking for icon at:", iconPath);
    
    if (fs.existsSync(iconPath)) {
      const iconBuffer = fs.readFileSync(iconPath);
      console.log("[Tray] Icon buffer length:", iconBuffer.length);
      icon = nativeImage.createFromBuffer(iconBuffer);
    } else {
      throw new Error("ICO file not found at: " + iconPath);
    }
  } catch (e) {
    console.log("[Tray] Could not load ICO, using fallback:", e.message);
    const iconDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAhElEQVRYR+2WMQ6AIAwD+/+P1oGBsVBsbLTc1EtLiJDi7kJb0iHJt7NJ+vLpBwDwLwCA/xIAgH8BAPyXAMD/CgDgvwQA4F8AAP8lAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IXoA7wABVQJYpgAAAABJRU5ErkJggg==";
    icon = nativeImage.createFromDataURL(iconDataUrl);
  }
  
  console.log("[Tray] Icon isEmpty:", icon.isEmpty());
  
  if (icon.isEmpty()) {
    console.error("[Tray] ❌ ERROR: Icon is empty!");
    return;
  }
  
  console.log("[Tray] ✅ Creating Tray...");
  tray = new Tray(icon);
  console.log("[Tray] ✅ Tray created!");
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Reprompty",
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        if (tray) {
          tray.destroy();
          tray = null;
        }
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip("Reprompty");
  tray.setContextMenu(contextMenu);
  
  tray.on("double-click", () => {
    mainWindow.show();
    mainWindow.focus();
  });
  
  console.log("=== CREATE TRAY END ===");
}

// App lifecycle
app.whenReady().then(() => {
  console.log("=== APP READY ===");
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

// IPC handlers
ipcMain.handle("run-mcp-tool", async (event, toolName, args) => {
  if (!runMCPTool) {
    const mcpModule = await import("./mcp/index.js");
    runMCPTool = mcpModule.runMCPTool;
  }
  return runMCPTool(toolName, args);
});

const connections = [];

ipcMain.handle("list-connections", async () => {
  return connections;
});

ipcMain.handle("add-connection", async (event, args) => {
  const id = Date.now().toString();
  const connection = { id, ...args };
  connections.push(connection);
  return connection;
});

ipcMain.handle("remove-connection", async (event, id) => {
  const index = connections.findIndex(c => c.id === id);
  if (index !== -1) {
    connections.splice(index, 1);
    return true;
  }
  return false;
});

ipcMain.on("open-external", (event, url) => {
  shell.openExternal(url);
});

console.log("[Main] Main process loaded!");
