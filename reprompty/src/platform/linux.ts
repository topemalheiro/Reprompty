import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import nodePath from "node:path";
import {
  findWindowAgentState,
  getWindowAgentStates,
  type AgentKind,
} from "../core/cdp-client.js";
import {
  getWindowDesktopAssignments,
} from "../core/virtual-desktop-manager.js";

export interface WindowInfo {
  pid: number;
  title: string;
  socketPath: string;
  processName?: string;
  /** KDE Wayland kdotool UUID handle (if available) */
  kdotoolHandle?: string;
}

const VS_CODE_PROCESS_NAMES = new Set(["code", "code-oss", "vscodium", "codium"]);
const KILO_CODE_PROCESS_NAMES = new Set(["kilocode"]);
const SUPPORTED_EDITOR_PROCESS_NAMES = new Set([
  ...VS_CODE_PROCESS_NAMES,
  ...KILO_CODE_PROCESS_NAMES,
]);

/** Known editor window title substrings for detection */
const EDITOR_TITLE_SUBSTRINGS = [
  "Visual Studio Code",
  "Kilo Code",
  "Kimi Code",
  "VSCodium",
  "Code: - OSS",
];

function isEditorWindowTitle(title: string): boolean {
  return EDITOR_TITLE_SUBSTRINGS.some((substring) => title.includes(substring));
}
const KILO_PIPE_PREFIXES = ["kilo-ipc-", "kilo-code-", "roo-code-"];

function isWaylandSession(): boolean {
  return process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY;
}

function getKdotoolPath(): string {
  return nodePath.join(process.env.HOME || "", ".local", "bin", "kdotool");
}

