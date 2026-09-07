$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Mike = Join-Path $Root "apps\mike"

npm ci --prefix (Join-Path $Mike "backend")
npm ci --prefix (Join-Path $Mike "frontend")
