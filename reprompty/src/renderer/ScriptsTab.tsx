import React, { useState, useEffect, useRef } from "react";

interface ScriptInfo {
  id: string;
  name: string;
  path: string;
  type: string;
  args: string[];
  autoStart: boolean;
  layoutRole: string | null;
  status: string;
  pid: number | null;
  exitCode: number | null;
}

interface ScriptOutputEvent {
  scriptId: string;
  stream: string;
  line: string;
  timestamp: string;
}

interface ScriptStatusEvent {
  scriptId: string;
  status: string;
  pid: number | null;
}

interface ScriptsTabProps {
  setStatus: (status: string) => void;
}

const SCRIPT_TYPES = [
  { value: "powershell", label: "PowerShell (.ps1)" },
  { value: "batch", label: "Batch (.bat/.cmd)" },
  { value: "vbs", label: "VBScript (.vbs)" },
  { value: "executable", label: "Executable (.exe)" },
];

function detectTypeFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "ps1": return "powershell";
    case "bat":
    case "cmd": return "batch";
    case "vbs": return "vbs";
    case "exe": return "executable";
    default: return "powershell";
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "running": return "#4aff4a";
    case "starting": return "#ffaa4a";
    case "error": return "#ff4a4a";
    default: return "#666";
  }
}

function typeBadgeColor(type: string): string {
  switch (type) {
    case "powershell": return "#5391d9";
    case "batch": return "#c0c0c0";
    case "vbs": return "#d9a353";
    case "executable": return "#53d97a";
    default: return "#888";
  }
}

