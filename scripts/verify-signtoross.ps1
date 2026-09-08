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
  if ($LASTEXITCODE -ne 0) { throw "Mike backend build failed." }
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
  if ($LASTEXITCODE -ne 0) { throw "Mike frontend build failed." }
}

$tempRoot = if ($env:AUTOYOU_TEST_ROOT) { [IO.Path]::GetFullPath($env:AUTOYOU_TEST_ROOT) } else { [IO.Path]::GetTempPath() }
$fixture = Join-Path $tempRoot ("signtoross-verify-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
$fixtureEnv = Join-Path $fixture ".env.prod"
$previousHost = $env:HOST_URL
try {
  Copy-Item -LiteralPath (Join-Path $OpenSign ".env.prod.example") -Destination $fixtureEnv
  $caddy = Get-Content -LiteralPath (Join-Path $OpenSign "Caddyfile") -Raw
  if ($caddy -notmatch 'handle_path\s+/api/\*' -or $caddy -notmatch 'reverse_proxy\s+server:8080') {
    throw "Caddy must strip /api and forward requests to OpenSign on port 8080."
  }
  foreach ($hostUrl in @("http://127.0.0.1:3051", "https://sign.example.test")) {
    $env:HOST_URL = $hostUrl
    $rendered = docker compose --project-directory $fixture --env-file (Join-Path $OpenSign ".env.example") -f (Join-Path $OpenSign "docker-compose.yml") config --format json
    if ($LASTEXITCODE -ne 0) { throw "OpenSign Docker Compose config failed." }
    $config = $rendered | ConvertFrom-Json
    $server = $config.services.server.environment
    $client = $config.services.client.environment
    if ($server.PARSE_MOUNT -ne "/app" -or
        $server.SERVER_URL -ne "$hostUrl/api/app" -or
        $client.REACT_APP_SERVERURL -ne "$hostUrl/api/app" -or
        $server.PUBLIC_URL -ne $hostUrl -or $client.PUBLIC_URL -ne $hostUrl -or
        $client.REACT_APP_APPID -ne $server.APP_ID) {
      throw "OpenSign server and client API configuration does not match the Caddy route."
    }
    Write-Host "OpenSign example configuration is valid for $hostUrl."
  }
} finally {
  $env:HOST_URL = $previousHost
  if (Test-Path -LiteralPath $fixtureEnv) {
    Remove-Item -LiteralPath $fixtureEnv -Force
  }
  Remove-Item -LiteralPath $fixture -Force
}

if ($Live) {
  $urls = @(
    "http://127.0.0.1:3051/api/app/health",
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
