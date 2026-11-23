@echo off
rem DocsMasked Relay - per-user uninstaller wrapper (Windows PowerShell 5.1).
rem Removes the extension files and Start Menu shortcuts only.
rem
rem The uninstaller deletes the folder that contains this .cmd file. cmd.exe
rem reads batch files line by line, so the original wrapper copies itself to
rem %TEMP% and hands control to that copy. The copy is not inside the folder
rem being deleted, so cmd.exe can finish cleanly.
setlocal EnableExtensions
chcp 65001 >nul 2>&1

if defined DMRELAY_UNINSTALL_CHILD if defined DMRELAY_ROOT goto run_from_temp

set "DMRELAY_UNINSTALL_CHILD=1"
set "DMRELAY_ROOT=%~dp0"
set "DMRELAY_TEMP_CMD=%TEMP%\DocsMaskedRelay-uninstall.cmd"
copy /y "%~f0" "%DMRELAY_TEMP_CMD%" >nul
if errorlevel 1 (
    echo Could not create a temporary copy of uninstall.cmd in %TEMP%.
    if not "%DMRELAY_NO_PAUSE%"=="1" pause
    exit /b 1
)
cd /d "%TEMP%" >nul 2>&1

rem No CALL: the temporary copy replaces this batch context, so cmd.exe never
rem reads this file again after the install root has been deleted.
"%DMRELAY_TEMP_CMD%" %*

exit /b 1

:run_from_temp
cd /d "%TEMP%" >nul 2>&1
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%DMRELAY_ROOT%uninstall.ps1" %*
set "DMRELAY_RC=%ERRORLEVEL%"

if not "%DMRELAY_RC%"=="0" (
    echo.
    echo DocsMasked Relay uninstall failed. Exit code: %DMRELAY_RC%
    echo Read the error above for details.
    if not "%DMRELAY_NO_PAUSE%"=="1" pause
)

exit /b %DMRELAY_RC%
