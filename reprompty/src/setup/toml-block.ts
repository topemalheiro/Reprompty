// Line-based edits of one table in a TOML file (Codex's config.toml). Everything
// outside the table keeps its exact text, comments included.

export class TomlEditError extends Error {}

type KeyPath = string[];

interface Header {
  kind: "header";
  line: number;
  path: KeyPath;
  array: boolean;
}

interface KeyValue {
  kind: "kv";
  line: number;
  endLine: number;
  table: KeyPath;
  key: KeyPath;
  value: string;
}

type Entry = Header | KeyValue;

export interface TomlTable {
  /** The table's values, sub-tables included */
  values: Record<string, unknown>;
  /** Keys set directly in the table, with their original lines */
  entries: Array<{ key: string[]; lines: string[] }>;
}

const BARE_KEY_CHAR = /[A-Za-z0-9_-]/;
const ESCAPES: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\x1b",
  '"': '"',
  "\\": "\\",
};

function skipSpaces(text: string, i: number): number {
  while (text[i] === " " || text[i] === "\t") i++;
  return i;
}

function readEscape(text: string, i: number): { value: string; end: number } {
  const kind = text[i + 1];
  if (kind === "u" || kind === "U") {
    const length = kind === "u" ? 4 : 8;
    const hex = text.slice(i + 2, i + 2 + length);
    if (hex.length !== length || !/^[0-9a-fA-F]+$/.test(hex)) throw new TomlEditError("bad escape");
    return { value: String.fromCodePoint(parseInt(hex, 16)), end: i + 2 + length };
  }
  if (kind in ESCAPES) return { value: ESCAPES[kind], end: i + 2 };
  throw new TomlEditError("bad escape");
}

function readBasicString(text: string, start: number): { value: string; end: number } {
  let value = "";
  let i = start + 1;
  while (i < text.length && text[i] !== "\n") {
    const c = text[i];
    if (c === '"') return { value, end: i + 1 };
    if (c === "\\") {
      const escape = readEscape(text, i);
      value += escape.value;
      i = escape.end;
      continue;
    }
    value += c;
    i++;
  }
  throw new TomlEditError("unterminated string");
}

function literalEnd(text: string, start: number): number {
  const end = text.indexOf("'", start + 1);
  if (end === -1 || text.slice(start, end).includes("\n")) throw new TomlEditError("unterminated string");
  return end + 1;
}

function readKey(text: string, start: number): { path: KeyPath; end: number } {
  const keyPath: KeyPath = [];
  let i = start;
  for (;;) {
    i = skipSpaces(text, i);
    if (text[i] === '"') {
      const part = readBasicString(text, i);
      keyPath.push(part.value);
      i = part.end;
    } else if (text[i] === "'") {
      const end = literalEnd(text, i);
      keyPath.push(text.slice(i + 1, end - 1));
      i = end;
    } else {
      let j = i;
      while (j < text.length && BARE_KEY_CHAR.test(text[j])) j++;
      if (j === i) throw new TomlEditError("bad key");
      keyPath.push(text.slice(i, j));
      i = j;
    }
    i = skipSpaces(text, i);
    if (text[i] !== ".") return { path: keyPath, end: i };
    i++;
  }
}

function parseKeyPath(table: string): KeyPath {
  const key = readKey(table, 0);
  if (key.end !== table.length) throw new TomlEditError(`bad table name ${table}`);
  return key.path;
}

function parseHeader(text: string): { path: KeyPath; array: boolean } {
  const array = text.startsWith("[[");
  const key = readKey(text, array ? 2 : 1);
  let i = key.end;
  const close = array ? "]]" : "]";
  if (!text.startsWith(close, i)) throw new TomlEditError("bad table header");
  i = skipSpaces(text, i + close.length);
  if (i < text.length && text[i] !== "#") throw new TomlEditError("bad table header");
  return { path: key.path, array };
}

