import React, { useEffect, useState } from "react";

interface Preset {
  name: string;
  modelPath: string;
  modelType: string;
  quantization: string;
  port: number;
  contextSize: number;
  gpuLayers: number;
  threads: number;
  batchSize: number;
  ubatchSize: number;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  maxTokens: number;
  chatTemplate: string;
  extraArgs: string;
  autostart?: boolean;
}

interface ServerStatus {
  running: boolean;
  pid?: number;
  port?: number;
  preset?: string;
}

const DEFAULT_PRESET: Preset = {
  name: "",
  modelPath: "",
  modelType: "chat",
  quantization: "Q8_0",
  port: 8080,
  contextSize: 32768,
  gpuLayers: 0,
  threads: 8,
  batchSize: 512,
  ubatchSize: 512,
  temperature: 0.8,
  topP: 0.9,
  topK: 40,
  repeatPenalty: 1.1,
  maxTokens: -1,
  chatTemplate: "",
  extraArgs: "",
  autostart: false,
};

const TYPE_COLORS: Record<string, string> = {
  chat: "#4a9eff",
  embedding: "#ffaa44",
  voice: "#ff66aa",
};

export default function LlamaCppTab() {
  const [presets, setPresets] = useState<string[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [statuses, setStatuses] = useState<ServerStatus[]>([]);
  const [autostartList, setAutostartList] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [editorPreset, setEditorPreset] = useState<Preset>(DEFAULT_PRESET);
  const [editorOriginalName, setEditorOriginalName] = useState<string>("");
  const [message, setMessage] = useState<string>("");
  const [binaryPath, setBinaryPath] = useState<string | null>(null);

  useEffect(() => {
    loadPresets();
    checkStatus();
    checkBinary();
    loadAutostart();
    const interval = setInterval(checkStatus, 3000);
    return () => clearInterval(interval);
  }, []);

  const loadPresets = async () => {
    try {
      const list = await window.electronAPI.llamaListPresets();
      setPresets(list);
      if (list.length > 0 && !selectedPreset) {
        setSelectedPreset(list[0]);
      }
    } catch (err) {
      setMessage(`Failed to load presets: ${err}`);
    }
  };

  const checkStatus = async () => {
    try {
      const s = await window.electronAPI.llamaStatus();
      setStatuses(Array.isArray(s) ? s : []);
    } catch {
      setStatuses([]);
    }
  };

  const checkBinary = async () => {
    try {
      const path = await window.electronAPI.llamaGetBinaryPath();
      setBinaryPath(path);
    } catch {
      setBinaryPath(null);
    }
  };

  const loadAutostart = async () => {
    try {
      const list = await window.electronAPI.llamaGetAutostart();
      setAutostartList(Array.isArray(list) ? list : []);
    } catch {
      setAutostartList([]);
    }
  };

  const isRunning = (presetName: string) =>
    statuses.some((s) => s.preset === presetName);

  const handleStart = async () => {
    if (!selectedPreset) {
      setMessage("Select a preset first");
      return;
    }
    setMessage(`Starting ${selectedPreset}...`);
    try {
      const result = await window.electronAPI.llamaStart(selectedPreset);
      if (result.success) {
        setMessage(`Started ${selectedPreset} on port ${result.port} (PID ${result.pid})`);
        checkStatus();
      } else {
        setMessage(`Start failed: ${result.error}`);
      }
    } catch (err) {
      setMessage(`Error: ${err}`);
    }
  };

  const handleStopAll = async () => {
    setMessage("Stopping all llama-servers...");
    try {
      await window.electronAPI.llamaStop();
      setMessage("All servers stopped");
      checkStatus();
    } catch (err) {
      setMessage(`Error: ${err}`);
    }
  };

  const handleStopPreset = async (presetName: string) => {
    setMessage(`Stopping ${presetName}...`);
    try {
      await window.electronAPI.llamaStopPreset(presetName);
      setMessage(`${presetName} stopped`);
      checkStatus();
    } catch (err) {
      setMessage(`Error: ${err}`);
    }
  };

  const handleOpenUI = (port: number) => {
    window.open(`http://localhost:${port}`, "_blank");
  };

  const handleNew = () => {
    setEditorPreset({ ...DEFAULT_PRESET, name: "new-preset" });
    setEditorOriginalName("");
    setEditing(true);
    setMessage("");
  };

  const handleEdit = async () => {
    if (!selectedPreset) return;
    try {
      const data = await window.electronAPI.llamaLoadPreset(selectedPreset);
      if (data) {
        const preset = data as Preset;
        preset.autostart = autostartList.includes(selectedPreset);
        setEditorPreset(preset);
        setEditorOriginalName(selectedPreset);
        setEditing(true);
        setMessage("");
      }
    } catch (err) {
      setMessage(`Failed to load preset: ${err}`);
    }
  };

  const handleDelete = async () => {
    if (!selectedPreset) return;
    if (!confirm(`Delete preset '${selectedPreset}'?`)) return;
    try {
      await window.electronAPI.llamaDeletePreset(selectedPreset);
      setMessage(`Deleted '${selectedPreset}'`);
      setSelectedPreset("");
      loadPresets();
    } catch (err) {
      setMessage(`Delete failed: ${err}`);
    }
  };

  const handleSaveEditor = async () => {
    const name = editorPreset.name.trim();
    if (!name) {
      setMessage("Preset name is required");
      return;
    }
    if (!editorPreset.modelPath.trim()) {
      setMessage("Model path is required");
      return;
    }
    try {
      // Persist autostart separately from preset JSON
      await window.electronAPI.llamaSetAutostart(name, !!editorPreset.autostart);
      // Remove autostart field before saving preset JSON
      const { autostart: _, ...presetData } = editorPreset;
      await window.electronAPI.llamaSavePreset(name, presetData);
      setMessage(`Saved preset '${name}'`);
      setEditing(false);
      loadPresets();
      loadAutostart();
      setSelectedPreset(name);
    } catch (err) {
      setMessage(`Save failed: ${err}`);
    }
  };

  const handlePickModel = async () => {
    const path = prompt("Enter full path to .gguf model:", editorPreset.modelPath);
    if (path !== null) {
      setEditorPreset({ ...editorPreset, modelPath: path });
    }
  };

  const handlePickBinary = async () => {
    const path = prompt("Enter full path to llama-server binary:", binaryPath || "");
    if (path !== null) {
      await window.electronAPI.llamaSetBinaryPath(path);
      checkBinary();
    }
  };

  return (
    <div style={styles.panel}>
      <div style={styles.headerRow}>
        <h2 style={styles.panelTitle}>Llama.cpp Local Models</h2>
        {statuses.length > 0 && (
          <span style={styles.runningBadge}>
            ● {statuses.length} model{statuses.length > 1 ? "s" : ""} running
          </span>
        )}
      </div>

      {!binaryPath && (
        <div style={styles.warningBanner}>
          <b>llama-server not found.</b>{" "}
          <button style={styles.linkBtn} onClick={handlePickBinary}>
            Set binary path
          </button>{" "}
          or install llama.cpp (e.g., <code>brew install llama.cpp</code> or build from source).
        </div>
      )}

      {message && <div style={styles.infoBanner}>{message}</div>}

      {/* Controls */}
      <div style={styles.controlRow}>
        <select
          style={styles.select}
          value={selectedPreset}
          onChange={(e) => setSelectedPreset(e.target.value)}
        >
          <option value="">Select a preset...</option>
          {presets.map((p) => (
            <option key={p} value={p}>
              {p} {isRunning(p) ? "●" : ""} {autostartList.includes(p) ? "🚀" : ""}
            </option>
          ))}
        </select>

        <button
          style={styles.btn}
          onClick={handleStart}
          disabled={!binaryPath || !selectedPreset || isRunning(selectedPreset)}
        >
          Start
        </button>
        <button
          style={styles.secondaryBtn}
          onClick={handleStopAll}
          disabled={statuses.length === 0}
        >
          Stop All
        </button>
        <button style={styles.secondaryBtn} onClick={handleNew}>
          New Preset
        </button>
        <button style={styles.secondaryBtn} onClick={handleEdit} disabled={!selectedPreset}>
          Edit
        </button>
        <button style={styles.dangerBtn} onClick={handleDelete} disabled={!selectedPreset}>
          Delete
        </button>
      </div>

      {/* Active Model Cards */}
      <div style={styles.cardsContainer}>
        {statuses.length === 0 && (
          <div style={styles.emptyState}>No models running</div>
        )}
        {statuses.map((s) => (
          <div key={s.preset} style={styles.card}>
            <div style={styles.cardHeader}>
              <span style={styles.cardTitle}>{s.preset}</span>
              <span
                style={{
                  ...styles.typeBadge,
                  background: TYPE_COLORS[getPresetType(s.preset)] || "#666",
                }}
              >
                {getPresetType(s.preset)}
              </span>
            </div>
            <div style={styles.cardBody}>
              <div style={styles.cardField}>
                <span style={styles.cardLabel}>Port</span>
                <span style={styles.cardValue}>{s.port}</span>
              </div>
              <div style={styles.cardField}>
                <span style={styles.cardLabel}>PID</span>
                <span style={styles.cardValue}>{s.pid}</span>
              </div>
            </div>
            <div style={styles.cardActions}>
              <button
                style={styles.cardBtn}
                onClick={() => s.port && handleOpenUI(s.port)}
              >
                Open UI
              </button>
              <button
                style={styles.cardStopBtn}
                onClick={() => s.preset && handleStopPreset(s.preset)}
              >
                Stop
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Preset Editor */}
      {editing && (
        <div style={styles.editorPanel}>
          <h3 style={styles.editorTitle}>
            {editorOriginalName ? `Editing: ${editorOriginalName}` : "New Preset"}
          </h3>

          <div style={styles.formGrid}>
            <label style={styles.label}>Preset Name</label>
            <input
              style={styles.input}
              value={editorPreset.name}
              onChange={(e) => setEditorPreset({ ...editorPreset, name: e.target.value })}
            />

            <label style={styles.label}>Model Path (.gguf)</label>
            <div style={styles.inputRow}>
              <input
                style={{ ...styles.input, flex: 1 }}
                value={editorPreset.modelPath}
                onChange={(e) => setEditorPreset({ ...editorPreset, modelPath: e.target.value })}
              />
              <button style={styles.secondaryBtn} onClick={handlePickModel}>
                Browse
              </button>
            </div>

            <label style={styles.label}>Model Type</label>
            <select
              style={styles.select}
              value={editorPreset.modelType}
              onChange={(e) => setEditorPreset({ ...editorPreset, modelType: e.target.value })}
            >
              <option value="chat">Chat</option>
              <option value="embedding">Embedding</option>
              <option value="voice">Voice / TTS</option>
            </select>

            <label style={styles.label}>Quantization</label>
            <select
              style={styles.select}
              value={editorPreset.quantization}
              onChange={(e) => setEditorPreset({ ...editorPreset, quantization: e.target.value })}
            >
              <option value="Q4_K_M">Q4_K_M (smallest)</option>
              <option value="Q5_K_M">Q5_K_M</option>
              <option value="Q6_K">Q6_K</option>
              <option value="Q8_0">Q8_0 (best quality)</option>
              <option value="FP16">FP16</option>
            </select>

            <label style={styles.label}>Server Port</label>
            <input
              style={styles.input}
              type="number"
              value={editorPreset.port}
              onChange={(e) => setEditorPreset({ ...editorPreset, port: parseInt(e.target.value) || 8080 })}
            />

            <label style={styles.label}>Context Size</label>
            <input
              style={styles.input}
              type="number"
              value={editorPreset.contextSize}
              onChange={(e) => setEditorPreset({ ...editorPreset, contextSize: parseInt(e.target.value) || 4096 })}
            />

            <label style={styles.label}>GPU Layers (-ngl)</label>
            <input
              style={styles.input}
              type="number"
              value={editorPreset.gpuLayers}
              onChange={(e) => setEditorPreset({ ...editorPreset, gpuLayers: parseInt(e.target.value) || 0 })}
            />

            <label style={styles.label}>Threads (-t)</label>
            <input
              style={styles.input}
              type="number"
              value={editorPreset.threads}
              onChange={(e) => setEditorPreset({ ...editorPreset, threads: parseInt(e.target.value) || 4 })}
            />

            <label style={styles.label}>Batch Size (-b)</label>
            <input
              style={styles.input}
              type="number"
              value={editorPreset.batchSize}
              onChange={(e) => setEditorPreset({ ...editorPreset, batchSize: parseInt(e.target.value) || 512 })}
            />

            <label style={styles.label}>UBatch Size (-ub)</label>
            <input
              style={styles.input}
              type="number"
              value={editorPreset.ubatchSize}
              onChange={(e) => setEditorPreset({ ...editorPreset, ubatchSize: parseInt(e.target.value) || 512 })}
            />

            <label style={styles.label}>Temperature</label>
            <input
              style={styles.input}
              type="number"
              step="0.1"
              value={editorPreset.temperature}
              onChange={(e) => setEditorPreset({ ...editorPreset, temperature: parseFloat(e.target.value) })}
            />

            <label style={styles.label}>Top-p</label>
            <input
              style={styles.input}
              type="number"
              step="0.05"
              value={editorPreset.topP}
              onChange={(e) => setEditorPreset({ ...editorPreset, topP: parseFloat(e.target.value) })}
            />

            <label style={styles.label}>Top-k</label>
            <input
              style={styles.input}
              type="number"
              value={editorPreset.topK}
              onChange={(e) => setEditorPreset({ ...editorPreset, topK: parseInt(e.target.value) || 0 })}
            />

            <label style={styles.label}>Repeat Penalty</label>
            <input
              style={styles.input}
              type="number"
              step="0.1"
              value={editorPreset.repeatPenalty}
              onChange={(e) => setEditorPreset({ ...editorPreset, repeatPenalty: parseFloat(e.target.value) })}
            />

            <label style={styles.label}>Max Tokens (-n)</label>
            <input
              style={styles.input}
              type="number"
              value={editorPreset.maxTokens}
              onChange={(e) => setEditorPreset({ ...editorPreset, maxTokens: parseInt(e.target.value) || -1 })}
            />

            <label style={styles.label}>Chat Template</label>
            <input
              style={styles.input}
              value={editorPreset.chatTemplate}
              onChange={(e) => setEditorPreset({ ...editorPreset, chatTemplate: e.target.value })}
              placeholder="e.g., qwen, gemma, llama3, mistral"
            />

            <label style={styles.label}>Extra CLI Args</label>
            <input
              style={styles.input}
              value={editorPreset.extraArgs}
              onChange={(e) => setEditorPreset({ ...editorPreset, extraArgs: e.target.value })}
              placeholder="e.g., --flash-attn --mlock"
            />

            <label style={styles.label}>Launch on startup</label>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={!!editorPreset.autostart}
                onChange={(e) => setEditorPreset({ ...editorPreset, autostart: e.target.checked })}
              />
              Start this model automatically when Reprompty opens
            </label>
          </div>

          <div style={styles.editorActions}>
            <button style={styles.btn} onClick={handleSaveEditor}>
              Save Preset
            </button>
            <button style={styles.secondaryBtn} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Aperant integration hint */}
      <div style={styles.hintBox}>
        <b>💡 Aperant-MCP Integration:</b> Start a preset, then in Aperant-MCP add an API profile with Base URL{" "}
        <code>http://localhost:{statuses[0]?.port || 8080}/v1</code> and API Key <code>dummy</code>.
        {statuses.length > 1 && " Multiple models are running — use the port shown on each card above."}
      </div>
    </div>
  );
}

// Helper to guess preset type from preset data (we load it on demand for the card)
function getPresetType(presetName: string | undefined): string {
  if (!presetName) return "chat";
  if (presetName.includes("embedding")) return "embedding";
  if (presetName.includes("vocal") || presetName.includes("voice") || presetName.includes("tts")) return "voice";
  return "chat";
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    background: "#2d2d2d",
    borderRadius: "8px",
    padding: "20px",
    display: "flex",
    flexDirection: "column",
    height: "calc(100vh - 160px)",
    minHeight: "400px",
    overflowY: "auto",
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "16px",
    flexWrap: "wrap",
    gap: "12px",
    flexShrink: 0,
  },
  panelTitle: {
    margin: 0,
    fontSize: "18px",
  },
  runningBadge: {
    color: "#44ff44",
    fontSize: "13px",
    fontWeight: 600,
  },
  warningBanner: {
    padding: "10px 12px",
    background: "#332211",
    border: "1px solid #664422",
    borderRadius: "4px",
    color: "#ffaa44",
    fontSize: "13px",
    marginBottom: "12px",
    flexShrink: 0,
  },
  infoBanner: {
    padding: "8px 12px",
    background: "#113322",
    border: "1px solid #226644",
    borderRadius: "4px",
    color: "#44ff88",
    fontSize: "13px",
    marginBottom: "12px",
    flexShrink: 0,
  },
  controlRow: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
    marginBottom: "16px",
    flexWrap: "wrap",
    flexShrink: 0,
  },
  select: {
    padding: "6px 10px",
    background: "#1e1e1e",
    color: "#eee",
    border: "1px solid #444",
    borderRadius: "4px",
    fontSize: "13px",
    minWidth: "180px",
  },
  btn: {
    padding: "8px 16px",
    background: "#4a9eff",
    border: "none",
    borderRadius: "4px",
    color: "#fff",
    cursor: "pointer",
    fontSize: "13px",
  },
  secondaryBtn: {
    padding: "8px 14px",
    background: "#333",
    border: "1px solid #4a4a4a",
    borderRadius: "4px",
    color: "#eee",
    cursor: "pointer",
    fontSize: "12px",
  },
  dangerBtn: {
    padding: "8px 14px",
    background: "#553333",
    border: "1px solid #884444",
    borderRadius: "4px",
    color: "#ff8888",
    cursor: "pointer",
    fontSize: "12px",
  },
  linkBtn: {
    background: "transparent",
    border: "none",
    color: "#4a9eff",
    cursor: "pointer",
    textDecoration: "underline",
    fontSize: "13px",
    padding: 0,
  },
  cardsContainer: {
    display: "flex",
    flexWrap: "wrap",
    gap: "12px",
    marginBottom: "16px",
    flexShrink: 0,
  },
  emptyState: {
    padding: "20px",
    color: "#888",
    fontSize: "13px",
    fontStyle: "italic",
    width: "100%",
    textAlign: "center",
  },
  card: {
    background: "#252525",
    border: "1px solid #3d3d3d",
    borderRadius: "8px",
    padding: "12px 14px",
    minWidth: "180px",
    maxWidth: "240px",
    flex: "1 1 180px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "8px",
  },
  cardTitle: {
    fontWeight: 600,
    fontSize: "14px",
    color: "#eee",
    wordBreak: "break-word",
  },
  typeBadge: {
    fontSize: "10px",
    fontWeight: 600,
    color: "#fff",
    padding: "2px 6px",
    borderRadius: "4px",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    whiteSpace: "nowrap",
  },
  cardBody: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  cardField: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: "12px",
  },
  cardLabel: {
    color: "#888",
  },
  cardValue: {
    color: "#ccc",
    fontFamily: "monospace",
  },
  cardActions: {
    display: "flex",
    gap: "6px",
    marginTop: "4px",
  },
  cardBtn: {
    flex: 1,
    padding: "6px 10px",
    background: "#333",
    border: "1px solid #4a4a4a",
    borderRadius: "4px",
    color: "#eee",
    cursor: "pointer",
    fontSize: "11px",
  },
  cardStopBtn: {
    flex: 1,
    padding: "6px 10px",
    background: "#553333",
    border: "1px solid #884444",
    borderRadius: "4px",
    color: "#ff8888",
    cursor: "pointer",
    fontSize: "11px",
  },
  editorPanel: {
    background: "#252525",
    borderRadius: "8px",
    padding: "16px",
    marginBottom: "16px",
    border: "1px solid #3d3d3d",
    flexShrink: 0,
  },
  editorTitle: {
    margin: "0 0 12px 0",
    fontSize: "15px",
    color: "#ccc",
  },
  formGrid: {
    display: "grid",
    gridTemplateColumns: "140px 1fr",
    gap: "8px 12px",
    alignItems: "center",
  },
  label: {
    fontSize: "12px",
    color: "#aaa",
    textAlign: "right",
  },
  checkboxLabel: {
    fontSize: "12px",
    color: "#ccc",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    cursor: "pointer",
  },
  input: {
    padding: "5px 8px",
    background: "#1e1e1e",
    color: "#eee",
    border: "1px solid #444",
    borderRadius: "4px",
    fontSize: "13px",
  },
  inputRow: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
  },
  editorActions: {
    display: "flex",
    gap: "8px",
    marginTop: "16px",
    justifyContent: "flex-end",
  },
  hintBox: {
    padding: "10px 12px",
    background: "#1a1a2e",
    border: "1px solid #2d2d44",
    borderRadius: "4px",
    color: "#8899cc",
    fontSize: "12px",
    marginTop: "auto",
    flexShrink: 0,
  },
};
