@echo off
title IRON ID Sovereign Mail Launcher
echo ===================================================
echo [IRON ID] Launching Sovereign Mail Engine ^& Webmail
echo ===================================================

set BASE_DIR=%~dp0

echo [1/2] Starting IRON ID Mail Engine on port 8080...
cd /d "%BASE_DIR%engine"
start "IRON ID Mail Engine" /min stalwart.exe -c config.json

timeout /t 2 /nobreak >nul

echo [2/2] Starting Webmail Client on port 3001...
cd /d "%BASE_DIR%webmail"
start "IRON ID Webmail Gateway" node server.js

timeout /t 1 /nobreak >nul

echo Opening browser at http://localhost:3001 ...
start http://localhost:3001

echo.
echo ===================================================
echo  Both services are running!
echo  Webmail UI: http://localhost:3001
echo  IRON ID JMAP: http://127.0.0.1:8080/jmap
echo ===================================================
echo Press any key to exit this launcher window (services keep running).
pause >nul
