@echo off
rem DocsMasked Relay - per-user installer wrapper (Windows PowerShell 5.1).
rem No admin rights, no network access.
setlocal EnableExtensions
chcp 65001 >nul 2>&1

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "DMRELAY_RC=%ERRORLEVEL%"

if not "%DMRELAY_RC%"=="0" (
    echo.
    echo DocsMasked Relay installation failed. Exit code: %DMRELAY_RC%
    echo Read the error above for details.
    if not "%DMRELAY_NO_PAUSE%"=="1" pause
)

exit /b %DMRELAY_RC%
