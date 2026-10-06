@echo off
title TORRE - KU Stand
cd /d "%~dp0"

if exist "C:\Program Files\nodejs\node.exe" goto :run_direct

where node >nul 2>nul
if errorlevel 1 goto :notfound

start "" http://localhost:3000
node server\index.js
pause
exit /b

:run_direct
start "" http://localhost:3000
"C:\Program Files\nodejs\node.exe" server\index.js
pause
exit /b

:notfound
echo.
echo   Node.js not found on this computer.
echo   Download and install it from https://nodejs.org  (green LTS button),
echo   then run this file again.
echo.
pause
exit /b
