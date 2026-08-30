/**
 * Bot command definitions (for the Telegram command menu) and help text.
 *
 * Private chats get the full list (sorted by workflow). Groups/forum topics get
 * a shorter list with cancel/menu first — reply keyboards are unreliable there.
 */

import { GROK_FORWARDED_COMMANDS } from "./handlers/grok-slash.js";

/** Bot-local commands (not forwarded to Grok). Order = Telegram "/" menu order. */
export const BOT_COMMANDS: { command: string; description: string }[] = [
  // Core control
  { command: "start", description: "Welcome, menu & status panel" },
  { command: "menu", description: "Open the menu" },
  { command: "cancel", description: "Stop the current turn" },
  { command: "stop", description: "Stop the current turn (alias of /cancel)" },
  { command: "status", description: "Current session, project & queue" },
  { command: "new", description: "New session in current project" },
  // Sessions
  { command: "running", description: "Sessions this chat controls" },
  { command: "sessions", description: "List/resume sessions · /sessions <q>" },
  { command: "active", description: "Sessions running now on the PC" },
  { command: "history", description: "Show recent conversation history" },
  { command: "import", description: "Import Kiro/OpenCode/Claude/Codex session" },
  // Project
  { command: "projects", description: "Projects: list / search / open / new" },
  // Queue
  { command: "btw", description: "Run ASAP: /btw <text>" },
  { command: "flush", description: "Send queued follow-ups now" },
  { command: "queue", description: "Show queued follow-ups" },
  // Account
  { command: "accounts", description: "Switch between saved Grok accounts" },
  { command: "reauth", description: "Sign in to Grok (login or import)" },
  { command: "usage", description: "Account & context usage" },
  // System / tools
  { command: "mcp", description: "Inspect & toggle MCP servers" },
  { command: "tasks", description: "Manage scheduled tasks" },
  { command: "newtask", description: "Create a scheduled task" },
  { command: "killall", description: "Kill all active sessions on the PC" },
  { command: "model", description: "Switch model: /model <id>" },
  { command: "restart", description: "Restart the Grok agent" },
  { command: "sandbox", description: "Show / set Grok sandbox profile" },
  { command: "unwatch", description: "Stop following a live session" },
  { command: "help", description: "Show help" },
];

/** Full Telegram menu: bot-local + Grok Build shell forwards (≤100). */
export const COMMANDS: { command: string; description: string }[] = [
  ...BOT_COMMANDS,
  ...GROK_FORWARDED_COMMANDS.map(({ command, description }) => ({ command, description })),
];

/**
 * Group / forum command menu — keep short; cancel & menu first so topics can
 * stop a turn without the private reply-keyboard bar.
 */
export const GROUP_COMMANDS: { command: string; description: string }[] = [
  { command: "cancel", description: "Stop the current turn" },
  { command: "stop", description: "Stop the current turn" },
  { command: "menu", description: "Open topic / group menu" },
  { command: "status", description: "Session, project & queue" },
  { command: "new", description: "New session in this topic/project" },
  { command: "running", description: "Sessions this topic controls" },
  { command: "sessions", description: "List / resume sessions" },
  { command: "btw", description: "Queue or run: /btw <text>" },
  { command: "flush", description: "Run queued follow-ups now" },
  { command: "model", description: "Switch model: /model <id>" },
  { command: "goal", description: "Grok /goal — set/status/pause/resume/clear" },
  { command: "plan", description: "Grok /plan — enter plan mode" },
  { command: "compact", description: "Grok /compact — compress context" },
  { command: "help", description: "Show help" },
];

export const HELP_TEXT = [
  "\u{1F916} Grok Telegram Bot",
  "Drive Grok CLI from your phone \u2014 projects, resume, live sessions, diffs.",
  "",
  "HOW IT WORKS",
  "\u2022 Just send a message to chat with Grok in the current project.",
  "\u2022 While Grok is working, anything you send is queued and runs",
  "  automatically when the current turn finishes.",
  "\u2022 Persistent bar (private): \u2630 Menu \u00B7 \u{1F195} New session \u00B7 \u{1F9ED} Running \u00B7 \u23F9 Stop.",
  "\u2022 New session: /new or the bar button (not the inline Menu message).",
  "\u2022 In groups / forum topics: use /cancel or Menu \u2192 \u23F9 Stop",
  "  (the persistent bar is unreliable in topics; use /new or topic menu).",
  "",
  "COMMANDS (core)",
  "/menu \u2014 open the menu",
  "/cancel or /stop \u2014 stop the current turn",
  "/status \u2014 session, project and queue",
  "/new \u2014 new session in the current project (also bar: \u{1F195} New session)",
  "",
  "COMMANDS (sessions)",
  "/running \u2014 sessions this chat/topic controls",
  "/sessions \u2014 resume a recent Grok session",
  "/active \u2014 attach to a session running on the PC",
  "/history \u2014 latest messages of the current session",
  "/import \u2014 import a /running session from another agent",
  "",
  "COMMANDS (more)",
  "/projects \u2014 choose which folder Grok works in (private chats)",
  "/btw <text> \u2014 run now if idle, else right after the current task",
  "/goal <objective|status|pause|resume|clear> \u2014 Grok run-until-done goal (project topic / AI Chat)",
  "/flush \u2014 run queued follow-ups immediately",
  "/reauth \u2014 sign in to Grok",
  "/accounts \u2014 switch saved Grok accounts",
  "/sandbox \u2014 show or set GROK_SANDBOX (needs /restart)",
  "",
  "GROK BUILD SLASH (forwarded into the active session)",
  "/goal /plan /view_plan /compact /context /session_info",
  "/deep_research /workflow /workflows /loop",
  "/remember /memory /memory_flush /dream",
  "Underscores map to hyphens (e.g. /view_plan \u2192 /view-plan).",
  "Other non-bot Grok /commands and skills are also forwarded.",
].join("\n");
