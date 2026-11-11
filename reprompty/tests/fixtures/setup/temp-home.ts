import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = path.dirname(fileURLToPath(import.meta.url));

// Everything that can point setup at a real config folder.
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "CODEX_HOME",
  "KIMI_CODE_HOME",
  "CLAUDE_CONFIG_DIR",
  "VSCODE_PORTABLE",
  "PATH",
  "APPIMAGE",
  "APPDIR",
  "REPROMPTY_KDOTOOL",
];

export interface TempHome {
  root: string;
  home: string;
  /** The only folder on PATH */
  bin: string;
  /** Path inside the home folder */
  at(...parts: string[]): string;
  /** Copy a fixture into the home folder */
  seed(fixture: string, ...target: string[]): string;
  restore(): void;
}

export function makeTempHome(): TempHome {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reprompty-setup-")));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = path.join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  process.env.PATH = bin;

  const at = (...parts: string[]) => path.join(home, ...parts);
  return {
    root,
    home,
    bin,
    at,
    seed(fixture, ...target) {
      return writeFile(at(...target), fixtureText(fixture));
    },
    restore() {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// LF whatever the checkout did, so expected texts match on every OS.
export function fixtureText(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf-8").replace(/\r\n/g, "\n");
}

export function writeFile(file: string, content: string | Buffer, mode?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
  return file;
}

export function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name))
    .sort();
}

export function backupFiles(home: string): string[] {
  return listFiles(path.join(home, ".reprompty", "backups"));
}
