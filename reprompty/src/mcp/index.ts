import {
  connectionManager,
  ConnectionType,
  ConnectionConfig,
  VSCodeWindowConfig,
} from "../core/connection-manager.js";
import { getOrCreateIpcClient } from "../core/ipc-client.js";
import { spawnWindow, findWindowByTitle, detectWindows, getCdpPort } from "../platform/windows.js";
import { sendViaCdp, isCdpAvailable } from "../core/cdp-client.js";
import { scriptManager } from "../core/script-manager.js";
import { layoutManager } from "../core/layout-manager.js";

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

// MCP Tools
export const tools: MCPTool[] = [
  {
    name: "spawn_window",
    description: "Spawn a new VS Code window with a project folder",
    inputSchema: {
      type: "object",
      properties: {
        folderPath: { type: "string", description: "Path to the project folder" },
        windowName: { type: "string", description: "Optional name for the window" },
      },
      required: ["folderPath"],
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
        waitForResponse: { type: "boolean", description: "Wait for response (not implemented yet)" },
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
          description: "Type of connection" 
        },
        name: { type: "string", description: "Name for this connection" },
        config: { 
          type: "object", 
          description: "Connection configuration",
          properties: {
            socketPath: { type: "string", description: "IPC socket path" },
            windowTitle: { type: "string", description: "Window title to find" },
            method: { type: "string", enum: ["foreground", "background"], description: "Send method" },
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
    description: "Apply a layout slot to position/resize the active VS Code window. Use slot letter (A, B) or slot name.",
    inputSchema: {
      type: "object",
      properties: {
        slot: { type: "string", description: "Slot letter (A, B) or slot name (e.g. 'Dual Bottom')" },
        windowTitle: { type: "string", description: "Optional: target a specific window by title substring" },
      },
      required: ["slot"],
    },
  },
  {
    name: "list_layout_slots",
    description: "List all available layout slots with their configurations (position, size, hotkey)",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "spawn_and_layout",
    description: "Spawn a new VS Code window for a project folder and apply a layout slot to position it",
    inputSchema: {
      type: "object",
      properties: {
        folderPath: { type: "string", description: "Path to the project folder" },
        slot: { type: "string", description: "Layout slot letter (A, B) or name to apply after spawning" },
      },
      required: ["folderPath", "slot"],
    },
  },
  {
    name: "detect_windows",
    description: "Auto-detect all VS Code and Kilo Code windows with their PIDs, titles, and IPC pipe availability",
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

// Tool implementations
export async function callTool(
  toolName: string, 
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (toolName) {
    case "spawn_window": {
      const folderPath = args.folderPath as string;
      const windowName = args.windowName as string | undefined;
      const result = await spawnWindow(folderPath, windowName);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    case "send_prompt": {
      const connectionId = args.connectionId as string;
      const prompt = args.prompt as string;

      // Allow lookup by name or ID
      const connection =
        connectionManager.getConnection(connectionId) ||
        connectionManager.getConnectionByName(connectionId);
      if (!connection) {
        return { content: [{ type: "text", text: `Error: Connection "${connectionId}" not found` }] };
      }

      const cfg = connection.config as VSCodeWindowConfig;

      // Background IPC pipe (Kilo Code)
      if (cfg.method === "background" && cfg.socketPath) {
        try {
          const client = getOrCreateIpcClient(cfg.socketPath);
          const ready = await client.waitForReady();
          if (!ready) {
            connectionManager.updateConnectionStatus(connection.id, "error");
            return { content: [{ type: "text", text: `Error: IPC not ready for ${connection.name} (timeout)` }] };
          }
          client.sendTaskMessage(prompt);
          connectionManager.updateConnectionStatus(connection.id, "active");
          return { content: [{ type: "text", text: `Sent to ${connection.name} via background IPC` }] };
        } catch (err) {
          connectionManager.updateConnectionStatus(connection.id, "error");
          return { content: [{ type: "text", text: `Error sending to ${connection.name}: ${err}` }] };
        }
      }

      // CDP background (Claude Code)
      if (cfg.extension === "claude-code") {
        const port = getCdpPort();
        if (port) {
          const result = await sendViaCdp(port, prompt);
          if (result.success) {
            connectionManager.updateConnectionStatus(connection.id, "active");
            return { content: [{ type: "text", text: `Sent to ${connection.name} via CDP (background)` }] };
          }
          // CDP failed, fall through to foreground
        }
      }

      return { content: [{ type: "text", text: `No background method available for ${connection.name}. Use foreground from Reprompty UI.` }] };
    }

    case "add_connection": {
      const type = args.type as ConnectionType;
      const name = args.name as string;
      const config = args.config as ConnectionConfig;
      
      const connection = connectionManager.addConnection(type, name, config);
      return { content: [{ type: "text", text: `Added connection: ${connection.id} (${connection.name})` }] };
    }

    case "list_connections": {
      const connections = connectionManager.listConnections();
      return { content: [{ type: "text", text: JSON.stringify(connections, null, 2) }] };
    }

    case "remove_connection": {
      const connectionId = args.connectionId as string;
      const removed = connectionManager.removeConnection(connectionId);
      return { content: [{ type: "text", text: removed ? `Removed connection ${connectionId}` : `Connection ${connectionId} not found` }] };
    }

    case "daisy_chain": {
      const prompts = args.prompts as Array<{ connectionId: string; prompt: string }>;
      const continueOnError = (args.continueOnError as boolean) || false;

      const results: string[] = [];

      for (const p of prompts) {
        const connection =
          connectionManager.getConnection(p.connectionId) ||
          connectionManager.getConnectionByName(p.connectionId);
        if (!connection) {
          results.push(`Connection "${p.connectionId}" not found`);
          if (!continueOnError) break;
          continue;
        }

        const cfg = connection.config as VSCodeWindowConfig;
        try {
          if (cfg.method === "background" && cfg.socketPath) {
            const client = getOrCreateIpcClient(cfg.socketPath);
            const ready = await client.waitForReady();
            if (!ready) throw new Error("IPC not ready");
            client.sendTaskMessage(p.prompt);
            results.push(`Sent to ${connection.name} (background)`);
          } else if (cfg.extension === "claude-code") {
            const port = getCdpPort();
            if (port) {
              const cdpResult = await sendViaCdp(port, p.prompt);
              if (cdpResult.success) {
                results.push(`Sent to ${connection.name} (CDP)`);
              } else {
                throw new Error(cdpResult.error || "CDP failed");
              }
            } else {
              throw new Error("CDP port not available");
            }
          } else {
            throw new Error("No background method available");
          }
        } catch (err) {
          results.push(`Failed: ${connection.name} - ${err}`);
          if (!continueOnError) break;
        }
      }

      return { content: [{ type: "text", text: results.join("\n") }] };
    }

    case "list_scripts": {
      const scripts = scriptManager.listScripts();
      return { content: [{ type: "text", text: JSON.stringify(scripts, null, 2) }] };
    }

    case "run_script": {
      const scriptId = args.scriptId as string;
      const script = scriptManager.findByIdOrName(scriptId);
      if (!script) {
        return { content: [{ type: "text", text: `Script not found: ${scriptId}` }] };
      }
      const started = scriptManager.runScript(script.id);
      return { content: [{ type: "text", text: started ? `Started: ${script.name}` : `Failed to start: ${script.name}` }] };
    }

    case "stop_script": {
      const scriptId = args.scriptId as string;
      const script = scriptManager.findByIdOrName(scriptId);
      if (!script) {
        return { content: [{ type: "text", text: `Script not found: ${scriptId}` }] };
      }
      const stopped = scriptManager.stopScript(script.id);
      return { content: [{ type: "text", text: stopped ? `Stopped: ${script.name}` : `Failed to stop: ${script.name}` }] };
    }

    case "apply_layout": {
      const slotKey = args.slot as string;
      // Try by letter first, then by name
      const slot = layoutManager.getSlotByLetter(slotKey) ??
        layoutManager.listSlots().find((s) => s.name.toLowerCase() === slotKey.toLowerCase());
      if (!slot) {
        const available = layoutManager.listSlots().map((s) => `${s.letter}: ${s.name}`).join(", ");
        return { content: [{ type: "text", text: `Slot "${slotKey}" not found. Available: ${available}` }] };
      }
      const winTitle = args.windowTitle as string | undefined;
      const result = await layoutManager.applySlot(slot.id, winTitle);
      return { content: [{ type: "text", text: result.success ? `Applied layout slot ${slot.letter}: ${slot.name}` : `Failed: ${result.error}` }] };
    }

    case "list_layout_slots": {
      const slots = layoutManager.listSlots();
      return { content: [{ type: "text", text: JSON.stringify(slots, null, 2) }] };
    }

    case "spawn_and_layout": {
      const folderPath = args.folderPath as string;
      const slotKey = args.slot as string;

      const slot = layoutManager.getSlotByLetter(slotKey) ??
        layoutManager.listSlots().find((s) => s.name.toLowerCase() === slotKey.toLowerCase());
      if (!slot) {
        const available = layoutManager.listSlots().map((s) => `${s.letter}: ${s.name}`).join(", ");
        return { content: [{ type: "text", text: `Slot "${slotKey}" not found. Available: ${available}` }] };
      }

      // Spawn the window
      const spawnResult = await spawnWindow(folderPath);
      if (!spawnResult.success) {
        return { content: [{ type: "text", text: `Failed to spawn: ${spawnResult.message}` }] };
      }

      // Wait for the window to initialize, then detect it by folder path
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Extract folder name from path to use as window title filter
      const folderName = folderPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";

      // Try to confirm the new window exists, but still fall back to the
      // folder name so layout targeting does not silently degrade if detection
      // is slow on a busy system.
      const windows = detectWindows();
      windows.find((w) =>
        w.title.toLowerCase().includes(folderName.toLowerCase()) &&
        w.title.includes("Visual Studio Code")
      );
      const windowTitle = folderName;

      const layoutResult = await layoutManager.applySlot(slot.id, windowTitle);
      return {
        content: [{
          type: "text",
          text: layoutResult.success
            ? `Spawned ${folderPath} and applied slot ${slot.letter}: ${slot.name}`
            : `Spawned ${folderPath} but layout failed: ${layoutResult.error}`,
        }],
      };
    }

    case "detect_windows": {
      const windows = detectWindows();
      return { content: [{ type: "text", text: JSON.stringify(windows, null, 2) }] };
    }

    case "check_cdp": {
      const port = getCdpPort();
      if (!port) {
        return { content: [{ type: "text", text: JSON.stringify({ available: false, reason: "DevToolsActivePort not found" }) }] };
      }
      const available = await isCdpAvailable(port);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            available,
            port,
            claudeCodeWebview: available,
            reason: available ? "Claude Code webview found" : "Claude Code webview not found among CDP targets",
          }, null, 2),
        }],
      };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${toolName}` }] };
  }
}

// Simple MCP server that can be invoked
export async function runMCPTool(
  toolName: string, 
  args: Record<string, unknown>
): Promise<string> {
  const result = await callTool(toolName, args);
  return result.content[0]?.text || "No result";
}

console.log("Reprompty MCP server loaded");
console.log("Available tools:", tools.map(t => t.name).join(", "));
