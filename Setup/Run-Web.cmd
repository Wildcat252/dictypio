@echo off
REM Dictypio - run the web app
REM Double-click this, or run from a terminal.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Run-Web.ps1" %*
echo.
pause
