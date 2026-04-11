/**
 * Reprompty Skill
 * 
 * This skill enables multi-window AI agent orchestration.
 * 
 * Usage:
 * - Add connections to VS Code windows
 * - Send prompts to multiple windows
 * - Daisy chain prompts across windows
 * 
 * Example:
 *   const skill = createRepromptySkill();
 *   await skill.list_spawn_targets();
 *   await skill.spawn_window({ target: "windows-project" });
 *   await skill.add_connection({ type: "vscode-window", name: "agent-1", config: { socketPath: "\\\\.\\pipe\\kilo-ipc-12345", method: "background" } });
 *   await skill.send_prompt({ connectionId: "agent-1", prompt: "Write a hello world function" });
 */

import { runMCPTool } from "../src/mcp/index.js";

export type SpawnWindowParams =
  | {
      target: string;
      windowName?: string;
      desktop?: string;
      createDesktop?: boolean;
    }
  | {
      folderPath: string;
      windowName?: string;
      desktop?: string;
      createDesktop?: boolean;
    };

export type SpawnAndLayoutParams =
  | {
      target: string;
      slot: string;
      windowName?: string;
      desktop?: string;
      createDesktop?: boolean;
    }
  | {
      folderPath: string;
      slot: string;
      windowName?: string;
      desktop?: string;
      createDesktop?: boolean;
    };

export interface ApplyLayoutParams {
  slot: string;
  windowHandle?: number;
  windowTitle?: string;
}

export interface SpawnTargetInfo {
  id: string;
  label: string;
  folderPath: string;
  windowName?: string;
  desktop?: string;
  addedAt: string;
}

export interface VirtualDesktopInfo {
  index: number;
  name: string;
  isCurrent: boolean;
}

export interface SendPromptParams {
  connectionId: string;
  prompt: string;
  waitForResponse?: boolean;
  timeout?: number;
}

export interface AddConnectionParams {
  type: "vscode-window" | "vscode-cli" | "http-api" | "websocket";
  name: string;
  config: {
    socketPath?: string;
    windowTitle?: string;
    method?: "foreground" | "background";
    folderPath?: string;
    url?: string;
  };
}

export interface DaisyChainParams {
  prompts: Array<{
    connectionId: string;
    prompt: string;
  }>;
  continueOnError?: boolean;
}

export const RepromptySkill = {
  name: "reprompty",
  description: "Multi-window AI agent orchestration framework",

  /**
   * List saved spawn targets (token-friendly aliases for folder paths)
   */
  async list_spawn_targets(): Promise<string> {
    return runMCPTool("list_spawn_targets", {});
  },

  /**
   * List Windows virtual desktops
   */
  async list_virtual_desktops(): Promise<string> {
    return runMCPTool("list_virtual_desktops", {});
  },

  /**
   * Ensure a named virtual desktop exists without switching to it
   */
  async ensure_virtual_desktop(params: { name: string }): Promise<string> {
    return runMCPTool("ensure_virtual_desktop", params);
  },

  /**
   * Rename a virtual desktop by exact name
   */
  async rename_virtual_desktop(params: {
    currentName: string;
    newName: string;
  }): Promise<string> {
    return runMCPTool("rename_virtual_desktop", params);
  },

  /**
   * Spawn a new VS Code window
   */
  async spawn_window(params: SpawnWindowParams): Promise<string> {
    return runMCPTool("spawn_window", params as unknown as Record<string, unknown>);
  },

  /**
   * Spawn a new VS Code window and place it into a layout slot
   */
  async spawn_and_layout(params: SpawnAndLayoutParams): Promise<string> {
    return runMCPTool("spawn_and_layout", params as unknown as Record<string, unknown>);
  },

  /**
   * Apply a saved layout slot to an existing VS Code window
   */
  async apply_layout(params: ApplyLayoutParams): Promise<string> {
    return runMCPTool("apply_layout", params as unknown as Record<string, unknown>);
  },

  /**
   * List all saved layout slots
   */
  async list_layout_slots(): Promise<string> {
    return runMCPTool("list_layout_slots", {});
  },

  /**
   * Send a prompt to a connection
   * The prompt appears in the chat without focusing the window
   */
  async send_prompt(params: SendPromptParams): Promise<string> {
    return runMCPTool("send_prompt", {
      connectionId: params.connectionId,
      prompt: params.prompt,
      waitForResponse: params.waitForResponse,
      timeout: params.timeout,
    });
  },

  /**
   * Add a new connection
   */
  async add_connection(params: AddConnectionParams): Promise<string> {
    return runMCPTool("add_connection", {
      type: params.type,
      name: params.name,
      config: params.config,
    });
  },

  /**
   * List all connections
   */
  async list_connections(): Promise<string> {
    return runMCPTool("list_connections", {});
  },

  /**
   * Remove a connection
   */
  async remove_connection(params: { connectionId: string }): Promise<string> {
    return runMCPTool("remove_connection", params);
  },

  /**
   * Chain prompts across multiple windows
   */
  async daisy_chain(params: DaisyChainParams): Promise<string> {
    return runMCPTool("daisy_chain", params as unknown as Record<string, unknown>);
  },

  /**
   * Quick example workflow
   */
  async example(): Promise<string> {
    // This is an example of how to use the skill
    return `
Example usage:

1. List targets + spawn a window using an alias:
   await reprompty.list_spawn_targets();
   await reprompty.spawn_window({ target: "windows-project", desktop: "2" });

2. Create or rename desktops:
   await reprompty.ensure_virtual_desktop({ name: "Aperant-MCP" });
   await reprompty.rename_virtual_desktop({ currentName: "3", newName: "Focus" });

3. Add a connection:
   await reprompty.add_connection({
     type: "vscode-window",
     name: "agent-1",
     config: { socketPath: "\\\\\\\\.\\\\pipe\\\\kilo-ipc-12345", method: "background" }
   });

4. Send a prompt:
   await reprompty.send_prompt({
     connectionId: "agent-1",
     prompt: "Create a TypeScript function that adds two numbers"
   });

5. Daisy chain:
   await reprompty.daisy_chain({
     prompts: [
       { connectionId: "agent-1", prompt: "Create a function" },
       { connectionId: "agent-2", prompt: "Add tests" }
     ]
   });
    `.trim();
  },
};

export default RepromptySkill;
