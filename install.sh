#!/usr/bin/env bash
# ============================================================
#  Grok Telegram Bot — 1-click installer (Linux / macOS)
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

echo "============================================"
echo "  Grok Telegram Bot - installer"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[X] Node.js 20+ is required. Get it from https://nodejs.org"
  exit 1
fi

echo "[1/4] Installing dependencies..."
npm install

echo
echo "[2/4] Detecting grok and writing .env..."
node scripts/setup.mjs

echo
if grep -Eq '^TELEGRAM_BOT_TOKEN=.+' .env; then
  echo "[3/4] Token already configured."
else
  echo "[3/4] Telegram setup"
  read -rp "    Paste your bot token from @BotFather: " TOKEN
  read -rp "    Your Telegram user ID (from @userinfobot): " TG_UID
  node scripts/setup.mjs "$TOKEN" "$TG_UID"
fi

echo
echo "[4/4] Background service (starts automatically on boot)"
read -rp "    Install as a background service now? [y/N] " SVC
if [[ "${SVC:-}" =~ ^[Yy]$ ]]; then
  npm run install:service
  echo
  echo "Done. Manage it with:  npm run service -- status | stop | restart | logs"
else
  echo
  echo "Done. Start the bot with:  npm start"
fi
