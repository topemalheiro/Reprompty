import { describe, expect, it } from "bun:test";
import {
  buildKiloPipeCandidates,
  fallbackProcessNameFromTitle,
  isSupportedEditorProcessName,
  normalizeEditorProcessName,
  resolveDetectedWindowProcessName,
  resolveBackgroundRoute,
} from "../src/platform/linux.ts";

describe("linux detection helpers", () => {
  it("normalizes editor process names with optional exe suffixes", () => {
    expect(normalizeEditorProcessName("code.exe")).toBe("code");
    expect(normalizeEditorProcessName("code-oss.exe")).toBe("code-oss");
    expect(normalizeEditorProcessName(" vscodium ")).toBe("vscodium");
    expect(normalizeEditorProcessName("codium")).toBe("codium");
    expect(normalizeEditorProcessName("kilocode")).toBe("kilocode");
  });

  it("accepts Code, Code:-OSS, VSCodium, codium, and kilocode as supported editor processes", () => {
    expect(isSupportedEditorProcessName("code")).toBe(true);
    expect(isSupportedEditorProcessName("code-oss")).toBe(true);
    expect(isSupportedEditorProcessName("vscodium")).toBe(true);
    expect(isSupportedEditorProcessName("codium")).toBe(true);
    expect(isSupportedEditorProcessName("kilocode")).toBe(true);
    expect(isSupportedEditorProcessName("code.exe")).toBe(true);
    expect(isSupportedEditorProcessName("cursor")).toBe(false);
    expect(isSupportedEditorProcessName("nvim")).toBe(false);
  });

  it("falls back to title-derived process names only when process lookup is missing", () => {
    expect(resolveDetectedWindowProcessName("code-oss", "repo - Visual Studio Code")).toBe("code-oss");
    expect(resolveDetectedWindowProcessName("", "repo - Visual Studio Code")).toBe("code");
    expect(resolveDetectedWindowProcessName(undefined, "repo - Kilo Code")).toBe("kilocode");
    expect(fallbackProcessNameFromTitle("repo - VSCodium")).toBe("code");
    expect(fallbackProcessNameFromTitle("repo - Kilo Code")).toBe("kilocode");
  });

  it("builds pipe candidates for kilo and legacy roo naming on Linux", () => {
    const candidates = buildKiloPipeCandidates(1234);
    expect(candidates.length).toBe(3);
    expect(candidates[0]).toMatch(/kilo-ipc-1234\.sock$/);
    expect(candidates[1]).toMatch(/kilo-code-1234\.sock$/);
    expect(candidates[2]).toMatch(/roo-code-1234\.sock$/);
  });

  it("resolves background route from the active agent instead of raw CDP availability", () => {
    expect(resolveBackgroundRoute("kilo-code", ["kilo-code"], true)).toBe("ipc-kilo");
    expect(resolveBackgroundRoute("kilo-code", ["kilo-code"], false)).toBe("cdp-kilo");
    expect(resolveBackgroundRoute("codex", ["codex"], false)).toBe("cdp-codex");
    expect(resolveBackgroundRoute("claude-code", ["claude-code"], false)).toBe("cdp-claude");
  });

  it("defaults unknown agent to cdp-kilo when Kilo Code: is available", () => {
    expect(resolveBackgroundRoute("unknown", ["kilo-code"], false)).toBe("cdp-kilo");
    expect(resolveBackgroundRoute("unknown", ["codex"], false)).toBe("cdp-codex");
    expect(resolveBackgroundRoute("unknown", ["kilo-code", "codex"], false)).toBe("cdp-kilo");
  });

  it("falls back to foreground when no agent is available", () => {
    expect(resolveBackgroundRoute("unknown", [], false)).toBe("foreground");
    expect(resolveBackgroundRoute("unknown", [], true)).toBe("foreground");
  });
});
