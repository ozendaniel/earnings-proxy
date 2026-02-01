Double-click launcher

Files:
- run_generate_docs.cmd  (double-click this one)
- run_generate_docs.ps1  (PowerShell script it runs)

What it does:
- Runs scripts/generate_earnings_docs.py using your ACTION_API_KEY environment variable
- Uses targets.csv at:
  C:\Users\ozend\Dropbox\O3 Industries\#Automated Transcript Summaries\targets.csv

If the targets path is different, edit run_generate_docs.ps1 and change $Targets.

If ACTION_API_KEY isn't set:
Run (PowerShell):
  [Environment]::SetEnvironmentVariable("ACTION_API_KEY", "<YOUR_KEY>", "User")
Then close and reopen PowerShell.
