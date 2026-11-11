// npm 12 skips dependency install scripts that package.json doesn't allow, which leaves
// Electron without its binary. Download it here when that happened.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const electronDir = path.join(__dirname, "..", "node_modules", "electron");
const pathFile = path.join(electronDir, "path.txt");

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD || !fs.existsSync(electronDir) || fs.existsSync(pathFile)) {
  process.exit(0);
}

console.log("Electron's binary is missing. Downloading it...");
const result = spawnSync(process.execPath, [path.join(electronDir, "install.js")], { stdio: "inherit" });

if (result.status === 0 && fs.existsSync(pathFile)) {
  console.log("Electron downloaded.");
} else {
  console.error("Electron could not be downloaded. Try again with: node node_modules/electron/install.js");
  process.exit(result.status || 1);
}
