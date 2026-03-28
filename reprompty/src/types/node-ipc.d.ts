declare module "node-ipc" {
  interface IpcConfig {
    silent: boolean;
    retry: number;
    maxRetries: number;
    stopRetrying: boolean;
    id: string;
    [key: string]: unknown;
  }

  interface IpcOfConnection {
    on(event: string, callback: (...args: any[]) => void): void;
    off(event: string, callback: (...args: any[]) => void): void;
    emit(event: string, data?: unknown): void;
  }

  interface IpcServer {
    on(event: string, callback: (...args: any[]) => void): void;
    start(): void;
    stop(): void;
    broadcast(event: string, data?: unknown): void;
    emit(socket: any, event: string, data?: unknown): void;
  }

  interface IPC {
    config: IpcConfig;
    of: Record<string, IpcOfConnection | undefined>;
    server: IpcServer;
    connectTo(id: string, path: string, callback: () => void): void;
    disconnect(id: string): void;
    serve(path: string, callback: () => void): void;
  }

  const ipc: IPC;
  export default ipc;
}
