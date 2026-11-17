---
name: reprompty
description: Open VS Code projects in new windows and on named virtual desktops, arrange windows into layouts, and send prompts to the Claude Code, Codex, Kilo Code and Kimi Code panels in other VS Code windows, using the Reprompty MCP tools. Use when the user asks to open or duplicate a project window, create or rename desktops, apply a layout, prompt or hand work to another agent, continue a specific Claude Code session, save or restore a set of windows, or run one of their Reprompty scripts. Windows 11 and KDE Plasma 6.
---

# Reprompty

Reprompty is a desktop app and MCP server for Windows 11 and KDE Plasma 6. Its tools let you see the user's VS Code windows and the AI agent panels in each one, open projects in new windows on named virtual desktops, move windows into layout slots, and type prompts into the Claude Code, Codex, Kilo Code and Kimi Code panels of other windows. The app doesn't need to be open: your agent runs its own copy of the MCP server.

## Before you start

- No Reprompty tools in your tool list (Claude Code shows them as `mcp__reprompty__<name>`)? The MCP server isn't connected. The user connects it by running `npm run setup` in the `reprompty` folder (see https://github.com/topemalheiro/Reprompty#connect-your-ai-agent).
- A prompt won't send, or `detect_windows` shows no agent panels? Run `check_cdp`. Reprompty types into agent panels through VS Code's debugging port. The user turns it on with `npm run setup -- cdp` in the `reprompty` folder, then quits VS Code completely and reopens it.

## Rules

1. **Never switch the user's virtual desktop.** Don't pass `activateDesktop`. Open windows on other desktops and tell the user which desktop they are on.
2. **Never prompt the window you are running in.** The prompt would land in your own chat. Your window is the one whose title shows the folder of your working directory; if two windows show that folder, ask the user which one is yours.
3. **Prompts are fire-and-forget.** Reprompty types the prompt and sends it, but can't read the reply or tell when the other agent is done. If you need the result, ask the other agent to write it to a file, and read that file later.
4. **Ask before interrupting.** If the other agent may be in the middle of a task, ask the user before sending to it.
5. **Target windows exactly.** Prefer a handle from `detect_windows` to a title. On Windows, pass the window's `handle` as `windowHandle`. On KDE Plasma, pass its `kdotoolHandle` (a `{...}` id) if it has one, otherwise its `handle`: on Wayland `handle` is the process ID, which all VS Code windows share.
6. **Reuse connections.** Check `list_connections` before `add_connection`, and reuse a connection that already points at the window.

## Recipes

### Prompt an agent in another window

