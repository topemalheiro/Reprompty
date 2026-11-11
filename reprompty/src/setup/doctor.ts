import * as path from "node:path";
import { readSettings } from "../core/settings.js";
import { getCdpPort } from "../core/vscode-paths.js";
import {
  CLIENT_IDS,
  CLIENT_LABELS,
  clientStatus,
  registerClient,
  registeredLaunch,
  unregisterClient,
  type ClientId,
} from "./clients.js";
import {
  detectInstallContext,
  displayPath,
  installKindLabel,
  isFile,
  type ActionResult,
  type InstallContext,
} from "./context.js";
import {
  installVirtualDesktopModule,
  isKdePlasma,
  linuxDeps,
  linuxInstallHint,
  sessionType,
  VIRTUAL_DESKTOP_INSTALL,
  virtualDesktopModule,
} from "./deps.js";
import { desktopEntryPath, installDesktopEntry, managedDesktopEntryExists, otherDesktopEntry, removeDesktopEntry } from "./desktop-entry.js";
import { appImageWrapperPath, mcpHandshake, resolveMcpLaunch, syncAppImageRuntime, type McpLaunch } from "./launch.js";
import { installSkill, missingSkillMessage, removeSkill, skillTargets, type SkillAgent } from "./skills.js";
import {
  CDP_RESTART_HINT,
  CDP_SECURITY_NOTE,
  cdpLive,
  DEFAULT_CDP_PORT,
  listVsCodeVariants,
  removeCdpPort,
  setCdpPort,
} from "./vscode.js";

export type { ActionResult } from "./context.js";

export type CheckStatus = "ok" | "warn" | "fail" | "info";
export type CheckGroup = "app" | "vscode" | "agents" | "system";

export interface Check {
  id: string;
  group: CheckGroup;
  label: string;
  status: CheckStatus;
  detail?: string;
  action?: { id: string; label: string };
  /** A command the user can run to fix it */
  command?: string;
}

export interface DoctorOptions {
  /** Also start the MCP server and check its answers */
  deep?: boolean;
  ctx?: InstallContext;
}

export interface ActionOptions {
  port?: string;
  dryRun?: boolean;
  ctx?: InstallContext;
}

const AGENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "kilo-code": "Kilo Code",
  "kimi-code": "Kimi Code",
};

export function defaultCdpPort(): string {
  return String(readSettings().cdpPort ?? DEFAULT_CDP_PORT);
}

function shownCommand(l: McpLaunch): string {
  const shown = (value: string) => (path.isAbsolute(value) ? displayPath(value) : value);
  const env = Object.keys(l.env).map((key) => `${key}=${l.env[key]} `).join("");
  return `${env}${[l.command, ...l.args].map(shown).join(" ")}`;
}

function appChecks(ctx: InstallContext, launch: McpLaunch): Check[] {
  const checks: Check[] = [
    {
      id: "app.version",
      group: "app",
      label: "Reprompty",
      status: "info",
      detail: `${ctx.version}, ${installKindLabel(ctx.kind)} in ${displayPath(ctx.appRoot)}`,
    },
  ];
  if (isFile(ctx.serverJs)) {
    checks.push({ id: "app.server", group: "app", label: "MCP server", status: "ok", detail: displayPath(ctx.serverJs) });
  } else {
    checks.push({
      id: "app.server",
      group: "app",
      label: "MCP server",
      status: "fail",
      detail: `${displayPath(ctx.serverJs)} is missing`,
      command: ctx.kind === "source" ? "npm run build:mcp" : undefined,
    });
  }
  checks.push(
    isFile(ctx.skillFile)
      ? { id: "app.skill", group: "app", label: "Skill file", status: "ok", detail: displayPath(ctx.skillFile) }
      : { id: "app.skill", group: "app", label: "Skill file", status: "fail", detail: missingSkillMessage(ctx.skillFile) }
  );

  if (ctx.kind === "appimage" && !isFile(appImageWrapperPath())) {
    checks.push({
      id: "app.command",
      group: "app",
      label: "MCP command",
      status: "warn",
      detail: `${displayPath(appImageWrapperPath())} is missing; start Reprompty once to create it`,
    });
  } else if (!path.isAbsolute(launch.command)) {
    checks.push({
      id: "app.command",
      group: "app",
      label: "MCP command",
      status: "warn",
      detail: `Node.js wasn't found, so agents need ${launch.command} on their PATH: ${shownCommand(launch)}`,
    });
  } else {
    checks.push({ id: "app.command", group: "app", label: "MCP command", status: "info", detail: shownCommand(launch) });
  }
  return checks;
}

