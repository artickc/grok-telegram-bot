/**
 * Bot command definitions (for the Telegram command menu) and help text.
 *
 * Telegram setMyCommands hard limit is 100 entries. Bot-local commands plus
 * the advertised Grok shell subset must stay under that; catch-all forward
 * still reaches non-menu Grok/skills slashes.
 */
import { GROK_FORWARDED_COMMANDS } from "./handlers/grok-slash.js";

/** Bot-local commands (not forwarded to Grok). */
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: "start", description: "Welcome, menu & status panel" },
  { command: "menu", description: "Show the menu keyboard" },
  { command: "projects", description: "Projects: list / search <q> / open <path> / new <name>" },
  { command: "sessions", description: "List/resume sessions (active first) \u00b7 /sessions <q>" },
  { command: "active", description: "Sessions running now on the PC" },
  { command: "running", description: "Sessions this chat controls \u2014 switch between them" },
  { command: "killall", description: "Kill all active sessions on the PC" },
  { command: "mcp", description: "Inspect & toggle MCP servers \u00b7 health-check" },
  { command: "tasks", description: "Manage scheduled tasks" },
  { command: "newtask", description: "Create a scheduled task" },
  { command: "history", description: "Show recent conversation history" },
  { command: "new", description: "Start a fresh session here" },
  { command: "status", description: "Current session, project & queue" },
  { command: "usage", description: "Account & context usage" },
  { command: "btw", description: "Run ASAP (now if idle, else next): /btw <text>" },
  { command: "flush", description: "Send queued follow-ups now" },
  { command: "queue", description: "Show queued follow-ups" },
  { command: "cancel", description: "Stop the current turn" },
  { command: "unwatch", description: "Stop following a live session" },
  { command: "model", description: "Switch model: /model <id>" },
  { command: "restart", description: "Restart the Grok agent" },
  { command: "reauth", description: "Sign in to Grok (login or import)" },
  { command: "accounts", description: "Switch between saved Grok accounts" },
  { command: "help", description: "Show help" },
];

/** Full Telegram menu: bot-local + Grok Build shell forwards (≤100). */
export const COMMANDS: { command: string; description: string }[] = [
  ...BOT_COMMANDS,
  ...GROK_FORWARDED_COMMANDS.map(({ command, description }) => ({ command, description })),
];

export const HELP_TEXT = [
  "\u{1F916} Grok Telegram Bot",
  "Drive Grok CLI from your phone \u2014 projects, resume, live sessions, diffs.",
  "",
  "HOW IT WORKS",
  "\u2022 Just send a message to chat with Grok in the current project.",
  "\u2022 While Grok is working, anything you send is queued and runs",
  "  automatically when the current turn finishes.",
  "",
  "BOT COMMANDS",
  "/projects \u2014 choose which folder Grok works in",
  "/sessions \u2014 resume one of your recent Grok sessions",
  "/active \u2014 attach to a session currently running on the PC",
  "/history \u2014 show the latest messages of the current session",
  "/new \u2014 start a brand-new session in the current project",
  "/btw <text> \u2014 run it now if idle, otherwise right after the current task",
  "/flush \u2014 run queued follow-ups immediately",
  "/cancel \u2014 stop the current turn",
  "/status \u2014 show session, project and queue size",
  "/reauth \u2014 sign in to Grok (grok login, or import an existing login)",
  "/accounts \u2014 switch between saved Grok accounts",
  "",
  "GROK BUILD SLASH (forwarded into the active session)",
  "/goal /plan /view_plan /compact /context /session_info",
  "/deep_research /workflow /workflows /loop",
  "/remember /memory /memory_flush /dream",
  "/effort /always_approve /auto /fork /rewind",
  "/imagine /imagine_video /hooks /plugins /skills",
  "/docs /doctor /settings /config_agents /personas",
  "/grok_new /grok_usage /grok_btw \u2014 Grok builtins that collide with bot names",
  "Underscores map to hyphens (e.g. /view_plan \u2192 /view-plan).",
  "Other non-bot Grok /commands and skills are also forwarded.",
].join("\n");
