import * as fs from "node:fs";
import * as path from "node:path";
import {
  appImageRuntimeDir,
  dataHome,
  displayPath,
  isFile,
  type ActionResult,
  type InstallContext,
} from "./context.js";
import { backupFile, commitWrite, copyFileAtomic, readTextFile, sha256, type TextFile } from "./fs-safe.js";

const MARKER = "X-Reprompty-Managed=true";

export function desktopEntryPath(): string {
  return path.join(dataHome(), "applications", "reprompty.desktop");
}

function readEntry(file: string): TextFile | null {
  try {
    return readTextFile(file);
  } catch {
    return null;
  }
}

export function managedDesktopEntryExists(): boolean {
  return readEntry(desktopEntryPath())?.text.includes(MARKER) ?? false;
}

function mainGroup(text: string): string {
  const start = text.indexOf("[Desktop Entry]");
  if (start === -1) return "";
  const rest = text.slice(start + "[Desktop Entry]".length);
  const next = rest.search(/^\[/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** A menu entry for Reprompty that someone made by hand. */
export function otherDesktopEntry(): string | null {
  const dir = path.join(dataHome(), "applications");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    if (!name.endsWith(".desktop") || file === desktopEntryPath()) continue;
    const group = mainGroup(readEntry(file)?.text ?? "");
    if (/^Name=Reprompty\s*$/m.test(group) && !/^NoDisplay=true\s*$/m.test(group) && !group.includes(MARKER)) {
      return file;
    }
  }
  return null;
}

// Desktop Entry spec: quote arguments with reserved characters, escape \ " ` $ inside
// the quotes, then double every backslash for the string type; % is always %%.
function execArg(arg: string): string {
  const escaped = arg.replace(/%/g, "%%");
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(escaped)) return escaped;
  return `"${escaped.replace(/(["`$\\])/g, "\\$1")}"`.replace(/\\/g, "\\\\");
}

function execLine(argv: string[], fieldCodes = ""): string {
  return `Exec=${argv.map(execArg).join(" ")}${fieldCodes ? ` ${fieldCodes}` : ""}`;
}

interface Launcher {
  argv: string[];
  fieldCodes?: string;
  actions: Array<{ id: string; name: string; argv: string[] }>;
}

function launcher(ctx: InstallContext): Launcher | null {
  const layoutActions = (script: string | null) =>
    script
      ? [
          { id: "layout-dual", name: "Two-monitor layout", argv: ["python3", script, "--once", "--dual", "--slot", "A"] },
          { id: "layout-single", name: "One-monitor layout", argv: ["python3", script, "--once", "--single", "--slot", "B"] },
        ]
      : [];

  if (ctx.kind === "appimage" && ctx.appImage) {
    // syncAppImageRuntime copies the layout script here.
    const copied = path.join(appImageRuntimeDir(), "layout", "linux_layout.py");
    const hasScript = ctx.layoutScript !== null || isFile(copied);
    return { argv: [ctx.appImage, "--no-sandbox"], fieldCodes: "%U", actions: layoutActions(hasScript ? copied : null) };
  }
  if (ctx.kind === "source") {
    const script = (name: string) => path.join(ctx.appRoot, "linux", name);
    if (!isFile(script("reprompty-launcher.sh"))) return null;
    const actions = [
      { id: "layout-dual", name: "Two-monitor layout", argv: [script("layout-dual.sh")] },
      { id: "layout-single", name: "One-monitor layout", argv: [script("layout-single.sh")] },
    ].filter((action) => isFile(action.argv[0]));
    return { argv: [script("reprompty-launcher.sh")], actions };
  }
  if (ctx.kind === "unpacked" && ctx.runtime) {
    return { argv: [ctx.runtime], fieldCodes: "%U", actions: layoutActions(ctx.layoutScript) };
  }
  return null;
}

