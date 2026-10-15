# IRON ID Sovereign Mail - PowerShell Launcher
$baseDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host " [IRON ID] Launching Sovereign Mail Engine & Webmail" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan

# 1. Start IRON ID Core Engine
Write-Host "[1/2] Starting IRON ID Mail Engine (Port 8080)..." -ForegroundColor Yellow
$engineProcess = Start-Process -FilePath "$baseDir\engine\stalwart.exe" -ArgumentList "-c `"$baseDir\engine\config.json`"" -WorkingDirectory "$baseDir\engine" -PassThru -WindowStyle Minimized

Start-Sleep -Seconds 2

# 2. Start Webmail Server
Write-Host "[2/2] Starting Webmail Gateway (Port 3001)..." -ForegroundColor Yellow
$webmailProcess = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory "$baseDir\webmail" -PassThru

Start-Sleep -Seconds 1

# 3. Open Browser
Start-Process "http://localhost:3001"

Write-Host ""
Write-Host "===================================================" -ForegroundColor Green
Write-Host " Services are online!" -ForegroundColor Green
Write-Host " Webmail UI:     http://localhost:3001" -ForegroundColor Green
Write-Host " IRON ID Engine: http://127.0.0.1:8080/jmap" -ForegroundColor Green
Write-Host "===================================================" -ForegroundColor Green
