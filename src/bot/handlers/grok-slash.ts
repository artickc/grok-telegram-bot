/**
 * Forward Grok Build slash commands (e.g. /goal, /plan, /compact) into the
 * active ACP session. Grok shell builtins are parsed from the prompt text by
 * slash_exec — they never reached the agent before because the Telegram message
 * handler treated unknown "/…" lines as typos.
 *
 * Bot-local commands (projects, sessions, reauth, …) stay reserved and are
 * handled by their own `bot.command` registrations. Name collisions use
 * non-colliding Telegram aliases that still send the correct Grok slash line.
 */
import type { Bot, Context } from "grammy";
import { textPrompt } from "../../app/types.js";
import { createLogger } from "../../logger.js";
import type { BotDeps } from "../deps.js";
import { extractReplyContext } from "../reply-context.js";

const log = createLogger("grok-slash");

/**
 * Telegram command names reserved by this bot (without leading slash).
 * Must stay in sync with bot.command registrations / COMMANDS menu.
 * Bare names in this set are NEVER stolen for Grok — use collision aliases.
 */
export const BOT_RESERVED_COMMANDS = new Set(
  [
    "start",
    "menu",
    "help",
    "projects",
    "project",
    "sessions",
    "active",
    "running",
    "killall",
    "mcp",
    "tasks",
    "newtask",
    "history",
    "new",
    "status",
    "usage",
    "btw",
    "flush",
    "queue",
    "clearqueue",
    "cancel",
    "unwatch",
    "model",
    "restart",
    "sandbox",
    "reauth",
    "accounts",
  ].map((c) => c.toLowerCase()),
);

/**
 * Telegram command name (no slash, lowercase) → Grok shell command name (no slash).
 * Covers hyphenated multi-word forms, documented Grok aliases, and collision aliases
 * for bot-reserved bare names that still have distinct Grok builtins.
 */
export const GROK_SLASH_ALIASES: Readonly<Record<string, string>> = {
  // Multi-word (Telegram underscore ↔ Grok hyphen)
  view_plan: "view-plan",
  show_plan: "view-plan",
  plan_view: "view-plan",
  deep_research: "deep-research",
  always_approve: "always-approve",
  session_info: "session-info",
  imagine_video: "imagine-video",
  config_agents: "config-agents",
  release_notes: "release-notes",
  import_claude: "import-claude",
  compact_mode: "compact-mode",
  vim_mode: "vim-mode",
  agents_dashboard: "dashboard",
  // No-underscore convenience forms
  viewplan: "view-plan",
  showplan: "view-plan",
  planview: "view-plan",
  deepresearch: "deep-research",
  alwaysapprove: "always-approve",
  sessioninfo: "session-info",
  imaginevideo: "imagine-video",
  configagents: "config-agents",
  releasenotes: "release-notes",
  importclaude: "import-claude",
  // Documented Grok aliases
  clear: "new",
  undo: "rewind",
  title: "rename",
  m: "model",
  mem: "memory",
  cost: "usage",
  agents: "config-agents",
  howto: "docs",
  guides: "docs",
  changelog: "release-notes",
  ml: "multiline",
  t: "theme",
  full: "fullscreen",
  tour: "tutorial",
  onboarding: "tutorial",
  welcome: "home",
  exit: "quit",
  prefs: "settings",
  preferences: "settings",
  config: "settings",
  terminal_setup: "doctor",
  terminal_check: "doctor",
  terminal_info: "doctor",
  terminalsetup: "doctor",
  terminalcheck: "doctor",
  terminalinfo: "doctor",
  // Bot name collisions → still send the Grok builtin
  grok_new: "new",
  session_new: "new",
  grok_clear: "new",
  memory_flush: "flush",
  grok_flush: "flush",
  grok_usage: "usage",
  grok_cost: "usage",
  grok_btw: "btw",
  // session-info aliases when bare status/info are bot-reserved
  grok_status: "session-info",
  grok_info: "session-info",
};

/**
 * Official shell builtins that are meaningful over ACP (not pure TUI/pager).
 * Used for tests / inventory; menu may advertise a subset + collision aliases.
 */
