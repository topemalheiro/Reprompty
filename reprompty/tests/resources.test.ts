import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { appResource, appRoot, appVersion } from "../src/core/resources.ts";

describe("resources", () => {
  it("resolves the package root from src/core", () => {
    expect(appRoot()).toBe(path.resolve(__dirname, ".."));
    expect(appResource("src", "core", "resources.ts")).toBe(
      path.join(appRoot(), "src", "core", "resources.ts")
    );
    expect(fs.existsSync(appResource("src", "core", "resources.ts"))).toBe(true);
  });

  it("reads the version from package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(appResource("package.json"), "utf-8"));
    expect(appVersion()).toBe(pkg.version);
  });
});
