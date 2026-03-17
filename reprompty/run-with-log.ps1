# Reprompty Debug Launcher with Logging
$ErrorActionPreference = "Continue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exePath = Join-Path $scriptDir "release9\win-unpacked\Reprompty.exe"
$logPath = Join-Path $scriptDir "reprompty-debug.log"

# Clear old log
"" | Out-File -FilePath $logPath -Encoding utf8

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"[$timestamp] Reprompty Debug Launcher starting..." | Out-File -FilePath $logPath -Append
"[$timestamp] Exe path: $exePath" | Out-File -FilePath $logPath -Append
"[$timestamp] Log path: $logPath" | Out-File -FilePath $logPath -Append

# Check if exe exists
if (-not (Test-Path $exePath)) {
    "ERROR: Exe not found at $exePath" | Out-File -FilePath $logPath -Append
    Read-Host "Press Enter to exit"
    exit 1
}

"[$timestamp] Exe found, starting app..." | Out-File -FilePath $logPath -Append

# Start the process
$process = Start-Process -FilePath $exePath -PassThru -WindowStyle Normal

"[$timestamp] Process started with PID: $($process.Id)" | Out-File -FilePath $logPath -Append

# Wait a few seconds
Start-Sleep -Seconds 5

# Check if still running
if (-not $process.HasExited) {
    "[$timestamp] App is running!" | Out-File -FilePath $logPath -Append
    Write-Host "Reprompty is running! Check the system tray."
    Write-Host "Log file: $logPath"
} else {
    "[$timestamp] App exited with code: $($process.ExitCode)" | Out-File -FilePath $logPath -Append
    Write-Host "App exited with code: $($process.ExitCode)"
}

# Keep script running so we can see output
Write-Host ""
Write-Host "==================================="
Write-Host "Reprompty Debug Info:"
Write-Host "==================================="
Write-Host "Exe: $exePath"
Write-Host "Log: $logPath"
Write-Host "PID: $($process.Id)"
Write-Host ""
Write-Host "If tray icon doesn't show:"
Write-Host "1. Check Windows notification area"
Write-Host "2. Open Task Manager and look for Reprompty"
Write-Host "3. Check the log file for errors"
Write-Host ""
Write-Host "Press any key to exit..."
Read-Host ""