export function desktopEntryText(ctx: InstallContext): string | null {
  const launch = launcher(ctx);
  if (!launch) return null;
  const lines = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Reprompty",
    "Comment=Open, arrange and prompt AI coding agents in VS Code",
    execLine(launch.argv, launch.fieldCodes),
    "Icon=reprompty",
    "Terminal=false",
    "Categories=Development;",
    "StartupNotify=true",
    "StartupWMClass=Reprompty",
  ];
  if (launch.actions.length > 0) lines.push(`Actions=${launch.actions.map((action) => action.id).join(";")};`);
  lines.push(MARKER);
  for (const action of launch.actions) {
    lines.push("", `[Desktop Action ${action.id}]`, `Name=${action.name}`, execLine(action.argv));
  }
  return lines.join("\n") + "\n";
}

function pngSize(file: string): number | null {
  try {
    const header = Buffer.alloc(24);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, header, 0, 24, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (header.toString("latin1", 12, 16) !== "IHDR") return null;
    const width = header.readUInt32BE(16);
    return width === header.readUInt32BE(20) ? width : null;
  } catch {
    return null;
  }
}

function iconFiles(ctx: InstallContext): { source: string; target: string } | null {
  const candidates = [
    path.join(ctx.appRoot, "build-resources", "icon.png"),
    // Packaged apps get the icons next to resources/app.
    path.join(ctx.appRoot, "..", "icon.png"),
    path.join(ctx.appRoot, "build-resources", "mouse-icon.png"),
  ];
  for (const source of candidates) {
    const size = pngSize(source);
    if (size) {
      const target = path.join(dataHome(), "icons", "hicolor", `${size}x${size}`, "apps", "reprompty.png");
      return { source, target };
    }
  }
  return null;
}

function sameContent(a: string, b: string): boolean {
  try {
    return sha256(fs.readFileSync(a)) === sha256(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/** Adds Reprompty to the Linux app menu, unless a hand-made entry already does. */
export function installDesktopEntry(ctx: InstallContext, o: { dryRun?: boolean } = {}): ActionResult {
  const file = desktopEntryPath();
  const where = displayPath(file);
  if (process.platform !== "linux") return { ok: false, changed: false, message: "The app-menu entry is for Linux" };
  const before = readEntry(file);
  if (before && !before.text.includes(MARKER)) {
    return { ok: true, changed: false, message: `${where} wasn't made by Reprompty; left as is` };
  }
  const other = before ? null : otherDesktopEntry();
  if (other) return { ok: true, changed: false, message: `${displayPath(other)} already adds Reprompty to the app menu` };
  const text = desktopEntryText(ctx);
  if (!text) return { ok: false, changed: false, message: "This install has no launcher for the app menu" };

  const icon = iconFiles(ctx);
  const iconChanges = icon !== null && !sameContent(icon.source, icon.target);
  try {
    const { changed, backup } = commitWrite(file, before, text, { dryRun: o.dryRun, mode: 0o644 });
    if (iconChanges && !o.dryRun) copyFileAtomic(icon.source, icon.target);
    const files = [...(changed ? [file] : []), ...(iconChanges ? [icon.target] : [])];
    if (files.length === 0) return { ok: true, changed: false, message: `${where} is up to date` };
    const verb = before ? (o.dryRun ? "Would update" : "Updated") : o.dryRun ? "Would create" : "Created";
    const iconNote = iconChanges ? ` and the icon ${displayPath(icon.target)}` : "";
    return {
      ok: true,
      changed: true,
      message: `${verb} ${where}${iconNote}`,
      files,
      backups: backup ? [backup] : [],
    };
  } catch (err) {
    return { ok: false, changed: false, message: `Couldn't write ${where}: ${err instanceof Error ? err.message : err}` };
  }
}

export function removeDesktopEntry(o: { dryRun?: boolean } = {}): ActionResult {
  const file = desktopEntryPath();
  const where = displayPath(file);
  if (!managedDesktopEntryExists()) return { ok: true, changed: false, message: `${where} wasn't made by Reprompty` };
  if (o.dryRun) return { ok: true, changed: true, message: `Would remove ${where}`, files: [file] };
  const backup = backupFile(file);
  fs.rmSync(file, { force: true });
  return { ok: true, changed: true, message: `Removed ${where}`, files: [file], backups: backup ? [backup] : [] };
}
