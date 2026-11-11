import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

import {
  computeSlotGeometry,
  defaultSlots,
  fixedGeometry,
  migrateLayoutsConfig,
  sashTargetX,
  slotFractions,
  slotMode,
  type LayoutMode,
  type LayoutSlot,
  type Monitor,
  type SlotGeometry,
} from "../src/core/layout-slots.ts";

interface FixtureCase {
  name: string;
  linux: boolean;
  monitors: Monitor[];
  expected: Record<LayoutMode, SlotGeometry>;
}

const fixture: { cases: FixtureCase[] } = JSON.parse(
  fs.readFileSync(new URL("./fixtures/monitor-layouts.json", import.meta.url), "utf-8")
);

const OLD_WINDOWS_SCRIPT = "C:\\Users\\topem\\scripts\\VSCodeSidePanelLayout\\VSCodeSidePanelLayout.ps1";

function slot(overrides: Partial<LayoutSlot>): LayoutSlot {
  return { id: "id", letter: "A", name: "Slot", scriptArgs: [], hotkey: null, monitorHint: "", ...overrides };
}

describe("computeSlotGeometry", () => {
  for (const testCase of fixture.cases) {
    for (const mode of ["dual", "single"] as const) {
      it(`${testCase.name}: ${mode}`, () => {
        const { sashFraction, ...expected } = testCase.expected[mode];
        const geometry = computeSlotGeometry(testCase.monitors, mode);
        expect(geometry).not.toBeNull();
        const { sashFraction: actualFraction, ...actual } = geometry!;
        expect(actual).toEqual(expected);
        expect(actualFraction).toBeCloseTo(sashFraction, 4);
      });
    }
  }

  it("covers every case the plan lists", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8);
    expect(fixture.cases.filter((testCase) => testCase.linux).length).toBeGreaterThanOrEqual(6);
  });

  it("returns null without usable monitors", () => {
    expect(computeSlotGeometry([], "dual")).toBeNull();
    expect(computeSlotGeometry([{ name: "x", x: 0, y: 0, width: 0, height: 1080 }], "single")).toBeNull();
  });

  it("ignores monitor order", () => {
    const [first] = fixture.cases;
    const reversed = [...first.monitors].reverse();
    expect(computeSlotGeometry(reversed, "dual")).toEqual(computeSlotGeometry(first.monitors, "dual"));
    expect(computeSlotGeometry(reversed, "single")).toEqual(computeSlotGeometry(first.monitors, "single"));
  });

  it("puts the window inside both work areas when the monitors are offset", () => {
    const geometry = computeSlotGeometry(
      [
        { name: "L", x: -1920, y: 300, width: 1920, height: 1080, work: { x: -1920, y: 300, width: 1920, height: 1040 } },
        { name: "R", x: 0, y: 0, width: 1920, height: 1080, work: { x: 0, y: 0, width: 1920, height: 1040 }, primary: true },
      ],
      "dual"
    );
    expect(geometry).toEqual({ x: -1920, y: 300, width: 3840, height: 740, sashFraction: 0.5, monitors: ["L", "R"] });
  });

  it("breaks ties between equal monitors by primary, then leftmost", () => {
    const monitors: Monitor[] = [
      { name: "right", x: 3000, y: 0, width: 1920, height: 1080 },
      { name: "left", x: 0, y: 0, width: 1920, height: 1080 },
    ];
    expect(computeSlotGeometry(monitors, "dual")?.monitors).toEqual(["left"]);
    expect(computeSlotGeometry(monitors, "single")?.monitors).toEqual(["right"]);
    monitors[0].primary = true;
    expect(computeSlotGeometry(monitors, "dual")?.monitors).toEqual(["right"]);
    expect(computeSlotGeometry(monitors, "single")?.monitors).toEqual(["left"]);
  });
});

describe("sashTargetX", () => {
  it("measures panelFraction from the panel's side", () => {
    expect(sashTargetX(2000, true, { panelFraction: 0.3 })).toBe(600);
    expect(sashTargetX(2000, false, { panelFraction: 0.3 })).toBe(1400);
  });

  it("measures sashFraction from the left edge whatever the side", () => {
    expect(sashTargetX(3280, true, { sashFraction: 0.41463 })).toBe(1360);
    expect(sashTargetX(3280, false, { sashFraction: 0.41463 })).toBe(1360);
  });

  it("prefers sashFraction over panelFraction, and defaults to the middle", () => {
    expect(sashTargetX(2000, false, { sashFraction: 0.25, panelFraction: 0.9 })).toBe(500);
    expect(sashTargetX(2000, false, { sashFraction: Number.NaN, panelFraction: 0.25 })).toBe(1500);
    expect(sashTargetX(2000, true, {})).toBe(1000);
    expect(sashTargetX(2000, false, {})).toBe(1000);
  });

  it("clamps to the viewport", () => {
    expect(sashTargetX(2000, true, { sashFraction: 1.5 })).toBe(2000);
    expect(sashTargetX(2000, true, { sashFraction: -0.2 })).toBe(0);
    expect(sashTargetX(2000, true, { panelFraction: 2 })).toBe(2000);
    expect(sashTargetX(2000, false, { panelFraction: 2 })).toBe(0);
    expect(sashTargetX(2000, false, { panelFraction: -1 })).toBe(2000);
  });
});

