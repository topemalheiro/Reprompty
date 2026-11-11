import type WebSocket from "ws";
import {
  cdpSend,
  findWindowGroupByTitle,
  getCdpTargets,
  getEvaluationValue,
  groupTargetsByPage,
  withTargetSocket,
  type CdpTarget,
} from "./cdp-client.js";
import { sashTargetX, type PanelFractions } from "./layout-slots.js";

export interface SashReading {
  /** Divider position as a share of the viewport, from its left edge */
  sashFraction: number;
  isLeft: boolean;
  viewportWidth: number;
  panelWidth: number;
}

export interface SashResult {
  success: boolean;
  error?: string;
  reading?: SashReading;
}

interface SashProbe {
  sashX: number;
  sashY: number;
  auxBarWidth: number;
  windowWidth: number;
  isLeft: boolean;
}

type ProbeError = "no-auxiliary-bar" | "auxiliary-bar-hidden" | "no-sash-found" | "no-response";
type Evaluate = (expression: string) => Promise<unknown>;
type Send = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const ALREADY_THERE_PX = 5;
const DRAG_TOLERANCE_PX = 10;
const PROBE_RETRIES = 2;
const PROBE_RETRY_DELAY_MS = 300;

// The secondary side bar ("auxiliary bar") and the vertical sash on its inner edge.
const PROBE_SCRIPT = `
(() => {
  const auxBar = document.getElementById('workbench.parts.auxiliarybar');
  if (!auxBar) return { error: 'no-auxiliary-bar' };
  const aux = auxBar.getBoundingClientRect();
  // Docked side by the gap to each window edge: a wide right panel can start left of the middle.
  const isLeft = aux.left <= window.innerWidth - aux.right;
  if (aux.width === 0) return { error: 'auxiliary-bar-hidden' };
  const edge = isLeft ? aux.right : aux.left;
  let best = null;
  let bestDist = Infinity;
  for (const sash of document.querySelectorAll('.monaco-sash.vertical')) {
    const r = sash.getBoundingClientRect();
    const dist = Math.abs(r.left + r.width / 2 - edge);
    if (dist < bestDist) {
      bestDist = dist;
      best = r;
    }
  }
  if (!best || bestDist > 20) return { error: 'no-sash-found' };
  return {
    sashX: Math.round(best.left + best.width / 2),
    sashY: Math.round(best.top + best.height / 2),
    auxBarWidth: Math.round(aux.width),
    windowWidth: window.innerWidth,
    isLeft,
  };
})()
`;

const PROBE_ERRORS: Record<ProbeError, string> = {
  "no-auxiliary-bar": "This VS Code window has no secondary side bar",
  "auxiliary-bar-hidden": "The secondary side bar is closed; open it and try again",
  "no-sash-found": "Could not find the secondary side bar's divider",
  "no-response": "VS Code did not answer the side bar probe",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function session(ws: WebSocket): { send: Send; evaluate: Evaluate } {
  let nextId = 1;
  return {
    send: (method, params) => cdpSend(ws, method, params, nextId++),
    evaluate: async (expression) =>
      getEvaluationValue(
        await cdpSend<{ result?: { value?: unknown } }>(
          ws,
          "Runtime.evaluate",
          { expression, returnByValue: true },
          nextId++
        )
      ),
  };
}

async function findWorkbenchPage(
  port: number,
  windowTitle?: string
): Promise<{ page: CdpTarget } | { error: string }> {
  let targets: CdpTarget[];
  try {
    targets = await getCdpTargets(port);
  } catch (error) {
    return { error: `Cannot reach VS Code on debugging port ${port}: ${errorMessage(error)}` };
  }
  const groups = groupTargetsByPage(targets).filter((group) => group.page.url.includes("workbench"));
  if (groups.length === 0) {
    return { error: `No VS Code window on debugging port ${port}` };
  }
  const group = findWindowGroupByTitle(groups, windowTitle);
  if (group) return { page: group.page };
  if (!windowTitle) {
    return { error: `${groups.length} VS Code windows are open; name the window` };
  }
  return { error: `No single VS Code window matches "${windowTitle}"` };
}

// The renderer reflows after a window move; until then innerWidth is the old width.
async function waitForViewportSettle(evaluate: Evaluate, timeoutMs = 1500, intervalMs = 50): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  let previous: number | null = null;
  while (Date.now() < deadline) {
    const current = await evaluate("window.innerWidth");
    if (typeof current !== "number") return null;
    if (current === previous) return current;
    previous = current;
    await sleep(intervalMs);
  }
  return previous;
}

