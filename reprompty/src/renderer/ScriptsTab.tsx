import React, { useEffect, useRef, useState } from "react";

interface ScriptMcpAction {
  id: string;
  enabled: boolean;
  toolName: string;
  label: string;
  description: string;
  args: string[];
}

interface ScriptInfo {
  id: string;
  name: string;
  path: string;
  type: string;
  args: string[];
  autoStart: boolean;
  layoutRole: string | null;
  mcpActions: ScriptMcpAction[];
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

const BUILT_IN_MCP_TOOLS = [
  {
    name: "spawn_window",
    description: "Open VS Code using a saved target alias or raw folder path.",
  },
  {
    name: "spawn_and_layout",
    description: "Open a target and place it into a layout slot in one call.",
  },
  {
    name: "list_spawn_targets",
    description: "List the short target aliases available to MCP clients.",
  },
  {
    name: "list_virtual_desktops",
    description: "List the current Windows virtual desktops and their names.",
  },
  {
    name: "ensure_virtual_desktop",
    description: "Create a named desktop if it does not exist without switching to it.",
  },
  {
    name: "rename_virtual_desktop",
    description: "Rename an existing desktop by exact name.",
  },
  {
    name: "apply_layout",
    description: "Apply a saved layout slot to the active or targeted window.",
  },
];

function detectTypeFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "ps1":
      return "powershell";
    case "bat":
    case "cmd":
      return "batch";
    case "vbs":
      return "vbs";
    case "exe":
      return "executable";
    default:
      return "powershell";
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "running":
      return "#4aff4a";
    case "starting":
      return "#ffaa4a";
    case "error":
      return "#ff4a4a";
    default:
      return "#666";
  }
}

function typeBadgeColor(type: string): string {
  switch (type) {
    case "powershell":
      return "#5391d9";
    case "batch":
      return "#c0c0c0";
    case "vbs":
      return "#d9a353";
    case "executable":
      return "#53d97a";
    default:
      return "#888";
  }
}

