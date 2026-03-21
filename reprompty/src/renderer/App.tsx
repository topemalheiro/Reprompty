import React, { useState, useEffect } from "react";
import ScriptsTab from "./ScriptsTab";

// Type definitions for the electron API
interface ElectronAPI {
  spawnWindow: (args: unknown) => Promise<string>;
  sendPrompt: (args: unknown) => Promise<string>;
  addConnection: (args: unknown) => Promise<string>;
  listConnections: () => Promise<string>;
  removeConnection: (args: unknown) => Promise<string>;
  daisyChain: (args: unknown) => Promise<string>;
  // Script management
  listScripts: () => Promise<any[]>;
  addScript: (args: { name: string; path: string; type: string; args: string[] }) => Promise<any>;
  removeScript: (id: string) => Promise<boolean>;
  runScript: (id: string) => Promise<boolean>;
  stopScript: (id: string) => Promise<boolean>;
  updateScript: (id: string, updates: Record<string, unknown>) => Promise<any>;
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
}

function App() {
  const [activeTab, setActiveTab] = useState<"connections" | "send" | "spawn" | "scripts">("connections");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [newConnectionName, setNewConnectionName] = useState("");
  const [newConnectionSocket, setNewConnectionSocket] = useState("");
  const [promptText, setPromptText] = useState("");
  const [selectedConnection, setSelectedConnection] = useState("");
  const [status, setStatus] = useState("");
  const [folderPath, setFolderPath] = useState("");

  useEffect(() => {
    loadConnections();
  }, []);

  const loadConnections = async () => {
    try {
      const result = await window.electronAPI.listConnections();
      try {
        const parsed = JSON.parse(result);
        setConnections(parsed);
      } catch {
        setConnections([]);
      }
    } catch (error) {
      console.error("Failed to load connections:", error);
    }
  };

  const addConnection = async () => {
    if (!newConnectionName || !newConnectionSocket) {
      setStatus("Please fill in all fields");
      return;
    }
    try {
      const result = await window.electronAPI.addConnection({
        type: "vscode-window",
        name: newConnectionName,
        config: {
          socketPath: newConnectionSocket,
          method: "background",
        },
      });
      setStatus(result);
      setNewConnectionName("");
      setNewConnectionSocket("");
      loadConnections();
    } catch (error) {
      setStatus(`Error: ${error}`);
    }
  };

  const removeConnection = async (id: string) => {
    try {
      const result = await window.electronAPI.removeConnection({ connectionId: id });
      setStatus(result);
      loadConnections();
    } catch (error) {
      setStatus(`Error: ${error}`);
    }
  };

  const sendPrompt = async () => {
    if (!selectedConnection || !promptText) {
      setStatus("Please select a connection and enter a prompt");
      return;
    }
    try {
      const result = await window.electronAPI.sendPrompt({
        connectionId: selectedConnection,
        prompt: promptText,
      });
      setStatus(result);
      setPromptText("");
    } catch (error) {
      setStatus(`Error: ${error}`);
    }
  };

  const spawnWindow = async () => {
    if (!folderPath) {
      setStatus("Please enter a folder path");
      return;
    }
    try {
      const result = await window.electronAPI.spawnWindow({
        folderPath: folderPath,
      });
      setStatus(result);
      setFolderPath("");
    } catch (error) {
      setStatus(`Error: ${error}`);
    }
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <header style={styles.header}>
        <h1 style={styles.title}>Reprompty</h1>
        <p style={styles.subtitle}>Multi-window AI Agent Orchestration</p>
      </header>

      {/* Navigation */}
      <nav style={styles.nav}>
        <button
          style={activeTab === "connections" ? styles.navButtonActive : styles.navButton}
          onClick={() => setActiveTab("connections")}
        >
          Connections
        </button>
        <button
          style={activeTab === "send" ? styles.navButtonActive : styles.navButton}
          onClick={() => setActiveTab("send")}
        >
          Send Prompt
        </button>
        <button
          style={activeTab === "spawn" ? styles.navButtonActive : styles.navButton}
          onClick={() => setActiveTab("spawn")}
        >
          Spawn Window
        </button>
        <button
          style={activeTab === "scripts" ? styles.navButtonActive : styles.navButton}
          onClick={() => setActiveTab("scripts")}
        >
          Scripts
        </button>
      </nav>

      {/* Content */}
      <main style={styles.content}>
        {activeTab === "connections" && (
          <div style={styles.panel}>
            <h2 style={styles.panelTitle}>Manage Connections</h2>
            
            {/* Add Connection Form */}
            <div style={styles.form}>
              <input
                style={styles.input}
                placeholder="Connection Name"
                value={newConnectionName}
                onChange={(e) => setNewConnectionName(e.target.value)}
              />
              <input
                style={styles.input}
                placeholder="Socket Path (e.g., \\.\pipe\kilo-ipc-12345)"
                value={newConnectionSocket}
                onChange={(e) => setNewConnectionSocket(e.target.value)}
              />
              <button style={styles.button} onClick={addConnection}>
                Add Connection
              </button>
            </div>

            {/* Connection List */}
            <div style={styles.connectionList}>
              {connections.length === 0 ? (
                <p style={styles.emptyText}>No connections yet</p>
              ) : (
                connections.map((conn) => (
                  <div key={conn.id} style={styles.connectionItem}>
                    <div>
                      <strong>{conn.name}</strong>
                      <span style={styles.connectionType}> ({conn.type})</span>
                      <span style={styles.connectionStatus}> - {conn.status}</span>
                    </div>
                    <button
                      style={styles.deleteButton}
                      onClick={() => removeConnection(conn.id)}
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

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
                  {conn.name}
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

        {activeTab === "spawn" && (
          <div style={styles.panel}>
            <h2 style={styles.panelTitle}>Spawn VS Code Window</h2>
            
            <input
              style={styles.input}
              placeholder="Folder Path (e.g., C:\Users\topem\my-project)"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
            />

            <button style={styles.button} onClick={spawnWindow}>
              Spawn Window
            </button>
          </div>
        )}

        {activeTab === "scripts" && (
          <ScriptsTab setStatus={setStatus} />
        )}

        {/* Status */}
        {status && (
          <div style={styles.status}>
            {status}
          </div>
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
    margin: "0 0 20px 0",
    fontSize: "18px",
  },
  form: {
    display: "flex",
    gap: "10px",
    marginBottom: "20px",
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
    padding: "10px 20px",
    background: "#4a9eff",
    border: "none",
    borderRadius: "4px",
    color: "#fff",
    cursor: "pointer",
    fontSize: "14px",
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
  connectionList: {
    marginTop: "20px",
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
  connectionType: {
    color: "#888",
    fontSize: "12px",
  },
  connectionStatus: {
    color: "#4a9eff",
    fontSize: "12px",
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
