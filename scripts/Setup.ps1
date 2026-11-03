$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath '.venv')) { python -m venv .venv; if ($LASTEXITCODE -ne 0) { throw 'Python venv creation failed.' } }
& '.venv/Scripts/python.exe' '-m' 'pip' 'install' '-r' 'requirements.lock.txt'
if ($LASTEXITCODE -ne 0) { throw 'Python dependency install failed.' }
& '.venv/Scripts/python.exe' '-m' 'pip' 'install' '-e' '.'
if ($LASTEXITCODE -ne 0) { throw 'Python package install failed.' }
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Node dependency install failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
if (-not (Test-Path -LiteralPath 'config.toml')) { Copy-Item -LiteralPath 'config.example.toml' -Destination 'config.toml' }
Write-Host 'Ready. Run scripts/Start-Demo.ps1 or scripts/Start-Desktop.ps1.'
