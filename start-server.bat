@echo off
title ThisCord Server
color 0A

:: Start bore tunnel in a separate window
start "Bore Tunnel" /min "C:\Users\elias\Downloads\bore-v0.5.3-x86_64-pc-windows-msvc\bore.exe" local 3001 --to bore.pub --port 53400

:: Small delay
timeout /t 2 /nobreak >nul

:: Start server with live dashboard
node "%~dp0server.js"

pause
