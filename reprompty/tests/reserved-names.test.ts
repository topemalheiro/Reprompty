import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { RESERVED_MCP_TOOL_NAMES } from "../src/core/script-manager.ts";

// Read as text: importing src/mcp/index.ts would load every manager and platform module.
function builtInToolNames(): string[] {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "mcp", "index.ts"), "utf-8");
  const start = source.search(/const BUILT_IN_TOOLS\b[^=]*=\s*\[/);
  const end = source.indexOf("\n];", start);
  if (start < 0 || end < 0) throw new Error("BUILT_IN_TOOLS array not found in src/mcp/index.ts");
  const block = source.slice(start, end);
  return [...block.matchAll(/^\s*name:\s*["'`]([^"'`]+)["'`]/gm)].map((match) => match[1]);
}

describe("RESERVED_MCP_TOOL_NAMES", () => {
  it("reserves every built-in MCP tool name", () => {
    const names = builtInToolNames();
    expect(names.length).toBeGreaterThanOrEqual(26);

    const reserved: readonly string[] = RESERVED_MCP_TOOL_NAMES;
    expect(names.filter((name) => !reserved.includes(name))).toEqual([]);
  });
});
