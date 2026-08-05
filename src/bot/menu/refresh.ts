/**
 * Sends a short message that (re)shows the compact bar and refreshes the pinned
 * status panel (where the live project/agent/model/reasoning state is shown).
 */
import type { Context } from "grammy";
import type { BotDeps } from "../deps.js";
import { resolveScope } from "../scope.js";
import { compactKeyboard } from "./keyboard.js";

export async function refreshMenu(ctx: Context, deps: BotDeps, text: string): Promise<void> {
  const chatId = ctx.chat!.id;
  const scope = resolveScope(ctx, deps);
  await ctx.reply(text, { reply_markup: compactKeyboard(), ...scope.threadExtra });
  await deps.statusPanel.refresh(chatId);
}
