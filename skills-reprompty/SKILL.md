---
name: reprompty
description: Reprompty MCP tool reference and workflows for multi-window AI agent orchestration on Linux KDE Wayland.
---

# Reprompty Skill

## Overview

Reprompty is an AI agent orchestration framework for Linux (KDE Wayland) that enables multi-window prompt engineering, virtual desktop management, layout automation, and agent team coordination. Built with Electron + Vite.

## Platform

**Primary platform: Linux (KDE Plasma Wayland)**

Window detection uses `kdotool` for native Wayland windows. `wmctrl` is used as fallback for XWayland windows. Layout positioning uses `kdotool` (Wayland) or `xdotool` (X11).

## Using This Skill

This skill auto-loads when you open the Reprompty project in Kimi Code: CLI, Kilo Code:, or Codex. When it is not auto-loaded, invoke it manually with the slash command:

```
/skill:reprompty
```

**Important:** In Kimi Code: and Kilo Code:, the slash command must include the `/skill:` prefix. Send it as its own message, or place it at the very start of your prompt. Because of a current client-side behavior, typing `/skill:reprompty` and then continuing to type on the same line may cause the rest of your prompt to be cleared. To avoid that, either:

- Let the skill auto-load from the project (no manual command needed), or
- Send `/skill:reprompty` first, then send your actual request in a follow-up message.

## Architecture

```
Agent (Kilo/Kimi/Codex) → Reprompty MCP Server → Platform Layer → VS Code: Windows
                                                    ↓
                                            Virtual Desktops (KWin)
                                                    ↓
                                              Layout Engine
```

## MCP Server Setup

### Standalone Server

```bash
# Build the MCP server
npm run build:mcp

# Run it
node dist/mcp/server.js
```

### Kilo Code: Configuration

Add to `~/.config/Code/User/globalStorage/kilocode.kilo-code/settings/mcp_settings.json`:

```json
{
  "mcpServers": {
    "reprompty": {
      "command": "node",
      "args": [
        "/home/tope/Projects/OS-Toolkit/Reprompty/reprompty/dist/mcp/server.js"
      ],
      "disabled": false,
      "autoApprove": [
        "spawn_window",
        "send_prompt",
        "detect_windows",
        "apply_layout"
      ]
    }
  }
}
```

### Codex Configuration

Add to VS Code: `settings.json`:

```json
{
  "chatgpt.mcpServers": {
    "reprompty": {
      "command": "node",
      "args": [
        "/home/tope/Projects/OS-Toolkit/Reprompty/reprompty/dist/mcp/server.js"
      ]
    }
  }
}
```

### Kimi Code: Configuration

Kimi Code: CLI supports MCP via `~/.config/kimi/mcp.json` or a project `.kimi/mcp.json`:

```json
{
  "mcpServers": {
    "reprompty": {
      "command": "node",
      "args": [
        "/home/tope/Projects/OS-Toolkit/Reprompty/reprompty/dist/mcp/server.js"
      ],
      "disabled": false
    }
  }
}
```

Build the server first with `npm run build:mcp` from the `reprompty/` directory.

---

## MCP Tools

### Window Detection

#### `detect_windows`
Auto-detect all VS Code: / Kilo Code: / Kimi Code: / Claude Code: / Codex windows with their PIDs, handles, active agents, virtual desktops, and available background routes.

```typescript
// No parameters
// Returns: Array<{
//   pid: number;
//   handle: number;
//   title: string;
//   folderPath: string;
//   processName: string;
//   desktop?: string;
//   isCurrentDesktop?: boolean;
//   extension: "kilo-code" | "claude-code" | "codex" | "kimi-code" | "unknown";
//   activeAgent: same;
//   availableAgents: string[];
//   backgroundRoute: "ipc-kilo" | "cdp-kilo" | "cdp-claude" | "cdp-codex" | "cdp-kimi" | "foreground";
//   sendMethod: "background" | "foreground";
// }>
```

#### `detect_all_windows`
Detect ALL visible windows on the desktop (browsers, terminals, editors, etc.).

```typescript
// No parameters
```

#### `check_cdp`
Check if Chrome DevTools Protocol is available for background sending.

```typescript
// No parameters
// Returns: { available: boolean; port: number; agentWebview: boolean }
```

---

### Window Spawning

#### `spawn_window`
Spawn a new VS Code: window from a saved target alias or raw folder path.

