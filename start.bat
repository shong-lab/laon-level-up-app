@echo off
title LAON Level Up Server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo.
echo  ============================================
echo   LAON Level Up Challenge
echo  ============================================
echo.
echo  Starting server...
echo  Local: http://localhost:3000
echo.
echo  Close this window to stop the server.
echo.

if /I "%~1"=="nobrowser" goto runserver
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000'"

:runserver
node local-server.js

echo.
echo Server stopped.
pause
exit /b 0

:nonode
echo.
echo  Node.js is not installed.
echo  Install Node.js from https://nodejs.org and try again.
echo.
pause
exit /b 1
