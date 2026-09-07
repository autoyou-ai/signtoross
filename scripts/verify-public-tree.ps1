$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot

$nestedGit = Get-ChildItem -LiteralPath $Root -Force -Recurse -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -eq ".git" -and $_.FullName -ne (Join-Path $Root ".git")
  }

if ($nestedGit) {
  $nestedGit | ForEach-Object { Write-Error "Nested Git metadata found: $($_.FullName)" }
  throw "Nested Git metadata must be removed before public initialization."
}

$ignored = "\\node_modules\\|\\.next\\|\\dist\\|\\.git\\|\\.local\\|\\apps\\mike\\backend\\.env$|\\apps\\mike\\frontend\\.env.local$|\\services\\opensign\\.env$|\\services\\opensign\\.env.prod$|\\services\\opensign\\.admin-credentials.txt$"
$machineHits = @()
$slash = [regex]::Escape([string][char]92)
$windowsUserPathPattern = "C:${slash}Users${slash}[A-Za-z0-9._-]+"
$posixUserPathPattern = "Users/[A-Za-z0-9._-]+"
$cloudDrivePattern = "One" + "Drive"

Get-ChildItem -LiteralPath $Root -Recurse -File -Force |
  Where-Object { $_.FullName -notmatch $ignored } |
  ForEach-Object {
    $file = $_.FullName
    $lineNo = 0
    Get-Content -LiteralPath $file -ErrorAction SilentlyContinue | ForEach-Object {
      $lineNo++
      if ($_ -match $windowsUserPathPattern -or $_ -match $posixUserPathPattern -or $_ -match $cloudDrivePattern) {
        $machineHits += [pscustomobject]@{ File = $file; Line = $lineNo; Rule = "machine_path" }
      }
    }
  }

if ($machineHits.Count -gt 0) {
  $machineHits | Sort-Object File,Line | ForEach-Object {
    Write-Error "$($_.File):$($_.Line):$($_.Rule)"
  }
  throw "Machine-local path references found in public tree."
}

$forbiddenPatterns = @(
  @{ Name = "private_public_host"; Pattern = "sign" + "\.autoyou\.me" },
  @{ Name = "private_runtime_launcher"; Pattern = "run_" + "autoyou\.bat" },
  @{ Name = "private_server_name"; Pattern = "AutoYou" + "-Server" },
  @{ Name = "provider_specific_credential_reference"; Pattern = "(Cloudflare" + " token|IO" + "NOS credential)" },
  @{ Name = "provider_dns_runbook"; Pattern = "(Cloudflare" + " DNS|Cloudflare" + " A record|DNS" + "-over-HTTPS)" }
)

$forbiddenHits = @()

Get-ChildItem -LiteralPath $Root -Recurse -File -Force |
  Where-Object { $_.FullName -notmatch $ignored } |
  ForEach-Object {
    $file = $_.FullName
    $lineNo = 0
    Get-Content -LiteralPath $file -ErrorAction SilentlyContinue | ForEach-Object {
      $lineNo++
      foreach ($rule in $forbiddenPatterns) {
        if ($_ -match $rule.Pattern) {
          $forbiddenHits += [pscustomobject]@{ File = $file; Line = $lineNo; Rule = $rule.Name }
        }
      }
    }
  }

if ($forbiddenHits.Count -gt 0) {
  $forbiddenHits | Sort-Object File,Line,Rule | ForEach-Object {
    Write-Error "$($_.File):$($_.Line):$($_.Rule)"
  }
  throw "Private deployment references found in public tree."
}

$patterns = @(
  @{ Name = "openai_key"; Pattern = "sk-[A-Za-z0-9_-]{20,}" },
  @{ Name = "google_api_key"; Pattern = "AIza[0-9A-Za-z_-]{20,}" },
  @{ Name = "github_token"; Pattern = "gh[pousr]_[A-Za-z0-9_]{20,}" },
  @{ Name = "aws_access_key"; Pattern = "AKIA[0-9A-Z]{16}" },
  @{ Name = "jwt"; Pattern = "eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+" },
  @{ Name = "private_key_block"; Pattern = "-----BEGIN [A-Z ]*PRIVATE KEY-----" }
)

$hits = @()

Get-ChildItem -LiteralPath $Root -Recurse -File -Force |
  Where-Object { $_.FullName -notmatch $ignored } |
  ForEach-Object {
    $file = $_.FullName
    $lineNo = 0
    Get-Content -LiteralPath $file -ErrorAction SilentlyContinue | ForEach-Object {
      $lineNo++
      foreach ($rule in $patterns) {
        if ($_ -match $rule.Pattern) {
          $hits += [pscustomobject]@{ File = $file; Line = $lineNo; Rule = $rule.Name }
        }
      }
    }
  }

if ($hits.Count -gt 0) {
  $hits | Sort-Object File,Line,Rule | ForEach-Object {
    Write-Error "$($_.File):$($_.Line):$($_.Rule)"
  }
  throw "High-risk token-shaped values found in public tree."
}

Write-Host "Public tree check passed."

# Licence coherence. Every part of this tree is AGPL-3.0; a file claiming
# different terms for the repository would misstate them to anyone who forks it.
$rootLicense = Join-Path $Root "LICENSE"
if (-not (Test-Path -LiteralPath $rootLicense)) {
  throw "Root LICENSE is missing."
}
if (-not (Select-String -LiteralPath $rootLicense -Pattern "GNU AFFERO GENERAL PUBLIC LICENSE" -Quiet)) {
  throw "Root LICENSE is not the AGPL-3.0 text. apps/mike is AGPL-3.0-only and the tree must not claim weaker terms."
}

# Internal names and private-tree references must not reach the public repo.
$internalPatterns = @(
  "autoyou-brain",
  "autoyou-support",
  "ip-transfer-execution",
  "consolidation_manifest"
)
# This script names the forbidden strings in order to search for them, so it
# must exclude itself or it always reports a hit on its own pattern list.
$selfPath = $MyInvocation.MyCommand.Path
foreach ($pattern in $internalPatterns) {
  $hits = Get-ChildItem -LiteralPath $Root -Recurse -File -Force |
    Where-Object { $_.FullName -notmatch $ignored -and $_.FullName -ne $selfPath } |
    Select-String -Pattern $pattern -List -ErrorAction SilentlyContinue
  if ($hits) {
    $hits | ForEach-Object { Write-Error "Internal reference '$pattern' in $($_.Path)" }
    throw "Internal references must be removed before publishing."
  }
}
