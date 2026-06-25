# Wrappy

A barebones VS Code: extension that wraps any CLI chat tool (Kimi CLI, Codex CLI, GLM CLI, etc.) in a single shared chat panel.

## Why

The official AI coding extensions are heavy and model-specific. Wrappy is intentionally minimal: one chat view, one CLI setting, shared history across model switches.

## Setup

1. Install the CLI you want to use (`kimi`, `codex`, `glm`, …) and make sure it is on your `PATH`.
2. Open this folder in VS Code:.
3. Run `npm install && npm run compile`.
4. Press `F5` to launch the Extension Development Host.
5. Open the **Wrappy** view from the secondary sidebar.

## Configuration

- `wrappy.cliPath` — path to the CLI executable (default: `kimi`).
- `wrappy.cliArgs` — extra arguments passed on every invocation (default: `[]`).

Switching `cliPath` keeps the existing chat history visible; new messages are sent to the newly selected CLI.

## Build

```bash
npm install
npm run compile
vsce package
```

## License

MIT
