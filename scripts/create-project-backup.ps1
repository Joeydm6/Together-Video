param(
    [string]$Label = "stable"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$safeLabel = ($Label -replace '[^a-zA-Z0-9._-]', '-').Trim('-')
if ([string]::IsNullOrWhiteSpace($safeLabel)) {
    $safeLabel = "snapshot"
}

$backupsDir = Join-Path $repoRoot "backups"
$stagingDir = Join-Path $backupsDir "_staging_$timestamp"
$archivePath = Join-Path $backupsDir "togethervideo-$timestamp-$safeLabel.zip"

$excludeDirectories = @(
    ".cache",
    ".cloudflared",
    ".cursor",
    "backups",
    "node_modules"
)

$excludeFilePatterns = @(
    "*.log",
    "tmp-*",
    "tunnel-output.txt"
)

function Test-IsExcludedFile {
    param(
        [string]$RelativePath,
        [string]$Name
    )

    foreach ($pattern in $excludeFilePatterns) {
        if ($Name -like $pattern -or $RelativePath -like $pattern) {
            return $true
        }
    }

    return $false
}

function Copy-ProjectTree {
    param(
        [string]$SourceRoot,
        [string]$DestinationRoot
    )

    $items = Get-ChildItem -LiteralPath $SourceRoot -Force
    foreach ($item in $items) {
        if ($item.FullName.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $relativePath = $item.FullName.Substring($repoRoot.Length).TrimStart('\')
        } else {
            $relativePath = $item.Name
        }
        if ($excludeDirectories -contains $item.Name) {
            continue
        }

        if ($item.PSIsContainer) {
            $targetDirectory = Join-Path $DestinationRoot $item.Name
            New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
            Copy-ProjectTree -SourceRoot $item.FullName -DestinationRoot $targetDirectory
            continue
        }

        if (Test-IsExcludedFile -RelativePath $relativePath -Name $item.Name) {
            continue
        }

        Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $DestinationRoot $item.Name) -Force
    }
}

New-Item -ItemType Directory -Path $backupsDir -Force | Out-Null
if (Test-Path $stagingDir) {
    Remove-Item $stagingDir -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null

Copy-ProjectTree -SourceRoot $repoRoot -DestinationRoot $stagingDir

if (Test-Path $archivePath) {
    Remove-Item $archivePath -Force
}

Compress-Archive -Path (Join-Path $stagingDir '*') -DestinationPath $archivePath -CompressionLevel Optimal
Remove-Item $stagingDir -Recurse -Force

Write-Output $archivePath
