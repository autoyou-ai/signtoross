param(
  [switch]$SkipBuild,
  [switch]$Live
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Mike = Join-Path $Root "apps\mike"
$OpenSign = Join-Path $Root "services\opensign"

& (Join-Path $PSScriptRoot "verify-public-tree.ps1")

if (-not $SkipBuild) {
  npm run build --prefix (Join-Path $Mike "backend")
  if (-not $env:NEXT_PUBLIC_SUPABASE_URL) {
    $env:NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
  }
  if (-not $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY) {
    $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY = "public-anon-key-placeholder"
  }
  if (-not $env:NEXT_PUBLIC_API_BASE_URL) {
    $env:NEXT_PUBLIC_API_BASE_URL = "http://localhost:3001"
  }
  npm run build --prefix (Join-Path $Mike "frontend")
}

Push-Location $OpenSign
try {
  $createdTempEnv = $false
  if (-not (Test-Path -LiteralPath ".env.prod") -and (Test-Path -LiteralPath ".env.prod.example")) {
    Copy-Item -LiteralPath ".env.prod.example" -Destination ".env.prod"
    $createdTempEnv = $true
  }
  docker compose config | Out-Null
  Write-Host "OpenSign Docker Compose config is valid."
} finally {
  if ($createdTempEnv -and (Test-Path -LiteralPath ".env.prod")) {
    Remove-Item -LiteralPath ".env.prod" -Force
  }
  Pop-Location
}

if ($Live) {
  $urls = @(
    "http://127.0.0.1:3051/health",
    "http://127.0.0.1:3001/health/integrations"
  )

  if ($env:SIGNTOROSS_LIVE_OPENSIGN_HEALTH_URL) {
    $urls += $env:SIGNTOROSS_LIVE_OPENSIGN_HEALTH_URL
  }

  foreach ($url in $urls) {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20
    Write-Host "$url -> $($response.StatusCode)"
  }
}

Write-Host "SignToROSS verification passed."
