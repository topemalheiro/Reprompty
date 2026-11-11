// `npm start`: builds once if dist/ is missing, then starts Electron with a clean environment.
// REPROMPTY_LAUNCH_DRY_RUN=1 prints the command as JSON instead of running it.
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function buildCommand() {
  const npmCli = process.env.npm_execpath;
  if (npmCli && /\.[cm]?js$/i.test(npmCli)) return [process.execPath, npmCli, "run", "build:all"];
  if (npmCli) return [npmCli, "run", "build:all"];
  return [process.platform === "win32" ? "npm.cmd" : "npm", "run", "build:all"];
}

let electronPath;
try {
  electronPath = require("electron");
} catch (err) {
  console.error(
    err && err.code === "MODULE_NOT_FOUND"
      ? "Dependencies are not installed. Run: npm ci"
      : "Electron is not downloaded. Run: node node_modules/electron/install.js"
  );
  process.exit(1);
}

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^ELECTRON_(RUN_AS_NODE|NO_ATTACH_CONSOLE)$/i.test(key)) delete env[key];
}

const args = [root];
if (process.platform === "linux") {
  try {
    // Ubuntu 23.10+ blocks the user namespaces Chromium's sandbox needs.
    const restricted = fs.readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8");
    if (restricted.trim() === "1") args.push("--no-sandbox");
  } catch {}
}
args.push(...process.argv.slice(2));

const build = fs.existsSync(path.join(root, "dist", "main", "index.js")) ? null : buildCommand();

if (process.env.REPROMPTY_LAUNCH_DRY_RUN === "1") {
  console.log(JSON.stringify({ build, command: electronPath, args, env }, null, 2));
  process.exit(0);
}

if (build) {
  const [cmd, ...cmdArgs] = build;
  const result = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", shell: /\.cmd$/i.test(cmd) });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const child = spawn(electronPath, args, { stdio: "inherit", env });
child.on("error", (err) => {
  console.error(`Could not start Electron: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
