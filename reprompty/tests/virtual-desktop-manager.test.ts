import { describe, expect, it } from "bun:test";

import {
  normalizeVirtualDesktopList,
  resolveVirtualDesktopByName,
} from "../src/core/virtual-desktop-manager.ts";

describe("virtual desktop helpers", () => {
  it("normalizes PowerShell virtual desktop output", () => {
    expect(
      normalizeVirtualDesktopList([
        { Number: 1, Name: "Work", Visible: false },
        { index: 0, name: "1", isCurrent: true },
      ])
    ).toEqual([
      { index: 0, name: "1", isCurrent: true },
      { index: 1, name: "Work", isCurrent: false },
    ]);
  });

  it("resolves virtual desktops by exact case-insensitive name", () => {
    const desktops = [
      { index: 0, name: "1", isCurrent: true },
      { index: 1, name: "Work", isCurrent: false },
    ];

    expect(resolveVirtualDesktopByName(desktops, "work").desktop).toEqual(
      desktops[1]
    );
  });

  it("fails clearly when the requested desktop is missing", () => {
    const desktops = [{ index: 0, name: "1", isCurrent: true }];
    const result = resolveVirtualDesktopByName(desktops, "Focus");

    expect(result.desktop).toBeUndefined();
    expect(result.error).toContain('Desktop "Focus" not found');
  });

  it("fails clearly when duplicate desktop names exist", () => {
    const desktops = [
      { index: 0, name: "Work", isCurrent: true },
      { index: 1, name: "Work", isCurrent: false },
    ];
    const result = resolveVirtualDesktopByName(desktops, "Work");

    expect(result.desktop).toBeUndefined();
    expect(result.error).toContain("matched multiple desktops");
  });
});
