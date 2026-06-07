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

  // Portainer proxy (bypasses renderer self-signed cert restrictions)
  portainerFetch: (method: string, url: string, body?: string) =>
    ipcRenderer.invoke("portainer-fetch", method, url, body),

  // Llama.cpp preset management + server control
  llamaListPresets: () => ipcRenderer.invoke("llama-list-presets"),
  llamaLoadPreset: (name: string) => ipcRenderer.invoke("llama-load-preset", name),
  llamaSavePreset: (name: string, data: unknown) => ipcRenderer.invoke("llama-save-preset", name, data),
  llamaDeletePreset: (name: string) => ipcRenderer.invoke("llama-delete-preset", name),
  llamaStart: (presetName: string) => ipcRenderer.invoke("llama-start", presetName),
  llamaStop: () => ipcRenderer.invoke("llama-stop"),
  llamaStopPreset: (presetName: string) => ipcRenderer.invoke("llama-stop-preset", presetName),
  llamaStatus: () => ipcRenderer.invoke("llama-status"),
  llamaGetBinaryPath: () => ipcRenderer.invoke("llama-get-binary-path"),
  llamaSetBinaryPath: (path: string) => ipcRenderer.invoke("llama-set-binary-path", path),
  llamaGetAutostart: () => ipcRenderer.invoke("llama-get-autostart"),
  llamaSetAutostart: (presetName: string, enabled: boolean) => ipcRenderer.invoke("llama-set-autostart", presetName, enabled),

  // Graphiti MCP control
  graphitiStart: () => ipcRenderer.invoke("graphiti-start"),
  graphitiStop: () => ipcRenderer.invoke("graphiti-stop"),
  graphitiStatus: () => ipcRenderer.invoke("graphiti-status"),

  // Generic MCP tool runner (for save/load task presets, etc.)
  runMcpTool: (toolName: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("run-mcp-tool", toolName, args || {}),
});
