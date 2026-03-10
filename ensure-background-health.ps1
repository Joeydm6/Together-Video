$projectRoot = $PSScriptRoot
$logDir = Join-Path $projectRoot '.cache\logs'
$startupLog = Join-Path $logDir 'startup.log'
$mutexName = 'Local\TogetherVideoBackgroundHealthCheck'
$serverLauncher = Join-Path $projectRoot 'run-server-hidden.vbs'
$tunnelLauncher = Join-Path $projectRoot 'run-tunnel-hidden.vbs'
$targetUrl = 'http://127.0.0.1:8000'
$initialDelaySeconds = 12
$checkIntervalSeconds = 15
$maxChecks = 8

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-StartupLog {
    param([string]$Message)

    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $startupLog -Value "[$timestamp] $Message"
}

function Test-ServerReady {
    try {
        $response = Invoke-WebRequest -Uri $targetUrl -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    } catch {
        return $false
    }
}

function Start-ServerLauncher {
    if (-not (Test-Path $serverLauncher)) {
        Write-StartupLog "Healthcheck could not find server launcher: $serverLauncher"
        return $false
    }

    Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$serverLauncher`"" -WindowStyle Hidden
    Write-StartupLog 'Healthcheck triggered hidden server launcher.'
    return $true
}

function Start-TunnelLauncher {
    if (-not (Test-Path $tunnelLauncher)) {
        Write-StartupLog "Healthcheck skipped tunnel launcher because it is missing: $tunnelLauncher"
        return
    }

    Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$tunnelLauncher`"" -WindowStyle Hidden
    Write-StartupLog 'Healthcheck triggered hidden tunnel launcher.'
}

try {
    $healthMutex = [System.Threading.Mutex]::new($false, $mutexName)
    $hasHandle = $healthMutex.WaitOne(0, $false)
} catch {
    $healthMutex = $null
    $hasHandle = $true
}

if (-not $hasHandle) {
    Write-StartupLog 'Background healthcheck already running. Exiting duplicate trigger.'
    exit 0
}

try {
    Write-StartupLog 'Background healthcheck scheduled.'
    Start-Sleep -Seconds $initialDelaySeconds

    for ($attempt = 1; $attempt -le $maxChecks; $attempt += 1) {
        if (Test-ServerReady) {
            Write-StartupLog "Healthcheck confirmed server availability on attempt $attempt."
            Start-TunnelLauncher
            exit 0
        }

        Write-StartupLog "Healthcheck detected server unavailable on attempt $attempt. Restarting launcher."
        if (-not (Start-ServerLauncher)) {
            exit 1
        }

        $recovered = $false
        for ($waitAttempt = 0; $waitAttempt -lt 12; $waitAttempt += 1) {
            Start-Sleep -Seconds 1
            if (Test-ServerReady) {
                $recovered = $true
                break
            }
        }

        if ($recovered) {
            Write-StartupLog "Healthcheck restored server availability on attempt $attempt."
            Start-TunnelLauncher
            exit 0
        }

        Start-Sleep -Seconds $checkIntervalSeconds
    }

    Write-StartupLog 'Background healthcheck finished without restoring the server.'
    exit 1
} finally {
    if ($healthMutex -and $hasHandle) {
        $healthMutex.ReleaseMutex() | Out-Null
        $healthMutex.Dispose()
    }
}
