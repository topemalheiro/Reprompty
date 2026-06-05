// Platform-specific virtual desktop manager
import type {
  VirtualDesktopInfo,
  WindowDesktopInfo,
  VirtualDesktopMutationResult,
  EnsureVirtualDesktopResult,
  MoveWindowToVirtualDesktopResult,
} from "./virtual-desktop-manager-windows.js";

const isWindows = process.platform === "win32";

// Dynamically import the platform implementation
let windowsImpl: typeof import("./virtual-desktop-manager-windows.js") | null = null;
let linuxImpl: typeof import("./virtual-desktop-manager-linux.js") | null = null;

async function getImpl() {
  if (isWindows) {
    if (!windowsImpl) {
      windowsImpl = await import("./virtual-desktop-manager-windows.js");
    }
    return windowsImpl;
  }
  if (!linuxImpl) {
    linuxImpl = await import("./virtual-desktop-manager-linux.js");
  }
  return linuxImpl;
}

// Re-export types
export type {
  VirtualDesktopInfo,
  WindowDesktopInfo,
  VirtualDesktopMutationResult,
  EnsureVirtualDesktopResult,
  MoveWindowToVirtualDesktopResult,
} from "./virtual-desktop-manager-windows.js";

// Wrapper functions
export async function listVirtualDesktops(): Promise<VirtualDesktopInfo[]> {
  return (await getImpl()).listVirtualDesktops();
}

export async function createVirtualDesktop(
  name?: string
): Promise<VirtualDesktopMutationResult> {
  return (await getImpl()).createVirtualDesktop(name);
}

export async function ensureVirtualDesktop(
  requestedName: string
): Promise<EnsureVirtualDesktopResult> {
  return (await getImpl()).ensureVirtualDesktop(requestedName);
}

export async function renameVirtualDesktop(
  currentName: string,
  newName: string
): Promise<VirtualDesktopMutationResult> {
  return (await getImpl()).renameVirtualDesktop(currentName, newName);
}

export async function switchToVirtualDesktop(
  requestedName: string
): Promise<{ success: boolean; desktop?: VirtualDesktopInfo; error?: string }> {
  return (await getImpl()).switchToVirtualDesktop(requestedName);
}

export async function moveWindowToVirtualDesktop(
  windowHandle: number | string,
  requestedName: string
): Promise<MoveWindowToVirtualDesktopResult> {
  return (await getImpl()).moveWindowToVirtualDesktop(windowHandle, requestedName);
}

export async function getWindowDesktopAssignments(
  handles: number[]
): Promise<WindowDesktopInfo[]> {
  return (await getImpl()).getWindowDesktopAssignments(handles);
}

// Re-export synchronous utility functions from Windows impl (they're platform-agnostic)
export {
  deriveVirtualDesktopName,
  makeUniqueVirtualDesktopName,
  planEnsureVirtualDesktop,
  validateVirtualDesktopRename,
  resolveVirtualDesktopByName,
} from "./virtual-desktop-manager-windows.js";
