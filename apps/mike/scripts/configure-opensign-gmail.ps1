param(
  [string]$OpenSignDir = (Join-Path $PSScriptRoot "..\..\..\services\opensign"),
  [string]$BackendEnvPath = (Join-Path $PSScriptRoot "..\backend\.env"),
  [string]$SenderEmail = "admin@example.com",
  [switch]$Restart
)

$ErrorActionPreference = "Stop"

function Set-DotEnvValue {
  param(
    [string[]]$Lines,
    [string]$Name,
    [string]$Value
  )

  $escaped = $Value -replace "\\", "\\" -replace "`r", "" -replace "`n", ""
  $line = "$Name=$escaped"
  $pattern = "^\s*$([regex]::Escape($Name))="
  $found = $false
  $next = foreach ($existing in $Lines) {
    if ($existing -match $pattern) {
      $found = $true
      $line
    } else {
      $existing
    }
  }
  if (-not $found) {
    $next += $line
  }
  return $next
}

$resolvedOpenSignDir = (Resolve-Path -LiteralPath $OpenSignDir).Path
$envPath = Join-Path $resolvedOpenSignDir ".env.prod"
$composePath = Join-Path $resolvedOpenSignDir "docker-compose.yml"

if (-not (Test-Path -LiteralPath $envPath)) {
  throw "OpenSign env file not found: $envPath"
}
if (-not (Test-Path -LiteralPath $composePath)) {
  throw "OpenSign compose file not found: $composePath"
}

$securePassword = Read-Host "Google app password for $SenderEmail" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  if ($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

if (-not $plainPassword) {
  throw "No app password supplied."
}

$lines = Get-Content -LiteralPath $envPath
$lines = Set-DotEnvValue $lines "SMTP_ENABLE" "true"
$lines = Set-DotEnvValue $lines "SMTP_HOST" "smtp.gmail.com"
$lines = Set-DotEnvValue $lines "SMTP_PORT" "465"
$lines = Set-DotEnvValue $lines "SMTP_USER_EMAIL" $SenderEmail
$lines = Set-DotEnvValue $lines "SMTP_USERNAME" $SenderEmail
$lines = Set-DotEnvValue $lines "SMTP_PASS" $plainPassword

Set-Content -LiteralPath $envPath -Value $lines -Encoding UTF8
Write-Host "OpenSign Gmail SMTP settings updated in $envPath"

if (Test-Path -LiteralPath $BackendEnvPath) {
  $backendLines = Get-Content -LiteralPath $BackendEnvPath
  $backendLines = Set-DotEnvValue $backendLines "OPENSIGN_SELFHOST_SEND_EMAIL" "true"
  $backendLines = Set-DotEnvValue $backendLines "OPENSIGN_SELFHOST_REQUIRE_EMAIL" "true"
  $backendLines = Set-DotEnvValue $backendLines "OPENSIGN_SELFHOST_EMAIL_CONFIGURED" "true"
  Set-Content -LiteralPath $BackendEnvPath -Value $backendLines -Encoding UTF8
  Write-Host "Mike backend email-readiness settings updated in $BackendEnvPath"
} else {
  Write-Host "Backend env file not found at $BackendEnvPath; skipped Mike email-readiness settings."
}

if ($Restart) {
  docker compose -f $composePath up -d --force-recreate server client
  Write-Host "OpenSign server and client services restarted."
} else {
  Write-Host "Run with -Restart to recreate the OpenSign server and client containers."
}