describe("slot helpers", () => {
  it("slotMode uses mode, else the letter", () => {
    expect(slotMode(slot({ letter: "A" }))).toBe("dual");
    expect(slotMode(slot({ letter: "b" }))).toBe("single");
    expect(slotMode(slot({ letter: "C" }))).toBe("single");
    expect(slotMode(slot({ letter: "B", mode: "dual" }))).toBe("dual");
  });

  it("fixedGeometry needs all four coordinates", () => {
    expect(fixedGeometry(slot({ windowX: -1360, windowY: 449, windowWidth: 3280, windowHeight: 583 }))).toEqual({
      x: -1360,
      y: 449,
      width: 3280,
      height: 583,
    });
    expect(fixedGeometry(slot({ windowX: 0, windowY: 0, windowWidth: 1920 }))).toBeNull();
    expect(fixedGeometry(slot({}))).toBeNull();
  });

  it("slotFractions prefers sashFraction, then panelFraction, then panelWidth / windowWidth", () => {
    const base = { windowWidth: 3200, panelWidth: 800 };
    expect(slotFractions(slot({ ...base, sashFraction: 0.4, panelFraction: 0.3 }))).toEqual({ sashFraction: 0.4 });
    expect(slotFractions(slot({ ...base, panelFraction: 0.3 }))).toEqual({ panelFraction: 0.3 });
    expect(slotFractions(slot(base))).toEqual({ panelFraction: 0.25 });
    expect(slotFractions(slot({}))).toEqual({});
  });

  it("default slots are auto and portable", () => {
    for (const platform of ["win32", "linux"]) {
      const slots = defaultSlots(platform);
      expect(slots.map((s) => [s.letter, s.mode, s.hotkey])).toEqual([
        ["A", "dual", "Ctrl+Alt+V"],
        ["B", "single", "Ctrl+Alt+N"],
      ]);
      for (const s of slots) expect(fixedGeometry({ ...s, id: "x" })).toBeNull();
    }
    expect(defaultSlots("win32").map((s) => s.scriptArgs)).toEqual([["-Once"], ["-SingleOnce"]]);
    expect(defaultSlots("linux").map((s) => s.scriptArgs)).toEqual([["--slot", "A"], ["--slot", "B"]]);
  });
});

