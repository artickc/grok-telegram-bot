# Forum project group

Use a **Telegram forum supergroup** so each project gets its own topic. The bot
runs Grok sessions **in the bound project path** for that topic, while the
default **AI Chat** topic stays on your workspace (`GROK_WORKSPACE`).

This is optional. Private DMs with the bot still work exactly as before.

---

## Prerequisites

1. A **supergroup** with **Topics** enabled (Telegram group settings → Topics).
2. The bot is an **administrator** with **Manage Topics** (and enough rights to
   post / pin when you want icons or setup announcements).
3. Your bot token and allowlist configured as usual:
   - `TELEGRAM_BOT_TOKEN`
   - **`ALLOWED_USERS`** — required for groups. Unauthorized members are
     **ignored silently** (no ⛔ spam). Empty allowlist with a forum group is
     unsafe (any member could drive the host).
4. `PROJECT_ROOTS` / catalog so project names resolve (same roots as `/projects`).

---

## Configure

In `.env` (or `~/.grok/tg/.env` for a global npm install):

```ini
# Negative Telegram chat id of the forum supergroup
TOPIC_GROUP_ID=-100xxxxxxxxxx

# Default true: create one topic per catalog project (paced + 429-retried)
TOPIC_AUTO_CREATE=true

# Display name for the workspace topic (default AI Chat)
TOPIC_AI_CHAT_NAME=AI Chat

# Workspace used in General / AI Chat
GROK_WORKSPACE=C:\path\to\workspace

# Where /projects and exact-name topic binds look for folders
PROJECT_ROOTS=C:\path\to\Domains,H:\Lucru\Domains
```

Restart the bot after changing these. On startup the bot **probes** the group:

| Probe result | Behavior |
|---|---|
| Not admin / no Manage Topics | Group **ignored** for topic features |
| Topics off | Best-effort try to enable; if Telegram has no API for it, group ignored until you enable Topics manually |
| Admin + Topics on | **Ready** — creates AI Chat (and optional project topics) |

Re-run setup any time from inside the group:

```
/forum_setup
```

You get a clear **ready** vs **disabled (reason)** status and the mapped topic count.

When the bot is later promoted to admin, it re-probes automatically (`my_chat_member`).

---

## Topic model

| Topic | Working directory | Typical use |
|---|---|---|
| **General** / **AI Chat** | `GROK_WORKSPACE` | Orchestration, cross-project planning, agent bridge actions |
| **Project topic** | Bound project path | All coding work for that folder |
| **User-created topic** | Bound after name/path match | Ad-hoc projects or new folders |

Messages you send **inside a topic** are prompts for a session whose `cwd` is
that topic’s path. Menus, model/reasoning picks, `/sessions`, `/running`, and
Stop are **topic-scoped** so one project does not steal another’s session.

In topics the persistent reply keyboard is unreliable, so use the **topic
inline menu** (Stop + Running + …) or slash commands (`/new`, `/stop`, …).

---

## Binding a topic to a project

### Auto-bind (exact name only)

If you create a topic whose title **exactly** matches a catalog project name
(case-insensitive), the bot binds it immediately and confirms the path.

Fuzzy / partial matching is **not** used (it used to pick the wrong folder).

### Manual bind

If there is no exact catalog match, the bot asks you to send:

- an **absolute directory path**, or
- an **exact** catalog project name

Examples:

```text
H:\Lucru\Domains\MyApp
MyApp
```

### Agent bind (Telegram bridge)