```typescript
// Option 1: by saved target alias
{ target: string; windowName?: string; desktop?: string; createDesktop?: boolean; activateDesktop?: boolean }

// Option 2: by raw folder path
{ folderPath: string; windowName?: string; desktop?: string; createDesktop?: boolean; activateDesktop?: boolean }
```

**Desktop behavior:**
- `desktop`: explicit desktop name. Created if missing.
- `createDesktop: true`: auto-create a desktop named from target label or folder basename.
- `activateDesktop: true`: **switch to target desktop BEFORE spawning** (old behavior).
- Default (`activateDesktop: false`): spawn on current desktop, then move window to target desktop after detection.

#### `spawn_and_layout`
Spawn + apply layout in one call.

```typescript
{ target?: string; folderPath?: string; slot: string; windowName?: string; desktop?: string; createDesktop?: boolean; activateDesktop?: boolean }
```

`slot` is required — use `"A"`, `"B"`, or a named slot.

#### `list_spawn_targets`
List saved spawn target aliases.

```typescript
// No parameters
// Returns: Array<{ id: string; label: string; folderPath: string; windowName?: string; desktop?: string }>
```

---

### Virtual Desktops

#### `list_virtual_desktops`
List all KDE virtual desktops with index, name, and current status.

```typescript
// No parameters
// Returns: Array<{ index: number; name: string; isCurrent: boolean }>
```

#### `ensure_virtual_desktop`
Create a named desktop if it does not exist. Does NOT switch to it.

```typescript
{ name: string }
// Returns: { success: boolean; created: boolean; desktop?: { index, name, isCurrent }; error?: string }
```

#### `rename_virtual_desktop`
Rename an existing desktop by exact name.

```typescript
{ currentName: string; newName: string }
```

---

### Layout

#### `apply_layout`
Apply a saved layout slot to position/resize a VS Code: window.

```typescript
{ slot: string; windowHandle?: number; windowTitle?: string }
```

`windowHandle` is preferred when available (exact target). `windowTitle` is fallback.

#### `list_layout_slots`
List all configured layout slots.

```typescript
// No parameters
// Returns: Array<{ id: string; letter?: string; name: string; windowX, windowY, windowWidth, windowHeight, panelWidth, monitorHint }>
```

Default Linux slots:
- **Slot A** (Dual Bottom): spans two adjacent monitors, panel on left monitor
- **Slot B** (Top Full Panel): fills one monitor, panel at half width

---

### Prompt Sending

#### `send_prompt`
Send a prompt to a saved connection.

```typescript
{ connectionId: string; prompt: string; waitForResponse?: boolean; timeout?: number }
```

**Background routes by agent:**
- **Kilo Code:** → IPC socket (fastest, no window focus)
- **Kimi Code:** → CDP inject + Enter key simulation
- **Claude Code:** → CDP inject + Enter key simulation
- **Codex:** → CDP inject + Enter key simulation

If background fails, falls back to foreground (clipboard + key simulation).

#### `add_connection`
Add a connection to the pool.

```typescript
{ type: "vscode-window" | "vscode-cli" | "http-api" | "websocket"; name: string; config: { socketPath?: string; windowTitle?: string; method?: "foreground" | "background"; folderPath?: string; url?: string } }
```

For VS Code: windows, `method: "background"` uses CDP (no focus). `method: "foreground"` uses clipboard + key simulation.

#### `list_connections`
List all connections.

#### `remove_connection`
Remove a connection.

```typescript
{ connectionId: string }
```

#### `daisy_chain`
Chain prompts across multiple connections.

```typescript
{ prompts: Array<{ connectionId: string; prompt: string }>; continueOnError?: boolean }
```

---

### Scripts

#### `list_scripts`
List registered scripts.

#### `run_script`
Run a script by ID.

```typescript
{ scriptId: string }
```

#### `stop_script`
Stop a running script.

```typescript
{ scriptId: string }
```

Scripts with `reprompty-mcp:` headers in their first 40 lines are auto-registered as MCP tools.

---

### Script-Generated Tools

These are dynamically registered from scripts:

- `dual_monitor_layout_bottom` — Run the dual-monitor bottom layout
- `top_monitors_layout_panel_full` — Run the top-monitors panel-full layout

---

## Example Workflows

### Spawn a project window on a new desktop

