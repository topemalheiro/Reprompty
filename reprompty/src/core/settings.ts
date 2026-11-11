import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RepromptySettings {
  cdpPort?: number;
  graphitiComposeDir?: string;
}

export function settingsPath(): string {
  return path.join(os.homedir(), ".reprompty", "settings.json");
}

// Never cached: the app and the MCP server both read and write this file.
// Unknown keys are kept so writeSettings doesn't drop them.
export function readSettings(): RepromptySettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const settings = { ...parsed } as Record<string, unknown>;
  const port = settings.cdpPort;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    delete settings.cdpPort;
  }
  if (typeof settings.graphitiComposeDir !== "string" || !settings.graphitiComposeDir) {
    delete settings.graphitiComposeDir;
  }
  return settings as RepromptySettings;
}

/** Merge the patch into settings.json (a key set to undefined is removed). */
export function writeSettings(patch: Partial<RepromptySettings>): RepromptySettings {
  const file = settingsPath();
  const merged: RepromptySettings = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  return merged;
}
