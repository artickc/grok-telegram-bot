/**
 * Control commands: /start /help /status /new /cancel /btw /flush.
 */
import type { Bot } from "grammy";
import { basename } from "node:path";
import { textPrompt } from "../../app/types.js";
import type { BotDeps } from "../deps.js";
import { HELP_TEXT } from "../commands.js";
import { compactKeyboard } from "../menu/keyboard.js";
import { refreshMenu } from "../menu/refresh.js";
import { extractReplyContext } from "../reply-context.js";
import { resolveScope } from "../scope.js";
import { openMainMenu } from "./menu.js";

export function registerControl(bot: Bot, deps: BotDeps): void {
  bot.command("start", async (ctx) => {
    const agent = deps.acp.agentInfo;
    const lines = [
      "\u{1F44B} Welcome! I bridge Telegram to Grok Build over ACP.",
      agent?.name ? `Connected to ${agent.name} ${agent.version ?? ""}`.trim() : "",
      "",
      "Tap \u2630 Menu for everything. A live status panel appears while I work",
      "(\u2630 Menu \u2192 Status shows it anytime). Just send a message to start.",
    ].filter(Boolean);
    await ctx.reply(lines.join("\n"), { reply_markup: compactKeyboard() });
    await deps.statusPanel.refresh(ctx.chat.id);
  });

  bot.command("menu", async (ctx) => {
    await openMainMenu(ctx, deps);
    await deps.statusPanel.refresh(ctx.chat.id);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  bot.command("status", async (ctx) => {
    const scope = resolveScope(ctx, deps);
    const rt = scope.rt;
    const lines = [
      "\u{1F4CA} Status",
      scope.isForum ? `Topic: ${scope.projectName ?? "topic"}` : "",
      `Project: ${rt.projectName ?? (basename(rt.cwd) || rt.cwd)}`,
      `Folder: ${rt.cwd}`,
      `Session: ${rt.sessionId ?? "(none yet)"}`,
      `Model: ${rt.model || "default"}`,
      `Reasoning: ${rt.reasoning}`,
      `State: ${rt.isBusy ? "\u23F3 working" : "\u2705 idle"}`,
      `Queued follow-ups: ${rt.queueLength}`,
    ].filter(Boolean);
    const subagents = deps.registry.subagentSummaryForChat(ctx.chat.id);
    if (subagents) lines.push(`Subagents: ${subagents}`);
    await ctx.reply(lines.join("\n"), scope.threadExtra);
  });

  bot.command("new", async (ctx) => {
    const scope = resolveScope(ctx, deps);
    try {
      await scope.controller.addNew(scope.rt.cwd, scope.rt.projectName);
      await refreshMenu(ctx, deps, `\u2728 New session started in ${scope.rt.projectName ?? scope.rt.cwd}`);
    } catch (err) {
      await ctx.reply(`\u274C Could not start session: ${(err as Error).message}`, scope.threadExtra);
    }
  });

  bot.command("cancel", async (ctx) => {
    const scope = resolveScope(ctx, deps);
    const cancelled = await scope.rt.cancel();
    await ctx.reply(
      cancelled ? "\u23F9 Cancelling current turn\u2026" : "Nothing is running.",
      scope.threadExtra,
    );
  });

  bot.command("btw", async (ctx) => {
    const text = (ctx.match || "").toString().trim();
    if (!text) {
      await ctx.reply("Usage: /btw <something for the agent to do — now if idle, otherwise next>");
      return;
    }
    const scope = resolveScope(ctx, deps);
    const outcome = await scope.rt.submit(textPrompt(text, undefined, extractReplyContext(ctx)));
    if (outcome === "queued") {
      await ctx.reply(
        `\u{1F4E5} Queued (position ${scope.rt.queueLength}) \u2014 it'll run automatically as soon as the current task finishes.`,
        scope.threadExtra,
      );
    } else {
      await ctx.reply("\u25B6\uFE0F On it\u2026", scope.threadExtra);
    }
  });

  bot.command("flush", async (ctx) => {
    const scope = resolveScope(ctx, deps);
    const rt = scope.rt;
    if (rt.queueLength === 0) {
      await ctx.reply("Queue is empty.", scope.threadExtra);
      return;
    }
    if (rt.isBusy) {
      await ctx.reply(
        `\u23F3 ${rt.queueLength} queued \u2014 they'll run automatically when the current turn ends.`,
        scope.threadExtra,
      );
      return;
    }
    await ctx.reply("\u25B6\uFE0F Running queued follow-ups\u2026", scope.threadExtra);
    const drained = rt.drainQueueToPrompt();
    if (drained) await rt.submit(drained);
  });
}
