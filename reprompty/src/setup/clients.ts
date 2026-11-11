import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { vscodeVariants } from "../core/vscode-paths.js";
import { findExecutable } from "../core/which.js";
import { configHome, displayPath, isDirectory, isFile, type ActionResult } from "./context.js";
import { backupFile, commitWrite, getPath, parseJsonc, readTextFile, setJsoncValue, type TextFile } from "./fs-safe.js";
import { SERVER_NAME, type McpLaunch } from "./launch.js";
import { readTomlTable, removeTomlTable, tomlKey, tomlString, upsertTomlTable } from "./toml-block.js";

export type ClientId = "claude" | "codex" | "kimi-code" | "kimi-cli" | "kilo" | "kilo-cli";
export type RegistrationState = "missing" | "registered" | "different";

export const CLIENT_IDS: readonly ClientId[] = ["claude", "codex", "kimi-code", "kimi-cli", "kilo", "kilo-cli"];

export const CLIENT_LABELS: Record<ClientId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  "kimi-code": "Kimi Code",
  "kimi-cli": "Kimi CLI",
  kilo: "Kilo Code",
  "kilo-cli": "Kilo CLI",
};

export interface ClientStatus {
  id: ClientId;
  label: string;
  installed: boolean;
  configPath: string | null;
  state: RegistrationState;
  /** What differs from this install's command */
  detail?: string;
  /** Why the config couldn't be read; nothing is written then */
  error?: string;
  /** The registered command, when there is one */
  registered?: McpLaunch;
}

// Layout runs can take up to 60 s.
const TOOL_TIMEOUT_SEC = 120;
const CODEX_TABLE = `mcp_servers.${SERVER_NAME}`;
const CODEX_KEYS = new Set(["command", "args", "env", "tool_timeout_sec"]);
const JSON_KEY = ["mcpServers", SERVER_NAME];
const KILO_CLI_KEY = ["mcp", "servers", SERVER_NAME];
// The flat form, which Kilo deprecated
const KILO_CLI_FLAT_KEY = ["mcp", SERVER_NAME];
// Tool approvals the user made in Kilo Code survive a new registration.
const KILO_KEPT_KEYS = ["alwaysAllow", "disabledTools"];
const RELOAD_HINT = "Reload the VS Code window (or restart the agent) so it loads Reprompty.";

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function claudeConfigFile(): string {
  const legacy = path.join(claudeHome(), ".config.json");
  if (isFile(legacy)) return legacy;
  return path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json");
}

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function kimiCodeHome(): string {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
}

export function kimiCliHome(): string {
  return path.join(os.homedir(), ".kimi");
}

function extensionRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".vscode-insiders", "extensions"),
    path.join(home, ".vscode-oss", "extensions"),
    path.join(home, ".var", "app", "com.visualstudio.code", "data", "vscode", "extensions"),
  ];
}

function versionOf(name: string, prefix: string): number[] {
  const match = /^\d+(\.\d+)*/.exec(name.slice(prefix.length));
  return match ? match[0].split(".").map(Number) : [];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Installed VS Code extension folders starting with the prefix, newest version first. */
export function findExtensions(prefix: string): string[] {
  const found: Array<{ dir: string; version: number[] }> = [];
  for (const root of extensionRoots()) {
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.toLowerCase().startsWith(prefix) && /^\d/.test(name.slice(prefix.length))) {
        found.push({ dir: path.join(root, name), version: versionOf(name, prefix) });
      }
    }
  }
  return found.sort((a, b) => compareVersions(b.version, a.version)).map((entry) => entry.dir);
}

/** The claude CLI on PATH, else the one bundled with the newest Claude Code extension. */
export function findClaudeCli(): string | null {
  // Without a shell, Windows can't run claude.cmd; only the native claude.exe works.
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const home = os.homedir();
  const found =
    findExecutable(exe) ?? findExecutable(exe, [path.join(home, ".local", "bin"), path.join(home, ".claude", "local")]);
  if (found) return found;
  for (const dir of findExtensions("anthropic.claude-code-")) {
    const bundled = findExecutable(path.join(dir, "resources", "native-binary", exe));
    if (bundled) return bundled;
  }
  return null;
}

function kiloSettingsFiles(): string[] {
  const dirs = vscodeVariants().map((variant) =>
    path.join(variant.userDataDir, "User", "globalStorage", "kilocode.kilo-code")
  );
  return [...new Set(dirs)].filter(isDirectory).map((dir) => path.join(dir, "settings", "mcp_settings.json"));
}