async function handshakeCheck(ctx: InstallContext, launch: McpLaunch): Promise<Check> {
  const result = await mcpHandshake(launch, { expectVersion: ctx.version });
  const check: Check = { id: "app.handshake", group: "app", label: "MCP server test", status: result.ok ? "ok" : "fail" };
  check.detail = result.ok
    ? `${result.tools} tools, version ${result.version}`
    : [result.error, ...result.problems].filter(Boolean).join("; ");
  return check;
}

async function vscodeChecks(): Promise<Check[]> {
  const variants = listVsCodeVariants().filter((variant) => variant.installed);
  if (variants.length === 0) {
    return [{ id: "vscode.installed", group: "vscode", label: "VS Code", status: "fail", detail: "Not found" }];
  }
  const checks: Check[] = [];
  const seenArgv = new Set<string>();
  for (const variant of variants) {
    checks.push({
      id: `vscode.installed:${variant.id}`,
      group: "vscode",
      label: variant.label,
      status: "ok",
      detail: displayPath(variant.command ?? variant.userDataDir),
    });
    if (seenArgv.has(variant.argvPath)) continue;
    seenArgv.add(variant.argvPath);
    const where = displayPath(variant.argvPath);
    const check: Check = { id: `vscode.port:${variant.id}`, group: "vscode", label: "Debugging port", status: "ok" };
    const turnOn = { id: `cdp.enable:${variant.id}`, label: "Turn on" };
    if (variant.argvError) {
      Object.assign(check, { status: "fail", detail: `Can't use ${where} (${variant.argvError})` });
    } else if (variant.portIsNumber) {
      Object.assign(check, {
        status: "fail",
        detail: `${where} sets it as a number, which VS Code ignores`,
        action: { ...turnOn, label: "Fix" },
      });
    } else if (variant.port) {
      check.detail = `${variant.port}, set in ${where}`;
    } else {
      Object.assign(check, { status: "fail", detail: `Not set in ${where}`, action: turnOn });
    }
    checks.push(check);
  }

  const port = getCdpPort();
  if (port !== null) {
    const live = await cdpLive(port);
    if (live.ok) {
      const agents = live.agents.map((agent) => AGENT_NAMES[agent] ?? agent);
      checks.push({
        id: "vscode.live",
        group: "vscode",
        label: `Port ${port}`,
        status: "ok",
        detail: `${live.windows} window${live.windows === 1 ? "" : "s"}; agent panels: ${agents.join(", ") || "none open"}`,
      });
    } else {
      checks.push({
        id: "vscode.live",
        group: "vscode",
        label: `Port ${port}`,
        status: "warn",
        detail: `VS Code doesn't answer (${live.error}). If it's open: ${CDP_RESTART_HINT}`,
      });
    }
    checks.push({ id: "vscode.security", group: "vscode", label: "Port access", status: "info", detail: CDP_SECURITY_NOTE });
  }

  const command = variants.find((variant) => variant.command)?.command;
  checks.push(
    command
      ? { id: "vscode.cli", group: "vscode", label: "code command", status: "ok", detail: displayPath(command) }
      : {
          id: "vscode.cli",
          group: "vscode",
          label: "code command",
          status: "warn",
          detail: "Not on PATH; Reprompty opens folders with it",
        }
  );
  return checks;
}

