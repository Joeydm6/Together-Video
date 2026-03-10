param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,

    [switch]$CreateSafetyBackup = $true
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedArchive = Resolve-Path $ArchivePath
if (-not $resolvedArchive) {
    throw "Archive not found: $ArchivePath"
}

$archiveFullPath = $resolvedArchive.Path
if (-not (Test-Path $archiveFullPath)) {
    throw "Archive not found: $archiveFullPath"
}

$backupsDir = Join-Path $repoRoot "backups"
$restoreTemp = Join-Path $backupsDir "_restore_temp"
$restoreSafetyDir = Join-Path $backupsDir "pre-restore"
$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"

$preservePaths = @(
    "backups",
    "node_modules",
    ".cache",
    ".cloudflared"
)

function Remove-ProjectContent {
    param([string]$Root)

    Get-ChildItem -LiteralPath $Root -Force | ForEach-Object {
        if ($preservePaths -contains $_.Name) {
            return
        }
        Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
}

New-Item -ItemType Directory -Path $backupsDir -Force | Out-Null

if ($CreateSafetyBackup) {
    New-Item -ItemType Directory -Path $restoreSafetyDir -Force | Out-Null
    $safetyArchive = Join-Path $restoreSafetyDir "pre-restore-$timestamp.zip"
    powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "create-project-backup.ps1") -Label "pre-restore-$timestamp" | Out-Null
}

if (Test-Path $restoreTemp) {
    Remove-Item $restoreTemp -Recurse -Force
}
New-Item -ItemType Directory -Path $restoreTemp -Force | Out-Null

Expand-Archive -LiteralPath $archiveFullPath -DestinationPath $restoreTemp -Force
Remove-ProjectContent -Root $repoRoot

Get-ChildItem -LiteralPath $restoreTemp -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $repoRoot -Recurse -Force
}

Remove-Item $restoreTemp -Recurse -Force

Write-Output "Restored from $archiveFullPath"
