import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyEdits, modify, parse, type JSONPath, type ParseError } from "jsonc-parser";

const KEEP_BACKUP_SETS = 20;
// Backups made within this window (one CLI run, one Setup click) share a folder.
const BACKUP_SET_WINDOW_MS = 2 * 60_000;
const BACKUP_SET_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?$/;

let currentSet: { dir: string; at: number } | null = null;

export function backupsDir(): string {
  return path.join(os.homedir(), ".reprompty", "backups");
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export interface TextFile {
  /** Content without a byte order mark */
  text: string;
  bom: boolean;
}

/** The file's text, or null when it doesn't exist. */
export function readTextFile(file: string): TextFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const bom = raw.charCodeAt(0) === 0xfeff;
  return { text: bom ? raw.slice(1) : raw, bom };
}

function realTarget(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

// ~/.codex/config.toml -> .codex__config.toml
function flattenName(file: string): string {
  const relative = path.relative(os.homedir(), file);
  const name = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
  return name.replace(/^[\\/]+/, "").replace(/[\\/:]+/g, "__");
}

function newSetDir(root: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  let dir = path.join(root, stamp);
  for (let i = 1; fs.existsSync(dir); i++) dir = path.join(root, `${stamp}-${i}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function pruneBackups(root: string, keep: string): void {
  let sets: string[];
  try {
    sets = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && BACKUP_SET_NAME.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return;
  }
  for (const name of sets.slice(0, Math.max(0, sets.length - KEEP_BACKUP_SETS))) {
    const dir = path.join(root, name);
    if (dir !== keep) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copy a file into ~/.reprompty/backups/<timestamp>/ (mode 0600: configs can hold
 * credentials) and return the copy's path; null when there is nothing to back up.
 */
export function backupFile(file: string): string | null {
  const source = realTarget(file);
  let data: Buffer;
  try {
    if (!fs.statSync(source).isFile()) return null;
    data = fs.readFileSync(source);
  } catch {
    return null;
  }

  const root = backupsDir();
  const name = flattenName(file);
  const now = Date.now();
  if (
    !currentSet ||
    now - currentSet.at > BACKUP_SET_WINDOW_MS ||
    !fs.existsSync(currentSet.dir) ||
    fs.existsSync(path.join(currentSet.dir, name))
  ) {
    currentSet = { dir: newSetDir(root, now), at: now };
    pruneBackups(root, currentSet.dir);
  }
  const target = path.join(currentSet.dir, name);
  fs.writeFileSync(target, data, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return target;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows refuses the rename while another program has the file open, usually briefly.
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      sleep(50 * (attempt + 1));
    }
  }
}

function tempPath(target: string): string {
  const suffix = `${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  return path.join(path.dirname(target), `.${path.basename(target)}.${suffix}`);
}

/**
 * Write through a temp file in the same folder and a rename. An existing file keeps
 * its mode, byte order mark and CRLF line endings; symlinks are written through.
 */
export function writeFileAtomic(file: string, text: string, o: { mode?: number } = {}): void {
  const target = realTarget(file);
  let mode = o.mode;
  let out = text;
  const existing = (() => {
    try {
      return { mode: fs.statSync(target).mode & 0o7777, current: readTextFile(target) };
    } catch {
      return null;
    }
  })();
  if (existing) {
    mode = existing.mode;
    if (existing.current?.bom && out.charCodeAt(0) !== 0xfeff) out = "\ufeff" + out;
    if (existing.current?.text.includes("\r\n")) out = out.replace(/\r?\n/g, "\r\n");
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = tempPath(target);
  try {
    fs.writeFileSync(temp, out, { mode: mode ?? 0o644 });
    if (mode !== undefined) fs.chmodSync(temp, mode);
    renameWithRetry(temp, target);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/** Byte-for-byte copy through a temp file; returns false when the target already matches. */
export function copyFileAtomic(source: string, target: string, o: { mode?: number } = {}): boolean {
  const data = fs.readFileSync(source);
  try {
    if (sha256(fs.readFileSync(target)) === sha256(data)) return false;
  } catch {
    // missing target
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = tempPath(target);
  try {
    fs.writeFileSync(temp, data, { mode: o.mode ?? 0o644 });
    if (o.mode !== undefined) fs.chmodSync(temp, o.mode);
    renameWithRetry(temp, target);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  return true;
}

export function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Write the new text only when it differs, after backing up the old file.
 * With dryRun nothing is written; `changed` then says whether it would be.
 */
export function commitWrite(
  file: string,
  before: TextFile | null,
  after: string,
  o: { dryRun?: boolean; mode?: number } = {}
): { changed: boolean; backup: string | null } {
  if (before !== null && before.text === after) return { changed: false, backup: null };
  if (o.dryRun) return { changed: true, backup: null };
  const backup = before !== null ? backupFile(file) : null;
  writeFileAtomic(file, after, { mode: o.mode });
  return { changed: true, backup };
}

function lineAndColumn(text: string, offset: number): string {
  const lines = text.slice(0, offset).split("\n");
  return `line ${lines.length}, column ${lines[lines.length - 1].length + 1}`;
}

/** Parses JSON with comments; the error names a position, never the content. */
export function parseJsonc(text: string): { value: unknown; error: string | null } {
  if (text.trim() === "") return { value: {}, error: null };
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) return { value: undefined, error: `syntax error at ${lineAndColumn(text, errors[0].offset)}` };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value: undefined, error: "the top level isn't an object" };
  }
  return { value, error: null };
}

// Follow the file's own indentation and line endings.
function formattingOf(text: string): { insertSpaces: boolean; tabSize: number; eol: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /^([ \t]+)["/}\]]/m.exec(text)?.[1];
  if (indent?.startsWith("\t")) return { insertSpaces: false, tabSize: 4, eol };
  return { insertSpaces: true, tabSize: indent ? Math.min(indent.length, 8) : 2, eol };
}

/** Set (or with undefined, remove) one value, leaving the rest of the text alone. */
export function setJsoncValue(text: string, keyPath: JSONPath, value: unknown): string {
  const base = text.trim() === "" ? "{}" : text;
  const edits = modify(base, keyPath, value, { formattingOptions: formattingOf(base) });
  const out = applyEdits(base, edits);
  return text.trim() === "" ? out + "\n" : out;
}

export function getPath(value: unknown, keyPath: string[]): unknown {
  let node = value;
  for (const key of keyPath) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}