type Delimiter = '"""' | "'''";

interface ScanState {
  depth: number;
  multiline: Delimiter | null;
}

// Index just past the closing delimiter, or -1 when the string goes on.
function multilineEnd(text: string, from: number, delimiter: Delimiter): number {
  let i = from;
  while (i < text.length) {
    if (delimiter === '"""' && text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text.startsWith(delimiter, i)) {
      let end = i + 3;
      // Up to two quotes before the closing delimiter belong to the string.
      while (end - i < 5 && text[end] === delimiter[0]) end++;
      return end;
    }
    i++;
  }
  return -1;
}

// Follows strings and brackets so a value can span lines.
function scanValueText(text: string, state: ScanState): ScanState {
  let { depth, multiline } = state;
  let i = 0;
  while (i < text.length) {
    if (multiline) {
      const end = multilineEnd(text, i, multiline);
      if (end === -1) return { depth, multiline };
      i = end;
      multiline = null;
      continue;
    }
    const c = text[i];
    if (c === "#") break;
    if (c === '"' || c === "'") {
      const triple = c.repeat(3) as Delimiter;
      if (text.startsWith(triple, i)) {
        multiline = triple;
        i += 3;
      } else {
        i = c === '"' ? readBasicString(text, i).end : literalEnd(text, i);
      }
      continue;
    }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    i++;
  }
  return { depth, multiline };
}

function scan(lines: string[]): Entry[] {
  const entries: Entry[] = [];
  let table: KeyPath = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trimStart();
    if (text === "" || text.startsWith("#")) continue;
    const start = i;
    try {
      if (text.startsWith("[")) {
        const header = parseHeader(text);
        table = header.path;
        entries.push({ kind: "header", line: i, ...header });
        continue;
      }
      const key = readKey(text, 0);
      const equals = skipSpaces(text, key.end);
      if (text[equals] !== "=") throw new TomlEditError("expected =");
      let value = text.slice(equals + 1);
      let state = scanValueText(value, { depth: 0, multiline: null });
      while (state.depth > 0 || state.multiline) {
        i++;
        if (i >= lines.length) throw new TomlEditError("unterminated value");
        value += "\n" + lines[i];
        state = scanValueText(lines[i], state);
      }
      entries.push({ kind: "kv", line: start, endLine: i, table, key: key.path, value });
    } catch (err) {
      if (err instanceof TomlEditError) throw new TomlEditError(`Can't read line ${start + 1} (${err.message})`);
      throw err;
    }
  }
  return entries;
}

function startsWith(keyPath: KeyPath, prefix: KeyPath): boolean {
  return prefix.length <= keyPath.length && prefix.every((part, i) => keyPath[i] === part);
}

// Headers can't add to a table that inline tables or dotted keys already define.
function checkInlineDefinitions(entries: Entry[], target: KeyPath, table: string): void {
  for (const entry of entries) {
    if (entry.kind === "header") {
      if (entry.array && startsWith(target, entry.path)) {
        throw new TomlEditError(`Line ${entry.line + 1} makes ${entry.path.join(".")} an array; change [${table}] by hand`);
      }
      continue;
    }
    if (startsWith(entry.table, target)) continue;
    const full = [...entry.table, ...entry.key];
    const topLevel = entry.table.length === 0 && entry.key[0] === target[0];
    if (topLevel || startsWith(full, target) || startsWith(target, full)) {
      throw new TomlEditError(
        `Line ${entry.line + 1} sets ${target[0]} inline or with dotted keys; change [${table}] by hand`
      );
    }
  }
}

function tableBlocks(entries: Entry[], target: KeyPath): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];
  let current: { start: number; end: number } | null = null;
  for (const entry of entries) {
    if (entry.kind === "header") {
      current = startsWith(entry.path, target) ? { start: entry.line, end: entry.line } : null;
      if (current) blocks.push(current);
    } else if (current) {
      current.end = entry.endLine;
    }
  }
  return blocks;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function splitLines(text: string): { lines: string[]; eol: string; finalNewline: boolean } {
  const body = text.replace(/\r?\n$/, "");
  return {
    lines: body === "" ? [] : body.split(/\r?\n/),
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    finalNewline: body !== text,
  };
}

