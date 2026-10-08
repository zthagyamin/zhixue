$ErrorActionPreference = "Stop"
$companionRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$protocolRoot = "HKCU:\Software\Classes\zhixue-companion"
$commandKey = Join-Path $protocolRoot "shell\open\command"
$launcher = Join-Path $companionRoot "start-companion.ps1"
$powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'

New-Item -Path $commandKey -Force | Out-Null
Set-Item -Path $protocolRoot -Value "URL:Zhixue Companion Protocol"
New-ItemProperty -Path $protocolRoot -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
Set-Item -Path $commandKey -Value ('"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}" "%1"' -f $powershell, $launcher)

Write-Host "Zhixue Companion browser launch protocol registered."
