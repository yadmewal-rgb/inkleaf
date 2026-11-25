@echo off
rem Run before every release: checks the code, the sync server and the app in a visible Chrome window.
cd /d "%~dp0"
if not exist node_modules call npm ci --ignore-scripts --no-audit --no-fund
if errorlevel 1 exit /b 1
node check.mjs %*
