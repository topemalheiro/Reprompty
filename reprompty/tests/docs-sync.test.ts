import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");
const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath));

const SKILL = "reprompty/resources/agent-guide.md";

// Parsed as text: importing src/mcp/index.ts would start the managers and write ~/.reprompty.
function builtInToolNames(source: string): string[] {
  const start = source.indexOf("const BUILT_IN_TOOLS");
  const end = source.indexOf("\n];", start);
  if (start < 0 || end < 0) throw new Error("BUILT_IN_TOOLS not found in src/mcp/index.ts");
  return Array.from(source.slice(start, end).matchAll(/\bname:\s*"([^"]+)"/g), (match) => match[1]);
}

describe("docs sync", () => {
  const skillText = read(SKILL).toString("utf-8");
  const toolNames = builtInToolNames(read("reprompty/src/mcp/index.ts").toString("utf-8"));

  it("gives the skill the name and description agents need to load it", () => {
    expect(skillText).toMatch(/^---\r?\nname: reprompty\r?\ndescription: \S.*\r?\n---\r?\n/);
  });

  it("reads the built-in tool names from src/mcp/index.ts", () => {
    expect(toolNames.length).toBeGreaterThanOrEqual(26);
    expect(new Set(toolNames).size).toBe(toolNames.length);
  });

  it("mentions every built-in tool in the skill", () => {
    const missing = toolNames.filter((name) => !new RegExp(`(?<!\\w)${name}(?!\\w)`).test(skillText));
    expect(missing).toEqual([]);
  });

  it("gives every built-in tool a heading in docs/mcp-tools.md", () => {
    const reference = read("docs/mcp-tools.md").toString("utf-8");
    const missing = toolNames.filter((name) => !new RegExp(`^### \`${name}\`\\s*$`, "m").test(reference));
    expect(missing).toEqual([]);
  });
});