```typescript
await ensure_virtual_desktop({ name: "Aperant-MCP" });
await spawn_window({ target: "aperant", desktop: "Aperant-MCP" });
```

### Spawn + layout in one shot

```typescript
await spawn_and_layout({ target: "voxtype", slot: "A", desktop: "VoxType" });
```

### Send to multiple windows (daisy chain)

```typescript
await daisy_chain({
  prompts: [
    { connectionId: "kilo-main", prompt: "Refactor the auth module" },
    { connectionId: "kimi-voxtype", prompt: "Write tests for the auth module" },
  ],
  continueOnError: true,
});
```

### Detect windows and send to a specific one

```typescript
const windows = JSON.parse(await detect_windows());
const target = windows.find((w: any) => w.title.includes("VoxType"));
if (target) {
  // Add connection dynamically then send
  await add_connection({
    type: "vscode-window",
    name: "voxtype-kimi",
    config: { windowTitle: target.title, method: "background" }
  });
  await send_prompt({ connectionId: "voxtype-kimi", prompt: "Explain this codebase" });
}
```

---

## Logs

- Reprompty app log: `~/reprompty-logs/reprompty-YYYY-MM-DD.log`
- CDP debug log: `~/reprompty-cdp-debug.log`
- Layout transcript: `~/.local/share/VSCodeSidePanelLayout/layout-run-<timestamp>.log`

---

## Agent-Specific Notes

### Kilo Code:
- Full MCP support via `mcp_settings.json`
- Background send uses IPC socket when available
- Falls back to CDP if no socket

### Kimi Code:
- No native MCP support (as of current version)
- Use Reprompty UI or route through Kilo/Codex
- Background send uses CDP with textarea inject + Enter key

### Codex
- MCP support via VS Code: settings
- Background send uses CDP with ProseMirror inject + Enter key

---

## Appendix: Full MCP Tool Reference

### `add_connection`
```json
{
  "name": "required string",
  "type": "vscode-window | vscode-cli | http-api | websocket",
  "config": {
    "method": "foreground | background",
    "windowTitle": "optional string",
    "folderPath": "optional string",
    "socketPath": "optional string",
    "url": "optional string"
  }
}
```

### `remove_connection`
```json
{ "connectionId": "required string" }
```

### `list_connections`
No params. Returns all connections with IDs and statuses.

### `send_prompt`
```json
{
  "connectionId": "required string",
  "prompt": "required string",
  "timeout": "optional number (ms)",
  "waitForResponse": "optional boolean"
}
```

### `daisy_chain`
```json
{
  "prompts": [
    { "connectionId": "...", "prompt": "..." }
  ],
  "continueOnError": "optional boolean"
}
```

### `detect_windows`
No params. Returns all VS Code:/Kimi Code: windows with PIDs and capabilities.

### `check_cdp`
No params. Returns whether Chrome DevTools Protocol is available for background send.

### `spawn_window`
```json
{
  "target": "optional string (saved alias)",
  "folderPath": "optional string",
  "windowName": "optional string",
  "desktop": "optional string",
  "activateDesktop": "optional boolean",
  "createDesktop": "optional boolean"
}
```

### `apply_layout`
```json
{
  "slot": "required string (A, B, or slot name)",
  "windowHandle": "optional number",
  "windowTitle": "optional string"
}
```

### `spawn_and_layout`
```json
{
  "slot": "required string",
  "target": "optional string",
  "folderPath": "optional string",
  "windowName": "optional string",
  "desktop": "optional string",
  "activateDesktop": "optional boolean",
  "createDesktop": "optional boolean"
}
```

### `list_layout_slots`
No params. Returns all layout slots with configurations.

### `dual_monitor_layout_bottom`
No params. Runs the Ctrl+Alt+V dual monitor bottom layout.

### `top_monitors_layout_panel_full`
No params. Runs the Ctrl+Alt+N top monitors panel-full layout.

### `list_virtual_desktops`
No params. Returns all virtual desktops.

### `ensure_virtual_desktop`
```json
{ "name": "required string" }
```

### `rename_virtual_desktop`
```json
{
  "currentName": "required string",
  "newName": "required string"
}
```

### `list_spawn_targets`
No params. Returns all saved spawn target aliases.

### `list_scripts`
No params. Returns all registered scripts with status.

### `run_script`
```json
{ "scriptId": "required string (name or ID)" }
```

### `stop_script`
```json
{ "scriptId": "required string (name or ID)" }
```
