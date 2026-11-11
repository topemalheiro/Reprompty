import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  CLIENT_IDS,
  CLIENT_LABELS,
  configSnippet,
  isClientInstalled,
  registeredLaunch,
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
import { linuxDeps, linuxInstallHint, VIRTUAL_DESKTOP_INSTALL, virtualDesktopModule } from "./deps.js";
import { defaultCdpPort, planSetup, runAction, runDoctor, type Check, type CheckGroup } from "./doctor.js";
import { backupsDir } from "./fs-safe.js";
import { mcpHandshake, resolveMcpLaunch, type McpLaunch } from "./launch.js";
import { SKILL_AGENTS, skillTargets, type SkillAgent } from "./skills.js";
import { CDP_SECURITY_NOTE, isValidPort, listVsCodeVariants } from "./vscode.js";

const USAGE = `Usage: setup [command] [options]

Commands:
  doctor     Check this install, VS Code, the AI agents and the system (default)
  all        Set up everything found: debugging port, MCP server, skill, app menu
  cdp        Turn on VS Code's debugging port   [--port N] [--variant id] [--remove]
  mcp        Register the MCP server            [--client id ...] [--remove] [--print]
  skills     Install the Reprompty skill        [--client id ...] [--remove]
  desktop    Add Reprompty to the app menu (Linux)   [--remove]
  deps       Missing system packages and how to install them   [--install (Windows)]
  mcp-test   Start the MCP server and check it  [--registered id] [--call tool --args json] [--server file]

Options:
  --yes        Don't ask before changing anything (setup only asks on a terminal)
  --dry-run    Show which files would change and how; change nothing
  --json       Print JSON
  --deep       doctor: also start the MCP server and check its answers
  --root DIR   Use the Reprompty package in DIR instead of this one

Agents: ${CLIENT_IDS.join(", ")}
Exit codes: 0 OK, 1 something failed, 2 crashed or wrong usage`;

const COMMANDS = ["doctor", "all", "cdp", "mcp", "skills", "desktop", "deps", "mcp-test"];

const GROUP_TITLES: Record<CheckGroup, string> = {
  app: "Reprompty",
  vscode: "VS Code",
  agents: "AI agents",
  system: "System",
};

const BADGES: Record<Check["status"], string> = { ok: "ok", warn: "warn", fail: "FAIL", info: "info" };

class UsageError extends Error {}

interface Options {
  command: string;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  deep: boolean;
  remove: boolean;
  print: boolean;
  install: boolean;
  help: boolean;
  port?: string;
  variants: string[];
  clients: string[];
  registered?: string;
  call?: string;
  args?: string;
  server?: string;
  root?: string;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    command: "",
    yes: false,
    dryRun: false,
    json: false,
    deep: false,
    remove: false,
    print: false,
    install: false,
    help: false,
    variants: [],
    clients: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const value = (): string => {
      if (equals !== -1) return arg.slice(equals + 1);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`${flag} needs a value`);
      i++;
      return next;
    };
    const list = (): string[] => {
      const values = value().split(",");
      // `--client claude codex` as well as `--client claude --client codex`
      while (equals === -1 && argv[i + 1] && (CLIENT_IDS as readonly string[]).includes(argv[i + 1])) values.push(argv[++i]);
      return values.map((item) => item.trim()).filter(Boolean);
    };
    switch (flag) {
      case "--yes":
      case "-y":
        o.yes = true;
        break;
      case "--dry-run":
        o.dryRun = true;
        break;
      case "--json":
        o.json = true;
        break;
      case "--deep":
        o.deep = true;
        break;
      case "--remove":
        o.remove = true;
        break;
      case "--print":
        o.print = true;
        break;
      case "--install":
        o.install = true;
        break;
      case "--help":
      case "-h":
        o.help = true;
        break;
      case "--port":
        o.port = value();
        break;
      case "--variant":
        o.variants.push(...value().split(","));
        break;
      case "--client":
        o.clients.push(...list());
        break;
      case "--registered":
        o.registered = value();
        break;
      case "--call":
        o.call = value();
        break;
      case "--args":
        o.args = value();
        break;
      case "--server":
        o.server = value();
        break;
      case "--root":
        o.root = value();
        break;
      default:
        if (arg.startsWith("-")) throw new UsageError(`Unknown option ${arg}`);
        if (o.command) throw new UsageError(`Unexpected argument ${arg}`);
        o.command = arg;
    }
  }
  o.command ||= "doctor";
  if (!COMMANDS.includes(o.command)) throw new UsageError(`Unknown command ${o.command}`);
  if (o.port !== undefined && !isValidPort(o.port)) throw new UsageError(`--port needs a port number (1-65535)`);
  return o;
}

