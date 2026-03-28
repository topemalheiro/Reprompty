#!/usr/bin/env node
/**
 * Reprompty MCP Server - Standalone stdio transport
 *
 * Run: npx tsx src/mcp/server.ts
 * Register: claude mcp add reprompty -- npx tsx path/to/server.ts
 */

import { tools, callTool } from "./index.js";

// ============================================================================
// Stdio MCP Server (JSON-RPC over stdin/stdout)
// ============================================================================

const JSONRPC_VERSION = "2.0";
const PROTOCOL_VERSION = "2024-11-05";

let buffer = "";

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
      handleMessage(msg).catch((err) => {
        sendError(msg.id, -32603, String(err));
      });
    } catch {
      // Ignore malformed JSON
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
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
          version: "0.2.0",
        },
      });
      break;

    case "notifications/initialized":
      // Client acknowledged init - no response needed
      break;

    case "tools/list":
      sendResult(id!, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
      break;

    case "tools/call": {
      const toolName = params?.name as string;
      const toolArgs = (params?.arguments || {}) as Record<string, unknown>;

      try {
        const result = await callTool(toolName, toolArgs);
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

// Log to stderr (not stdout which is for JSON-RPC)
console.log = (...args: unknown[]) => {
  process.stderr.write(args.map(String).join(" ") + "\n");
};
console.error = console.log;
console.warn = console.log;

console.log("[Reprompty MCP] Server started on stdio");
console.log("[Reprompty MCP] Tools:", tools.map((t) => t.name).join(", "));
