# Reprompty Skill

## Overview

Reprompty is an AI agent orchestration framework that enables multi-window prompt engineering, task automation, and agent team coordination. Built with Bun + Electron + Vite for cross-platform development.

## Architecture

```mermaid
graph TD
    A[Skill/Agent] --> B[Reprompty MCP]
    B --> C[Connection Manager]
    C --> D[VS Code Window]
    C --> E[CLI Connection]
    C --> F[Custom API]
    D --> G[Claude Code]
    E --> G
    F --> G
```

## Connection Types

### 1. VS Code Window (Extension)
- Connects to VS Code window via extension
- Sends prompts in foreground or background
- Uses clipboard + SendKeys or extension IPC

### 2. CLI Connection
- Uses `code --folder-uri` for spawning windows
- Spawns new VS Code instances
- Good for batch operations

### 3. Custom API
- HTTP/WebSocket API connections
- For connecting to external AI services
- Extensible for new connection types

## Connection Management

Similar to Auto Claude MCP, connections are stored in a connection pool and can be added/removed dynamically.

### Connection Types

```typescript
type ConnectionType = 'vscode-window' | 'vscode-cli' | 'http-api' | 'websocket';

interface Connection {
  id: string;
  type: ConnectionType;
  name: string;
  config: VSCodeWindowConfig | VSCodeCLIConfig | HTTPAPIConfig | WebSocketConfig;
  status: 'active' | 'inactive' | 'error';
  createdAt: string;
}

interface VSCodeWindowConfig {
  windowTitle: string;
  method: 'foreground' | 'background'; // foreground uses clipboard+SendKeys, background uses extension IPC
}

interface VSCodeCLIConfig {
  folderPath: string;
  args?: string[];
}

interface HTTPAPIConfig {
  url: string;
  headers?: Record<string, string>;
  auth?: {
    type: 'bearer' | 'basic';
    token: string;
  };
}

interface WebSocketConfig {
  url: string;
  protocols?: string[];
}
```

## MCP Tools

### list_spawn_targets
List saved spawn target aliases for VS Code folders.

```typescript
// Returns: Array<{ id: string; label: string; folderPath: string; windowName?: string; desktop?: string }>
```

### list_virtual_desktops
List Windows virtual desktops and indicate which one is current.

```typescript
// Returns: Array<{ index: number; name: string; isCurrent: boolean }>
```

### ensure_virtual_desktop
Create a named Windows virtual desktop if it does not already exist, without switching to it.

```typescript
interface EnsureVirtualDesktopParams {
  name: string;
}
```

### rename_virtual_desktop
Rename a Windows virtual desktop by exact name.

```typescript
interface RenameVirtualDesktopParams {
  currentName: string;
  newName: string;
}
```

### spawn_window
Spawn a new VS Code window using a saved target alias or a raw project folder.

```typescript
type SpawnWindowParams =
  | { target: string; windowName?: string; desktop?: string; createDesktop?: boolean; activateDesktop?: boolean }
  | { folderPath: string; windowName?: string; desktop?: string; createDesktop?: boolean; activateDesktop?: boolean };
```

If `desktop` is supplied and missing, Reprompty creates it and targets that desktop for the spawn. If `createDesktop: true` is supplied without an explicit `desktop`, Reprompty creates a fresh desktop named from the saved target label first, otherwise the folder basename. Desktop-aware spawns stay on the current desktop by default and only switch when `activateDesktop: true` is supplied.

### spawn_and_layout
Spawn a VS Code window and apply a layout slot in one call.

```typescript
type SpawnAndLayoutParams =
  | { target: string; slot: string; desktop?: string; createDesktop?: boolean; activateDesktop?: boolean }
  | { folderPath: string; slot: string; desktop?: string; createDesktop?: boolean; activateDesktop?: boolean };
```

Reprompty now isolates the spawned window by new handle first and only falls back to a unique title match. If it cannot identify one safe target, the tool fails instead of moving the wrong editor window.
Desktop-aware spawns stay on the current desktop by default: Reprompty spawns, isolates the new handle, moves it to the target desktop, and then applies layout by handle. Pass `activateDesktop: true` only when you explicitly want the old switch-first behavior.

### apply_layout
Apply a saved layout slot to an existing VS Code window.

```typescript
interface ApplyLayoutParams {
  slot: string;
  windowHandle?: number;
  windowTitle?: string;
}
```

`windowHandle` is preferred when available because it targets one exact window.

### send_prompt
Send a prompt to a specific connection.

