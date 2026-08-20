@echo off
cd /d "%~dp0"
echo.
echo  ==========================================
echo     DreamSync Production Archive - V3
echo  ==========================================
echo.
start "" http://localhost:3000
node server.js
