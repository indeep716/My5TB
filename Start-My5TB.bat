@echo off
setlocal
cd /d "%~dp0"
title My5TB
if not exist ".venv\Scripts\python.exe" (
    echo My5TB environment is missing. Run scripts\Setup.ps1 first.
    pause
    exit /b 1
)
if not exist "data\drive-setup\cloud.toml" (
    echo Cloud configuration is missing: data\drive-setup\cloud.toml
    pause
    exit /b 1
)
".venv\Scripts\python.exe" -m my5tb.cli --config "data\drive-setup\cloud.toml" gui
if errorlevel 1 (
    echo.
    echo My5TB could not start. See the error above.
    pause
    exit /b 1
)
endlocal
