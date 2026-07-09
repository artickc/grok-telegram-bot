@echo off
REM ============================================================
REM  Grok Telegram Bot — 1-click installer (Windows)
REM ============================================================
setlocal
cd /d "%~dp0"

echo ============================================
echo   Grok Telegram Bot - installer
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js 20+ is required. Get it from https://nodejs.org
  pause
  exit /b 1
)

echo [1/4] Installing dependencies...
call npm install
if errorlevel 1 ( echo [X] npm install failed & pause & exit /b 1 )

echo.
echo [2/4] Detecting grok and writing .env...
call node scripts\setup.mjs

echo.
node -e "process.exit(/^TELEGRAM_BOT_TOKEN=.+/m.test(require('fs').readFileSync('.env','utf8'))?0:1)" 2>nul
if not errorlevel 1 goto :have_token

echo [3/4] Telegram setup
set /p TOKEN="    Paste your bot token from @BotFather: "
set /p UID="    Your Telegram user ID (from @userinfobot): "
call node scripts\setup.mjs "%TOKEN%" "%UID%"
goto :service

:have_token
echo [3/4] Token already configured.

:service
echo.
echo [4/4] Background service (starts automatically at logon)
set /p SVC="    Install as a background service now? [y/N] "
if /i "%SVC%"=="y" (
  call npm run install:service
  echo.
  echo Done. Manage it with:  npm run service -- status ^| stop ^| restart ^| logs
) else (
  echo.
  echo Done. Start the bot with:  start.cmd   ^(or: npm start^)
)
echo.
pause
