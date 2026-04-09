import {
  connectionManager,
  type ConnectionType,
  type ConnectionConfig,
  type VSCodeWindowConfig,
} from "../core/connection-manager.js";
import { getOrCreateIpcClient } from "../core/ipc-client.js";
import { scriptManager } from "../core/script-manager.js";
import { layoutManager } from "../core/layout-manager.js";
import { spawnTargetManager } from "../core/spawn-target-manager.js";
import { spawnWindow, detectWindows, getCdpPort } from "../platform/windows.js";
import { sendViaCdp, isCdpAvailable } from "../core/cdp-client.js";

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
          description: "Optional: target a specific window by title substring",
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
  | { folderPath: string; windowName?: string; label: string }
  | { error: string } {
  const target = typeof args.target === "string" ? args.target.trim() : "";
  const explicitFolderPath =
    typeof args.folderPath === "string" ? args.folderPath.trim() : "";
  const explicitWindowName =
    typeof args.windowName === "string" ? args.windowName.trim() : "";

  if (target) {
    const savedTarget = spawnTargetManager.getTarget(target);
    if (!savedTarget) {
      return { error: `Spawn target "${target}" not found` };
    }
    return {
      folderPath: savedTarget.folderPath,
      windowName: explicitWindowName || savedTarget.windowName,
      label: `${savedTarget.label} (${savedTarget.id})`,
    };
  }

  if (!explicitFolderPath) {
    return { error: 'Provide either "target" or "folderPath"' };
  }

  return {
    folderPath: explicitFolderPath,
    windowName: explicitWindowName || undefined,
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
      const result = await spawnWindow(resolved.folderPath, resolved.windowName);
      return textResult(JSON.stringify(result, null, 2), !result.success);
    }

    case "list_spawn_targets": {
      return textResult(JSON.stringify(spawnTargetManager.listTargets(), null, 2));
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

      if (cfg.extension === "claude-code") {
        const port = getCdpPort();
        if (port) {
          const result = await sendViaCdp(port, prompt);
          if (result.success) {
            connectionManager.updateConnectionStatus(connection.id, "active");
            return textResult(`Sent to ${connection.name} via CDP (background)`);
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
          } else if (cfg.extension === "claude-code") {
            const port = getCdpPort();
            if (!port) {
              throw new Error("CDP port not available");
            }
            const cdpResult = await sendViaCdp(port, promptTask.prompt);
            if (!cdpResult.success) {
              throw new Error(cdpResult.error || "CDP failed");
            }
            results.push(`Sent to ${connection.name} (CDP)`);
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
      const winTitle = args.windowTitle as string | undefined;
      const result = await layoutManager.applySlot(slot.id, winTitle);
      return textResult(
        result.success
          ? `Applied layout slot ${slot.letter}: ${slot.name}`
          : `Failed: ${result.error}`,
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

      const spawnResult = await spawnWindow(resolved.folderPath, resolved.windowName);
      if (!spawnResult.success) {
        return textResult(`Failed to spawn: ${spawnResult.message}`, true);
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));

      const folderName =
        resolved.folderPath
          .replace(/\\/g, "/")
          .split("/")
          .filter(Boolean)
          .pop() || "";
      const windowTitle = folderName;
      const layoutResult = await layoutManager.applySlot(slot.id, windowTitle);

      return textResult(
        layoutResult.success
          ? `Spawned ${resolved.label} and applied slot ${slot.letter}: ${slot.name}`
          : `Spawned ${resolved.label} but layout failed: ${layoutResult.error}`,
        !layoutResult.success
      );
    }

    case "detect_windows": {
      return textResult(JSON.stringify(detectWindows(), null, 2));
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
