param([string]$Config = 'config.toml')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath $Config)) { Copy-Item -LiteralPath 'config.example.toml' -Destination $Config }
& '.venv/Scripts/python.exe' '-m' 'my5tb.cli' '--config' $Config 'gui'