export const GROK_SHELL_ACP_COMMANDS: readonly string[] = [
  "new",
  "compact",
  "context",
  "session-info",
  "fork",
  "rewind",
  "copy",
  "export",
  "delete",
  "rename",
  "model",
  "effort",
  "always-approve",
  "auto",
  "plan",
  "view-plan",
  "memory",
  "flush",
  "dream",
  "remember",
  "hooks",
  "plugins",
  "marketplace",
  "skills",
  "imagine",
  "imagine-video",
  "loop",
  "goal",
  "deep-research",
  "workflow",
  "workflows",
  "feedback",
  "btw",
  "mcps",
  "doctor",
  "release-notes",
  "docs",
  "import-claude",
  "config-agents",
  "personas",
  "login",
  "logout",
  "usage",
  "privacy",
  "settings",
];

/** Grok Build slash commands we advertise in the Telegram menu (Telegram-safe names). */
export const GROK_FORWARDED_COMMANDS: { command: string; description: string; grok: string }[] = [
  // Session
  { command: "compact", description: "Grok /compact — compress context", grok: "compact" },
  { command: "context", description: "Grok /context — context window usage", grok: "context" },
  { command: "session_info", description: "Grok /session-info", grok: "session-info" },
  { command: "fork", description: "Grok /fork — branch session", grok: "fork" },
  { command: "rewind", description: "Grok /rewind — undo last turns", grok: "rewind" },
  { command: "copy", description: "Grok /copy — copy last response", grok: "copy" },
  { command: "export", description: "Grok /export — export conversation", grok: "export" },
  { command: "delete", description: "Grok /delete — delete session history", grok: "delete" },
  { command: "rename", description: "Grok /rename <title>", grok: "rename" },
  { command: "grok_new", description: "Grok /new — fresh session (CLI)", grok: "new" },
  // Model / mode
  { command: "effort", description: "Grok /effort low|medium|high|xhigh", grok: "effort" },
  { command: "always_approve", description: "Grok /always-approve toggle", grok: "always-approve" },
  { command: "auto", description: "Grok /auto — auto permission mode", grok: "auto" },
  { command: "plan", description: "Grok /plan — enter plan mode", grok: "plan" },
  { command: "view_plan", description: "Grok /view-plan — show saved plan", grok: "view-plan" },
  // Memory
  { command: "memory", description: "Grok /memory — browse memories", grok: "memory" },
  { command: "memory_flush", description: "Grok /flush — save session to memory", grok: "flush" },
  { command: "dream", description: "Grok /dream — consolidate memory", grok: "dream" },
  { command: "remember", description: "Grok /remember <note>", grok: "remember" },
  // Extensions
  { command: "hooks", description: "Grok /hooks — hooks panel", grok: "hooks" },
  { command: "plugins", description: "Grok /plugins — plugins panel", grok: "plugins" },
  { command: "marketplace", description: "Grok /marketplace — plugin marketplace", grok: "marketplace" },
  { command: "skills", description: "Grok /skills — skills panel", grok: "skills" },
  // Media
  { command: "imagine", description: "Grok /imagine <description>", grok: "imagine" },
  { command: "imagine_video", description: "Grok /imagine-video <description>", grok: "imagine-video" },
  // Scheduling / workflows / goals
  { command: "loop", description: "Grok /loop [interval] <prompt>", grok: "loop" },
  { command: "goal", description: "Grok /goal — set/status/pause/resume/clear", grok: "goal" },
  { command: "deep_research", description: "Grok /deep-research <query>", grok: "deep-research" },
  { command: "workflow", description: "Grok /workflow — run/manage workflow", grok: "workflow" },
  { command: "workflows", description: "Grok /workflows — workflow dashboard", grok: "workflows" },
  // Other
  { command: "feedback", description: "Grok /feedback [message]", grok: "feedback" },
  { command: "grok_btw", description: "Grok /btw — aside without interrupting", grok: "btw" },
  { command: "mcps", description: "Grok /mcps — MCP servers modal", grok: "mcps" },
  { command: "doctor", description: "Grok /doctor — session diagnostics", grok: "doctor" },
  { command: "release_notes", description: "Grok /release-notes", grok: "release-notes" },
  { command: "docs", description: "Grok /docs — how-to guides", grok: "docs" },
  { command: "import_claude", description: "Grok /import-claude", grok: "import-claude" },
  { command: "config_agents", description: "Grok /config-agents — agent defs", grok: "config-agents" },
  { command: "personas", description: "Grok /personas — manage personas", grok: "personas" },
  { command: "login", description: "Grok /login — re-auth in session", grok: "login" },
  { command: "logout", description: "Grok /logout", grok: "logout" },
  { command: "grok_usage", description: "Grok /usage — credit/billing", grok: "usage" },
  { command: "privacy", description: "Grok /privacy — data/retention", grok: "privacy" },
  { command: "settings", description: "Grok /settings — config modal", grok: "settings" },
];

