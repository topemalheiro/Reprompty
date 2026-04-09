import * as fs from "node:fs";
import * as path from "node:path";

export interface SpawnTarget {
  id: string;
  label: string;
  folderPath: string;
  windowName?: string;
  addedAt: string;
}

interface SpawnTargetsConfig {
  targets: SpawnTarget[];
}

function getConfigDir(): string {
  const homeDir = process.env.USERPROFILE || process.env.HOME || ".";
  return path.join(homeDir, ".reprompty");
}

export function normalizeSpawnTargetId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export class SpawnTargetManager {
  private readonly configDir: string;
  private readonly configPath: string;
  private readonly targets = new Map<string, SpawnTarget>();

  constructor() {
    this.configDir = getConfigDir();
    this.configPath = path.join(this.configDir, "spawn-targets.json");
    this.loadConfig();
  }

  private loadConfig(): void {
    try {
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
      }

      if (!fs.existsSync(this.configPath)) {
        this.saveConfig();
        return;
      }

      const raw = fs.readFileSync(this.configPath, "utf-8");
      const config = JSON.parse(raw) as Partial<SpawnTargetsConfig>;
      for (const target of config.targets ?? []) {
        const normalized = this.normalizeTarget(target);
        this.targets.set(normalized.id, normalized);
      }
    } catch (err) {
      console.error("[SpawnTargetManager] Failed to load config:", err);
    }
  }

  private saveConfig(): void {
    try {
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
      }
      const config: SpawnTargetsConfig = {
        targets: this.listTargets(),
      };
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf-8");
    } catch (err) {
      console.error("[SpawnTargetManager] Failed to save config:", err);
    }
  }

  private normalizeTarget(
    target: Pick<SpawnTarget, "label" | "folderPath"> & Partial<SpawnTarget>
  ): SpawnTarget {
    const label = target.label.trim();
    const idSource = target.id?.trim() || label;
    const id = normalizeSpawnTargetId(idSource);

    if (!id) {
      throw new Error("Spawn target alias is required");
    }
    if (!label) {
      throw new Error("Spawn target label is required");
    }
    if (!target.folderPath?.trim()) {
      throw new Error("Spawn target folder path is required");
    }

    return {
      id,
      label,
      folderPath: target.folderPath.trim(),
      windowName: target.windowName?.trim() || undefined,
      addedAt: target.addedAt || new Date().toISOString(),
    };
  }

  listTargets(): SpawnTarget[] {
    return Array.from(this.targets.values()).sort((a, b) =>
      a.label.localeCompare(b.label)
    );
  }

  getTarget(id: string): SpawnTarget | null {
    const normalizedId = normalizeSpawnTargetId(id);
    return this.targets.get(normalizedId) ?? null;
  }

  addTarget(target: Pick<SpawnTarget, "label" | "folderPath"> & Partial<SpawnTarget>): SpawnTarget {
    const normalized = this.normalizeTarget(target);
    if (this.targets.has(normalized.id)) {
      throw new Error(`Spawn target "${normalized.id}" already exists`);
    }
    this.targets.set(normalized.id, normalized);
    this.saveConfig();
    return normalized;
  }

  updateTarget(
    id: string,
    updates: Partial<SpawnTarget>
  ): SpawnTarget | null {
    const existing = this.getTarget(id);
    if (!existing) {
      return null;
    }

    const updated = this.normalizeTarget({
      ...existing,
      ...updates,
      id: updates.id ?? existing.id,
    });

    if (updated.id !== existing.id && this.targets.has(updated.id)) {
      throw new Error(`Spawn target "${updated.id}" already exists`);
    }

    this.targets.delete(existing.id);
    this.targets.set(updated.id, updated);
    this.saveConfig();
    return updated;
  }

  removeTarget(id: string): boolean {
    const normalizedId = normalizeSpawnTargetId(id);
    const removed = this.targets.delete(normalizedId);
    if (removed) {
      this.saveConfig();
    }
    return removed;
  }
}

export const spawnTargetManager = new SpawnTargetManager();
