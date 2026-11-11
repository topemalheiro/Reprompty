import { execFile } from "node:child_process";
import { findExecutable, findKdotool } from "../core/which.js";
import type { ActionResult } from "./context.js";

export interface DepCheck {
  id: string;
  label: string;
  /** Where it was found */
  found: string | null;
  required: boolean;
  neededFor: string;
  packages: { pacman?: string; aur?: string; apt?: string; dnf?: string; cargo?: string };
}

export type SessionType = "wayland" | "x11" | "unknown";

export function sessionType(env: NodeJS.ProcessEnv = process.env): SessionType {
  const type = (env.XDG_SESSION_TYPE ?? "").toLowerCase();
  if (type === "wayland" || type === "x11") return type;
  if (env.WAYLAND_DISPLAY) return "wayland";
  if (env.DISPLAY) return "x11";
  return "unknown";
}

export function isKdePlasma(env: NodeJS.ProcessEnv = process.env): boolean {
  return /\bKDE\b/i.test(env.XDG_CURRENT_DESKTOP ?? "") || Boolean(env.KDE_FULL_SESSION);
}

/** The tools Reprompty runs on Linux; X11 sessions use the X tools instead of the Wayland ones. */
export function linuxDeps(env: NodeJS.ProcessEnv = process.env): DepCheck[] {
  const x11 = sessionType(env) === "x11";
  const deps: DepCheck[] = [
    {
      id: "qdbus",
      label: "qdbus6",
      found: findExecutable(["qdbus6", "qdbus", "qdbus-qt6", "qdbus-qt5"]),
      required: true,
      neededFor: "virtual desktops and KWin",
      packages: { pacman: "qt6-tools", apt: "qdbus-qt6", dnf: "qt6-qttools" },
    },
    {
      id: "dbus-send",
      label: "dbus-send",
      found: findExecutable("dbus-send"),
      required: true,
      neededFor: "virtual desktops and KWin",
      packages: { pacman: "dbus", apt: "dbus", dnf: "dbus-tools" },
    },
    {
      id: "python3",
      label: "python3",
      found: findExecutable("python3"),
      required: false,
      neededFor: "layouts",
      packages: { pacman: "python", apt: "python3", dnf: "python3" },
    },
    {
      id: "kscreen-doctor",
      label: "kscreen-doctor",
      found: findExecutable("kscreen-doctor"),
      required: false,
      neededFor: "layouts",
      packages: { pacman: "libkscreen", apt: "libkscreen-bin", dnf: "kf6-libkscreen" },
    },
  ];
  if (x11) {
    deps.push(
      {
        id: "wmctrl",
        label: "wmctrl",
        found: findExecutable("wmctrl"),
        required: true,
        neededFor: "window control on X11",
        packages: { pacman: "wmctrl", apt: "wmctrl", dnf: "wmctrl" },
      },
      {
        id: "xdotool",
        label: "xdotool",
        found: findExecutable("xdotool"),
        required: true,
        neededFor: "window control on X11",
        packages: { pacman: "xdotool", apt: "xdotool", dnf: "xdotool" },
      },
      {
        id: "xclip",
        label: "xclip or xsel",
        found: findExecutable(["xclip", "xsel"]),
        required: false,
        neededFor: "typing prompts in the foreground",
        packages: { pacman: "xclip", apt: "xclip", dnf: "xclip" },
      }
    );
  } else {
    deps.unshift({
      id: "kdotool",
      label: "kdotool",
      found: findKdotool(),
      required: true,
      neededFor: "window control on Wayland",
      packages: { aur: "kdotool", cargo: "kdotool" },
    });
    deps.push(
      {
        id: "wl-copy",
        label: "wl-copy",
        found: findExecutable("wl-copy"),
        required: false,
        neededFor: "typing prompts in the foreground",
        packages: { pacman: "wl-clipboard", apt: "wl-clipboard", dnf: "wl-clipboard" },
      },
      {
        id: "wtype",
        label: "wtype or ydotool",
        found: findExecutable(["wtype", "ydotool"]),
        required: false,
        neededFor: "typing prompts in the foreground",
        packages: { pacman: "wtype", apt: "wtype", dnf: "wtype" },
      }
    );
  }
  return deps;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/** Commands to install what's missing. They are only printed: setup never runs sudo. */
export function linuxInstallHint(missing: DepCheck[]): string[] {
  if (missing.length === 0) return [];
  const has = (command: string) => findExecutable(command) !== null;
  const arch = has("pacman");
  const debian = has("apt-get");
  const fedora = has("dnf");
  const lines: string[] = [];

  const pacman = unique(missing.map((dep) => dep.packages.pacman));
  const aur = unique(missing.map((dep) => dep.packages.aur));
  if (arch || !(debian || fedora)) {
    if (pacman.length > 0) lines.push(`sudo pacman -S --needed ${pacman.join(" ")}`);
    if (aur.length > 0) lines.push(`${has("paru") && !has("yay") ? "paru" : "yay"} -S ${aur.join(" ")}`);
  }
  const apt = unique(missing.map((dep) => dep.packages.apt));
  if (debian && apt.length > 0) lines.push(`sudo apt install ${apt.join(" ")}   # best effort: names vary by release`);
  const dnf = unique(missing.map((dep) => dep.packages.dnf));
  if (fedora && dnf.length > 0) lines.push(`sudo dnf install ${dnf.join(" ")}   # best effort: names vary by release`);
  const cargo = unique(missing.map((dep) => dep.packages.cargo));
  if (!arch && cargo.length > 0) lines.push(`cargo install ${cargo.join(" ")}`);
  return lines;
}

function powershell(script: string, timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: timeoutMs },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })
    );
  });
}

/** Whether the VirtualDesktop PowerShell module (needed for Windows desktops) is installed. */
export async function virtualDesktopModule(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const result = await powershell("if (Get-Module -ListAvailable VirtualDesktop) { 'yes' } else { 'no' }", 60_000);
  return result.ok && result.stdout.trim() === "yes";
}

export const VIRTUAL_DESKTOP_INSTALL = "Install-Module VirtualDesktop -Scope CurrentUser";

export async function installVirtualDesktopModule(o: { dryRun?: boolean } = {}): Promise<ActionResult> {
  if (process.platform !== "win32") {
    return { ok: false, changed: false, message: "The VirtualDesktop module is for Windows" };
  }
  if (await virtualDesktopModule()) {
    return { ok: true, changed: false, message: "The VirtualDesktop PowerShell module is already installed" };
  }
  if (o.dryRun) {
    return { ok: true, changed: true, message: `Would install the VirtualDesktop PowerShell module (${VIRTUAL_DESKTOP_INSTALL})` };
  }
  const result = await powershell(
    "Install-PackageProvider NuGet -MinimumVersion 2.8.5.201 -Scope CurrentUser -Force | Out-Null; " +
      "Install-Module VirtualDesktop -Scope CurrentUser -Force -AllowClobber",
    5 * 60_000
  );
  if (!result.ok || !(await virtualDesktopModule())) {
    const reason = result.stderr.trim().split(/\r?\n/).filter(Boolean).pop();
    return {
      ok: false,
      changed: false,
      message: `Couldn't install the VirtualDesktop PowerShell module${reason ? `: ${reason}` : ""}`,
      next: `Run in PowerShell: ${VIRTUAL_DESKTOP_INSTALL}`,
    };
  }
  return {
    ok: true,
    changed: true,
    message: "Installed the VirtualDesktop PowerShell module",
    next: "Restart Reprompty so it finds the module.",
  };
}
