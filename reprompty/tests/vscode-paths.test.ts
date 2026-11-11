import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getCdpPort,
  readArgvPort,
  readDevToolsActivePort,
  vscodeVariants,
  type VsCodeVariantId,
} from "../src/core/vscode-paths.ts";

const ENV_KEYS = ["HOME", "USERPROFILE", "APPDATA", "XDG_CONFIG_HOME", "VSCODE_PORTABLE"];
let savedEnv: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "reprompty-vscode-paths-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = path.join(home, "AppData", "Roaming");
  process.env.XDG_CONFIG_HOME = path.join(home, "config");
  delete process.env.VSCODE_PORTABLE;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function variant(id: VsCodeVariantId) {
  const found = vscodeVariants().find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No ${id} variant`);
  return found;
}

function writeActivePort(id: VsCodeVariantId, port: number, modified: Date): void {
  const file = path.join(variant(id).userDataDir, "DevToolsActivePort");
  writeFile(file, `${port}\n/devtools/browser/0b1c2d3e\n`);
  fs.utimesSync(file, modified, modified);
}

describe("vscodeVariants", () => {
  it("reads argv.json from the data folders in the home folder", () => {
    expect(variant("code").argvPath).toBe(path.join(home, ".vscode", "argv.json"));
    expect(variant("insiders").argvPath).toBe(path.join(home, ".vscode-insiders", "argv.json"));
    expect(variant("vscodium").argvPath).toBe(path.join(home, ".vscode-oss", "argv.json"));
  });

  it("uses the platform's user data folders", () => {
    const base = process.platform === "win32" ? process.env.APPDATA! : process.env.XDG_CONFIG_HOME!;
    expect(variant("code").userDataDir).toBe(path.join(base, "Code"));
    expect(variant("insiders").userDataDir).toBe(path.join(base, "Code - Insiders"));
    expect(variant("vscodium").userDataDir).toBe(path.join(base, "VSCodium"));
  });

  it.skipIf(process.platform === "win32")("includes Code - OSS and the Flatpak on Linux", () => {
    expect(variant("oss").userDataDir).toBe(path.join(home, "config", "Code - OSS"));
    expect(variant("oss").argvPath).toBe(path.join(home, ".vscode-oss", "argv.json"));
    expect(vscodeVariants().map((candidate) => candidate.userDataDir)).toContain(
      path.join(home, ".var", "app", "com.visualstudio.code", "config", "Code")
    );
  });

  it.skipIf(process.platform === "win32")("falls back to ~/.config without XDG_CONFIG_HOME", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(variant("code").userDataDir).toBe(path.join(home, ".config", "Code"));
  });

  it("reads argv.json from VSCODE_PORTABLE when it is set", () => {
    const portable = path.join(home, "portable-data");
    process.env.VSCODE_PORTABLE = portable;
    for (const candidate of vscodeVariants()) {
      expect(candidate.argvPath).toBe(path.join(portable, "argv.json"));
    }
  });
});

describe("readArgvPort", () => {
  it("parses comments and trailing commas", () => {
    const argvPath = path.join(home, ".vscode", "argv.json");
    writeFile(
      argvPath,
      [
        "// This file allows you to pass permanent command line arguments to VS Code.",
        "{",
        "  /* lets Reprompty prompt in the background */",
        '  "enable-crash-reporter": false, // no reports',
        '  "remote-debugging-port": "9222",',
        "}",
        "",
      ].join("\n")
    );
    expect(readArgvPort(argvPath)).toBe("9222");
  });

  it("returns a numeric value as a string", () => {
    const argvPath = path.join(home, ".vscode", "argv.json");
    writeFile(argvPath, '{ "remote-debugging-port": 9222 }');
    expect(readArgvPort(argvPath)).toBe("9222");
  });

  it("returns null when the port is missing or the file is unusable", () => {
    const argvPath = path.join(home, ".vscode", "argv.json");
    expect(readArgvPort(argvPath)).toBeNull();
    writeFile(argvPath, '{ "enable-crash-reporter": true }');
    expect(readArgvPort(argvPath)).toBeNull();
    writeFile(argvPath, '{ "remote-debugging-port": true }');
    expect(readArgvPort(argvPath)).toBeNull();
    writeFile(argvPath, '{ "remote-debugging-port": "9222" "oops" }');
    expect(readArgvPort(argvPath)).toBeNull();
  });
});

describe("readDevToolsActivePort", () => {
  it("reads the port on the first line", () => {
    const dir = path.join(home, "user-data");
    writeFile(path.join(dir, "DevToolsActivePort"), "9333\r\n/devtools/browser/abc\r\n");
    expect(readDevToolsActivePort(dir)).toBe(9333);
  });

  it("returns null for a missing or broken file", () => {
    const dir = path.join(home, "user-data");
    expect(readDevToolsActivePort(dir)).toBeNull();
    writeFile(path.join(dir, "DevToolsActivePort"), "not a port\n");
    expect(readDevToolsActivePort(dir)).toBeNull();
  });
});

describe("getCdpPort", () => {
  it("prefers the newest DevToolsActivePort", () => {
    writeActivePort("code", 9222, new Date("2026-01-01T10:00:00Z"));
    writeActivePort("vscodium", 9333, new Date("2026-01-02T10:00:00Z"));
    expect(getCdpPort()).toBe(9333);

    writeActivePort("code", 9222, new Date("2026-01-03T10:00:00Z"));
    expect(getCdpPort()).toBe(9222);
  });

  it("uses a running editor's port over argv.json", () => {
    writeFile(variant("code").argvPath, '{ "remote-debugging-port": "9229" }');
    writeActivePort("insiders", 9444, new Date("2026-01-01T10:00:00Z"));
    expect(getCdpPort()).toBe(9444);
  });

  it("falls back to the port in argv.json", () => {
    writeFile(variant("vscodium").argvPath, '{ "remote-debugging-port": "9229", }');
    expect(getCdpPort()).toBe(9229);
  });

  it("returns null when no port is set anywhere", () => {
    writeFile(variant("code").argvPath, "{}");
    expect(getCdpPort()).toBeNull();
  });
});