function kiloCliConfig(): string | null {
  const dir = path.join(configHome(), "kilo");
  return ["kilo.jsonc", "kilo.json"].map((name) => path.join(dir, name)).find(isFile) ?? null;
}

export function isClientInstalled(id: ClientId): boolean {
  switch (id) {
    case "claude":
      return isDirectory(claudeHome()) || findClaudeCli() !== null;
    case "codex":
      return (
        isDirectory(codexHome()) || findExecutable("codex") !== null || findExtensions("openai.chatgpt-").length > 0
      );
    case "kimi-code":
      return isDirectory(kimiCodeHome()) || findExtensions("moonshot-ai.kimi-code-").length > 0;
    case "kimi-cli":
      return isDirectory(kimiCliHome());
    case "kilo":
      return kiloSettingsFiles().length > 0;
    case "kilo-cli":
      return kiloCliConfig() !== null;
  }
}

/** The files that hold (or would hold) the client's reprompty entry. */
export function clientConfigFiles(id: ClientId): string[] {
  switch (id) {
    case "claude":
      return [claudeConfigFile()];
    case "codex":
      return [path.join(codexHome(), "config.toml")];
    case "kimi-code":
      return [path.join(kimiCodeHome(), "mcp.json")];
    case "kimi-cli":
      return [path.join(kimiCliHome(), "mcp.json")];
    case "kilo":
      return kiloSettingsFiles();
    case "kilo-cli": {
      const file = kiloCliConfig();
      return file ? [file] : [];
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return null;
    out[key] = item;
  }
  return out;
}

function toLaunch(command: unknown, args: unknown, env: unknown): McpLaunch | null {
  const envRecord = stringRecord(env);
  if (typeof command !== "string" || !envRecord) return null;
  const argList = args === undefined ? [] : args;
  if (!Array.isArray(argList) || !argList.every((arg) => typeof arg === "string")) return null;
  return { command, args: argList as string[], env: envRecord };
}

export function sameLaunch(a: McpLaunch | null | undefined, b: McpLaunch): boolean {
  if (!a || a.command !== b.command || a.args.length !== b.args.length) return false;
  if (a.args.some((arg, i) => arg !== b.args[i])) return false;
  const keys = Object.keys(a.env);
  return keys.length === Object.keys(b.env).length && keys.every((key) => a.env[key] === b.env[key]);
}

function shownPath(value: string): string {
  return path.isAbsolute(value) ? displayPath(value) : value;
}

function shownArgs(args: string[]): string {
  return `[${args.map(shownPath).join(" ")}]`;
}

/** What changes between two commands; env values never appear, only their names. */
export function describeChange(before: McpLaunch | null | undefined, after: McpLaunch): string {
  if (!before) return "";
  const parts: string[] = [];
  if (before.command !== after.command) parts.push(`command ${shownPath(before.command)} -> ${shownPath(after.command)}`);
  if (before.args.join("\0") !== after.args.join("\0")) parts.push(`args ${shownArgs(before.args)} -> ${shownArgs(after.args)}`);
  const envBefore = Object.keys(before.env).sort().join(", ") || "none";
  const envAfter = Object.keys(after.env).sort().join(", ") || "none";
  if (!sameLaunch({ ...after, env: before.env }, after)) {
    parts.push(envBefore === envAfter ? `env values of ${envAfter}` : `env ${envBefore} -> ${envAfter}`);
  }
  return parts.join(", ");
}

interface EntryRead {
  file: string;
  before: TextFile | null;
  /** Parsed JSON or TOML text, when the file could be read */
  value?: unknown;
  /** The reprompty entry as found */
  entry?: unknown;
  launch: McpLaunch | null;
  /** The entry has the timeout and type this install writes */
  complete: boolean;
  error?: string;
}

function readJsonEntry(id: ClientId, file: string): EntryRead {
  let before: TextFile | null;
  try {
    before = readTextFile(file);
  } catch (err) {
    return { file, before: null, launch: null, complete: false, error: `Can't read ${displayPath(file)} (${errorMessage(err)})` };
  }
  const parsed = parseJsonc(before?.text ?? "");
  if (parsed.error) {
    return { file, before, launch: null, complete: false, error: `Can't use ${displayPath(file)} (${parsed.error})` };
  }
  const keyPath = id === "kilo-cli" ? KILO_CLI_KEY : JSON_KEY;
  for (let i = 1; i < keyPath.length; i++) {
    const parent = getPath(parsed.value, keyPath.slice(0, i));
    if (parent !== undefined && !isObject(parent)) {
      return {
        file,
        before,
        launch: null,
        complete: false,
        error: `${keyPath.slice(0, i).join(".")} in ${displayPath(file)} isn't an object`,
      };
    }
  }

  let entry = getPath(parsed.value, keyPath);
  if (id === "kilo-cli" && entry === undefined) entry = getPath(parsed.value, KILO_CLI_FLAT_KEY);
  if (!isObject(entry)) return { file, before, value: parsed.value, entry, launch: null, complete: false };

  if (id === "kilo-cli") {
    const command = Array.isArray(entry.command) ? entry.command : [];
    const launch = toLaunch(command[0], command.slice(1), entry.environment);
    return { file, before, value: parsed.value, entry, launch, complete: entry.type === "local" };
  }
  const launch = toLaunch(entry.command, entry.args, entry.env);
  let complete = true;
  if (id === "claude") complete = entry.type === undefined || entry.type === "stdio";
  if (id === "kilo") complete = typeof entry.timeout === "number" && entry.timeout >= TOOL_TIMEOUT_SEC;
  return { file, before, value: parsed.value, entry, launch, complete };
}

function readCodexEntry(file: string): EntryRead {
  let before: TextFile | null;
  try {
    before = readTextFile(file);
  } catch (err) {
    return { file, before: null, launch: null, complete: false, error: `Can't read ${displayPath(file)} (${errorMessage(err)})` };
  }
  try {
    const table = readTomlTable(before?.text ?? "", CODEX_TABLE);
    if (!table) return { file, before, launch: null, complete: false };
    const values = table.values;
    const timeout = values.tool_timeout_sec;
    return {
      file,
      before,
      value: table,
      entry: values,
      launch: toLaunch(values.command, values.args, values.env),
      complete: typeof timeout === "number" && timeout >= TOOL_TIMEOUT_SEC,
    };
  } catch (err) {
    return { file, before, launch: null, complete: false, error: `Can't use ${displayPath(file)} (${errorMessage(err)})` };
  }
}

function readEntry(id: ClientId, file: string): EntryRead {
  return id === "codex" ? readCodexEntry(file) : readJsonEntry(id, file);
}

function isRegistered(read: EntryRead, l: McpLaunch): boolean {
  return !read.error && read.complete && sameLaunch(read.launch, l);
}

export function clientStatus(id: ClientId, l: McpLaunch): ClientStatus {
  const files = clientConfigFiles(id);
  const status: ClientStatus = {
    id,
    label: CLIENT_LABELS[id],
    installed: isClientInstalled(id),
    configPath: files[0] ?? null,
    state: "missing",
  };
  const reads = files.map((file) => readEntry(id, file));
  const failed = reads.find((read) => read.error);
  if (failed) {
    status.error = failed.error;
    status.configPath = failed.file;
  }
  const found = reads.filter((read) => !read.error && read.entry !== undefined);
  if (found.length === 0) return status;

  status.registered = found.find((read) => read.launch)?.launch ?? undefined;
  const stale = reads.find((read) => !read.error && !isRegistered(read, l));
  if (!stale && !failed) {
    status.state = "registered";
    return status;
  }
  status.state = "different";
  if (stale) {
    status.configPath = stale.file;
    status.detail = stale.launch
      ? describeChange(stale.launch, l) || "missing the timeout or type this version sets"
      : stale.entry === undefined
        ? `not in ${displayPath(stale.file)}`
        : "the entry isn't a command Reprompty can read";
  }
  return status;
}

/** The command a client would run for reprompty, read from its config. */
export function registeredLaunch(id: ClientId): McpLaunch | null {
  for (const file of clientConfigFiles(id)) {
    const read = readEntry(id, file);
    if (read.launch) return read.launch;
  }
  return null;
}

function jsonEntry(id: ClientId, l: McpLaunch, existing: unknown): Record<string, unknown> {
  if (id === "kilo-cli") {
    const entry: Record<string, unknown> = { type: "local", command: [l.command, ...l.args], environment: l.env };
    if (isObject(existing) && isObject(existing.timeout)) entry.timeout = existing.timeout;
    return entry;
  }
  if (id === "claude") return { type: "stdio", command: l.command, args: l.args, env: l.env };
  const entry: Record<string, unknown> = { command: l.command, args: l.args, env: l.env };
  if (id === "kilo") {
    entry.timeout = TOOL_TIMEOUT_SEC;
    for (const key of KILO_KEPT_KEYS) {
      if (isObject(existing) && existing[key] !== undefined) entry[key] = existing[key];
    }
  }
  return entry;
}

function codexBody(l: McpLaunch, kept: string[]): string[] {
  const lines = [`command = ${tomlString(l.command)}`, `args = [${l.args.map(tomlString).join(", ")}]`];
  const env = Object.entries(l.env);
  if (env.length > 0) {
    lines.push(`env = { ${env.map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(", ")} }`);
  }
  lines.push(`tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`, ...kept);
  return lines;
}

/** The file's text with this install's entry; throws when the file can't take it. */
function updatedText(id: ClientId, read: EntryRead, l: McpLaunch): string {
  const text = read.before?.text ?? "";
  if (id === "codex") {
    const table = read.value as ReturnType<typeof readTomlTable>;
    const kept = (table?.entries ?? []).filter((entry) => !CODEX_KEYS.has(entry.key[0])).flatMap((entry) => entry.lines);
    return upsertTomlTable(text, CODEX_TABLE, codexBody(l, kept));
  }
  const keyPath = id === "kilo-cli" ? KILO_CLI_KEY : JSON_KEY;
  let after = setJsoncValue(text, keyPath, jsonEntry(id, l, read.entry));
  if (id === "kilo-cli" && getPath(read.value, KILO_CLI_FLAT_KEY) !== undefined) {
    after = setJsoncValue(after, KILO_CLI_FLAT_KEY, undefined);
  }
  return after;
}

function entryName(id: ClientId): string {
  if (id === "codex") return `[${CODEX_TABLE}]`;
  return (id === "kilo-cli" ? KILO_CLI_KEY : JSON_KEY).join(".");
}

function describeWrite(id: ClientId, read: EntryRead, l: McpLaunch, dryRun: boolean): string {
  const where = displayPath(read.file);
  if (!read.before) return `${dryRun ? "Would create" : "Created"} ${where} with ${entryName(id)}`;
  const verb = `${dryRun ? "Would change" : "Changed"} ${where}:`;
  if (read.entry === undefined) return `${verb} add ${entryName(id)}`;
  const change = describeChange(read.launch, l);
  return `${verb} update ${entryName(id)}${change ? ` (${change})` : read.launch ? " (timeout and type)" : ""}`;
}

interface FileOutcome {
  ok: boolean;
  changed: boolean;
  message: string;
  file: string;
  backup?: string | null;
}

function writeEntry(id: ClientId, read: EntryRead, l: McpLaunch, dryRun: boolean): FileOutcome {
  const where = displayPath(read.file);
  if (read.error) return { ok: false, changed: false, file: read.file, message: `${read.error}; not changed` };
  if (isRegistered(read, l)) return { ok: true, changed: false, file: read.file, message: `${where} already has Reprompty` };
  try {
    const after = updatedText(id, read, l);
    // New files can later hold credentials, so only the user may read them.
    const { changed, backup } = commitWrite(read.file, read.before, after, { dryRun, mode: 0o600 });
    return { ok: true, changed, file: read.file, backup, message: describeWrite(id, read, l, dryRun) };
  } catch (err) {
    return { ok: false, changed: false, file: read.file, message: `Couldn't write ${where}: ${errorMessage(err)}` };
  }
}

function combine(outcomes: FileOutcome[], next?: string): ActionResult {
  const changed = outcomes.filter((outcome) => outcome.changed);
  return {
    ok: outcomes.every((outcome) => outcome.ok),
    changed: changed.length > 0,
    message: outcomes.map((outcome) => outcome.message).join("\n"),
    files: changed.map((outcome) => outcome.file),
    backups: outcomes.map((outcome) => outcome.backup).filter((backup): backup is string => Boolean(backup)),
    next: changed.length > 0 ? next : undefined,
  };
}

function runClaudeCli(cli: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(cli, args, {
    encoding: "utf-8",
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, DISABLE_AUTOUPDATER: "1" },
  });
  if (result.error) return { ok: false, output: result.error.message };
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split(/\r?\n/).pop() ?? "";
  return { ok: result.status === 0, output };
}

