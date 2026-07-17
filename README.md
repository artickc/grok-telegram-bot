# Grok Telegram Bot 🤖

> **Control [Grok CLI](https://grok.dev/cli/) from Telegram.** Your AI coding
> assistant in your pocket — switch projects, resume and attach to live coding
> sessions, stream answers with diffs, queue follow-ups, and run it 24/7 as a
> background service on Windows, Linux, and macOS.

![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20Linux%20%7C%20macOS-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Powered by](https://img.shields.io/badge/powered%20by-Grok%20CLI-orange)

A professional Telegram bridge that drives the official **Grok Build CLI**
(`grok`) over the **Agent Client Protocol (ACP)** — `grok agent stdio` — and
turns it into a mobile, always-on AI pair programmer. Sign in with your xAI
account (SuperGrok / X Premium+), send a message from anywhere, and watch Grok
plan, read files, run commands, and edit code on your machine — with live typing
indicators, clean Telegram markdown, and unified edit diffs.

A fork of [`artickc/kiro-telegram-bot`](https://github.com/artickc/kiro-telegram-bot),
re-architected for the Grok Build CLI and extended into a full multi-session client.

---

## ✨ Features

| Capability | What it does |
|---|---|
| 🗂 **Projects** | `/projects` browses your folders and runs Grok in the one you pick. |
| ♻️ **Resume sessions** | `/sessions` lists recent Grok sessions; tap to resume one (`grok --session <id>`). |
| 🟢 **Connect to live sessions** | `/active` shows sessions running **right now** on your PC. Watch them live, or continue them — see below. |
| 🛑 **Kill a session / PID** | Each live `/sessions` · `/active` card has a **🛑 Kill · pid N** button (confirm-guarded) that stops that session's process and its child tree; `/killall` stops them all. The bot's own agent is never killable. |
| 📡 **Live watch** | Follow a running session read-only in real time (tails its event log). |
| 🧭 **Always-visible menu** | A persistent keyboard plus a pinned status panel that appears while a task runs (and clears when idle), showing your current **project, agent, reasoning effort, model, session and queue**. |
| ⏰ **Scheduled tasks** | Create prompts that run on a schedule (once / daily / weekly / monthly / every-N-minutes) in a chosen project, delivered back to your chat. |
| 🖼 **Multi-image prompts** | Send one or many photos (albums included) with a caption — all attached to the prompt for the agent to analyze. |
| 📜 **History** | `/history` shows the latest messages of any session. |
| 🧩 **MCP control** | `/mcp` lists MCP servers, **health-checks** them (which connected / failed and why), and **enables/disables** them — then restarts the agent to apply. |
| 👥 **Subagent visibility** | When Grok delegates to subagents and waits on them, you see each one **start / work / finish** plus a live `🤖 N running` summary — and subagent permission prompts route to your chat. |
| 📈 **Task progress bar** | The agent appends a `{progress: N%}` marker; the bot hides it and shows a **green 0–100% loading bar** on the live message, in the status panel, and on session cards (`SHOW_PROGRESS`). |
| 🔐 **Sign in from chat** | `/reauth` signs you in without a terminal — **🔑 Sign in** runs headless `grok login --device-auth` (link/code streams to your chat, no host browser), or **📥 Import** an existing on-host login; the agent restarts under the new identity. |
| 👥 **Multiple accounts** | `/accounts` saves several Grok **sign-ins** (custom names) and switches between them in a tap — **stops the agent → replaces `~/.grok/auth.json` → restarts headlessly** (never opens a browser). |
| 🔁 **Auto-rotate on give-up** | When a turn exhausts its retries (or hits **402 balance exhausted** with no same-account retry), optionally cycle through your other saved accounts once: stop CLI → swap `auth.json` → restart + re-auth → retry. First that works wins (toggle in `/accounts`). |
| ✅ **Auto-approve tools** | By default, ACP permission prompts are auto-approved for the **session** (`AUTO_APPROVE_PERMISSIONS`). Turn both that and `GROK_TRUST_ALL_TOOLS` off for interactive Approve/Deny — those prompts are **pinned** until you act. |
| 🪙 **Credits & usage** | The `✅ Done` line and `/usage` show credits used (when Grok reports them), turns this session, and account info. |
| ⌨️ **Typing indicator** | Stays on for the whole turn, even through long tool chains. |
| 📥 **Queued follow-ups** | Message while Grok is busy — it's queued and runs next. `/btw` runs it ASAP (now if idle, else right after the current task); `/flush` runs the queue now. |
| ✏️ **Edit diffs** | File edits show as unified `diff` blocks with `+N -M` stats. |
| 💬 **Quality markdown** | Converts agent markdown to Telegram **MarkdownV2** with safe escaping and code-fence-aware splitting. |
| 🔁 **Self-healing** | Auto-restarts the Grok agent with backoff and re-binds your session. |
| 🖥 **Runs 24/7** | 1-click install as a background service that starts on boot — Windows, Linux, macOS, auto-detected. |
| 🔒 **Access control** | Restrict to specific Telegram user IDs. |

---

## 📊 How it compares

| Capability | **This bot** | Other Grok Telegram bots |
|---|:---:|:---:|
| Connect Grok CLI to Telegram (ACP) | ✅ | ✅ |
| Switch between projects | ✅ | ❌ |
| Resume saved sessions | ✅ | ❌ |
| Attach to **live** PC sessions (watch / fork) | ✅ | ❌ |
| **Kill a session by PID** (or all at once) | ✅ | ❌ |
| **Live task-progress bars** (`{progress: N%}`) | ✅ | ❌ |
| **Sign in from chat** (`/reauth`, device-code) | ✅ | ❌ |
| **Multiple saved accounts** + headless one-tap switch (`/accounts`) | ✅ | ❌ |
| **Auto-rotate accounts** when a turn gives up | ✅ | ❌ |
| **Session auto-approve** + **pinned** interactive permissions | ✅ | ❌ |
| Multiple isolated sessions | ✅ | ❌ (single shared) |
| Queued follow-ups while busy | ✅ | ❌ |
| **Scheduled tasks** (cron-like) | ✅ | ❌ |
| **Multi-image** prompts (albums) | ✅ | ❌ |
| Unified **edit diffs** | ✅ | ❌ |
| Persistent menu + live status panel | ✅ | ❌ |
| Agent / reasoning / model menus | ✅ | ❌ |
| Combined, throttled output (no spam) | ✅ | ❌ |
| Auto-restart + session re-bind | ✅ | ❌ |
| 24/7 cross-platform service | ✅ | ❌ |
| 1-click install | ✅ | ❌ |

---

## ⚡ Install from npm

The fastest way — one command installs the global **`grok-tg`** CLI (ships with
the `tsx` runtime, no build step):

```bash
npm install -g grok-telegram-bot
```

By default your config lives in a **canonical, path-independent home** —
`~/.grok/tg/` (its `.env`, `logs/`, `data/`) — so the bot loads the **same**
`.env` no matter which folder you start it from. Run `grok-tg setup --path` to
print the exact location. (A `.env` in the current folder is still honoured
first, so existing per-folder checkouts keep working.)

```bash
grok-tg setup            # auto-detects grok, writes ~/.grok/tg/.env
grok-tg setup --path     # print the .env location
# edit that .env: set TELEGRAM_BOT_TOKEN and ALLOWED_USERS
grok-tg run              # foreground …
grok-tg install          # … or install as a 24/7 background service
```

The bot is **single-instance per token**: starting it again terminates any
ghost/duplicate that was still polling Telegram (the usual cause of a stale
"⛔ Not authorized"), so the fresh process with your current `.env` wins. A
plain `grok-tg run` yields to an already-running background service instead.

Startup options: `grok-tg setup [--path] | run | install | status | logs [n] |
stop | restart | uninstall`. Or try it without installing: `npx
grok-telegram-bot setup`. See **[docs/INSTALL.md](./docs/INSTALL.md)** for the
full guide.

**Already installed?** See **[docs/UPGRADE.md](./docs/UPGRADE.md)** to update to
the newest version — global npm installs auto-update when idle, or run
`npm install -g grok-telegram-bot@latest` and `grok-tg restart`.

---

## 🚀 1-click install

Clone or download, then run the installer for your OS. It installs
dependencies, auto-detects `grok`, writes `.env`, asks for your bot token,
and optionally sets up the background service.

**Windows** — double-click `install.cmd` (or in a terminal):

```powershell
.\install.cmd
```

**Linux / macOS**:

```bash
chmod +x install.sh && ./install.sh
```

### Prerequisites

- **Grok Build CLI** (`grok`) installed — `curl -fsSL https://x.ai/cli/install.sh | bash`
  (Windows: `irm https://x.ai/cli/install.ps1 | iex`). Run `grok --version` to confirm.
- A **SuperGrok** or **X Premium+** subscription, and a one-time sign-in: run
  `grok login` (browser OIDC) on the host, or use the bot's `/reauth`. On a
  headless host with no browser you can instead set `XAI_API_KEY`.
- **Node.js 20+**.
- A **bot token** from [@BotFather](https://t.me/BotFather).
- Your **Telegram user ID** from [@userinfobot](https://t.me/userinfobot).

> ⚠️ **Use a dedicated bot token.** Telegram allows only one long-polling
> consumer per token. If you also run another Telegram bot (e.g. a Kiro bridge)
> on the **same** token, they will clash on `getUpdates`. This bot keeps its
> own config home (`~/.grok/tg`) and only ever manages its **own** sessions
> (`<data>/sessions`), so it never touches Kiro's processes or session locks —
> but give it its own BotFather token to avoid the polling conflict.

---

## 🧑‍💻 Manual setup

```bash
npm install
npm run setup            # auto-detects grok + project roots, writes .env
# edit .env: set TELEGRAM_BOT_TOKEN and ALLOWED_USERS
npm start
```

No build step — TypeScript runs directly via `tsx`.

---

## 🛠 Run as a background service (daemon)

The bot installs as a **user-level** service that starts automatically on boot.
The platform is auto-detected:

| OS | Mechanism | Starts on |
|---|---|---|
| Windows | Hidden Scheduled Task (elevated) · per-user **Startup folder** (no admin) | logon |
| Linux | systemd **user** service (+ linger) | boot |
| macOS | launchd LaunchAgent | login |

On Windows, registering a logon-triggered Scheduled Task needs admin, so from a
normal terminal `grok-tg install` falls back to a hidden launcher in your
per-user **Startup folder** (starts at logon, no elevation). Run it from an
**elevated** terminal to use the Scheduled Task instead; either way `status`,
`stop`, `restart` and `uninstall` work the same.

```bash
npm run install:service     # install + start, enable autostart
npm run service -- status   # show install + running state
npm run service -- stop
npm run service -- restart
npm run service -- logs 200 # tail the log file
npm run uninstall:service   # stop + remove
```

Or use the `grok-tg` command (if linked): `grok-tg install | status | logs`.

Logs are written to `logs/grok-telegram-bot.log` (rotated at 5 MB).

---

## 💬 Commands

```
/menu         Show the persistent menu keyboard
/projects     List · /projects <q> search · /projects <path> open any folder · /projects new <name>
/sessions     List & resume sessions (active first) · /sessions <q> to filter
/active       Sessions running now on the PC
/running      Sessions this chat controls — switch between them
/killall      Kill all active sessions on the PC (with confirm)
/mcp          Inspect MCP servers · health-check · enable/disable
/tasks        Manage scheduled tasks
/newtask      Create a scheduled task (wizard)
/history      Show recent conversation history
/new          Start a fresh session here
/status       Current session, project & queue
/usage        Account info & current context usage
/btw <text>   Run it now if idle, else queue to run right after the current task
/flush        Send queued follow-ups now
/queue        Show queued follow-ups
/clearqueue   Clear the queue
/cancel       Stop the current turn
/unwatch      Stop following a live session
/model <id>   Switch the model for this session
/restart      Restart the Grok agent
/reauth       Sign in to Grok — 🔑 Sign in (grok login) or 📥 Import an existing login
/accounts     Save & switch between multiple Grok accounts · auto-rotate on errors
/help         Show help
```

Anything that isn't a command is sent to Grok as a prompt. While a turn is
running, your messages are queued and sent automatically when it finishes.

---

## 🧭 The menu & status panel

A tiny **persistent bar** sits under the message box — **☰ Menu · 🧭 Running ·
⏹ Stop** — so common actions are one tap away without clutter. Tap **☰ Menu**
(or `/menu`) to open a clean, grouped **inline menu**: Project · New · Running ·
Sessions · Agent · Model · Reasoning · Tasks · Status · Usage · Stop · Kill all.
The bar can be hidden (🙈) and restored (⌨️ Show bar or `/menu`).

While a task is running, a **pinned status panel** appears at the top of the chat
showing your current **task progress, activity, queue, project, session, context
%, agent, reasoning effort and model** (and how many sessions the chat controls),
updating live — and it's **removed when the session goes idle** so the chat stays
clean between tasks (use **Status** in the menu to see it on demand any time).
Pick **Agent**, **Reasoning** or **Model** from the inline menu (reasoning steers
how thoroughly the agent works: Minimal → Max).

## ⏰ Scheduled tasks

A task is a **prompt + a project + a schedule**. When it fires, the bot opens a
session in that project, runs the prompt, and delivers the result to your chat.

- **/newtask** (or the ➕ button) launches a guided wizard: name → prompt →
  project → schedule → confirm.
- **Schedules**: `once` at a date/time, `daily` at HH:MM, `weekly` (e.g. `Mon 09:00`),
  `monthly` (e.g. `15 09:00`), or `interval` (every N minutes).
- **/tasks** lists everything with buttons to **run now, enable/disable, edit**
  (rename, prompt, project, reschedule) and **delete**.

Tasks are stored in `data/tasks.json` and survive restarts; the scheduler runs
them whether you're online or not (great with the 24/7 service).

## 🖼 Sending images

Send one or several photos — including a Telegram **album** — with an optional
caption. The bot downloads them and attaches them all to the prompt as image
content blocks, so the agent can analyze them together. Images sent while Grok
is busy are queued with your next turn.

**Images come back too:** when the agent produces images during a turn — Imagine
`image_gen` / `image_edit` (written under
`~/.grok/sessions/<cwd>/<session>/images/` and `…/assets/`), screenshots, or
files under `<project>/images/` — the bot detects the freshly-written files and
sends them back to Telegram as **downloadable documents** (`SEND_AGENT_IMAGES`,
default on). Prompts also include image-output rules so the agent keeps gens in
the session media folder and reports absolute paths.

## 🎙 Sending voice

Send a voice note, audio file, or video note and the bot runs it as a prompt
**only when STT is configured**.

Set any OpenAI/Whisper-compatible endpoint via `STT_API_URL` (and `STT_API_KEY`
if needed). The bot transcribes, shows the quote, and submits plain text.
Without `STT_API_URL`, voice is rejected with a short “not configured” message
— Grok Build CLI rejects ACP `audio` content blocks, so raw audio cannot be
heard by the agent. Leave `STT_LANGUAGE` blank for automatic detection
(English, Russian, Romanian/Moldovan, and ~100 more).

## 📎 Sending files

Send any **document** and the bot resolves it. **Text-like files** — a long
message your Telegram client turned into a `.txt`, plus code, logs, JSON, CSV,
Markdown, and more — are downloaded, decoded, and inlined into the prompt (up to
`DOC_MAX_CHARS`, then truncated with a note), so the agent reads the whole thing.
**Binary files** are saved under `<data>/downloads` and their path is handed to
the agent to open with its own tools. An optional caption becomes the
instruction; files sent while Grok is busy are queued with your next turn.

## ↩️ Replying for context

**Reply** to any message (yours or the bot's) and the referenced content rides
along with your new message, so a terse "fix this" or "why?" keeps its meaning.
If you highlight a specific **quote** while replying, the bot forwards that exact
excerpt plus the surrounding message. Works for text, photo, voice and file
prompts alike (long quotes are trimmed to keep prompts lean).

## 📈 Task progress

The bot asks the agent to end each message with a `{progress: N%}` marker, then
**hides the marker** and renders a **green loading bar** from 0–100 %
(`🟩🟩🟩🟩🟩⬜⬜⬜⬜⬜ 50%`, all-green ✅ at 100 %) so you can see how far along the
current task is. The bar appears at the bottom of the **live message**, in the
pinned **status panel**, and on **`/running` and `/sessions` cards**. Markers are
also stripped from history, replays and previews, so the raw plumbing never
shows. Turn it off with `SHOW_PROGRESS=false`.

That marker is only an instruction the model can ignore — weaker/free models and
long, tool-heavy turns often emit none, which used to leave the bar empty for the
whole turn. So when `SHOW_PROGRESS` is on but no marker arrives, the bot falls
back to a **computed** bar derived from real activity (completed tool calls,
streamed output, elapsed time): it starts low, climbs as work advances, and fills
to 100 % when the turn completes. The agent's own marker, when present, always
takes precedence and the value never decreases. Disable the fallback with
`PROGRESS_FALLBACK=false`.

## 🔐 Signing in to Grok

Grok Build signs in with your **xAI account** (SuperGrok / X Premium+), not an
API key. Run **`/reauth`** to sign in without touching a terminal:

- **🔑 Sign in** — runs `grok login --device-auth` (device code, **no browser on
  the host**). The verification link/code streams into the chat so you can
  approve it on any device. The bot then restarts the agent under the new
  identity.
- **📥 Import existing** — adopt a `grok login` already done on this machine
  (`~/.grok/auth.json`).

It's refused while a turn is running. You can also sign in up front by running
`grok login` on the host, or set `XAI_API_KEY` on a headless host.

## 👥 Multiple accounts

**`/accounts`** manages several Grok **sign-ins** side by side. Save the current
login as a named account (auto-named from its email when available, or
**Save as…** with a custom name), rename or delete saved ones, and **switch** in
a tap. Switching is deliberately headless:

1. Snapshot the current login (so it isn't lost),
2. **Stop** the shared agent,
3. **Replace** `~/.grok/auth.json` with the saved snapshot,
4. **Start** the agent and authenticate with `cached_token` only — never a
   browser method like `grok.com` (which would hang a service host).

The menu shows the **host Grok login** vs which saved account it matches, so a
manual `grok login` outside the bot doesn't leave a stale “active” label.

**🔁 Auto-rotate on errors** (toggle here): when a turn exhausts its retries and
can't recover, the bot cycles through your other saved logins **once** with the
same stop → auth.json → start path — the first that succeeds stays active; if
they all fail it stops after one pass. Handy when an account gets throttled or
runs out of quota.

---

## 🧭 Working on several sessions at once

One chat can drive **multiple Grok sessions** and switch between them. Start a
session (📁 Project / 🆕 New), and each becomes a "controlled" session. Tap
**🧭 Running** (or `/running`) to switch: the foreground session streams live
while the others keep working quietly. When you switch to a session you see its
recent context and **every message that arrived while you were away** (its
unread, recovered from the session log). Leave a task running in A, hop to B,
reply, and come back to A to read what it did. Close a session with ✖ (it isn't
killed) — or tap **🛑 Kill · pid N** on its `/sessions` · `/active` card to stop
its process (and `/killall` to stop them all).

## 🔗 Connecting to live sessions

While a turn is running, the bot marks that session busy (a `.lock` with the live
`grok` child's pid), so a second turn can't collide with it. You can still:

- **📡 Watch** — follow the running session's output live (read-only) by tailing
  its event log. Stop with `/unwatch`.
- **Continue (fork)** — tapping a live session opens a **linked continuation** in
  the same project, primed with the recent transcript, so you can keep
  interacting from Telegram without disturbing the running turn.

Resuming an **idle** session loads it directly so you continue the exact thread.

---

## ⚙️ Configuration (`.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **yes** | — | Bot token from @BotFather. |
| `ALLOWED_USERS` | recommended | *(all)* | Comma-separated Telegram user IDs. Empty = anyone (unsafe). |
| `GROK_CLI_PATH` | no | auto / `grok` | Path to the `grok` binary. |
| `GROK_WORKSPACE` | no | cwd | Default working directory. |
| `XAI_API_KEY` | no | — | xAI API key, only for headless hosts with no browser. Normally you sign in with `grok login` (or `/reauth`) — no key needed. Exported to the agent when set. |
| `GROK_MODEL` | no | `grok-4.5` | Default model for new sessions. |
| `GROK_TG_DIR` | no | `~/.grok/tg` | Folder holding this instance's `.env`, `logs/`, `data/`. Resolution: `--instance` → `GROK_TG_DIR` → a `.env` in the current folder → `~/.grok/tg`. So a `.env` created once is loaded from any startup path. |
| `GROK_AGENT` | no | — | Custom sub-agent name (informational; Grok delegates via its own `task`/`delegate` tools). |
| `GROK_TRUST_ALL_TOOLS` | no | `true` | Pass `--always-approve` so tools run without prompts. |
| `AUTO_APPROVE_PERMISSIONS` | no | `true` | Auto-approve ACP `session/request_permission` (prefer “allow for this session”). Set `false` **and** `GROK_TRUST_ALL_TOOLS=false` for interactive Approve/Deny buttons (those prompts are **pinned** until you act or they time out). |
| `PROJECT_ROOTS` | no | workspace parent + home | Roots for `/projects`. |
| `STREAM_THROTTLE_MS` | no | `1500` | Live-edit interval while streaming. |
| `MESSAGE_BATCH_MS` | no | `800` | Window to coalesce rapid text messages (e.g. a long message Telegram split at 4096 chars) into one prompt. `0` disables. |
| `SHOW_TOOL_CALLS` | no | `true` | Show tool-call status messages. |
| `SHOW_EDIT_DIFFS` | no | `true` | Show unified diffs for edits. |
| `DIFF_MAX_LINES` | no | `120` | Max diff lines shown inline. |
| `DOC_MAX_CHARS` | no | `100000` | Max characters of a **text file** attachment inlined into the prompt (a long message Telegram turned into a `.txt`, plus code, logs, JSON, CSV, …). Longer files are truncated with a note; binaries are saved under `<data>/downloads` and their path is handed to the agent. `0` = unlimited. |
| `SHOW_SUBAGENTS` | no | `true` | Stream subagent (crew) start/work/finish while the main agent waits. |
| `SHOW_PROGRESS` | no | `true` | Ask the agent to append a `{progress: N%}` marker to each message; the bot parses it, hides the marker, and renders a green 0–100% bar on the live message, in session cards, and in the status panel. |
| `PROGRESS_FALLBACK` | no | `true` | When `SHOW_PROGRESS` is on but the agent emits **no** `{progress: N%}` marker (weaker/free models and long tool-heavy turns often skip it), render a **bot-computed** bar derived from real activity (completed tool calls, streamed output, elapsed time) so a live bar still advances — filling to 100% when the turn completes. The agent's own marker, when present, always takes precedence and stays monotonic. |
| `NOTIFY_OTHER_SESSIONS` | no | `true` | Deliver a session's "Done" summary (with a short created/edited/deleted count) even when it's a background session, marked "From other session". `false` keeps background sessions silent. |
| `MCP_PROBE_TIMEOUT_MS` | no | `8000` | Per-server timeout for the `/mcp` live health-check. |
| `MCP_PROBE_CONCURRENCY` | no | `6` | How many MCP health probes run at once. |
| `GROK_AUTO_RESTART` | no | `true` | Auto-restart the agent if it exits. |
| `GROK_TG_SINGLE_INSTANCE` | no | `true` | Enforce one running bot **per token**: on startup a still-alive ghost/duplicate (an old process polling Telegram with a stale `.env`, the usual cause of a phantom "⛔ Not authorized") is terminated so the fresh process wins. A manual `run` yields to an already-running background service instead of fighting it. |
| `AUTO_UPDATE` | no | `true` | Hourly check npm and, when a newer version exists **and the bot is idle** (no turn/task running, no other active Grok session), auto-update + restart + post the release notes (tagged `#update`). Global npm installs only. |
| `UPDATE_CHECK_MS` | no | `3600000` | How often to check npm for updates (ms). |
| `PROMPT_RETRY_ATTEMPTS` | no | `5` | Max retries for a transient agent error (e.g. high-traffic / `Internal error`) before any output streamed, with `6s → 12s → 24s → 48s → 60s` backoff. The real error shows each attempt; a summary after the last. `0` disables. |
| `AUTO_FORK_ON_ERROR` | no | `true` | When the retries above are exhausted on a transient error (throttle / `Internal error` / exhausted context) and nothing streamed, **logically fork** the session — open a fresh continuation primed with the recent transcript, drop the stuck session, and retry the message once. |
| `AUTO_FORK_CONTEXT_PCT` | no | `85` | When a prompt fails transiently **and** the session's last-known context usage is at/above this %, **skip the retry backoff and fork immediately** — a context-exhausted session won't recover by retrying the same oversized prompt (throttling on a near-full session shows up as `-32603 … throttled`). Forking compacts it into a fresh continuation primed with the recent transcript. Requires `AUTO_FORK_ON_ERROR`; `0` disables this trigger. |
| `RESUME_ON_STREAM_ERROR` | no | `true` | When a transient error (throttle / `Internal error` / dropped response stream) strikes **after the reply already began streaming**, the retry/fork/rotate paths above are skipped (re-sending would re-run tools that already executed). Instead the bot asks the **same session to continue** from where it stopped — the partial reply and completed tool results are already in history, so nothing is repeated — using the same backoff so the throttle can clear. Skipped for context-full sessions (they can't recover by continuing). |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `LOG_DIR` / `LOG_FILE` | no | `<project>/logs/…` | Log location. |

---

## 🧩 How it works

```
Telegram  ──HTTPS──▶  Bot (grammY)
                         │  spawns once
                         ▼
        grok agent stdio  ◀── JSON-RPC 2.0 over stdio (ACP) ──▶  Bot
                         │
                         ├─ initialize / authenticate   (cached login / API key)
                         ├─ session/new · session/load  (projects, resume)
                         ├─ session/prompt              (your messages)
                         └─ session/update              (streamed text, tools)
```

One `grok agent stdio` process multiplexes many sessions. After `initialize` the
bot runs `authenticate` (using the cached `grok login` token, or `XAI_API_KEY`),
then streamed `agent_message_chunk` updates are assembled into a live, throttled
message and `tool_call` updates render as status lines with diffs.

The bot records the sessions **it** drives on disk under `<data>/sessions/`:
`<id>.json` (metadata), `<id>.jsonl` (history, used by `/history` and live
watch), and `<id>.lock` (written while a turn runs, for active detection). This
layout is entirely separate from any Kiro bridge, so the two never collide.

---

## 📁 Project layout

```
src/
├── index.ts              Entry point, daemon-friendly logging, shutdown
├── cli.ts                CLI: run / install / start / stop / status / logs
├── config.ts             .env loading, paths, daemon options
├── logger.ts             Leveled logger with file output
├── grok/                 Grok bridge: headless client, JSONL types, models, session log
├── sessions/             Session discovery, history parser, live tail watcher
├── projects/             Project directory discovery
├── mcp/                  MCP config (list/toggle) + live health probe
├── render/               Markdown→MarkdownV2, diffs, tool formatting, chunking
├── stream/               Incremental edit-streaming
├── service/              Cross-platform daemon (windows/linux/macos + selector)
└── bot/                  grammY bot, per-chat runtime, handlers
```

---

## ❓ FAQ

**Can I run the Grok Telegram bot 24/7 on a server?** Yes — `npm run install:service`
installs a user-level service (systemd/launchd/Scheduled Task) that starts on
boot and auto-restarts on crash.

**How do I control Grok from my phone?** Set up the bot, message it on Telegram,
and pick a project with `/projects`. Every message becomes a Grok prompt.

**Can multiple people use one bot?** Add their IDs to `ALLOWED_USERS`. Each chat
gets its own session.

**Why can't I take over a session that's already running?** Grok locks active
sessions exclusively. The bot lets you **watch** it live or **fork** a linked
continuation instead. See "Connecting to live sessions".

**Does it support custom agents and MCP servers?** Yes — set `GROK_AGENT`, and
the bot inherits whatever MCP servers Grok CLI is configured with.

---

## 🔐 Tool approvals

Over ACP, Grok honors a permission mode. Defaults are built for unattended
mobile use:

| Setting | Default | Effect |
|---|---|---|
| `GROK_TRUST_ALL_TOOLS` | `true` | Passes `--always-approve` so tools run without prompts. |
| `AUTO_APPROVE_PERMISSIONS` | `true` | If a permission request still arrives, auto-pick **allow for this session** / always-allow. |

Set **both** to `false` for ACP **"ask"** mode: Grok sends
`session/request_permission` before risky tools and the bot surfaces
**Approve / Allow for session / Deny** buttons. Those prompts are **pinned** so
they aren't buried by streaming output; the pin is removed when you choose,
or when the request times out (status panel is re-pinned). You can always
intervene on a live turn with the tool stream + **⏹ Stop** (`/cancel`).

## 🔐 Security

This bot lets authorized Telegram users run commands and edit files on the host.
**Always set `ALLOWED_USERS`**, keep `.env` private, and run as a non-privileged
user. See [SECURITY.md](./SECURITY.md) for the full model.

---

## 🗺 Roadmap

- [x] Projects, resume & attach to live sessions
- [x] Queued follow-ups, edit diffs, quality MarkdownV2
- [x] Persistent menu + live status panel (project / agent / reasoning / model)
- [x] Scheduled tasks (once / daily / weekly / monthly / interval)
- [x] Multi-image prompts (albums)
- [x] Combined, throttled output (anti-spam)
- [x] 24/7 cross-platform background service
- [x] Voice messages → STT (`STT_API_URL`) → text prompt (disabled without STT)
- [x] Agent-generated images → Telegram document files (session `images/`/`assets/`)
- [x] Context-usage % in the status panel
- [x] Inline approvals — approve/deny risky tools from buttons (non trust-all mode)
- [x] Session auto-approve + pinned permission prompts
- [x] Account & context usage (`/usage`)
- [x] Multiple accounts with headless one-tap switch + auto-rotate (`/accounts`)
- [x] Device-code `/reauth` (no host browser) + real email labels from auth.json
- [x] Rich per-kind tool-call detail (search / edit diffs / shell / MCP / …)
- [x] README community sections — Contributors, Top Contributors, Stars, StarMapper
- [ ] **Token & cost meter** — per-session token counts and an estimated spend tally
- [ ] **Text-to-speech replies** — optionally speak answers back as voice notes
- [ ] **Scheduled-task chaining & conditions** — run task B after A, or only if a command/file check passes
- [ ] **Team mode** — multiple authorized users with per-user sessions, roles, and an audit log
- [ ] Localized bot UI (i18n)
- [ ] Docker image with `grok` preinstalled
- [ ] Webhook mode for serverless deployment

Have an idea? Open a [feature request](../../issues/new/choose).

## 🤝 Contributing

Contributions are very welcome! See **[CONTRIBUTING.md](./CONTRIBUTING.md)** to get
started — no build step is required (`npm run dev`), and `npm run typecheck` must
pass.

New here? Look for issues labeled
[**good first issue**](../../issues?q=is%3Aopen+label%3A%22good+first+issue%22)
and [**help wanted**](../../issues?q=is%3Aopen+label%3A%22help+wanted%22).

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## 👥 Contributors

[![Contributors](https://contrib.rocks/image?repo=artickc/grok-telegram-bot&max=100&columns=20&anon=1)](https://github.com/artickc/grok-telegram-bot/graphs/contributors)

### How to Contribute

1. Fork the repository
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

See [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed guidelines.

### Releasing a New Version

```bash
# Bump the version, update CHANGELOG.md, then push a tag.
# The release workflow builds a downloadable zip and publishes notes automatically.
npm version minor              # or: patch / major — updates package.json + commits
git push --follow-tags         # pushing the v* tag triggers .github/workflows/release.yml
```

---

## ⭐ Top Contributors

> This project is built and maintained in the open. These people have made the
> contributions that shape its quality, stability, and reach. **Thank you.**

<table>
  <tr>
    <td align="center" width="180">
      <a href="https://github.com/artickc">
        <img src="https://github.com/artickc.png?size=100" width="80" height="80" style="border-radius:50%" alt="artickc"/><br/>
        <sub><b>artickc</b></sub>
      </a><br/>
      🥇 Maintainer<br/>
      <sub>Created the bot: Grok headless bridge, multi-session<br/>runtime, scheduler, daemon &amp; renderer</sub>
    </td>
  </tr>
</table>

> 🙏 Every pull request, bug report, and idea matters. Open source is built by
> people like them — see the full list under [Contributors](#-contributors).

---

## 📊 Stars

<a href="https://www.star-history.com/?repos=artickc%2Fgrok-telegram-bot&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=artickc/grok-telegram-bot&type=Date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=artickc/grok-telegram-bot&type=Date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=artickc/grok-telegram-bot&type=Date&legend=top-left" />
  </picture>
</a>

If this project helps you, please consider giving it a ⭐ — it really helps!

---

## 🌍 StarMapper

> See where in the world this project's stargazers live — an interactive map of
> the community.

<a href="https://starmapper.bruniaux.com/artickc/grok-telegram-bot">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://starmapper.bruniaux.com/api/map-image/artickc/grok-telegram-bot?theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://starmapper.bruniaux.com/api/map-image/artickc/grok-telegram-bot?theme=light" />
    <img alt="StarMapper — where this project's stargazers live" src="https://starmapper.bruniaux.com/api/map-image/artickc/grok-telegram-bot" />
  </picture>
</a>

---

## 📦 Download & Releases

Grab the latest packaged build from the
[**Releases**](https://github.com/artickc/grok-telegram-bot/releases) page — each
release ships a clean `grok-telegram-bot-<version>.zip` (no `node_modules` or
secrets) plus GitHub's source archives. See [CHANGELOG.md](./CHANGELOG.md) for
what changed in each version, **[docs/INSTALL.md](./docs/INSTALL.md)** for the
full 1-click install guide, and **[docs/UPGRADE.md](./docs/UPGRADE.md)** for how
to update an existing install (npm, zip, or source).

---

## 📄 License

[MIT](./LICENSE) — see also [CONTRIBUTING](./CONTRIBUTING.md) and
[Code of Conduct](./CODE_OF_CONDUCT.md).

---

<sub>Keywords: Grok CLI Telegram bot, xAI Grok coding agent, AI coding
assistant on Telegram, mobile AI pair programming, remote coding agent, run AI
agent as a service, Windows/Linux/macOS daemon, ChatOps for developers.</sub>
