$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$OpenSign = Join-Path $Root "services\opensign"

if (-not (Test-Path -LiteralPath (Join-Path $OpenSign ".env.prod"))) {
  throw "Missing services\opensign\.env.prod. Copy .env.prod.example and fill local secrets first."
}

Push-Location $OpenSign
try {
  docker compose up -d
} finally {
  Pop-Location
}
