/**
 * /killall — terminate all active Grok sessions running on this PC (the ones
 * holding a live session lock), excluding the bot's own agent process. Guarded
 * by an inline confirmation since it kills processes.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { killPid } from "../../sessions/process.js";
import type { SessionMeta } from "../../sessions/types.js";
import type { BotDeps } from "../deps.js";

function targets(deps: BotDeps): SessionMeta[] {
  const self = deps.acp.pid;
  return deps.store.listActive().filter((s) => s.lockPid && s.lockPid !== self);
}

export async function showKillConfirm(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.ephemeral.open(ctx);
  const active = targets(deps);
  if (active.length === 0) {
    await deps.ephemeral.reply(ctx, "\u2705 No other active Grok sessions to kill.");
    return;
  }
  const list = active
    .slice(0, 12)
    .map((s) => `\u2022 ${s.title.slice(0, 40)} (pid ${s.lockPid})`)
    .join("\n");
  const kb = new InlineKeyboard()
    .text(`\u{1F6D1} Kill ${active.length}`, "killall:confirm")
    .text("Cancel", "killall:cancel");
  await deps.ephemeral.reply(
    ctx,
    `\u{1F6D1} Kill ${active.length} active session(s)?\n${list}\n\n(The bot's own session is excluded.)`,
    { reply_markup: kb },
  );
}

export function registerKill(bot: Bot, deps: BotDeps): void {
  bot.command("killall", (ctx) => showKillConfirm(ctx, deps));

  bot.callbackQuery("killall:cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Cancelled.").catch(() => {});
  });

  bot.callbackQuery("killall:confirm", async (ctx) => {
    await ctx.answerCallbackQuery();
    const active = targets(deps);
    let killed = 0;
    for (const s of active) {
      if (s.lockPid && killPid(s.lockPid)) killed++;
    }
    await ctx.editMessageText(`\u{1F6D1} Killed ${killed} of ${active.length} active session(s).`).catch(() => {});
  });
}
