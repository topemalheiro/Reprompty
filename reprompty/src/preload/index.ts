import { contextBridge, ipcRenderer } from "electron";

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld("electronAPI", {
  spawnWindow: (args: unknown) => ipcRenderer.invoke("spawn-window", args),
  sendPrompt: (args: unknown) => ipcRenderer.invoke("send-prompt", args),
  addConnection: (args: unknown) => ipcRenderer.invoke("add-connection", args),
  listConnections: () => ipcRenderer.invoke("list-connections"),
  removeConnection: (args: unknown) => ipcRenderer.invoke("remove-connection", args),
  daisyChain: (args: unknown) => ipcRenderer.invoke("daisy-chain", args),
});
