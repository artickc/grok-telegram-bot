/**
 * /accounts — manage several Grok sign-ins and switch between them.
 *
 * Grok has one active sign-in (`~/.grok/auth.json`); this menu snapshots the
 * current login as a named account, imports a login already on the machine, and
 * swaps the active identity in one tap (copies the saved snapshot back and
 * restarts the agent so sessions re-bind). Switching is serialised with the
 * shared agent and refused while a prompt is in flight.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { AuthService } from "../../app/auth-service.js";
import type { StoredAccount } from "../../app/accounts.js";
import { UNSUPPORTED_LOGIN_HELP } from "../../app/grok-credentials.js";
import { createLogger } from "../../logger.js";
import type { BotDeps } from "../deps.js";

const log = createLogger("accounts");

function accountLine(a: StoredAccount, active: boolean): string {
  const mark = active ? "\u2705 " : "\u{1F464} ";
  return `${mark}${a.label}`;
}

async function view(deps: BotDeps, note?: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const list = deps.accounts.list();
  const acct = await deps.usage.account().catch(() => undefined);
  const active = deps.accounts.activeAccountId();
  const marked = deps.accounts.markedActiveId();
  const loggedIn = await deps.usage.isLoggedIn().catch(() => false);
  const liveLabel = acct?.email?.trim();
  const activeMeta = active ? deps.accounts.get(active) : undefined;
  const markedMeta = marked && marked !== active ? deps.accounts.get(marked) : undefined;

  const lines = ["\u{1F465} Grok accounts", ""];
  if (!loggedIn) {
    lines.push("\u{1F534} Not signed in — sign in via /reauth.", "");
  } else if (liveLabel) {
    lines.push(`\u{1F7E2} Host Grok login: ${liveLabel}`);
    if (activeMeta) {
      lines.push(`  \u2514 Matches saved: ${activeMeta.label}`);
    } else {
      lines.push("  \u2514 Not among saved accounts — tap \u201C\u{1F4BE} Save current login\u201D.");
      if (markedMeta) {
        lines.push(`  \u2514 App still has ${markedMeta.label} selected — different from host login.`);
      }
    }
    lines.push("");
  } else {
    lines.push("\u{1F7E2} Signed in (identity unknown).", "");
  }
  if (list.length === 0) {
    lines.push("No saved accounts yet.", "", "Save the current login below, or sign in via /reauth.");
  } else {
    for (const a of list) lines.push(accountLine(a, a.id === active));
  }
  const rotate = deps.accounts.autoRotateEnabled();
  lines.push(
    "",
    `\u{1F501} Auto-rotate on errors: ${rotate ? "ON" : "OFF"}`,
    rotate
      ? "  \u2514 On give-up / 402 balance exhausted: stop CLI, swap auth, restart, retry each account once."
      : "  \u2514 Turns stay on the active account (402 balance exhausted stops immediately).",
  );
  if (note) lines.push("", note);

  const kb = new InlineKeyboard();
  for (const a of list) {
    const sw = a.id === active ? `\u2705 ${trim(a.label)} (active)` : `\u{1F504} ${trim(a.label)}`;
    kb.text(sw, a.id === active ? "acct:noop" : `acct:switch:${a.id}`)
      .text("\u270F\uFE0F", `acct:rename:${a.id}`)
      .text("\u{1F5D1}", `acct:del:${a.id}`)
      .row();
  }
  kb.text("\u{1F4BE} Save current login", "acct:save").text("\u270F\uFE0F Save as\u2026", "acct:saveas").row();
  kb.text("\u{1F4E5} Import existing", "acct:import").text("\u{1F511} Sign in\u2026", "acct:login").row();
  kb.text(`\u{1F501} Auto-rotate: ${rotate ? "ON" : "OFF"}`, "acct:rotate").row();
  kb.text("\u2716 Close", "acct:close");
  return { text: lines.join("\n"), keyboard: kb };
}

function trim(s: string, n = 22): string {
  return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
}

export async function showAccounts(ctx: Context, deps: BotDeps): Promise<void> {
  const { text, keyboard } = await view(deps);
  await deps.ephemeral.open(ctx);
  await deps.ephemeral.reply(ctx, text, { reply_markup: keyboard });
}

async function rerender(ctx: Context, deps: BotDeps, note?: string): Promise<void> {
  const { text, keyboard } = await view(deps, note);
  await ctx.editMessageText(text, { reply_markup: keyboard }).catch(() => {});
}

function busyReason(deps: BotDeps): string | undefined {
  if (deps.acp.hasInflightPrompt()) return "\u23F3 Grok is running a turn — try again when idle (or /cancel first).";
  return undefined;
}

export function registerAccounts(bot: Bot, deps: BotDeps): void {
  const auth = new AuthService(deps.cfg.grokCliPath);
  const pending = new Map<number, { mode: "save" | "rename"; id?: string }>();

  const promptName = async (ctx: Context, mode: "save" | "rename", id?: string): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const ask =
      mode === "save"
        ? "\u270F\uFE0F Send a name for the current login (e.g. \u201CWork\u201D or \u201CPersonal\u201D)."
        : "\u270F\uFE0F Send a new name for this account.";
    await deps.ephemeral.reply(ctx, ask);
    pending.set(chatId, { mode, id });
  };

  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat.id;
    const p = pending.get(chatId);
    if (!p) return next();
    const text = ctx.message.text;
    if (text.startsWith("/")) return next();
    pending.delete(chatId);
    await ctx.deleteMessage().catch(() => {});
    const name = text.trim().slice(0, 60);
    let note: string;
    try {
      if (p.mode === "rename" && p.id) {
        const meta = deps.accounts.rename(p.id, name);
        note = meta ? `\u270F\uFE0F Renamed to ${meta.label}` : "That account is no longer saved.";
      } else if (!(await deps.usage.isLoggedIn())) {
        note = `\u274C ${UNSUPPORTED_LOGIN_HELP}`;
      } else {
        const saved = await deps.accounts.captureCurrent(undefined, name);
        note = `\u{1F4BE} Saved: ${saved.label}`;
      }
    } catch (e) {
      note = `\u274C ${(e as Error).message}`;
    }
    await deps.ephemeral.open(ctx);
    const { text: t, keyboard } = await view(deps, note);
    await deps.ephemeral.reply(ctx, t, { reply_markup: keyboard });
  });

  bot.command("accounts", (ctx) => showAccounts(ctx, deps));

  bot.callbackQuery("acct:noop", (ctx) => ctx.answerCallbackQuery({ text: "Already active" }));

  bot.callbackQuery("acct:saveas", async (ctx) => {
    await ctx.answerCallbackQuery();
    await promptName(ctx, "save");
  });

  bot.callbackQuery("acct:rotate", async (ctx) => {
    const on = deps.accounts.setAutoRotate();
    await ctx.answerCallbackQuery({ text: `Auto-rotate ${on ? "on" : "off"}` });
    await rerender(ctx, deps, on ? "\u{1F501} Auto-rotate enabled." : "\u{1F501} Auto-rotate disabled.");
  });

  bot.callbackQuery(/^acct:rename:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await promptName(ctx, "rename", ctx.match![1]!);
  });

  bot.callbackQuery("acct:close", async (ctx) => {
    await ctx.answerCallbackQuery();
    await deps.ephemeral.drop(ctx);
  });

  bot.callbackQuery("acct:save", async (ctx) => {
    if (!(await deps.usage.isLoggedIn())) {
      await ctx.answerCallbackQuery({ text: "Not signed in", show_alert: true });
      return void rerender(ctx, deps, `\u274C ${UNSUPPORTED_LOGIN_HELP}`);
    }
    try {
      const saved = await deps.accounts.captureCurrent();
      await ctx.answerCallbackQuery({ text: `Saved ${saved.label}` });
      await rerender(ctx, deps, `\u{1F4BE} Saved: ${saved.label}`);
    } catch (e) {
      await ctx.answerCallbackQuery({ text: (e as Error).message.slice(0, 190), show_alert: true });
    }
  });

  bot.callbackQuery("acct:login", async (ctx) => {
    await ctx.answerCallbackQuery();
    await rerender(ctx, deps, "\u{1F511} Run /reauth to sign in, then tap \u201CSave current login\u201D.");
  });

  bot.callbackQuery("acct:import", async (ctx) => {
    const reason = busyReason(deps);
    if (reason) return void ctx.answerCallbackQuery({ text: reason, show_alert: true });
    await ctx.answerCallbackQuery({ text: "Importing…" });
    const res = await auth.importExisting();
    if (!res.ok) return void rerender(ctx, deps, `\u274C ${res.error ?? "Import failed."}`);
    // Import reuses the live auth.json — just re-bind the agent headlessly.
    try {
      await deps.acp.stopAndWait();
      await deps.acp.start();
    } catch (e) {
      await deps.acp.start().catch(() => {});
      return void rerender(ctx, deps, `\u26A0\uFE0F Imported, but re-bind failed: ${(e as Error).message}`);
    }
    let note = `\u2705 Imported the current login${res.label ? ` (${res.label})` : ""}.`;
    try {
      const saved = await deps.accounts.captureCurrent();
      note = `\u2705 Imported & saved ${saved.label}.`;
    } catch {
      /* best-effort */
    }
    await rerender(ctx, deps, note);
  });

  bot.callbackQuery(/^acct:switch:(.+)$/, async (ctx) => {
    const id = ctx.match![1]!;
    const reason = busyReason(deps);
    if (reason) return void ctx.answerCallbackQuery({ text: reason, show_alert: true });
    await ctx.answerCallbackQuery({ text: "Switching…" });
    try {
      // 1) Snapshot the current login so it isn't lost.
      await deps.accounts.captureCurrent().catch(() => {});
      const target = deps.accounts.get(id);
      await ctx
        .editMessageText(`\u{1F504} Switching to ${target?.label ?? "account"}\u2026 replacing auth.json + restarting agent`)
        .catch(() => {});
      // 2) Stop agent BEFORE writing auth.json (avoids the live process
      //    overwriting / racing the file, and never opens a browser).
      await deps.acp.stopAndWait();
      let meta;
      try {
        meta = await deps.accounts.switchTo(id);
        // 3) Start agent; it authenticates headlessly with cached_token.
        await deps.acp.start();
      } catch (e) {
        await deps.acp.start().catch(() => {});
        throw e;
      }
      const note = (await deps.usage.isLoggedIn())
        ? `\u2705 Now signed in as ${meta.label}. Your next message runs on this account.`
        : `\u26A0\uFE0F Switched to ${meta.label}, but no usable login is active. ${UNSUPPORTED_LOGIN_HELP}`;
      await rerender(ctx, deps, note);
    } catch (e) {
      log.warn("account switch failed:", (e as Error).message);
      await rerender(ctx, deps, `\u274C ${(e as Error).message}`);
    }
  });

  bot.callbackQuery(/^acct:del:(.+)$/, async (ctx) => {
    const id = ctx.match![1]!;
    const meta = deps.accounts.get(id);
    await deps.accounts.forget(id);
    await ctx.answerCallbackQuery({ text: meta ? `Removed ${meta.label}` : "Removed" });
    await rerender(ctx, deps);
  });
}
