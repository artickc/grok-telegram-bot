/**
 * Forward Grok Build slash commands (e.g. /goal, /plan, /compact) into the
 * active ACP session as a prompt. Grok shell builtins are parsed from the
 * prompt text by slash_exec — they never reached the agent before because the
 * Telegram message handler treated unknown "/…" lines as typos.
 *
 * Bot-local commands (projects, sessions, reauth, …) stay reserved and are
 * handled by their own `bot.command` registrations.
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
    "reauth",
    "accounts",
    // Telegram-friendly aliases for multi-word Grok commands we register below
    // are NOT reserved — they are forwarded.
  ].map((c) => c.toLowerCase()),
);

/** Grok Build slash commands we advertise in the Telegram menu (subset). */
export const GROK_FORWARDED_COMMANDS: { command: string; description: string; grok: string }[] = [
  { command: "goal", description: "Grok /goal — set/status/pause/resume/clear", grok: "goal" },
  { command: "plan", description: "Grok /plan — enter plan mode", grok: "plan" },
  { command: "view_plan", description: "Grok /view-plan — show saved plan", grok: "view-plan" },
  { command: "compact", description: "Grok /compact — compress context", grok: "compact" },
  { command: "context", description: "Grok /context — context window usage", grok: "context" },
  { command: "deep_research", description: "Grok /deep-research <query>", grok: "deep-research" },
  { command: "workflow", description: "Grok /workflow — run/manage workflow", grok: "workflow" },
  { command: "workflows", description: "Grok /workflows — workflow dashboard", grok: "workflows" },
  { command: "remember", description: "Grok /remember <note>", grok: "remember" },
  { command: "effort", description: "Grok /effort low|medium|high|xhigh", grok: "effort" },
  { command: "always_approve", description: "Grok /always-approve toggle", grok: "always-approve" },
  { command: "session_info", description: "Grok /session-info", grok: "session-info" },
  { command: "viewplan", description: "Alias for /view_plan", grok: "view-plan" },
  { command: "deepresearch", description: "Alias for /deep_research", grok: "deep-research" },
];

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
  let name = m[1]!.toLowerCase();
  const rest = m[3] ?? "";
  const alias = GROK_FORWARDED_COMMANDS.find((c) => c.command === name);
  if (alias) name = alias.grok;
  else {
    // underscore → hyphen for multi-word Grok commands (deep_research → deep-research)
    name = name.replace(/_/g, "-");
  }
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
  // Explicit Telegram commands for the popular Grok builtins (appear in menu).
  for (const def of GROK_FORWARDED_COMMANDS) {
    if (BOT_RESERVED_COMMANDS.has(def.command)) continue;
    bot.command(def.command, async (ctx) => {
      const args = (ctx.match || "").toString();
      const line = args ? `/${def.command} ${args}` : `/${def.command}`;
      await submitGrokSlash(ctx, deps, line);
    });
  }
}
