@echo off
title ThisCord Server
echo.
echo  ==========================================
echo   ThisCord Server + Bore Tunnel
echo  ==========================================
echo.

:: Start bore tunnel in a new window
start "Bore Tunnel" "C:\Users\elias\Downloads\bore-v0.5.3-x86_64-pc-windows-msvc\bore.exe" local 3001 --to bore.pub --port 53400

:: Small delay so bore starts first
timeout /t 2 /nobreak >nul

:: Start the WebSocket server
echo  Starting WebSocket server...
node server.js

pause
