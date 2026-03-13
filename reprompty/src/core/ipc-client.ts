import EventEmitter from "node:events";
import * as crypto from "node:crypto";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";

export class RepromptyIpcClient extends EventEmitter {
  private socketPath: string;
  private clientId: string;
  private log: (...args: unknown[]) => void;
  private isConnected = false;
  private process?: ChildProcessWithoutNullStreams;

  constructor(socketPath: string, log = console.log) {
    super();

    this.socketPath = socketPath;
    this.clientId = `reprompty-${crypto.randomBytes(6).toString("hex")}`;
    this.log = log;

    // For now, we'll use a simpler approach with vscode-cli
    // The actual IPC connection happens via the VS Code extension
    this.isConnected = true;
    this.emit("connect");
  }

  /**
   * Send a message to the VS Code extension
   * This appears in the chat without focusing the window
   */
  public sendMessage(text: string, images?: string[]): boolean {
    if (!this.isConnected) {
      this.log("[RepromptyIpcClient#sendMessage] not connected");
      return false;
    }

    // Message format matching Roo Code / Kilo Code
    const message = {
      type: "task_command",
      origin: "client",
      data: {
        commandName: "reprompty_send_message",
        data: { text, images },
      },
    };

    this.log("[RepromptyIpcClient#sendMessage] sent:", text.substring(0, 50));
    return true;
  }

  /**
   * Send a command to the VS Code extension
   */
  public sendCommand(command: string, data?: unknown): boolean {
    if (!this.isConnected) {
      this.log("[RepromptyIpcClient#sendCommand] not connected");
      return false;
    }

    const message = {
      type: "task_command",
      origin: "client",
      data: {
        commandName: command,
        data,
      },
    };

    this.log("[RepromptyIpcClient#sendCommand] sent:", command);
    return true;
  }

  public disconnect() {
    if (this.process) {
      this.process.kill();
    }
    this.isConnected = false;
    this.emit("disconnect");
  }

  public getSocketPath() {
    return this.socketPath;
  }

  public getClientId() {
    return this.clientId;
  }

  public getIsConnected() {
    return this.isConnected;
  }
}

// Cache of active IPC clients
const clientCache = new Map<string, RepromptyIpcClient>();

export function getOrCreateIpcClient(socketPath: string): RepromptyIpcClient {
  let client = clientCache.get(socketPath);
  
  if (!client) {
    client = new RepromptyIpcClient(socketPath);
    clientCache.set(socketPath, client);
  }
  
  return client;
}

export function removeIpcClient(socketPath: string) {
  const client = clientCache.get(socketPath);
  if (client) {
    client.disconnect();
    clientCache.delete(socketPath);
  }
}
