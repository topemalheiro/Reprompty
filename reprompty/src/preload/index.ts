import { contextBridge, ipcRenderer } from "electron";

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld("electronAPI", {
  spawnWindow: (args: unknown) => ipcRenderer.invoke("spawn-window", args),
  sendPrompt: (args: unknown) => ipcRenderer.invoke("send-prompt", args),
  addConnection: (args: unknown) => ipcRenderer.invoke("add-connection", args),
  listConnections: () => ipcRenderer.invoke("list-connections"),
  removeConnection: (args: unknown) => ipcRenderer.invoke("remove-connection", args),
  daisyChain: (args: unknown) => ipcRenderer.invoke("daisy-chain", args),

  // Window detection
  detectWindows: () => ipcRenderer.invoke("detect-windows"),
  onWindowsDetected: (callback: (windows: unknown[]) => void) => {
    ipcRenderer.on("windows-detected", (_event, windows) => callback(windows));
  },
  removeWindowListeners: () => {
    ipcRenderer.removeAllListeners("windows-detected");
  },

  // Script management
  listScripts: () => ipcRenderer.invoke("scripts-list"),
  addScript: (args: unknown) => ipcRenderer.invoke("scripts-add", args),
  removeScript: (id: string) => ipcRenderer.invoke("scripts-remove", id),
  runScript: (id: string) => ipcRenderer.invoke("scripts-run", id),
  stopScript: (id: string) => ipcRenderer.invoke("scripts-stop", id),
  updateScript: (id: string, updates: unknown) => ipcRenderer.invoke("scripts-update", id, updates),
  setScriptLayoutRole: (id: string, role: string | null) => ipcRenderer.invoke("scripts-set-layout-role", id, role),
  getScriptOutput: (id: string) => ipcRenderer.invoke("scripts-get-output", id),
  pickScriptFile: () => ipcRenderer.invoke("scripts-pick-file"),

  // Script event listeners (streaming from main process)
  onScriptOutput: (callback: (data: unknown) => void) => {
    ipcRenderer.on("script-output", (_event, data) => callback(data));
  },
  onScriptStatusChanged: (callback: (data: unknown) => void) => {
    ipcRenderer.on("script-status-changed", (_event, data) => callback(data));
  },
  removeScriptListeners: () => {
    ipcRenderer.removeAllListeners("script-output");
    ipcRenderer.removeAllListeners("script-status-changed");
  },
});
