@echo off
rem Starts Inkleaf on this PC and opens it in the browser. Close this window to stop it.
start "" http://localhost:8080/
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
