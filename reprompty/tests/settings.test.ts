import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readSettings, settingsPath, writeSettings } from "../src/core/settings.ts";

const ENV_KEYS = ["HOME", "USERPROFILE"];
let savedEnv: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "reprompty-settings-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function writeRaw(content: string): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), content);
}

describe("settings", () => {
  it("lives in ~/.reprompty/settings.json", () => {
    expect(settingsPath()).toBe(path.join(home, ".reprompty", "settings.json"));
  });

  it("is empty when the file is missing", () => {
    expect(readSettings()).toEqual({});
  });

  it("reads back what was written", () => {
    expect(writeSettings({ cdpPort: 9333 })).toEqual({ cdpPort: 9333 });
    expect(readSettings()).toEqual({ cdpPort: 9333 });
    expect(fs.readdirSync(path.dirname(settingsPath()))).toEqual(["settings.json"]);
  });

  it("merges each write into the saved settings", () => {
    writeSettings({ cdpPort: 9222 });
    const merged = writeSettings({ graphitiComposeDir: path.join(home, "graphiti") });
    expect(merged).toEqual({ cdpPort: 9222, graphitiComposeDir: path.join(home, "graphiti") });
    expect(readSettings()).toEqual(merged);

    writeSettings({ cdpPort: undefined });
    expect(readSettings()).toEqual({ graphitiComposeDir: path.join(home, "graphiti") });
  });

  it("keeps keys it doesn't know", () => {
    writeRaw('{ "cdpPort": 9222, "laterSetting": true }');
    writeSettings({ cdpPort: 9333 });
    const saved = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    expect(saved).toEqual({ cdpPort: 9333, laterSetting: true });
  });

  it("treats invalid JSON as no settings", () => {
    writeRaw("{ not json");
    expect(readSettings()).toEqual({});
    writeRaw("[1, 2]");
    expect(readSettings()).toEqual({});
    expect(writeSettings({ cdpPort: 9222 })).toEqual({ cdpPort: 9222 });
  });

  it("drops values of the wrong type", () => {
    writeRaw('{ "cdpPort": "9222", "graphitiComposeDir": 5 }');
    expect(readSettings()).toEqual({});
  });
});
