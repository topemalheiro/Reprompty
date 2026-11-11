import { describe, expect, it } from "vitest";

import {
  EDITOR_TITLE_SUFFIXES,
  isEditorWindowTitle,
  stripEditorSuffix,
  workspaceNameFromTitle,
} from "../src/core/editor-titles.ts";

describe("isEditorWindowTitle", () => {
  it("detects every supported editor", () => {
    expect(isEditorWindowTitle("main.ts - repo - Visual Studio Code")).toBe(true);
    expect(isEditorWindowTitle("repo - Visual Studio Code - Insiders")).toBe(true);
    expect(isEditorWindowTitle("repo - Code - OSS")).toBe(true);
    expect(isEditorWindowTitle("repo - VSCodium")).toBe(true);
    expect(isEditorWindowTitle("repo - Kilo Code")).toBe(true);
    expect(isEditorWindowTitle("repo - Kimi Code")).toBe(true);
  });

  it("ignores other windows", () => {
    expect(isEditorWindowTitle("Mozilla Firefox")).toBe(false);
    expect(isEditorWindowTitle("~ : fish — Konsole")).toBe(false);
  });

  it("has no colon in any editor name", () => {
    expect(EDITOR_TITLE_SUFFIXES.filter((suffix) => suffix.includes(":"))).toEqual([]);
  });
});

describe("stripEditorSuffix", () => {
  it("removes the editor name and anything after it", () => {
    expect(stripEditorSuffix("main.ts - repo - Visual Studio Code")).toBe("main.ts - repo");
    expect(stripEditorSuffix("repo - Visual Studio Code [Administrator]")).toBe("repo");
    expect(stripEditorSuffix("repo - Visual Studio Code - Insiders")).toBe("repo");
    expect(stripEditorSuffix("a - repo - Code - OSS")).toBe("a - repo");
    expect(stripEditorSuffix("Mozilla Firefox")).toBe("Mozilla Firefox");
  });

  it("keeps a folder named like an editor", () => {
    const title = "main.ts - Kimi Code - Visual Studio Code";
    expect(stripEditorSuffix(title)).toBe("main.ts - Kimi Code");
    expect(workspaceNameFromTitle(title)).toBe("Kimi Code");
  });
});

describe("workspaceNameFromTitle", () => {
  it("takes the last segment before the editor name", () => {
    expect(workspaceNameFromTitle("main.ts - KDE-Plasma-on-Wayland - Visual Studio Code")).toBe(
      "KDE-Plasma-on-Wayland"
    );
    expect(workspaceNameFromTitle("a - repo - Code - OSS")).toBe("repo");
    expect(workspaceNameFromTitle("Spite 3 (Workspace) - Visual Studio Code")).toBe(
      "Spite 3 (Workspace)"
    );
    expect(workspaceNameFromTitle("repo - VSCodium")).toBe("repo");
  });

  it("handles Insiders and an elevated window", () => {
    expect(workspaceNameFromTitle("a.ts - my-app - Visual Studio Code - Insiders")).toBe("my-app");
    expect(workspaceNameFromTitle("my-app - Visual Studio Code [Administrator]")).toBe("my-app");
  });

  it("drops the unsaved-changes marker", () => {
    expect(workspaceNameFromTitle("● repo - Visual Studio Code")).toBe("repo");
    expect(workspaceNameFromTitle("● main.ts - repo - Visual Studio Code")).toBe("repo");
  });

  it("returns null when nothing is left", () => {
    expect(workspaceNameFromTitle("Visual Studio Code")).toBeNull();
    expect(workspaceNameFromTitle(" - Code - OSS")).toBeNull();
    expect(workspaceNameFromTitle("● - Visual Studio Code")).toBeNull();
    expect(workspaceNameFromTitle("")).toBeNull();
  });
});
