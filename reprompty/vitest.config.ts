import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, which would start Electron. Tests get a throwaway
// home so importing the managers never writes the real ~/.reprompty.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "reprompty-test-home-"));
process.on("exit", () => fs.rmSync(testHome, { recursive: true, force: true }));

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Child processes, so os.homedir() follows HOME changes made by tests.
    pool: "forks",
    env: { HOME: testHome, USERPROFILE: testHome },
  },
});
