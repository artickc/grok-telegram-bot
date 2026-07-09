# Security Policy

## The security model — read this first

This bot connects Telegram to **Grok CLI running on your machine**. Anyone who
can message the bot can make Grok **read/write files and run shell commands** on
the host with your user's permissions. Treat the bot token and host access as
highly sensitive.

### Required hardening

1. **Always set `ALLOWED_USERS`.** With it empty, *any* Telegram user who finds
   the bot can control your machine. Set it to your own numeric Telegram ID(s).
2. **Keep `.env` private.** It contains your bot token. It is git-ignored by
   default — never commit it.
3. **Understand `GROK_TRUST_ALL_TOOLS=true`.** This runs tools without
   confirmation. Set it to `false` if you want Grok to surface permission
   prompts; the bot then auto-declines unknown permission requests.
4. **Scope the workspace.** The bot operates in the project folders you select.
   Only point `PROJECT_ROOTS` at directories you are comfortable exposing.
5. **Run as a non-privileged user.** The provided services install as a *user*
   service (systemd `--user`, launchd LaunchAgent, Windows logon task) — never
   as root/SYSTEM/admin.

### What the bot does NOT do

- It does not transmit your code or secrets anywhere except to Telegram (your
  messages) and to Grok CLI (which talks to its own backend).
- It does not open any inbound network port.
- It does not commit, read, or log the contents of `.env` secrets.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, open a
private security advisory on the repository, or email the maintainer listed in
`package.json`. We aim to respond within 7 days.

## Supported versions

The latest released version on the default branch receives security fixes.
