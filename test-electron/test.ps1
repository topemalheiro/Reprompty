# Test electron via PowerShell
$ErrorActionPreference = "Continue"
$electronPath = "C:\Users\user\AppData\Roaming\npm\node_modules\electron\dist\electron.exe"
$scriptPath = "C:\Users\user\Desktop\Windows Project\Reprompty\test-electron\index.js"

Write-Host "Running electron from: $electronPath"
Write-Host "With script: $scriptPath"

& $electronPath $scriptPath
