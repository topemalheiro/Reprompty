import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { backupFile, backupsDir, commitWrite, readTextFile, setJsoncValue, writeFileAtomic } from "../src/setup/fs-safe.ts";
import { backupFiles, makeTempHome, writeFile, type TempHome } from "./fixtures/setup/temp-home.ts";

const isWindows = process.platform === "win32";

let t: TempHome;

beforeEach(() => {
  t = makeTempHome();
});

afterEach(() => {
  t.restore();
});

describe("backupFile", () => {
  it("copies into ~/.reprompty/backups/<time>/ under a flat name, readable only by the user", () => {
    const file = writeFile(t.at(".codex", "config.toml"), "model = 1\n", 0o644);
    const backup = backupFile(file);
    expect(backup).not.toBeNull();
    expect(path.dirname(path.dirname(backup!))).toBe(backupsDir());
    expect(path.basename(path.dirname(backup!))).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    expect(path.basename(backup!)).toBe(".codex__config.toml");
    expect(fs.readFileSync(backup!, "utf-8")).toBe("model = 1\n");
    if (!isWindows) expect(fs.statSync(backup!).mode & 0o777).toBe(0o600);
  });

  it("returns null for a missing file", () => {
    expect(backupFile(t.at("missing.json"))).toBeNull();
    expect(backupFiles(t.home)).toEqual([]);
  });

  it("starts a new set rather than overwrite a backup of the same file", () => {
    const file = writeFile(t.at("a.json"), "1");
    const first = backupFile(file)!;
    writeFile(file, "2");
    const second = backupFile(file)!;
    expect(path.dirname(first)).not.toBe(path.dirname(second));
    expect(fs.readFileSync(first, "utf-8")).toBe("1");
    expect(fs.readFileSync(second, "utf-8")).toBe("2");
  });

  it("keeps the newest 20 sets", () => {
    for (let i = 0; i < 25; i++) {
      writeFile(path.join(backupsDir(), `2020-01-${String(i + 1).padStart(2, "0")}T00-00-00-000Z`, "old.json"), "{}");
    }
    writeFile(path.join(backupsDir(), "notes", "keep.txt"), "not a set");
    backupFile(writeFile(t.at("a.json"), "{}"));
    const sets = fs.readdirSync(backupsDir()).filter((name) => name.startsWith("20"));
    expect(sets).toHaveLength(20);
    expect(sets).not.toContain("2020-01-01T00-00-00-000Z");
    expect(sets).not.toContain("2020-01-06T00-00-00-000Z");
    expect(sets).toContain("2020-01-07T00-00-00-000Z");
    expect(fs.existsSync(path.join(backupsDir(), "notes", "keep.txt"))).toBe(true);
  });
});

describe("writeFileAtomic", () => {
  it("keeps the byte order mark, CRLF line endings and mode", () => {
    const file = writeFile(t.at("settings.json"), "﻿{\r\n}\r\n", 0o640);
    writeFileAtomic(file, readTextFile(file)!.text.replace(/\r\n/g, "\n").replace("{\n", '{\n  "a": 1\n'));
    expect(fs.readFileSync(file, "utf-8")).toBe('﻿{\r\n  "a": 1\r\n}\r\n');
    if (!isWindows) expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(t.home)).toEqual(["settings.json"]);
  });

  it("creates folders and uses the mode given for new files", () => {
    const file = t.at("new", "dir", "mcp.json");
    writeFileAtomic(file, "{}\n", { mode: 0o600 });
    expect(fs.readFileSync(file, "utf-8")).toBe("{}\n");
    if (!isWindows) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWindows)("writes through a symlink to its target", () => {
    const target = writeFile(t.at("dotfiles", "claude.json"), "{}");
    fs.symlinkSync(target, t.at(".claude.json"));
    writeFileAtomic(t.at(".claude.json"), '{"a":1}');
    expect(fs.lstatSync(t.at(".claude.json")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toBe('{"a":1}');
  });
});

describe("commitWrite", () => {
  it("writes nothing and backs up nothing when the text is the same", () => {
    const file = writeFile(t.at("a.json"), "{}\n");
    expect(commitWrite(file, readTextFile(file), "{}\n")).toEqual({ changed: false, backup: null });
    expect(backupFiles(t.home)).toEqual([]);
  });

  it("backs up the old file before writing a new one", () => {
    const file = writeFile(t.at("a.json"), "{}\n");
    const { changed, backup } = commitWrite(file, readTextFile(file), '{ "a": 1 }\n');
    expect(changed).toBe(true);
    expect(fs.readFileSync(backup!, "utf-8")).toBe("{}\n");
    expect(fs.readFileSync(file, "utf-8")).toBe('{ "a": 1 }\n');
  });

  it("only reports on a dry run", () => {
    const file = writeFile(t.at("a.json"), "{}\n");
    expect(commitWrite(file, readTextFile(file), "[]\n", { dryRun: true })).toEqual({ changed: true, backup: null });
    expect(fs.readFileSync(file, "utf-8")).toBe("{}\n");
    expect(backupFiles(t.home)).toEqual([]);
  });
});

describe("setJsoncValue", () => {
  it("follows the file's indentation", () => {
    expect(setJsoncValue('{\n\t"a": 1\n}', ["b"], 2)).toBe('{\n\t"a": 1,\n\t"b": 2\n}');
    expect(setJsoncValue('{\n    "a": 1\n}', ["b", "c"], 2)).toBe('{\n    "a": 1,\n    "b": {\n        "c": 2\n    }\n}');
  });

  it("starts an empty file", () => {
    expect(setJsoncValue("", ["a"], { b: 1 })).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
  });
});