```typescript
interface SendPromptParams {
  connectionId: string;
  prompt: string;
  waitForResponse?: boolean;
  timeout?: number;
}
```

### add_connection
Add a new connection to the connection pool.

```typescript
interface AddConnectionParams {
  type: ConnectionType;
  name: string;
  config: VSCodeWindowConfig | VSCodeCLIConfig | HTTPAPIConfig | WebSocketConfig;
}
```

### list_connections
List all available connections.

```typescript
// Returns: Connection[]
```

### remove_connection
Remove a connection from the pool.

```typescript
interface RemoveConnectionParams {
  connectionId: string;
}
```

### daisy_chain
Chain multiple prompts across connections.

```typescript
interface DaisyChainParams {
  prompts: Array<{
    connectionId: string;
    prompt: string;
  }>;
  continueOnError?: boolean;
}
```

### Script-Defined MCP Tools (Layout Presets)
Scripts can expose first-class MCP tools via portable `reprompty-mcp:` header lines (recommended) or via the Reprompty Scripts tab UI.

Header example (PowerShell):

```powershell
# reprompty-mcp: {"toolName":"dual_monitor_layout_bottom","label":"Dual monitor layout (bottom)","description":"Run the Ctrl+Alt+V dual monitor bottom layout","args":["-Once"]}
# reprompty-mcp: {"toolName":"top_monitors_layout_panel_full","label":"Top monitors layout (panel full)","description":"Run the Ctrl+Alt+N top monitors panel-full layout","args":["-SingleOnce"]}
param(...)
```

Built-in layout calls automatically pass `-WindowHandle` and `-LogPath` to compatible scripts, so one-shot layout runs can target the exact VS Code window and leave behind a transcript.

## Layout Logs

- Reprompty app log: `%USERPROFILE%\\reprompty-logs\\reprompty-YYYY-MM-DD.log`
- One-shot layout transcript: `%LOCALAPPDATA%\\VSCodeSidePanelLayout\\layout-run-<timestamp>.log`
- CDP repair log: `%LOCALAPPDATA%\\VSCodeSidePanelLayout\\repair.log`

## Virtual Desktop Notes

- Desktop names are the public contract for MCP and UI, not numeric indices
- Desktop names refresh from backend polling, so the Windows tab updates after rename
- `ensure_virtual_desktop` is intentionally non-disruptive and does not switch desktops
- Spawn flows stay on the current desktop by default and only switch when `activateDesktop: true` is requested

## Aperant /auto-claude-mcp Handoffs

- Use this section only when the user wants to use Aperant or explicitly says to use the `/auto-claude-mcp` skill
- When that happens, compose the message so the first line is `/auto-claude-mcp`
- Paste the tool-call chain directly into that prompt for the master agent
- Tell the agent to first check whether the relevant project tab is already open in Aperant
- If the project tab already exists, reuse it, skip `open_project`, and do not create a duplicate project tab
- Do not tell the agent to launch or relaunch Aperant as part of this handoff unless the user explicitly asked for a start/restart
- Match the chain to the user's wording:
  - if they say to fully arm Aperant, include the full chain
  - if they say only certain parts or exclude certain parts, remove the unrelated tool calls
- Keep the tool calls in this order when included:
  1. `open_project`
  2. `associate_project_desktop`
  3. `assign_window`
  4. `set_auto_resume_after_rate_limit`
  5. `set_rdr_enabled`

### Fully Arm Aperant Project Tool Call Chain

```text
/auto-claude-mcp

First check whether the relevant project tab is already open in Aperant. If it is already open, reuse it and skip `open_project`. Do not relaunch Aperant unless the user explicitly asked for that.

Then fully arm the Aperant project with the following tool calls in order:
- open_project
- associate_project_desktop
- assign_window
- set_auto_resume_after_rate_limit
- set_rdr_enabled
```

### Partial Chain Rule

```text
If the user says "only", "except", "don't", or otherwise narrows scope, include only the relevant calls from:
- open_project
- associate_project_desktop
- assign_window
- set_auto_resume_after_rate_limit
- set_rdr_enabled
```

## Background Messaging (No Foreground Focus)

Similar to Kilo Code / Roo Code, Reprompty uses **IPC sockets** to send messages in the background without bringing windows to the foreground.

### How It Works

1. **VS Code Extension** runs an IPC server on a Unix socket (or named pipe on Windows)
2. **Reprompty** connects to that socket using an IPC client
3. **Messages are sent** directly to the chat - no window focus needed

### Socket Path Discovery

On Windows, sockets are typically at:
```
\\.\pipe\kilo-ipc-<pid>
\\.\pipe\roo-code-ipc-<pid>
```