function registerClaude(read: EntryRead, l: McpLaunch, dryRun: boolean): FileOutcome {
  const cli = findClaudeCli();
  if (!cli || read.error || isRegistered(read, l)) return writeEntry("claude", read, l, dryRun);
  const how = describeWrite("claude", read, l, dryRun);
  if (dryRun) {
    return { ok: true, changed: true, file: read.file, message: `${how}, through ${shownPath(cli)} mcp add-json` };
  }
  const backup = read.before ? backupFile(read.file) : null;
  if (read.entry !== undefined) runClaudeCli(cli, ["mcp", "remove", "--scope", "user", SERVER_NAME]);
  const json = JSON.stringify(jsonEntry("claude", l, undefined));
  const added = runClaudeCli(cli, ["mcp", "add-json", "--scope", "user", SERVER_NAME, json]);
  if (added.ok) return { ok: true, changed: true, file: read.file, backup, message: `${how}, through claude mcp add-json` };

  // The CLI failed: edit the file instead.
  const fallback = writeEntry("claude", readJsonEntry("claude", read.file), l, false);
  if (fallback.ok) fallback.message += ` (claude mcp add-json failed: ${added.output})`;
  return { ...fallback, backup: fallback.backup ?? backup };
}

export async function registerClient(id: ClientId, l: McpLaunch, o: { dryRun?: boolean } = {}): Promise<ActionResult> {
  const dryRun = Boolean(o.dryRun);
  const label = CLIENT_LABELS[id];
  if (!isClientInstalled(id)) return { ok: false, changed: false, message: `${label} isn't installed here` };
  const files = clientConfigFiles(id);
  if (files.length === 0) return { ok: false, changed: false, message: `Couldn't find ${label}'s settings` };
  const outcomes = files.map((file) => {
    const read = readEntry(id, file);
    return id === "claude" ? registerClaude(read, l, dryRun) : writeEntry(id, read, l, dryRun);
  });
  return combine(outcomes, RELOAD_HINT);
}

