import React, { useState, useEffect } from "react";
import ScriptsTab from "./ScriptsTab";

interface DetectedWindow {
  pid: number;
  handle: number;
  title: string;
  folderPath: string;
  processName: string;
  extension: "kilo-code" | "claude-code" | "unknown";
  pipePath: string | null;
  sendMethod: "background" | "foreground";
}

interface ElectronAPI {
  spawnWindow: (args: unknown) => Promise<unknown>;
  sendPrompt: (args: unknown) => Promise<unknown>;
  sendToDetected: (args: { window: unknown; prompt: string }) => Promise<{ success: boolean; method?: string; error?: string }>;
  addConnection: (args: unknown) => Promise<unknown>;
  listConnections: () => Promise<unknown>;
  removeConnection: (args: unknown) => Promise<unknown>;
  daisyChain: (args: unknown) => Promise<unknown>;
  detectWindows: () => Promise<DetectedWindow[]>;
  onWindowsDetected: (callback: (windows: DetectedWindow[]) => void) => void;
  removeWindowListeners: () => void;
  listScripts: () => Promise<unknown[]>;
  addScript: (args: { name: string; path: string; type: string; args: string[] }) => Promise<unknown>;
  removeScript: (id: string) => Promise<boolean>;
  runScript: (id: string) => Promise<boolean>;
  stopScript: (id: string) => Promise<boolean>;
  updateScript: (id: string, updates: Record<string, unknown>) => Promise<unknown>;
  setScriptLayoutRole: (id: string, role: string | null) => Promise<boolean>;
  getScriptOutput: (id: string) => Promise<string[]>;
  pickScriptFile: () => Promise<string | null>;
  onScriptOutput: (callback: (data: unknown) => void) => void;
  onScriptStatusChanged: (callback: (data: unknown) => void) => void;
  removeScriptListeners: () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

function App() {
  const [activeTab, setActiveTab] = useState<"windows" | "send" | "spawn" | "scripts">("windows");
  const [detectedWindows, setDetectedWindows] = useState<DetectedWindow[]>([]);
  const [selectedWindowHandle, setSelectedWindowHandle] = useState<string>("");
  const [promptText, setPromptText] = useState("");
  const [status, setStatus] = useState("");
  const [folderPath, setFolderPath] = useState("");

  useEffect(() => {
    window.electronAPI.detectWindows().then(setDetectedWindows).catch(() => {});
    window.electronAPI.onWindowsDetected(setDetectedWindows);
    return () => { window.electronAPI.removeWindowListeners(); };
  }, []);

  const sendPrompt = async () => {
    if (!selectedWindowHandle || !promptText) {
      setStatus("Select a window and enter a prompt");
      return;
    }
    const win = detectedWindows.find((w) => String(w.handle) === selectedWindowHandle);
    if (!win) {
      setStatus("Window not found — it may have closed");
      return;
    }
    try {
      setStatus("Sending...");
      const result = await window.electronAPI.sendToDetected({ window: win, prompt: promptText });
      setStatus(result.success ? `Sent via ${result.method}` : `Failed: ${result.error || "all send methods failed"}`);
      if (result.success) setPromptText("");
    } catch (err) {
      setStatus(`Error: ${err}`);
    }
  };

  const spawnWindow = async () => {
    if (!folderPath) { setStatus("Enter a folder path"); return; }
    try {
      await window.electronAPI.spawnWindow({ folderPath });
      setStatus(`Spawned VS Code for ${folderPath}`);
      setFolderPath("");
    } catch (err) {
      setStatus(`Error: ${err}`);
    }
  };

  // Format title: "active-file - ProjectFolder - Visual Studio Code" → "ProjectFolder — active-file"
  const formatTitle = (win: DetectedWindow) => {
    const parts = win.title.replace(/ - Visual Studio Code.*$/, "").replace(/ - Kilo Code.*$/, "").split(" - ");
    if (parts.length >= 2) {
      const file = parts[0].trim();
      const folder = parts.slice(1).join(" - ").trim();
      return `${folder} — ${file}`;
    }
    return win.folderPath || win.title;
  };

  const extBadge = (ext: string) => {
    if (ext === "kilo-code") return { label: "Kilo", bg: "#2ea043" };
    if (ext === "claude-code") return { label: "Claude", bg: "#4a9eff" };
    return { label: "?", bg: "#666" };
  };

  const methBadge = (m: string) =>
    m === "background" ? { label: "BG", bg: "#2ea043" } : { label: "FG", bg: "#d29922" };

  return (
    <div style={s.container}>
      <header style={s.header}>
        <h1 style={s.title}>Reprompty</h1>
        <p style={s.subtitle}>Multi-window AI Agent Orchestration</p>
      </header>

      <nav style={s.nav}>
        {([["windows", "Windows"], ["send", "Send Prompt"], ["spawn", "Spawn"], ["scripts", "Scripts"]] as const).map(([id, label]) => (
          <button key={id} style={activeTab === id ? s.navActive : s.navBtn} onClick={() => setActiveTab(id as typeof activeTab)}>
            {label}
          </button>
        ))}
      </nav>

      <main style={s.content}>
        {/* ============ WINDOWS TAB ============ */}
        {activeTab === "windows" && (
          <div style={s.panel}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={s.panelTitle}>Detected Windows</h2>
              <span style={{ color: "#888", fontSize: 12 }}>{detectedWindows.length} found (auto-refreshes)</span>
            </div>
            {detectedWindows.length === 0 ? (
              <p style={s.empty}>No VS Code / Kilo Code windows detected</p>
            ) : (
              detectedWindows.map((win) => {
                const ext = extBadge(win.extension);
                const meth = methBadge(win.sendMethod);
                return (
                  <div key={win.handle} style={s.card}>
                    <div style={{ flex: 1 }}>
                      <strong style={{ color: "#fff" }}>{formatTitle(win)}</strong>
                      <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center" }}>
                        <span style={{ ...s.badge, background: ext.bg }}>{ext.label}</span>
                        <span style={{ ...s.badge, background: meth.bg }}>{meth.label}</span>
                        <span style={{ color: "#666", fontSize: 11 }}>PID {win.pid}</span>
                        {win.pipePath && <span style={{ color: "#555", fontSize: 10 }}>{win.pipePath}</span>}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ============ SEND PROMPT TAB ============ */}
        {activeTab === "send" && (
          <div style={s.panel}>
            <h2 style={s.panelTitle}>Send Prompt</h2>

            <select style={s.select} value={selectedWindowHandle} onChange={(e) => setSelectedWindowHandle(e.target.value)}>
              <option value="">Select a window...</option>
              {detectedWindows.map((win) => {
                const ext = win.extension === "kilo-code" ? "Kilo" : win.extension === "claude-code" ? "Claude" : "?";
                const meth = win.sendMethod === "background" ? "BG" : "FG";
                return (
                  <option key={win.handle} value={String(win.handle)}>
                    {formatTitle(win)} ({ext}) [{meth}]
                  </option>
                );
              })}
            </select>

            <textarea
              style={s.textarea}
              placeholder="Enter your prompt..."
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              rows={6}
            />

            <button style={s.btn} onClick={sendPrompt}>Send Prompt</button>
          </div>
        )}

        {/* ============ SPAWN TAB ============ */}
        {activeTab === "spawn" && (
          <div style={s.panel}>
            <h2 style={s.panelTitle}>Spawn VS Code Window</h2>
            <input
              style={s.input}
              placeholder="Folder Path (e.g., C:\Users\topem\my-project)"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
            />
            <button style={{ ...s.btn, marginTop: 12 }} onClick={spawnWindow}>Spawn Window</button>
          </div>
        )}

        {/* ============ SCRIPTS TAB ============ */}
        {activeTab === "scripts" && <ScriptsTab setStatus={setStatus} />}

        {status && <div style={s.status}>{status}</div>}
      </main>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: { minHeight: "100vh", background: "#1e1e1e", color: "#fff" },
  header: { padding: "20px", background: "#2d2d2d", borderBottom: "1px solid #3d3d3d" },
  title: { margin: 0, fontSize: "24px", fontWeight: 600 },
  subtitle: { margin: "5px 0 0 0", fontSize: "14px", color: "#888" },
  nav: { display: "flex", padding: "10px 20px", background: "#252525", borderBottom: "1px solid #3d3d3d", gap: "10px" },
  navBtn: { padding: "10px 20px", background: "transparent", border: "none", color: "#888", cursor: "pointer", fontSize: "14px", borderRadius: "4px" },
  navActive: { padding: "10px 20px", background: "#4a9eff", border: "none", color: "#fff", cursor: "pointer", fontSize: "14px", borderRadius: "4px" },
  content: { padding: "20px" },
  panel: { background: "#2d2d2d", borderRadius: "8px", padding: "20px" },
  panelTitle: { margin: 0, fontSize: "18px" },
  card: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px", background: "#1e1e1e", borderRadius: "6px", marginBottom: "8px" },
  badge: { padding: "2px 8px", borderRadius: "3px", fontSize: "11px", color: "#fff", fontWeight: 600 },
  input: { width: "100%", padding: "10px", background: "#1e1e1e", border: "1px solid #3d3d3d", borderRadius: "4px", color: "#fff", fontSize: "14px" },
  select: { width: "100%", padding: "10px", background: "#1e1e1e", border: "1px solid #3d3d3d", borderRadius: "4px", color: "#fff", fontSize: "14px", marginBottom: "15px" },
  textarea: { width: "100%", padding: "10px", background: "#1e1e1e", border: "1px solid #3d3d3d", borderRadius: "4px", color: "#fff", fontSize: "14px", marginBottom: "15px", resize: "vertical" },
  btn: { padding: "8px 16px", background: "#4a9eff", border: "none", borderRadius: "4px", color: "#fff", cursor: "pointer", fontSize: "13px" },
  empty: { color: "#888", textAlign: "center", padding: "20px" },
  status: { marginTop: "20px", padding: "10px", background: "#252525", borderRadius: "4px", color: "#4a9eff", fontSize: "14px" },
};

export default App;
