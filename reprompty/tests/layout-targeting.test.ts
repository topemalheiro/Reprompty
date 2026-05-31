import { describe, expect, it } from "bun:test";
import * as path from "node:path";

import { buildLayoutRunLogPath } from "../src/core/layout-manager.ts";
import {
  buildSpawnTitleHints,
  findNewWindowCandidates,
  selectUniqueWindowByTitle,
} from "../src/mcp/window-targeting.ts";
import type { DetectedWindow } from "../src/platform/windows.ts";

function makeWindow(
  overrides: Partial<DetectedWindow> & Pick<DetectedWindow, "handle" | "title">
): DetectedWindow {
  return {
    pid: overrides.pid ?? overrides.handle,
    handle: overrides.handle,
    title: overrides.title,
    folderPath: overrides.folderPath ?? "",
    processName: overrides.processName ?? "Code.real",
    extension: overrides.extension ?? "claude-code",
    pipePath: overrides.pipePath ?? null,
    sendMethod: overrides.sendMethod ?? "background",
  };
}

describe("layout run log helpers", () => {
  it("creates timestamped log file names in the provided directory", () => {
    const logPath = buildLayoutRunLogPath(
      "C:\\Users\\topem\\AppData\\Local\\VSCodeSidePanelLayout",
      new Date("2026-04-09T10:11:12.345Z"),
      "abc12345"
    );

    expect(path.basename(logPath)).toBe(
      "layout-run-2026-04-09_10-11-12-345-abc12345.log"
    );
  });
});

describe("window targeting helpers", () => {
  it("builds title hints from the saved window name and folder name", () => {
    expect(
      buildSpawnTitleHints({
        folderPath: "C:\\Users\\topem\\source\\repos\\Aperant-MCP",
        windowName: "Aperant MCP",
      })
    ).toEqual(["Aperant MCP", "Aperant-MCP"]);
  });

  it("finds only window handles that were not present before spawn", () => {
    const baseline = [
      makeWindow({ handle: 1001, title: "Repo A - Visual Studio Code" }),
      makeWindow({ handle: 1002, title: "Repo B - Visual Studio Code" }),
    ];
    const current = [
      ...baseline,
      makeWindow({ handle: 1003, title: "Aperant-MCP - Visual Studio Code" }),
    ];

    expect(findNewWindowCandidates(baseline, current).map((window) => window.handle)).toEqual([
      1003,
    ]);
  });

  it("prefers a unique exact title match before substring matching", () => {
    const windows = [
      makeWindow({ handle: 2001, title: "Welcome - Aperant-MCP - Visual Studio Code" }),
      makeWindow({ handle: 2002, title: "Aperant-MCP - Visual Studio Code" }),
    ];

    const selection = selectUniqueWindowByTitle(windows, [
      "Aperant-MCP - Visual Studio Code",
      "Aperant-MCP",
    ]);

    expect(selection.match?.handle).toBe(2002);
    expect(selection.reason).toContain("exact");
  });

  it("fails safely when a substring hint matches multiple windows", () => {
    const windows = [
      makeWindow({ handle: 3001, title: "Aperant-MCP - Visual Studio Code" }),
      makeWindow({ handle: 3002, title: "Welcome - Aperant-MCP - Visual Studio Code" }),
    ];

    const selection = selectUniqueWindowByTitle(windows, ["Aperant-MCP"]);

    expect(selection.match).toBeNull();
    expect(selection.reason).toContain("ambiguous");
  });
});
