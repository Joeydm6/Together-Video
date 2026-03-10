$projectRoot = $PSScriptRoot
$logDir = Join-Path $projectRoot '.cache\logs'
$startupLog = Join-Path $logDir 'startup.log'
$mutexName = 'Local\TogetherVideoBackgroundBootstrap'
$healthCheckScript = Join-Path $projectRoot 'ensure-background-health.ps1'

try {
    $startupMutex = [System.Threading.Mutex]::new($false, $mutexName)
    $hasHandle = $startupMutex.WaitOne(0, $false)
} catch {
    $startupMutex = $null
    $hasHandle = $true
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-StartupLog {
    param([string]$Message)

    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $startupLog -Value "[$timestamp] $Message"
}

if (-not $hasHandle) {
    Write-StartupLog "Background bootstrap already running. Exiting duplicate trigger."
    exit 0
}

Write-StartupLog "Starting TogetherVideo background bootstrap."

if (Test-Path $healthCheckScript) {
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$healthCheckScript`"" `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden
    Write-StartupLog "Triggered hidden background healthcheck."
}

$serverLauncher = Join-Path $projectRoot 'run-server-hidden.vbs'
$tunnelLauncher = Join-Path $projectRoot 'run-tunnel-hidden.vbs'

if (-not (Test-Path $serverLauncher)) {
    Write-StartupLog "Missing launcher: $serverLauncher"
    exit 1
}

if (-not (Test-Path $tunnelLauncher)) {
    Write-StartupLog "Missing tunnel launcher: $tunnelLauncher. Server bootstrap will continue without tunnel."
    $tunnelLauncher = $null
}

Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$serverLauncher`"" -WindowStyle Hidden
Write-StartupLog "Triggered hidden server launcher."

$serverReady = $false
for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Seconds 1
    try {
        $response = Invoke-WebRequest -Uri 'http://localhost:8000' -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
            $serverReady = $true
            break
        }
    } catch {
        # Keep waiting until the server responds or timeout expires.
    }
}

if (-not $serverReady) {
    Write-StartupLog "Server did not become ready within the wait window. Tunnel launch skipped."
    exit 1
}

Write-StartupLog "Server responded on http://localhost:8000."
if ($tunnelLauncher) {
    Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$tunnelLauncher`"" -WindowStyle Hidden
    Write-StartupLog "Triggered hidden tunnel launcher."
}

if ($startupMutex -and $hasHandle) {
    $startupMutex.ReleaseMutex() | Out-Null
    $startupMutex.Dispose()
}
