# Launches the chat app from source with the user's default profile storage,
# exactly like `npm start` (electron-forge start) but without the forge wrapper.
#
# PATH is rebuilt from the registry (Machine + User) so the app sees the same
# environment as a normal Start Menu launch. Inheriting the caller's PATH is
# wrong when the caller is a minimal shell: the Earn preflight probes for
# docker, cast and powershell then report a healthy host as broken.
$ErrorActionPreference = 'Stop'
$chat = Join-Path $PSScriptRoot '..\apps\chat' | Resolve-Path

$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$user = [Environment]::GetEnvironmentVariable('Path', 'User')
# User PATH may contain %VARS%; expand them.
$user = [Environment]::ExpandEnvironmentVariables($user)
$env:Path = "$machine;$user"

# Stop any already-running instance of this app so we never show a stale window.
# Match on the exe path: the app is launched with a relative '.', so the working
# directory never appears in the command line, but node_modules\electron does.
$repoRoot = Join-Path $PSScriptRoot '..' | Resolve-Path
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match [regex]::Escape($repoRoot.Path) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

$electron = & "C:\Users\PC\AppData\Local\Programs\Kimi\resources\resources\runtime\node.exe" -p "require('electron')"
Start-Process $electron -WorkingDirectory $chat -ArgumentList '.', '--no-updates'
Write-Host "launched from $chat with full user PATH"
