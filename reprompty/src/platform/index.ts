// Platform abstraction layer for window/platform operations

import * as windowsImpl from "./windows.js";
import * as linuxImpl from "./linux.js";

const impl = process.platform === "win32" ? windowsImpl : linuxImpl;

// Re-export types from the active implementation
export type {
  WindowInfo,
  DetectedWindow,
  AllWindowInfo,
} from "./windows.js";

// Re-export all functions from the active implementation
export const spawnWindow = impl.spawnWindow;
export const findWindowByTitle = impl.findWindowByTitle;
export const getDefaultSocketPath = impl.getDefaultSocketPath;
export const listWindows = impl.listWindows;
export const sendMessageForeground = impl.sendMessageForeground;
export const executeCommandForeground = impl.executeCommandForeground;
export const detectWindows = impl.detectWindows;
export const detectAllWindows = impl.detectAllWindows;
export const getCdpPort = impl.getCdpPort;
export const resolveKiloPipePath = impl.resolveKiloPipePath;
export const buildKiloPipeCandidates = impl.buildKiloPipeCandidates;
export const normalizeEditorProcessName = impl.normalizeEditorProcessName;
export const isSupportedEditorProcessName = impl.isSupportedEditorProcessName;
export const fallbackProcessNameFromTitle = impl.fallbackProcessNameFromTitle;
export const resolveDetectedWindowProcessName = impl.resolveDetectedWindowProcessName;
export const resolveBackgroundRoute = impl.resolveBackgroundRoute;
