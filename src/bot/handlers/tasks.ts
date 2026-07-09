/**
 * /tasks — manage scheduled tasks (create, list, view, edit, delete, run now).
 * /newtask — start the creation wizard.
 *
 * A task is a prompt + a project + a schedule (once/daily/weekly/monthly/
 * interval). The scheduler runs it and delivers the result here.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { basename } from "node:path";
import type { BotDeps } from "../deps.js";
import { describeSchedule } from "../../tasks/schedule.js";
import type { Task } from "../../tasks/types.js";
import type { ScheduleType } from "../../tasks/types.js";
import type { WizardPrompt } from "../wizard/task-wizard.js";
import { sendProjectMenu } from "./projects.js";

const UUID = "([0-9a-fA-F-]{36})";

export async function showTasks(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.ephemeral.open(ctx);
  const { text, kb } = listView(deps, ctx.chat!.id);
  await deps.ephemeral.reply(ctx, text, { reply_markup: kb });
}

export async function renderWizardPrompt(ctx: Context, deps: BotDeps, p: WizardPrompt): Promise<void> {
  switch (p.kind) {
    case "text":
      await ctx.reply(p.text);
      return;
    case "project":
      await sendProjectMenu(ctx, deps, "wiz:proj:", p.text);
      return;
    case "scheduleType": {
      const kb = new InlineKeyboard()
        .text("Once", "wiz:sched:once")
        .text("Daily", "wiz:sched:daily")
        .row()
        .text("Weekly", "wiz:sched:weekly")
        .text("Monthly", "wiz:sched:monthly")
        .row()
        .text("Every N minutes", "wiz:sched:interval");
      await ctx.reply(p.text, { reply_markup: kb });
      return;
    }
    case "confirm": {
      const kb = new InlineKeyboard().text("\u2705 Save", "wiz:confirm").text("\u2716 Cancel", "wiz:cancel");
      await ctx.reply(p.text, { reply_markup: kb });
      return;
    }
    case "done":
      await ctx.reply(p.text);
      return;
    case "aborted":
      await ctx.reply("Cancelled.");
      return;
  }
}

/**
 * Wizard text-input interceptor. Registered BEFORE command/prompt handlers so
 * that, while a task wizard is active, free text feeds the wizard. A slash
 * command aborts the wizard and is allowed through.
 */
export function registerWizardInput(bot: Bot, deps: BotDeps): void {
  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat.id;
    if (!deps.wizard.isActive(chatId)) return next();
    const text = ctx.message.text;
    if (text.startsWith("/")) {
      deps.wizard.abort(chatId);
      return next();
    }
    const p = deps.wizard.handleText(chatId, text);
    if (p) await renderWizardPrompt(ctx, deps, p);
  });
}

