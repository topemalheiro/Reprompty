import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installSkill, removeSkill, skillSource, skillState, skillTargets } from "../src/setup/skills.ts";
import { backupFiles, makeTempHome, writeFile, type TempHome } from "./fixtures/setup/temp-home.ts";

const isWindows = process.platform === "win32";
const SKILL = "---\nname: reprompty\ndescription: Run AI agents in VS Code windows\n---\n# Reprompty\n";

let t: TempHome;
let source: string;

beforeEach(() => {
  t = makeTempHome();
  source = writeFile(path.join(t.root, "app", "skills", "reprompty", "SKILL.md"), SKILL);
});

afterEach(() => {
  t.restore();
});

function target(agent: string) {
  const found = skillTargets(source).find((candidate) => candidate.agent === agent);
  if (!found) throw new Error(`No ${agent} target`);
  return found;
}

describe("skillTargets", () => {
  it("lists each agent's skill file", () => {
    expect(skillTargets(source).map((entry) => [entry.agent, entry.file])).toEqual([
      ["claude", t.at(".claude", "skills", "reprompty", "SKILL.md")],
      ["codex", t.at(".codex", "skills", "reprompty", "SKILL.md")],
      ["kimi-code", t.at(".kimi-code", "skills", "reprompty", "SKILL.md")],
      ["kimi-cli", t.at(".kimi", "skills", "reprompty", "SKILL.md")],
      ["kilo", t.at(".kilocode", "skills", "reprompty", "SKILL.md")],
    ]);
  });

  it("detects agents by their folders", () => {
    fs.mkdirSync(t.at(".claude"));
    fs.mkdirSync(t.at(".kimi"));
    expect(target("claude").detected).toBe(true);
    expect(target("codex").detected).toBe(false);
    // Kimi CLI falls back to ~/.claude/skills until ~/.kimi/skills exists.
    expect(target("kimi-cli").detected).toBe(false);
    fs.mkdirSync(t.at(".kimi", "skills"));
    expect(target("kimi-cli").detected).toBe(true);
  });

  it("uses ~/.roo for Kilo Code only when ~/.kilocode doesn't exist", () => {
    fs.mkdirSync(t.at(".roo"));
    expect(target("kilo").file).toBe(t.at(".roo", "skills", "reprompty", "SKILL.md"));
    fs.mkdirSync(t.at(".kilocode"));
    expect(target("kilo").file).toBe(t.at(".kilocode", "skills", "reprompty", "SKILL.md"));
  });

  it("uses CODEX_HOME and KIMI_CODE_HOME", () => {
    process.env.CODEX_HOME = t.at("codex");
    process.env.KIMI_CODE_HOME = t.at("kimi-code");
    expect(target("codex").file).toBe(t.at("codex", "skills", "reprompty", "SKILL.md"));
    expect(target("kimi-code").file).toBe(t.at("kimi-code", "skills", "reprompty", "SKILL.md"));
  });

  it("comes from skills/reprompty/SKILL.md in the package", () => {
    expect(skillSource().endsWith(path.join("skills", "reprompty", "SKILL.md"))).toBe(true);
  });
});

describe("installSkill", () => {
  it("copies the skill byte for byte, then has nothing to do", () => {
    const file = target("claude").file;
    expect(skillState(file, source)).toBe("missing");
    expect(installSkill(file, source)).toMatchObject({ ok: true, changed: true, files: [file] });
    expect(fs.readFileSync(file, "utf-8")).toBe(SKILL);
    expect(skillState(file, source)).toBe("current");
    expect(installSkill(file, source)).toMatchObject({ ok: true, changed: false });
  });

  it("updates an outdated copy and backs it up", () => {
    const file = writeFile(target("codex").file, "old skill\n");
    expect(skillState(file, source)).toBe("outdated");
    const result = installSkill(file, source);
    expect(result.changed).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe(SKILL);
    expect(fs.readFileSync(result.backups![0], "utf-8")).toBe("old skill\n");
  });

  it("writes nothing on a dry run", () => {
    const file = target("claude").file;
    const result = installSkill(file, source, { dryRun: true });
    expect(result).toMatchObject({ ok: true, changed: true, files: [file] });
    expect(result.message).toMatch(/^Would create/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("says clearly when this install has no skill file", () => {
    const missing = path.join(t.root, "app", "skills", "reprompty", "MISSING.md");
    const result = installSkill(target("claude").file, missing);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^The Reprompty skill file is missing from this install/);
    const file = writeFile(target("claude").file, "something\n");
    expect(skillState(file, missing)).toBe("unknown");
  });

  describe.skipIf(isWindows)("links", () => {
    it("leaves a link to this install's skill alone", () => {
      const file = target("claude").file;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.symlinkSync(source, file);
      expect(skillState(file, source)).toBe("linked");
      expect(installSkill(file, source)).toMatchObject({ ok: true, changed: false });
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    });

    it("replaces a link that leads nowhere with a copy", () => {
      const file = target("claude").file;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.symlinkSync(path.join(t.root, "old-repo", "skills-reprompty", "SKILL.md"), file);
      expect(skillState(file, source)).toBe("outdated");
      const result = installSkill(file, source);
      expect(result.message).toMatch(/^Replaced .* \(a link to .*old-repo.*\) with a copy/);
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(file, "utf-8")).toBe(SKILL);
    });

    it("never writes through a link into the file it points to", () => {
      const other = writeFile(path.join(t.root, "repo", "SKILL.md"), "the repo's own copy\n");
      const file = target("codex").file;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.symlinkSync(other, file);
      installSkill(file, source);
      expect(fs.readFileSync(other, "utf-8")).toBe("the repo's own copy\n");
      expect(fs.readFileSync(file, "utf-8")).toBe(SKILL);
      expect(backupFiles(t.home)).toEqual([]);
    });

    it("leaves a linked skill folder alone", () => {
      const repoDir = path.join(t.root, "repo", "skills", "reprompty");
      writeFile(path.join(repoDir, "SKILL.md"), "older\n");
      fs.mkdirSync(t.at(".claude", "skills"), { recursive: true });
      fs.symlinkSync(repoDir, t.at(".claude", "skills", "reprompty"));
      const result = installSkill(target("claude").file, source);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/is a link to/);
      expect(fs.readFileSync(path.join(repoDir, "SKILL.md"), "utf-8")).toBe("older\n");

      expect(removeSkill(target("claude").file).changed).toBe(true);
      expect(fs.existsSync(t.at(".claude", "skills", "reprompty"))).toBe(false);
      expect(fs.readFileSync(path.join(repoDir, "SKILL.md"), "utf-8")).toBe("older\n");
    });
  });
});

describe("removeSkill", () => {
  it("removes the copy and its empty folder, with a backup", () => {
    const file = target("claude").file;
    installSkill(file, source);
    const result = removeSkill(file);
    expect(result.changed).toBe(true);
    expect(fs.existsSync(path.dirname(file))).toBe(false);
    expect(backupFiles(t.home)).toHaveLength(1);
    expect(removeSkill(file).changed).toBe(false);
  });
});
