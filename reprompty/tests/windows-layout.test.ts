import { describe, expect, it } from "vitest";

import { computeSlotGeometry } from "../src/core/layout-slots.ts";
import { WINDOWS_LAYOUT_SCRIPT, toLayoutMonitors } from "../src/platform/windows-layout.ts";

const display1 = {
  Name: "\\\\.\\DISPLAY1",
  Primary: true,
  Dpi: 144,
  X: 0,
  Y: 0,
  Width: 2560,
  Height: 1440,
  WorkX: 0,
  WorkY: 0,
  WorkWidth: 2560,
  WorkHeight: 1392,
};

const display2 = {
  Name: "\\\\.\\DISPLAY2",
  Primary: false,
  Dpi: 96,
  X: -1920,
  Y: 200,
  Width: 1920,
  Height: 1080,
  WorkX: -1920,
  WorkY: 200,
  WorkWidth: 1920,
  WorkHeight: 1032,
};

describe("toLayoutMonitors", () => {
  it("accepts the single object PowerShell prints for one monitor", () => {
    expect(toLayoutMonitors(display1)).toEqual([
      {
        name: "DISPLAY1",
        x: 0,
        y: 0,
        width: 2560,
        height: 1440,
        primary: true,
        work: { x: 0, y: 0, width: 2560, height: 1392 },
      },
    ]);
  });

  it("accepts an array and keeps negative coordinates", () => {
    const monitors = toLayoutMonitors([display1, display2]);
    expect(monitors.map((m) => [m.name, m.x, m.y, m.primary])).toEqual([
      ["DISPLAY1", 0, 0, true],
      ["DISPLAY2", -1920, 200, false],
    ]);
    expect(monitors[1].work).toEqual({ x: -1920, y: 200, width: 1920, height: 1032 });
    expect(computeSlotGeometry(monitors, "dual")).toEqual({
      x: -1920,
      y: 200,
      width: 4480,
      height: 1032,
      sashFraction: 1920 / 4480,
      monitors: ["DISPLAY2", "DISPLAY1"],
    });
  });

  it("unwraps the value/Count object Windows PowerShell 5.1 can print for an array", () => {
    expect(toLayoutMonitors({ value: [display1, display2], Count: 2 }).map((m) => m.name)).toEqual([
      "DISPLAY1",
      "DISPLAY2",
    ]);
  });

  it("drops entries without a usable rectangle and work areas that are empty", () => {
    expect(toLayoutMonitors(null)).toEqual([]);
    expect(toLayoutMonitors("DISPLAY1")).toEqual([]);
    expect(toLayoutMonitors([{ ...display1, Width: 0 }, { Name: "x" }, 7])).toEqual([]);
    const [monitor] = toLayoutMonitors({ ...display2, WorkWidth: 0 });
    expect(monitor.work).toBeUndefined();
  });
});

describe("WINDOWS_LAYOUT_SCRIPT", () => {
  it("is ASCII, so Windows PowerShell reads it the same in any code page", () => {
    expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(WINDOWS_LAYOUT_SCRIPT)).toBe(true);
  });

  it("uses no C# newer than version 5 (Windows PowerShell 5.1 Add-Type)", () => {
    for (const syntax of ["=>", '$"', "out var", "nameof", "?.", "?["]) {
      expect(WINDOWS_LAYOUT_SCRIPT).not.toContain(syntax);
    }
  });

  it("never activates a window", () => {
    expect(WINDOWS_LAYOUT_SCRIPT).not.toMatch(/SetForegroundWindow|SW_RESTORE|SW_SHOWNORMAL|ShowWindow\(\w+, (1|9)\)/);
    expect(WINDOWS_LAYOUT_SCRIPT).toContain("const int SW_SHOWNOACTIVATE = 4;");
    expect(WINDOWS_LAYOUT_SCRIPT).toContain("0x0004 | 0x0010 | 0x0200");
  });

  it("takes its input from the environment and prints JSON", () => {
    expect(WINDOWS_LAYOUT_SCRIPT).toContain("$env:REPROMPTY_LAYOUT_REQUEST | ConvertFrom-Json");
    expect(WINDOWS_LAYOUT_SCRIPT).toContain("ConvertTo-Json -Depth 4 -Compress");
    expect(WINDOWS_LAYOUT_SCRIPT).not.toMatch(/\bparam\s*\(/i);
  });

  it("knows every editor title", () => {
    for (const name of ["Visual Studio Code", "Code - OSS", "VSCodium", "Kilo Code", "Kimi Code"]) {
      expect(WINDOWS_LAYOUT_SCRIPT).toContain(`"${name}"`);
    }
  });
});