export default function ScriptsTab({ setStatus }: ScriptsTabProps) {
  const [scripts, setScripts] = useState<ScriptInfo[]>([]);
  const [addingScript, setAddingScript] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newType, setNewType] = useState("powershell");
  const [newArgs, setNewArgs] = useState("");
  const [outputMap, setOutputMap] = useState<Record<string, string[]>>({});
  const outputRefs = useRef<Record<string, HTMLPreElement | null>>({});

  useEffect(() => {
    loadScripts();

    window.electronAPI.onScriptOutput((data: unknown) => {
      const event = data as ScriptOutputEvent;
      setOutputMap((prev) => {
        const lines = prev[event.scriptId] || [];
        const ts = event.timestamp.split("T")[1]?.slice(0, 8) || "";
        const prefix = event.stream === "stderr" ? "[ERR] " : "";
        const next = [...lines, `[${ts}] ${prefix}${event.line}`];
        if (next.length > 500) next.splice(0, next.length - 500);
        return { ...prev, [event.scriptId]: next };
      });
    });

    window.electronAPI.onScriptStatusChanged((data: unknown) => {
      const event = data as ScriptStatusEvent;
      setScripts((prev) =>
        prev.map((s) =>
          s.id === event.scriptId
            ? { ...s, status: event.status, pid: event.pid }
            : s
        )
      );
    });

    return () => {
      window.electronAPI.removeScriptListeners();
    };
  }, []);

  // Auto-scroll terminals
  useEffect(() => {
    for (const [id, el] of Object.entries(outputRefs.current)) {
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [outputMap]);

  const loadScripts = async () => {
    try {
      const result = await window.electronAPI.listScripts();
      setScripts(result);
      // Pre-load output for all scripts
      for (const s of result) {
        try {
          const lines = await window.electronAPI.getScriptOutput(s.id);
          if (lines && lines.length > 0) {
            setOutputMap((prev) => ({ ...prev, [s.id]: lines }));
          }
        } catch { /* ignore */ }
      }
    } catch (err) {
      setStatus(`Failed to load scripts: ${err}`);
    }
  };

  const handleBrowse = async () => {
    try {
      const filePath = await window.electronAPI.pickScriptFile();
      if (filePath) {
        setNewPath(filePath);
        setNewType(detectTypeFromPath(filePath));
        if (!newName) {
          const name = filePath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") || "";
          setNewName(name);
        }
      }
    } catch (err) {
      setStatus(`Browse failed: ${err}`);
    }
  };

  const handleAdd = async () => {
    if (!newName || !newPath) {
      setStatus("Please provide a name and script path");
      return;
    }
    try {
      await window.electronAPI.addScript({
        name: newName,
        path: newPath,
        type: newType,
        args: newArgs ? newArgs.split(" ").filter(Boolean) : [],
      });
      setNewName("");
      setNewPath("");
      setNewType("powershell");
      setNewArgs("");
      setAddingScript(false);
      setStatus(`Script "${newName}" added`);
      loadScripts();
    } catch (err) {
      setStatus(`Failed to add script: ${err}`);
    }
  };

  const handleRun = async (id: string, name: string) => {
    try {
      await window.electronAPI.runScript(id);
      setStatus(`Started: ${name}`);
    } catch (err) {
      setStatus(`Failed to start ${name}: ${err}`);
    }
  };

  const handleStop = async (id: string, name: string) => {
    try {
      await window.electronAPI.stopScript(id);
      setStatus(`Stopping: ${name}`);
    } catch (err) {
      setStatus(`Failed to stop ${name}: ${err}`);
    }
  };

  const handleRemove = async (id: string, name: string) => {
    try {
      await window.electronAPI.removeScript(id);
      setStatus(`Removed: ${name}`);
      loadScripts();
    } catch (err) {
      setStatus(`Failed to remove ${name}: ${err}`);
    }
  };

  const handleAutoStartToggle = async (id: string, current: boolean) => {
    try {
      await window.electronAPI.updateScript(id, { autoStart: !current });
      setScripts((prev) =>
        prev.map((s) => (s.id === id ? { ...s, autoStart: !current } : s))
      );
    } catch (err) {
      setStatus(`Failed to update auto-start: ${err}`);
    }
  };

  const clearOutput = (id: string) => {
    setOutputMap((prev) => ({ ...prev, [id]: [] }));
  };

  return (
    <div style={styles.panel}>
      <div style={styles.panelHeader}>
        <h2 style={styles.panelTitle}>Scripts</h2>
        <button
          style={styles.addButton}
          onClick={() => setAddingScript(!addingScript)}
        >
          {addingScript ? "Cancel" : "+ Add Script"}
        </button>
      </div>

      {/* Add Script Form */}
      {addingScript && (
        <div style={styles.addForm}>
          <div style={styles.formRow}>
            <input
              style={styles.input}
              placeholder="Script Name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <select
              style={styles.typeSelect}
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
            >
              {SCRIPT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div style={styles.formRow}>
            <input
              style={{ ...styles.input, flex: 1 }}
              placeholder="Script Path"
              value={newPath}
              onChange={(e) => {
                setNewPath(e.target.value);
                setNewType(detectTypeFromPath(e.target.value));
              }}
            />
            <button style={styles.browseButton} onClick={handleBrowse}>
              Browse
            </button>
          </div>
          <div style={styles.formRow}>
            <input
              style={styles.input}
              placeholder="Arguments (optional, space-separated)"
              value={newArgs}
              onChange={(e) => setNewArgs(e.target.value)}
            />
            <button style={styles.saveButton} onClick={handleAdd}>
              Save
            </button>
          </div>
        </div>
      )}

      {/* Script List */}
      <div style={styles.scriptList}>
        {scripts.length === 0 ? (
          <p style={styles.emptyText}>No scripts registered yet</p>
        ) : (
          scripts.map((script) => (
            <div key={script.id} style={styles.scriptCard}>
              {/* Terminal window */}
              <div style={styles.terminal}>
                {/* Terminal title bar */}
                <div style={{
                  ...styles.termTitleBar,
                  borderBottom: `1px solid ${script.status === "running" ? "#333" : "#2a2a2a"}`,
                }}>
                  <div style={styles.termTitleLeft}>
                    <span style={{ ...styles.termDot, background: statusColor(script.status) }} />
                    <span style={styles.termTitle}>
                      {script.name}
                    </span>
                    <span style={{ ...styles.typeBadge, background: typeBadgeColor(script.type) }}>
                      {script.type}
                    </span>
                    {script.pid && (
                      <span style={styles.termPid}>PID {script.pid}</span>
                    )}
                  </div>
                  <div style={styles.termTitleRight}>
                    <label style={styles.autoStartLabel}>
                      <input
                        type="checkbox"
                        checked={script.autoStart}
                        onChange={() => handleAutoStartToggle(script.id, script.autoStart)}
                        style={{ marginRight: "4px" }}
                      />
                      Auto
                    </label>
                    <button
                      style={script.status === "running" ? styles.termBtnDisabled : styles.termBtnRun}
                      onClick={() => handleRun(script.id, script.name)}
                      disabled={script.status === "running"}
                      title="Run script"
                    >
                      Run
                    </button>
                    <button
                      style={script.status !== "running" ? styles.termBtnDisabled : styles.termBtnStop}
                      onClick={() => handleStop(script.id, script.name)}
                      disabled={script.status !== "running"}
                      title="Stop script"
                    >
                      Stop
                    </button>
                    <button
                      style={styles.termBtnClear}
                      onClick={() => clearOutput(script.id)}
                      title="Clear output"
                    >
                      Clear
                    </button>
                    <button
                      style={styles.termBtnRemove}
                      onClick={() => handleRemove(script.id, script.name)}
                      title="Remove script"
                    >
                      X
                    </button>
                  </div>
                </div>

                {/* Terminal path line */}
                <div style={styles.termPathLine}>
                  {script.path}
                </div>

                {/* Terminal output body */}
                <pre
                  ref={(el) => { outputRefs.current[script.id] = el; }}
                  style={styles.termBody}
                >
                  {(outputMap[script.id] || []).length === 0
                    ? script.status === "running"
                      ? "Running...\n"
                      : script.status === "error"
                        ? "Script exited with error\n"
                        : "Ready\n"
                    : (outputMap[script.id] || []).join("\n")}
                </pre>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    background: "#2d2d2d",
    borderRadius: "8px",
    padding: "20px",
  },
  panelHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "20px",
  },
  panelTitle: {
    margin: 0,
    fontSize: "18px",
  },
  addButton: {
    padding: "8px 16px",
    background: "#4a9eff",
    border: "none",
    borderRadius: "4px",
    color: "#fff",
    cursor: "pointer",
    fontSize: "13px",
  },
  addForm: {
    background: "#1e1e1e",
    borderRadius: "6px",
    padding: "16px",
    marginBottom: "20px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  formRow: {
    display: "flex",
    gap: "10px",
    alignItems: "center",
  },
  input: {
    flex: 1,
    minWidth: "150px",
    padding: "10px",
    background: "#161616",
    border: "1px solid #3d3d3d",
    borderRadius: "4px",
    color: "#fff",
    fontSize: "14px",
  },
  typeSelect: {
    padding: "10px",
    background: "#161616",
    border: "1px solid #3d3d3d",
    borderRadius: "4px",
    color: "#fff",
    fontSize: "14px",
    minWidth: "160px",
  },
  browseButton: {
    padding: "10px 16px",
    background: "#3d3d3d",
    border: "1px solid #555",
    borderRadius: "4px",
    color: "#fff",
    cursor: "pointer",
    fontSize: "13px",
    whiteSpace: "nowrap",
  },
  saveButton: {
    padding: "10px 20px",
    background: "#4a9eff",
    border: "none",
    borderRadius: "4px",
    color: "#fff",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  scriptList: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },
  emptyText: {
    color: "#888",
    textAlign: "center",
    padding: "20px",
  },
  scriptCard: {
    // No extra card styling - the terminal IS the card
  },

  // Terminal window styles
  terminal: {
    background: "#0c0c0c",
    borderRadius: "8px",
    overflow: "hidden",
    border: "1px solid #333",
  },
  termTitleBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "6px 12px",
    background: "#1a1a1a",
    minHeight: "32px",
    gap: "8px",
  },
  termTitleLeft: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    overflow: "hidden",
  },
  termDot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    flexShrink: 0,
  },
  termTitle: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#ddd",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  typeBadge: {
    padding: "1px 7px",
    borderRadius: "8px",
    fontSize: "10px",
    color: "#fff",
    fontWeight: 500,
    flexShrink: 0,
  },
  termPid: {
    fontSize: "10px",
    color: "#666",
    flexShrink: 0,
  },
  termTitleRight: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    flexShrink: 0,
  },
  autoStartLabel: {
    display: "flex",
    alignItems: "center",
    fontSize: "11px",
    color: "#888",
    cursor: "pointer",
    marginRight: "4px",
  },
  termBtnRun: {
    padding: "2px 10px",
    background: "#2d7a2d",
    border: "none",
    borderRadius: "3px",
    color: "#fff",
    cursor: "pointer",
    fontSize: "11px",
  },
  termBtnStop: {
    padding: "2px 10px",
    background: "#cc3333",
    border: "none",
    borderRadius: "3px",
    color: "#fff",
    cursor: "pointer",
    fontSize: "11px",
  },
  termBtnClear: {
    padding: "2px 8px",
    background: "transparent",
    border: "1px solid #444",
    borderRadius: "3px",
    color: "#888",
    cursor: "pointer",
    fontSize: "11px",
  },
  termBtnRemove: {
    padding: "2px 8px",
    background: "transparent",
    border: "1px solid #663333",
    borderRadius: "3px",
    color: "#ff4a4a",
    cursor: "pointer",
    fontSize: "11px",
    fontWeight: 700,
  },
  termBtnDisabled: {
    padding: "2px 10px",
    background: "#222",
    border: "none",
    borderRadius: "3px",
    color: "#555",
    cursor: "not-allowed",
    fontSize: "11px",
  },
  termPathLine: {
    padding: "4px 12px",
    fontSize: "10px",
    color: "#555",
    fontFamily: "Consolas, 'Courier New', monospace",
    borderBottom: "1px solid #1a1a1a",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  termBody: {
    padding: "10px 12px",
    margin: 0,
    fontSize: "12px",
    fontFamily: "Consolas, 'Courier New', monospace",
    color: "#ccc",
    minHeight: "80px",
    maxHeight: "250px",
    overflowY: "auto",
    overflowX: "hidden",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    lineHeight: 1.5,
  },
};
