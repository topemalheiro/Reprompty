export type LayoutMode = "dual" | "single";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Monitor extends Rect {
  name: string;
  /** Monitor minus taskbars/panels; the whole monitor when absent */
  work?: Rect;
  primary?: boolean;
}

export interface SlotGeometry extends Rect {
  /** Divider position as a share of the window width, from its left edge */
  sashFraction: number;
  monitors: string[];
}

export interface PanelFractions {
  sashFraction?: number;
  panelFraction?: number;
}

export interface LayoutSlot {
  id: string;
  letter: string;
  name: string;
  mode?: LayoutMode;
  scriptArgs: string[];
  hotkey: string | null;
  windowX?: number;
  windowY?: number;
  windowWidth?: number;
  windowHeight?: number;
  panelWidth?: number;
  sashFraction?: number;
  panelFraction?: number;
  monitorHint: string;
}

export interface LayoutsConfig {
  version: number;
  scriptPath: string;
  hotkeys: boolean;
  slots: LayoutSlot[];
}

const CONFIG_VERSION = 2;

const EDGE_TOLERANCE_PX = 10;
const TOP_TOLERANCE_PX = 100;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUsableRect(rect: Rect | undefined): rect is Rect {
  return (
    !!rect &&
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function workArea(monitor: Monitor): Rect {
  return isUsableRect(monitor.work) ? monitor.work : monitor;
}

function area(rect: Rect): number {
  return rect.width * rect.height;
}

function verticalOverlap(a: Rect, b: Rect): number {
  return Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
}

function pairScore(left: Monitor, right: Monitor): number | null {
  if (Math.abs(left.x + left.width - right.x) >= EDGE_TOLERANCE_PX) return null;
  if (verticalOverlap(left, right) < Math.min(left.height, right.height) / 2) return null;
  if (verticalOverlap(workArea(left), workArea(right)) <= 0) return null;
  const sameSize = left.width === right.width && left.height === right.height;
  const topsAligned = Math.abs(left.y - right.y) < TOP_TOLERANCE_PX;
  return (sameSize ? 1e6 : 0) + (topsAligned ? 5e5 : 0) + area(left) + area(right);
}

function bestPair(monitors: Monitor[]): [Monitor, Monitor] | null {
  const sorted = [...monitors].sort((a, b) => a.x - b.x || a.y - b.y);
  let best: [Monitor, Monitor] | null = null;
  let bestScore = -1;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const score = pairScore(sorted[i], sorted[j]);
      if (score !== null && score > bestScore) {
        best = [sorted[i], sorted[j]];
        bestScore = score;
      }
    }
  }
  return best;
}

function largest(monitors: Monitor[]): Monitor {
  return [...monitors].sort(
    (a, b) =>
      area(b) - area(a) ||
      Number(Boolean(b.primary)) - Number(Boolean(a.primary)) ||
      a.x - b.x ||
      a.y - b.y
  )[0];
}

function span([left, right]: [Monitor, Monitor]): SlotGeometry {
  const leftWork = workArea(left);
  const rightWork = workArea(right);
  const x = leftWork.x;
  const y = Math.max(leftWork.y, rightWork.y);
  const width = rightWork.x + rightWork.width - x;
  const height = Math.min(leftWork.y + leftWork.height, rightWork.y + rightWork.height) - y;
  return { x, y, width, height, sashFraction: (right.x - x) / width, monitors: [left.name, right.name] };
}

function fill(monitor: Monitor): SlotGeometry {
  const { x, y, width, height } = workArea(monitor);
  return { x, y, width, height, sashFraction: 0.5, monitors: [monitor.name] };
}

/**
 * Dual: the best pair of side-by-side monitors, the divider on their seam; one
 * monitor when there is no pair. Single: the largest monitor dual does not use.
 */
export function computeSlotGeometry(monitors: Monitor[], mode: LayoutMode): SlotGeometry | null {
  const usable = monitors.filter(isUsableRect);
  if (usable.length === 0) return null;

  const pair = bestPair(usable);
  if (mode === "dual") {
    return pair ? span(pair) : fill(largest(usable));
  }
  const used: Monitor[] = pair ?? [largest(usable)];
  const free = usable.filter((monitor) => !used.includes(monitor));
  return fill(largest(free.length > 0 ? free : usable));
}

/** Divider x in viewport pixels. sashFraction counts from the left edge; panelFraction is the panel's share. */
export function sashTargetX(viewportWidth: number, isLeft: boolean, f: PanelFractions): number {
  let fraction: number;
  if (isFiniteNumber(f.sashFraction)) {
    fraction = f.sashFraction;
  } else {
    const panel = clamp01(isFiniteNumber(f.panelFraction) ? f.panelFraction : 0.5);
    fraction = isLeft ? panel : 1 - panel;
  }
  return Math.round(viewportWidth * clamp01(fraction));
}

export function slotMode(slot: LayoutSlot): LayoutMode {
  if (slot.mode === "dual" || slot.mode === "single") return slot.mode;
  return slot.letter.trim().toUpperCase() === "A" ? "dual" : "single";
}

/** The slot's own rectangle, or null for an auto slot. */
export function fixedGeometry(slot: LayoutSlot): Rect | null {
  const { windowX, windowY, windowWidth, windowHeight } = slot;
  if (
    !isFiniteNumber(windowX) ||
    !isFiniteNumber(windowY) ||
    !isFiniteNumber(windowWidth) ||
    !isFiniteNumber(windowHeight)
  ) {
    return null;
  }
  return { x: windowX, y: windowY, width: windowWidth, height: windowHeight };
}

