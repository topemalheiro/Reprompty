# MCP tools

Reprompty's MCP server gives your AI agent the tools below. You don't call them yourself: ask your agent in plain words, for example "open shop-api on a desktop called Backend", and it picks the tools. To connect an agent, see [Agent setup](../README.md#connect-your-ai-agent).

- [Find windows](#find-windows): [`detect_windows`](#detect_windows), [`detect_all_windows`](#detect_all_windows), [`check_cdp`](#check_cdp)
- [Open windows](#open-windows): [`spawn_window`](#spawn_window), [`list_spawn_targets`](#list_spawn_targets), [`spawn_and_layout`](#spawn_and_layout), [`duplicate_workspace_in_new_window`](#duplicate_workspace_in_new_window)
- [Virtual desktops](#virtual-desktops): [`list_virtual_desktops`](#list_virtual_desktops), [`ensure_virtual_desktop`](#ensure_virtual_desktop), [`rename_virtual_desktop`](#rename_virtual_desktop)
- [Layouts](#layouts): [`list_layout_slots`](#list_layout_slots), [`apply_layout`](#apply_layout)
- [Send prompts](#send-prompts): [`add_connection`](#add_connection), [`list_connections`](#list_connections), [`remove_connection`](#remove_connection), [`send_prompt`](#send_prompt), [`daisy_chain`](#daisy_chain)
- [Claude Code sessions](#claude-code-sessions): [`list_claude_sessions`](#list_claude_sessions), [`select_claude_session`](#select_claude_session)
- [Task presets](#task-presets): [`save_task_preset`](#save_task_preset), [`load_task_preset`](#load_task_preset), [`list_task_presets`](#list_task_presets), [`delete_task_preset`](#delete_task_preset)
- [Scripts](#scripts): [`list_scripts`](#list_scripts), [`run_script`](#run_script), [`stop_script`](#stop_script)
- [Tools from your scripts](#tools-from-your-scripts)
- [Good to know](#good-to-know)

## Find windows

### `detect_windows`

Lists your open VS Code windows (on KDE Plasma also Code - OSS) with their title, folder, the AI agent panels each one has and which one is active, the virtual desktop it is on, and whether Reprompty can type into it.

No arguments.

Each window comes with a `handle` (on KDE Plasma often also a `kdotoolHandle`) to pass to [`apply_layout`](#apply_layout). `sendMethod: "background"` means Reprompty can type into the window. Agent panels only show up while VS Code's [debugging port](../README.md#vs-codes-debugging-port) is on.

Works on: Windows 11 and KDE Plasma 6.

### `detect_all_windows`

Lists every visible window, from any app, with its title, handle, process ID and program name.

No arguments.

Works on: Windows 11 and KDE Plasma 6.

### `check_cdp`

Checks that VS Code's debugging port answers and that an agent panel can be reached through it. Run it when prompts don't arrive.

No arguments.

It returns `available`, the `port` and a `reason`. If the port is off, turn it on with `npm run setup -- cdp` in the `reprompty` folder, then quit VS Code completely and reopen it.

Works on: Windows 11 and KDE Plasma 6.

## Open windows

### `spawn_window`

Opens a folder in a new VS Code window, optionally on a named virtual desktop, while you stay on the desktop you are using.

| Argument | Required | Meaning |
| --- | --- | --- |
| `folderPath` | Yes, or `target` | The folder to open. |
| `target` | Yes, or `folderPath` | The short name of a saved folder (see [`list_spawn_targets`](#list_spawn_targets)). |
| `desktop` | No | The desktop to put the window on. It is created if it doesn't exist. |
| `createDesktop` | No | `true` creates a new desktop named after the saved folder's label or the folder's name, when no `desktop` is given. |
| `windowName` | No | Text you expect in the new window's title. Reprompty uses it to pick out the new window when several open at once; it doesn't rename the window. |
| `activateDesktop` | No | `true` switches you to the desktop before the window opens. Agents shouldn't use it; on KDE Plasma the server switches you back anyway. |

A saved folder can have its own default desktop; `desktop` and `createDesktop` override it. Reprompty opens the window on your current desktop, waits for it to appear and then moves it to the target desktop.

Works on: Windows 11 and KDE Plasma 6. Desktops on Windows need the VirtualDesktop PowerShell module (see [Virtual desktops](#virtual-desktops)).

### `list_spawn_targets`

Lists the folders saved in the app's **Spawn** tab, with the short name to pass as `target`, the folder path, and the optional window name and default desktop.

No arguments.

Works on: Windows 11 and KDE Plasma 6.

### `spawn_and_layout`

Does what [`spawn_window`](#spawn_window) does, then moves the new window into a layout slot.

| Argument | Required | Meaning |
| --- | --- | --- |
| `slot` | Yes | The slot's letter (`A`, `B`) or name, from [`list_layout_slots`](#list_layout_slots). |
| `folderPath`, `target`, `desktop`, `createDesktop`, `windowName`, `activateDesktop` | As in `spawn_window` | As in [`spawn_window`](#spawn_window). |

It waits up to 15 seconds for the new window. If it can't tell the new window apart from others that opened at the same time, it stops with an error instead of moving the wrong window. The layout is applied before the window moves to its desktop.

Works on: KDE Plasma 6. On Windows the window opens but the layout step isn't built in yet.

### `duplicate_workspace_in_new_window`

Opens a second VS Code window on the same folder as a window that is already open, on the same desktop, for example to run two agents on one project.

| Argument | Required | Meaning |
| --- | --- | --- |
| `windowTitle` | Yes, or `folderPath` | Part of the open window's title. |
| `folderPath` | Yes, or `windowTitle` | Part of the open window's folder path, or the folder's name. |
| `slot` | No | A layout slot to apply to the new window. |

The new window opens a temporary workspace file, so its title reads `reprompty-dup-<folder>-<number> (Workspace)`.

Works on: KDE Plasma 6. Not on Windows yet.

## Virtual desktops

These tools never switch your desktop. On Windows they need the VirtualDesktop PowerShell module, which `npm run setup` installs.

### `list_virtual_desktops`

Lists your virtual desktops with their position (`index`), name, and which one you are on (`isCurrent`).

No arguments.

Works on: Windows 11 and KDE Plasma 6.

### `ensure_virtual_desktop`

Creates a virtual desktop with this exact name if there isn't one yet. It doesn't switch to it.

| Argument | Required | Meaning |
| --- | --- | --- |
| `name` | Yes | The desktop's name. |

Works on: Windows 11 and KDE Plasma 6.

### `rename_virtual_desktop`

Renames a virtual desktop.

| Argument | Required | Meaning |
| --- | --- | --- |
| `currentName` | Yes | The desktop's current name, exactly. |
| `newName` | Yes | The new name. |

Works on: Windows 11 and KDE Plasma 6.

## Layouts

A layout slot is a saved window position and size plus the width of the AI side panel. Reprompty starts with two example slots, A and B. Set the position and size for your own monitors in `~/.reprompty/layouts.json` (`windowX`, `windowY`, `windowWidth`, `windowHeight`, `panelWidth`). Layouts work on KDE Plasma; built-in layouts for Windows are on the [roadmap](../ROADMAP.md).

You can also apply slot A with Ctrl+Alt+V and slot B with Ctrl+Alt+N. On KDE Plasma, set them up as [system shortcuts](linux-shortcuts.md).

### `list_layout_slots`

Lists the layout slots with their letter, name, position and size.

No arguments.

Works on: Windows 11 and KDE Plasma 6.

### `apply_layout`

Moves and resizes a VS Code window into a layout slot, then sets the width of its AI side panel through VS Code's debugging port.

| Argument | Required | Meaning |
| --- | --- | --- |
| `slot` | Yes | The slot's letter (`A`, `B`) or name. |
| `windowHandle` | No | The window to move, from [`detect_windows`](#detect_windows): its `handle` on Windows; on KDE Plasma its `kdotoolHandle` (a `{...}` id) if it has one, otherwise its `handle`. Preferred over `windowTitle`. |
| `windowTitle` | No | Part of the window's title. |

With neither `windowHandle` nor `windowTitle`, it uses a VS Code window on your current desktop. It runs Reprompty's layout script, which uses `kdotool`.

Works on: KDE Plasma 6. Not built in on Windows yet.

## Send prompts

Reprompty types a prompt into an agent panel and sends it, without bringing the window to the front. It doesn't wait for or read the reply. First save the window as a connection, then send to the connection.

### `add_connection`

Saves a VS Code window as a connection that you can send prompts to.

| Argument | Required | Meaning |
| --- | --- | --- |
| `type` | Yes | `vscode-window`. The other accepted types (`vscode-cli`, `http-api`, `websocket`) can't be sent to yet. |
| `name` | Yes | A short name, for example `shop-web`. You can use it in place of the ID. |
| `config.windowTitle` | Yes | Text in the window's title that finds the window. Use the project's folder name: the full title changes whenever another file is opened. |
| `config.method` | Yes | `background`. |
| `config.extension` | No | Which agent panel to type into when the window has several: `claude-code`, `codex`, `kilo-code` or `kimi-code`. By default the prompt goes to the active panel. |
| `config.socketPath` | No | Kilo Code only: the window's `pipePath` from `detect_windows`. Prompts then go through Kilo Code's own channel, which is faster. |

Works on: Windows 11 and KDE Plasma 6.

### `list_connections`

Lists the saved connections with their ID, name, settings and status.

No arguments.

Works on: Windows 11 and KDE Plasma 6.

### `remove_connection`

Deletes a saved connection.

| Argument | Required | Meaning |
| --- | --- | --- |
| `connectionId` | Yes | The connection's ID, from [`list_connections`](#list_connections). |

Works on: Windows 11 and KDE Plasma 6.

### `send_prompt`

Types a prompt into a connection's agent panel and sends it.

| Argument | Required | Meaning |
| --- | --- | --- |
| `connectionId` | Yes | The connection's ID or name. |
| `prompt` | Yes | The text to send. |
| `session` | No | Claude Code only: the session to continue, by ID, or by name (or a unique part of it) as [`list_claude_sessions`](#list_claude_sessions) shows it. Reprompty switches the panel to that session first, and refuses to send if the switch didn't happen. |

`waitForResponse` and `timeout` are accepted but do nothing yet; reading replies is on the [roadmap](../ROADMAP.md). A Kilo Code connection with a `socketPath` sends through Kilo Code's own channel; everything else goes through VS Code's debugging port.

Works on: Windows 11 and KDE Plasma 6.

### `daisy_chain`

Sends several prompts one after another, each to its own connection. It doesn't wait for an agent to finish before sending the next prompt.

| Argument | Required | Meaning |
| --- | --- | --- |
| `prompts` | Yes | A list of `{ connectionId, prompt, session }` items. `session` is optional, as in [`send_prompt`](#send_prompt). |
| `continueOnError` | No | `true` keeps going after a failed send. By default it stops at the first failure. |

Works on: Windows 11 and KDE Plasma 6.

## Claude Code sessions

### `list_claude_sessions`

Lists the sessions in a Claude Code panel's session history (its Local tab): the session ID, its name, how long ago it was used, and which one is open.

| Argument | Required | Meaning |
| --- | --- | --- |
| `connectionId` | No | The connection whose window to read, by ID or name. |
| `windowTitle` | No | Part of the window's title, instead of a connection. |
| `query` | No | Text to type into the history's own search box. It also finds sessions that aren't in the first list. |

With neither `connectionId` nor `windowTitle`, it only works when one VS Code window is open.

Works on: Windows 11 and KDE Plasma 6.

### `select_claude_session`

Switches a Claude Code panel to a session from its history, without sending anything.

| Argument | Required | Meaning |
| --- | --- | --- |
| `session` | Yes | The session ID, or its name (or a unique part of it). |
| `connectionId` | No | The connection whose window to use, by ID or name. |
| `windowTitle` | No | Part of the window's title, instead of a connection. |

If a name matches more than one session, the call fails and lists the matches with their IDs.

Works on: Windows 11 and KDE Plasma 6.

## Task presets

A task preset saves your virtual desktops and the project windows on them, so you can bring the same setup back later. Presets are JSON files in `~/.config/reprompty/presets/` (on Windows, in `.config\reprompty\presets` in your user folder).

### `save_task_preset`

Saves your virtual desktops and the folder of every open VS Code window, with the desktop it is on, under a name.

| Argument | Required | Meaning |
| --- | --- | --- |
| `name` | Yes | The preset's name, for example `Shop`. |

Works on: Windows 11 and KDE Plasma 6.

### `load_task_preset`

Brings a preset back: creates the desktops that are missing, opens the windows that aren't open yet and moves them to their desktops. It doesn't switch your desktop.

| Argument | Required | Meaning |
| --- | --- | --- |
| `name` | Yes | The preset's name. |

Works on: Windows 11 and KDE Plasma 6.

### `list_task_presets`

Lists the names of the saved presets.

No arguments.

Works on: Windows 11 and KDE Plasma 6.

### `delete_task_preset`

Deletes a saved preset.

| Argument | Required | Meaning |
| --- | --- | --- |
| `name` | Yes | The preset's name. |

Works on: Windows 11 and KDE Plasma 6.

## Scripts

These work with the scripts you add in the app's **Scripts** tab. The MCP server runs separately from the app, so it only knows the status of scripts that the agent itself started.

### `list_scripts`

Lists your scripts with their ID, name, path, type, the tools they add, and their status.

No arguments.

Works on: Windows 11 and KDE Plasma 6.

### `run_script`

Starts a script in the background and returns right away, without its output.

| Argument | Required | Meaning |
| --- | --- | --- |
| `scriptId` | Yes | The script's ID or name. |

The script runs with `REPROMPTY_BACKGROUND=1` set, so it can tell that an agent started it.

Works on: Windows 11 and KDE Plasma 6.

### `stop_script`

Stops a script that [`run_script`](#run_script) started in the same agent session. Scripts started from the app are stopped in the app.

| Argument | Required | Meaning |
| --- | --- | --- |
| `scriptId` | Yes | The script's ID or name. |

Works on: Windows 11 and KDE Plasma 6.

## Tools from your scripts

Any script in the **Scripts** tab can add tools of its own. Your agent sees them next to the built-in tools; each one runs the script once with the arguments you chose and returns what the script printed.

There are two ways to add one:

- Put one line per tool in the script, within its first 40 lines. Any comment style works, as long as the line contains `reprompty-mcp:` followed by the tool's JSON:

  ```bash
  # reprompty-mcp: {"toolName":"backup_notes","label":"Back up notes","description":"Copy my notes to the backup drive","args":["--once"]}
  ```

  If the script was already added, click **Re-scan header** on its card.
- Or click **+ Add MCP tool** on the script's card and fill in the same fields.

| Field | Required | Meaning |
| --- | --- | --- |
| `toolName` | Yes | The tool's name, in lower-case letters, digits and underscores (spaces and hyphens become underscores, other characters are dropped). It can't be a built-in tool's name or a name another script already uses. |
| `label` | Yes | A short title shown in the app. |
| `description` | No | What the tool does. Your agent reads it to decide when to use the tool. |
| `args` | No | Arguments passed after the script's own arguments. |
| `enabled` | No | `false` turns the tool off. |

How a script tool runs:

- Once, until the script exits. Reprompty sets no time limit, but agents stop waiting after their own tool timeout, so a script that keeps running (a key listener, for example) needs an argument that makes it do one thing and exit.
- The agent gets the script's output (stdout and stderr) and exit code. The output doesn't appear in the app's Scripts tab, because the MCP server is a separate process.
- It fails if the same script is already running from [`run_script`](#run_script).
- The script runs with `REPROMPTY_BACKGROUND=1` set.
- Each script type runs with:

  | Script type | Runs with |
  | --- | --- |
  | PowerShell (`.ps1`) | `powershell.exe` on Windows, `pwsh` (PowerShell 7) on Linux |
  | Batch (`.bat`, `.cmd`) | `cmd /c` |
  | VBScript (`.vbs`) | `cscript` |
  | Shell (`.sh`) | `bash` |
  | Python (`.py`) | `python3`, which must be on your PATH (on Windows too) |
  | Executable | The program itself |

Your agent loads the list of tools when its Reprompty server starts, so after adding or changing a script tool, restart the agent's MCP server (for an agent inside VS Code, reload the window).

An example that ships with Reprompty: [scripts/vscode-toggle-secondary-sidebar.py](../scripts/vscode-toggle-secondary-sidebar.py) (Linux) adds seven tools that toggle VS Code's secondary side bar and manage a key for it.

## Good to know

- Each agent starts its own copy of the MCP server. The Reprompty app doesn't need to be open.
- Claude Code shows the tools as `mcp__reprompty__<name>`. The tools that only read, which you can safely auto-approve, are `detect_windows`, `detect_all_windows`, `check_cdp` and every `list_` tool.
- Reprompty keeps its data in `~/.reprompty/` (on Windows, `.reprompty` in your user folder): `connections.json`, `layouts.json`, `scripts.json`, `settings.json` and `spawn-targets.json`. Task presets are in `~/.config/reprompty/presets/`.
- The server loads your saved folders, scripts and connections when it starts. After changing them in the app, restart the agent's MCP server.
- On KDE Plasma, if a tool call ever changes your virtual desktop, the server switches you back.
- The server writes its log to stderr, so its messages show up wherever your agent keeps MCP server logs. Where the app keeps its logs: [Troubleshooting](../README.md#troubleshooting).
