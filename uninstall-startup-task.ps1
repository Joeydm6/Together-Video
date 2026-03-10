$taskName = 'TogetherVideo Background Startup'
$startupFolder = [Environment]::GetFolderPath('Startup')
$startupShortcut = Join-Path $startupFolder 'TogetherVideo Background Startup.vbs'
$runKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValueName = 'TogetherVideoBackgroundStartup'

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Scheduled task removed: $taskName" -ForegroundColor Green
} else {
    Write-Host "Scheduled task not found: $taskName" -ForegroundColor Yellow
}

if (Get-ItemProperty -Path $runKeyPath -Name $runValueName -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path $runKeyPath -Name $runValueName -Force
    Write-Host "Registry startup entry removed: $runValueName" -ForegroundColor Green
} else {
    Write-Host "Registry startup entry not found: $runValueName" -ForegroundColor Yellow
}

if (Test-Path $startupShortcut) {
    Remove-Item $startupShortcut -Force
    Write-Host "Startup shortcut removed: $startupShortcut" -ForegroundColor Green
} else {
    Write-Host "Startup shortcut not found: $startupShortcut" -ForegroundColor Yellow
}
