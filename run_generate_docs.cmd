@echo off
setlocal
cd /d "%~dp0"

REM Double-click this file to run the generator.
REM Passes -Pause so the window stays open at the end.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_generate_docs.ps1" -Pause
