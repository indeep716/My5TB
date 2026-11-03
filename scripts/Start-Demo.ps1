$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) { throw 'Run scripts/Setup.ps1 first.' }
if (-not (Test-Path -LiteralPath 'dist/index.html')) { npm run build; if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' } }
& '.venv/Scripts/python.exe' 'scripts/demo.py' '--port' '8787'
