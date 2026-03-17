@echo off
echo ========================================
echo Reprompty Debug Launcher
echo ========================================
echo.

REM Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"
set "EXE_PATH=%SCRIPT_DIR%release9\win-unpacked\Reprompty.exe"

echo Starting Reprompty...
echo Exe path: %EXE_PATH%
echo.

REM Check if exe exists
if not exist "%EXE_PATH%" (
    echo ERROR: Exe not found at %EXE_PATH%
    pause
    exit /b 1
)

REM Run the exe and capture output
REM Using cmd /c to keep console window open
cmd /c "start \"Reprompty\" \"%EXE_PATH%\""

echo.
echo App started! Check system tray for icon.
echo If tray icon doesn't appear, check:
echo 1. Windows notification area settings
echo 2. Run Task Manager to see if Reprompty is running
echo.
pause
