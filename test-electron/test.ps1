# Test electron via PowerShell
$ErrorActionPreference = "Continue"
$electronPath = "C:\Users\topem\AppData\Roaming\npm\node_modules\electron\dist\electron.exe"
$scriptPath = "C:\Users\topem\Desktop\OS Toolkit\Reprompty\test-electron\index.js"

Write-Host "Running electron from: $electronPath"
Write-Host "With script: $scriptPath"

& $electronPath $scriptPath
