# Reprompty Tray Icon Fix Plan

## Problem
System tray icon not showing in production builds on Windows.

## Fix Attempts

### ❌ Attempt 1: 32x32 icon with path handling
- Used 32x32 PNG icon with proper path handling for dev vs production
- Didn't work

### ❌ Attempt 2: Disable ASAR packaging
- Set `asar: false` in electron-builder.json
- Intended to allow direct filesystem access to icon file
- Didn't work

### ⬜ Attempt 3: Use Windows .ico format
- Created proper ICO file with multiple sizes (16, 32, 48, 256)
- Updated code to load icon.ico from resources folder
- ICO file is now in resources (285KB)
- **Status**: Just built - needs testing

---

## Possible Causes (from research)

Based on web search results, here are common causes for Electron tray icon issues on Windows:

### 1. Icon Format Issues
- **PNG vs ICO**: Windows tray may require `.ico` format instead of `.png`
- **Icon size**: Windows tray icons should typically be 16x16 or 32x32
- **Icon resolution**: May need multiple sizes in ICO (16, 32, 48, 256)

### 2. Path Issues
- **Wrong `process.resourcesPath`**: The path to resources differs between dev and production
- **ASAR packaging**: Icons inside asar archives may not be accessible
- **Extra resources not copied**: The icon file may not be included in the build

### 3. Timing Issues
- **Tray created before app ready**: Tray must be created after `app.whenReady()`
- **Garbage collection**: Tray icon may be garbage collected if not kept in memory

### 4. Windows-Specific Issues
- **"Always show icons" setting**: Windows notification area settings
- **DPI scaling**: Icon may not display correctly on high-DPI displays
- **Taskbar personalization**: Windows 11 taskbar changes

### 5. Code Issues
- **Empty icon**: The nativeImage may be empty or invalid
- **Exception during tray creation**: Silent failures in production
- **Module loading issues**: Electron modules may not load properly in production

---

## Next Fix Options (if ICO doesn't work)

1. Add more logging: Capture errors during tray creation in production
2. Use app.getPath(): Use Electron's built-in path resolution
3. Check Windows settings: Verify notification area settings
4. Use nativeTheme: Check if dark/light mode affects icon display
