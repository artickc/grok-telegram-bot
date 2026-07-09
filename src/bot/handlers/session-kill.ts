/**
 * Per-session kill — terminate the OS process holding a live session's `.lock`
 * straight from its card in /sessions or /active.
 *
 * Flow (callback data, UUID-keyed so it survives bot restarts):
 *   killsess:<id>          a tap on the card's 🛑 Kill button → ask to confirm
 *   killsess:do:<id>       confirmed → kill the lockPid, report the outcome
 *   killsess:cancel:<id>   abort → restore the card's normal buttons
 *
 * Guards: the bot's own agent (acp.pid) is never killable here (its card never
 * shows the button, and the handlers re-check), and state is re-read from disk
 * at every step so a session that already stopped can't be "killed" twice.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { killPid } from "../../sessions/process.js";
import type { SessionMeta } from "../../sessions/types.js";
import type { BotDeps } from "../deps.js";
import { buildSessionCard } from "./session-card.js";

const UUID = "([0-9a-fA-F-]{36})";

/** Rebuild the standard card keyboard for the freshest on-disk session state. */
function cardKeyboard(deps: BotDeps, meta: SessionMeta): InlineKeyboard {
  const contextPct = deps.acp.metadataFor(meta.sessionId)?.contextUsagePercentage;
  return buildSessionCard(meta, { contextPct, selfPid: deps.acp.pid }).keyboard;
}

/** Re-read the session and decide whether its PID may be killed right now. */
function killable(
  deps: BotDeps,
  id: string,
): { ok: true; meta: SessionMeta; pid: number } | { ok: false; meta?: SessionMeta; reason: string } {
  const meta = deps.store.get(id);
  if (!meta) return { ok: false, reason: "Session not found." };
  if (!meta.active || typeof meta.lockPid !== "number") {
    return { ok: false, meta, reason: "Session is no longer running." };
  }
  if (meta.lockPid === deps.acp.pid) {
    return { ok: false, meta, reason: "That's the bot's own agent — can't kill it." };
  }
  return { ok: true, meta, pid: meta.lockPid };
}

export function registerSessionKill(bot: Bot, deps: BotDeps): void {
  // Step 1 — ask to confirm. Swap the card's buttons for a Kill/Cancel row.
  bot.callbackQuery(new RegExp(`^killsess:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    const check = killable(deps, id);
    if (!check.ok) {
      await ctx.answerCallbackQuery({ text: check.reason });
      // The button is stale (session stopped); refresh it to the normal card.
      if (check.meta) await ctx.editMessageReplyMarkup({ reply_markup: cardKeyboard(deps, check.meta) }).catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text(`\u{1F6D1} Kill pid ${check.pid}`, `killsess:do:${id}`)
      .text("\u21A9 Cancel", `killsess:cancel:${id}`);
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
  });

  // Step 2a — confirmed. Re-validate (it may have died meanwhile), then kill.
  bot.callbackQuery(new RegExp(`^killsess:do:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    const check = killable(deps, id);
    if (!check.ok) {
      await ctx.answerCallbackQuery({ text: check.reason });
      await appendStatus(ctx, check.reason);
      return;
    }
    const title = check.meta.title;
    const ok = killPid(check.pid);
    await ctx.answerCallbackQuery({ text: ok ? "Killed" : "Kill failed" });
    const note = ok
      ? `\u{1F6D1} Killed ${title} (pid ${check.pid}).`
      : `\u26A0\uFE0F Could not kill pid ${check.pid} (already gone, or not permitted).`;
    await appendStatus(ctx, note);
  });

  // Step 2b — cancelled. Put the card's normal buttons back.
  bot.callbackQuery(new RegExp(`^killsess:cancel:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    const meta = deps.store.get(id);
    if (meta) await ctx.editMessageReplyMarkup({ reply_markup: cardKeyboard(deps, meta) }).catch(() => {});
    else await ctx.editMessageReplyMarkup().catch(() => {});
  });
}

/** Append a one-line status under the card and drop its keyboard. */
async function appendStatus(ctx: Context, note: string): Promise<void> {
  const body = ctx.callbackQuery?.message?.text;
  const text = body ? `${body}\n\n${note}` : note;
  await ctx.editMessageText(text).catch(() => {});
}
