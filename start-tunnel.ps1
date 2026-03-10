$localEnvPath = Join-Path $PSScriptRoot '.env.local'
$logDir = Join-Path $PSScriptRoot '.cache\logs'
$stdoutLog = Join-Path $logDir 'tunnel.out.log'
$stderrLog = Join-Path $logDir 'tunnel.err.log'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Test-Path $localEnvPath)) {
    Write-Error ".env.local not found. Create it with CLOUDFLARE_TUNNEL_TOKEN=..."
    exit 1
}

$tokenLine = Get-Content $localEnvPath |
    Where-Object { $_ -match '^CLOUDFLARE_TUNNEL_TOKEN=' } |
    Select-Object -First 1

if (-not $tokenLine) {
    Write-Error "CLOUDFLARE_TUNNEL_TOKEN was not found in .env.local"
    exit 1
}

$token = $tokenLine.Substring('CLOUDFLARE_TUNNEL_TOKEN='.Length).Trim()

if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Error "CLOUDFLARE_TUNNEL_TOKEN in .env.local is empty"
    exit 1
}

if (Get-Service -Name 'Cloudflared' -ErrorAction SilentlyContinue) {
    Write-Host "Cloudflared Windows service is installed. Tunnel should run as a service." -ForegroundColor Yellow
    exit 0
}

$existing = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" |
    Where-Object { $_.CommandLine -like "*tunnel*" }

if ($existing) {
    Write-Host "Cloudflare tunnel is already running." -ForegroundColor Yellow
    exit 0
}

$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) {
    Write-Error "cloudflared.exe was not found in PATH"
    exit 1
}

Write-Host "Starting Cloudflare tunnel in background..." -ForegroundColor Green
Start-Process -FilePath $cloudflared `
    -ArgumentList 'tunnel', 'run', '--token', $token `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog
