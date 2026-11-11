import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findExecutable, findKdotool } from "../src/core/which.ts";

const isWindows = process.platform === "win32";
const ENV_KEYS = ["HOME", "USERPROFILE", "PATH", "REPROMPTY_KDOTOOL"];
let savedEnv: Record<string, string | undefined>;
let root: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reprompty-which-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PATH = path.join(root, "empty-path");
  delete process.env.REPROMPTY_KDOTOOL;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function touch(file: string, mode = 0o755): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\n", { mode });
  return file;
}

// A command as each OS finds it: tool.cmd on Windows, an executable tool elsewhere.
function command(dir: string, name: string): string {
  return touch(path.join(dir, isWindows ? `${name}.cmd` : name));
}

describe("findExecutable", () => {
  it("finds an executable in an extra folder", () => {
    const bin = path.join(root, "bin");
    const tool = command(bin, "reprompty-tool");
    expect(findExecutable("reprompty-tool", [bin])).toBe(tool);
  });

  it("searches the extra folders before PATH", () => {
    const onPath = path.join(root, "on-path");
    const extra = path.join(root, "extra");
    const pathTool = command(onPath, "reprompty-tool");
    const extraTool = command(extra, "reprompty-tool");
    process.env.PATH = onPath;
    expect(findExecutable("reprompty-tool")).toBe(pathTool);
    expect(findExecutable("reprompty-tool", [extra])).toBe(extraTool);
  });

  it("tries the names in order", () => {
    const bin = path.join(root, "bin");
    const second = command(bin, "second-tool");
    const first = command(bin, "first-tool");
    expect(findExecutable(["missing-tool", "second-tool", "first-tool"], [bin])).toBe(second);
    expect(findExecutable(["first-tool", "second-tool"], [bin])).toBe(first);
  });

  it("returns null when nothing matches", () => {
    expect(findExecutable("reprompty-missing-tool", [path.join(root, "nowhere")])).toBeNull();
    expect(findExecutable([])).toBeNull();
  });

  it.skipIf(isWindows)("skips files without the executable bit and folders", () => {
    const bin = path.join(root, "bin");
    touch(path.join(bin, "plain-file"), 0o644);
    fs.mkdirSync(path.join(bin, "a-folder"));
    expect(findExecutable(["plain-file", "a-folder"], [bin])).toBeNull();
  });
});

describe("findKdotool", () => {
  it("uses REPROMPTY_KDOTOOL when that file exists", () => {
    const custom = touch(path.join(root, "custom", "my-kdotool"));
    touch(path.join(os.homedir(), ".local", "bin", "kdotool"));
    process.env.REPROMPTY_KDOTOOL = custom;
    expect(findKdotool()).toBe(custom);
  });

  it("ignores REPROMPTY_KDOTOOL when the file is missing", () => {
    process.env.REPROMPTY_KDOTOOL = path.join(root, "missing", "kdotool");
    const local = touch(path.join(os.homedir(), ".local", "bin", "kdotool"));
    expect(findKdotool()).toBe(local);
  });

  it("checks PATH, then ~/.cargo/bin, then ~/.local/bin", () => {
    expect(findKdotool()).toBeNull();

    const local = touch(path.join(os.homedir(), ".local", "bin", "kdotool"));
    expect(findKdotool()).toBe(local);

    const cargo = touch(path.join(os.homedir(), ".cargo", "bin", "kdotool"));
    expect(findKdotool()).toBe(cargo);

    const onPath = path.join(root, "on-path");
    const fromPath = command(onPath, "kdotool");
    process.env.PATH = onPath;
    expect(findKdotool()).toBe(fromPath);
  });
});
