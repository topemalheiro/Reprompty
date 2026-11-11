// First import of server.ts: stdout carries JSON-RPC only, so nothing logged
// while the other modules load may reach it.
import { Console } from "node:console";
import * as os from "node:os";
import * as path from "node:path";

const stderrConsole = new Console({ stdout: process.stderr, stderr: process.stderr });
for (const method of ["log", "info", "debug", "dir", "dirxml", "table"] as const) {
  console[method] = stderrConsole[method];
}

// Some clients start MCP servers with a trimmed environment.
if (process.platform === "win32") {
  const home = os.homedir();
  process.env.USERPROFILE ||= home;
  process.env.APPDATA ||= path.join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA ||= path.join(home, "AppData", "Local");
}

// Inside an AppImage, keep its bundled libraries and binaries away from the
// tools the server runs (kdotool, qdbus6, python3).
const appDir = process.env.APPDIR?.replace(/\/+$/, "");
if (appDir) {
  for (const key of ["PATH", "LD_LIBRARY_PATH"]) {
    const value = process.env[key];
    if (value === undefined) continue;
    const kept = value
      .split(path.delimiter)
      .filter((entry) => entry && entry !== appDir && !entry.startsWith(appDir + "/"));
    if (kept.length > 0) {
      process.env[key] = kept.join(path.delimiter);
    } else {
      delete process.env[key];
    }
  }
}
