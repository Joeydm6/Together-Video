Write-Host "Starting TogetherVideo server and Cloudflare tunnel..." -ForegroundColor Green
Write-Host ""

Write-Host "[1/2] Starting Node.js server..." -ForegroundColor Yellow
Start-Process cmd -ArgumentList "/c", "npm start" -WindowStyle Normal

Start-Sleep -Seconds 3

Write-Host "[2/2] Starting Cloudflare tunnel..." -ForegroundColor Yellow  
Start-Process powershell -ArgumentList "-ExecutionPolicy", "Bypass", "-File", "`"$PSScriptRoot\start-tunnel.ps1`"" -WindowStyle Normal

Write-Host ""
Write-Host "Both services are starting..." -ForegroundColor Green
Write-Host "Server: http://localhost:8000" -ForegroundColor Cyan
Write-Host "Public: https://video.toolstack.nl" -ForegroundColor Cyan
Write-Host ""
Write-Host "Services are running in separate windows. Close this window when done." -ForegroundColor Gray 
