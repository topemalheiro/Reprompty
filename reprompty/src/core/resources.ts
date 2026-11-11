import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The package root: reprompty/ from source, since this file is in src/core and
 * every bundle is in dist/<name>/; resources/app in an installed app.
 */
export function appRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

export function appResource(...parts: string[]): string {
  return path.join(appRoot(), ...parts);
}

let cachedVersion: string | null = null;

export function appVersion(): string {
  if (cachedVersion === null) {
    try {
      const raw = fs.readFileSync(appResource("package.json"), "utf-8");
      const version = (JSON.parse(raw) as { version?: unknown }).version;
      cachedVersion = typeof version === "string" && version ? version : "0.0.0";
    } catch {
      cachedVersion = "0.0.0";
    }
  }
  return cachedVersion;
}