function removeEntry(id: ClientId, read: EntryRead, dryRun: boolean): FileOutcome {
  const where = displayPath(read.file);
  if (read.error) return { ok: false, changed: false, file: read.file, message: `${read.error}; not changed` };
  if (read.entry === undefined) return { ok: true, changed: false, file: read.file, message: `${where} doesn't have Reprompty` };
  const text = read.before?.text ?? "";
  try {
    let after: string;
    if (id === "codex") {
      after = removeTomlTable(text, CODEX_TABLE);
    } else {
      after = setJsoncValue(text, id === "kilo-cli" ? KILO_CLI_KEY : JSON_KEY, undefined);
      if (id === "kilo-cli" && getPath(parseJsonc(after).value, KILO_CLI_FLAT_KEY) !== undefined) {
        after = setJsoncValue(after, KILO_CLI_FLAT_KEY, undefined);
      }
    }
    const { changed, backup } = commitWrite(read.file, read.before, after, { dryRun });
    return {
      ok: true,
      changed,
      file: read.file,
      backup,
      message: `${dryRun ? "Would change" : "Changed"} ${where}: remove ${entryName(id)}`,
    };
  } catch (err) {
    return { ok: false, changed: false, file: read.file, message: `Couldn't write ${where}: ${errorMessage(err)}` };
  }
}

