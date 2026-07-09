@echo off
REM Easy launcher for the Grok Telegram Bot (Windows).
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
if not exist .env (
  echo No .env found - running setup...
  call npm run setup
  echo Edit .env to add your TELEGRAM_BOT_TOKEN, then run start.cmd again.
  pause
  exit /b 1
)
call npm start
pause
