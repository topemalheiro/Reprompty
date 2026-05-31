import React, { useEffect, useMemo, useState } from "react";
import ScriptsTab from "./ScriptsTab";

interface DetectedWindow {
  pid: number;
  handle: number;
  title: string;
  folderPath: string;
  processName: string;
  desktop?: string;
  isCurrentDesktop?: boolean;
  extension: "kilo-code" | "claude-code" | "codex" | "unknown";
  activeAgent: "kilo-code" | "claude-code" | "codex" | "unknown";
  availableAgents: Array<"kilo-code" | "claude-code" | "codex">;
  backgroundRoute: "ipc-kilo" | "cdp-kilo" | "cdp-claude" | "cdp-codex" | "foreground";
  pipePath: string | null;
  sendMethod: "background" | "foreground";
}

interface SpawnTarget {
  id: string;
  label: string;
  folderPath: string;
  windowName?: string;
  desktop?: string;
  addedAt: string;
}

interface VirtualDesktopInfo {
  index: number;
  name: string;
  isCurrent: boolean;
}

interface SpawnWindowResult {
  success: boolean;
  message?: string;
  error?: string;
  desktop?: string;
}

interface ElectronAPI {
  spawnWindow: (args: {
    folderPath: string;
    windowName?: string;
    desktop?: string;
    activateDesktop?: boolean;
  }) => Promise<SpawnWindowResult>;
  listSpawnTargets: () => Promise<SpawnTarget[]>;
  listVirtualDesktops: () => Promise<VirtualDesktopInfo[]>;
  addSpawnTarget: (args: {
    id?: string;
    label: string;
    folderPath: string;
    windowName?: string;
    desktop?: string;
  }) => Promise<SpawnTarget>;
  updateSpawnTarget: (id: string, updates: Record<string, unknown>) => Promise<SpawnTarget | null>;
  removeSpawnTarget: (id: string) => Promise<boolean>;
  sendPrompt: (args: unknown) => Promise<unknown>;
  sendToDetected: (args: {
    window: unknown;
    prompt: string;
  }) => Promise<{ success: boolean; method?: string; error?: string }>;
  addConnection: (args: unknown) => Promise<unknown>;
  listConnections: () => Promise<unknown>;
  removeConnection: (args: unknown) => Promise<unknown>;
  daisyChain: (args: unknown) => Promise<unknown>;
  detectWindows: () => Promise<DetectedWindow[]>;
  onWindowsDetected: (callback: (windows: DetectedWindow[]) => void) => void;
  removeWindowListeners: () => void;
  listScripts: () => Promise<unknown[]>;
  addScript: (args: {
    name: string;
    path: string;
    type: string;
    args: string[];
  }) => Promise<unknown>;
  removeScript: (id: string) => Promise<boolean>;
  runScript: (id: string) => Promise<boolean>;
  stopScript: (id: string) => Promise<boolean>;
  updateScript: (id: string, updates: Record<string, unknown>) => Promise<unknown>;
  rescanScriptMcpActions: (id: string) => Promise<unknown>;
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

function Mascot() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setFrame((value) => (value + 1) % 6), 350);
    return () => clearInterval(timer);
  }, []);

  const smoke = [
    [" ", " ", ")"],
    [" ", "(", ")"],
    [")", "(", ")"],
    [")", "(", " "],
    [")", " ", " "],
    [" ", " ", " "],
  ][frame];

  const art = [
    `                 ${smoke[0]}`,
    `                ${smoke[1]}`,
    `   (o)_(o)       ${smoke[2]}`,
    `  =( o_o )=   ~~*`,
    `   /  Y  \\-----'`,
    `  / /   \\ \\`,
    ` | |     | |`,
    `  \\_\\___/_/ \\_~`,
    `    |   |`,
    `   _|   |_`,
  ].join("\n");

  return (
    <pre
      style={{
        margin: 0,
        fontFamily: "Consolas, 'Courier New', monospace",
        fontSize: "12px",
        lineHeight: "1.2",
        color: "#666",
        position: "absolute",
        right: 20,
        top: 6,
        userSelect: "none",
      }}
    >
      {art}
    </pre>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState<"windows" | "send" | "spawn" | "scripts">("windows");
  const [detectedWindows, setDetectedWindows] = useState<DetectedWindow[]>([]);
  const [spawnTargets, setSpawnTargets] = useState<SpawnTarget[]>([]);
  const [virtualDesktops, setVirtualDesktops] = useState<VirtualDesktopInfo[]>([]);
  const [selectedWindowHandle, setSelectedWindowHandle] = useState("");
  const [promptText, setPromptText] = useState("");
  const [status, setStatus] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [quickWindowName, setQuickWindowName] = useState("");
  const [quickDesktopName, setQuickDesktopName] = useState("");
  const [editingTargetId, setEditingTargetId] = useState<string | null>(null);
  const [targetIdInput, setTargetIdInput] = useState("");
  const [targetLabelInput, setTargetLabelInput] = useState("");
  const [targetFolderInput, setTargetFolderInput] = useState("");
  const [targetWindowNameInput, setTargetWindowNameInput] = useState("");
  const [targetDesktopInput, setTargetDesktopInput] = useState("");

  const selectedTargetPreview = useMemo(() => {
    const alias = (editingTargetId || targetIdInput || targetLabelInput)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return alias || "windows-project";
  }, [editingTargetId, targetIdInput, targetLabelInput]);

  const virtualDesktopSummary = useMemo(
    () =>
      virtualDesktops
        .map((desktop) => `${desktop.name}${desktop.isCurrent ? " (current)" : ""}`)
        .join(", "),
    [virtualDesktops]
  );

  useEffect(() => {
    void loadSpawnTargets();
    void loadVirtualDesktops();
    window.electronAPI.detectWindows().then(setDetectedWindows).catch(() => undefined);
    window.electronAPI.onWindowsDetected((windows) => {
      setDetectedWindows(windows);
      void loadVirtualDesktops(true);
    });
    return () => {
      window.electronAPI.removeWindowListeners();
    };
  }, []);

  const loadSpawnTargets = async () => {
    try {
      const targets = await window.electronAPI.listSpawnTargets();
      setSpawnTargets(targets);
    } catch (err) {
      setStatus(`Failed to load spawn targets: ${err}`);
    }
  };

  const loadVirtualDesktops = async (silent = false) => {
    try {
      const desktops = await window.electronAPI.listVirtualDesktops();
      setVirtualDesktops(desktops);
    } catch (err) {
      if (!silent) {
        setStatus(`Failed to load virtual desktops: ${err}`);
      }
    }
  };

  const resetTargetForm = () => {
    setEditingTargetId(null);
    setTargetIdInput("");
    setTargetLabelInput("");
    setTargetFolderInput("");
    setTargetWindowNameInput("");
    setTargetDesktopInput("");
  };

  const sendPrompt = async () => {
    if (!selectedWindowHandle || !promptText) {
      setStatus("Select a window and enter a prompt");
      return;
    }

    const targetWindow = detectedWindows.find(
      (windowInfo) => String(windowInfo.handle) === selectedWindowHandle
    );
    if (!targetWindow) {
      setStatus("Window not found. It may have closed.");
      return;
    }

    try {
      setStatus("Sending...");
      const result = await window.electronAPI.sendToDetected({
        window: targetWindow,
        prompt: promptText,
      });
      setStatus(
        result.success ? "Sent successfully" : `Failed: ${result.error || "send failed"}`
      );
      if (result.success) {
        setPromptText("");
      }
    } catch (err) {
      setStatus(`Error: ${err}`);
    }
  };

  const spawnWindow = async () => {
    if (!folderPath.trim()) {
      setStatus("Enter a folder path");
      return;
    }

    try {
      const result = await window.electronAPI.spawnWindow({
        folderPath: folderPath.trim(),
        windowName: quickWindowName.trim() || undefined,
        desktop: quickDesktopName.trim() || undefined,
      });
      setStatus(
        result.success
          ? result.message || `Spawned VS Code for ${folderPath.trim()}`
          : result.error || result.message || "Failed to spawn VS Code window"
      );
      if (!result.success) {
        return;
      }
      setFolderPath("");
      setQuickWindowName("");
      setQuickDesktopName("");
    } catch (err) {
      setStatus(`Error: ${err}`);
    }
  };

  const spawnSavedTarget = async (target: SpawnTarget) => {
    try {
      const result = await window.electronAPI.spawnWindow({
        folderPath: target.folderPath,
        windowName: target.windowName,
        desktop: target.desktop,
      });
      setStatus(
        result.success
          ? result.message || `Spawned ${target.label} (${target.id})`
          : result.error || result.message || `Failed to spawn ${target.label}`
      );
    } catch (err) {
      setStatus(`Failed to spawn ${target.label}: ${err}`);
    }
  };

  const saveSpawnTarget = async () => {
    if (!targetLabelInput.trim() || !targetFolderInput.trim()) {
      setStatus("Target label and folder path are required");
      return;
    }

    const payload = {
      id: targetIdInput.trim() || undefined,
      label: targetLabelInput.trim(),
      folderPath: targetFolderInput.trim(),
      windowName: targetWindowNameInput.trim() || undefined,
      desktop: targetDesktopInput.trim() || undefined,
    };

    try {
      if (editingTargetId) {
        await window.electronAPI.updateSpawnTarget(editingTargetId, payload);
        setStatus(`Updated spawn target ${editingTargetId}`);
      } else {
        const created = await window.electronAPI.addSpawnTarget(payload);
        setStatus(`Saved spawn target ${created.id}`);
      }
      resetTargetForm();
      await loadSpawnTargets();
    } catch (err) {
      setStatus(`Failed to save spawn target: ${err}`);
    }
  };

  const editSpawnTarget = (target: SpawnTarget) => {
    setEditingTargetId(target.id);
    setTargetIdInput(target.id);
    setTargetLabelInput(target.label);
    setTargetFolderInput(target.folderPath);
    setTargetWindowNameInput(target.windowName || "");
    setTargetDesktopInput(target.desktop || "");
    setActiveTab("spawn");
  };

  const removeSpawnTarget = async (id: string) => {
    try {
      await window.electronAPI.removeSpawnTarget(id);
      setStatus(`Removed spawn target ${id}`);
      if (editingTargetId === id) {
        resetTargetForm();
      }
      await loadSpawnTargets();
    } catch (err) {
      setStatus(`Failed to remove spawn target: ${err}`);
    }
  };

  const formatTitle = (windowInfo: DetectedWindow) => {
    const parts = windowInfo.title
      .replace(/ - Visual Studio Code.*$/, "")
      .replace(/ - Kilo Code.*$/, "")
      .split(" - ");
    if (parts.length >= 2) {
      const file = parts[0].trim();
      const folder = parts.slice(1).join(" - ").trim();
      return `${folder} - ${file}`;
    }
    return windowInfo.folderPath || windowInfo.title;
  };

  const agentBadge = (agent: string) => {
    if (agent === "kilo-code") {
      return { label: "Kilo", bg: "#2ea043" };
    }
    if (agent === "claude-code") {
      return { label: "Claude", bg: "#4a9eff" };
    }
    if (agent === "codex") {
      return { label: "Codex", bg: "#0078d4" };
    }
    return { label: "?", bg: "#666" };
  };

  const methodBadge = (route: DetectedWindow["backgroundRoute"]) =>
    route === "foreground"
      ? { label: "FG", bg: "#d29922" }
      : { label: "BG", bg: "#2ea043" };

  const renderDesktopOptions = (selectedDesktop: string) => {
    const hasSelectedDesktop =
      Boolean(selectedDesktop) &&
      virtualDesktops.some((desktop) => desktop.name === selectedDesktop);

    return (
      <>
        <option value="">Current desktop</option>
        {!hasSelectedDesktop && selectedDesktop ? (
          <option value={selectedDesktop}>{selectedDesktop} (missing)</option>
        ) : null}
        {virtualDesktops.map((desktop) => (
          <option key={desktop.index} value={desktop.name}>
            {desktop.name}
            {desktop.isCurrent ? " (current)" : ""}
          </option>
        ))}
      </>
    );
  };

  return (
    <div style={styles.container}>
      <header style={{ ...styles.header, position: "relative", overflow: "hidden" }}>
        <h1 style={styles.title}>Reprompty</h1>
        <p style={styles.subtitle}>Multi-window AI Agent Orchestration</p>
        <Mascot />
      </header>

      <nav style={styles.nav}>
        {([
          ["windows", "Windows"],
          ["send", "Send Prompt"],
          ["spawn", "Spawn"],
          ["scripts", "Scripts"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            style={activeTab === id ? styles.navActive : styles.navBtn}
            onClick={() => setActiveTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      <main style={styles.content}>
        {activeTab === "windows" && (
          <div style={styles.panel}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <h2 style={styles.panelTitle}>Detected Windows</h2>
              <span style={{ color: "#888", fontSize: 12 }}>
                {detectedWindows.length} found (auto-refreshes)
              </span>
            </div>
            <div style={styles.desktopHint}>
              Desktop labels refresh from backend polling. Desktop-aware spawns now stay on your
              current desktop unless `activateDesktop: true` is explicitly requested.
            </div>
            {detectedWindows.length === 0 ? (
              <p style={styles.empty}>No VS Code / Kilo Code windows detected</p>
            ) : (
              detectedWindows.map((windowInfo) => {
                const agent = agentBadge(windowInfo.activeAgent);
                const method = methodBadge(windowInfo.backgroundRoute);
                return (
                  <div key={windowInfo.handle} style={styles.card}>
                    <div style={{ flex: 1 }}>
                      <strong style={{ color: "#fff" }}>{formatTitle(windowInfo)}</strong>
                      <div
                        style={{
                          display: "flex",
                          gap: 6,
                          marginTop: 4,
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        <span style={{ ...styles.badge, background: agent.bg }}>{agent.label}</span>
                        <span style={{ ...styles.badge, background: method.bg }}>{method.label}</span>
                        <span style={{ color: "#666", fontSize: 11 }}>PID {windowInfo.pid}</span>
                        {windowInfo.desktop && (
                          <span style={styles.desktopBadge}>
                            Desktop {windowInfo.desktop}
                            {windowInfo.isCurrentDesktop ? " (current)" : ""}
                          </span>
                        )}
                        {windowInfo.pipePath && (
                          <span style={{ color: "#555", fontSize: 10 }}>{windowInfo.pipePath}</span>
                        )}
                        {windowInfo.availableAgents.length > 0 && (
                          <span style={{ color: "#777", fontSize: 10 }}>
                            tabs {windowInfo.availableAgents.join(", ")}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {activeTab === "send" && (
          <div style={styles.panel}>
            <h2 style={styles.panelTitle}>Send Prompt</h2>

            <select
              style={styles.select}
              value={selectedWindowHandle}
              onChange={(event) => setSelectedWindowHandle(event.target.value)}
            >
              <option value="">Select a window...</option>
              {detectedWindows.map((windowInfo) => {
                const agent =
                  windowInfo.activeAgent === "kilo-code"
                    ? "Kilo"
                    : windowInfo.activeAgent === "claude-code"
                    ? "Claude"
                    : windowInfo.activeAgent === "codex"
                    ? "Codex"
                    : "?";
                const method = windowInfo.backgroundRoute === "foreground" ? "FG" : "BG";
                return (
                  <option key={windowInfo.handle} value={String(windowInfo.handle)}>
                    {formatTitle(windowInfo)} ({agent}) [{method}]
                    {windowInfo.desktop ? ` <Desktop ${windowInfo.desktop}>` : ""}
                  </option>
                );
              })}
            </select>

            <textarea
              style={styles.textarea}
              placeholder="Enter your prompt..."
              value={promptText}
              onChange={(event) => setPromptText(event.target.value)}
              rows={6}
            />

            <button style={styles.btn} onClick={sendPrompt}>
              Send Prompt
            </button>
          </div>
        )}

        {activeTab === "spawn" && (
          <div style={styles.panel}>
            <h2 style={styles.panelTitle}>Spawn VS Code Window</h2>
            <div style={styles.spawnHelp}>
              <div style={styles.helpCard}>
                <strong style={styles.helpTitle}>Built-in MCP Spawn/Desktop Tools</strong>
                <div style={styles.helpBody}>
                  `spawn_window` and `spawn_and_layout` accept `target` aliases plus optional
                  `desktop`, `createDesktop`, and `activateDesktop`. Desktop-aware spawns stay on
                  the current desktop by default and only switch when `activateDesktop: true` is
                  supplied. `list_virtual_desktops`, `ensure_virtual_desktop`, and
                  `rename_virtual_desktop` manage desktop names from the backend.
                </div>
              </div>
              <div style={styles.helpCard}>
                <strong style={styles.helpTitle}>Example</strong>
                <code style={styles.helpCode}>
                  spawn_and_layout
                  {`{ "target": "${selectedTargetPreview}", "slot": "B", "createDesktop": true }`}
                </code>
              </div>
            </div>

            <div style={styles.spawnSection}>
              <h3 style={styles.sectionTitle}>Quick Spawn</h3>
              <input
                style={styles.input}
                placeholder="Folder Path (e.g. C:\\Users\\topem\\my-project)"
                value={folderPath}
                onChange={(event) => setFolderPath(event.target.value)}
              />
              <input
                style={{ ...styles.input, marginTop: 10 }}
                placeholder="Optional window name"
                value={quickWindowName}
                onChange={(event) => setQuickWindowName(event.target.value)}
              />
              <select
                style={{ ...styles.select, marginTop: 10, marginBottom: 0 }}
                value={quickDesktopName}
                onChange={(event) => setQuickDesktopName(event.target.value)}
              >
                {renderDesktopOptions(quickDesktopName)}
              </select>
              <div style={styles.desktopHint}>
                Available desktops: {virtualDesktopSummary || "No virtual desktops detected"}. MCP
                can also create a fresh desktop per spawn with `createDesktop: true`, and it stays
                on your current desktop unless `activateDesktop: true` is requested.
              </div>
              <button style={{ ...styles.btn, marginTop: 12 }} onClick={spawnWindow}>
                Spawn Window
              </button>
            </div>

            <div style={styles.spawnSection}>
              <div style={styles.sectionHeader}>
                <h3 style={styles.sectionTitle}>Saved Spawn Targets</h3>
                <button style={styles.secondaryBtn} onClick={resetTargetForm}>
                  {editingTargetId ? "New Target" : "Reset"}
                </button>
              </div>

              <div style={styles.targetForm}>
                <div style={styles.formGrid}>
                  <input
                    style={styles.input}
                    placeholder="Alias (e.g. windows-project)"
                    value={targetIdInput}
                    onChange={(event) => setTargetIdInput(event.target.value)}
                  />
                  <input
                    style={styles.input}
                    placeholder="Label"
                    value={targetLabelInput}
                    onChange={(event) => setTargetLabelInput(event.target.value)}
                  />
                </div>
                <input
                  style={{ ...styles.input, marginTop: 10 }}
                  placeholder="Folder Path"
                  value={targetFolderInput}
                  onChange={(event) => setTargetFolderInput(event.target.value)}
                />
                <input
                  style={{ ...styles.input, marginTop: 10 }}
                  placeholder="Optional window name"
                  value={targetWindowNameInput}
                  onChange={(event) => setTargetWindowNameInput(event.target.value)}
                />
                <select
                  style={{ ...styles.select, marginTop: 10, marginBottom: 0 }}
                  value={targetDesktopInput}
                  onChange={(event) => setTargetDesktopInput(event.target.value)}
                >
                  {renderDesktopOptions(targetDesktopInput)}
                </select>
                <div style={styles.desktopHint}>
                  Default desktop: {virtualDesktopSummary || "No virtual desktops detected"}
                </div>
                <div style={styles.targetPreviewRow}>
                  <span style={styles.previewLabel}>MCP call:</span>
                  <code style={styles.previewCode}>
                    spawn_window {`{ "target": "${selectedTargetPreview}" }`}
                  </code>
                </div>
                <button style={{ ...styles.btn, marginTop: 12 }} onClick={saveSpawnTarget}>
                  {editingTargetId ? "Update Target" : "Save Target"}
                </button>
              </div>

              <div style={styles.targetList}>
                {spawnTargets.length === 0 ? (
                  <p style={styles.empty}>No saved spawn targets yet</p>
                ) : (
                  spawnTargets.map((target) => (
                    <div key={target.id} style={styles.targetCard}>
                      <div style={{ flex: 1 }}>
                        <div style={styles.targetCardTitleRow}>
                          <strong style={{ color: "#fff" }}>{target.label}</strong>
                          <span style={styles.targetIdBadge}>{target.id}</span>
                        </div>
                        <div style={styles.targetPath}>{target.folderPath}</div>
                        {target.desktop ? (
                          <div style={styles.targetMeta}>Default desktop: {target.desktop}</div>
                        ) : null}
                        <code style={styles.targetMcpCall}>
                          spawn_window {`{ "target": "${target.id}" }`}
                        </code>
                      </div>
                      <div style={styles.targetActions}>
                        <button style={styles.secondaryBtn} onClick={() => spawnSavedTarget(target)}>
                          Spawn
                        </button>
                        <button style={styles.secondaryBtn} onClick={() => editSpawnTarget(target)}>
                          Edit
                        </button>
                        <button
                          style={styles.dangerBtn}
                          onClick={() => void removeSpawnTarget(target.id)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === "scripts" && <ScriptsTab setStatus={setStatus} />}

        {status && <div style={styles.status}>{status}</div>}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { minHeight: "100vh", background: "#1e1e1e", color: "#fff" },
  header: { padding: "20px", background: "#2d2d2d", borderBottom: "1px solid #3d3d3d" },
  title: { margin: 0, fontSize: "24px", fontWeight: 600 },
  subtitle: { margin: "5px 0 0 0", fontSize: "14px", color: "#888" },
  nav: {
    display: "flex",
    padding: "10px 20px",
    background: "#252525",
    borderBottom: "1px solid #3d3d3d",
    gap: "10px",
  },
  navBtn: {
    padding: "10px 20px",
    background: "transparent",
    border: "none",
    color: "#888",
    cursor: "pointer",
    fontSize: "14px",
    borderRadius: "4px",
  },
  navActive: {
    padding: "10px 20px",
    background: "#4a9eff",
    border: "none",
    color: "#fff",
    cursor: "pointer",
    fontSize: "14px",
    borderRadius: "4px",
  },
  content: { padding: "20px" },
  panel: { background: "#2d2d2d", borderRadius: "8px", padding: "20px" },
  panelTitle: { margin: 0, fontSize: "18px" },
  sectionTitle: { margin: 0, fontSize: "16px" },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    marginBottom: "12px",
  },
  spawnHelp: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: "12px",
    marginTop: "16px",
  },
  helpCard: {
    background: "#1e1e1e",
    border: "1px solid #3d3d3d",
    borderRadius: "6px",
    padding: "12px",
  },
  helpTitle: {
    display: "block",
    marginBottom: "6px",
    color: "#fff",
    fontSize: "13px",
  },
  helpBody: {
    color: "#b8b8b8",
    fontSize: "12px",
    lineHeight: 1.5,
  },
  helpCode: {
    display: "block",
    marginTop: "4px",
    color: "#9fd0ff",
    fontSize: "12px",
    whiteSpace: "pre-wrap",
  },
  spawnSection: {
    marginTop: "20px",
    paddingTop: "18px",
    borderTop: "1px solid #3d3d3d",
  },
  card: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px",
    background: "#1e1e1e",
    borderRadius: "6px",
    marginBottom: "8px",
  },
  badge: {
    padding: "2px 8px",
    borderRadius: "3px",
    fontSize: "11px",
    color: "#fff",
    fontWeight: 600,
  },
  desktopBadge: {
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "11px",
    color: "#cbd5e1",
    border: "1px solid #3b4252",
    background: "#252b36",
  },
  input: {
    width: "100%",
    padding: "10px",
    background: "#1e1e1e",
    border: "1px solid #3d3d3d",
    borderRadius: "4px",
    color: "#fff",
    fontSize: "14px",
    boxSizing: "border-box",
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
    boxSizing: "border-box",
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
    background: "transparent",
    border: "1px solid #663333",
    borderRadius: "4px",
    color: "#ff7a7a",
    cursor: "pointer",
    fontSize: "12px",
  },
  empty: { color: "#888", textAlign: "center", padding: "20px" },
  status: {
    marginTop: "20px",
    padding: "10px",
    background: "#252525",
    borderRadius: "4px",
    color: "#4a9eff",
    fontSize: "14px",
  },
  formGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "10px",
  },
  targetForm: {
    background: "#1e1e1e",
    border: "1px solid #3d3d3d",
    borderRadius: "6px",
    padding: "14px",
  },
  targetPreviewRow: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
    flexWrap: "wrap",
    marginTop: "12px",
  },
  previewLabel: {
    color: "#999",
    fontSize: "12px",
  },
  desktopHint: {
    marginTop: "8px",
    color: "#8d96a6",
    fontSize: "12px",
    lineHeight: 1.4,
  },
  previewCode: {
    color: "#9fd0ff",
    fontSize: "12px",
    whiteSpace: "pre-wrap",
  },
  targetList: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    marginTop: "16px",
  },
  targetCard: {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    background: "#1e1e1e",
    border: "1px solid #3d3d3d",
    borderRadius: "6px",
    padding: "14px",
  },
  targetCardTitleRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
  },
  targetIdBadge: {
    padding: "2px 8px",
    borderRadius: "999px",
    background: "#223043",
    color: "#9fd0ff",
    fontSize: "11px",
  },
  targetPath: {
    color: "#999",
    fontSize: "12px",
    marginTop: "6px",
    wordBreak: "break-word",
  },
  targetMeta: {
    color: "#8d96a6",
    fontSize: "12px",
    marginTop: "6px",
  },
  targetMcpCall: {
    display: "block",
    marginTop: "8px",
    color: "#8ed0b2",
    fontSize: "12px",
    whiteSpace: "pre-wrap",
  },
  targetActions: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    alignItems: "stretch",
    minWidth: "92px",
  },
};

export default App;