function hasKdotool(): boolean {
  try {
    fs.accessSync(getKdotoolPath(), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function listWindowsKdotool(): Array<{ pid: number; title: string; processName: string; handle: string }> {
  const kdotoolPath = getKdotoolPath();
  const results: Array<{ pid: number; title: string; processName: string; handle: string }> = [];
  const seenHandles = new Set<string>();

  for (const term of EDITOR_TITLE_SUBSTRINGS) {
    try {
      const output = execSync(
        `"${kdotoolPath}" search --title ${JSON.stringify(term)} --limit 0`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();

      const lines = output.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
      for (const handleStr of lines) {
        try {
          if (seenHandles.has(handleStr)) {
            continue;
          }
          seenHandles.add(handleStr);

          const title = execSync(
            `"${kdotoolPath}" getwindowname ${handleStr}`,
            { encoding: "utf-8", timeout: 2000 }
          ).trim();

          if (!title || !isEditorWindowTitle(title)) {
            continue;
          }

          let pid = 0;
          try {
            const pidStr = execSync(
              `"${kdotoolPath}" getwindowpid ${handleStr}`,
              { encoding: "utf-8", timeout: 2000 }
            ).trim();
            pid = parseInt(pidStr, 10);
          } catch {
            pid = 0;
          }

          // Intentionally not deduping by PID here: a single process may own
          // multiple editor windows (e.g. VS Code: with multiple folders open).

          let processName = "";
          if (pid) {
            try {
              processName = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf-8", timeout: 2000 }).trim();
            } catch {
              processName = "";
            }
          }

          if (!processName) {
            processName = fallbackProcessNameFromTitle(title);
          }

          if (!isSupportedEditorProcessName(processName)) {
            continue;
          }

          results.push({ pid, title, processName, handle: handleStr });
        } catch {
          // skip individual window errors
        }
      }
    } catch {
      // search term failed
    }
  }

  return results;
}

function findKdotoolHandleByPid(pid: number): string | null {
  if (!hasKdotool()) return null;
  const kdotoolPath = getKdotoolPath();
  try {
    const output = execSync(
      `"${kdotoolPath}" search ".*"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    const lines = output.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
    for (const handle of lines) {
      try {
        const pidStr = execSync(
          `"${kdotoolPath}" getwindowpid ${handle}`,
          { encoding: "utf-8", timeout: 2000 }
        ).trim();
        if (parseInt(pidStr, 10) === pid) {
          return handle;
        }
      } catch {
        // continue
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function getWritableTempDir(): string {
  const candidates = [
    process.env.XDG_RUNTIME_DIR,
    process.env.TMPDIR,
    process.env.TEMP,
    process.env.TMP,
    "/tmp",
    ".",
  ].filter((value): value is string => Boolean(value));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // Try next candidate
    }
  }

  return ".";
}

export function normalizeEditorProcessName(name?: string | null): string {
  return (name ?? "").trim().replace(/\.exe$/i, "").toLowerCase();
}

export function isSupportedEditorProcessName(name?: string | null): boolean {
  const normalizedName = normalizeEditorProcessName(name);
  return SUPPORTED_EDITOR_PROCESS_NAMES.has(normalizedName);
}

export function fallbackProcessNameFromTitle(title: string): string {
  return title.includes("Kilo Code") || title.includes("Kimi Code") ? "kilocode" : "code";
}

export function buildKiloPipeCandidates(pid: number): string[] {
  const tmpDir = getWritableTempDir();
  return KILO_PIPE_PREFIXES.map((prefix) =>
    nodePath.join(tmpDir, `${prefix}${pid}.sock`)
  );
}

function findLegacyKiloPipeFallback(): string | null {
  try {
    const tmpDir = getWritableTempDir();
    const names = fs
      .readdirSync(tmpDir)
      .filter((name) =>
        KILO_PIPE_PREFIXES.some((prefix) => name.toLowerCase().startsWith(prefix))
      );
    if (names.length === 1) {
      return nodePath.join(tmpDir, names[0]);
    }
  } catch {
    // Ignore pipe enumeration failures
  }
  return null;
}

export function resolveKiloPipePath(pid: number): string | null {
  const candidates = buildKiloPipeCandidates(pid);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch {
      // Try next candidate
    }
  }

  return findLegacyKiloPipeFallback();
}

export function resolveDetectedWindowProcessName(
  processName: string | null | undefined,
  title: string
): string {
  const trimmedProcessName = (processName ?? "").trim();
  return trimmedProcessName || fallbackProcessNameFromTitle(title);
}

/**
 * Spawn a new VS Code window using the CLI
 */
export function spawnWindow(
  folderPath: string,
  _windowName?: string,
  _desktop?: string
): Promise<{ success: boolean; pid?: number; message: string; desktop?: string }> {
  return (async () => {
    try {
      // Find code executable in PATH
      let codePath: string | null = null;
      try {
        codePath = execSync("which code", { encoding: "utf-8", timeout: 5000 }).trim();
      } catch {
        codePath = null;
      }

      if (!codePath) {
        // Try common locations
        const commonPaths = [
          "/usr/bin/code",
          "/usr/local/bin/code",
          "/opt/visual-studio-code/bin/code",
          "/usr/share/code/bin/code",
          "/snap/bin/code",
          "/usr/bin/codium",
          "/usr/local/bin/codium",
          "/snap/bin/codium",
        ];
        for (const p of commonPaths) {
          if (fs.existsSync(p)) {
            codePath = p;
            break;
          }
        }
      }

      if (!codePath || !fs.existsSync(codePath)) {
        return { success: false, message: "code executable not found in PATH" };
      }

      const result = execSync(
        `\"${codePath}\" --remote-debugging-port=9222 -n \"${folderPath}\" &`,
        { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }
      ).trim();

      return {
        success: true,
        message: `Spawned VS Code: window for ${folderPath}${result ? ` (${result})` : ""}`,
      };
    } catch (error: any) {
      const stderr = error.stderr ? String(error.stderr).trim() : "";
      const msg = stderr || error.message || String(error);
      return {
        success: false,
        message: `Failed to spawn window: ${msg}`,
      };
    }
  })();
}

/**
 * Find a VS Code: window by title.
 * On Wayland falls back to process-based matching since xdotool does not work
 * for native Wayland windows.
 */
export function findWindowByTitle(windowTitle: string): WindowInfo | null {
  // Try X11/xdotool first
  try {
    const output = execSync(
      `xdotool search --name "${windowTitle}"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();

    if (!output) throw new Error("xdotool empty output");

    const handles = output.split("\n").map((l) => l.trim()).filter(Boolean);
    if (handles.length === 0) throw new Error("xdotool no handles");

    const handle = parseInt(handles[0], 10);
    const title = execSync(`xdotool getwindowname ${handle}`, { encoding: "utf-8" }).trim();

    if (!isEditorWindowTitle(title)) {
      return null;
    }

    let pid = 0;
    try {
      pid = parseInt(
        execSync(`xdotool getwindowpid ${handle}`, { encoding: "utf-8" }).trim(),
        10
      );
    } catch {
      pid = 0;
    }

    const socketPath = resolveKiloPipePath(pid) ?? `/tmp/kilo-ipc-${pid}.sock`;

    return {
      pid,
      title,
      socketPath,
    };
  } catch {
    // xdotool failed — fall through to Wayland/process fallback
  }

  // Wayland fallback: match by process title
  if (isWaylandSession()) {
    for (const proc of listEditorProcesses()) {
      if (proc.title.toLowerCase().includes(windowTitle.toLowerCase())) {
        return {
          pid: proc.pid,
          title: proc.title,
          socketPath: resolveKiloPipePath(proc.pid) ?? `/tmp/kilo-ipc-${proc.pid}.sock`,
        };
      }
    }
  }

  return null;
}

/**
 * Get the default IPC socket path for Kilo Code
 */
export function getDefaultSocketPath(): string {
  return resolveKiloPipePath(process.pid) ?? `/tmp/kilo-ipc-${process.pid}.sock`;
}

/**
 * Fallback window detection for Wayland using process listing.
 * wmctrl/xdotool do not work for native Wayland windows.
 */
function listEditorProcesses(): Array<{ pid: number; processName: string; title: string }> {
  const results: Array<{ pid: number; processName: string; title: string }> = [];
  try {
    // Find all candidate editor processes
    const psOutput = execSync(
      "ps -eo pid,comm,args",
      { encoding: "utf-8", timeout: 5000 }
    );

    const lines = psOutput.split("\n").map((l) => l.trim()).filter(Boolean);
    const seenPids = new Set<number>();

    for (const line of lines) {
      // Parse: PID COMMAND ARGS...
      const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) continue;

      const pid = parseInt(match[1], 10);
      const comm = match[2];
      const args = match[3];

      if (seenPids.has(pid)) continue;

      const normalizedComm = normalizeEditorProcessName(comm);
      if (!SUPPORTED_EDITOR_PROCESS_NAMES.has(normalizedComm)) {
        continue;
      }

      // Skip helper processes (zygote, gpu, renderer, crashpad)
      if (args.includes("--type=zygote") || args.includes("--type=gpu") || args.includes("--type=renderer") || args.includes("crashpad")) {
        continue;
      }

      // Extract folder path from args if available
      let title = "";
      const folderMatch = args.match(/\s+(-n|--new-window)\s+"?([^"]+)"?/);
      if (folderMatch) {
        title = folderMatch[2];
      } else {
        // Try to find a folder path in the args
        const pathMatch = args.match(/\s+([^\s-][^\s]*)\s*$/);
        if (pathMatch && !pathMatch[1].startsWith("-")) {
          title = pathMatch[1];
        }
      }

      // Build a synthetic title similar to X11 window titles
      const displayTitle = title ? `${nodePath.basename(title)} - Visual Studio Code:` : "Visual Studio Code:";

      seenPids.add(pid);
      results.push({
        pid,
        processName: normalizedComm,
        title: displayTitle,
      });
    }
  } catch (err) {
    console.error("[listEditorProcesses] Error:", err);
  }

  return results;
}

/**
 * List all VS Code: / Kilo Code windows
 */
export function listWindows(): WindowInfo[] {
  const windows: WindowInfo[] = [];

  try {
    const output = execSync(
      "wmctrl -l -p",
      { encoding: "utf-8", timeout: 5000 }
    );

    const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 4) continue;

      const handle = parseInt(parts[0], 16);
      const pid = parseInt(parts[2], 10);
      const title = parts.slice(3).join(" ");

      if (!isEditorWindowTitle(title)) {
        continue;
      }

      let processName = "";
      try {
        processName = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf-8", timeout: 2000 }).trim();
      } catch {
        processName = "";
      }

      if (!isSupportedEditorProcessName(processName)) {
        continue;
      }

      windows.push({
        pid,
        title,
        socketPath: resolveKiloPipePath(pid) ?? `/tmp/kilo-ipc-${pid}.sock`,
        processName,
      });
    }
  } catch {
    // wmctrl failed — likely on Wayland or not installed
  }

  // KDE Wayland: use kdotool for real window titles before falling back to ps
  if (windows.length === 0 && hasKdotool()) {
    for (const win of listWindowsKdotool()) {
      windows.push({
        pid: win.pid,
        title: win.title,
        socketPath: resolveKiloPipePath(win.pid) ?? `/tmp/kilo-ipc-${win.pid}.sock`,
        processName: win.processName,
        kdotoolHandle: win.handle,
      });
    }
  }

  // Wayland fallback: if no editor windows found via wmctrl or kdotool, use process listing
  if (windows.length === 0 && isWaylandSession()) {
    for (const proc of listEditorProcesses()) {
      windows.push({
        pid: proc.pid,
        title: proc.title,
        socketPath: resolveKiloPipePath(proc.pid) ?? `/tmp/kilo-ipc-${proc.pid}.sock`,
        processName: proc.processName,
      });
    }
  }

  return windows;
}

/**
 * Send a message to a window via foreground clipboard+key simulation.
 * On X11 uses xdotool. On Wayland uses kdotool windowactivate + wl-copy + wtype/ydotool.
 */
export async function sendMessageForeground(
  windowHandle: number,
  message: string
): Promise<boolean> {
  try {
    const tempDir = getWritableTempDir();
    const msgFile = nodePath.join(tempDir, `reprompty-msg-${Date.now()}.txt`);
    fs.writeFileSync(msgFile, message, "utf-8");

    if (isWaylandSession()) {
      // Wayland path: kdotool focus + wl-copy + wtype/ydotool
      const kdotoolPath = getKdotoolPath();
      const kdotoolHandle = hasKdotool() ? findKdotoolHandleByPid(windowHandle) : null;

      const script = `
#!/bin/bash
msg_file="${msgFile}"
message=$(cat "$msg_file")
rm -f "$msg_file"

# Copy to clipboard (wl-copy for Wayland)
if command -v wl-copy >/dev/null 2>&1; then
  echo -n "$message" | wl-copy
else
  echo "wl-copy not available" >&2
  exit 1
fi

# Focus window using kdotool if available
${kdotoolHandle ? `"${kdotoolPath}" windowactivate ${kdotoolHandle}` : "# kdotool handle not found"}
${kdotoolHandle ? "sleep 0.15" : "# skipping focus wait"}

# Paste and send — prefer wtype (no daemon), fall back to ydotool
if command -v wtype >/dev/null 2>&1; then
  wtype -M ctrl -k v -m ctrl
  sleep 0.1
  wtype -k Return
elif command -v ydotool >/dev/null 2>&1; then
  # Ensure ydotoold socket is available; start if needed
  if [ ! -S /run/user/$(id - u)/ydotoold_socket ]; then
    ydotoold --socket-path=/run/user/$(id - u)/ydotoold_socket --socket-own=$(id - u):$(id - g) &
    sleep 0.5
  fi
  export YDOTOOL_SOCKET=/run/user/$(id - u)/ydotoold_socket
  ydotool key 29:1 47:1 47:0 29:0
  sleep 0.1
  ydotool key 28:1 28:0
else
  echo "No typing tool available (wtype or ydotool)" >&2
  exit 1
fi

echo "sent"
`;
      const shFile = nodePath.join(tempDir, `reprompty-send-${Date.now()}.sh`);
      fs.writeFileSync(shFile, script, "utf-8");
      fs.chmodSync(shFile, 0o755);

      const result = execSync(`"${shFile}"`, { encoding: "utf-8", timeout: 10000 }).trim();
      try { fs.unlinkSync(shFile); } catch { /* ignore */ }
      return result.includes("sent");
    }

    // X11 path: xclip/xsel + xdotool
    const script = `
#!/bin/bash
msg_file="${msgFile}"
handle="${windowHandle}"
message=$(cat "$msg_file")
rm -f "$msg_file"

# Copy to clipboard
if command -v xclip >/dev/null 2>&1; then
  echo -n "$message" | xclip -selection clipboard
elif command -v xsel >/dev/null 2>&1; then
  echo -n "$message" | xsel --clipboard --input
else
  echo "No clipboard tool available" >&2
  exit 1
fi

# Focus window
xdotool windowactivate "$handle"
sleep 0.15

# Paste
xdotool key --clearmodifiers ctrl+v
sleep 0.1

# Press Enter
xdotool key --clearmodifiers Return
sleep 0.05

echo "sent"
`;

    const shFile = nodePath.join(tempDir, `reprompty-send-${Date.now()}.sh`);
    fs.writeFileSync(shFile, script, "utf-8");
    fs.chmodSync(shFile, 0o755);

    const result = execSync(
      `"${shFile}"`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();

    try { fs.unlinkSync(shFile); } catch { /* ignore */ }

    return result.includes("sent");
  } catch (err) {
    console.error("[sendMessageForeground] Error:", err);
    return false;
  }
}

// ============================================================================
// WINDOW AUTO-DETECTION
// ============================================================================

export interface DetectedWindow {
  pid: number;
  handle: number;
  title: string;
  folderPath: string;
  processName: string;
  desktop?: string;
  isCurrentDesktop?: boolean;
  extension: AgentKind;
  activeAgent: AgentKind;
  availableAgents: Array<Exclude<AgentKind, "unknown">>;
  backgroundRoute: "ipc-kilo" | "cdp-kilo" | "cdp-claude" | "cdp-codex" | "cdp-kimi" | "foreground";
  pipePath: string | null;
  sendMethod: "background" | "foreground";
  /** KDE Wayland kdotool UUID handle (if available) */
  kdotoolHandle?: string;
}

export function resolveBackgroundRoute(
  activeAgent: AgentKind,
  availableAgents: Array<Exclude<AgentKind, "unknown">>,
  pipeExists: boolean
): DetectedWindow["backgroundRoute"] {
  if (activeAgent === "kilo-code" && pipeExists) {
    return "ipc-kilo";
  }
  if (activeAgent === "kilo-code" && availableAgents.includes("kilo-code")) {
    return "cdp-kilo";
  }
  if (activeAgent === "kimi-code" && availableAgents.includes("kimi-code")) {
    return "cdp-kimi";
  }
  if (activeAgent === "codex" && availableAgents.includes("codex")) {
    return "cdp-codex";
  }
  if (activeAgent === "claude-code" && availableAgents.includes("claude-code")) {
    return "cdp-claude";
  }
  // When agent is unknown, prefer Kilo Code: as the "start with" agent
  if (activeAgent === "unknown" && availableAgents.includes("kilo-code")) {
    return "cdp-kilo";
  }
  if (activeAgent === "unknown" && availableAgents.includes("kimi-code")) {
    return "cdp-kimi";
  }
  if (activeAgent === "unknown" && availableAgents.includes("codex")) {
    return "cdp-codex";
  }
  return "foreground";
}

/**
 * Auto-detect all VS Code: / Kilo Code windows with their capabilities.
 * On Wayland falls back to process-based detection since wmctrl/xdotool
 * do not work for native Wayland windows.
 */
export async function detectWindows(): Promise<DetectedWindow[]> {
  let lines: string[] = [];
  let useWaylandFallback = false;

  try {
    const raw = execSync("wmctrl -l -p", { encoding: "utf-8", timeout: 10000 }).trim();
    lines = raw.split("\n").map((l) => l.trim()).filter((l) => l);
  } catch {
    // wmctrl not available or no windows — fall back on Wayland
    useWaylandFallback = isWaylandSession();
  }

  const seen = new Set<number>();
  const results: DetectedWindow[] = [];
  const port = getCdpPort();
  const agentStates = port ? await getWindowAgentStates(port).catch(() => []) : [];

  // Fetch virtual desktop names for mapping kdotool desktop indices (eagerly loaded)
  let virtualDesktops: Array<{ index: number; name: string; isCurrent: boolean }> = [];
  if (hasKdotool()) {
    try {
      const { listVirtualDesktops } = await import("../core/virtual-desktop-manager.js");
      virtualDesktops = await listVirtualDesktops();
    } catch {
      virtualDesktops = [];
    }
  }

  // Build handle list for desktop assignment lookup
  const x11Handles = lines
    .map((line) => {
      const parts = line.split(/\s+/);
      return parseInt(parts[0], 16);
    })
    .filter((handle) => Number.isFinite(handle) && handle > 0);

  const desktopAssignments = await getWindowDesktopAssignments(x11Handles).catch(() => []);
  const desktopByHandle = new Map(
    desktopAssignments.map((assignment) => [assignment.handle, assignment])
  );

  // Process X11 windows from wmctrl
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;

    const handle = parseInt(parts[0], 16);
    const pid = parseInt(parts[2], 10);
    const title = parts.slice(3).join(" ");

    if (!isEditorWindowTitle(title)) continue;
    if (seen.has(handle)) continue;
    seen.add(handle);

    let rawProcessName = "";
    try {
      rawProcessName = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf-8", timeout: 2000 }).trim();
    } catch {
      rawProcessName = "";
    }

    if (rawProcessName && !isSupportedEditorProcessName(rawProcessName)) continue;

    const titleMatch = title.match(/^(.+?)\s+-\s+(Visual Studio Code|Kilo Code|Kimi Code|VSCodium|Code: - OSS)/);
    const folderPath = titleMatch ? titleMatch[1].trim() : "";
    const processName = resolveDetectedWindowProcessName(rawProcessName, title);
    const normalizedProcessName = normalizeEditorProcessName(processName);
    const isKilo = normalizedProcessName === "kilocode" || title.includes("Kilo Code") || title.includes("Kimi Code");
    const pipePath = resolveKiloPipePath(pid);
    const pipeExists = Boolean(pipePath);
    const agentState = findWindowAgentState(agentStates, title);
    const activeAgent = agentState?.activeAgent ?? "unknown";
    const availableAgents = agentState?.availableAgents ?? [];
    const legacyExtension: DetectedWindow["extension"] = pipeExists
      ? "kilo-code"
      : isKilo
      ? "kilo-code"
      : "kilo-code";
    const backgroundRoute = resolveBackgroundRoute(activeAgent, availableAgents, pipeExists);
    const desktopAssignment = desktopByHandle.get(handle);
    const sendMethod: DetectedWindow["sendMethod"] =
      backgroundRoute === "foreground" ? "foreground" : "background";
    const extension: DetectedWindow["extension"] =
      activeAgent === "unknown" ? legacyExtension : activeAgent;

    results.push({
      pid,
      handle,
      title,
      folderPath,
      processName,
      desktop: desktopAssignment?.desktop,
      isCurrentDesktop: desktopAssignment?.isCurrentDesktop,
      extension,
      activeAgent,
      availableAgents,
      backgroundRoute,
      pipePath: pipeExists ? pipePath : null,
      sendMethod,
    });
  }

  // KDE Wayland kdotool path: when wmctrl found no editor windows, try kdotool
  if (results.length === 0 && hasKdotool()) {
    const kdotoolWindows = listWindowsKdotool();
    const seenKdotoolHandles = new Set<string>();
    for (const win of kdotoolWindows) {
      if (seenKdotoolHandles.has(win.handle)) continue;
      seenKdotoolHandles.add(win.handle);

      const titleMatch = win.title.match(/^(.+?)\s+-\s+(Visual Studio Code|Kilo Code|Kimi Code|VSCodium|Code: - OSS)/);
      const folderPath = titleMatch ? titleMatch[1].trim() : "";
      const isKilo = win.processName === "kilocode" || win.title.includes("Kilo Code") || win.title.includes("Kimi Code");
      const pipePath = resolveKiloPipePath(win.pid);
      const pipeExists = Boolean(pipePath);
      const agentState = findWindowAgentState(agentStates, win.title);
      const activeAgent = agentState?.activeAgent ?? "unknown";
      const availableAgents = agentState?.availableAgents ?? [];
      const legacyExtension: DetectedWindow["extension"] = pipeExists
        ? "kilo-code"
        : isKilo
        ? "kilo-code"
        : "kilo-code";
      const backgroundRoute = resolveBackgroundRoute(activeAgent, availableAgents, pipeExists);
      const sendMethod: DetectedWindow["sendMethod"] =
        backgroundRoute === "foreground" ? "foreground" : "background";
      const extension: DetectedWindow["extension"] =
        activeAgent === "unknown" ? legacyExtension : activeAgent;

      // Query desktop assignment via kdotool
      let desktop: string | undefined;
      let isCurrentDesktop: boolean | undefined;
      if (win.handle) {
        try {
          const desktopIndexStr = execSync(
            `"${getKdotoolPath()}" get_desktop_for_window ${win.handle}`,
            { encoding: "utf-8", timeout: 2000 }
          ).trim();
          const desktopIndex = parseInt(desktopIndexStr, 10);
          const desktopInfo = virtualDesktops.find((d) => d.index === desktopIndex);
          if (desktopInfo) {
            desktop = desktopInfo.name;
            isCurrentDesktop = desktopInfo.isCurrent;
          }
        } catch {
          // ignore desktop query errors
        }
      }

      results.push({
        pid: win.pid,
        handle: win.pid, // On Wayland there is no X11 handle; use PID as surrogate
        title: win.title,
        folderPath,
        processName: win.processName,
        desktop,
        isCurrentDesktop,
        extension,
        activeAgent,
        availableAgents,
        backgroundRoute,
        pipePath: pipeExists ? pipePath : null,
        sendMethod,
        kdotoolHandle: win.handle,
      });
    }
  }

  // Wayland fallback: if no editor windows found, use process listing
  if (results.length === 0 && (useWaylandFallback || isWaylandSession())) {
    for (const proc of listEditorProcesses()) {
      if (seen.has(proc.pid)) continue;
      seen.add(proc.pid);

      const titleMatch = proc.title.match(/^(.+?)\s+-\s+(Visual Studio Code|Kilo Code|Kimi Code|VSCodium|Code: - OSS)/);
      const folderPath = titleMatch ? titleMatch[1].trim() : "";
      const isKilo = proc.processName === "kilocode" || proc.title.includes("Kilo Code") || proc.title.includes("Kimi Code");
      const pipePath = resolveKiloPipePath(proc.pid);
      const pipeExists = Boolean(pipePath);
      const agentState = findWindowAgentState(agentStates, proc.title);
      const activeAgent = agentState?.activeAgent ?? "unknown";
      const availableAgents = agentState?.availableAgents ?? [];
      const legacyExtension: DetectedWindow["extension"] = pipeExists
        ? "kilo-code"
        : isKilo
        ? "kilo-code"
        : "kilo-code";
      const backgroundRoute = resolveBackgroundRoute(activeAgent, availableAgents, pipeExists);
      const sendMethod: DetectedWindow["sendMethod"] =
        backgroundRoute === "foreground" ? "foreground" : "background";
      const extension: DetectedWindow["extension"] =
        activeAgent === "unknown" ? legacyExtension : activeAgent;

      results.push({
        pid: proc.pid,
        handle: proc.pid, // On Wayland there is no X11 handle; use PID as surrogate
        title: proc.title,
        folderPath,
        processName: proc.processName,
        desktop: undefined,
        isCurrentDesktop: undefined,
        extension,
        activeAgent,
        availableAgents,
        backgroundRoute,
        pipePath: pipeExists ? pipePath : null,
        sendMethod,
      });
    }
  }

  return results;
}

function parseArgvJson(portFile: string): number | null {
  try {
    if (!fs.existsSync(portFile)) return null;
    const raw = fs.readFileSync(portFile, "utf-8");
    const parsed = JSON.parse(raw);
    const port = parsed["remote-debugging-port"];
    if (typeof port === "number" || typeof port === "string") {
      const n = parseInt(String(port), 10);
      if (!isNaN(n)) return n;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

export interface AllWindowInfo {
  handle: number;
  pid: number;
  title: string;
  processName: string;
  /** KDE Wayland kdotool UUID handle (if available) */
  kdotoolHandle?: string;
}

/**
 * Detect ALL visible windows on the desktop (not just editors).
 * On Wayland falls back to process listing since wmctrl does not see
 * native Wayland windows.
 */
export function detectAllWindows(): AllWindowInfo[] {
  const windows: AllWindowInfo[] = [];

  // On KDE Wayland, kdotool is the only reliable source for native windows.
  // Use it as primary when available.
  if (hasKdotool()) {
    try {
      const kdotoolPath = getKdotoolPath();
      const output = execSync(
        `"${kdotoolPath}" search ".*"`,
        { encoding: "utf-8", timeout: 10000 }
      );
      const lines = output.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
      const seenHandles = new Set<string>();

      for (const handle of lines) {
        if (seenHandles.has(handle)) continue;
        seenHandles.add(handle);

        let title = "";
        try {
          title = execSync(
            `"${kdotoolPath}" getwindowname ${handle}`,
            { encoding: "utf-8", timeout: 2000 }
          ).trim();
        } catch {
          continue;
        }
        if (!title) continue;

        let pid = 0;
        try {
          const pidStr = execSync(
            `"${kdotoolPath}" getwindowpid ${handle}`,
            { encoding: "utf-8", timeout: 2000 }
          ).trim();
          pid = parseInt(pidStr, 10);
        } catch {
          pid = 0;
        }

        let processName = "";
        if (pid) {
          try {
            processName = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf-8", timeout: 2000 }).trim();
          } catch {
            processName = "";
          }
        }

        windows.push({
          handle: pid || 0,
          pid: pid || 0,
          title,
          processName: processName || "unknown",
          kdotoolHandle: handle,
        });
      }
    } catch (err) {
      console.error("[detectAllWindows] kdotool error:", err);
    }
  }

  // Fallback to wmctrl for X11 / XWayland windows kdotool may have missed
  if (windows.length === 0) {
    try {
      const output = execSync("wmctrl -l -p", { encoding: "utf-8", timeout: 10000 });
      const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);

      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 4) continue;

        const handle = parseInt(parts[0], 16);
        const pid = parseInt(parts[2], 10);
        const title = parts.slice(3).join(" ");

        if (!title.trim()) continue;

        let processName = "";
        try {
          processName = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf-8", timeout: 2000 }).trim();
        } catch {
          processName = "";
        }

        windows.push({
          handle,
          pid,
          title,
          processName: processName || "unknown",
        });
      }
    } catch {
      // wmctrl failed
    }
  }

  // Final fallback: process listing if neither kdotool nor wmctrl worked
  if (windows.length === 0 && isWaylandSession()) {
    try {
      const psOutput = execSync("ps -eo pid,comm,args", { encoding: "utf-8", timeout: 5000 });
      const lines = psOutput.split("\n").map((l) => l.trim()).filter(Boolean);
      const seenPids = new Set<number>();

      for (const line of lines) {
        const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
        if (!match) continue;

        const pid = parseInt(match[1], 10);
        const comm = match[2];
        const args = match[3];

        if (seenPids.has(pid)) continue;

        // Skip kernel threads and simple helper processes
        if (comm.startsWith("[")) continue;
        if (args.includes("--type=zygote") || args.includes("--type=gpu") || args.includes("--type=renderer") || args.includes("crashpad")) continue;

        seenPids.add(pid);
        windows.push({
          handle: pid,
          pid,
          title: comm,
          processName: comm,
        });
      }
    } catch (err) {
      console.error("[detectAllWindows] Wayland ps fallback error:", err);
    }
  }

  return windows;
}

/**
 * Get the CDP (Chrome DevTools Protocol) port from VS Code:'s DevToolsActivePort file.
 * Falls back to parsing ~/.vscode/argv.json for "remote-debugging-port".
 * Returns null if not available.
 */
export function getCdpPort(): number | null {
  try {
    const homeDir = process.env.HOME;
    if (!homeDir) return null;

    // Try Code: first, then VSCodium
    const candidates = [
      nodePath.join(homeDir, ".config", "Code", "DevToolsActivePort"),
      nodePath.join(homeDir, ".config", "VSCodium", "DevToolsActivePort"),
      nodePath.join(homeDir, ".config", "Code - OSS", "DevToolsActivePort"),
    ];

    for (const portFile of candidates) {
      if (!fs.existsSync(portFile)) continue;

      const content = fs.readFileSync(portFile, "utf-8").trim();
      const port = parseInt(content.split("\n")[0], 10);
      if (!isNaN(port)) return port;
    }

    // Fallback to argv.json
    const argvCandidates = [
      nodePath.join(homeDir, ".vscode", "argv.json"),
      nodePath.join(homeDir, ".config", "VSCodium", "argv.json"),
      nodePath.join(homeDir, ".config", "Code - OSS", "argv.json"),
    ];
    for (const argvFile of argvCandidates) {
      const port = parseArgvJson(argvFile);
      if (port !== null) return port;
    }

    return null;
  } catch {
    return null;
  }
}
