import EventEmitter from "node:events";
import * as crypto from "node:crypto";

import ipc from "node-ipc";

// ============================================================================
// Kilo Code IPC Protocol Types (inlined from @roo-code/types)
// ============================================================================

const IpcMessageType = {
  Connect: "Connect",
  Disconnect: "Disconnect",
  Ack: "Ack",
  TaskCommand: "TaskCommand",
  TaskEvent: "TaskEvent",
} as const;

const IpcOrigin = {
  Client: "client",
  Server: "server",
} as const;

const TaskCommandName = {
  StartNewTask: "StartNewTask",
  CancelTask: "CancelTask",
  CloseTask: "CloseTask",
  ResumeTask: "ResumeTask",
  SendMessage: "SendMessage",
} as const;

interface Ack {
  clientId: string;
  pid: number;
  ppid: number;
}

interface TaskCommand {
  commandName: string;
  data: unknown;
}

interface IpcMessage {
  type: string;
  origin: string;
  clientId?: string;
  relayClientId?: string;
  data: unknown;
}

// ============================================================================
// IPC Client - Connects to Kilo Code's named pipe
// ============================================================================

export class RepromptyIpcClient extends EventEmitter {
  private readonly _socketPath: string;
  private readonly _id: string;
  private readonly _log: (...args: unknown[]) => void;
  private _isConnected = false;
  private _clientId?: string;
  private _readyPromise: Promise<boolean>;
  private _readyResolve?: (value: boolean) => void;
  private _connectTimeout?: ReturnType<typeof setTimeout>;

  constructor(socketPath: string, log = console.log, timeoutMs = 5000) {
    super();

    this._socketPath = socketPath;
    this._id = `reprompty-${crypto.randomBytes(6).toString("hex")}`;
    this._log = log;

    this._readyPromise = new Promise<boolean>((resolve) => {
      this._readyResolve = resolve;
    });

    ipc.config.silent = true;

    ipc.connectTo(this._id, this._socketPath, () => {
      ipc.of[this._id]?.on("connect", () => this.onConnect());
      ipc.of[this._id]?.on("disconnect", () => this.onDisconnect());
      ipc.of[this._id]?.on("message", (data: unknown) =>
        this.onMessage(data)
      );
    });

    this._connectTimeout = setTimeout(() => {
      if (!this.isReady) {
        this.log("[client] connection timeout after", timeoutMs, "ms");
        this._readyResolve?.(false);
        this._readyResolve = undefined;
      }
    }, timeoutMs);
  }

  private onConnect() {
    if (this._isConnected) {
      return;
    }

    this.log("[client#onConnect]");
    this._isConnected = true;
    this.emit(IpcMessageType.Connect);
  }

  private onDisconnect() {
    if (!this._isConnected) {
      return;
    }

    this.log("[client#onDisconnect]");
    this._isConnected = false;
    this._clientId = undefined;
    this.emit(IpcMessageType.Disconnect);
  }

  private onMessage(data: unknown) {
    if (typeof data !== "object" || data === null) {
      this.log("[client#onMessage] invalid data ->", JSON.stringify(data));
      return;
    }

    const payload = data as IpcMessage;

    if (payload.origin === IpcOrigin.Server) {
      switch (payload.type) {
        case IpcMessageType.Ack: {
          const ackData = payload.data as Ack;
          this._clientId = ackData.clientId;
          this.log(
            "[client#onMessage] Ack received, clientId =",
            this._clientId
          );
          if (this._connectTimeout) {
            clearTimeout(this._connectTimeout);
            this._connectTimeout = undefined;
          }
          this._readyResolve?.(true);
          this._readyResolve = undefined;
          this.emit(IpcMessageType.Ack, ackData);
          break;
        }
        case IpcMessageType.TaskEvent:
          this.emit(IpcMessageType.TaskEvent, payload.data);
          break;
        default:
          this.log(
            "[client#onMessage] unhandled:",
            JSON.stringify(payload).substring(0, 200)
          );
      }
    }
  }

  private log(...args: unknown[]) {
    this._log(...args);
  }

  /**
   * Send a TaskCommand to the Kilo Code extension
   */
  public sendCommand(command: TaskCommand) {
    const message: IpcMessage = {
      type: IpcMessageType.TaskCommand,
      origin: IpcOrigin.Client,
      clientId: this._clientId!,
      data: command,
    };

    this.sendMessage(message);
  }

  /**
   * Send a chat message to the active Kilo Code task (background, no focus)
   */
  public sendTaskMessage(text?: string, images?: string[]) {
    this.sendCommand({
      commandName: TaskCommandName.SendMessage,
      data: { text, images },
    });
  }

  /**
   * Start a new task in Kilo Code
   */
  public startNewTask(text: string, images?: string[]) {
    this.sendCommand({
      commandName: TaskCommandName.StartNewTask,
      data: { text, images },
    });
  }

  /**
   * Send a raw IPC message
   */
  public sendMessage(message: IpcMessage) {
    ipc.of[this._id]?.emit("message", message);
  }

  /**
   * Disconnect from the named pipe
   */
  public disconnect() {
    if (this._connectTimeout) {
      clearTimeout(this._connectTimeout);
      this._connectTimeout = undefined;
    }
    try {
      ipc.disconnect(this._id);
    } catch (error) {
      this.log(
        "[client#disconnect] error ->",
        error instanceof Error ? error.message : String(error)
      );
    }
    this._isConnected = false;
    this._clientId = undefined;
  }

  /**
   * Wait for the client to be fully ready (connected + Ack received)
   * Returns true if ready, false if timed out
   */
  public waitForReady(): Promise<boolean> {
    if (this.isReady) return Promise.resolve(true);
    return this._readyPromise;
  }

  public get socketPath() {
    return this._socketPath;
  }

  public get clientId() {
    return this._clientId;
  }

  public get isConnected() {
    return this._isConnected;
  }

  public get isReady() {
    return this._isConnected && this._clientId !== undefined;
  }
}

// ============================================================================
// Client Cache
// ============================================================================

const clientCache = new Map<string, RepromptyIpcClient>();

export function getOrCreateIpcClient(
  socketPath: string,
  log = console.log
): RepromptyIpcClient {
  const existing = clientCache.get(socketPath);

  if (existing && existing.isConnected) {
    return existing;
  }

  // Clean up stale client if it exists
  if (existing) {
    existing.disconnect();
    clientCache.delete(socketPath);
  }

  const client = new RepromptyIpcClient(socketPath, log);
  clientCache.set(socketPath, client);
  return client;
}

export function removeIpcClient(socketPath: string) {
  const client = clientCache.get(socketPath);
  if (client) {
    client.disconnect();
    clientCache.delete(socketPath);
  }
}

export function getAllClients(): Map<string, RepromptyIpcClient> {
  return clientCache;
}
