import { describe, expect, it } from "vitest";
import {
  buildKiloPipeCandidates,
  fallbackProcessNameFromTitle,
  isSupportedEditorProcessName,
  normalizeEditorProcessName,
  resolveDetectedWindowProcessName,
} from "../src/platform/windows.ts";

describe("windows detection helpers", () => {
  it("normalizes editor process names with optional exe suffixes", () => {
    expect(normalizeEditorProcessName("Code.exe")).toBe("code");
    expect(normalizeEditorProcessName("Code.real.exe")).toBe("code.real");
    expect(normalizeEditorProcessName(" kilocode ")).toBe("kilocode");
  });

  it("accepts Code, Code.real, kilocode, and kimi-code as supported editor processes", () => {
    expect(isSupportedEditorProcessName("Code")).toBe(true);
    expect(isSupportedEditorProcessName("Code.real")).toBe(true);
    expect(isSupportedEditorProcessName("Code.real.exe")).toBe(true);
    expect(isSupportedEditorProcessName("kilocode")).toBe(true);
    expect(isSupportedEditorProcessName("kimi-code")).toBe(true);
    expect(isSupportedEditorProcessName("cursor")).toBe(false);
  });

  it("falls back to title-derived process names only when process lookup is missing", () => {
    expect(resolveDetectedWindowProcessName("Code.real", "repo - Visual Studio Code")).toBe("Code.real");
    expect(resolveDetectedWindowProcessName("", "repo - Visual Studio Code")).toBe("Code");
    expect(resolveDetectedWindowProcessName(undefined, "repo - Kilo Code")).toBe("kilocode");
    expect(resolveDetectedWindowProcessName(undefined, "repo - Kimi Code")).toBe("kimi-code");
    expect(fallbackProcessNameFromTitle("repo - Kilo Code")).toBe("kilocode");
    expect(fallbackProcessNameFromTitle("repo - Kimi Code")).toBe("kimi-code");
  });

  it("builds pipe candidates for kilo and legacy roo naming", () => {
    expect(buildKiloPipeCandidates(1234)).toEqual([
      "\\\\.\\pipe\\kilo-ipc-1234",
      "\\\\.\\pipe\\kilo-code-1234",
      "\\\\.\\pipe\\roo-code-1234",
    ]);
  });
});
