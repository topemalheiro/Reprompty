import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  normalizeMcpToolName,
  parseScriptMcpActionsFromHeader,
} from "../src/core/script-manager.ts";
import { normalizeSpawnTargetId } from "../src/core/spawn-target-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempScript(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reprompty-script-test-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "layout.ps1");
  fs.writeFileSync(scriptPath, contents, "utf-8");
  return scriptPath;
}

describe("script MCP action helpers", () => {
  it("normalizes generated MCP tool names to snake case", () => {
    expect(normalizeMcpToolName("Top Monitors Layout")).toBe(
      "top_monitors_layout"
    );
    expect(normalizeMcpToolName("dual-monitor-layout")).toBe(
      "dual_monitor_layout"
    );
  });

  it("parses reprompty-mcp header metadata from script comments", () => {
    const scriptPath = makeTempScript(`
# reprompty-mcp: {"toolName":"dual_monitor_layout_bottom","label":"Dual monitor layout (bottom)","description":"Bottom layout","args":["-Once"]}
# reprompty-mcp: {"toolName":"top_monitors_layout_panel_full","label":"Top monitors layout (panel full)","description":"Top layout","args":["-SingleOnce"]}
param([switch]$Once, [switch]$SingleOnce)
`);

    const actions = parseScriptMcpActionsFromHeader(scriptPath);
    expect(actions).toHaveLength(2);
    expect(actions[0]?.toolName).toBe("dual_monitor_layout_bottom");
    expect(actions[0]?.args).toEqual(["-Once"]);
    expect(actions[1]?.toolName).toBe("top_monitors_layout_panel_full");
    expect(actions[1]?.args).toEqual(["-SingleOnce"]);
  });
});

describe("spawn target helpers", () => {
  it("normalizes target aliases for MCP-friendly target names", () => {
    expect(normalizeSpawnTargetId("Windows Project")).toBe("windows-project");
    expect(normalizeSpawnTargetId("  Repo / AI Window  ")).toBe("repo-ai-window");
  });
});
