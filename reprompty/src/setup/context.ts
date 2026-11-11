import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appRoot, appVersion } from "../core/resources.js";

export type InstallKind = "source" | "installed" | "appimage" | "unpacked";

export interface InstallContext {
  kind: InstallKind;
  version: string;
  appRoot: string;
  serverJs: string;
  skillFile: string;
  layoutScript: string | null;
  /** Electron binary usable with ELECTRON_RUN_AS_NODE */
  runtime: string | null;
  appImage?: string;
}

export interface ActionResult {
  ok: boolean;
  changed: boolean;
  message: string;
  files?: string[];
  backups?: string[];
  next?: string;
}

export interface DetectOptions {
  root?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  electron?: boolean;
  execPath?: string;
}

export function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isInside(child: string, parent: string, p: typeof path.posix): boolean {
  const relative = p.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !p.isAbsolute(relative));
}

function readVersion(packageJson: string): string {
  try {
    const version = (JSON.parse(fs.readFileSync(packageJson, "utf-8")) as { version?: unknown }).version;
    return typeof version === "string" && version ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function sourceRuntime(root: string, p: typeof path.posix): string | null {
  try {
    const relative = fs.readFileSync(p.join(root, "node_modules", "electron", "path.txt"), "utf-8").trim();
    const binary = p.join(root, "node_modules", "electron", "dist", relative);
    return relative && isFile(binary) ? binary : null;
  } catch {
    return null;
  }
}

export function detectInstallContext(o: DetectOptions = {}): InstallContext {
  const root = o.root ?? appRoot();
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const electron = o.electron ?? Boolean(process.versions.electron);
  const execPath = o.execPath ?? process.execPath;
  const p = platform === "win32" ? path.win32 : path.posix;
  const join = (...parts: string[]) => p.join(root, ...parts);

  const layoutScript = join("layout", "linux_layout.py");
  const base = {
    version: o.root === undefined ? appVersion() : readVersion(join("package.json")),
    appRoot: root,
    serverJs: join("dist", "mcp", "server.js"),
    skillFile: join("skills", "reprompty", "SKILL.md"),
    layoutScript: isFile(layoutScript) ? layoutScript : null,
  };

  // APPIMAGE alone can leak into programs started from the AppImage, so the
  // code must also run from inside its mount.
  const appDir = env.APPDIR;
  if (platform === "linux" && env.APPIMAGE && appDir && isInside(root, appDir, p)) {
    return { kind: "appimage", ...base, runtime: electron ? execPath : null, appImage: env.APPIMAGE };
  }

  if (p.basename(root) === "app" && p.basename(p.dirname(root)) === "resources") {
    const executable = p.join(root, "..", "..", platform === "win32" ? "Reprompty.exe" : "reprompty");
    const runtime = electron ? execPath : isFile(executable) ? executable : null;
    return { kind: platform === "win32" ? "installed" : "unpacked", ...base, runtime };
  }

  return { kind: "source", ...base, runtime: sourceRuntime(root, p) };
}

export function installKindLabel(kind: InstallKind): string {
  switch (kind) {
    case "source":
      return "source install";
    case "installed":
      return "installed app";
    case "appimage":
      return "AppImage";
    case "unpacked":
      return "unpacked build";
  }
}

export function dataHome(): string {
  const fromEnv = process.env.XDG_DATA_HOME;
  return fromEnv && path.isAbsolute(fromEnv) ? fromEnv : path.join(os.homedir(), ".local", "share");
}

export function configHome(): string {
  const fromEnv = process.env.XDG_CONFIG_HOME;
  return fromEnv && path.isAbsolute(fromEnv) ? fromEnv : path.join(os.homedir(), ".config");
}

/** An AppImage mounts somewhere new on every start, so agents run a copy of the server kept here. */
export function appImageRuntimeDir(): string {
  return path.join(dataHome(), "reprompty");
}

/** A path for messages, with the home folder shortened to ~. */
export function displayPath(file: string): string {
  const home = os.homedir();
  const relative = path.relative(home, file);
  if (relative === "") return "~";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return file;
  return `~${path.sep}${relative}`;
}
