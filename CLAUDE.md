# Reprompty: notes for coding agents

Reprompty is an Electron app and a stdio MCP server that find VS Code windows, open projects on virtual desktops, arrange windows into layouts and type prompts into AI agent panels over the Chrome DevTools Protocol, on Windows 11 and KDE Plasma 6.

## Where things are

- `reprompty/src/main`, `src/preload`, `src/renderer`: the Electron app (React UI).
- `reprompty/src/mcp`: the MCP server. `server.ts` is the stdio transport; the tools are in `index.ts` (`BUILT_IN_TOOLS` and `callTool`).
- `reprompty/src/core`: logic shared by the app and the server. `src/platform`: OS code (`windows.ts`, `linux.ts`). `src/setup`: the setup command, `npm run setup` (VS Code's debugging port, agent connections, skill copies, Windows' VirtualDesktop module, the Linux app-menu entry).
- `VSCodeSidePanelLayout/linux_layout.py`: the KDE layout script (Python, standard library only). `reprompty/linux/layout-dual.sh` and `layout-single.sh` call it; keep their paths, because users' KDE shortcuts run them.
- `reprompty/skills/reprompty/SKILL.md`: the agent skill. Its copies in `.claude/skills/`, `.agents/skills/` and `.kilocode/skills/` must stay byte-identical.
- `README.md`, `ROADMAP.md`, `docs/`: user docs. Only document what works; planned work goes in `ROADMAP.md`.
- `wrappy/`: a separate small VS Code extension that Reprompty doesn't use.

## Commands (in `reprompty/`)

- `npm install`
- `npm run build:all`: builds the app into `dist/`, the MCP server into `dist/mcp/server.js` (esbuild, CommonJS, no Electron) and the setup command.
- `npm start`: starts the app, building it first if `dist/` is missing.
- `npm run dev`: starts the app with hot reload.
- `npm test`: vitest. Tests get a temporary home folder (`vitest.config.ts`), so they never touch the real `~/.reprompty`.
- `npx tsc --noEmit -p tsconfig.json` reports many old errors; add no new ones in the files you touch.

## Rules

- Agents must never switch the user's virtual desktop. On KDE Plasma, `src/mcp/server.ts` switches back if a tool changed it; Windows code must not switch desktops at all.
- No machine-specific paths or user names: use `os.homedir()`, PATH lookups (`src/core/which.ts`) and `appResource()` (`src/core/resources.ts`).
- Write "VS Code", "Kilo Code", "Kimi Code", "Claude Code" and "Code - OSS" exactly, with no colon straight after them. A bulk replace once added one in 139 lines and broke window matching.
- A new built-in MCP tool goes in `BUILT_IN_TOOLS` (`src/mcp/index.ts`), `RESERVED_MCP_TOOL_NAMES` (`src/core/script-manager.ts`), `docs/mcp-tools.md` and the skill, then the skill's three repo copies. `tests/docs-sync.test.ts` checks the docs and the copies.
- The MCP server's stdout carries JSON-RPC only: log to stderr.
- Keep comments sparse and match the surrounding code style.

