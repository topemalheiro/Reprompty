import {
  connectionManager,
  ConnectionType,
  ConnectionConfig,
  VSCodeWindowConfig,
} from "../core/connection-manager.js";
import { getOrCreateIpcClient } from "../core/ipc-client.js";
import { spawnWindow, findWindowByTitle, listWindows, getCdpPort } from "../platform/windows.js";
import { sendViaCdp, isCdpAvailable } from "../core/cdp-client.js";
import { scriptManager } from "../core/script-manager.js";

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
    description: "Run the primary or secondary layout script for window positioning",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["primary", "secondary"], description: "Which layout to apply" },
      },
      required: ["role"],
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
      const role = args.role as "primary" | "secondary";
      const script = scriptManager.getLayoutScript(role);
      if (!script) {
        return { content: [{ type: "text", text: `No ${role} layout script configured` }] };
      }
      const started = scriptManager.runScript(script.id);
      return { content: [{ type: "text", text: started ? `Applied ${role} layout: ${script.name}` : `Failed to apply layout` }] };
    }

    case "detect_windows": {
      const windows = listWindows();
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
