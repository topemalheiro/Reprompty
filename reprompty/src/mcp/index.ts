import {
  connectionManager,
  type ConnectionType,
  type ConnectionConfig,
  type VSCodeWindowConfig,
} from "../core/connection-manager.js";
import { getOrCreateIpcClient } from "../core/ipc-client.js";
import { scriptManager } from "../core/script-manager.js";
import {
  layoutManager,
  type LayoutTarget,
} from "../core/layout-manager.js";
import {
  resolveSpawnTargetDesktop,
  spawnTargetManager,
} from "../core/spawn-target-manager.js";
import {
  listVirtualDesktops,
  switchToVirtualDesktop,
} from "../core/virtual-desktop-manager.js";
import {
  spawnWindow,
  detectWindows,
  getCdpPort,
  type DetectedWindow,
} from "../platform/windows.js";
import { sendViaAgentCdp, isCdpAvailable } from "../core/cdp-client.js";
import {
  buildSpawnTitleHints,
  findNewWindowCandidates,
  selectUniqueWindowByTitle,
} from "./window-targeting.js";

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: object;
}

export interface MCPResource {
  uri: string;
  name: string;
  description: string;
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const BUILT_IN_TOOLS: MCPTool[] = [
  {
    name: "spawn_window",
    description: "Spawn a new VS Code window using a saved target alias or a raw project folder",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Saved spawn target alias" },
        folderPath: { type: "string", description: "Path to the project folder" },
        windowName: { type: "string", description: "Optional name for the window" },
        desktop: {
          type: "string",
          description: "Optional virtual desktop name to switch to before spawning",
        },
      },
    },
  },
  {
    name: "list_spawn_targets",
    description: "List all saved spawn target aliases for opening VS Code windows",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_virtual_desktops",
    description: "List all available Windows virtual desktops and indicate which one is current",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "send_prompt",
    description: "Send a prompt to a specific connection (appears in chat without focusing window)",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string", description: "ID of the connection to send to" },
        prompt: { type: "string", description: "The prompt to send" },
        waitForResponse: {
          type: "boolean",
          description: "Wait for response (not implemented yet)",
        },
        timeout: { type: "number", description: "Timeout in milliseconds" },
      },
      required: ["connectionId", "prompt"],
    },
  },
  {
    name: "add_connection",
    description: "Add a new connection to the connection pool",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["vscode-window", "vscode-cli", "http-api", "websocket"],
          description: "Type of connection",
        },
        name: { type: "string", description: "Name for this connection" },
        config: {
          type: "object",
          description: "Connection configuration",
          properties: {
            socketPath: { type: "string", description: "IPC socket path" },
            windowTitle: { type: "string", description: "Window title to find" },
            method: {
              type: "string",
              enum: ["foreground", "background"],
              description: "Send method",
            },
            folderPath: { type: "string", description: "Folder path for CLI" },
            url: { type: "string", description: "URL for HTTP/WebSocket" },
          },
        },
      },
      required: ["type", "name", "config"],
    },
  },
  {
    name: "list_connections",
    description: "List all available connections",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "remove_connection",
    description: "Remove a connection from the pool",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string", description: "ID of the connection to remove" },
      },
      required: ["connectionId"],
    },
  },
  {
    name: "daisy_chain",
    description: "Chain multiple prompts across connections",
    inputSchema: {
      type: "object",
      properties: {
        prompts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              connectionId: { type: "string" },
              prompt: { type: "string" },
            },
            required: ["connectionId", "prompt"],
          },
        },
        continueOnError: { type: "boolean" },
      },
      required: ["prompts"],
    },
  },
  {
    name: "list_scripts",
    description: "List all registered scripts with their current status",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "run_script",
    description: "Run a registered script by name or ID",
    inputSchema: {
      type: "object",
      properties: {
        scriptId: { type: "string", description: "Script ID or name" },
      },
      required: ["scriptId"],
    },
  },
  {
    name: "stop_script",
    description: "Stop a running script by name or ID",
    inputSchema: {
      type: "object",
      properties: {
        scriptId: { type: "string", description: "Script ID or name" },
      },
      required: ["scriptId"],
    },
  },
  {
    name: "apply_layout",
    description: "Apply a layout slot to position or resize the active VS Code window",
    inputSchema: {
      type: "object",
      properties: {
        slot: {
          type: "string",
          description: "Slot letter (A, B) or slot name (for example 'Dual Bottom')",
        },
        windowTitle: {
          type: "string",
          description: "Optional: target a specific window by title",
        },
        windowHandle: {
          type: "number",
          description: "Optional: exact window handle to target. Preferred over windowTitle",
        },
      },
      required: ["slot"],
    },
  },
  {
    name: "list_layout_slots",
    description: "List all available layout slots with their configurations",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "spawn_and_layout",
    description: "Spawn a new VS Code window from a target or folder path and apply a layout slot",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Saved spawn target alias" },
        folderPath: { type: "string", description: "Path to the project folder" },
        windowName: { type: "string", description: "Optional name for the window" },
        desktop: {
          type: "string",
          description: "Optional virtual desktop name to switch to before spawning",
        },
        slot: {
          type: "string",
          description: "Layout slot letter (A, B) or name to apply after spawning",
        },
      },
      required: ["slot"],
    },
  },
  {
    name: "detect_windows",
    description: "Auto-detect all VS Code and Kilo Code windows with their PIDs and capabilities",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "check_cdp",
    description: "Check if Chrome DevTools Protocol is available for Claude Code background sending",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

function textResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function getGeneratedTools(): MCPTool[] {
  return scriptManager.listGeneratedMcpTools().map((registration) => ({
    name: registration.action.toolName,
    description:
      registration.action.description ||
      `Run ${registration.action.label} from ${registration.scriptName}`,
    inputSchema: {
      type: "object",
      properties: {},
    },
  }));
}

export function getTools(): MCPTool[] {
  return [...BUILT_IN_TOOLS, ...getGeneratedTools()];
}

function resolveSpawnInput(args: Record<string, unknown>):
  | { folderPath: string; windowName?: string; desktop?: string; label: string }
  | { error: string } {
  const target = typeof args.target === "string" ? args.target.trim() : "";
  const explicitFolderPath =
    typeof args.folderPath === "string" ? args.folderPath.trim() : "";
  const explicitWindowName =
    typeof args.windowName === "string" ? args.windowName.trim() : "";
  const explicitDesktop =
    typeof args.desktop === "string" ? args.desktop.trim() : "";

  if (target) {
    const savedTarget = spawnTargetManager.getTarget(target);
    if (!savedTarget) {
      return { error: `Spawn target "${target}" not found` };
    }
    return {
      folderPath: savedTarget.folderPath,
      windowName: explicitWindowName || savedTarget.windowName,
      desktop: resolveSpawnTargetDesktop(explicitDesktop, savedTarget.desktop),
      label: `${savedTarget.label} (${savedTarget.id})`,
    };
  }

  if (!explicitFolderPath) {
    return { error: 'Provide either "target" or "folderPath"' };
  }

  return {
    folderPath: explicitFolderPath,
    windowName: explicitWindowName || undefined,
    desktop: resolveSpawnTargetDesktop(explicitDesktop),
    label: explicitFolderPath,
  };
}

function resolveLayoutSlot(slotKey: string) {
  return (
    layoutManager.getSlotByLetter(slotKey) ??
    layoutManager
      .listSlots()
      .find((slot) => slot.name.toLowerCase() === slotKey.toLowerCase())
  );
}

function parseWindowHandle(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function formatWindowSummary(window: DetectedWindow): string {
  return `${window.handle}:${window.pid}:${window.title}`;
}

function logToolEvent(message: string, details?: unknown): void {
  if (details === undefined) {
    console.log(`[Reprompty MCP] ${message}`);
    return;
  }

  console.log(
    `[Reprompty MCP] ${message} ${JSON.stringify(details)}`
  );
}

async function waitForSpawnedWindow(
  baselineWindows: DetectedWindow[],
  titleHints: string[],
  timeoutMs = 15000,
  pollIntervalMs = 500
): Promise<{
  matchedWindow: DetectedWindow | null;
  finalWindows: DetectedWindow[];
  newCandidates: DetectedWindow[];
  reason: string;
}> {
  const startedAt = Date.now();
  let finalWindows = baselineWindows;
  let newCandidates: DetectedWindow[] = [];
  let lastReason = "no new window handles detected after spawn";

  while (Date.now() - startedAt < timeoutMs) {
    finalWindows = await detectWindows();
    newCandidates = findNewWindowCandidates(baselineWindows, finalWindows);

    if (newCandidates.length === 1) {
      return {
        matchedWindow: newCandidates[0],
        finalWindows,
        newCandidates,
        reason: "matched a unique new window handle",
      };
    }

    if (newCandidates.length > 1) {
      const narrowed = selectUniqueWindowByTitle(newCandidates, titleHints);
      if (narrowed.match) {
        return {
          matchedWindow: narrowed.match,
          finalWindows,
          newCandidates,
          reason: `${narrowed.reason} among newly detected windows`,
        };
      }

      lastReason = `${narrowed.reason}; new candidates=${newCandidates
        .map(formatWindowSummary)
        .join(" | ")}`;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const fallback = selectUniqueWindowByTitle(finalWindows, titleHints);
  if (fallback.match) {
    return {
      matchedWindow: fallback.match,
      finalWindows,
      newCandidates,
      reason: `${fallback.reason} after timeout`,
    };
  }

  return {
    matchedWindow: null,
    finalWindows,
    newCandidates,
    reason: `${lastReason}; ${fallback.reason}`,
  };
}

export async function callTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case "spawn_window": {
      const resolved = resolveSpawnInput(args);
      if ("error" in resolved) {
        return textResult(resolved.error, true);
      }
      const result = await spawnWindow(
        resolved.folderPath,
        resolved.windowName,
        resolved.desktop
      );
      return textResult(JSON.stringify(result, null, 2), !result.success);
    }

    case "list_spawn_targets": {
      return textResult(JSON.stringify(spawnTargetManager.listTargets(), null, 2));
    }

    case "list_virtual_desktops": {
      try {
        return textResult(JSON.stringify(await listVirtualDesktops(), null, 2));
      } catch (error) {
        return textResult(
          `Failed to list virtual desktops: ${error instanceof Error ? error.message : String(error)}`,
          true
        );
      }
    }

    case "send_prompt": {
      const connectionId = args.connectionId as string;
      const prompt = args.prompt as string;
      const connection =
        connectionManager.getConnection(connectionId) ||
        connectionManager.getConnectionByName(connectionId);

      if (!connection) {
        return textResult(`Error: Connection "${connectionId}" not found`, true);
      }

      const cfg = connection.config as VSCodeWindowConfig;

      if (cfg.method === "background" && cfg.socketPath) {
        try {
          const client = getOrCreateIpcClient(cfg.socketPath);
          const ready = await client.waitForReady();
          if (!ready) {
            connectionManager.updateConnectionStatus(connection.id, "error");
            return textResult(
              `Error: IPC not ready for ${connection.name} (timeout)`,
              true
            );
          }
          client.sendTaskMessage(prompt);
          connectionManager.updateConnectionStatus(connection.id, "active");
          return textResult(`Sent to ${connection.name} via background IPC`);
        } catch (err) {
          connectionManager.updateConnectionStatus(connection.id, "error");
          return textResult(`Error sending to ${connection.name}: ${err}`, true);
        }
      }

      if (
        cfg.extension === "claude-code" ||
        cfg.extension === "codex" ||
        cfg.extension === "kilo-code"
      ) {
        const port = getCdpPort();
        if (port) {
          const result = await sendViaAgentCdp(port, prompt, {
            agent: cfg.extension,
            windowTitle: cfg.windowTitle,
          });
          if (result.success) {
            connectionManager.updateConnectionStatus(connection.id, "active");
            return textResult(`Sent to ${connection.name} via ${cfg.extension} CDP (background)`);
          }
        }
      }

      return textResult(
        `No background method available for ${connection.name}. Use foreground from Reprompty UI.`,
        true
      );
    }

    case "add_connection": {
      const type = args.type as ConnectionType;
      const name = args.name as string;
      const config = args.config as ConnectionConfig;
      const connection = connectionManager.addConnection(type, name, config);
      return textResult(`Added connection: ${connection.id} (${connection.name})`);
    }

    case "list_connections": {
      return textResult(JSON.stringify(connectionManager.listConnections(), null, 2));
    }

    case "remove_connection": {
      const connectionId = args.connectionId as string;
      const removed = connectionManager.removeConnection(connectionId);
      return textResult(
        removed
          ? `Removed connection ${connectionId}`
          : `Connection ${connectionId} not found`,
        !removed
      );
    }

    case "daisy_chain": {
      const prompts = args.prompts as Array<{ connectionId: string; prompt: string }>;
      const continueOnError = (args.continueOnError as boolean) || false;
      const results: string[] = [];

      for (const promptTask of prompts) {
        const connection =
          connectionManager.getConnection(promptTask.connectionId) ||
          connectionManager.getConnectionByName(promptTask.connectionId);
        if (!connection) {
          results.push(`Connection "${promptTask.connectionId}" not found`);
          if (!continueOnError) {
            break;
          }
          continue;
        }

        const cfg = connection.config as VSCodeWindowConfig;
        try {
          if (cfg.method === "background" && cfg.socketPath) {
            const client = getOrCreateIpcClient(cfg.socketPath);
            const ready = await client.waitForReady();
            if (!ready) {
              throw new Error("IPC not ready");
            }
            client.sendTaskMessage(promptTask.prompt);
            results.push(`Sent to ${connection.name} (background)`);
          } else if (
            cfg.extension === "claude-code" ||
            cfg.extension === "codex" ||
            cfg.extension === "kilo-code"
          ) {
            const port = getCdpPort();
            if (!port) {
              throw new Error("CDP port not available");
            }
            const cdpResult = await sendViaAgentCdp(port, promptTask.prompt, {
              agent: cfg.extension,
              windowTitle: cfg.windowTitle,
            });
            if (!cdpResult.success) {
              throw new Error(cdpResult.error || "CDP failed");
            }
            results.push(`Sent to ${connection.name} (${cfg.extension} CDP)`);
          } else {
            throw new Error("No background method available");
          }
        } catch (err) {
          results.push(`Failed: ${connection.name} - ${err}`);
          if (!continueOnError) {
            break;
          }
        }
      }

      return textResult(results.join("\n"));
    }

    case "list_scripts": {
      return textResult(JSON.stringify(scriptManager.listScripts(), null, 2));
    }

    case "run_script": {
      const scriptId = args.scriptId as string;
      const script = scriptManager.findByIdOrName(scriptId);
      if (!script) {
        return textResult(`Script not found: ${scriptId}`, true);
      }
      const started = scriptManager.runScript(script.id);
      return textResult(
        started ? `Started: ${script.name}` : `Failed to start: ${script.name}`,
        !started
      );
    }

    case "stop_script": {
      const scriptId = args.scriptId as string;
      const script = scriptManager.findByIdOrName(scriptId);
      if (!script) {
        return textResult(`Script not found: ${scriptId}`, true);
      }
      const stopped = scriptManager.stopScript(script.id);
      return textResult(
        stopped ? `Stopped: ${script.name}` : `Failed to stop: ${script.name}`,
        !stopped
      );
    }

    case "apply_layout": {
      const slotKey = args.slot as string;
      const slot = resolveLayoutSlot(slotKey);
      if (!slot) {
        const available = layoutManager
          .listSlots()
          .map((item) => `${item.letter}: ${item.name}`)
          .join(", ");
        return textResult(`Slot "${slotKey}" not found. Available: ${available}`, true);
      }
      const target: LayoutTarget = {
        windowTitle:
          typeof args.windowTitle === "string" ? args.windowTitle.trim() || undefined : undefined,
        windowHandle: parseWindowHandle(args.windowHandle),
      };

      logToolEvent("apply_layout request", {
        slot: slot.letter,
        slotName: slot.name,
        target,
      });

      const result = await layoutManager.applySlot(slot.id, target);
      logToolEvent("apply_layout result", {
        slot: slot.letter,
        slotName: slot.name,
        success: result.success,
        error: result.error,
        logPath: result.logPath,
        target,
      });

      return textResult(
        JSON.stringify(
          {
            success: result.success,
            slot: { id: slot.id, letter: slot.letter, name: slot.name },
            target,
            logPath: result.logPath,
            error: result.error,
            exitCode: result.exitCode ?? null,
          },
          null,
          2
        ),
        !result.success
      );
    }

    case "list_layout_slots": {
      return textResult(JSON.stringify(layoutManager.listSlots(), null, 2));
    }

    case "spawn_and_layout": {
      const resolved = resolveSpawnInput(args);
      if ("error" in resolved) {
        return textResult(resolved.error, true);
      }

      const slotKey = args.slot as string;
      const slot = resolveLayoutSlot(slotKey);
      if (!slot) {
        const available = layoutManager
          .listSlots()
          .map((item) => `${item.letter}: ${item.name}`)
          .join(", ");
        return textResult(`Slot "${slotKey}" not found. Available: ${available}`, true);
      }

      if (resolved.desktop) {
        const desktopResult = await switchToVirtualDesktop(resolved.desktop);
        logToolEvent("spawn_and_layout desktop switch", {
          requestedFolderPath: resolved.folderPath,
          requestedDesktop: resolved.desktop,
          success: desktopResult.success,
          error: desktopResult.error,
        });

        if (!desktopResult.success) {
          return textResult(
            JSON.stringify(
              {
                success: false,
                stage: "switch_desktop",
                requestedFolderPath: resolved.folderPath,
                requestedWindowName: resolved.windowName ?? null,
                requestedDesktop: resolved.desktop,
                slot: { id: slot.id, letter: slot.letter, name: slot.name },
                error: desktopResult.error,
              },
              null,
              2
            ),
            true
          );
        }
      }

      const baselineWindows = await detectWindows();
      const titleHints = buildSpawnTitleHints({
        folderPath: resolved.folderPath,
        windowName: resolved.windowName,
      });

      logToolEvent("spawn_and_layout baseline", {
        requestedTarget: typeof args.target === "string" ? args.target : null,
        requestedFolderPath: resolved.folderPath,
        requestedWindowName: resolved.windowName ?? null,
        requestedDesktop: resolved.desktop ?? null,
        slot: slot.letter,
        slotName: slot.name,
        titleHints,
        baselineHandles: baselineWindows.map(formatWindowSummary),
      });

      const spawnResult = await spawnWindow(resolved.folderPath, resolved.windowName);
      if (!spawnResult.success) {
        logToolEvent("spawn_and_layout spawn failed", {
          requestedFolderPath: resolved.folderPath,
          requestedDesktop: resolved.desktop ?? null,
          slot: slot.letter,
          message: spawnResult.message,
        });
        return textResult(
          JSON.stringify(
            {
              success: false,
              stage: "spawn",
              requestedFolderPath: resolved.folderPath,
              requestedWindowName: resolved.windowName ?? null,
              requestedDesktop: resolved.desktop ?? null,
              slot: { id: slot.id, letter: slot.letter, name: slot.name },
              error: spawnResult.message,
            },
            null,
            2
          ),
          true
        );
      }

      const selection = await waitForSpawnedWindow(baselineWindows, titleHints);
      logToolEvent("spawn_and_layout window selection", {
        requestedFolderPath: resolved.folderPath,
        requestedDesktop: resolved.desktop ?? null,
        slot: slot.letter,
        reason: selection.reason,
        candidateHandles: selection.newCandidates.map(formatWindowSummary),
        finalHandles: selection.finalWindows.map(formatWindowSummary),
        matchedWindow: selection.matchedWindow
          ? formatWindowSummary(selection.matchedWindow)
          : null,
      });

      if (!selection.matchedWindow) {
        return textResult(
          JSON.stringify(
            {
              success: false,
              stage: "select_window",
              requestedFolderPath: resolved.folderPath,
              requestedWindowName: resolved.windowName ?? null,
              requestedDesktop: resolved.desktop ?? null,
              slot: { id: slot.id, letter: slot.letter, name: slot.name },
              titleHints,
              baselineHandles: baselineWindows.map(formatWindowSummary),
              candidateHandles: selection.newCandidates.map(formatWindowSummary),
              finalHandles: selection.finalWindows.map(formatWindowSummary),
              error: `Unable to isolate a unique spawned VS Code window: ${selection.reason}`,
            },
            null,
            2
          ),
          true
        );
      }

      const target: LayoutTarget = {
        windowHandle: selection.matchedWindow.handle,
        windowTitle: selection.matchedWindow.title,
      };
      const layoutResult = await layoutManager.applySlot(slot.id, target);

      logToolEvent("spawn_and_layout layout result", {
        requestedFolderPath: resolved.folderPath,
        requestedDesktop: resolved.desktop ?? null,
        slot: slot.letter,
        target,
        success: layoutResult.success,
        error: layoutResult.error,
        logPath: layoutResult.logPath,
      });

      return textResult(
        JSON.stringify(
          {
            success: layoutResult.success,
            requestedFolderPath: resolved.folderPath,
            requestedWindowName: resolved.windowName ?? null,
            requestedDesktop: resolved.desktop ?? null,
            spawnTargetLabel: resolved.label,
            slot: { id: slot.id, letter: slot.letter, name: slot.name },
            titleHints,
            baselineHandles: baselineWindows.map(formatWindowSummary),
            candidateHandles: selection.newCandidates.map(formatWindowSummary),
            finalHandles: selection.finalWindows.map(formatWindowSummary),
            matchedWindow: selection.matchedWindow,
            selectionReason: selection.reason,
            logPath: layoutResult.logPath,
            exitCode: layoutResult.exitCode ?? null,
            error: layoutResult.error,
          },
          null,
          2
        ),
        !layoutResult.success
      );
    }

    case "detect_windows": {
      return textResult(JSON.stringify(await detectWindows(), null, 2));
    }

    case "check_cdp": {
      const port = getCdpPort();
      if (!port) {
        return textResult(
          JSON.stringify(
            { available: false, reason: "DevToolsActivePort not found" },
            null,
            2
          ),
          true
        );
      }
      const available = await isCdpAvailable(port);
      return textResult(
        JSON.stringify(
          {
            available,
            port,
            claudeCodeWebview: available,
            reason: available
              ? "Claude Code webview found"
              : "Claude Code webview not found among CDP targets",
          },
          null,
          2
        ),
        !available
      );
    }

    default: {
      const generatedTool = scriptManager.findGeneratedMcpTool(toolName);
      if (generatedTool) {
        const result = await scriptManager.runGeneratedMcpTool(toolName);
        return textResult(JSON.stringify(result, null, 2), !result.success);
      }
      return textResult(`Unknown tool: ${toolName}`, true);
    }
  }
}

export async function runMCPTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const result = await callTool(toolName, args);
  return result.content[0]?.text || "No result";
}

console.log("Reprompty MCP server loaded");
console.log("Available tools:", getTools().map((tool) => tool.name).join(", "));
