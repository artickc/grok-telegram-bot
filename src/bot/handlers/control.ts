/**
 * Control commands: /start /help /status /new /cancel /stop /btw /flush /menu.
 *
 * Slash messages are deleted instantly by bot.ts middleware; handlers post
 * bot status messages so the user always sees the bot is alive (CLI can be slow).
 */
import type { Bot, Context } from "grammy";
import { basename } from "node:path";
import { textPrompt } from "../../app/types.js";
import type { BotDeps } from "../deps.js";
import { HELP_TEXT } from "../commands.js";
import { compactKeyboard } from "../menu/keyboard.js";
import { refreshMenu } from "../menu/refresh.js";
import { adoptUserPrompt } from "../prompt-anchor.js";
import { extractReplyContext } from "../reply-context.js";
import { resolveScope } from "../scope.js";
import { openMainMenu } from "./menu.js";

export function registerControl(bot: Bot, deps: BotDeps): void {
  bot.command("start", async (ctx) => {
    const scope = resolveScope(ctx, deps);
    const agent = deps.acp.agentInfo;
    const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
    const lines = [
      "\u{1F44B} Welcome! I bridge Telegram to Grok Build over ACP.",
      agent?.name ? `Connected to ${agent.name} ${agent.version ?? ""}`.trim() : "",
      "",
      isGroup || scope.isForum
        ? "In groups / topics: /menu for controls, /cancel or /stop to halt a turn."
        : "Bar: \u2630 Menu \u00B7 \u{1F195} New session \u00B7 \u{1F9ED} Running \u00B7 \u23F9 Stop. Live status panel while I work",
      isGroup || scope.isForum
        ? "Just send a message in this topic to start."
        : "(\u2630 Menu \u2192 Status shows it anytime). Just send a message to start.",
    ].filter(Boolean);
    await ctx.reply(lines.join("\n"), {
      reply_markup: compactKeyboard(),
      ...scope.threadExtra,
    });
    await deps.statusPanel.refresh(ctx.chat.id);
  });

  bot.command("menu", async (ctx) => {
    await openMainMenu(ctx, deps);
    await deps.statusPanel.refresh(ctx.chat.id);
  });

  bot.command("help", async (ctx) => {
    const scope = resolveScope(ctx, deps);
    await ctx.reply(HELP_TEXT, scope.threadExtra);
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
    // Instant feedback before ACP session/new (can be slow on cold CLI).
    // Same copy as bar 🆕 New and inline m:new.
    await ctx.reply("\u2728 Creating new session\u2026", scope.threadExtra).catch(() => {});
    try {
      await scope.controller.addNew(scope.rt.cwd, scope.rt.projectName);
      await refreshMenu(ctx, deps, `\u2728 New session in ${scope.rt.projectName ?? scope.rt.cwd}`);
    } catch (err) {
      await ctx.reply(`\u274C ${(err as Error).message}`, scope.threadExtra);
    }
  });

  const cancelTurn = async (ctx: Context): Promise<void> => {
    const scope = resolveScope(ctx, deps);
    const cancelled = await scope.rt.cancel();
    await ctx.reply(
      cancelled ? "\u23F9 Cancelling current turn\u2026" : "Nothing is running.",
      scope.threadExtra,
    );
  };

  bot.command("cancel", cancelTurn);
  bot.command("stop", cancelTurn);

  bot.command("btw", async (ctx) => {
    const text = (ctx.match || "").toString().trim();
    if (!text) {
      const scope = resolveScope(ctx, deps);
      await ctx.reply(
        "Usage: /btw <something for the agent to do — now if idle, otherwise next>",
        scope.threadExtra,
      );
      return;
    }
    const scope = resolveScope(ctx, deps);
    const userMsgId = ctx.message?.message_id;
    const anchor = await adoptUserPrompt(deps.api, {
      chatId: ctx.chat.id,
      text,
      // Command middleware already deleted the slash message; re-delete is a no-op.
      userMessageIds: userMsgId !== undefined ? [userMsgId] : [],
      messageThreadId: scope.threadExtra.message_thread_id,
      projectName: scope.rt.projectName,
      prefix: "\u{1F4DD} /btw",
    });
    // Fall back to userMsgId if anchor send failed (message may already be gone).
    const outcome = await scope.rt.submit(
      textPrompt(text, anchor?.replyTo ?? userMsgId, extractReplyContext(ctx), {
        promptId: anchor?.promptId,
      }),
    );
    if (outcome === "queued") {
      const extra: Record<string, unknown> = { ...scope.threadExtra };
      if (anchor?.replyTo !== undefined) {
        extra.reply_parameters = {
          message_id: anchor.replyTo,
          allow_sending_without_reply: true,
        };
      }
      await ctx.reply(
        `\u{1F4E5} Queued (position ${scope.rt.queueLength}) \u2014 it'll run automatically as soon as the current task finishes.`,
        extra,
      );
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
