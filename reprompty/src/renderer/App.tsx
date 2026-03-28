import React, { useState, useEffect } from "react";
import ScriptsTab from "./ScriptsTab";

// Type definitions
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
  spawnWindow: (args: unknown) => Promise<string>;
  sendPrompt: (args: unknown) => Promise<{ success: boolean; method?: string; error?: string }>;
  addConnection: (args: unknown) => Promise<unknown>;
  listConnections: () => Promise<unknown>;
  removeConnection: (args: unknown) => Promise<unknown>;
  daisyChain: (args: unknown) => Promise<string>;
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

interface Connection {
  id: string;
  name: string;
  type: string;
  status: string;
  config?: {
    socketPath?: string;
    method?: string;
    extension?: string;
    windowHandle?: number;
  };
}

function App() {
  const [activeTab, setActiveTab] = useState<"connections" | "send" | "spawn" | "scripts">("connections");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [detectedWindows, setDetectedWindows] = useState<DetectedWindow[]>([]);
  const [promptText, setPromptText] = useState("");
  const [selectedConnection, setSelectedConnection] = useState("");
  const [status, setStatus] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualSocket, setManualSocket] = useState("");

  useEffect(() => {
    loadConnections();
    // Initial window detection
    window.electronAPI.detectWindows().then(setDetectedWindows).catch(() => {});
    // Listen for polling updates
    window.electronAPI.onWindowsDetected((windows) => {
      setDetectedWindows(windows);
    });
    return () => {
      window.electronAPI.removeWindowListeners();
    };
  }, []);

  const loadConnections = async () => {
    try {
      const result = await window.electronAPI.listConnections();
      const list = typeof result === "string" ? JSON.parse(result) : result;
      setConnections(Array.isArray(list) ? list : []);
    } catch {
      setConnections([]);
    }
  };

  const connectToWindow = async (win: DetectedWindow) => {
    const name = win.folderPath || `Window-${win.pid}`;
    const config: Record<string, unknown> = {
      method: win.sendMethod,
      extension: win.extension,
      windowHandle: win.handle,
    };
    if (win.pipePath) {
      config.socketPath = win.pipePath;
    }
    try {
      await window.electronAPI.addConnection({
        type: "vscode-window",
        name,
        config,
      });
      setStatus(`Connected to ${name}`);
      loadConnections();
    } catch (err) {
      setStatus(`Error: ${err}`);
    }
  };

  const addManualConnection = async () => {
    if (!manualName || !manualSocket) {
      setStatus("Fill in name and socket path");
      return;
    }
    try {
      await window.electronAPI.addConnection({
        type: "vscode-window",
        name: manualName,
        config: { socketPath: manualSocket, method: "background" },
      });
      setStatus(`Added ${manualName}`);
      setManualName("");
      setManualSocket("");
      setShowManualAdd(false);
      loadConnections();
    } catch (err) {
      setStatus(`Error: ${err}`);
    }
  };

  const removeConnection = async (id: string) => {
    try {
      await window.electronAPI.removeConnection({ connectionId: id });
      setStatus("Connection removed");
      loadConnections();
    } catch (err) {
      setStatus(`Error: ${err}`);
    }
  };

  const sendPrompt = async () => {
    if (!selectedConnection || !promptText) {
      setStatus("Select a connection and enter a prompt");
      return;
    }
    try {
      const result = await window.electronAPI.sendPrompt({
        connectionId: selectedConnection,
        prompt: promptText,
      });
      if (result && typeof result === "object" && "success" in result) {
        setStatus(result.success ? `Sent via ${result.method}` : `Failed: ${result.error}`);
      } else {
        setStatus(String(result));
      }
      setPromptText("");
    } catch (err) {
      setStatus(`Error: ${err}`);
    }
  };

  const spawnWindow = async () => {
    if (!folderPath) {
      setStatus("Enter a folder path");
      return;
    }
    try {
      const result = await window.electronAPI.spawnWindow({ folderPath });
      setStatus(typeof result === "string" ? result : JSON.stringify(result));
      setFolderPath("");
    } catch (err) {
      setStatus(`Error: ${err}`);
    }
  };

  // Check if a detected window is already connected
  const isConnected = (win: DetectedWindow) => {
    return connections.some((c) => {
      const cfg = c.config || {};
      return cfg.socketPath === win.pipePath || cfg.windowHandle === win.handle;
    });
  };

  const extensionBadge = (ext: string) => {
    if (ext === "kilo-code") return { label: "Kilo", bg: "#2ea043" };
    if (ext === "claude-code") return { label: "Claude", bg: "#4a9eff" };
    return { label: "Unknown", bg: "#666" };
  };

  const methodBadge = (method: string) => {
    if (method === "background") return { label: "BG", bg: "#2ea043" };
    return { label: "FG", bg: "#d29922" };
  };

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>Reprompty</h1>
        <p style={styles.subtitle}>Multi-window AI Agent Orchestration</p>
      </header>

      <nav style={styles.nav}>
        {(["connections", "send", "spawn", "scripts"] as const).map((tab) => (
          <button
            key={tab}
            style={activeTab === tab ? styles.navButtonActive : styles.navButton}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "connections" ? "Connections" : tab === "send" ? "Send Prompt" : tab === "spawn" ? "Spawn Window" : "Scripts"}
          </button>
        ))}
      </nav>

      <main style={styles.content}>
        {/* ============ CONNECTIONS TAB ============ */}
        {activeTab === "connections" && (
          <div>
            {/* Detected Windows Section */}
            <div style={styles.panel}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h2 style={styles.panelTitle}>Detected Windows</h2>
                <span style={{ color: "#888", fontSize: 12 }}>
                  {detectedWindows.length} found (auto-refreshes)
                </span>
              </div>

              {detectedWindows.length === 0 ? (
                <p style={styles.emptyText}>No VS Code / Kilo Code windows detected</p>
              ) : (
                detectedWindows.map((win) => {
                  const ext = extensionBadge(win.extension);
                  const meth = methodBadge(win.sendMethod);
                  const connected = isConnected(win);
                  return (
                    <div key={win.pid} style={styles.detectedCard}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          {connected && <span style={styles.greenDot} />}
                          <strong style={{ color: "#fff" }}>{win.folderPath || win.title}</strong>
                        </div>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <span style={{ ...styles.badge, background: ext.bg }}>{ext.label}</span>
                          <span style={{ ...styles.badge, background: meth.bg }}>{meth.label}</span>
                          <span style={{ color: "#666", fontSize: 11 }}>PID {win.pid}</span>
                        </div>
                      </div>
                      {connected ? (
                        <span style={{ color: "#2ea043", fontSize: 13 }}>Connected</span>
                      ) : (
                        <button style={styles.button} onClick={() => connectToWindow(win)}>
                          Connect
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Connected Windows Section */}
            <div style={{ ...styles.panel, marginTop: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h2 style={styles.panelTitle}>Connected</h2>
                <button
                  style={{ ...styles.smallButton, background: showManualAdd ? "#666" : "#4a9eff" }}
                  onClick={() => setShowManualAdd(!showManualAdd)}
                >
                  {showManualAdd ? "Cancel" : "+ Manual"}
                </button>
              </div>

              {showManualAdd && (
                <div style={styles.form}>
                  <input
                    style={styles.input}
                    placeholder="Connection Name"
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                  />
                  <input
                    style={styles.input}
                    placeholder="Socket Path (\\.\pipe\kilo-ipc-12345)"
                    value={manualSocket}
                    onChange={(e) => setManualSocket(e.target.value)}
                  />
                  <button style={styles.button} onClick={addManualConnection}>Add</button>
                </div>
              )}

              {connections.length === 0 ? (
                <p style={styles.emptyText}>No connections yet — connect to a detected window above</p>
              ) : (
                connections.map((conn) => (
                  <div key={conn.id} style={styles.connectionItem}>
                    <div style={{ flex: 1 }}>
                      <strong>{conn.name}</strong>
                      <span style={{ color: "#888", fontSize: 12, marginLeft: 8 }}>
                        {conn.config?.extension || conn.type}
                      </span>
                      <span style={{ color: conn.status === "active" ? "#2ea043" : conn.status === "error" ? "#ff4a4a" : "#888", fontSize: 12, marginLeft: 8 }}>
                        {conn.status}
                      </span>
                    </div>
                    <button style={styles.deleteButton} onClick={() => removeConnection(conn.id)}>
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* ============ SEND PROMPT TAB ============ */}
        {activeTab === "send" && (
          <div style={styles.panel}>
            <h2 style={styles.panelTitle}>Send Prompt</h2>

            <select
              style={styles.select}
              value={selectedConnection}
              onChange={(e) => setSelectedConnection(e.target.value)}
            >
              <option value="">Select a connection...</option>
              {connections.map((conn) => (
                <option key={conn.id} value={conn.id}>
                  {conn.name} ({conn.config?.extension || conn.type})
                </option>
              ))}
            </select>

            <textarea
              style={styles.textarea}
              placeholder="Enter your prompt..."
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              rows={6}
            />

            <button style={styles.button} onClick={sendPrompt}>
              Send Prompt
            </button>
          </div>
        )}

        {/* ============ SPAWN WINDOW TAB ============ */}
        {activeTab === "spawn" && (
          <div style={styles.panel}>
            <h2 style={styles.panelTitle}>Spawn VS Code Window</h2>

            <input
              style={styles.input}
              placeholder="Folder Path (e.g., C:\Users\topem\my-project)"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
            />

            <button style={{ ...styles.button, marginTop: 12 }} onClick={spawnWindow}>
              Spawn Window
            </button>
          </div>
        )}

        {/* ============ SCRIPTS TAB ============ */}
        {activeTab === "scripts" && (
          <ScriptsTab setStatus={setStatus} />
        )}

        {/* Status bar */}
        {status && (
          <div style={styles.status}>{status}</div>
        )}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    background: "#1e1e1e",
    color: "#fff",
  },
  header: {
    padding: "20px",
    background: "#2d2d2d",
    borderBottom: "1px solid #3d3d3d",
  },
  title: {
    margin: 0,
    fontSize: "24px",
    fontWeight: 600,
  },
  subtitle: {
    margin: "5px 0 0 0",
    fontSize: "14px",
    color: "#888",
  },
  nav: {
    display: "flex",
    padding: "10px 20px",
    background: "#252525",
    borderBottom: "1px solid #3d3d3d",
    gap: "10px",
  },
  navButton: {
    padding: "10px 20px",
    background: "transparent",
    border: "none",
    color: "#888",
    cursor: "pointer",
    fontSize: "14px",
    borderRadius: "4px",
  },
  navButtonActive: {
    padding: "10px 20px",
    background: "#4a9eff",
    border: "none",
    color: "#fff",
    cursor: "pointer",
    fontSize: "14px",
    borderRadius: "4px",
  },
  content: {
    padding: "20px",
  },
  panel: {
    background: "#2d2d2d",
    borderRadius: "8px",
    padding: "20px",
  },
  panelTitle: {
    margin: 0,
    fontSize: "18px",
  },
  form: {
    display: "flex",
    gap: "10px",
    marginBottom: "16px",
    flexWrap: "wrap",
  },
  input: {
    flex: 1,
    minWidth: "200px",
    padding: "10px",
    background: "#1e1e1e",
    border: "1px solid #3d3d3d",
    borderRadius: "4px",
    color: "#fff",
    fontSize: "14px",
  },
  select: {
    width: "100%",
    padding: "10px",
    background: "#1e1e1e",
    border: "1px solid #3d3d3d",
    borderRadius: "4px",
    color: "#fff",
    fontSize: "14px",
    marginBottom: "15px",
  },
  textarea: {
    width: "100%",
    padding: "10px",
    background: "#1e1e1e",
    border: "1px solid #3d3d3d",
    borderRadius: "4px",
    color: "#fff",
    fontSize: "14px",
    marginBottom: "15px",
    resize: "vertical",
  },
  button: {
    padding: "8px 16px",
    background: "#4a9eff",
    border: "none",
    borderRadius: "4px",
    color: "#fff",
    cursor: "pointer",
    fontSize: "13px",
  },
  smallButton: {
    padding: "5px 12px",
    background: "#4a9eff",
    border: "none",
    borderRadius: "4px",
    color: "#fff",
    cursor: "pointer",
    fontSize: "12px",
  },
  deleteButton: {
    padding: "5px 10px",
    background: "#ff4a4a",
    border: "none",
    borderRadius: "4px",
    color: "#fff",
    cursor: "pointer",
    fontSize: "12px",
  },
  detectedCard: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px",
    background: "#1e1e1e",
    borderRadius: "6px",
    marginBottom: "8px",
  },
  connectionItem: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px",
    background: "#1e1e1e",
    borderRadius: "4px",
    marginBottom: "8px",
  },
  badge: {
    padding: "2px 8px",
    borderRadius: "3px",
    fontSize: "11px",
    color: "#fff",
    fontWeight: 600,
  },
  greenDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "#2ea043",
    display: "inline-block",
  },
  emptyText: {
    color: "#888",
    textAlign: "center",
    padding: "20px",
  },
  status: {
    marginTop: "20px",
    padding: "10px",
    background: "#252525",
    borderRadius: "4px",
    color: "#4a9eff",
    fontSize: "14px",
  },
};

export default App;
