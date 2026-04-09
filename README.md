# Reprompty

A framework for orchestrating multiple AI agent windows and prompt engineering workflows on Windows 11.

## Overview

Reprompty enables you to:

- Spawn multiple VS Code windows with isolated chat sessions
- Create prompt templates with XML tags for structured prompting
- Automate batch task execution across multiple windows
- Trigger skills and workflows based on conditions
- Build agent teams that collaborate on complex tasks
- Link LLMs to pass information or to sync to prepare for a merge for example.

## Features

### Window Management

- Spawn duplicate VS Code windows pointing to the same directory
- Each window maintains independent chat history
- Organize windows automatically using scripts

### Prompt Engineering

- XML-tagged prompt templates
- Variable substitution and context injection
- Prompt chaining and composition

### Automation

- Trigger skills based on events
- Batch task creation and management
- Workflow orchestration for multi-agent teams

### Agent Teams

- Coordinate multiple AI agents
- Parallel task execution
- Result aggregation and synthesis

## Getting Started

```bash
# Clone the repository
git clone https://github.com/topemalheiro/Reprompty.git

# Install dependencies
cd reprompty
npm install

# Run the framework
npm start
```

## Kilo Code MCP Setup

Reprompty's stdio MCP server entrypoint is `reprompty/src/mcp/server.ts`.

After installing dependencies in `reprompty/`, register the MCP server in Kilo Code with:

- Working directory: `reprompty`
- Command: `bun`
- Args: `run`, `mcp`
- Equivalent shell command: `cd reprompty && bun run mcp`

Direct entrypoint alternative:

- Command: `bun`
- Args: `run`, `src/mcp/server.ts`

Do not point Kilo Code at `reprompty/src/mcp/index.ts`; that module contains tool implementations, while `reprompty/src/mcp/server.ts` is the stdio transport that handles MCP `initialize`, `tools/list`, and `tools/call`.

## Spawn Targets (Token-Friendly VS Code Spawning)

Reprompty can save common folders as **spawn targets** so MCP clients can open VS Code windows with a short alias instead of a long `folderPath`.

1. Open Reprompty -> **Spawn** tab.
2. Under **Saved Spawn Targets**, fill:
   - Alias (example: `windows-project`)
   - Label (example: `Windows Project`)
   - Folder Path (example: `C:\Users\topem\Desktop\Windows Project`)
   - Optional window name
3. Click **Save Target**.

From MCP:

```text
mcp__reprompty__list_spawn_targets

mcp__reprompty__spawn_window { "target": "windows-project" }
```

`spawn_window` and `spawn_and_layout` still support raw `folderPath` if you prefer not to use aliases.

## Script-Defined MCP Tools (Layout Presets)

Reprompty can turn **script flags / presets** into first-class MCP tools. This is the recommended way to expose layout presets like:

- Ctrl+Alt+V: Dual monitor layout (bottom)
- Ctrl+Alt+N: Top monitors layout (panel full)

### Option A: Portable Script Headers (Recommended)

Add one or more `reprompty-mcp:` lines near the top of your script (first ~40 lines). Each line is JSON describing one tool.

Example (PowerShell):

```powershell
# reprompty-mcp: {"toolName":"dual_monitor_layout_bottom","label":"Dual monitor layout (bottom)","description":"Run the Ctrl+Alt+V dual monitor bottom layout","args":["-Once"]}
# reprompty-mcp: {"toolName":"top_monitors_layout_panel_full","label":"Top monitors layout (panel full)","description":"Run the Ctrl+Alt+N top monitors panel-full layout","args":["-SingleOnce"]}
param(...)
```

Then in Reprompty:

1. Open Reprompty -> **Scripts** tab -> **+ Add Script**.
2. Point to the script file and save.
3. In the script card, under **MCP Tools**, click **Re-scan header** if needed and make sure the tools are enabled.

Now those tool names show up in MCP `tools/list` and can be called directly:

```text
mcp__reprompty__dual_monitor_layout_bottom
mcp__reprompty__top_monitors_layout_panel_full
```

### Option B: UI-Defined Presets (No Script Edits)

In the **Scripts** tab, click **+ Add MCP tool** inside a script card and set:

- Tool name (must be unique across all scripts and not collide with built-in tools)
- Args (space-separated) to pass into the script (example: `-A` or `-Once`)

### Important Notes

- Generated script tools are **one-shot** invocations. The MCP call waits for the script to exit.
  - If your script is a long-running hotkey listener, add a one-shot switch like `-Once` that runs the layout and exits.
- Output from MCP-triggered runs is appended to the script terminal with a `[MCP:<toolName>]` prefix.

## Architecture

Reprompty is designed as a modular framework that can:

- Run as a VS Code extension
- Integrate with existing tools like Kilo Code
- Spawn and manage native Windows processes

## License

MIT License - see LICENSE file for details.

## Contributing

Contributions welcome! Please read our contributing guidelines before submitting PRs.