function joinLines(lines: string[], eol: string, finalNewline: boolean): string {
  return lines.length === 0 ? "" : lines.join(eol) + (finalNewline ? eol : "");
}

// A block ends at its last value, so comments right above the next header stay with it.
function spliceBlocks(
  lines: string[],
  blocks: Array<{ start: number; end: number }>,
  replacement: string[] | null
): string[] {
  const out: string[] = [];
  let cursor = 0;
  blocks.forEach((block, index) => {
    out.push(...lines.slice(cursor, block.start));
    cursor = block.end + 1;
    if (index === 0 && replacement) {
      out.push(...replacement);
      return;
    }
    while (cursor < lines.length && isBlank(lines[cursor]) && (out.length === 0 || isBlank(out[out.length - 1]))) {
      cursor++;
    }
    if (cursor >= lines.length) {
      while (out.length > 0 && isBlank(out[out.length - 1])) out.pop();
    }
  });
  out.push(...lines.slice(cursor));
  return out;
}

/**
 * Replace [table] and its sub-tables ([table.env], ...) with one new block, in
 * place of the first; append it when the table is missing. Throws when the file
 * defines the table in a way a header can't replace.
 */
export function upsertTomlTable(text: string, table: string, bodyLines: string[]): string {
  const target = parseKeyPath(table);
  const { lines, eol, finalNewline } = splitLines(text);
  const entries = scan(lines);
  checkInlineDefinitions(entries, target, table);
  const block = [`[${table}]`, ...bodyLines];
  const blocks = tableBlocks(entries, target);
  if (blocks.length === 0) {
    const out = [...lines];
    while (out.length > 0 && isBlank(out[out.length - 1])) out.pop();
    if (out.length > 0) out.push("");
    out.push(...block);
    return joinLines(out, eol, true);
  }
  return joinLines(spliceBlocks(lines, blocks, block), eol, finalNewline);
}

export function removeTomlTable(text: string, table: string): string {
  const target = parseKeyPath(table);
  const { lines, eol, finalNewline } = splitLines(text);
  const entries = scan(lines);
  checkInlineDefinitions(entries, target, table);
  const blocks = tableBlocks(entries, target);
  if (blocks.length === 0) return text;
  return joinLines(spliceBlocks(lines, blocks, null), eol, finalNewline);
}

interface ValueCursor {
  s: string;
  i: number;
}

function skipBlank(p: ValueCursor, newlines: boolean): void {
  while (p.i < p.s.length) {
    const c = p.s[p.i];
    if (c === " " || c === "\t" || (newlines && (c === "\n" || c === "\r"))) {
      p.i++;
    } else if (newlines && c === "#") {
      while (p.i < p.s.length && p.s[p.i] !== "\n") p.i++;
    } else {
      break;
    }
  }
}

function readMultiline(p: ValueCursor, delimiter: Delimiter): string {
  p.i += 3;
  if (p.s.startsWith("\r\n", p.i)) p.i += 2;
  else if (p.s[p.i] === "\n") p.i++;
  let value = "";
  while (p.i < p.s.length) {
    if (p.s.startsWith(delimiter, p.i)) {
      let extra = 0;
      while (extra < 2 && p.s[p.i + 3 + extra] === delimiter[0]) extra++;
      p.i += 3 + extra;
      return value + delimiter[0].repeat(extra);
    }
    if (delimiter === '"""' && p.s[p.i] === "\\") {
      const continuation = /^\\[ \t]*\r?\n\s*/.exec(p.s.slice(p.i));
      if (continuation) {
        p.i += continuation[0].length;
        continue;
      }
      const escape = readEscape(p.s, p.i);
      value += escape.value;
      p.i = escape.end;
      continue;
    }
    value += p.s[p.i++];
  }
  throw new TomlEditError("unterminated string");
}

