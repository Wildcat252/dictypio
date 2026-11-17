@echo off
REM Dictypio - Windows installer launcher
REM Double-click this, or run from a terminal. Optional: Install.cmd -Run
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" %*
echo.
pause
