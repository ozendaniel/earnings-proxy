@echo off
setlocal
cd /d "%~dp0"

REM Double-click this file to run the generator.
REM Uses PowerShell with ExecutionPolicy Bypass for this run only.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_generate_docs.ps1"
