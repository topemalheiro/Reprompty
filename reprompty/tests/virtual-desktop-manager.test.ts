import { describe, expect, it } from "bun:test";

import {
  deriveVirtualDesktopName,
  makeUniqueVirtualDesktopName,
  normalizeVirtualDesktopList,
  planEnsureVirtualDesktop,
  resolveVirtualDesktopByName,
  validateVirtualDesktopRename,
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

  it("prefers the saved target label when deriving a fresh desktop name", () => {
    expect(
      deriveVirtualDesktopName(
        "Aperant MCP",
        "C:\\Users\\topem\\source\\repos\\Aperant-MCP"
      )
    ).toBe("Aperant MCP");
  });

  it("falls back to the folder basename when no target label is available", () => {
    expect(
      deriveVirtualDesktopName(
        undefined,
        "C:\\Users\\topem\\source\\repos\\Aperant-MCP\\"
      )
    ).toBe("Aperant-MCP");
  });

  it("adds a numeric suffix when a fresh desktop name already exists", () => {
    const desktops = [
      { index: 0, name: "1", isCurrent: true },
      { index: 1, name: "Aperant MCP", isCurrent: false },
      { index: 2, name: "Aperant MCP 2", isCurrent: false },
    ];

    expect(makeUniqueVirtualDesktopName(desktops, "Aperant MCP")).toBe(
      "Aperant MCP 3"
    );
  });

  it("plans ensure_virtual_desktop as a no-op when the desktop already exists", () => {
    const desktops = [
      { index: 0, name: "1", isCurrent: true },
      { index: 1, name: "Work", isCurrent: false },
    ];

    expect(planEnsureVirtualDesktop(desktops, "work")).toEqual({
      existingDesktop: desktops[1],
      shouldCreate: false,
    });
  });

  it("plans ensure_virtual_desktop to create when the desktop is missing", () => {
    const desktops = [{ index: 0, name: "1", isCurrent: true }];

    expect(planEnsureVirtualDesktop(desktops, "Focus")).toEqual({
      shouldCreate: true,
    });
  });

  it("validates desktop renames and blocks duplicate destination names", () => {
    const desktops = [
      { index: 0, name: "1", isCurrent: true },
      { index: 1, name: "Focus", isCurrent: false },
      { index: 2, name: "Aperant MCP", isCurrent: false },
    ];

    expect(
      validateVirtualDesktopRename(desktops, "Focus", "Aperant MCP")
    ).toEqual({
      error: 'Desktop "Aperant MCP" already exists',
    });

    expect(
      validateVirtualDesktopRename(desktops, "Focus", "Deep Work")
    ).toEqual({
      currentDesktop: desktops[1],
      normalizedNewName: "Deep Work",
    });
  });
});