/** Resolve a Telegram command token (no slash) to a Grok shell command name. */
export function resolveGrokCommandName(telegramName: string): string {
  const name = telegramName.toLowerCase();
  const fromAlias = GROK_SLASH_ALIASES[name];
  if (fromAlias) return fromAlias;
  const fromMenu = GROK_FORWARDED_COMMANDS.find((c) => c.command === name);
  if (fromMenu) return fromMenu.grok;
  // underscore → hyphen for multi-word Grok commands (deep_research → deep-research)
  return name.replace(/_/g, "-");
}

/** True when a bare slash line should be forwarded to Grok (not a bot command). */
export function shouldForwardSlashToGrok(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("/") || t.includes("\n")) return false;
  // /cmd@botname args
  const m = t.match(/^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s|$)/);
  if (!m) return false;
  const name = m[1]!.toLowerCase();
  if (BOT_RESERVED_COMMANDS.has(name)) return false;
  return true;
}

/** Normalize Telegram `/view_plan foo` → Grok `/view-plan foo`. */
export function toGrokSlashLine(text: string): string {
  const t = text.trim();
  const m = t.match(/^\/([A-Za-z0-9_]+)(@\w+)?([\s\S]*)$/);
  if (!m) return t;
  const rest = m[3] ?? "";
  const name = resolveGrokCommandName(m[1]!);
  return `/${name}${rest}`;
}

export async function submitGrokSlash(ctx: Context, deps: BotDeps, line: string): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const rt = deps.registry.get(chatId);
  const grokLine = toGrokSlashLine(line);
  try {
    // Prefer dedicated ACP command RPC when the agent supports it; fall back to
    // session/prompt (Grok slash_exec parses leading / in the prompt).
    if (rt.sessionId) {
      try {
        await deps.acp.executeCommand(rt.sessionId, grokLine);
        await ctx.reply(`\u25B6\uFE0F Sent to Grok: \`${grokLine}\``, { parse_mode: "Markdown" });
        return;
      } catch (err) {
        log.debug(
          `executeCommand failed for ${grokLine}: ${(err as Error).message}; falling back to prompt`,
        );
      }
    }
    const outcome = await rt.submit(textPrompt(grokLine, ctx.message?.message_id, extractReplyContext(ctx)));
    if (outcome === "queued") {
      await ctx.reply(
        `\u{1F4E5} Queued (position ${rt.queueLength}): \`${grokLine}\` \u2014 runs after the current turn.`,
        { parse_mode: "Markdown" },
      );
    } else {
      await ctx.reply(`\u25B6\uFE0F Running \`${grokLine}\`\u2026`, { parse_mode: "Markdown" });
    }
  } catch (err) {
    log.warn(`grok slash failed: ${(err as Error).message}`);
    await ctx.reply(`\u274C Could not run \`${grokLine}\`: ${(err as Error).message}`, {
      parse_mode: "Markdown",
    });
  }
}

export function registerGrokSlash(bot: Bot, deps: BotDeps): void {
  // Explicit Telegram commands for advertised Grok builtins (appear in menu).
  for (const def of GROK_FORWARDED_COMMANDS) {
    if (BOT_RESERVED_COMMANDS.has(def.command)) continue;
    bot.command(def.command, async (ctx) => {
      const args = (ctx.match || "").toString();
      const line = args ? `/${def.command} ${args}` : `/${def.command}`;
      await submitGrokSlash(ctx, deps, line);
    });
  }
}
