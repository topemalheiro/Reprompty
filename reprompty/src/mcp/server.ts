#!/usr/bin/env node
/**
 * Reprompty MCP Server - Standalone stdio transport
 *
 * Build: npm run build:mcp
 * Run: node dist/mcp/server.js
 */

import "./stdio-guard.js";

// Some MCP clients (e.g. Kimi Code CLI) spawn the server with a sanitized
// environment that strips graphical session variables. Restore them before
// any platform code runs.
import { ensureLinuxSessionEnv } from "../platform/linux.js";
ensureLinuxSessionEnv();

import { getTools, callTool } from "./index.js";
import { appVersion } from "../core/resources.js";
import {
  getCurrentDesktopUuid,
  setCurrentDesktopUuid,
} from "../core/virtual-desktop-manager-linux.js";

// Agents must never move the user to another virtual desktop, whatever a tool runs.
async function callToolOnSameDesktop(
  toolName: string,
  args: Record<string, unknown>
): ReturnType<typeof callTool> {
  const desktop = process.platform === "linux" ? getCurrentDesktopUuid() : null;
  try {
    return await callTool(toolName, args);
  } finally {
    if (desktop && getCurrentDesktopUuid() !== desktop) {
      try {
        setCurrentDesktopUuid(desktop);
        console.error(`[Reprompty MCP] ${toolName} changed the virtual desktop; switched back`);
      } catch (err) {
        console.error(`[Reprompty MCP] Could not switch back after ${toolName}:`, err);
      }
    }
  }
}

// ============================================================================
// Stdio MCP Server (JSON-RPC over stdin/stdout)
// ============================================================================

const JSONRPC_VERSION = "2.0";
const PROTOCOL_VERSION = "2024-11-05";

let buffer = "";
let pendingRequests = 0;
let stdinEnded = false;

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;

  // Process complete JSON-RPC messages (newline-delimited)
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      pendingRequests++;
      handleMessage(msg)
        .catch((err) => {
          sendError(msg.id, -32603, String(err));
        })
        .finally(() => {
          pendingRequests--;
          if (stdinEnded && pendingRequests === 0) {
            process.exit(0);
          }
        });
    } catch {
      // Ignore malformed JSON
    }
  }
});

process.stdin.on("end", () => {
  stdinEnded = true;
  if (pendingRequests === 0) {
    process.exit(0);
  }
  // Otherwise wait for in-flight requests to finish before exiting.
});

function send(msg: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id: string | number, result: unknown) {
  send({ jsonrpc: JSONRPC_VERSION, id, result });
}

function sendError(id: string | number | null, code: number, message: string) {
  send({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } });
}

async function handleMessage(msg: { id?: string | number; method?: string; params?: Record<string, unknown> }) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      sendResult(id!, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "reprompty",
          version: appVersion(),
        },
      });
      break;

    case "notifications/initialized":
      // Client acknowledged init - no response needed
      break;

    case "tools/list":
      {
      const tools = getTools();
      sendResult(id!, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
      }
      break;

    case "tools/call": {
      const toolName = params?.name as string;
      const toolArgs = (params?.arguments || {}) as Record<string, unknown>;

      try {
        const result = await callToolOnSameDesktop(toolName, toolArgs);
        sendResult(id!, result);
      } catch (err) {
        sendResult(id!, {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        });
      }
      break;
    }

    case "ping":
      sendResult(id!, {});
      break;

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

console.log("[Reprompty MCP] Server started on stdio");
console.log("[Reprompty MCP] Tools:", getTools().map((t) => t.name).join(", "));
