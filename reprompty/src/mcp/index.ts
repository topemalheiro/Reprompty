import { spawn } from "node:child_process";
import {
  connectionManager,
  type ConnectionType,
  type ConnectionConfig,
  type VSCodeWindowConfig,
} from "../core/connection-manager.js";
import { getOrCreateIpcClient } from "../core/ipc-client.js";
import { scriptManager } from "../core/script-manager.js";
import {
  layoutManager,
  type LayoutTarget,
} from "../core/layout-manager.js";
import {
  resolveSpawnTargetDesktop,
  spawnTargetManager,
} from "../core/spawn-target-manager.js";
import {
  createVirtualDesktop,
  deriveVirtualDesktopName,
  ensureVirtualDesktop,
  listVirtualDesktops,
  makeUniqueVirtualDesktopName,
  moveWindowToVirtualDesktop,
  renameVirtualDesktop,
  switchToVirtualDesktop,
  type VirtualDesktopInfo,
} from "../core/virtual-desktop-manager.js";
import {
  spawnWindow,
  detectWindows,
  detectAllWindows,
  getCdpPort,
  getWorkspacePathFromPid,
  type DetectedWindow,
} from "../platform/index.js";
import { sendViaAgentCdp, isCdpAvailable } from "../core/cdp-client.js";
import {
  buildSpawnTitleHints,
  findNewWindowCandidates,
  selectUniqueWindowByTitle,
} from "./window-targeting.js";
import {
  saveTaskPreset,
  loadTaskPreset,
  listTaskPresets,
  deleteTaskPreset,
} from "../core/task-preset-manager.js";

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: object;
}

export interface MCPResource {
  uri: string;
  name: string;
  description: string;
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

type ResolvedSpawnInput =
  | {
      folderPath: string;
      windowName?: string;
      explicitDesktop?: string;
      defaultDesktop?: string;
      createDesktop: boolean;
      activateDesktop: boolean;
      label: string;
      targetLabel?: string;
    }
  | { error: string };

const BUILT_IN_TOOLS: MCPTool[] = [
  {
    name: "spawn_window",
    description: "Spawn a new VS Code window using a saved target alias or a raw project folder",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Saved spawn target alias" },
        folderPath: { type: "string", description: "Path to the project folder" },
        windowName: { type: "string", description: "Optional name for the window" },
        desktop: {
          type: "string",
          description:
            "Optional virtual desktop name to use or auto-create for this spawn",
        },
        createDesktop: {
          type: "boolean",
          description:
            "Optional: create a fresh desktop for this spawn when no explicit desktop name is supplied",
        },
        activateDesktop: {
          type: "boolean",
          description:
            "Optional: switch to the target desktop before spawning. Defaults to false.",
        },
      },
    },
  },
  {
    name: "list_spawn_targets",
    description: "List all saved spawn target aliases for opening VS Code windows",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_virtual_desktops",
    description: "List all available Windows virtual desktops and indicate which one is current",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "ensure_virtual_desktop",
    description:
      "Ensure a Windows virtual desktop exists by exact name without switching to it",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Exact desktop name to ensure exists",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "rename_virtual_desktop",
    description:
      "Rename an existing Windows virtual desktop by exact name without switching desktops",
    inputSchema: {
      type: "object",
      properties: {
        currentName: {
          type: "string",
          description: "Current exact desktop name",
        },
        newName: {
          type: "string",
          description: "New exact desktop name",
        },
      },
      required: ["currentName", "newName"],
    },
  },
  {
    name: "send_prompt",
    description: "Send a prompt to a specific connection (appears in chat without focusing window)",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string", description: "ID of the connection to send to" },
        prompt: { type: "string", description: "The prompt to send" },
        waitForResponse: {
          type: "boolean",
          description: "Wait for response (not implemented yet)",
        },
        timeout: { type: "number", description: "Timeout in milliseconds" },
      },
      required: ["connectionId", "prompt"],
    },
  },
  {
    name: "add_connection",
    description: "Add a new connection to the connection pool",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["vscode-window", "vscode-cli", "http-api", "websocket"],
          description: "Type of connection",
        },
        name: { type: "string", description: "Name for this connection" },
        config: {
          type: "object",
          description: "Connection configuration",
          properties: {
            socketPath: { type: "string", description: "IPC socket path" },
            windowTitle: { type: "string", description: "Window title to find" },
            method: {
              type: "string",
              enum: ["foreground", "background"],
              description: "Send method",
            },
            folderPath: { type: "string", description: "Folder path for CLI" },
            url: { type: "string", description: "URL for HTTP/WebSocket" },
          },
        },
      },
      required: ["type", "name", "config"],
    },
  },
  {
    name: "list_connections",
    description: "List all available connections",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "remove_connection",
    description: "Remove a connection from the pool",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string", description: "ID of the connection to remove" },
      },
      required: ["connectionId"],
    },
  },
  {
    name: "daisy_chain",
    description: "Chain multiple prompts across connections",
    inputSchema: {
      type: "object",
      properties: {
        prompts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              connectionId: { type: "string" },
              prompt: { type: "string" },
            },
            required: ["connectionId", "prompt"],
          },
        },
        continueOnError: { type: "boolean" },
      },
      required: ["prompts"],
    },
  },
  {
    name: "list_scripts",
    description: "List all registered scripts with their current status",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "run_script",
    description: "Run a registered script by name or ID",
    inputSchema: {
      type: "object",
      properties: {
        scriptId: { type: "string", description: "Script ID or name" },
      },
      required: ["scriptId"],
    },
  },
  {
    name: "stop_script",
    description: "Stop a running script by name or ID",
    inputSchema: {
      type: "object",
      properties: {
        scriptId: { type: "string", description: "Script ID or name" },
      },
      required: ["scriptId"],
    },
  },
  {
    name: "apply_layout",
    description: "Apply a layout slot to position or resize the active VS Code window",
    inputSchema: {
      type: "object",
      properties: {
        slot: {
          type: "string",
          description: "Slot letter (A, B) or slot name (for example 'Dual Bottom')",
        },
        windowTitle: {
          type: "string",
          description: "Optional: target a specific window by title",
        },
        windowHandle: {
          type: "number",
          description: "Optional: exact window handle to target. Preferred over windowTitle",
        },
      },
      required: ["slot"],
    },
  },
  {
    name: "list_layout_slots",
    description: "List all available layout slots with their configurations",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "spawn_and_layout",
    description: "Spawn a new VS Code window from a target or folder path and apply a layout slot",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Saved spawn target alias" },
        folderPath: { type: "string", description: "Path to the project folder" },
        windowName: { type: "string", description: "Optional name for the window" },
        desktop: {
          type: "string",
          description:
            "Optional virtual desktop name to use or auto-create for this spawn",
        },
        createDesktop: {
          type: "boolean",
          description:
            "Optional: create a fresh desktop for this spawn when no explicit desktop name is supplied",
        },
        activateDesktop: {
          type: "boolean",
          description:
            "Optional: switch to the target desktop before spawning. Defaults to false.",
        },
        slot: {
          type: "string",
          description: "Layout slot letter (A, B) or name to apply after spawning",
        },
      },
      required: ["slot"],
    },
  },
  {
    name: "detect_windows",
    description: "Auto-detect all VS Code: and Kilo Code: windows with their PIDs and capabilities",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "detect_all_windows",
    description: "Detect ALL visible windows on the desktop (browsers, terminals, editors, etc.)",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "check_cdp",
    description: "Check if Chrome DevTools Protocol is available for background sending",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "save_task_preset",
    description: "Save the current virtual desktop and VS Code: window layout as a named task preset",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Unique name for the preset (e.g., 'Coding', 'Docs')",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "load_task_preset",
    description: "Restore a saved task preset: recreate virtual desktops and spawn VS Code: windows",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the preset to restore",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_task_presets",
    description: "List all saved task preset names",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "delete_task_preset",
    description: "Delete a saved task preset by name",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the preset to delete",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "duplicate_workspace_in_new_window",
    description:
      "Duplicate the current workspace as a new VS Code: window. Optionally apply a layout slot to the newly created window.",
    inputSchema: {
      type: "object",
      properties: {
        windowTitle: {
          type: "string",
          description: "Window title substring to identify the target VS Code: window",
        },
        folderPath: {
          type: "string",
          description: "Folder path substring to identify the target VS Code: window",
        },
        slot: {
          type: "string",
          description: "Optional layout slot to apply to the new window (e.g. 'A', 'B', or slot name)",
        },
      },
    },
  },
];

function textResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function getGeneratedTools(): MCPTool[] {
  return scriptManager.listGeneratedMcpTools().map((registration) => ({
    name: registration.action.toolName,
    description:
      registration.action.description ||
      `Run ${registration.action.label} from ${registration.scriptName}`,
    inputSchema: {
      type: "object",
      properties: {},
    },
  }));
}

export function getTools(): MCPTool[] {
  return [...BUILT_IN_TOOLS, ...getGeneratedTools()];
}

function parseBooleanArg(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
  }

  return false;
}

function resolveSpawnInput(args: Record<string, unknown>): ResolvedSpawnInput {
  const target = typeof args.target === "string" ? args.target.trim() : "";
  const explicitFolderPath =
    typeof args.folderPath === "string" ? args.folderPath.trim() : "";
  const explicitWindowName =
    typeof args.windowName === "string" ? args.windowName.trim() : "";
  const explicitDesktop =
    typeof args.desktop === "string" ? args.desktop.trim() : "";
  const createDesktop = parseBooleanArg(args.createDesktop);
  const activateDesktop = parseBooleanArg(args.activateDesktop);

  if (target) {
    const savedTarget = spawnTargetManager.getTarget(target);
    if (!savedTarget) {
      return { error: `Spawn target "${target}" not found` };
    }
    return {
      folderPath: savedTarget.folderPath,
      windowName: explicitWindowName || savedTarget.windowName,
      explicitDesktop: explicitDesktop || undefined,
      defaultDesktop: resolveSpawnTargetDesktop(undefined, savedTarget.desktop),
      createDesktop,
      activateDesktop,
      label: `${savedTarget.label} (${savedTarget.id})`,
      targetLabel: savedTarget.label,
    };
  }

  if (!explicitFolderPath) {
    return { error: 'Provide either "target" or "folderPath"' };
  }

  return {
    folderPath: explicitFolderPath,
    windowName: explicitWindowName || undefined,
    explicitDesktop: explicitDesktop || undefined,
    defaultDesktop: undefined,
    createDesktop,
    activateDesktop,
    label: explicitFolderPath,
  };
}

function resolveLayoutSlot(slotKey: string) {
  return (
    layoutManager.getSlotByLetter(slotKey) ??
    layoutManager
      .listSlots()
      .find((slot) => slot.name.toLowerCase() === slotKey.toLowerCase())
  );
}