function createNewAction(index: number): ScriptMcpAction {
  const suffix = Date.now() + index;
  return {
    id: `mcp-action-${suffix}`,
    enabled: true,
    toolName: `new_tool_${suffix}`,
    label: "New MCP Tool",
    description: "Describe what this script action should do.",
    args: [],
  };
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
    void loadScripts();

    window.electronAPI.onScriptOutput((data: unknown) => {
      const event = data as ScriptOutputEvent;
      setOutputMap((prev) => {
        const lines = prev[event.scriptId] || [];
        const ts = event.timestamp.split("T")[1]?.slice(0, 8) || "";
        const prefix = event.stream === "stderr" ? "[ERR] " : "";
        const next = [...lines, `[${ts}] ${prefix}${event.line}`];
        if (next.length > 500) {
          next.splice(0, next.length - 500);
        }
        return { ...prev, [event.scriptId]: next };
      });
    });

    window.electronAPI.onScriptStatusChanged((data: unknown) => {
      const event = data as ScriptStatusEvent;
      setScripts((prev) =>
        prev.map((script) =>
          script.id === event.scriptId
            ? { ...script, status: event.status, pid: event.pid }
            : script
        )
      );
    });

    return () => {
      window.electronAPI.removeScriptListeners();
    };
  }, []);

  useEffect(() => {
    for (const element of Object.values(outputRefs.current)) {
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    }
  }, [outputMap]);

  const loadScripts = async () => {
    try {
      const result = (await window.electronAPI.listScripts()) as ScriptInfo[];
      setScripts(result);

      for (const script of result) {
        try {
          const lines = await window.electronAPI.getScriptOutput(script.id);
          if (lines && lines.length > 0) {
            setOutputMap((prev) => ({ ...prev, [script.id]: lines }));
          }
        } catch {
          // Ignore individual output preload failures.
        }
      }
    } catch (err) {
      setStatus(`Failed to load scripts: ${err}`);
    }
  };

  const updateScriptDraft = (
    scriptId: string,
    updater: (script: ScriptInfo) => ScriptInfo
  ): ScriptInfo | null => {
    let nextScript: ScriptInfo | null = null;
    setScripts((prev) =>
      prev.map((script) => {
        if (script.id !== scriptId) {
          return script;
        }
        nextScript = updater(script);
        return nextScript;
      })
    );
    return nextScript;
  };

  const persistScript = async (scriptId: string, updates: Record<string, unknown>) => {
    try {
      const updated = (await window.electronAPI.updateScript(scriptId, updates)) as
        | ScriptInfo
        | null;
      if (updated) {
        setScripts((prev) =>
          prev.map((script) => (script.id === scriptId ? updated : script))
        );
      }
    } catch (err) {
      setStatus(`Failed to update script MCP settings: ${err}`);
      await loadScripts();
    }
  };

  const handleBrowse = async () => {
    try {
      const filePath = await window.electronAPI.pickScriptFile();
      if (!filePath) {
        return;
      }
      setNewPath(filePath);
      setNewType(detectTypeFromPath(filePath));
      if (!newName) {
        const fileName = filePath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") || "";
        setNewName(fileName);
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
      const savedName = newName;
      setNewName("");
      setNewPath("");
      setNewType("powershell");
      setNewArgs("");
      setAddingScript(false);
      setStatus(`Script "${savedName}" added`);
      await loadScripts();
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
      await loadScripts();
    } catch (err) {
      setStatus(`Failed to remove ${name}: ${err}`);
    }
  };

  const handleAutoStartToggle = async (id: string, current: boolean) => {
    try {
      const updated = (await window.electronAPI.updateScript(id, {
        autoStart: !current,
      })) as ScriptInfo | null;
      if (updated) {
        setScripts((prev) => prev.map((script) => (script.id === id ? updated : script)));
      }
    } catch (err) {
      setStatus(`Failed to update auto-start: ${err}`);
    }
  };

  const clearOutput = (id: string) => {
    setOutputMap((prev) => ({ ...prev, [id]: [] }));
  };

  const handleActionFieldChange = (
    scriptId: string,
    actionId: string,
    field: keyof ScriptMcpAction,
    value: string | boolean | string[]
  ) => {
    return updateScriptDraft(scriptId, (script) => ({
      ...script,
      mcpActions: script.mcpActions.map((action) =>
        action.id === actionId ? { ...action, [field]: value } : action
      ),
    }));
  };

  const commitActionChanges = async (scriptId: string) => {
    const script = scripts.find((item) => item.id === scriptId);
    if (!script) {
      return;
    }
    await persistScript(scriptId, { mcpActions: script.mcpActions });
  };

  const addAction = async (scriptId: string) => {
    const draft = updateScriptDraft(scriptId, (script) => ({
      ...script,
      mcpActions: [...script.mcpActions, createNewAction(script.mcpActions.length)],
    }));
    if (draft) {
      await persistScript(scriptId, { mcpActions: draft.mcpActions });
    }
  };

  const removeAction = async (scriptId: string, actionId: string) => {
    const draft = updateScriptDraft(scriptId, (script) => ({
      ...script,
      mcpActions: script.mcpActions.filter((action) => action.id !== actionId),
    }));
    if (draft) {
      await persistScript(scriptId, { mcpActions: draft.mcpActions });
    }
  };

  const rescanHeaderActions = async (scriptId: string, name: string) => {
    try {
      const updated = (await window.electronAPI.rescanScriptMcpActions(scriptId)) as
        | ScriptInfo
        | null;
      if (updated) {
        setScripts((prev) =>
          prev.map((script) => (script.id === scriptId ? updated : script))
        );
      }
      setStatus(`Re-scanned MCP header actions for ${name}`);
    } catch (err) {
      setStatus(`Failed to re-scan MCP headers for ${name}: ${err}`);
    }
  };

  return (
    <div style={styles.panel}>
      <div style={styles.panelHeader}>
        <h2 style={styles.panelTitle}>Scripts</h2>
        <button style={styles.addButton} onClick={() => setAddingScript(!addingScript)}>
          {addingScript ? "Cancel" : "+ Add Script"}
        </button>
      </div>

      <div style={styles.explainerGrid}>
        {BUILT_IN_MCP_TOOLS.map((tool) => (
          <div key={tool.name} style={styles.explainerCard}>
            <code style={styles.explainerToolName}>{tool.name}</code>
            <div style={styles.explainerText}>{tool.description}</div>
          </div>
        ))}
      </div>

      {addingScript && (
        <div style={styles.addForm}>
          <div style={styles.formRow}>
            <input
              style={styles.input}
              placeholder="Script Name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <select
              style={styles.typeSelect}
              value={newType}
              onChange={(event) => setNewType(event.target.value)}
            >
              {SCRIPT_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </div>
          <div style={styles.formRow}>
            <input
              style={{ ...styles.input, flex: 1 }}
              placeholder="Script Path"
              value={newPath}
              onChange={(event) => {
                setNewPath(event.target.value);
                setNewType(detectTypeFromPath(event.target.value));
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
              onChange={(event) => setNewArgs(event.target.value)}
            />
            <button style={styles.saveButton} onClick={handleAdd}>
              Save
            </button>
          </div>
        </div>
      )}

      <div style={styles.scriptList}>
        {scripts.length === 0 ? (
          <p style={styles.emptyText}>No scripts registered yet</p>
        ) : (
          scripts.map((script) => (
            <div key={script.id} style={styles.scriptCard}>
              <div style={styles.terminal}>
                <div
                  style={{
                    ...styles.termTitleBar,
                    borderBottom: `1px solid ${
                      script.status === "running" ? "#333" : "#2a2a2a"
                    }`,
                  }}
                >
                  <div style={styles.termTitleLeft}>
                    <span
                      style={{ ...styles.termDot, background: statusColor(script.status) }}
                    />
                    <span style={styles.termTitle}>{script.name}</span>
                    <span
                      style={{
                        ...styles.typeBadge,
                        background: typeBadgeColor(script.type),
                      }}
                    >
                      {script.type}
                    </span>
                    {script.pid && <span style={styles.termPid}>PID {script.pid}</span>}
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
                      style={
                        script.status === "running"
                          ? styles.termBtnDisabled
                          : styles.termBtnRun
                      }
                      onClick={() => handleRun(script.id, script.name)}
                      disabled={script.status === "running"}
                      title="Run script"
                    >
                      Run
                    </button>
                    <button
                      style={
                        script.status !== "running"
                          ? styles.termBtnDisabled
                          : styles.termBtnStop
                      }
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

                <div style={styles.termPathLine}>{script.path}</div>

                <div style={styles.actionsSection}>
                  <div style={styles.actionsHeader}>
                    <div>
                      <strong style={styles.actionsTitle}>MCP Tools</strong>
                      <div style={styles.actionsSubtitle}>
                        Add UI actions here or use `reprompty-mcp:` lines in the script header.
                      </div>
                    </div>
                    <div style={styles.actionsHeaderButtons}>
                      <button
                        style={styles.actionMiniButton}
                        onClick={() => void rescanHeaderActions(script.id, script.name)}
                      >
                        Re-scan header
                      </button>
                      <button
                        style={styles.actionMiniButtonPrimary}
                        onClick={() => void addAction(script.id)}
                      >
                        + Add MCP tool
                      </button>
                    </div>
                  </div>

                  {script.mcpActions.length === 0 ? (
                    <div style={styles.noActionsText}>
                      No script-defined MCP tools yet for this script.
                    </div>
                  ) : (
                    <div style={styles.actionList}>
                      {script.mcpActions.map((action) => (
                        <div key={action.id} style={styles.actionCard}>
                          <div style={styles.actionTopRow}>
                            <label style={styles.actionToggleLabel}>
                              <input
                                type="checkbox"
                                checked={action.enabled}
                                onChange={(event) => {
                                  const draft = handleActionFieldChange(
                                    script.id,
                                    action.id,
                                    "enabled",
                                    event.target.checked
                                  );
                                  if (draft) {
                                    void persistScript(script.id, { mcpActions: draft.mcpActions });
                                  }
                                }}
                              />
                              Enabled
                            </label>
                            <code style={styles.actionToolBadge}>{action.toolName}</code>
                            <button
                              style={styles.termBtnRemove}
                              onClick={() => void removeAction(script.id, action.id)}
                            >
                              Remove
                            </button>
                          </div>

                          <div style={styles.actionGrid}>
                            <input
                              style={styles.actionInput}
                              value={action.label}
                              onChange={(event) =>
                                handleActionFieldChange(
                                  script.id,
                                  action.id,
                                  "label",
                                  event.target.value
                                )
                              }
                              onBlur={() => void commitActionChanges(script.id)}
                              placeholder="Label"
                            />
                            <input
                              style={styles.actionInput}
                              value={action.toolName}
                              onChange={(event) =>
                                handleActionFieldChange(
                                  script.id,
                                  action.id,
                                  "toolName",
                                  event.target.value
                                )
                              }
                              onBlur={() => void commitActionChanges(script.id)}
                              placeholder="tool_name"
                            />
                          </div>

                          <input
                            style={{ ...styles.actionInput, marginTop: 8 }}
                            value={action.description}
                            onChange={(event) =>
                              handleActionFieldChange(
                                script.id,
                                action.id,
                                "description",
                                event.target.value
                              )
                            }
                            onBlur={() => void commitActionChanges(script.id)}
                            placeholder="Description"
                          />

                          <input
                            style={{ ...styles.actionInput, marginTop: 8 }}
                            value={action.args.join(" ")}
                            onChange={(event) =>
                              handleActionFieldChange(
                                script.id,
                                action.id,
                                "args",
                                event.target.value
                                  .split(" ")
                                  .map((value) => value.trim())
                                  .filter(Boolean)
                              )
                            }
                            onBlur={() => void commitActionChanges(script.id)}
                            placeholder="Args (e.g. -Once or -A)"
                          />

                          <div style={styles.actionCallHint}>
                            MCP call: <code>{action.toolName}</code>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <pre
                  ref={(element) => {
                    outputRefs.current[script.id] = element;
                  }}
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
  explainerGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "12px",
    marginBottom: "20px",
  },
  explainerCard: {
    background: "#1e1e1e",
    border: "1px solid #3d3d3d",
    borderRadius: "6px",
    padding: "12px",
  },
  explainerToolName: {
    display: "block",
    color: "#9fd0ff",
    marginBottom: "6px",
    fontSize: "12px",
  },
  explainerText: {
    fontSize: "12px",
    color: "#bdbdbd",
    lineHeight: 1.5,
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
  scriptCard: {},
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
  actionsSection: {
    padding: "12px",
    borderBottom: "1px solid #1a1a1a",
    background: "#121212",
  },
  actionsHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    marginBottom: "12px",
    flexWrap: "wrap",
  },
  actionsTitle: {
    display: "block",
    fontSize: "13px",
    color: "#fff",
  },
  actionsSubtitle: {
    fontSize: "11px",
    color: "#8a8a8a",
    marginTop: "4px",
  },
  actionsHeaderButtons: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
  },
  actionMiniButton: {
    padding: "6px 10px",
    background: "transparent",
    border: "1px solid #444",
    borderRadius: "4px",
    color: "#bbb",
    cursor: "pointer",
    fontSize: "11px",
  },
  actionMiniButtonPrimary: {
    padding: "6px 10px",
    background: "#22558e",
    border: "1px solid #356ca8",
    borderRadius: "4px",
    color: "#fff",
    cursor: "pointer",
    fontSize: "11px",
  },
  noActionsText: {
    color: "#888",
    fontSize: "12px",
  },
  actionList: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  actionCard: {
    background: "#1a1a1a",
    border: "1px solid #2d2d2d",
    borderRadius: "6px",
    padding: "12px",
  },
  actionTopRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    justifyContent: "space-between",
    flexWrap: "wrap",
    marginBottom: "10px",
  },
  actionToggleLabel: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    color: "#ddd",
    fontSize: "12px",
  },
  actionToolBadge: {
    padding: "3px 8px",
    borderRadius: "999px",
    background: "#223043",
    color: "#9fd0ff",
    fontSize: "11px",
  },
  actionGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "8px",
  },
  actionInput: {
    width: "100%",
    padding: "8px 10px",
    background: "#111",
    border: "1px solid #333",
    borderRadius: "4px",
    color: "#fff",
    fontSize: "12px",
    boxSizing: "border-box",
  },
  actionCallHint: {
    marginTop: "8px",
    fontSize: "11px",
    color: "#8ed0b2",
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
