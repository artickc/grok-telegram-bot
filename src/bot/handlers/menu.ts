/**
 * Menu handler — maps the persistent reply-keyboard buttons (matched by emoji
 * prefix for stateful ones) to actions, and provides inline submenus for
 * Reasoning and Model. Changing a value re-renders the keyboard so its labels
 * always reflect the current state.
 *
 * The Agent picker was removed: Grok has no useful headless agent switch, and
 * plan mode is entered automatically when the agent judges a task complex.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { reasoningLabel } from "../../app/reasoning.js";
import { REASONING_LEVELS, type ReasoningEffort } from "../../app/types.js";
import type { BotDeps } from "../deps.js";
import { BAR_LABELS, compactKeyboard, mainMenuInline, MENU_BTN, RUNNING_BTN, STOP_BTN } from "../menu/keyboard.js";
import { refreshMenu } from "../menu/refresh.js";
import { resolveScope } from "../scope.js";
import { showImportSources } from "./import-session.js";
import { showKillConfirm } from "./kill.js";
import { showMcp } from "./mcp.js";
import { showProjects } from "./projects.js";
import { showRunning } from "./running.js";
import { showAccounts } from "./accounts.js";
import { showSessions } from "./sessions.js";
import { showTasks } from "./tasks.js";
import { showUsage } from "./usage.js";

/** Open the full inline menu, showing the current model/reasoning (topic-aware). */
export async function openMainMenu(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.ephemeral.open(ctx);
  const scope = resolveScope(ctx, deps);
  const preferred = scope.rt.preferredAccountId;
  const saved = preferred
    ? deps.accounts.list().find((a) => a.id === preferred || a.loginId === preferred)
    : undefined;
  const accountLabel = saved?.label || preferred?.slice(0, 12) || undefined;
  const title = scope.isForum
    ? `\u2699\uFE0F Topic menu \u00B7 ${scope.projectName ?? "topic"}`
    : "\u2699\uFE0F Menu";
  await deps.ephemeral.reply(ctx, title, {
    reply_markup: mainMenuInline({
      model: scope.rt.model || "default",
      reasoning: reasoningLabel(scope.rt.reasoning),
      forumTopic: scope.isForum
        ? { name: scope.projectName ?? "Topic", account: accountLabel }
        : undefined,
    }),
  });
}

export function registerMenu(bot: Bot, deps: BotDeps): void {
  // Compact persistent bar.
  bot.hears(BAR_LABELS, async (ctx) => {
    deps.wizard.abort(ctx.chat.id);
    const scope = resolveScope(ctx, deps);
    switch (ctx.message?.text) {
      case MENU_BTN:
        return openMainMenu(ctx, deps);
      case RUNNING_BTN:
        return showRunning(ctx, deps);
      case STOP_BTN: {
        return void ctx.reply(
          (await scope.rt.cancel()) ? "\u23F9 Cancelling\u2026" : "Nothing is running.",
          scope.threadExtra,
        );
      }
    }
  });

  // Inline menu actions.
  bot.callbackQuery(/^m:(\w+)$/, (ctx) => dispatchMenu(ctx, deps, ctx.match![1]!));

  // ── Reasoning ──────────────────────────────────────────────────────────────
  bot.callbackQuery(/^reason:(minimal|low|medium|high|max)$/, async (ctx) => {
    const level = ctx.match![1] as ReasoningEffort;
    resolveScope(ctx, deps).rt.setReasoningPref(level);
    await confirm(ctx, deps, `\u{1F9E0} Reasoning: ${reasoningLabel(level)}`);
  });

  // ── Model ────────────────────────────────────────────────────────────────
  bot.callbackQuery(/^model:set:(\d+)$/, async (ctx) => {
    const entry = deps.acp.availableModels[Number(ctx.match![1])];
    if (!entry) return void ctx.answerCallbackQuery({ text: "Expired, tap Model again." });
    await ctx.answerCallbackQuery({ text: `\u{1F9E9} Model: ${entry.name}` });
    const res = await resolveScope(ctx, deps).rt.setModelPref(entry.modelId);
    if (!res.ok) {
      await ctx.reply(`\u26A0\uFE0F Model set failed: ${res.error}`, resolveScope(ctx, deps).threadExtra).catch(() => {});
    }
    await confirmUi(ctx, deps);
  });
  bot.callbackQuery("model:clear", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "\u{1F9E9} Model: default" });
    await resolveScope(ctx, deps).rt.setModelPref("");
    await confirmUi(ctx, deps);
  });
}

