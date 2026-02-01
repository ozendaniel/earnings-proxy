# Double-click launcher for generating earnings summary docs
# Uses ACTION_API_KEY from your User env vars.

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

$Targets = "C:\Users\ozend\Dropbox\O3 Industries\#Automated Transcript Summaries\targets.csv"

if (-not (Test-Path $Targets)) {
  Write-Host "Targets file not found:" -ForegroundColor Red
  Write-Host "  $Targets" -ForegroundColor Red
  Write-Host "Edit run_generate_docs.ps1 to point to your targets.csv." -ForegroundColor Yellow
  Read-Host "Press Enter to exit"
  exit 1
}

if (-not $env:ACTION_API_KEY) {
  Write-Host "ACTION_API_KEY environment variable is not set." -ForegroundColor Red
  Write-Host "Set it once (User scope) with:" -ForegroundColor Yellow
  Write-Host "  [Environment]::SetEnvironmentVariable(\"ACTION_API_KEY\", \"<YOUR_KEY>\", \"User\")" -ForegroundColor Yellow
  Write-Host "Then close and reopen PowerShell." -ForegroundColor Yellow
  Read-Host "Press Enter to exit"
  exit 1
}

# Optional: ensure deps are installed (comment out if you prefer)
# python -m pip install -r .\scripts\requirements-generate-earnings-docs.txt

Write-Host "Running doc generator..." -ForegroundColor Cyan

python .\scripts\generate_earnings_docs.py --targets "$Targets" --action-key-env ACTION_API_KEY

Write-Host "Done." -ForegroundColor Green
Read-Host "Press Enter to close"
