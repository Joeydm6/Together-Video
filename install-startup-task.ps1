$taskName = 'TogetherVideo Background Startup'
$projectRoot = $PSScriptRoot
$startupLauncher = Join-Path $projectRoot 'run-background-hidden.vbs'
$startupFolder = [Environment]::GetFolderPath('Startup')
$startupShortcut = Join-Path $startupFolder 'TogetherVideo Background Startup.vbs'
$runKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValueName = 'TogetherVideoBackgroundStartup'

if (-not (Test-Path $startupLauncher)) {
    Write-Error "Missing $startupLauncher"
    exit 1
}

$action = New-ScheduledTaskAction `
    -Execute 'wscript.exe' `
    -Argument "`"$startupLauncher`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

try {
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -User $env:USERNAME `
        -Description 'Starts TogetherVideo server and tunnel in the background when Windows logs in.' `
        -Force `
        -ErrorAction Stop | Out-Null

    Write-Host "Scheduled task installed: $taskName" -ForegroundColor Green
} catch {
    try {
        $taskTarget = "wscript.exe `"$startupLauncher`""
        & schtasks.exe /Create /TN $taskName /SC ONLOGON /TR $taskTarget /F | Out-Null

        if ($LASTEXITCODE -eq 0) {
            Write-Warning "PowerShell ScheduledTasks API failed, but schtasks.exe succeeded."
            Write-Host "Scheduled task installed: $taskName" -ForegroundColor Green
        }
    } catch {
        # Fall through to alternate startup mechanisms.
    }
}

$runValue = "wscript.exe `"$startupLauncher`""
New-Item -Path $runKeyPath -Force | Out-Null
Set-ItemProperty -Path $runKeyPath -Name $runValueName -Value $runValue -Force
Copy-Item -Path $startupLauncher -Destination $startupShortcut -Force

Write-Host "Registry startup entry installed: $runValueName" -ForegroundColor Green
Write-Host "Startup folder fallback installed: $startupShortcut" -ForegroundColor Green