function print(text = ""): void {
  process.stdout.write(text + "\n");
}

function printJson(value: unknown): void {
  print(JSON.stringify(value, null, 2));
}

function quoteArg(value: string): string {
  return /^[\w@%+=:,./~-]+$/.test(value) ? value : `"${value}"`;
}

// How the user ran this, for the "fix:" hints.
function selfCommand(o: Options): string {
  const root = o.root ? ` --root ${quoteArg(o.root)}` : "";
  if (process.env.npm_lifecycle_event === "setup") return `npm run setup --${root}`;
  if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
    return `${path.basename(process.execPath)} --setup-cli${root}`;
  }
  const script = process.argv[1] ?? "dist/setup/cli.js";
  const relative = path.relative(process.cwd(), script);
  const shown = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : displayPath(script);
  return `node ${quoteArg(shown)}${root}`;
}

function actionCommand(actionId: string): string {
  const [name, arg] = actionId.split(":", 2);
  switch (name) {
    case "cdp.enable":
      return `cdp --variant ${arg}`;
    case "mcp.register":
      return `mcp --client ${arg}`;
    case "skills.install":
      return `skills --client ${arg}`;
    case "linux.desktop":
      return "desktop";
    case "win.virtualdesktop":
      return "deps --install";
    default:
      return "all";
  }
}

