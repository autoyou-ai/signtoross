$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$TokenPath = Join-Path $Root ".local\cloudflared-token.txt"
$LogDir = Join-Path $Root ".local"
$OutLog = Join-Path $LogDir "cloudflared.out.log"
$ErrLog = Join-Path $LogDir "cloudflared.err.log"

if (-not (Test-Path -LiteralPath $TokenPath)) {
  throw "Missing .local\cloudflared-token.txt. Recreate the Cloudflare Tunnel token locally before exposing the public OpenSign hostname."
}

$Cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue)
if (-not $Cloudflared) {
  throw "cloudflared is not installed or not on PATH."
}

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

$ResolvedTokenPath = (Resolve-Path -LiteralPath $TokenPath).Path
$Existing = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -ieq "cloudflared.exe" -and
    $_.CommandLine -like "*$ResolvedTokenPath*"
  }

if ($Existing) {
  $Existing |
    Select-Object ProcessId |
    Format-Table -AutoSize
  return
}

Start-Process `
  -FilePath $Cloudflared.Source `
  -ArgumentList @("tunnel", "run", "--url", "http://127.0.0.1:3051", "--token-file", $ResolvedTokenPath) `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog

Start-Sleep -Seconds 5

Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -ieq "cloudflared.exe" -and
    $_.CommandLine -like "*$ResolvedTokenPath*"
  } |
  Select-Object ProcessId |
  Format-Table -AutoSize
