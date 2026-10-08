@echo off
setlocal
set "PSModulePath="
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-companion.ps1"
if errorlevel 1 pause