function canAsk(o: Options): boolean {
  return !o.yes && !o.dryRun && !o.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [Y/n] `, resolve));
    return !/^\s*n/i.test(answer);
  } finally {
    rl.close();
  }
}

function contextFor(o: Options): InstallContext {
  if (!o.root) return detectInstallContext();
  const root = path.resolve(o.root);
  if (!isFile(path.join(root, "package.json"))) throw new UsageError(`${root} has no package.json`);
  return detectInstallContext({ root });
}

async function doctor(o: Options, ctx: InstallContext): Promise<number> {
  const checks = await runDoctor({ deep: o.deep, ctx });
  const failed = checks.filter((check) => check.status === "fail");
  if (o.json) {
    printJson({ version: ctx.version, kind: ctx.kind, appRoot: ctx.appRoot, checks });
    return failed.length > 0 ? 1 : 0;
  }

  print(`Reprompty ${ctx.version}, ${installKindLabel(ctx.kind)} in ${displayPath(ctx.appRoot)}`);
  const rows = checks.filter((check) => check.id !== "app.version");
  const width = Math.min(28, Math.max(...rows.map((check) => check.label.length)));
  const self = selfCommand(o);
  for (const group of Object.keys(GROUP_TITLES) as CheckGroup[]) {
    const inGroup = rows.filter((check) => check.group === group);
    if (inGroup.length === 0) continue;
    print();
    print(GROUP_TITLES[group]);
    for (const check of inGroup) {
      print(`  ${BADGES[check.status].padEnd(5)} ${check.label.padEnd(width)}  ${check.detail ?? ""}`.trimEnd());
      if (check.status === "ok" || check.status === "info") continue;
      const fix = check.action ? `${self} ${actionCommand(check.action.id)}` : check.command;
      if (fix) print(`  ${"".padEnd(5)} ${"".padEnd(width)}  fix: ${fix}`);
    }
  }
  const warnings = checks.filter((check) => check.status === "warn").length;
  print();
  if (failed.length === 0 && warnings === 0) {
    print("Everything is set up.");
  } else {
    const parts = [
      failed.length > 0 ? `${failed.length} check${failed.length === 1 ? "" : "s"} failed` : "",
      warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    print(`${parts.join(", ")}. To set up everything found: ${self} all`);
  }
  return failed.length > 0 ? 1 : 0;
}

interface Ran {
  action: string;
  result: ActionResult;
}

// The same failure for several agents (a missing skill file) is printed once.
function printResult(result: ActionResult, printed: Set<string>): void {
  for (const line of result.message.split("\n")) {
    if (!result.ok && printed.has(line)) continue;
    if (!result.ok) printed.add(line);
    print(`  ${result.ok ? "" : "FAIL "}${line}`);
  }
}

function finish(o: Options, ran: Ran[], skipped: string[] = []): number {
  const ok = ran.every((entry) => entry.result.ok);
  const files = [...new Set(ran.flatMap((entry) => entry.result.files ?? []))];
  if (o.json) {
    printJson({ ok, dryRun: o.dryRun, files, skipped, results: ran.map((entry) => ({ action: entry.action, ...entry.result })) });
    return ok ? 0 : 1;
  }
  print();
  if (o.dryRun) {
    print(
      files.length > 0
        ? `Dry run: ${files.length} file${files.length === 1 ? "" : "s"} would change. Nothing was written.`
        : "Dry run: nothing would change."
    );
  } else if (files.length > 0) {
    const backups = ran.some((entry) => (entry.result.backups ?? []).length > 0);
    print(`Changed ${files.length} file${files.length === 1 ? "" : "s"}.${backups ? ` Backups are in ${displayPath(backupsDir())}.` : ""}`);
  } else if (ran.length > 0 && ok) {
    print("Nothing needed changing.");
  }
  const next = [...new Set(ran.map((entry) => entry.result.next).filter((value): value is string => Boolean(value)))];
  if (!o.dryRun && next.length > 0) {
    print("Next:");
    for (const step of next) print(`  ${step}`);
  }
  return ok ? 0 : 1;
}

async function runActions(o: Options, ctx: InstallContext, actions: string[]): Promise<Ran[]> {
  const ran: Ran[] = [];
  const printed = new Set<string>();
  for (const action of actions) {
    const result = await runAction(action, { ctx, port: o.port, dryRun: o.dryRun });
    ran.push({ action, result });
    if (!o.json) printResult(result, printed);
  }
  return ran;
}

async function setupAll(o: Options, ctx: InstallContext): Promise<number> {
  const groups = await planSetup({ ctx, port: o.port });
  if (groups.length === 0) {
    if (o.json) printJson({ ok: true, dryRun: o.dryRun, files: [], skipped: [], results: [] });
    else print("Everything is already set up.");
    return 0;
  }
  const ran: Ran[] = [];
  const skipped: string[] = [];
  for (const group of groups) {
    if (!o.json) print(`\n${group.title}`);
    if (canAsk(o)) {
      if (!(await confirm(`  ${group.question}`))) {
        skipped.push(group.id);
        print("  Skipped");
        continue;
      }
    } else if (group.id === "cdp" && !o.json) {
      print(`  ${CDP_SECURITY_NOTE}`);
    }
    ran.push(...(await runActions(o, ctx, group.actions)));
  }
  return finish(o, ran, skipped);
}

async function cdp(o: Options, ctx: InstallContext): Promise<number> {
  const all = listVsCodeVariants();
  for (const id of o.variants) {
    if (!all.some((variant) => variant.id === id)) {
      throw new UsageError(`Unknown --variant ${id}; use ${all.map((variant) => variant.id).join(", ")}`);
    }
  }
  const seen = new Set<string>();
  const variants = all.filter((variant) => {
    const wanted = o.variants.length > 0 ? o.variants.includes(variant.id) : variant.installed;
    if (!wanted || seen.has(variant.argvPath)) return false;
    seen.add(variant.argvPath);
    return true;
  });
  if (variants.length === 0) {
    if (o.json) printJson({ ok: false, dryRun: o.dryRun, files: [], results: [] });
    else print("VS Code isn't installed here (or hasn't been started yet).");
    return 1;
  }
  const port = o.port ?? defaultCdpPort();
  if (!o.remove && canAsk(o)) {
    if (!(await confirm(`Turn on VS Code's debugging port ${port}? ${CDP_SECURITY_NOTE}`))) return 0;
  } else if (!o.remove && !o.json) {
    print(CDP_SECURITY_NOTE);
  }
  const verb = o.remove ? "cdp.disable" : "cdp.enable";
  return finish(o, await runActions(o, ctx, variants.map((variant) => `${verb}:${variant.id}`)));
}

