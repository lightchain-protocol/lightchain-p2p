# Starts a clean instance of the chat app with a debug port, for driving from a
# script. Kills any instance already using that storage first, because two
# processes over one Corestore deadlock rather than failing.
#
#   .\scripts\run-app.ps1 -Storage A -Port 9301 -Fresh
#
# -Fresh wipes the storage directory. Without it the instance keeps whatever was
# there, which is how a restart is tested.

param(
  [string]$Storage = 'A',
  [int]$Port = 9301,
  [switch]$Fresh
)

$ErrorActionPreference = 'Stop'

$chat = Join-Path $PSScriptRoot '..\apps\chat' | Resolve-Path
$dir = Join-Path $env:LOCALAPPDATA "LightchainDemo\$Storage"

function Stop-Tree($processId) {
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$processId" -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Tree $_.ProcessId }
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}

$running = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match [regex]::Escape($dir) }
foreach ($p in $running) { Stop-Tree $p.ProcessId }
if ($running) { Start-Sleep -Seconds 3 }

if ($Fresh) { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }

Push-Location $chat
try {
  $electron = & node -p "require('electron')"
  Start-Process $electron -WorkingDirectory $chat -ArgumentList @(
    '.', '--no-updates', '--no-room-gate', "--remote-debugging-port=$Port", '--storage', $dir
  ) | Out-Null
} finally {
  Pop-Location
}

foreach ($i in 1..60) {
  Start-Sleep -Milliseconds 500
  try {
    Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 2 | Out-Null
    Write-Host "app ready on $Port, storage $dir"
    exit 0
  } catch {
    # Still starting.
  }
}

Write-Error "app did not answer on $Port within 30s"
exit 1
