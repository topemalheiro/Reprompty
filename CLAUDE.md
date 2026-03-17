# Reprompty - Claude Code Integration

This project provides integration between Claude Code and Reprompty.

## Tech Stack

- **Electron** - Desktop application framework
- **Vite** - Build tool
- **Bun** - JavaScript runtime (use `bun` instead of `npm` for running)
- **React** - UI framework
- **TypeScript** - Type safety

## Running the App

```bash
cd reprompty
bun run dev    # Development mode
bun run build  # Production build
```

## Build Output

The production build is located at:
- `reprompty/release9/win-unpacked/Reprompty.exe`

## Icon

The tray icon uses an embedded 32x32 cyan triangle PNG (base64 encoded) that works in both dev and production modes:

```typescript
const iconDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAhElEQVRYR+2WMQ6AIAwD+/+P1oGBsVBsbLTc1EtLiJDi7kJb0iHJt7NJ+vLpBwDwLwCA/xIAgH8BAPyXAMD/CgDgvwQA4F8AAP8lAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IQAA/yEAAP8hAAD/IXoA7wABVQJYpgAAAABJRU5ErkJggg==";
```

This is loaded directly via `nativeImage.createFromDataURL()` which works reliably in both development and production builds.

## Project Structure

```
reprompty/
├── src/
│   ├── main/          # Electron main process
│   ├── preload/       # Preload scripts
│   ├── renderer/      # React UI
│   ├── core/          # Core functionality
│   ├── mcp/          # MCP server integration
│   └── platform/      # Platform-specific code
├── skills/           # Claude Code skills
├── release9/         # Production build output
│   └── win-unpacked/
│       └── Reprompty.exe
└── package.json
```
