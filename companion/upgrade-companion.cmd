@echo off
setlocal
set "PSModulePath="
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-or-upgrade.ps1" -PayloadRoot "%~dp0"
if errorlevel 1 pause