function setPath(target: Record<string, unknown>, keyPath: KeyPath, value: unknown): void {
  let node = target;
  for (const part of keyPath.slice(0, -1)) {
    const next = node[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[keyPath[keyPath.length - 1]] = value;
}

function scalar(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = raw.replace(/_/g, "");
  if (/^[+-]?\d+$/.test(n)) return Number(n);
  if (/^0x[0-9a-fA-F]+$/.test(n)) return parseInt(n.slice(2), 16);
  if (/^0o[0-7]+$/.test(n)) return parseInt(n.slice(2), 8);
  if (/^0b[01]+$/.test(n)) return parseInt(n.slice(2), 2);
  if (/^[+-]?inf$/.test(n)) return n.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(n)) return NaN;
  if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(n)) return Number(n);
  // Dates and times stay text.
  return raw;
}

function readValue(p: ValueCursor): unknown {
  skipBlank(p, false);
  const c = p.s[p.i];
  if (c === '"' || c === "'") {
    const triple = c.repeat(3) as Delimiter;
    if (p.s.startsWith(triple, p.i)) return readMultiline(p, triple);
    if (c === '"') {
      const string = readBasicString(p.s, p.i);
      p.i = string.end;
      return string.value;
    }
    const end = literalEnd(p.s, p.i);
    const value = p.s.slice(p.i + 1, end - 1);
    p.i = end;
    return value;
  }
  if (c === "[" || c === "{") {
    const close = c === "[" ? "]" : "}";
    const list: unknown[] = [];
    const table: Record<string, unknown> = {};
    p.i++;
    for (;;) {
      skipBlank(p, true);
      if (p.s[p.i] === close) {
        p.i++;
        return c === "[" ? list : table;
      }
      if (c === "[") {
        list.push(readValue(p));
      } else {
        const key = readKey(p.s, p.i);
        p.i = skipSpaces(p.s, key.end);
        if (p.s[p.i] !== "=") throw new TomlEditError("expected =");
        p.i++;
        setPath(table, key.path, readValue(p));
      }
      skipBlank(p, true);
      if (p.s[p.i] === ",") p.i++;
      else if (p.s[p.i] !== close) throw new TomlEditError("expected , or " + close);
    }
  }
  const match = /^[^\s,\]}#]+/.exec(p.s.slice(p.i));
  if (!match) throw new TomlEditError("missing value");
  p.i += match[0].length;
  return scalar(match[0]);
}

/** The table's values, or null when the file has no [table]. */
export function readTomlTable(text: string, table: string): TomlTable | null {
  const target = parseKeyPath(table);
  const { lines } = splitLines(text);
  const entries = scan(lines);
  checkInlineDefinitions(entries, target, table);

  let found = false;
  const values: Record<string, unknown> = {};
  const direct: TomlTable["entries"] = [];
  for (const entry of entries) {
    if (entry.kind === "header") {
      if (startsWith(entry.path, target)) found = true;
      continue;
    }
    if (!startsWith(entry.table, target)) continue;
    let value: unknown;
    try {
      value = readValue({ s: entry.value, i: 0 });
    } catch (err) {
      if (err instanceof TomlEditError) throw new TomlEditError(`Can't read line ${entry.line + 1} (${err.message})`);
      throw err;
    }
    setPath(values, [...entry.table.slice(target.length), ...entry.key], value);
    if (entry.table.length === target.length) {
      direct.push({ key: entry.key, lines: lines.slice(entry.line, entry.endLine + 1) });
    }
  }
  return found ? { values, entries: direct } : null;
}

/** A TOML basic string; JSON's escapes are valid TOML apart from DEL. */
export function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\x7f/g, "\\u007f");
}

export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}