export async function unregisterClient(id: ClientId, o: { dryRun?: boolean } = {}): Promise<ActionResult> {
  const dryRun = Boolean(o.dryRun);
  const outcomes = clientConfigFiles(id).map((file) => {
    const read = readEntry(id, file);
    const cli = id === "claude" && !read.error && read.entry !== undefined ? findClaudeCli() : null;
    if (!cli) return removeEntry(id, read, dryRun);
    const where = displayPath(read.file);
    if (dryRun) {
      return {
        ok: true,
        changed: true,
        file: read.file,
        message: `Would run ${shownPath(cli)} mcp remove --scope user ${SERVER_NAME} (changes ${where})`,
      };
    }
    const backup = read.before ? backupFile(read.file) : null;
    const removed = runClaudeCli(cli, ["mcp", "remove", "--scope", "user", SERVER_NAME]);
    if (removed.ok) return { ok: true, changed: true, file: read.file, backup, message: `Changed ${where}: remove ${entryName(id)}` };
    return removeEntry(id, readJsonEntry(id, read.file), false);
  });
  if (outcomes.length === 0) return { ok: true, changed: false, message: `${CLIENT_LABELS[id]} has no settings file` };
  return combine(outcomes);
}

/** What to add by hand, for `mcp --print`. */
export function configSnippet(id: ClientId, l: McpLaunch): string {
  const where = clientConfigFiles(id).map(displayPath).join(", ") || "its settings file";
  if (id === "codex") return [`# ${where}`, `[${CODEX_TABLE}]`, ...codexBody(l, [])].join("\n");
  const entry = jsonEntry(id, l, undefined);
  const wrapped = id === "kilo-cli" ? { mcp: { servers: { [SERVER_NAME]: entry } } } : { mcpServers: { [SERVER_NAME]: entry } };
  const lines = [`// ${where}`, JSON.stringify(wrapped, null, 2)];
  if (id === "claude" && process.platform !== "win32") {
    const json = JSON.stringify(entry).replace(/'/g, "'\\''");
    lines.unshift(`claude mcp add-json --scope user ${SERVER_NAME} '${json}'`, "", "Or by hand:");
  }
  return lines.join("\n");
}
