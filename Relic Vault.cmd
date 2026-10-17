@echo off
rem Double-click to start Relic Vault. Close this window to stop it.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required: https://nodejs.org & pause & exit /b 1)
node server.mjs %*
pause
