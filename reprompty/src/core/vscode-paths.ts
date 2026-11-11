import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse, type ParseError } from "jsonc-parser";

export type VsCodeVariantId = "code" | "insiders" | "oss" | "vscodium";

export interface VsCodeVariant {
  id: VsCodeVariantId;
  label: string;
  /** argv.json, where VS Code reads "remote-debugging-port" at startup */
  argvPath: string;
  /** Holds DevToolsActivePort and User/workspaceStorage */
  userDataDir: string;
}

// id, label, argv.json folder in the home folder, user data folder name
const VARIANTS: ReadonlyArray<[VsCodeVariantId, string, string, string]> = [
  ["code", "Visual Studio Code", ".vscode", "Code"],
  ["insiders", "Visual Studio Code - Insiders", ".vscode-insiders", "Code - Insiders"],
  ["oss", "Code - OSS", ".vscode-oss", "Code - OSS"],
  ["vscodium", "VSCodium", ".vscode-oss", "VSCodium"],
];

export function vscodeVariants(): VsCodeVariant[] {
  const home = os.homedir();
  const portable = process.env.VSCODE_PORTABLE;
  const argvPath = (dataFolder: string) =>
    portable ? path.join(portable, "argv.json") : path.join(home, dataFolder, "argv.json");

  const isWindows = process.platform === "win32";
  const base = isWindows
    ? process.env.APPDATA || path.join(home, "AppData", "Roaming")
    : process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const variants = VARIANTS.filter(([id]) => !(isWindows && id === "oss")).map(
    ([id, label, dataFolder, userData]): VsCodeVariant => ({
      id,
      label,
      argvPath: argvPath(dataFolder),
      userDataDir: path.join(base, userData),
    })
  );
  if (!isWindows) {
    variants.push({
      id: "code",
      label: "Visual Studio Code (Flatpak)",
      argvPath: argvPath(".vscode"),
      userDataDir: path.join(home, ".var", "app", "com.visualstudio.code", "config", "Code"),
    });
  }
  return variants;
}

function toPort(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port > 0 && port < 65536 ? port : null;
}

export function readDevToolsActivePort(userDataDir: string): number | null {
  try {
    const content = fs.readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf-8");
    return toPort(content.split(/\r?\n/, 1)[0]);
  } catch {
    return null;
  }
}

/** The "remote-debugging-port" value in argv.json (JSONC), as a string. */
export function readArgvPort(argvPath: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(argvPath, "utf-8");
  } catch {
    return null;
  }
  const errors: ParseError[] = [];
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true });
  // VS Code ignores an argv.json it can't parse, so a broken file has no port.
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const value = (parsed as Record<string, unknown>)["remote-debugging-port"];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value;
  return null;
}

/**
 * The port of the most recently started VS Code with a debugging port, else
 * the port set in argv.json.
 */
export function getCdpPort(): number | null {
  const variants = vscodeVariants();
  let newest: { port: number; mtimeMs: number } | null = null;
  for (const userDataDir of new Set(variants.map((variant) => variant.userDataDir))) {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(path.join(userDataDir, "DevToolsActivePort")).mtimeMs;
    } catch {
      continue;
    }
    const port = readDevToolsActivePort(userDataDir);
    if (port !== null && (newest === null || mtimeMs > newest.mtimeMs)) {
      newest = { port, mtimeMs };
    }
  }
  if (newest) return newest.port;

  for (const argvPath of new Set(variants.map((variant) => variant.argvPath))) {
    const value = readArgvPort(argvPath);
    const port = value === null ? null : toPort(value);
    if (port !== null) return port;
  }
  return null;
}