export function slotFractions(slot: LayoutSlot): PanelFractions {
  if (isFiniteNumber(slot.sashFraction)) return { sashFraction: slot.sashFraction };
  if (isFiniteNumber(slot.panelFraction)) return { panelFraction: slot.panelFraction };
  if (isFiniteNumber(slot.panelWidth) && isFiniteNumber(slot.windowWidth) && slot.windowWidth > 0) {
    return { panelFraction: slot.panelWidth / slot.windowWidth };
  }
  return {};
}

export function defaultSlots(platform: string): Omit<LayoutSlot, "id">[] {
  const windows = platform === "win32";
  return [
    {
      letter: "A",
      name: "Dual",
      mode: "dual",
      scriptArgs: windows ? ["-Once"] : ["--slot", "A"],
      hotkey: "Ctrl+Alt+V",
      monitorHint: "Two side-by-side monitors; the agent panel fills one",
    },
    {
      letter: "B",
      name: "Single",
      mode: "single",
      scriptArgs: windows ? ["-SingleOnce"] : ["--slot", "B"],
      hotkey: "Ctrl+Alt+N",
      monitorHint: "One monitor that slot A does not use",
    },
  ];
}

// Coordinates Reprompty used to ship as defaults, which only fit the author's monitors.
const OLD_DEFAULT_SLOTS: ReadonlyArray<{ geometry: readonly number[]; mode: LayoutMode; hint: string }> = [
  { geometry: [0, 1083, 3840, 953, 1920], mode: "dual", hint: "DISPLAY5+DISPLAY6 bottom dual monitors" },
  { geometry: [-1360, 449, 3280, 583, 1920], mode: "single", hint: "DISPLAY2+DISPLAY1 top monitors" },
  { geometry: [1360, 1002, 3840, 1080, 1920], mode: "dual", hint: "HDMI-A-1 + DP-1 bottom dual monitors" },
  { geometry: [1360, 0, 1920, 1080, 960], mode: "single", hint: "HDMI-A-4 top monitor" },
];
const OLD_GEOMETRY_KEYS = ["windowX", "windowY", "windowWidth", "windowHeight", "panelWidth"];
const OLD_WINDOWS_SCRIPT = "C:\\Users\\topem\\scripts\\VSCodeSidePanelLayout\\VSCodeSidePanelLayout.ps1";
const OLD_BUNDLED_SCRIPT = /[\\/]VSCodeSidePanelLayout[\\/](linux_layout\.py|reprompty-layout-cython)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOldScriptPath(scriptPath: string): boolean {
  return (
    scriptPath.toLowerCase() === OLD_WINDOWS_SCRIPT.toLowerCase() ||
    OLD_BUNDLED_SCRIPT.test(scriptPath)
  );
}

function migrateSlot(slot: Record<string, unknown>, platform: string): Record<string, unknown> | null {
  if (slot.sashFraction != null || slot.panelFraction != null) return null;
  const old = OLD_DEFAULT_SLOTS.find((candidate) =>
    OLD_GEOMETRY_KEYS.every((key, index) => slot[key] === candidate.geometry[index])
  );
  if (!old) return null;

  const migrated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(slot)) {
    if (!OLD_GEOMETRY_KEYS.includes(key)) migrated[key] = value;
  }
  migrated.mode = old.mode;
  if (slot.monitorHint === old.hint) {
    const hint = defaultSlots(platform).find((candidate) => candidate.mode === old.mode)?.monitorHint;
    if (hint) migrated.monitorHint = hint;
  }
  return migrated;
}

/**
 * Brings a parsed (or raw JSON) layouts.json to version 2. Version 1 files lose
 * the old built-in script paths and the old default coordinates (those slots
 * become auto); every other slot is kept as it is. Null when it isn't a config.
 */
export function migrateLayoutsConfig(
  raw: unknown,
  platform: string
): { config: LayoutsConfig; changed: boolean } | null {
  let parsed = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed.replace(/^\uFEFF/, ""));
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.slots)) return null;

  const { version, scriptPath, hotkeys, slots, ...extra } = parsed;
  const slotObjects = (slots as unknown[]).filter(isRecord);
  let changed = slotObjects.length !== (slots as unknown[]).length;

  let nextScriptPath = typeof scriptPath === "string" ? scriptPath : "";
  let nextSlots = slotObjects.map((slot) => ({ ...slot }));
  const nextHotkeys = typeof hotkeys === "boolean" ? hotkeys : false;
  if (typeof scriptPath !== "string" || typeof hotkeys !== "boolean") changed = true;

  const isCurrent = isFiniteNumber(version) && version >= CONFIG_VERSION;
  if (!isCurrent) {
    changed = true;
    if (isOldScriptPath(nextScriptPath)) nextScriptPath = "";
    nextSlots = nextSlots.map((slot) => migrateSlot(slot, platform) ?? slot);
  }

  return {
    config: {
      version: isCurrent ? version : CONFIG_VERSION,
      scriptPath: nextScriptPath,
      hotkeys: nextHotkeys,
      slots: nextSlots as unknown as LayoutSlot[],
      ...extra,
    },
    changed,
  };
}