function isProbe(value: unknown): value is SashProbe {
  const probe = value as SashProbe;
  return (
    !!probe &&
    typeof probe === "object" &&
    typeof probe.sashX === "number" &&
    typeof probe.sashY === "number" &&
    typeof probe.auxBarWidth === "number" &&
    typeof probe.windowWidth === "number" &&
    probe.windowWidth > 0 &&
    typeof probe.isLeft === "boolean"
  );
}

async function probeSash(evaluate: Evaluate): Promise<SashProbe | { error: ProbeError }> {
  for (let attempt = 0; ; attempt++) {
    const value = await evaluate(PROBE_SCRIPT);
    if (isProbe(value)) return value;
    const code = (value as { error?: ProbeError } | null)?.error;
    const error: ProbeError = code && code in PROBE_ERRORS ? code : "no-response";
    const retry = error === "no-auxiliary-bar" || error === "no-sash-found";
    if (!retry || attempt >= PROBE_RETRIES) return { error };
    await sleep(PROBE_RETRY_DELAY_MS);
  }
}

async function dragSash(send: Send, fromX: number, y: number, toX: number): Promise<void> {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: fromX, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: toX, y, button: "left" });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: toX, y, button: "left", clickCount: 1 });
}

function toReading(probe: SashProbe): SashReading {
  return {
    sashFraction: probe.sashX / probe.windowWidth,
    isLeft: probe.isLeft,
    viewportWidth: probe.windowWidth,
    panelWidth: probe.auxBarWidth,
  };
}

function describeProbe(probe: SashProbe): string {
  return `divider at ${probe.sashX} of ${probe.windowWidth}px, panel ${probe.auxBarWidth}px on the ${probe.isLeft ? "left" : "right"}`;
}

/** Drags the secondary side bar's divider of one VS Code window to the given fractions. */
export async function setSidePanelSash(
  port: number,
  windowTitle: string | undefined,
  f: PanelFractions,
  log?: (line: string) => void
): Promise<SashResult> {
  const found = await findWorkbenchPage(port, windowTitle);
  if ("error" in found) return { success: false, error: found.error };
  log?.(`Side panel: CDP window "${found.page.title}"`);

  try {
    return await withTargetSocket(found.page, async (ws): Promise<SashResult> => {
      const { send, evaluate } = session(ws);
      await waitForViewportSettle(evaluate);
      const probe = await probeSash(evaluate);
      if ("error" in probe) return { success: false, error: PROBE_ERRORS[probe.error] };

      const targetX = sashTargetX(probe.windowWidth, probe.isLeft, f);
      log?.(`Side panel: ${describeProbe(probe)}, target ${targetX}`);
      if (Math.abs(probe.sashX - targetX) <= ALREADY_THERE_PX) {
        return { success: true, reading: toReading(probe) };
      }

      await dragSash(send, probe.sashX, probe.sashY, targetX);
      await sleep(100);
      const after = await probeSash(evaluate);
      if ("error" in after) {
        // VS Code hides the bar when a drag leaves it far below its minimum width.
        if (after.error === "auxiliary-bar-hidden") {
          return { success: false, error: "The secondary side bar closed: the divider target leaves it too narrow" };
        }
        log?.(`Side panel: drag sent, divider not readable afterwards (${after.error})`);
        return { success: true };
      }
      log?.(`Side panel: ${describeProbe(after)}`);
      if (Math.abs(after.sashX - targetX) > DRAG_TOLERANCE_PX) {
        return {
          success: false,
          error: `The side panel divider stopped at ${after.sashX}px instead of ${targetX}px`,
          reading: toReading(after),
        };
      }
      return { success: true, reading: toReading(after) };
    });
  } catch (error) {
    return { success: false, error: `Side panel: ${errorMessage(error)}` };
  }
}

/** Where the secondary side bar's divider of one VS Code window is now. */
export async function readSidePanelSash(port: number, windowTitle?: string): Promise<SashResult> {
  const found = await findWorkbenchPage(port, windowTitle);
  if ("error" in found) return { success: false, error: found.error };

  try {
    return await withTargetSocket(found.page, async (ws): Promise<SashResult> => {
      const { evaluate } = session(ws);
      await waitForViewportSettle(evaluate);
      const probe = await probeSash(evaluate);
      if ("error" in probe) return { success: false, error: PROBE_ERRORS[probe.error] };
      return { success: true, reading: toReading(probe) };
    });
  } catch (error) {
    return { success: false, error: `Side panel: ${errorMessage(error)}` };
  }
}
