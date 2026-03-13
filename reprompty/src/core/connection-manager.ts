import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";

export type ConnectionType = "vscode-window" | "vscode-cli" | "http-api" | "websocket";
export type ConnectionStatus = "active" | "inactive" | "error";

export interface VSCodeWindowConfig {
  socketPath?: string;
  windowTitle?: string;
  method: "foreground" | "background";
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

export class ConnectionManager extends EventEmitter {
  private connections: Map<string, Connection> = new Map();

  constructor() {
    super();
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
    this.emit("connectionAdded", connection);

    return connection;
  }

  removeConnection(connectionId: string): boolean {
    const exists = this.connections.has(connectionId);
    if (exists) {
      this.connections.delete(connectionId);
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
      connection.status = status;
      this.emit("connectionStatusChanged", connectionId, status);
      return true;
    }
    return false;
  }

  getConnectionByName(name: string): Connection | undefined {
    return Array.from(this.connections.values()).find(
      (c) => c.name === name
    );
  }
}

// Singleton instance
export const connectionManager = new ConnectionManager();
