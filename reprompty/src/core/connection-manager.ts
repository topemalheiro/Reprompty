import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";

export type ConnectionType = "vscode-window" | "vscode-cli" | "http-api" | "websocket";
export type ConnectionStatus = "active" | "inactive" | "error";

export interface VSCodeWindowConfig {
  socketPath?: string;
  windowTitle?: string;
  windowHandle?: number;
  method: "foreground" | "background";
  extension?: "kilo-code" | "claude-code" | "unknown";
}

export interface VSCodeCLIConfig {
  folderPath: string;
  args?: string[];
}

export interface HTTPAPIConfig {
  url: string;
  headers?: Record<string, string>;
  auth?: {
    type: "bearer" | "basic";
    token: string;
  };
}

export interface WebSocketConfig {
  url: string;
  protocols?: string[];
}

export type ConnectionConfig = VSCodeWindowConfig | VSCodeCLIConfig | HTTPAPIConfig | WebSocketConfig;

export interface Connection {
  id: string;
  type: ConnectionType;
  name: string;
  config: ConnectionConfig;
  status: ConnectionStatus;
  createdAt: string;
}

// ============================================================================
// Connection Manager with file persistence
// ============================================================================

export class ConnectionManager extends EventEmitter {
  private connections: Map<string, Connection> = new Map();
  private configPath: string;

  constructor() {
    super();

    const homeDir = process.env.USERPROFILE || process.env.HOME || ".";
    const configDir = nodePath.join(homeDir, ".reprompty");
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    this.configPath = nodePath.join(configDir, "connections.json");
    this.loadConfig();
  }

  private loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, "utf-8");
        const entries: Connection[] = JSON.parse(raw);
        for (const entry of entries) {
          // Reset status on load - connections need to be re-established
          this.connections.set(entry.id, { ...entry, status: "inactive" });
        }
      }
    } catch (err) {
      console.error("[ConnectionManager] Failed to load config:", err);
    }
  }

  private saveConfig() {
    try {
      const entries = Array.from(this.connections.values());
      fs.writeFileSync(this.configPath, JSON.stringify(entries, null, 2), "utf-8");
    } catch (err) {
      console.error("[ConnectionManager] Failed to save config:", err);
    }
  }

  addConnection(
    type: ConnectionType,
    name: string,
    config: ConnectionConfig
  ): Connection {
    const id = crypto.randomUUID();
    const connection: Connection = {
      id,
      type,
      name,
      config,
      status: "inactive",
      createdAt: new Date().toISOString(),
    };

    this.connections.set(id, connection);
    this.saveConfig();
    this.emit("connectionAdded", connection);

    return connection;
  }

  removeConnection(connectionId: string): boolean {
    const exists = this.connections.has(connectionId);
    if (exists) {
      this.connections.delete(connectionId);
      this.saveConfig();
      this.emit("connectionRemoved", connectionId);
    }
    return exists;
  }

  getConnection(connectionId: string): Connection | undefined {
    return this.connections.get(connectionId);
  }

  listConnections(): Connection[] {
    return Array.from(this.connections.values());
  }

  updateConnectionStatus(connectionId: string, status: ConnectionStatus): boolean {
    const connection = this.connections.get(connectionId);
    if (connection) {
      const updated = { ...connection, status };
      this.connections.set(connectionId, updated);
      this.emit("connectionStatusChanged", connectionId, status);
      return true;
    }
    return false;
  }

  updateConnection(connectionId: string, updates: Partial<Omit<Connection, "id">>): Connection | null {
    const connection = this.connections.get(connectionId);
    if (!connection) return null;

    const updated = { ...connection, ...updates };
    this.connections.set(connectionId, updated);
    this.saveConfig();
    return updated;
  }

  getConnectionByName(name: string): Connection | undefined {
    return Array.from(this.connections.values()).find(
      (c) => c.name.toLowerCase() === name.toLowerCase()
    );
  }

  findBySocketPath(socketPath: string): Connection | undefined {
    return Array.from(this.connections.values()).find(
      (c) =>
        c.type === "vscode-window" &&
        (c.config as VSCodeWindowConfig).socketPath === socketPath
    );
  }
}

// Singleton instance
export const connectionManager = new ConnectionManager();
