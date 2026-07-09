/**
 * /history — show the latest messages of the current (or a chosen) session.
 */
import type { Bot } from "grammy";
import { basename } from "node:path";
import type { BotDeps } from "../deps.js";
import { readHistory } from "../../sessions/history.js";
import { sessionHashtags } from "../../render/hashtags.js";
import type { SessionMeta } from "../../sessions/types.js";
import { sendMarkdownDoc } from "../telegram-io.js";

const ENTRY_MAX = 700;
const ROLE_ICON: Record<string, string> = {
  user: "\u{1F464}",
  assistant: "\u{1F916}",
  tool: "\u{1F527}",
  system: "\u2139\uFE0F",
};

export function registerHistory(bot: Bot, deps: BotDeps): void {
  bot.command("history", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    if (!rt.sessionId) {
      await ctx.reply("No active session. Use /sessions or send a message first.");
      return;
    }
    const meta = deps.store.get(rt.sessionId);
    await showHistory(deps, ctx.chat.id, rt.sessionId, meta, 16, rt.tags);
  });
}

/** Render and send the recent history of a session. */
export async function showHistory(
  deps: BotDeps,
  chatId: number,
  sessionId: string,
  meta?: SessionMeta,
  count = 16,
  tags?: string,
): Promise<void> {
  const entries = readHistory(deps.store.jsonlPath(sessionId), count);
  if (entries.length === 0) {
    await deps.api.sendMessage(chatId, "No history found for this session yet.");
    return;
  }
  const title = meta?.title || sessionId.slice(0, 8);
  const proj = meta?.cwd ? basename(meta.cwd) : "";
  const header = `\u{1F4DC} **History** \u2014 ${title}${proj ? ` (${proj})` : ""}`;

  const body = entries
    .map((e) => {
      const icon = ROLE_ICON[e.role] ?? "\u2022";
      let text = e.text.length > ENTRY_MAX ? e.text.slice(0, ENTRY_MAX) + " …" : e.text;
      if (e.role === "tool" && e.tool) text = `\`${e.tool}\` ${text}`;
      return `${icon} ${text}`;
    })
    .join("\n\n");

  // Every AI-output surface carries the session's searchable hashtags. A static
  // view (no live runtime) tags at least project + session id.
  const footer = tags ?? sessionHashtags({ cwd: meta?.cwd, sessionId });
  await sendMarkdownDoc(deps.api, chatId, `${header}\n\n${body}\n\n${footer}`);
}