The extension listens on `KILO_IPC_SOCKET_PATH` or `ROO_CODE_IPC_SOCKET_PATH` environment variable.

### Foreground vs Background

| Method | Description |
|--------|-------------|
| **background** | Uses IPC socket - message appears in chat without focusing window |
| **foreground** | Uses clipboard + SendKeys - brings window to front (Auto Claude MCP style) |

**Reprompty uses background by default** - this is the key difference from Auto Claude MCP.

## Example Usage (Auto Claude MCP Style)

```typescript
// List saved targets (token-friendly spawn aliases)
await list_spawn_targets();

// List or prepare desktops
await list_virtual_desktops();
await ensure_virtual_desktop({ name: "Aperant-MCP" });
await rename_virtual_desktop({ currentName: "3", newName: "Focus" });

// Spawn a window via target alias on an existing or auto-created desktop
await spawn_window({ target: "windows-project", desktop: "2" });

// Opt into the old switch-first desktop behavior
await spawn_window({ target: "windows-project", desktop: "2", activateDesktop: true });

// Or create a fresh project desktop during spawn
await spawn_and_layout({ target: "windows-project", slot: "B", createDesktop: true });

// Add a VS Code window connection (background - uses IPC socket)
await add_connection({
  type: 'vscode-window',
  name: 'claude-code-main',
  config: {
    socketPath: '\\\\.\\pipe\\kilo-ipc-12345',
    method: 'background'
  }
});

// Add another connection (foreground - uses clipboard + SendKeys)
await add_connection({
  type: 'vscode-window',
  name: 'claude-code-agent',
  config: {
    windowTitle: 'Claude Code',
    method: 'foreground'
  }
});

// Send a prompt (appears in chat without focusing window!)
await send_prompt({
  connectionId: 'claude-code-main',
  prompt: 'Create a simple TypeScript function that adds two numbers'
});

// Daisy chain prompts across multiple windows
await daisy_chain({
  prompts: [
    { connectionId: 'claude-code-main', prompt: 'Create a function' },
    { connectionId: 'claude-code-agent', prompt: 'Add tests for the function' }
  ],
  continueOnError: true
});

// Call a script-defined MCP tool (no args)
await dual_monitor_layout_bottom();
```

## Platform Abstraction

### Windows Implementation
- Use PowerShell/Win32 APIs for window management
- VS Code CLI: `code --folder-uri`
- Window positioning via Win32 API

### Linux Implementation
- Use wmctrl/xdotool for window management
- VS Code CLI: `code --folder-uri`
- Platform code in `src/platform/windows.ts` / `src/platform/linux.ts`

## Project Structure

```
reprompty/
├── src/
│   ├── main/           # Electron main process
│   │   ├── index.ts
│   │   ├── tray.ts     # System tray
│   │   └── ipc.ts     # IPC handlers
│   ├── preload/       # Preload scripts
│   ├── renderer/      # Vite React app
│   │   ├── App.tsx
│   │   └── components/
│   ├── core/          # Platform-agnostic
│   │   ├── connection-manager.ts
│   │   ├── prompt-engine.ts
│   │   └── task-orchestrator.ts
│   └── platform/      # Platform-specific
│       ├── windows.ts
│       └── linux.ts
├── skills/            # Reprompty skills
├── connections/      # Connection configs
├── MCP.md            # MCP server definition
└── package.json
```

## Usage

### Adding a Connection
```typescript
// Via MCP tool
await add_connection({
  type: 'vscode',
  name: 'my-vscode',
  config: {
    windowTitle: 'Claude Code',
    method: 'background' // or 'foreground'
  }
});
```

### Sending a Prompt
```typescript
await send_prompt({
  connectionId: 'my-vscode',
  prompt: 'Write a hello world in TypeScript'
});
```

### Daisy Chaining
```typescript
await daisy_chain({
  prompts: [
    { connectionId: 'vscode-1', prompt: 'Create a function' },
    { connectionId: 'vscode-2', prompt: 'Add tests for the function' }
  ]
});
```

## XML Prompt Templates

Reprompty supports XML-tagged prompt templates:

```xml
<task>
  <context>
    You are working on a TypeScript project.
  </context>
  <goal>
    Create a new utility function
  </goal>
  <constraints>
    - Must be typed
    - Must include JSDoc
  </constraints>
</task>
```

## Future Considerations

- Skill marketplace for sharing prompt templates
- Multi-agent coordination protocols
- Result aggregation and synthesis
- Workflow visualization