From **AI Chat / General**, the agent can create topics and bind paths via a
fenced JSON block (see [Agent bridge](#agent-bridge-cross-topic-actions)).
Absolute paths that **do not exist yet are created on disk**, then bound
(new-project flow).

### One path, one topic

A catalog path is only bound to **one** topic. If the same exact name/path is
already used, the bot says so and asks for another path or name.

---

## Day-to-day usage

1. Open the **project topic** (or create one and bind it).
2. Chat normally — each message is a Grok prompt in that project.
3. **`/new`** or the menu **New** button starts a fresh session in that topic.
4. **Stop** / `/stop` / `/cancel` only cancels **this topic’s** in-flight turn —
   never the shared `grok agent` process (other topics keep running).
5. Attach photos, documents, and (with STT configured) voice the same as in DM.
6. User prompts are re-posted as **prompt anchors** with a searchable
   `#prompt_…` tag; replies and Done messages thread to that anchor.

### Multi-project orchestration

In **AI Chat**, ask the agent to open a project elsewhere, e.g. “Create a topic
for MyApp at `H:\Projects\MyApp` and scaffold a README there.” The agent emits
bridge actions; the bot creates the topic, binds the path, and can
`send_prompt` into that topic without you switching threads manually.

---

## Agent bridge (cross-topic actions)

On the **first prompt of a session** the bot teaches the agent a small protocol:
emit a fenced `json` block with a `"telegram"` array (up to **9** actions per
turn; up to **5** `send_prompt`). The bridge strips the fence from the chat and
may feed results back as a quiet system turn (not a second Done).

| Action | Purpose |
|---|---|
| `create_topic` | New forum topic; optional `path` binds immediately |
| `set_path` | Bind/rebind topic by title or `#threadId` |
| `send_prompt` | Inject a prompt into another topic (`ran` / `queued`; optional `new_session`) |
| `search_memory` | Search topic + session indexes |
| `list_bots` | List allowlisted sibling bots |
| `bot_command` | Call `/command@bot` and wait for that bot to settle |

Example (from General / AI Chat):

```json
{
  "telegram": [
    {
      "action": "create_topic",
      "name": "MyApp",
      "path": "H:\\Projects\\MyApp"
    },
    {
      "action": "send_prompt",
      "topic": "MyApp",
      "prompt": "1) scaffold\n2) tests\n3) README"
    }
  ]
}
```

`topic` may be the exact title, `#threadId`, `general`, or `ai chat`.

---

## Sibling bots (optional)

To let the agent call other Telegram bots you control:

```ini
ALLOWED_TELEGRAM_BOTS=helperbot,other_bot
# Optional catalogs for list_bots / teaching:
# TELEGRAM_BOT_COMMANDS=helperbot:status,help;otherbot:start|Start,info
# TELEGRAM_BOT_REPLY_TIMEOUT_MS=45000
# TELEGRAM_BOT_SETTLE_MS=2000
```

Only usernames on the allowlist can be invoked. Timeouts return `ok=false` and
do **not** count as Done.

---

## Access control

| Setting | Effect |
|---|---|
| `ALLOWED_USERS` set | Only listed user IDs can prompt (DM **and** group topics) |
| Not allowlisted | Updates ignored **silently** in the group |
| Empty allowlist | Anyone can use the bot — **do not combine with `TOPIC_GROUP_ID`** |

---

## Troubleshooting

| Symptom | What to check |
|---|---|
| Topics never created | Bot admin + Manage Topics; Topics enabled; `TOPIC_GROUP_ID` exact (negative id); `/forum_setup` |
| “Group ignored” | Status text from `/forum_setup` (`not_admin`, `not_forum`, …) |
| Wrong folder bound | Title must **exactly** match catalog name; re-bind with absolute path |
| Agent can’t create topics | Forum must be **ready**; work from AI Chat / General for orchestration |
| Unauthorized spam / silent ignore | Confirm your id in `ALLOWED_USERS`; others are silent by design |
| Stop kills everything | Should not — upgrade if an old build killed the shared agent; Stop is session-scoped |
| Large catalog slow | Bulk create is paced and 429-retried; re-run `/forum_setup` to continue |

---

## Related

- [README](../README.md) — full feature list and config table
- [INSTALL.md](./INSTALL.md) — first-time setup
- [UPGRADE.md](./UPGRADE.md) — updating an existing install
- `.env.example` — all forum / bridge env vars with comments
