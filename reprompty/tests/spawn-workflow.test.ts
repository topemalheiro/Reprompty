import { describe, expect, it } from "bun:test";

import { resolveDesktopActivationMode } from "../src/mcp/index.ts";

describe("spawn desktop activation mode", () => {
  it("does nothing when no desktop was requested", () => {
    expect(resolveDesktopActivationMode(undefined, false)).toBe("none");
  });

  it("defaults desktop-aware spawns to move-after-spawn", () => {
    expect(resolveDesktopActivationMode("2", false)).toBe("move-after-spawn");
  });

  it("preserves the old switch-first behavior when explicitly requested", () => {
    expect(resolveDesktopActivationMode("2", true)).toBe("switch-before-spawn");
  });
});
