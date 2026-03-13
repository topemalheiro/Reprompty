# Reprompty - Claude Code Integration

This project provides integration between Claude Code and Reprompty.

## Tech Stack

- **Electron** - Desktop application framework
- **Vite** - Build tool
- **Bun** - JavaScript runtime (use `bun` instead of `npm` for running)
- **React** - UI framework
- **TypeScript** - Type safety

## Current Status

**BUILD FAILURE**: The application cannot be built/run due to issues with `vite-plugin-electron` not properly importing the Electron module.

When running `npm run dev` or `npm run start`, the app crashes with:
```
TypeError: Cannot read properties of undefined (reading 'whenReady')
```

This happens because `require("electron")` returns the path to `electron.exe` instead of the Electron module, making `app`, `BrowserWindow`, etc. undefined.

### Attempted Fixes

1. Using different import styles (named imports, namespace imports)
2. Modifying `vite.config.ts` rollup options
3. Moving `electron` to `devDependencies`
4. Downgrading `vite-plugin-electron` to v0.28.0

None of these worked.

## Icon

The tray icon uses a simple cyan square (16x16 PNG base64):
```typescript
const iconDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAH0lEQVQ4T2NkYGD4z0ABYBw1gGE0DBhGwwBm0ACGYRQMAADt9Qf/WqLbFwAAAABJRU5ErkJggg==";
```