function agentChecks(ctx: InstallContext, launch: McpLaunch): Check[] {
  const checks: Check[] = [];
  const skills = skillTargets(ctx.skillFile);
  for (const id of CLIENT_IDS) {
    const label = CLIENT_LABELS[id];
    const status = clientStatus(id, launch);
    if (!status.installed) {
      checks.push({ id: `mcp:${id}`, group: "agents", label, status: "info", detail: "Not installed" });
      continue;
    }
    const check: Check = { id: `mcp:${id}`, group: "agents", label: `${label} MCP server`, status: "ok" };
    const where = status.configPath ? displayPath(status.configPath) : "its settings";
    if (status.error) {
      Object.assign(check, { status: "fail", detail: status.error });
    } else if (status.state === "registered") {
      check.detail = `Registered in ${where}`;
    } else if (status.state === "missing") {
      Object.assign(check, {
        status: "fail",
        detail: `Not registered (${where})`,
        action: { id: `mcp.register:${id}`, label: "Register" },
      });
    } else {
      const broken = brokenFile(status.registered);
      Object.assign(check, {
        status: broken ? "fail" : "warn",
        detail: broken
          ? `Registered with a file that's gone: ${displayPath(broken)}`
          : `Registered with another command: ${status.detail}`,
        action: { id: `mcp.register:${id}`, label: "Update" },
      });
    }
    checks.push(check);

    const skill = skills.find((target) => target.agent === id);
    if (!skill) continue;
    const skillCheck: Check = { id: `skill:${id}`, group: "agents", label: `${label} skill`, status: "ok" };
    const install = { id: `skills.install:${id}`, label: "Install" };
    const file = displayPath(skill.file);
    if (!skill.detected) {
      // Only Kimi CLI: it reads ~/.claude/skills until ~/.kimi/skills exists.
      Object.assign(skillCheck, { status: "info", detail: "Uses the skill in ~/.claude/skills or ~/.codex/skills" });
    } else if (skill.state === "current" || skill.state === "linked") {
      skillCheck.detail = skill.state === "linked" ? `${file} (a link to this install)` : file;
    } else if (skill.state === "missing") {
      Object.assign(skillCheck, { status: "warn", detail: `Not installed (${file})`, action: install });
    } else if (skill.state === "outdated") {
      Object.assign(skillCheck, { status: "warn", detail: `Outdated (${file})`, action: { ...install, label: "Update" } });
    } else {
      Object.assign(skillCheck, { status: "warn", detail: `${file} exists, but this install has no skill file to compare it with` });
    }
    checks.push(skillCheck);
  }
  return checks;
}

// A registration that runs a file which no longer exists (a moved or deleted install).
function brokenFile(l: McpLaunch | undefined): string | null {
  if (!l) return null;
  if (path.isAbsolute(l.command) && !isFile(l.command)) return l.command;
  return l.args.find((arg) => path.isAbsolute(arg) && /\.[cm]?js$/.test(arg) && !isFile(arg)) ?? null;
}

async function systemChecks(ctx: InstallContext): Promise<Check[]> {
  const checks: Check[] = [];
  if (process.platform === "win32") {
    const installed = await virtualDesktopModule();
    checks.push(
      installed
        ? { id: "system.virtualdesktop", group: "system", label: "VirtualDesktop module", status: "ok", detail: "Installed" }
        : {
            id: "system.virtualdesktop",
            group: "system",
            label: "VirtualDesktop module",
            status: "warn",
            detail: "Needed to open windows on their own virtual desktops",
            action: { id: "win.virtualdesktop", label: "Install" },
            command: VIRTUAL_DESKTOP_INSTALL,
          }
    );
    return checks;
  }
  if (process.platform !== "linux") {
    return [{ id: "system.os", group: "system", label: "System", status: "warn", detail: "Reprompty supports Windows 11 and KDE Plasma 6" }];
  }

  const kde = isKdePlasma();
  const desktop = kde ? "KDE Plasma" : process.env.XDG_CURRENT_DESKTOP || "unknown desktop";
  checks.push({
    id: "system.desktop",
    group: "system",
    label: "Desktop",
    status: kde ? "ok" : "warn",
    detail: `${desktop}, ${sessionType()} session${kde ? "" : "; Reprompty's window tools need KDE Plasma 6"}`,
  });
  for (const dep of linuxDeps()) {
    if (dep.found) {
      checks.push({ id: `system.dep:${dep.id}`, group: "system", label: dep.label, status: "ok", detail: displayPath(dep.found) });
      continue;
    }
    checks.push({
      id: `system.dep:${dep.id}`,
      group: "system",
      label: dep.label,
      status: dep.required ? "fail" : "warn",
      detail: `Missing; needed for ${dep.neededFor}`,
      command: linuxInstallHint([dep]).join(" && ") || undefined,
    });
  }

  const other = managedDesktopEntryExists() ? null : otherDesktopEntry();
  if (managedDesktopEntryExists() || other) {
    checks.push({
      id: "system.menu",
      group: "system",
      label: "App menu entry",
      status: "ok",
      detail: displayPath(other ?? desktopEntryPath()),
    });
  } else if (ctx.kind !== "installed") {
    checks.push({
      id: "system.menu",
      group: "system",
      label: "App menu entry",
      status: "info",
      detail: "Not in the app menu",
      action: { id: "linux.desktop", label: "Add to app menu" },
    });
  }
  return checks;
}

