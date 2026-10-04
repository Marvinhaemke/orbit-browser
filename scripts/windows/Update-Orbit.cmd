@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-Orbit.ps1" %*
set "ORBIT_UPDATE_RESULT=%ERRORLEVEL%"
if not "%ORBIT_UPDATE_RESULT%"=="0" pause
exit /b %ORBIT_UPDATE_RESULT%