1. `detect_windows`. Find the window by its folder name. `availableAgents` lists its agent panels and `activeAgent` the one in front. `sendMethod: "background"` means Reprompty can type into it; `foreground` means it can't (run `check_cdp`).
2. `list_connections`. If a connection already targets that window, use it.
3. Otherwise `add_connection` with `type: "vscode-window"`, a short `name` such as `shop-web`, and `config: { windowTitle: "shop-web", method: "background" }`. Use the folder name as `windowTitle`, not the whole title, which changes whenever the user opens another file. If the window has more than one agent panel, add `extension` to `config` (`claude-code`, `codex`, `kilo-code` or `kimi-code`); otherwise the prompt goes to the active panel.
4. `send_prompt` with `connectionId` (the connection's ID or name) and `prompt`.

### Continue a Claude Code session

1. `list_claude_sessions` with the connection (`connectionId`) or `windowTitle`. Add `query` to search the whole history.
2. `send_prompt` with `session` set to the session ID, or its name or a unique part of it. Reprompty switches the panel to that session first and refuses to send if the switch didn't happen. If a name matches several sessions, the call fails and lists their IDs: retry with one of them.

`select_claude_session` switches the panel without sending anything.

### Same prompt to several windows

`daisy_chain` with `prompts: [{ connectionId, prompt }, ...]` (each item may add a `session`). It sends them one after another without waiting for replies, and stops at the first failure unless you pass `continueOnError: true`.

### Open a project on its own desktop

`spawn_window` with `folderPath` (or `target`, a short name from `list_spawn_targets`) and `desktop: "Backend"`. Reprompty creates the desktop if needed, opens the window and moves it there, while the user stays on their own desktop. `createDesktop: true` instead makes a new desktop named after the folder.

### Open and arrange windows

- `spawn_and_layout` is `spawn_window` plus a `slot`. If it can't tell the new window apart from others that opened at the same time, it stops instead of moving the wrong one.
- For a window that is already open: `list_layout_slots`, then `apply_layout` with `slot` (a letter or a slot name) and the window's handle (rule 5). With no handle or title, it uses a VS Code window on the user's current desktop.
- By default, slot A spreads a window over two side-by-side monitors with the agent panel filling one of them, and slot B fills one monitor. Both are worked out from the user's monitors.

### Second window on the same project (KDE Plasma)

`duplicate_workspace_in_new_window` with `folderPath: "shop-api"` (or part of the window's title as `windowTitle`), and optionally a `slot`. The new window opens on the same desktop as the original.

### Save and restore a work setup

`save_task_preset` with a `name` saves the virtual desktops and the folder of every open VS Code window, with the desktop it is on. `load_task_preset` recreates missing desktops and reopens missing windows on them. `list_task_presets` and `delete_task_preset` manage the saved presets.

### Desktops

`list_virtual_desktops` shows the desktops and the current one. `ensure_virtual_desktop` creates a desktop without switching to it. `rename_virtual_desktop` renames one.

### The user's scripts

`list_scripts` lists the scripts added in the app. `run_script` starts one in the background and returns at once, without its output. `stop_script` stops a script that `run_script` started. Scripts can also add their own tools, which appear in your tool list next to these; each one runs its script once and returns the output. A new script tool only shows up after the user restarts Reprompty's MCP server (for an agent inside VS Code, by reloading the window).

## Tools

Full reference: https://github.com/topemalheiro/Reprompty/blob/main/docs/mcp-tools.md

| Tool | What it does | Key arguments |
| --- | --- | --- |
| `detect_windows` | Lists open VS Code windows with folder, agent panels, desktop, handles and whether Reprompty can type into them | none |
| `detect_all_windows` | Lists every visible window, from any app | none |
| `check_cdp` | Checks VS Code's debugging port and that an agent panel can be reached | none |
| `spawn_window` | Opens a folder in a new VS Code window, optionally on a named desktop | `folderPath` or `target`; `desktop`, `createDesktop`, `windowName` |
| `list_spawn_targets` | Lists saved folders and their short names | none |
| `spawn_and_layout` | `spawn_window`, then a layout slot | as `spawn_window`, plus `slot` |
| `duplicate_workspace_in_new_window` | Opens a second window on an open window's folder (KDE Plasma) | `folderPath` or `windowTitle`; `slot` |
| `list_virtual_desktops` | Lists virtual desktops and marks the current one | none |
| `ensure_virtual_desktop` | Creates a desktop if it is missing, without switching | `name` |
| `rename_virtual_desktop` | Renames a desktop | `currentName`, `newName` |
| `list_layout_slots` | Lists the layout slots | none |
| `apply_layout` | Moves and resizes a window into a slot and sets its side panel width | `slot`; `windowHandle` or `windowTitle` |
| `add_connection` | Saves a window as a prompt target | `type`, `name`, `config.windowTitle`, `config.method` |
| `list_connections` | Lists saved connections | none |
| `remove_connection` | Deletes a connection | `connectionId` (its ID) |
| `send_prompt` | Types a prompt into a connection's agent panel and sends it | `connectionId`, `prompt`; `session` |
| `daisy_chain` | Sends several prompts in order | `prompts`; `continueOnError` |
| `list_claude_sessions` | Lists the sessions in a Claude Code panel's history | `connectionId` or `windowTitle`; `query` |
| `select_claude_session` | Switches a Claude Code panel to a session without sending | `session`; `connectionId` or `windowTitle` |
| `save_task_preset` | Saves desktops and open project windows under a name | `name` |
| `load_task_preset` | Reopens a saved set of desktops and windows | `name` |
| `list_task_presets` | Lists saved presets | none |
| `delete_task_preset` | Deletes a preset | `name` |
| `list_scripts` | Lists the user's scripts and the tools they add | none |
| `run_script` | Starts a script in the background | `scriptId` (ID or name) |
| `stop_script` | Stops a script started with `run_script` | `scriptId` |

Any other tool in your list whose name comes from the user's scripts is a script tool: it runs its script once and returns the output.

## Platform notes

- **Windows 11:** the virtual desktop tools need the VirtualDesktop PowerShell module, which `npm run setup` installs. `duplicate_workspace_in_new_window` isn't available yet.
- **KDE Plasma 6:** Reprompty uses `kdotool` and `qdbus6`; layouts also use `python3` and `kscreen-doctor`. If a tool call ever changes the desktop, the server switches the user back.
- **Not supported:** GNOME and other Linux desktops, and macOS.

## When things fail

| Message or symptom | What to do |
| --- | --- |
| A message about the CDP or debugging port, or `check_cdp` reports it isn't available | The user runs `npm run setup -- cdp` in the `reprompty` folder, then quits VS Code completely and reopens it. |
| `<agent> webview not found in <window>` | That agent's panel isn't open in the window. Ask the user to open it, or use a connection with another `extension`. |
| `No unique VS Code CDP target matched` | No window, or more than one, matches the connection's `windowTitle`. Use a longer, unique part of the title from `detect_windows`. |
| `No background method available` | No open window matches the connection's `windowTitle`, or the window has no agent panel open. Check `detect_windows`; if the title is wrong, remove the connection and add it again with the window's folder name. |
| `Connection "..." not found` | Use an ID or name from `list_connections`. |
| `Spawn target "..." not found` | Use a short name from `list_spawn_targets`, or pass `folderPath` instead. |
| `Slot "..." not found` | Use a letter or name from `list_layout_slots`. |
| `Unable to isolate a unique spawned VS Code window` | No single new window appeared: the folder may already be open (VS Code then brings that window up instead), or several windows opened at once. Run `detect_windows` and use the window's handle with `apply_layout`. |
| `More than one Claude session matches` | Retry with the session ID from the list. |
| Desktop tools fail on Windows | The VirtualDesktop module is missing: the user runs `npm run setup` (or `Install-Module VirtualDesktop -Scope CurrentUser`). |
| A saved folder, connection or script tool is missing | The server loads them when it starts: ask the user to restart Reprompty's MCP server. |

Logs: the app writes to the `reprompty-logs` folder in the user's home folder; the MCP server writes to stderr, so its messages show up wherever your agent keeps MCP server logs. More help: https://github.com/topemalheiro/Reprompty#troubleshooting. KDE layout shortcuts: https://github.com/topemalheiro/Reprompty/blob/main/docs/linux-shortcuts.md.
