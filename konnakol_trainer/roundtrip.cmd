@echo off
setlocal
set SCRIPT_DIR=%~dp0
node "%SCRIPT_DIR%dist\roundtrip.js" %*
exit /b %ERRORLEVEL%
