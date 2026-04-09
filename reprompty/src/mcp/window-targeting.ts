import type { DetectedWindow } from "../platform/windows.js";

export interface WindowSelectionResult {
  match: DetectedWindow | null;
  reason: string;
}

export function buildSpawnTitleHints(input: {
  folderPath: string;
  windowName?: string;
}): string[] {
  const folderName =
    input.folderPath
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .pop() || "";

  return Array.from(
    new Set(
      [input.windowName?.trim() || "", folderName.trim()].filter(Boolean)
    )
  );
}

export function findNewWindowCandidates(
  baselineWindows: DetectedWindow[],
  currentWindows: DetectedWindow[]
): DetectedWindow[] {
  const baselineHandles = new Set(baselineWindows.map((window) => window.handle));
  return currentWindows.filter((window) => !baselineHandles.has(window.handle));
}

export function selectUniqueWindowByTitle(
  windows: DetectedWindow[],
  titleHints: string[]
): WindowSelectionResult {
  const normalizedHints = titleHints
    .map((hint) => hint.trim())
    .filter(Boolean);

  for (const hint of normalizedHints) {
    const loweredHint = hint.toLowerCase();

    const exactMatches = windows.filter(
      (window) => window.title.trim().toLowerCase() === loweredHint
    );
    if (exactMatches.length === 1) {
      return {
        match: exactMatches[0],
        reason: `exact title match on "${hint}"`,
      };
    }
    if (exactMatches.length > 1) {
      return {
        match: null,
        reason: `ambiguous exact title match on "${hint}" (${exactMatches.length} matches)`,
      };
    }

    const substringMatches = windows.filter((window) =>
      window.title.toLowerCase().includes(loweredHint)
    );
    if (substringMatches.length === 1) {
      return {
        match: substringMatches[0],
        reason: `unique substring title match on "${hint}"`,
      };
    }
    if (substringMatches.length > 1) {
      return {
        match: null,
        reason: `ambiguous substring title match on "${hint}" (${substringMatches.length} matches)`,
      };
    }
  }

  if (normalizedHints.length === 0) {
    return {
      match: null,
      reason: "no title hints were provided",
    };
  }

  return {
    match: null,
    reason: `no windows matched any title hint (${normalizedHints.join(", ")})`,
  };
}