function parseWindowHandle(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function formatWindowSummary(window: DetectedWindow): string {
  return `${window.handle}:${window.pid}:${window.title}`;
}

function logToolEvent(message: string, details?: unknown): void {
  if (details === undefined) {
    console.log(`[Reprompty MCP] ${message}`);
    return;
  }

  console.log(
    `[Reprompty MCP] ${message} ${JSON.stringify(details)}`
  );
}

function resolveRequestedDesktopName(
  resolved: Exclude<ResolvedSpawnInput, { error: string }>
): string | undefined {
  const explicitDesktop = resolved.explicitDesktop?.trim();
  if (explicitDesktop) {
    return explicitDesktop;
  }

  if (resolved.createDesktop) {
    return undefined;
  }

  return resolved.defaultDesktop?.trim() || undefined;
}

function formatVirtualDesktopSummary(
  desktop: VirtualDesktopInfo | undefined,
  fallbackName?: string
): string | undefined {
  return desktop?.name || fallbackName;
}

export function resolveDesktopActivationMode(
  desktop: string | undefined,
  activateDesktop: boolean
): "none" | "switch-before-spawn" | "move-after-spawn" {
  if (!desktop) {
    return "none";
  }

  return activateDesktop ? "switch-before-spawn" : "move-after-spawn";
}

async function prepareSpawnDesktop(
  resolved: Exclude<ResolvedSpawnInput, { error: string }>
): Promise<
  | {
      success: true;
      desktop?: string;
      desktopInfo?: VirtualDesktopInfo;
      createdDesktop: boolean;
      desktopMode:
        | "current"
        | "explicit"
        | "target-default"
        | "created-explicit"
        | "created-target-default"
        | "created-derived";
      requestedDesktop?: string;
      derivedDesktopBaseName?: string;
    }
  | { success: false; error: string }
> {
  const explicitDesktop = resolved.explicitDesktop?.trim() || undefined;
  const defaultDesktop = resolved.defaultDesktop?.trim() || undefined;

  if (explicitDesktop) {
    const ensuredDesktop = await ensureVirtualDesktop(explicitDesktop);
    if (!ensuredDesktop.success) {
      return {
        success: false,
        error:
          ensuredDesktop.error ||
          `Failed to ensure virtual desktop "${explicitDesktop}"`,
      };
    }

    return {
      success: true,
      desktop: formatVirtualDesktopSummary(ensuredDesktop.desktop, explicitDesktop),
      desktopInfo: ensuredDesktop.desktop,
      createdDesktop: ensuredDesktop.created,
      desktopMode: ensuredDesktop.created ? "created-explicit" : "explicit",
      requestedDesktop: explicitDesktop,
    };
  }

  if (resolved.createDesktop) {
    const desktops = await listVirtualDesktops();
    const derivedDesktopBaseName = deriveVirtualDesktopName(
      resolved.targetLabel,
      resolved.folderPath
    );
    if (!derivedDesktopBaseName) {
      return {
        success: false,
        error:
          "Could not derive a desktop name from the target label or folder path",
      };
    }

    const freshDesktopName = makeUniqueVirtualDesktopName(
      desktops,
      derivedDesktopBaseName
    );
    const createdDesktop = await createVirtualDesktop(freshDesktopName);
    if (!createdDesktop.success) {
      return {
        success: false,
        error:
          createdDesktop.error ||
          `Failed to create virtual desktop "${freshDesktopName}"`,
      };
    }

    return {
      success: true,
      desktop: formatVirtualDesktopSummary(createdDesktop.desktop, freshDesktopName),
      desktopInfo: createdDesktop.desktop,
      createdDesktop: true,
      desktopMode: "created-derived",
      requestedDesktop: freshDesktopName,
      derivedDesktopBaseName,
    };
  }

  if (defaultDesktop) {
    const ensuredDesktop = await ensureVirtualDesktop(defaultDesktop);
    if (!ensuredDesktop.success) {
      return {
        success: false,
        error:
          ensuredDesktop.error ||
          `Failed to ensure virtual desktop "${defaultDesktop}"`,
      };
    }

    return {
      success: true,
      desktop: formatVirtualDesktopSummary(ensuredDesktop.desktop, defaultDesktop),
      desktopInfo: ensuredDesktop.desktop,
      createdDesktop: ensuredDesktop.created,
      desktopMode: ensuredDesktop.created
        ? "created-target-default"
        : "target-default",
      requestedDesktop: defaultDesktop,
    };
  }

  return {
    success: true,
    createdDesktop: false,
    desktopMode: "current",
  };
}

async function waitForSpawnedWindow(
  baselineWindows: DetectedWindow[],
  titleHints: string[],
  timeoutMs = 15000,
  pollIntervalMs = 500
): Promise<{
  matchedWindow: DetectedWindow | null;
  finalWindows: DetectedWindow[];
  newCandidates: DetectedWindow[];
  reason: string;
}> {
  const startedAt = Date.now();
  let finalWindows = baselineWindows;
  let newCandidates: DetectedWindow[] = [];
  let lastReason = "no new window handles detected after spawn";

  while (Date.now() - startedAt < timeoutMs) {
    finalWindows = await detectWindows();
    newCandidates = findNewWindowCandidates(baselineWindows, finalWindows);

    if (newCandidates.length === 1) {
      return {
        matchedWindow: newCandidates[0],
        finalWindows,
        newCandidates,
        reason: "matched a unique new window handle",
      };
    }

    if (newCandidates.length > 1) {
      const narrowed = selectUniqueWindowByTitle(newCandidates, titleHints);
      if (narrowed.match) {
        return {
          matchedWindow: narrowed.match,
          finalWindows,
          newCandidates,
          reason: `${narrowed.reason} among newly detected windows`,
        };
      }

      lastReason = `${narrowed.reason}; new candidates=${newCandidates
        .map(formatWindowSummary)
        .join(" | ")}`;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const fallback = selectUniqueWindowByTitle(finalWindows, titleHints);
  if (fallback.match) {
    return {
      matchedWindow: fallback.match,
      finalWindows,
      newCandidates,
      reason: `${fallback.reason} after timeout`,
    };
  }

  return {
    matchedWindow: null,
    finalWindows,
    newCandidates,
    reason: `${lastReason}; ${fallback.reason}`,
  };
}

async function executeSpawnWorkflow(
  resolved: Exclude<ResolvedSpawnInput, { error: string }>,
  options: {
    slot?: NonNullable<ReturnType<typeof resolveLayoutSlot>>;
    requestedTarget?: string | null;
  } = {}
): Promise<Record<string, unknown>> {
  const requestedDesktop = resolveRequestedDesktopName(resolved) ?? null;
  const desktopResolution = await prepareSpawnDesktop(resolved);
  if (!desktopResolution.success) {
    return {
      success: false,
      stage: "resolve_desktop",
      requestedFolderPath: resolved.folderPath,
      requestedWindowName: resolved.windowName ?? null,
      requestedDesktop,
      createDesktop: resolved.createDesktop,
      activateDesktop: resolved.activateDesktop,
      spawnTargetLabel: resolved.label,
      slot: options.slot
        ? { id: options.slot.id, letter: options.slot.letter, name: options.slot.name }
        : null,
      error: desktopResolution.error,
    };
  }

  const desktopActivationMode = resolveDesktopActivationMode(
    desktopResolution.desktop,
    resolved.activateDesktop
  );

  logToolEvent("spawn workflow desktop resolution", {
    requestedTarget: options.requestedTarget ?? null,
    requestedFolderPath: resolved.folderPath,
    requestedWindowName: resolved.windowName ?? null,
    requestedDesktop,
    createDesktop: resolved.createDesktop,
    activateDesktop: resolved.activateDesktop,
    desktopMode: desktopResolution.desktopMode,
    desktopActivationMode,
    effectiveDesktop: desktopResolution.desktop ?? null,
    createdDesktop: desktopResolution.createdDesktop,
  });

  if (
    desktopActivationMode === "switch-before-spawn" &&
    desktopResolution.desktop
  ) {
    const desktopResult = await switchToVirtualDesktop(desktopResolution.desktop);
    logToolEvent("spawn workflow desktop switch", {
      requestedTarget: options.requestedTarget ?? null,
      requestedFolderPath: resolved.folderPath,
      requestedDesktop,
      effectiveDesktop: desktopResolution.desktop,
      activateDesktop: resolved.activateDesktop,
      createDesktop: resolved.createDesktop,
      createdDesktop: desktopResolution.createdDesktop,
      desktopMode: desktopResolution.desktopMode,
      success: desktopResult.success,
      error: desktopResult.error,
    });

    if (!desktopResult.success) {
      return {
        success: false,
        stage: "switch_desktop",
        requestedFolderPath: resolved.folderPath,
        requestedWindowName: resolved.windowName ?? null,
        requestedDesktop,
        effectiveDesktop: desktopResolution.desktop,
        createDesktop: resolved.createDesktop,
        activateDesktop: resolved.activateDesktop,
        desktopMode: desktopResolution.desktopMode,
        desktopActivationMode,
        createdDesktop: desktopResolution.createdDesktop,
        spawnTargetLabel: resolved.label,
        slot: options.slot
          ? { id: options.slot.id, letter: options.slot.letter, name: options.slot.name }
          : null,
        error: desktopResult.error,
      };
    }
  }

  const baselineWindows = await detectWindows();
  const titleHints = buildSpawnTitleHints({
    folderPath: resolved.folderPath,
    windowName: resolved.windowName,
  });

  logToolEvent("spawn workflow baseline", {
    requestedTarget: options.requestedTarget ?? null,
    requestedFolderPath: resolved.folderPath,
    requestedWindowName: resolved.windowName ?? null,
    requestedDesktop,
    effectiveDesktop: desktopResolution.desktop ?? null,
    createDesktop: resolved.createDesktop,
    activateDesktop: resolved.activateDesktop,
    createdDesktop: desktopResolution.createdDesktop,
    desktopMode: desktopResolution.desktopMode,
    desktopActivationMode,
    slot: options.slot?.letter ?? null,
    slotName: options.slot?.name ?? null,
    titleHints,
    baselineHandles: baselineWindows.map(formatWindowSummary),
  });

  const spawnResult = await spawnWindow(resolved.folderPath, resolved.windowName);
  if (!spawnResult.success) {
    logToolEvent("spawn workflow spawn failed", {
      requestedTarget: options.requestedTarget ?? null,
      requestedFolderPath: resolved.folderPath,
      requestedDesktop,
      effectiveDesktop: desktopResolution.desktop ?? null,
      createDesktop: resolved.createDesktop,
      activateDesktop: resolved.activateDesktop,
      createdDesktop: desktopResolution.createdDesktop,
      desktopMode: desktopResolution.desktopMode,
      desktopActivationMode,
      slot: options.slot?.letter ?? null,
      message: spawnResult.message,
    });

    return {
      success: false,
      stage: "spawn",
      requestedFolderPath: resolved.folderPath,
      requestedWindowName: resolved.windowName ?? null,
      requestedDesktop,
      effectiveDesktop: desktopResolution.desktop ?? null,
      createDesktop: resolved.createDesktop,
      activateDesktop: resolved.activateDesktop,
      createdDesktop: desktopResolution.createdDesktop,
      desktopMode: desktopResolution.desktopMode,
      desktopActivationMode,
      spawnTargetLabel: resolved.label,
      slot: options.slot
        ? { id: options.slot.id, letter: options.slot.letter, name: options.slot.name }
        : null,
      error: spawnResult.message,
    };
  }

  const selection = await waitForSpawnedWindow(baselineWindows, titleHints);
  logToolEvent("spawn workflow window selection", {
    requestedTarget: options.requestedTarget ?? null,
    requestedFolderPath: resolved.folderPath,
    requestedDesktop,
    effectiveDesktop: desktopResolution.desktop ?? null,
    createDesktop: resolved.createDesktop,
    activateDesktop: resolved.activateDesktop,
    createdDesktop: desktopResolution.createdDesktop,
    desktopMode: desktopResolution.desktopMode,
    desktopActivationMode,
    slot: options.slot?.letter ?? null,
    reason: selection.reason,
    candidateHandles: selection.newCandidates.map(formatWindowSummary),
    finalHandles: selection.finalWindows.map(formatWindowSummary),
    matchedWindow: selection.matchedWindow
      ? formatWindowSummary(selection.matchedWindow)
      : null,
  });

  const requiresExactWindow =
    Boolean(options.slot) || desktopActivationMode === "move-after-spawn";

  let matchedWindow = selection.matchedWindow;
  let finalWindows = selection.finalWindows;
  let moveResult:
    | Awaited<ReturnType<typeof moveWindowToVirtualDesktop>>
    | undefined;

  if (!matchedWindow && requiresExactWindow) {
    return {
      success: false,
      stage: "select_window",
      requestedFolderPath: resolved.folderPath,
      requestedWindowName: resolved.windowName ?? null,
      requestedDesktop,
      effectiveDesktop: desktopResolution.desktop ?? null,
      createDesktop: resolved.createDesktop,
      activateDesktop: resolved.activateDesktop,
      createdDesktop: desktopResolution.createdDesktop,
      desktopMode: desktopResolution.desktopMode,
      desktopActivationMode,
      spawnTargetLabel: resolved.label,
      slot: options.slot
        ? { id: options.slot.id, letter: options.slot.letter, name: options.slot.name }
        : null,
      titleHints,
      baselineHandles: baselineWindows.map(formatWindowSummary),
      candidateHandles: selection.newCandidates.map(formatWindowSummary),
      finalHandles: selection.finalWindows.map(formatWindowSummary),
      error: `Unable to isolate a unique spawned VS Code window: ${selection.reason}`,
    };
  }

  if (
    matchedWindow &&
    desktopActivationMode === "move-after-spawn" &&
    desktopResolution.desktop
  ) {
    moveResult = await moveWindowToVirtualDesktop(
      matchedWindow.kdotoolHandle || matchedWindow.handle,
      desktopResolution.desktop
    );

    logToolEvent("spawn workflow desktop move", {
      requestedTarget: options.requestedTarget ?? null,
      requestedFolderPath: resolved.folderPath,
      requestedDesktop,
      effectiveDesktop: desktopResolution.desktop,
      activateDesktop: resolved.activateDesktop,
      desktopMode: desktopResolution.desktopMode,
      desktopActivationMode,
      matchedWindow: formatWindowSummary(matchedWindow),
      success: moveResult.success,
      error: moveResult.error,
      desktop: moveResult.desktop?.name ?? null,
      isCurrentDesktop: moveResult.isCurrentDesktop ?? null,
    });

    if (!moveResult.success) {
      return {
        success: false,
        stage: "move_window",
        requestedFolderPath: resolved.folderPath,
        requestedWindowName: resolved.windowName ?? null,
        requestedDesktop,
        effectiveDesktop: desktopResolution.desktop,
        createDesktop: resolved.createDesktop,
        activateDesktop: resolved.activateDesktop,
        createdDesktop: desktopResolution.createdDesktop,
        desktopMode: desktopResolution.desktopMode,
        desktopActivationMode,
        spawnTargetLabel: resolved.label,
        slot: options.slot
          ? { id: options.slot.id, letter: options.slot.letter, name: options.slot.name }
          : null,
        matchedWindow,
        error: moveResult.error,
      };
    }

    finalWindows = await detectWindows();
    matchedWindow =
      finalWindows.find((window) => window.handle === matchedWindow?.handle) ??
      matchedWindow;
  }

  const summaryParts = [spawnResult.message];
  if (
    desktopActivationMode === "switch-before-spawn" &&
    desktopResolution.desktop
  ) {
    summaryParts.push(`Activated desktop ${desktopResolution.desktop} before spawn`);
  }
  if (
    desktopActivationMode === "move-after-spawn" &&
    desktopResolution.desktop &&
    matchedWindow
  ) {
    summaryParts.push(
      `Moved window handle ${matchedWindow.handle} to desktop ${desktopResolution.desktop}`
    );
  }

  if (!options.slot) {
    return {
      success: true,
      message: summaryParts.join(". "),
      requestedFolderPath: resolved.folderPath,
      requestedWindowName: resolved.windowName ?? null,
      requestedDesktop,
      effectiveDesktop:
        desktopResolution.desktop ?? matchedWindow?.desktop ?? null,
      createDesktop: resolved.createDesktop,
      activateDesktop: resolved.activateDesktop,
      createdDesktop: desktopResolution.createdDesktop,
      desktopMode: desktopResolution.desktopMode,
      desktopActivationMode,
      derivedDesktopBaseName: desktopResolution.derivedDesktopBaseName ?? null,
      spawnTargetLabel: resolved.label,
      titleHints,
      baselineHandles: baselineWindows.map(formatWindowSummary),
      candidateHandles: selection.newCandidates.map(formatWindowSummary),
      finalHandles: finalWindows.map(formatWindowSummary),
      matchedWindow,
      selectionReason: selection.reason,
      selectionWarning:
        matchedWindow || requiresExactWindow ? null : selection.reason,
      moveResult: moveResult ?? null,
    };
  }

  if (!matchedWindow) {
    return {
      success: false,
      stage: "select_window",
      requestedFolderPath: resolved.folderPath,
      requestedWindowName: resolved.windowName ?? null,
      requestedDesktop,
      effectiveDesktop: desktopResolution.desktop ?? null,
      createDesktop: resolved.createDesktop,
      activateDesktop: resolved.activateDesktop,
      createdDesktop: desktopResolution.createdDesktop,
      desktopMode: desktopResolution.desktopMode,
      desktopActivationMode,
      spawnTargetLabel: resolved.label,
      slot: { id: options.slot.id, letter: options.slot.letter, name: options.slot.name },
      error: `Unable to isolate a unique spawned VS Code window: ${selection.reason}`,
    };
  }

  const target: LayoutTarget = {
    windowHandle: matchedWindow.handle,
    windowTitle: matchedWindow.title,
  };
  const layoutResult = await layoutManager.applySlot(options.slot.id, target);

  logToolEvent("spawn workflow layout result", {
    requestedTarget: options.requestedTarget ?? null,
    requestedFolderPath: resolved.folderPath,
    requestedDesktop,
    effectiveDesktop: desktopResolution.desktop ?? null,
    createDesktop: resolved.createDesktop,
    activateDesktop: resolved.activateDesktop,
    createdDesktop: desktopResolution.createdDesktop,
    desktopMode: desktopResolution.desktopMode,
    desktopActivationMode,
    slot: options.slot.letter,
    slotName: options.slot.name,
    target,
    success: layoutResult.success,
    error: layoutResult.error,
    logPath: layoutResult.logPath,
  });

  return {
    success: layoutResult.success,
    message: summaryParts
      .concat(`Applied layout slot ${options.slot.letter}`)
      .join(". "),
    requestedFolderPath: resolved.folderPath,
    requestedWindowName: resolved.windowName ?? null,
    requestedDesktop,
    effectiveDesktop:
      desktopResolution.desktop ?? matchedWindow.desktop ?? null,
    createDesktop: resolved.createDesktop,
    activateDesktop: resolved.activateDesktop,
    createdDesktop: desktopResolution.createdDesktop,
    desktopMode: desktopResolution.desktopMode,
    desktopActivationMode,
    derivedDesktopBaseName: desktopResolution.derivedDesktopBaseName ?? null,
    spawnTargetLabel: resolved.label,
    slot: { id: options.slot.id, letter: options.slot.letter, name: options.slot.name },
    titleHints,
    baselineHandles: baselineWindows.map(formatWindowSummary),
    candidateHandles: selection.newCandidates.map(formatWindowSummary),
    finalHandles: finalWindows.map(formatWindowSummary),
    matchedWindow,
    selectionReason: selection.reason,
    moveResult: moveResult ?? null,
    logPath: layoutResult.logPath,
    exitCode: layoutResult.exitCode ?? null,
    error: layoutResult.error,
  };
}

export async function callTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case "spawn_window": {
      const resolved = resolveSpawnInput(args);
      if ("error" in resolved) {
        return textResult(resolved.error, true);
      }
      const result = await executeSpawnWorkflow(resolved, {
        requestedTarget:
          typeof args.target === "string" ? args.target.trim() || null : null,
      });
      return textResult(
        JSON.stringify(result, null, 2),
        result.success !== true
      );
    }

    case "list_spawn_targets": {
      return textResult(JSON.stringify(spawnTargetManager.listTargets(), null, 2));
    }

    case "list_virtual_desktops": {
      try {
        return textResult(JSON.stringify(await listVirtualDesktops(), null, 2));
      } catch (error) {
        return textResult(
          `Failed to list virtual desktops: ${error instanceof Error ? error.message : String(error)}`,
          true
        );
      }
    }

    case "ensure_virtual_desktop": {
      const requestedName =
        typeof args.name === "string" ? args.name.trim() : "";
      const result = await ensureVirtualDesktop(requestedName);
      return textResult(JSON.stringify(result, null, 2), !result.success);
    }

    case "rename_virtual_desktop": {
      const currentName =
        typeof args.currentName === "string" ? args.currentName.trim() : "";
      const newName =
        typeof args.newName === "string" ? args.newName.trim() : "";
      const result = await renameVirtualDesktop(currentName, newName);
      return textResult(JSON.stringify(result, null, 2), !result.success);
    }

    case "send_prompt": {
      const connectionId = args.connectionId as string;
      const prompt = args.prompt as string;
      const connection =
        connectionManager.getConnection(connectionId) ||
        connectionManager.getConnectionByName(connectionId);

      if (!connection) {
        return textResult(`Error: Connection "${connectionId}" not found`, true);
      }

      const cfg = connection.config as VSCodeWindowConfig;

      // Try IPC first (fastest for Kilo Code:)
      if (cfg.method === "background" && cfg.socketPath) {
        try {
          const client = getOrCreateIpcClient(cfg.socketPath);
          const ready = await client.waitForReady();
          if (ready) {
            client.sendTaskMessage(prompt);
            connectionManager.updateConnectionStatus(connection.id, "active");
            return textResult(`Sent to ${connection.name} via background IPC`);
          }
        } catch (err) {
          console.warn(`[send_prompt] IPC failed for ${connection.name}, falling back to CDP:`, err);
        }
      }

      // Resolve extension: use stored value or auto-detect from current windows
      let extension = cfg.extension;
      if (!extension && (cfg.windowTitle || cfg.folderPath)) {
        const windows = await detectWindows();
        const match = windows.find(
          (w) =>
            (cfg.windowTitle && w.title.includes(cfg.windowTitle)) ||
            (cfg.folderPath && w.folderPath.includes(cfg.folderPath))
        );
        if (match) {
          extension = match.extension;
        }
      }

      // Fall back to CDP for Kilo Code:, Kimi Code:, Codex, and Claude Code:
      if (
        extension === "claude-code" ||
        extension === "codex" ||
        extension === "kilo-code" ||
        extension === "kimi-code"
      ) {
        const port = getCdpPort();
        if (port) {
          const result = await sendViaAgentCdp(port, prompt, {
            agent: extension,
            windowTitle: cfg.windowTitle,
          });
          if (result.success) {
            connectionManager.updateConnectionStatus(connection.id, "active");
            return textResult(`Sent to ${connection.name} via ${extension} CDP (background)`);
          }
          return textResult(
            `CDP send failed for ${connection.name}: ${result.error || "unknown error"}`,
            true
          );
        }
        return textResult(
          `CDP port not available for ${connection.name}. Ensure VS Code: is started with --remote-debugging-port=9222`,
          true
        );
      }

      return textResult(
        `No background method available for ${connection.name} (extension: ${extension ?? "unknown"}). Use foreground from Reprompty UI.`,
        true
      );
    }

    case "add_connection": {
      const type = args.type as ConnectionType;
      const name = args.name as string;
      const config = args.config as ConnectionConfig;
      const connection = connectionManager.addConnection(type, name, config);
      return textResult(`Added connection: ${connection.id} (${connection.name})`);
    }

    case "list_connections": {
      return textResult(JSON.stringify(connectionManager.listConnections(), null, 2));
    }

    case "remove_connection": {
      const connectionId = args.connectionId as string;
      const removed = connectionManager.removeConnection(connectionId);
      return textResult(
        removed
          ? `Removed connection ${connectionId}`
          : `Connection ${connectionId} not found`,
        !removed
      );
    }

    case "daisy_chain": {
      const prompts = args.prompts as Array<{ connectionId: string; prompt: string }>;
      const continueOnError = (args.continueOnError as boolean) || false;
      const results: string[] = [];

      for (const promptTask of prompts) {
        const connection =
          connectionManager.getConnection(promptTask.connectionId) ||
          connectionManager.getConnectionByName(promptTask.connectionId);
        if (!connection) {
          results.push(`Connection "${promptTask.connectionId}" not found`);
          if (!continueOnError) {
            break;
          }
          continue;
        }

        const cfg = connection.config as VSCodeWindowConfig;
        try {
          let sent = false;

          // Try IPC first
          if (cfg.method === "background" && cfg.socketPath) {
            try {
              const client = getOrCreateIpcClient(cfg.socketPath);
              const ready = await client.waitForReady();
              if (ready) {
                client.sendTaskMessage(promptTask.prompt);
                results.push(`Sent to ${connection.name} (background IPC)`);
                sent = true;
              }
            } catch (ipcErr) {
              console.warn(`[daisy_chain] IPC failed for ${connection.name}, trying CDP:`, ipcErr);
            }
          }

          // Resolve extension: use stored value or auto-detect from current windows
          let extension = cfg.extension;
          if (!extension && (cfg.windowTitle || cfg.folderPath)) {
            const windows = await detectWindows();
            const match = windows.find(
              (w) =>
                (cfg.windowTitle && w.title.includes(cfg.windowTitle)) ||
                (cfg.folderPath && w.folderPath.includes(cfg.folderPath))
            );
            if (match) {
              extension = match.extension;
            }
          }

          // Fall back to CDP
          if (!sent && (
            extension === "claude-code" ||
            extension === "codex" ||
            extension === "kilo-code" ||
            extension === "kimi-code"
          )) {
            const port = getCdpPort();
            if (!port) {
              throw new Error("CDP port not available");
            }
            const cdpResult = await sendViaAgentCdp(port, promptTask.prompt, {
              agent: extension,
              windowTitle: cfg.windowTitle,
            });
            if (!cdpResult.success) {
              throw new Error(cdpResult.error || "CDP failed");
            }
            results.push(`Sent to ${connection.name} (${extension} CDP)`);
            sent = true;
          }

          if (!sent) {
            throw new Error(`No background method available (extension: ${extension ?? "unknown"})`);
          }
        } catch (err) {
          results.push(`Failed: ${connection.name} - ${err}`);
          if (!continueOnError) {
            break;
          }
        }
      }

      return textResult(results.join("\n"));
    }

    case "list_scripts": {
      return textResult(JSON.stringify(scriptManager.listScripts(), null, 2));
    }

    case "run_script": {
      const scriptId = args.scriptId as string;
      const script = scriptManager.findByIdOrName(scriptId);
      if (!script) {
        return textResult(`Script not found: ${scriptId}`, true);
      }
      const started = scriptManager.runScript(script.id);
      return textResult(
        started ? `Started: ${script.name}` : `Failed to start: ${script.name}`,
        !started
      );
    }

    case "stop_script": {
      const scriptId = args.scriptId as string;
      const script = scriptManager.findByIdOrName(scriptId);
      if (!script) {
        return textResult(`Script not found: ${scriptId}`, true);
      }
      const stopped = scriptManager.stopScript(script.id);
      return textResult(
        stopped ? `Stopped: ${script.name}` : `Failed to stop: ${script.name}`,
        !stopped
      );
    }

    case "apply_layout": {
      const slotKey = args.slot as string;
      const slot = resolveLayoutSlot(slotKey);
      if (!slot) {
        const available = layoutManager
          .listSlots()
          .map((item) => `${item.letter}: ${item.name}`)
          .join(", ");
        return textResult(`Slot "${slotKey}" not found. Available: ${available}`, true);
      }
      const target: LayoutTarget = {
        windowTitle:
          typeof args.windowTitle === "string" ? args.windowTitle.trim() || undefined : undefined,
        windowHandle: parseWindowHandle(args.windowHandle),
      };

      logToolEvent("apply_layout request", {
        slot: slot.letter,
        slotName: slot.name,
        target,
      });

      const result = await layoutManager.applySlot(slot.id, target);
      logToolEvent("apply_layout result", {
        slot: slot.letter,
        slotName: slot.name,
        success: result.success,
        error: result.error,
        logPath: result.logPath,
        target,
      });

      return textResult(
        JSON.stringify(
          {
            success: result.success,
            slot: { id: slot.id, letter: slot.letter, name: slot.name },
            target,
            logPath: result.logPath,
            error: result.error,
            exitCode: result.exitCode ?? null,
          },
          null,
          2
        ),
        !result.success
      );
    }

    case "list_layout_slots": {
      return textResult(JSON.stringify(layoutManager.listSlots(), null, 2));
    }

    case "spawn_and_layout": {
      const resolved = resolveSpawnInput(args);
      if ("error" in resolved) {
        return textResult(resolved.error, true);
      }

      const slotKey = args.slot as string;
      const slot = resolveLayoutSlot(slotKey);
      if (!slot) {
        const available = layoutManager
          .listSlots()
          .map((item) => `${item.letter}: ${item.name}`)
          .join(", ");
        return textResult(`Slot "${slotKey}" not found. Available: ${available}`, true);
      }

      const result = await executeSpawnWorkflow(resolved, {
        slot,
        requestedTarget:
          typeof args.target === "string" ? args.target.trim() || null : null,
      });

      return textResult(
        JSON.stringify(result, null, 2),
        result.success !== true
      );
    }

    case "detect_windows": {
      return textResult(JSON.stringify(await detectWindows(), null, 2));
    }

    case "detect_all_windows": {
      return textResult(JSON.stringify(await detectAllWindows(), null, 2));
    }

    case "check_cdp": {
      const port = getCdpPort();
      if (!port) {
        return textResult(
          JSON.stringify(
            { available: false, reason: "DevToolsActivePort not found" },
            null,
            2
          ),
          true
        );
      }
      const available = await isCdpAvailable(port);
      return textResult(
        JSON.stringify(
          {
            available,
            port,
            agentWebview: available,
            reason: available
              ? "Agent webview found via CDP"
              : "No agent webview found among CDP targets",
          },
          null,
          2
        ),
        !available
      );
    }

    case "save_task_preset": {
      const presetName =
        typeof args.name === "string" ? args.name.trim() : "";
      if (!presetName) {
        return textResult("Preset name is required", true);
      }
      const result = await saveTaskPreset(presetName);
      return textResult(
        JSON.stringify(result, null, 2),
        !result.success
      );
    }

    case "load_task_preset": {
      const presetName =
        typeof args.name === "string" ? args.name.trim() : "";
      if (!presetName) {
        return textResult("Preset name is required", true);
      }
      const result = await loadTaskPreset(presetName);
      return textResult(
        JSON.stringify(result, null, 2),
        !result.success
      );
    }

    case "list_task_presets": {
      return textResult(JSON.stringify(listTaskPresets(), null, 2));
    }

    case "delete_task_preset": {
      const presetName =
        typeof args.name === "string" ? args.name.trim() : "";
      if (!presetName) {
        return textResult("Preset name is required", true);
      }
      const result = deleteTaskPreset(presetName);
      return textResult(
        JSON.stringify(result, null, 2),
        !result.success
      );
    }

    case "duplicate_workspace_in_new_window": {
      const windows = await detectWindows();
      const windowTitle =
        typeof args.windowTitle === "string" ? args.windowTitle.trim() : "";
      const folderPath =
        typeof args.folderPath === "string" ? args.folderPath.trim() : "";
      const slotKey = typeof args.slot === "string" ? args.slot.trim() : "";

      const target = windows.find((w) => {
        if (windowTitle && w.title.includes(windowTitle)) return true;
        if (folderPath && w.folderPath.includes(folderPath)) return true;
        // Also try matching against the resolved workspace path from the title
        if (folderPath) {
          const resolved = getWorkspacePathFromPid(w.pid, w.title);
          if (resolved && resolved.includes(folderPath)) return true;
        }
        return false;
      });

      if (!target) {
        return textResult(
          `No matching VS Code: window found. ` +
            (windowTitle ? `windowTitle="${windowTitle}" ` : "") +
            (folderPath ? `folderPath="${folderPath}"` : ""),
          true
        );
      }

      const workspacePath = getWorkspacePathFromPid(target.pid, target.title);
      if (!workspacePath) {
        return textResult(
          `Could not determine workspace path for "${target.title}" (PID ${target.pid}). The window may not have a folder/workspace open.`,
          true
        );
      }

      let openPath = workspacePath;

      // If it's a folder (not a .code-workspace file), create a temporary
      // workspace file so VS Code: always opens a new window instead of
      // focusing the existing one.
      if (!workspacePath.endsWith(".code-workspace")) {
        const tmpDir = require("node:os").tmpdir();
        const wsName = require("node:path").basename(workspacePath);
        const tmpWsFile = require("node:path").join(
          tmpDir,
          `reprompty-dup-${wsName}-${Date.now()}.code-workspace`
        );
        require("node:fs").writeFileSync(
          tmpWsFile,
          JSON.stringify({ folders: [{ path: workspacePath }], settings: {} }, null, 2),
          "utf-8"
        );
        openPath = tmpWsFile;
      }

      const baselineWindows = await detectWindows();
      const titleHints = buildSpawnTitleHints({
        folderPath: workspacePath,
        windowName: undefined,
      });

      // Spawn VS Code: in a new window — completely background, no input interference
      const child = spawn("code", ["-n", openPath], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      // Wait for the new window to appear
      const selection = await waitForSpawnedWindow(baselineWindows, titleHints);

      if (!selection.matchedWindow) {
        return textResult(
          `Duplicated workspace "${workspacePath}" in a new VS Code: window, but could not detect the new window for layout. Reason: ${selection.reason}`,
          !slotKey // error only if layout was requested
        );
      }

      // Move the new window to the same desktop as the source window
      if (target.desktop) {
        const moveResult = await moveWindowToVirtualDesktop(
          selection.matchedWindow.kdotoolHandle || selection.matchedWindow.handle,
          target.desktop
        );
        if (!moveResult.success) {
          console.warn(
            `[duplicate_workspace_in_new_window] Failed to move new window to desktop ${target.desktop}:`,
            moveResult.error
          );
        }
      }

      // Apply layout if slot was requested
      if (slotKey) {
        const slot = resolveLayoutSlot(slotKey);
        if (!slot) {
          const available = layoutManager
            .listSlots()
            .map((item) => `${item.letter}: ${item.name}`)
            .join(", ");
          return textResult(
            `Duplicated workspace "${workspacePath}". Slot "${slotKey}" not found. Available: ${available}`,
            true
          );
        }

        const layoutTarget: LayoutTarget = {
          // Pass windowTitle instead of windowHandle — the layout daemon
          // on Linux/Wayland matches by kdotool UUID or title substring.
          // PID-based handles don't work across VS Code: windows since
          // they all share the same process.
          windowTitle: selection.matchedWindow.title,
          kdotoolHandle: selection.matchedWindow.kdotoolHandle,
        };
        const layoutResult = await layoutManager.applySlot(slot.id, layoutTarget);

        return textResult(
          layoutResult.success
            ? `Duplicated workspace "${workspacePath}" and applied layout slot ${slot.letter}`
            : `Duplicated workspace "${workspacePath}" but layout failed: ${layoutResult.error}`,
          !layoutResult.success
        );
      }

      return textResult(
        `Duplicated workspace "${workspacePath}" in a new VS Code: window`
      );
    }

    default: {
      const generatedTool = scriptManager.findGeneratedMcpTool(toolName);
      if (generatedTool) {
        const result = await scriptManager.runGeneratedMcpTool(toolName);
        return textResult(JSON.stringify(result, null, 2), !result.success);
      }
      return textResult(`Unknown tool: ${toolName}`, true);
    }
  }
}

export async function runMCPTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const result = await callTool(toolName, args);
  return result.content[0]?.text || "No result";
}

console.log("Reprompty MCP server loaded");
console.log("Available tools:", getTools().map((tool) => tool.name).join(", "));
