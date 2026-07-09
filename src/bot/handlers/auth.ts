/**
 * /reauth — sign in to Grok from chat. Shows Sign in (runs `grok login`,
 * streaming any URL/code) or Import existing, then re-binds the agent. Guarded:
 * refused while a turn is in flight.
 */
import type { Bot } from "grammy";
import type { BotDeps } from "../deps.js";
import { ReauthController } from "../reauth-controller.js";

export function registerReauth(bot: Bot, deps: BotDeps): void {
  const controller = new ReauthController(
    deps.api,
    deps.acp,
    deps.cfg.grokCliPath,
    () => deps.usage.account(),
    () => deps.usage.isLoggedIn(),
  );

  bot.command("reauth", async (ctx) => {
    if (controller.isBusy(ctx.chat.id)) {
      await ctx.reply("\u{1F510} A sign-in is already in progress.");
      return;
    }
    if (deps.acp.hasInflightPrompt()) {
      await ctx.reply("\u23F3 Grok is busy running a turn — try /reauth when idle (or /cancel first).");
      return;
    }
    await controller.chooseMethod(ctx.chat.id);
  });

  bot.callbackQuery("reauth:login", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Signing in…" });
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId !== undefined && messageId !== undefined) await controller.beginLogin(chatId, messageId);
  });

  bot.callbackQuery("reauth:import", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Importing…" });
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId !== undefined && messageId !== undefined) await controller.importExisting(chatId, messageId);
  });

  bot.callbackQuery("reauth:choose-cancel", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId !== undefined && messageId !== undefined) await controller.cancelChoice(chatId, messageId);
  });

  bot.callbackQuery("reauth:cancel", async (ctx) => {
    const chatId = ctx.chat?.id;
    const ok = chatId !== undefined && controller.cancel(chatId);
    await ctx.answerCallbackQuery({ text: ok ? "Cancelling…" : "Nothing to cancel" });
  });

  bot.callbackQuery("reauth:retry", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Retry" });
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId !== undefined && messageId !== undefined) await controller.retry(chatId, messageId);
  });
}