export function registerTasks(bot: Bot, deps: BotDeps): void {
  bot.command("tasks", (ctx) => showTasks(ctx, deps));
  bot.command("newtask", async (ctx) => {
    await renderWizardPrompt(ctx, deps, deps.wizard.startCreate(ctx.chat.id));
  });

  bot.callbackQuery("task:new", async (ctx) => {
    await ctx.answerCallbackQuery();
    await renderWizardPrompt(ctx, deps, deps.wizard.startCreate(ctx.chat!.id));
  });

  bot.callbackQuery(new RegExp(`^task:view:${UUID}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    const task = deps.tasks.get(ctx.match![1]!);
    if (!task) return void ctx.editMessageText("Task not found.");
    const { text, kb } = detailView(task);
    await ctx.editMessageText(text, { reply_markup: kb });
  });

  bot.callbackQuery("task:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { text, kb } = listView(deps, ctx.chat!.id);
    await ctx.editMessageText(text, { reply_markup: kb });
  });

  bot.callbackQuery(new RegExp(`^task:toggle:${UUID}$`), async (ctx) => {
    const task = deps.tasks.get(ctx.match![1]!);
    if (!task) return void ctx.answerCallbackQuery({ text: "Not found" });
    const updated = deps.tasks.update(task.id, { enabled: !task.enabled });
    await ctx.answerCallbackQuery({ text: updated?.enabled ? "Enabled" : "Disabled" });
    if (updated) {
      const { text, kb } = detailView(updated);
      await ctx.editMessageText(text, { reply_markup: kb });
    }
  });

  bot.callbackQuery(new RegExp(`^task:run:${UUID}$`), async (ctx) => {
    const task = deps.tasks.get(ctx.match![1]!);
    if (!task) return void ctx.answerCallbackQuery({ text: "Not found" });
    await ctx.answerCallbackQuery({ text: "Running now\u2026" });
    void deps.taskRunner.run(task);
  });

  bot.callbackQuery(new RegExp(`^task:del:${UUID}$`), async (ctx) => {
    deps.tasks.delete(ctx.match![1]!);
    await ctx.answerCallbackQuery({ text: "Deleted" });
    const { text, kb } = listView(deps, ctx.chat!.id);
    await ctx.editMessageText(text, { reply_markup: kb });
  });

  bot.callbackQuery(new RegExp(`^task:editmenu:${UUID}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    const task = deps.tasks.get(ctx.match![1]!);
    if (!task) return;
    await ctx.editMessageText(`Edit "${task.name}" — choose what to change:`, {
      reply_markup: editMenu(task.id),
    });
  });

  bot.callbackQuery(new RegExp(`^task:edit:(name|prompt|project|schedule):${UUID}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    const field = ctx.match![1] as "name" | "prompt" | "project" | "schedule";
    const p = deps.wizard.startEdit(ctx.chat!.id, ctx.match![2]!, field);
    if (p) await renderWizardPrompt(ctx, deps, p);
    else await ctx.reply("Task not found.");
  });

  // ── wizard inline steps ────────────────────────────────────────────────
  bot.callbackQuery(/^wiz:proj:(\d+)$/, async (ctx) => {
    const entry = deps.menuCache.getProject(ctx.chat!.id, Number(ctx.match![1]));
    if (!entry) return void ctx.answerCallbackQuery({ text: "Expired, restart the task." });
    await ctx.answerCallbackQuery();
    const p = deps.wizard.setProject(ctx.chat!.id, entry.path, entry.name);
    if (p) await renderWizardPrompt(ctx, deps, p);
  });

  bot.callbackQuery(/^wiz:sched:(once|daily|weekly|monthly|interval)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = deps.wizard.setScheduleType(ctx.chat!.id, ctx.match![1] as ScheduleType);
    if (p) await renderWizardPrompt(ctx, deps, p);
  });

  bot.callbackQuery("wiz:confirm", async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = deps.wizard.confirm(ctx.chat!.id);
    if (p) await renderWizardPrompt(ctx, deps, p);
  });

  bot.callbackQuery("wiz:cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    deps.wizard.abort(ctx.chat!.id);
    await ctx.editMessageText("Cancelled.");
  });
}

// ── views ────────────────────────────────────────────────────────────────

function listView(deps: BotDeps, chatId: number): { text: string; kb: InlineKeyboard } {
  const tasks = deps.tasks.forChat(chatId);
  const kb = new InlineKeyboard();
  if (tasks.length === 0) {
    kb.text("\u2795 New task", "task:new");
    return { text: "You have no scheduled tasks yet.", kb };
  }
  for (const t of tasks) {
    const dot = t.enabled ? "\u{1F7E2}" : "\u26AA";
    const name = t.name.length > 24 ? t.name.slice(0, 24) + "\u2026" : t.name;
    kb.text(`${dot} ${name} \u00B7 ${describeSchedule(t.schedule)}`, `task:view:${t.id}`).row();
  }
  kb.text("\u2795 New task", "task:new");
  return { text: `\u{1F5D3} Your scheduled tasks (${tasks.length}):`, kb };
}

function detailView(t: Task): { text: string; kb: InlineKeyboard } {
  const next = t.nextRun ? new Date(t.nextRun).toLocaleString() : "\u2014";
  const last = t.lastRun ? `${new Date(t.lastRun).toLocaleString()} (${t.lastStatus ?? "?"})` : "never";
  const prompt = t.prompt.length > 300 ? t.prompt.slice(0, 300) + "\u2026" : t.prompt;
  const text = [
    `\u{1F5D3} ${t.name}  ${t.enabled ? "\u{1F7E2} enabled" : "\u26AA disabled"}`,
    `\u{1F4C1} Project: ${t.projectName || basename(t.projectPath)}`,
    `\u{1F501} Schedule: ${describeSchedule(t.schedule)}`,
    `\u23ED Next run: ${next}`,
    `\u23EE Last run: ${last}`,
    "",
    `\u{1F4AC} ${prompt}`,
  ].join("\n");
  const kb = new InlineKeyboard()
    .text("\u25B6 Run now", `task:run:${t.id}`)
    .text(t.enabled ? "\u23F8 Disable" : "\u25B6 Enable", `task:toggle:${t.id}`)
    .row()
    .text("\u270F\uFE0F Edit", `task:editmenu:${t.id}`)
    .text("\u{1F5D1} Delete", `task:del:${t.id}`)
    .row()
    .text("\u2B05 Back", "task:list");
  return { text, kb };
}

function editMenu(id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Rename", `task:edit:name:${id}`)
    .text("Prompt", `task:edit:prompt:${id}`)
    .row()
    .text("Project", `task:edit:project:${id}`)
    .text("Schedule", `task:edit:schedule:${id}`)
    .row()
    .text("\u2B05 Back", `task:view:${id}`);
}
