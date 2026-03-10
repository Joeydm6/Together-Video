$projectRoot = $PSScriptRoot
$serverLogDir = Join-Path $projectRoot '.cache\logs'
$stdoutLog = Join-Path $serverLogDir 'server.out.log'
$stderrLog = Join-Path $serverLogDir 'server.err.log'
$port = 8000

New-Item -ItemType Directory -Force -Path $serverLogDir | Out-Null

$existing = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*server.js*" -and $_.CommandLine -like "*TogetherVideo*" }

if ($existing) {
    Write-Host "TogetherVideo server is already running." -ForegroundColor Yellow
    exit 0
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    Write-Error "Port $port is already in use by process ID $($listener.OwningProcess)."
    exit 1
}

Start-Process -FilePath 'node' `
    -ArgumentList 'server.js' `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog

Write-Host "TogetherVideo server started in background." -ForegroundColor Green
