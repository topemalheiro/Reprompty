# Roadmap

What's planned for Reprompty, roughly in order. Ideas and feedback are welcome in [GitHub issues](https://github.com/topemalheiro/Reprompty/issues).

## At a glance

| When | What |
| --- | --- |
| Now | Agent status dashboard, shut down when all agents are done, usage throttle, read agent replies, panel checks |
| Next | Master agent mode, files viewer, shared chat history, event triggers, prompt templates, task queue, Windows parity, security hardening, Electron upgrade, automatic updates, AUR and winget packages |
| Later | Local explainer agent, account switching, KDE Activities, more editors, GNOME and macOS, MCP server on npm |

## Main features

### Usage throttle

A fader sets how much of an agent's 5-hour usage window it may use. Past that point Reprompty reacts the way you choose: it lowers the reasoning effort, switches to another model, pauses, or waits for the reset and carries on. The fader also works with other windows, such as weekly limits.

**How:** read the usage figures each agent already shows or logs (Codex, for example, writes its rate-limit status to its session logs), then change the effort or the model through the agent's own controls or settings. Some of these sources are undocumented and may change.

### Shut down when all agents are done

Give your agents a batch of tasks, leave them running overnight, and Reprompty shuts the computer down once every agent has finished, after a countdown you can cancel. Together with the [task queue](#agent-coordination), this is what lets batches of tasks run unattended.

**How:** an agent counts as finished when it hasn't been busy or waiting for your input for a few minutes and nothing is queued for it. That comes from the agent status dashboard and from the agents' end-of-turn hooks (Claude Code's Stop hook, Codex's `notify` setting). Then a notification with a Cancel button, one last check when the countdown ends, and `systemctl poweroff` on Linux or `shutdown /s` on Windows. A dry-run mode shows what would happen.

### Master agent mode

One agent directs the others: it opens the windows it needs, hands out tasks, waits for each agent to finish and reads its answer before deciding the next step.

**How:** today's tools (open windows, send prompts, pick Claude Code sessions) plus new tools to read an agent's status, wait until it is idle and read its last reply. Sending to a busy agent is refused unless the prompt is queued.

### Files viewer

Every time an agent is prompted again, Reprompty opens the files it read or changed in its last turn, spread across your displays, so you can follow what it did.

**How:** take the turn's list of files from the agent's transcript or hooks (Claude Code's Read, Edit and Write calls, Codex's recorded file changes), then open the files with `code -g file:line` in viewer windows that the layout engine places on each monitor, with a cap for very large turns.

### Shared chat history between agents

Agents share what was said and decided, so one can pick up where another left off.

**How:** connect every agent to the same memory: Graphiti (free, self-hosted; Reprompty's Portainer tab has start and stop buttons for it) or another free MCP memory server. Add a "hand off" action that writes a short summary of an agent's recent turns to a file and asks the next agent to read it and continue.

### Local explainer agent

A model running on your own computer explains, step by step and in plain words, why an agent did what it did. It is meant for learning, and your code stays on your machine.

**How:** an Explain button on a session or a turn sends a condensed copy of that turn (prompt, replies, tool calls, changes) to a model started from the Llama.cpp tab, through llama-server's OpenAI-compatible API, with follow-up questions in a small chat view. The explanations are reconstructions, not the agent's real reasoning.

### Account switching

Switch between subscriptions, or between several accounts of the same agent (for example two Claude Code or two Codex accounts), and continue each agent where it was. Scripts do the switching for as many agents as possible, and can rotate to the next account automatically when one hits its usage limit.

**How:** one config folder per account (`CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex, and the equivalents for the other agents), with the session history shared between them. Switching saves the current login, points the agent at the next account's folder, reloads the window and resumes the session; Reprompty's Claude Code session picker can reopen it. Rotation starts when the usage throttle or the agent itself reports that the limit was hit.

> [!WARNING]
> Rotating accounts to get around usage limits may break the providers' terms. Anthropic's [consumer terms](https://www.anthropic.com/legal/consumer-terms) forbid bypassing its protective measures, and OpenAI's [terms of use](https://openai.com/policies/terms-of-use/) forbid circumventing rate limits. Team and business plans have their own rules. Automatic rotation will be off by default, and you use it at your own risk.

## Agent coordination

- **Read agent replies and combine results:** wait for an agent to finish, read its answer, and gather the answers of several agents into one summary. *How:* implement `send_prompt`'s `waitForResponse` (accepted today but not implemented) with the status tools and the agents' transcripts or end-of-turn hooks.
- **Event triggers:** run a prompt, a script or a skill when something happens, such as an agent finishing, a file changing or a usage limit getting close. *How:* a local endpoint that receives the agents' hooks, plus simple "when this happens, do that" rules.
- **Task queue:** queue many tasks and hand them to free agents one at a time, with a list of what is pending, running and done. *How:* built on the status tools; send the next task when an agent goes idle.
- **Prompt templates:** save prompts with XML sections and `{{variables}}`, fill them in and send them to any agent. *How:* template files in `~/.reprompty/templates`, a picker in the Send Prompt tab and a `send_template` tool.
- **KDE Activities:** group desktops and windows into KDE Activities and switch whole work contexts at once. *How:* KDE's Activities D-Bus service, next to the existing KWin desktop code.

## Platform and project health

- **Agent status dashboard:** a busy, waiting or idle badge and usage bars for every window in the Windows tab, which several features above build on. *How:* Claude Code's live session list and panel state, plus the window watch Reprompty already runs.
- **Panel checks:** tests that notice when an agent extension changes its chat panel, so sending prompts doesn't break silently after an update.
- **Windows parity:** built-in window layouts on Windows (move and resize through the Windows API, side panel width through VS Code's debugging port, slots worked out from your monitors), and opening a second window on the same project. *How:* the layout pieces exist in `src/core/layout-slots.ts`, `src/core/side-panel.ts` and `src/platform/windows-layout.ts` and need wiring in.
- **Installers:** a Windows installer and a Linux AppImage on GitHub Releases, built by GitHub Actions, so you don't need Git or Node.js.
- **More editors:** VSCodium, Cursor and the Flatpak build of VS Code.
- **GNOME and macOS:** the window and desktop code is specific to Windows and KDE Plasma; the part that types prompts can be shared.
- **Packages:** AUR and winget.
- **Automatic updates** from GitHub Releases.
- **Electron upgrade:** Electron 28 is out of support.
- **Security hardening:** limit what other programs on your computer can do through VS Code's debugging port, and keep account logins in a vault that only you can read.
- **MCP server on npm:** `npx reprompty-mcp` for people who only want the agent tools.

## Recently done

- v0.3.0: installing works on a fresh machine (`npm install` gets a working Electron on npm 12 and Node 26, `npm start` builds first), `npm run setup` turns on VS Code's debugging port and connects Claude Code, Codex, Kilo Code and Kimi Code, and Code - OSS windows are found. Tested on a fresh Windows 11 and on KDE Plasma 6.