describe("migrateLayoutsConfig", () => {
  const oldWindowsFile = {
    version: 1,
    scriptPath: OLD_WINDOWS_SCRIPT.toUpperCase(),
    slots: [
      {
        letter: "A",
        name: "Dual Bottom",
        scriptArgs: ["-Once"],
        hotkey: "Ctrl+Alt+V",
        windowX: 0,
        windowY: 1083,
        windowWidth: 3840,
        windowHeight: 953,
        panelWidth: 1920,
        monitorHint: "DISPLAY5+DISPLAY6 bottom dual monitors",
        id: "a-id",
      },
      {
        letter: "B",
        name: "Top Full Panel",
        scriptArgs: ["-SingleOnce"],
        hotkey: "Ctrl+Alt+N",
        windowX: -1360,
        windowY: 449,
        windowWidth: 3280,
        windowHeight: 583,
        panelWidth: 1920,
        monitorHint: "DISPLAY2+DISPLAY1 top monitors",
        id: "b-id",
      },
    ],
  };

  // Shaped like the author's real file: custom slots recorded with Capture-style numbers.
  const customLinuxFile = {
    version: 1,
    scriptPath: "/home/someone/Projects/Reprompty/VSCodeSidePanelLayout/linux_layout.py",
    slots: [
      {
        letter: "A",
        name: "Dual Bottom",
        scriptArgs: ["--once", "--slot", "A"],
        hotkey: "Ctrl+Alt+V",
        windowX: 1360,
        windowY: 1083,
        windowWidth: 3200,
        windowHeight: 848,
        panelWidth: 1600,
        sashFraction: 0.5,
        monitorHint: "Dual monitors bottom",
        id: "229adb21-e013-498b-8e0e-dcb6bdcf39ab",
      },
      {
        letter: "B",
        name: "Top Full Panel",
        scriptArgs: ["--once", "--slot", "B"],
        hotkey: "Ctrl+Alt+N",
        windowX: 0,
        windowY: 449,
        windowWidth: 3280,
        windowHeight: 728,
        panelWidth: 1360,
        sashFraction: 0.4146341463414634,
        monitorHint: "Single monitor top",
        id: "aa31b8f2-a2c3-4f3d-8c90-880e387fe980",
      },
    ],
  };

  it("turns the old Windows defaults into auto slots and the old script into the built-in one", () => {
    const result = migrateLayoutsConfig(structuredClone(oldWindowsFile), "win32");
    expect(result?.changed).toBe(true);
    expect(result?.config).toEqual({
      version: 2,
      scriptPath: "",
      hotkeys: false,
      slots: [
        {
          letter: "A",
          name: "Dual Bottom",
          scriptArgs: ["-Once"],
          hotkey: "Ctrl+Alt+V",
          monitorHint: "Two side-by-side monitors; the agent panel fills one",
          id: "a-id",
          mode: "dual",
        },
        {
          letter: "B",
          name: "Top Full Panel",
          scriptArgs: ["-SingleOnce"],
          hotkey: "Ctrl+Alt+N",
          monitorHint: "One monitor that slot A does not use",
          id: "b-id",
          mode: "single",
        },
      ],
    });
    for (const s of result!.config.slots) expect(fixedGeometry(s)).toBeNull();
  });

  it("keeps custom slots byte for byte and only drops the old script path", () => {
    const raw = JSON.stringify(customLinuxFile, null, 2);
    const result = migrateLayoutsConfig(raw, "linux");
    expect(result?.changed).toBe(true);
    expect(result?.config.scriptPath).toBe("");
    expect(JSON.stringify(result?.config.slots, null, 2)).toBe(JSON.stringify(customLinuxFile.slots, null, 2));
    // The saved file differs only in version, scriptPath and the new hotkeys line.
    const expected = raw
      .replace('"version": 1', '"version": 2')
      .replace(/"scriptPath": ".*"/, '"scriptPath": "",\n  "hotkeys": false');
    expect(JSON.stringify(result?.config, null, 2)).toBe(expected);
  });

  it("migrates a default A next to a custom B", () => {
    const file = {
      version: 1,
      scriptPath: "/opt/OS Toolkit/VSCodeSidePanelLayout/reprompty-layout-cython",
      slots: [
        {
          id: "a",
          letter: "A",
          name: "Dual Bottom",
          scriptArgs: ["--slot", "A"],
          hotkey: "Ctrl+Alt+V",
          windowX: 1360,
          windowY: 1002,
          windowWidth: 3840,
          windowHeight: 1080,
          panelWidth: 1920,
          monitorHint: "my own words",
        },
        customLinuxFile.slots[1],
      ],
    };
    const result = migrateLayoutsConfig(structuredClone(file), "linux");
    expect(result?.config.scriptPath).toBe("");
    expect(result?.config.slots[0]).toEqual({
      id: "a",
      letter: "A",
      name: "Dual Bottom",
      scriptArgs: ["--slot", "A"],
      hotkey: "Ctrl+Alt+V",
      monitorHint: "my own words",
      mode: "dual",
    });
    expect(result?.config.slots[1]).toEqual(customLinuxFile.slots[1]);
  });

  it("keeps a default-shaped slot that has its own divider", () => {
    const pinned = { ...oldWindowsFile.slots[0], sashFraction: 0.5 };
    const result = migrateLayoutsConfig({ ...oldWindowsFile, slots: [pinned] }, "win32");
    expect(result?.config.slots[0]).toEqual(pinned);
  });

  it("keeps any other script path", () => {
    for (const scriptPath of [
      "D:\\tools\\MyLayout.ps1",
      "/home/someone/bin/layout.sh",
      "/x/VSCodeSidePanelLayout/linux_layout.py.bak",
    ]) {
      const result = migrateLayoutsConfig({ ...customLinuxFile, scriptPath }, "linux");
      expect(result?.config.scriptPath).toBe(scriptPath);
    }
    const windowsBundled = migrateLayoutsConfig(
      { ...customLinuxFile, scriptPath: "C:\\src\\Reprompty\\VSCodeSidePanelLayout\\linux_layout.py" },
      "win32"
    );
    expect(windowsBundled?.config.scriptPath).toBe("");
  });

  it("is idempotent on version 2", () => {
    const first = migrateLayoutsConfig(structuredClone(oldWindowsFile), "win32")!;
    const second = migrateLayoutsConfig(structuredClone(first.config), "win32");
    expect(second).toEqual({ config: first.config, changed: false });

    const customV2 = { version: 2, scriptPath: OLD_WINDOWS_SCRIPT, hotkeys: true, slots: oldWindowsFile.slots };
    expect(migrateLayoutsConfig(structuredClone(customV2), "win32")).toEqual({ config: customV2, changed: false });
  });

  it("accepts the file text", () => {
    const result = migrateLayoutsConfig(`\uFEFF${JSON.stringify(oldWindowsFile)}`, "win32");
    expect(result?.config.version).toBe(2);
  });

  it("returns null for anything that is not a layouts file", () => {
    for (const raw of ["", "{ not json", "42", 42, null, undefined, [], {}, { slots: "A" }, { version: 1 }]) {
      expect(migrateLayoutsConfig(raw, "linux")).toBeNull();
    }
  });
});