function selectedClients(o: Options): ClientId[] {
  for (const id of o.clients) {
    if (!(CLIENT_IDS as readonly string[]).includes(id)) throw new UsageError(`Unknown agent ${id}; use ${CLIENT_IDS.join(", ")}`);
  }
  return o.clients.length > 0 ? (o.clients as ClientId[]) : CLIENT_IDS.filter((id) => isClientInstalled(id));
}

async function mcp(o: Options, ctx: InstallContext): Promise<number> {
  const clients = selectedClients(o);
  if (o.print) {
    const launch = resolveMcpLaunch(ctx);
    const shown = clients.length > 0 ? clients : [...CLIENT_IDS];
    if (o.json) {
      printJson({ launch, snippets: Object.fromEntries(shown.map((id) => [id, configSnippet(id, launch)])) });
    } else {
      for (const id of shown) {
        print(CLIENT_LABELS[id]);
        print(configSnippet(id, launch));
        print();
      }
    }
    return 0;
  }
  if (clients.length === 0) {
    if (o.json) printJson({ ok: true, dryRun: o.dryRun, files: [], results: [] });
    else print(`No AI agents found. Supported: ${CLIENT_IDS.map((id) => CLIENT_LABELS[id]).join(", ")}.`);
    return 0;
  }
  const verb = o.remove ? "mcp.remove" : "mcp.register";
  return finish(o, await runActions(o, ctx, clients.map((id) => `${verb}:${id}`)));
}

async function skills(o: Options, ctx: InstallContext): Promise<number> {
  for (const id of o.clients) {
    if (!(SKILL_AGENTS as readonly string[]).includes(id)) {
      throw new UsageError(`No skill folder for ${id}; use ${SKILL_AGENTS.join(", ")}`);
    }
  }
  const targets = skillTargets(ctx.skillFile).filter((target) =>
    o.clients.length > 0 ? o.clients.includes(target.agent) : target.detected
  );
  if (targets.length === 0) {
    if (o.json) printJson({ ok: true, dryRun: o.dryRun, files: [], results: [] });
    else print("No AI agents found that use skills.");
    return 0;
  }
  const verb = o.remove ? "skills.remove" : "skills.install";
  return finish(o, await runActions(o, ctx, targets.map((target) => `${verb}:${target.agent as SkillAgent}`)));
}

async function desktop(o: Options, ctx: InstallContext): Promise<number> {
  return finish(o, await runActions(o, ctx, [o.remove ? "linux.desktop.remove" : "linux.desktop"]));
}

async function deps(o: Options, ctx: InstallContext): Promise<number> {
  if (process.platform === "win32") {
    const installed = await virtualDesktopModule();
    if (o.install && !installed) {
      if (canAsk(o) && !(await confirm("Install the VirtualDesktop PowerShell module for this user?"))) return 0;
      return finish(o, await runActions(o, ctx, ["win.virtualdesktop"]));
    }
    if (o.json) printJson({ virtualDesktopModule: installed });
    else print(installed ? "The VirtualDesktop module is installed." : `Missing the VirtualDesktop module. Install it with: ${VIRTUAL_DESKTOP_INSTALL}`);
    return 0;
  }
  if (process.platform !== "linux") {
    print("Reprompty supports Windows 11 and KDE Plasma 6.");
    return 1;
  }
  const list = linuxDeps();
  const missing = list.filter((dep) => !dep.found);
  const commands = linuxInstallHint(missing);
  const requiredMissing = missing.some((dep) => dep.required);
  if (o.json) {
    printJson({ deps: list, commands });
    return requiredMissing ? 1 : 0;
  }
  const width = Math.max(...list.map((dep) => dep.label.length));
  for (const dep of list) {
    const state = dep.found ? `found: ${displayPath(dep.found)}` : dep.required ? "MISSING (required)" : "missing";
    print(`  ${dep.label.padEnd(width)}  ${state}  (${dep.neededFor})`);
  }
  print();
  if (commands.length === 0) {
    print("Nothing is missing.");
  } else {
    print("Install what's missing with:");
    for (const command of commands) print(`  ${command}`);
  }
  return requiredMissing ? 1 : 0;
}

