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
 *   await skill.spawn_window({ folderPath: "/path/to/project" });
 *   await skill.add_connection({ type: "vscode-window", name: "agent-1", config: { socketPath: "\\\\.\\pipe\\kilo-ipc-12345", method: "background" } });
 *   await skill.send_prompt({ connectionId: "agent-1", prompt: "Write a hello world function" });
 */

import { runMCPTool } from "../src/mcp/index.js";

export interface SpawnWindowParams {
  folderPath: string;
  windowName?: string;
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
   * Spawn a new VS Code window
   */
  async spawn_window(params: SpawnWindowParams): Promise<string> {
    return runMCPTool("spawn_window", params as unknown as Record<string, unknown>);
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

1. Spawn a window:
   await reprompty.spawn_window({ folderPath: "C:/my-project" });

2. Add a connection:
   await reprompty.add_connection({
     type: "vscode-window",
     name: "agent-1",
     config: { socketPath: "\\\\\\\\.\\\\pipe\\\\kilo-ipc-12345", method: "background" }
   });

3. Send a prompt:
   await reprompty.send_prompt({
     connectionId: "agent-1",
     prompt: "Create a TypeScript function that adds two numbers"
   });

4. Daisy chain:
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
