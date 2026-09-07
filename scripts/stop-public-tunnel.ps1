$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$TokenPath = Join-Path $Root ".local\cloudflared-token.txt"

if (-not (Test-Path -LiteralPath $TokenPath)) {
  Write-Output "No .local\cloudflared-token.txt found; no SignToROSS tunnel process can be matched safely."
  return
}

$ResolvedTokenPath = (Resolve-Path -LiteralPath $TokenPath).Path
$Processes = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -ieq "cloudflared.exe" -and
    $_.CommandLine -like "*$ResolvedTokenPath*"
  }

if (-not $Processes) {
  Write-Output "No SignToROSS cloudflared tunnel process is running."
  return
}

foreach ($Process in $Processes) {
  Stop-Process -Id $Process.ProcessId -Force
  Write-Output "Stopped SignToROSS cloudflared tunnel process $($Process.ProcessId)."
}