// The package a server bundle belongs to, two folders up from dist/mcp/server.js.
function versionNextTo(serverJs: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(serverJs), "..", "..", "package.json"), "utf-8"));
    return pkg?.name === "reprompty" && typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

async function mcpTest(o: Options, ctx: InstallContext): Promise<number> {
  let args: Record<string, unknown> | undefined;
  if (o.args !== undefined) {
    try {
      args = JSON.parse(o.args);
    } catch {
      throw new UsageError("--args needs a JSON object");
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new UsageError("--args needs a JSON object");
  }

  let launch: McpLaunch | null;
  let expectVersion: string | null = ctx.version;
  let missing: string | null = null;
  if (o.server) {
    const server = path.resolve(o.server);
    // This process's own runtime: node, or Electron in node mode.
    launch = {
      command: process.execPath,
      args: [server],
      env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
    };
    expectVersion = versionNextTo(server);
    if (!isFile(server)) missing = `${displayPath(server)} doesn't exist`;
  } else if (o.registered) {
    if (!(CLIENT_IDS as readonly string[]).includes(o.registered)) {
      throw new UsageError(`Unknown agent ${o.registered}; use ${CLIENT_IDS.join(", ")}`);
    }
    launch = registeredLaunch(o.registered as ClientId);
    if (!launch) missing = `${CLIENT_LABELS[o.registered as ClientId]} has no Reprompty entry`;
  } else {
    launch = resolveMcpLaunch(ctx);
    if (!isFile(ctx.serverJs)) {
      missing = `${displayPath(ctx.serverJs)} is missing${ctx.kind === "source" ? "; build it with npm run build:mcp" : ""}`;
    }
  }
  if (missing || !launch) {
    if (o.json) printJson({ ok: false, error: missing });
    else print(`FAIL  ${missing}`);
    return 1;
  }

  const result = await mcpHandshake(launch, { call: o.call, args, expectVersion });
  if (o.json) {
    printJson({ command: launch.command, args: launch.args, envKeys: Object.keys(launch.env), ...result });
    return result.ok ? 0 : 1;
  }
  const shown = (value: string) => (path.isAbsolute(value) ? displayPath(value) : value);
  const env = Object.keys(launch.env).map((key) => `${key}=${launch!.env[key]} `).join("");
  print(`Command:  ${env}${[launch.command, ...launch.args].map(shown).join(" ")}`);
  if (result.name) print(`Server:   ${result.name} ${result.version ?? "(no version)"}`);
  if (expectVersion === null) print("Version:  not checked (no package.json next to the server)");
  if (result.tools !== undefined) print(`Tools:    ${result.tools}`);
  if (o.call && result.result !== undefined) {
    print(`${o.call}:`);
    print(result.result);
  }
  if (result.error) print(`FAIL  ${result.error}`);
  for (const problem of result.problems) print(`FAIL  ${problem}`);
  if (result.stderr) {
    print("Server stderr (last lines):");
    for (const line of result.stderr.split("\n")) print(`  ${line}`);
  }
  print(result.ok ? "MCP test passed." : "MCP test failed.");
  return result.ok ? 0 : 1;
}

/** Runs one setup command; resolves to the exit code (0 OK, 1 failed, 2 crashed or wrong usage). */
export async function runCli(argv: string[]): Promise<number> {
  let o: Options;
  try {
    o = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n\n${USAGE}\n`);
    return 2;
  }
  if (o.help) {
    print(USAGE);
    return 0;
  }
  try {
    const ctx = contextFor(o);
    if (o.dryRun && !o.json && ["all", "cdp", "mcp", "skills", "desktop"].includes(o.command) && !o.print) {
      print("Dry run: nothing is written.");
    }
    switch (o.command) {
      case "all":
        return await setupAll(o, ctx);
      case "cdp":
        return await cdp(o, ctx);
      case "mcp":
        return await mcp(o, ctx);
      case "skills":
        return await skills(o, ctx);
      case "desktop":
        return await desktop(o, ctx);
      case "deps":
        return await deps(o, ctx);
      case "mcp-test":
        return await mcpTest(o, ctx);
      default:
        return await doctor(o, ctx);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    process.stderr.write(`Setup crashed: ${err instanceof Error ? (err.stack ?? err.message) : err}\n`);
    return 2;
  }
}
