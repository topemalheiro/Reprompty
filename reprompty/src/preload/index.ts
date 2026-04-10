import { contextBridge, ipcRenderer } from "electron";

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld("electronAPI", {
  spawnWindow: (args: unknown) => ipcRenderer.invoke("spawn-window", args),
  listSpawnTargets: () => ipcRenderer.invoke("spawn-targets-list"),
  listVirtualDesktops: () => ipcRenderer.invoke("virtual-desktops-list"),
  addSpawnTarget: (args: unknown) => ipcRenderer.invoke("spawn-targets-add", args),
  updateSpawnTarget: (id: string, updates: unknown) => ipcRenderer.invoke("spawn-targets-update", id, updates),
  removeSpawnTarget: (id: string) => ipcRenderer.invoke("spawn-targets-remove", id),
  addConnection: (args: unknown) => ipcRenderer.invoke("add-connection", args),
  listConnections: () => ipcRenderer.invoke("list-connections"),
  removeConnection: (args: unknown) => ipcRenderer.invoke("remove-connection", args),
  daisyChain: (args: unknown) => ipcRenderer.invoke("daisy-chain", args),
  sendToDetected: (args: { window: unknown; prompt: string }) => ipcRenderer.invoke("send-to-detected", args),

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
  rescanScriptMcpActions: (id: string) => ipcRenderer.invoke("scripts-rescan-mcp-actions", id),
  setScriptLayoutRole: (id: string, role: string | null) => ipcRenderer.invoke("scripts-set-layout-role", id, role),
  getScriptOutput: (id: string) => ipcRenderer.invoke("scripts-get-output", id),
  pickScriptFile: () => ipcRenderer.invoke("scripts-pick-file"),

  // Layout slots
  listLayoutSlots: () => ipcRenderer.invoke("layouts-list"),
  addLayoutSlot: (slot: unknown) => ipcRenderer.invoke("layouts-add", slot),
  updateLayoutSlot: (id: string, updates: unknown) => ipcRenderer.invoke("layouts-update", id, updates),
  removeLayoutSlot: (id: string) => ipcRenderer.invoke("layouts-remove", id),
  applyLayoutSlot: (id: string) => ipcRenderer.invoke("layouts-apply", id),
  getLayoutScriptPath: () => ipcRenderer.invoke("layouts-get-script-path"),
  setLayoutScriptPath: (path: string) => ipcRenderer.invoke("layouts-set-script-path", path),

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
