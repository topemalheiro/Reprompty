// Simple test - check globals
console.log("=== TEST ELECTRON GLOBALS ===");
console.log("process.versions.electron:", process.versions.electron);
console.log("process.resourcesPath:", process.resourcesPath);

console.log("\n=== Checking globals ===");
console.log("typeof app:", typeof app);
console.log("typeof BrowserWindow:", typeof BrowserWindow);
console.log("typeof Tray:", typeof Tray);
console.log("typeof Menu:", typeof Menu);
console.log("typeof nativeImage:", typeof nativeImage);
console.log("typeof ipcMain:", typeof ipcMain);
console.log("typeof shell:", typeof shell);

// Try require
console.log("\n=== Checking require('electron') ===");
const electron = require("electron");
console.log("require('electron') type:", typeof electron);
console.log("require('electron') value:", electron);

// If we got here and have app, use it
if (typeof app !== 'undefined' && app) {
  console.log("\n✅ SUCCESS! Electron globals are available!");
  
  // Quick test - create a window
  const win = new BrowserWindow({ width: 400, height: 300, show: false });
  console.log("Created window:", !!win);
  
  win.loadURL('data:text/html,<h1>Hello from Electron!</h1>');
  win.once('ready-to-show', () => {
    win.show();
    console.log("Window shown!");
  });
  
  app.whenReady().then(() => {
    console.log("App ready event fired!");
  });
} else {
  console.log("\n❌ FAIL - No electron globals");
}
