import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appResource } from "../core/resources.js";
import { displayPath, isDirectory, isFile, type ActionResult } from "./context.js";
import { backupFile, copyFileAtomic, isSymlink, sha256 } from "./fs-safe.js";
import {
  CLIENT_LABELS,
  claudeHome,
  codexHome,
  findExtensions,
  isClientInstalled,
  kimiCliHome,
  kimiCodeHome,
} from "./clients.js";

export type SkillAgent = "claude" | "codex" | "kimi-code" | "kimi-cli" | "kilo";
/** unknown: the file exists but this install has no skill file to compare it with */
export type SkillState = "missing" | "current" | "outdated" | "linked" | "unknown";

export interface SkillTarget {
  agent: SkillAgent;
  label: string;
  file: string;
  /** The agent is installed, so setup installs the skill for it */
  detected: boolean;
  state: SkillState;
}

export const SKILL_AGENTS: readonly SkillAgent[] = ["claude", "codex", "kimi-code", "kimi-cli", "kilo"];

const SKILL_PATH = ["reprompty", "SKILL.md"];

export function skillSource(): string {
  return appResource("skills", ...SKILL_PATH);
}

export function missingSkillMessage(source: string): string {
  return `The Reprompty skill file is missing from this install (${displayPath(source)}). Update or reinstall Reprompty.`;
}

function realPath(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function kiloSkillsDir(): string {
  const home = os.homedir();
  const kilocode = path.join(home, ".kilocode");
  const roo = path.join(home, ".roo");
  // Kilo Code reads ~/.roo only when ~/.kilocode doesn't exist.
  return !isDirectory(kilocode) && isDirectory(roo) ? path.join(roo, "skills") : path.join(kilocode, "skills");
}

function targetFiles(): Array<{ agent: SkillAgent; file: string; detected: boolean }> {
  const kimiCliSkills = path.join(kimiCliHome(), "skills");
  return [
    { agent: "claude", file: path.join(claudeHome(), "skills", ...SKILL_PATH), detected: isClientInstalled("claude") },
    { agent: "codex", file: path.join(codexHome(), "skills", ...SKILL_PATH), detected: isClientInstalled("codex") },
    {
      agent: "kimi-code",
      file: path.join(kimiCodeHome(), "skills", ...SKILL_PATH),
      detected: isClientInstalled("kimi-code"),
    },
    // Creating ~/.kimi/skills would hide ~/.claude/skills from Kimi CLI, so only use it when it exists.
    { agent: "kimi-cli", file: path.join(kimiCliSkills, ...SKILL_PATH), detected: isDirectory(kimiCliSkills) },
    {
      agent: "kilo",
      file: path.join(kiloSkillsDir(), ...SKILL_PATH),
      detected:
        isClientInstalled("kilo") ||
        findExtensions("kilocode.kilo-code-").length > 0 ||
        isDirectory(path.join(os.homedir(), ".kilocode")),
    },
  ];
}

export function skillState(file: string, source: string): SkillState {
  const sourceReal = realPath(source);
  const real = realPath(file);
  if (real && sourceReal && samePath(real, sourceReal)) return "linked";
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch {
    // A link that leads nowhere still has to be replaced.
    return isSymlink(file) ? "outdated" : "missing";
  }
  if (!sourceReal) return "unknown";
  return sha256(data) === sha256(fs.readFileSync(source)) ? "current" : "outdated";
}

export function skillTargets(source = skillSource()): SkillTarget[] {
  return targetFiles().map((target) => ({
    ...target,
    label: CLIENT_LABELS[target.agent],
    state: skillState(target.file, source),
  }));
}

/** Copy the skill byte for byte; a link that resolves to the source is left alone. */
export function installSkill(file: string, source = skillSource(), o: { dryRun?: boolean } = {}): ActionResult {
  const where = displayPath(file);
  if (!isFile(source)) return { ok: false, changed: false, message: missingSkillMessage(source) };
  const state = skillState(file, source);
  if (state === "linked") return { ok: true, changed: false, message: `${where} links to this install's skill` };
  if (state === "current") return { ok: true, changed: false, message: `${where} is up to date` };

  const dir = path.dirname(file);
  if (isSymlink(dir)) {
    return {
      ok: false,
      changed: false,
      message: `${displayPath(dir)} is a link to ${displayPath(realPath(dir) ?? fs.readlinkSync(dir))}; remove the link so Reprompty can install its own copy`,
    };
  }
  const link = isSymlink(file);
  let how: string;
  if (state === "missing") {
    how = `${o.dryRun ? "Would create" : "Created"} ${where}`;
  } else if (link) {
    const target = fs.readlinkSync(file);
    how = `${o.dryRun ? "Would replace" : "Replaced"} ${where} (a link to ${displayPath(path.resolve(path.dirname(file), target))}) with a copy`;
  } else {
    how = `${o.dryRun ? "Would update" : "Updated"} ${where}`;
  }
  how += ` from ${displayPath(source)}`;
  if (o.dryRun) return { ok: true, changed: true, message: how, files: [file] };

  const backups: string[] = [];
  try {
    // Never write through the link: it may point into a repository.
    if (link) fs.unlinkSync(file);
    else if (state !== "missing") {
      const backup = backupFile(file);
      if (backup) backups.push(backup);
    }
    copyFileAtomic(source, file);
  } catch (err) {
    return { ok: false, changed: false, message: `Couldn't write ${where}: ${err instanceof Error ? err.message : err}` };
  }
  return { ok: true, changed: true, message: how, files: [file], backups };
}

export function removeSkill(file: string, o: { dryRun?: boolean } = {}): ActionResult {
  const dir = path.dirname(file);
  // A linked folder goes as a whole; what it links to stays.
  const target = isSymlink(dir) ? dir : file;
  const where = displayPath(target);
  const link = isSymlink(target);
  if (!link && !fs.existsSync(target)) return { ok: true, changed: false, message: `${where} isn't there` };
  if (o.dryRun) return { ok: true, changed: true, message: `Would remove ${where}`, files: [target] };
  const backups: string[] = [];
  try {
    if (!link) {
      const backup = backupFile(target);
      if (backup) backups.push(backup);
    }
    fs.rmSync(target, { force: true });
    if (target === file && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch (err) {
    return { ok: false, changed: false, message: `Couldn't remove ${where}: ${err instanceof Error ? err.message : err}` };
  }
  return { ok: true, changed: true, message: `Removed ${where}`, files: [target], backups };
}
