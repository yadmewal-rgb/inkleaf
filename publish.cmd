@echo off
rem Uploads the current version of Inkleaf to GitHub. The first run opens a GitHub sign-in window.
cd /d "%~dp0"
"C:\Program Files\Git\cmd\git.exe" push -u origin main
if errorlevel 1 (
  echo.
  echo Upload failed. Copy the text above and send it to Claude.
) else (
  echo.
  echo Upload finished. You can close this window.
)
pause