export async function runDoctor(o: DoctorOptions = {}): Promise<Check[]> {
  const ctx = o.ctx ?? detectInstallContext();
  const launch = resolveMcpLaunch(ctx);
  const checks = appChecks(ctx, launch);
  if (o.deep && isFile(ctx.serverJs)) checks.push(await handshakeCheck(ctx, launch));
  checks.push(...(await vscodeChecks()));
  checks.push(...agentChecks(ctx, launch));
  checks.push(...(await systemChecks(ctx)));
  return checks;
}

export type SetupGroupId = "cdp" | "mcp" | "skills" | "desktop" | "virtualdesktop";

export interface SetupGroup {
  id: SetupGroupId;
  title: string;
  /** Asked once per group on a terminal */
  question: string;
  actions: string[];
}

/** What `setup all` (and "Run recommended setup") would do here, grouped. */
export async function planSetup(o: { ctx?: InstallContext; port?: string } = {}): Promise<SetupGroup[]> {
  const ctx = o.ctx ?? detectInstallContext();
  const port = o.port ?? defaultCdpPort();
  const launch = resolveMcpLaunch(ctx);
  const groups: SetupGroup[] = [];

  // Code - OSS and VSCodium share one argv.json.
  const byArgv = new Map<string, string>();
  for (const variant of listVsCodeVariants()) {
    if (!variant.installed || byArgv.has(variant.argvPath)) continue;
    byArgv.set(variant.argvPath, variant.portIsNumber || variant.port !== port ? `cdp.enable:${variant.id}` : "");
  }
  const cdp = [...byArgv.values()].filter(Boolean);
  if (cdp.length > 0) {
    groups.push({
      id: "cdp",
      title: "VS Code debugging port",
      question: `Turn on VS Code's debugging port ${port}? ${CDP_SECURITY_NOTE}`,
      actions: cdp,
    });
  }

  const clients = CLIENT_IDS.filter((id) => {
    const status = clientStatus(id, launch);
    return status.installed && status.state !== "registered";
  });
  if (clients.length > 0) {
    groups.push({
      id: "mcp",
      title: "MCP server",
      question: `Register Reprompty's MCP server with ${clients.map((id) => CLIENT_LABELS[id]).join(", ")}?`,
      actions: clients.map((id) => `mcp.register:${id}`),
    });
  }

  const skills = skillTargets(ctx.skillFile).filter(
    (target) => target.detected && (target.state === "missing" || target.state === "outdated")
  );
  if (skills.length > 0) {
    groups.push({
      id: "skills",
      title: "Skill",
      question: `Install the Reprompty skill for ${skills.map((target) => target.label).join(", ")}?`,
      actions: skills.map((target) => `skills.install:${target.agent}`),
    });
  }

  if (process.platform === "linux" && ctx.kind !== "installed" && !otherDesktopEntry()) {
    const managed = managedDesktopEntryExists();
    const preview = installDesktopEntry(ctx, { dryRun: true });
    if (preview.ok && preview.changed) {
      groups.push({
        id: "desktop",
        title: "App menu",
        question: managed ? "Update Reprompty's app-menu entry?" : "Add Reprompty to the app menu?",
        actions: ["linux.desktop"],
      });
    }
  }
  if (process.platform === "win32" && !(await virtualDesktopModule())) {
    groups.push({
      id: "virtualdesktop",
      title: "VirtualDesktop module",
      question: "Install the VirtualDesktop PowerShell module, which Reprompty needs for virtual desktops?",
      actions: ["win.virtualdesktop"],
    });
  }
  return groups;
}