/** Dispatch an inline-menu action (`m:<action>`). */
async function dispatchMenu(ctx: Context, deps: BotDeps, action: string): Promise<void> {
  const scope = resolveScope(ctx, deps);
  const { chatId, rt, controller, threadExtra, isForum, projectName, projectPath } = scope;
  switch (action) {
    case "close":
      await ctx.answerCallbackQuery();
      return void ctx.deleteMessage().catch(() => {});
    case "topicinfo":
      await ctx.answerCallbackQuery();
      return void deps.ephemeral.reply(
        ctx,
        `\u{1F4C1} **Topic project**\n${projectName ?? "?"}\n\`${projectPath ?? rt.cwd}\`\n\n` +
          `Model / reasoning / running sessions on this menu are for **this topic only**.`,
      );
    case "hidebar":
      await ctx.answerCallbackQuery();
      await ctx.deleteMessage().catch(() => {});
      return void ctx.reply("\u{1F648} Bar hidden \u2014 send /menu to bring it back.", {
        reply_markup: { remove_keyboard: true },
        ...threadExtra,
      });
    case "showbar":
      await ctx.answerCallbackQuery();
      return void ctx.reply("\u2328\uFE0F Bar restored.", {
        reply_markup: compactKeyboard(),
        ...threadExtra,
      });
    case "project":
      if (isForum) {
        await ctx.answerCallbackQuery({ text: "Project is fixed to this topic", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery();
      return showProjects(ctx, deps);
    case "running":
      await ctx.answerCallbackQuery();
      return showRunning(ctx, deps);
    case "sessions":
      await ctx.answerCallbackQuery();
      return showSessions(ctx, deps);
    case "import":
      await ctx.answerCallbackQuery();
      return showImportSources(ctx, deps);
    case "tasks":
      await ctx.answerCallbackQuery();
      return showTasks(ctx, deps);
    case "agent":
      // Legacy callback from old keyboards.
      await ctx.answerCallbackQuery({
        text: "Agent menu removed — Grok picks sub-agents automatically",
        show_alert: true,
      });
      return openMainMenu(ctx, deps);
    case "model":
      await ctx.answerCallbackQuery();
      return showModelMenu(ctx, deps);
    case "reasoning":
      await ctx.answerCallbackQuery();
      return showReasoningMenu(ctx, deps);
    case "status":
      await ctx.answerCallbackQuery();
      await deps.statusPanel.refresh(chatId);
      await deps.ephemeral.open(ctx);
      return void deps.ephemeral.reply(ctx, deps.statusPanel.render(chatId));
    case "usage":
      await ctx.answerCallbackQuery();
      return showUsage(ctx, deps);
    case "accounts":
      await ctx.answerCallbackQuery();
      return showAccounts(ctx, deps);
    case "mcp":
      await ctx.answerCallbackQuery();
      return showMcp(ctx, deps);
    case "killall":
      await ctx.answerCallbackQuery();
      return showKillConfirm(ctx, deps);
    case "new":
      await ctx.answerCallbackQuery();
      try {
        await controller.addNew(rt.cwd, rt.projectName);
        return refreshMenu(ctx, deps, `\u2728 New session in ${rt.projectName ?? rt.cwd}`);
      } catch (e) {
        return void ctx.reply(`\u274C ${(e as Error).message}`, threadExtra);
      }
    case "stop": {
      // Answer first so a slow cancel never times out the callback query.
      await ctx.answerCallbackQuery({ text: rt.isBusy ? "Cancelling\u2026" : "Nothing is running" });
      if (rt.isBusy) await rt.cancel();
      return;
    }
    default:
      return void ctx.answerCallbackQuery();
  }
}

async function confirm(ctx: Context, deps: BotDeps, text: string): Promise<void> {
  // Toast first (callback must be answered within ~seconds), then UI updates.
  await ctx.answerCallbackQuery({ text });
  await confirmUi(ctx, deps);
}

/** Refresh status + reopen the main menu after a preference change. */
async function confirmUi(ctx: Context, deps: BotDeps): Promise<void> {
  try {
    await ctx.deleteMessage();
  } catch {
    /* ignore */
  }
  await deps.statusPanel.refresh(ctx.chat!.id);
  await openMainMenu(ctx, deps); // reopen so the new value is visible
}

async function showReasoningMenu(ctx: Context, deps: BotDeps): Promise<void> {
  const rt = resolveScope(ctx, deps).rt;
  await deps.ephemeral.open(ctx);
  const kb = new InlineKeyboard();
  REASONING_LEVELS.forEach((l) => kb.text(`${l === rt.reasoning ? "\u2713 " : ""}${reasoningLabel(l)}`, `reason:${l}`));
  await deps.ephemeral.reply(ctx, `Current reasoning: ${reasoningLabel(rt.reasoning)}\nChoose effort:`, {
    reply_markup: kb,
  });
}

async function showModelMenu(ctx: Context, deps: BotDeps): Promise<void> {
  const rt = resolveScope(ctx, deps).rt;
  await ensureReady(ctx, rt);
  await deps.ephemeral.open(ctx);
  const models = deps.acp.availableModels;
  if (models.length === 0) {
    await deps.ephemeral.reply(
      ctx,
      "No selectable models reported by Grok yet \u2014 send a message first, then try again.",
    );
    return;
  }
  const current = rt.model || deps.acp.currentModelId;
  const kb = new InlineKeyboard();
  models.forEach((m, i) => kb.text(`${m.modelId === current ? "\u2713 " : ""}${m.name}`, `model:set:${i}`).row());
  kb.text("Default (agent's model)", "model:clear");
  await deps.ephemeral.reply(ctx, `Current model: ${rt.model || "default"}\nChoose a model:`, { reply_markup: kb });
}

/** Ensure a session is live so models/modes are populated; show typing meanwhile. */
async function ensureReady(ctx: Context, rt: { prepare: () => Promise<void> }): Promise<void> {
  try {
    await ctx.replyWithChatAction("typing");
  } catch {
    /* ignore */
  }
  try {
    await rt.prepare();
  } catch {
    /* menu will show whatever is available */
  }
}
