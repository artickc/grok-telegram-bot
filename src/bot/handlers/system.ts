/**
 * System commands: /queue /clearqueue /model /restart.
 */
import type { Bot } from "grammy";
import type { BotDeps } from "../deps.js";

export function registerSystem(bot: Bot, deps: BotDeps): void {
  bot.command("queue", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    if (rt.queueLength === 0) {
      await ctx.reply("Queue is empty. Send a message while I'm busy, or use /btw <text>.");
      return;
    }
    await ctx.reply(`\u{1F4E5} ${rt.queueLength} follow-up(s) queued. They run automatically after the current turn, or use /flush.`);
  });

  bot.command("clearqueue", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    const n = rt.clearQueue();
    await ctx.reply(n > 0 ? `\u{1F5D1} Cleared ${n} queued message(s).` : "Queue was already empty.");
  });

  bot.command("model", async (ctx) => {
    const modelId = (ctx.match || "").toString().trim();
    const rt = deps.registry.get(ctx.chat.id);
    if (!modelId) {
      await ctx.reply("Usage: /model <model-id>  (changes the model for the current session)");
      return;
    }
    if (!rt.sessionId) {
      await ctx.reply("No active session yet. Send a message or pick a /projects folder first.");
      return;
    }
    try {
      await deps.acp.setModel(rt.sessionId, modelId);
      await ctx.reply(`\u2705 Model set to \`${modelId}\` for this session.`, { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.reply(`\u274C Could not set model: ${(err as Error).message}`);
    }
  });

  bot.command("restart", async (ctx) => {
    await ctx.reply("\u{1F501} Restarting the Grok agent\u2026");
    try {
      await deps.acp.restart();
      await ctx.reply("\u2705 Grok agent restarted. Your session will re-bind on the next message.");
    } catch (err) {
      await ctx.reply(`\u274C Restart failed: ${(err as Error).message}`);
    }
  });
}
