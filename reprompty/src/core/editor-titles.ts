/** Editor names at the end of VS Code-family window titles ("file - folder - <name>"). */
export const EDITOR_TITLE_SUFFIXES: readonly string[] = [
  "Visual Studio Code - Insiders",
  "Visual Studio Code",
  "Code - OSS",
  "VSCodium",
  "Kilo Code",
  "Kimi Code",
];

const DIRTY_MARKER = /^●\s*/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// " - <suffix>", or the suffix alone at the start of the title.
const SUFFIX_PATTERN = new RegExp(
  `(?:^|\\s+-\\s+)(?:${EDITOR_TITLE_SUFFIXES.map((suffix) =>
    escapeRegExp(suffix).replace(/ /g, "\\s+")
  ).join("|")})(?!\\w)`,
  "gi"
);

export function isEditorWindowTitle(title: string): boolean {
  return EDITOR_TITLE_SUFFIXES.some((suffix) => title.includes(suffix));
}

/**
 * Remove " - <editor>" and anything after it (" - Visual Studio Code [Administrator]").
 * The last match wins, so a folder named like an editor survives.
 */
export function stripEditorSuffix(title: string): string {
  let cut = -1;
  for (const match of title.matchAll(SUFFIX_PATTERN)) {
    cut = match.index ?? cut;
  }
  return (cut === -1 ? title : title.slice(0, cut)).trim();
}

/**
 * Folder or workspace name from an editor title: the last " - " segment before
 * the editor name, so "main.ts - my-repo - Visual Studio Code" gives "my-repo".
 */
export function workspaceNameFromTitle(title: string): string | null {
  const rest = stripEditorSuffix(title).replace(DIRTY_MARKER, "");
  const separator = rest.lastIndexOf(" - ");
  const name = (separator === -1 ? rest : rest.slice(separator + 3)).trim();
  return name || null;
}