function clientId(value: string | undefined): ClientId {
  if (value && (CLIENT_IDS as readonly string[]).includes(value)) return value as ClientId;
  throw new Error(`Unknown agent ${value ?? ""}; use one of ${CLIENT_IDS.join(", ")}`);
}

/** The AppImage wrapper must exist before agents are pointed at it. */
function launchForRegistration(ctx: InstallContext, dryRun: boolean): McpLaunch {
  if (ctx.kind === "appimage" && !dryRun) syncAppImageRuntime(ctx);
  return resolveMcpLaunch(ctx);
}

function merge(results: ActionResult[]): ActionResult {
  const next = [...new Set(results.map((result) => result.next).filter((value): value is string => Boolean(value)))];
  return {
    ok: results.every((result) => result.ok),
    changed: results.some((result) => result.changed),
    message: results.map((result) => result.message).join("\n"),
    files: results.flatMap((result) => result.files ?? []),
    backups: results.flatMap((result) => result.backups ?? []),
    next: next.join(" ") || undefined,
  };
}

export async function runAction(id: string, o: ActionOptions = {}): Promise<ActionResult> {
  const ctx = o.ctx ?? detectInstallContext();
  const dryRun = Boolean(o.dryRun);
  const [name, arg] = id.split(":", 2);
  try {
    switch (name) {
      case "cdp.enable":
      case "cdp.disable": {
        const variant = listVsCodeVariants().find((candidate) => candidate.id === arg);
        if (!variant) return { ok: false, changed: false, message: `Unknown VS Code build ${arg ?? ""}` };
        return name === "cdp.enable"
          ? setCdpPort(variant.argvPath, o.port ?? defaultCdpPort(), { dryRun })
          : removeCdpPort(variant.argvPath, { dryRun });
      }
      case "mcp.register":
        return await registerClient(clientId(arg), launchForRegistration(ctx, dryRun), { dryRun });
      case "mcp.remove":
        return await unregisterClient(clientId(arg), { dryRun });
      case "mcp.test": {
        const launch = arg ? registeredLaunch(clientId(arg)) : resolveMcpLaunch(ctx);
        if (!launch) return { ok: false, changed: false, message: `${CLIENT_LABELS[clientId(arg)]} has no Reprompty entry` };
        const result = await mcpHandshake(launch, { expectVersion: ctx.version });
        return {
          ok: result.ok,
          changed: false,
          message: result.ok
            ? `The MCP server answers: ${result.tools} tools, version ${result.version}`
            : `MCP server test failed: ${[result.error, ...result.problems].filter(Boolean).join("; ")}`,
        };
      }
      case "skills.install":
      case "skills.remove": {
        const target = skillTargets(ctx.skillFile).find((candidate) => candidate.agent === (arg as SkillAgent));
        if (!target) return { ok: false, changed: false, message: `No skill folder for ${arg ?? ""}` };
        return name === "skills.install"
          ? installSkill(target.file, ctx.skillFile, { dryRun })
          : removeSkill(target.file, { dryRun });
      }
      case "linux.desktop":
        return installDesktopEntry(ctx, { dryRun });
      case "linux.desktop.remove":
        return removeDesktopEntry({ dryRun });
      case "win.virtualdesktop":
        return await installVirtualDesktopModule({ dryRun });
      case "all": {
        const groups = await planSetup({ ctx, port: o.port });
        const results: ActionResult[] = [];
        for (const action of groups.flatMap((group) => group.actions)) {
          results.push(await runAction(action, { ...o, ctx }));
        }
        return results.length > 0 ? merge(results) : { ok: true, changed: false, message: "Nothing to set up" };
      }
      default:
        return { ok: false, changed: false, message: `Unknown action ${id}` };
    }
  } catch (err) {
    return { ok: false, changed: false, message: err instanceof Error ? err.message : String(err) };
  }
}

