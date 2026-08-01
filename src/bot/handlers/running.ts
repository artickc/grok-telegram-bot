/**
 * /running — the sessions this chat controls. Tap one to switch to it; on
 * switch you see a header + the target's unread messages (what happened while
 * you were away) or its recent history the first time.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import type { RunningSession, SwitchResult } from "../chat-controller.js";
import type { BotDeps } from "../deps.js";
import type { HistoryEntry } from "../../sessions/types.js";
import { jsonlMtimeMs, readFirstPrompt, readLastCardSummary } from "../../sessions/history.js";
import { progressBar } from "../../render/progress.js";
import { refreshMenu } from "../menu/refresh.js";
import { sendMarkdownDoc } from "../telegram-io.js";

const UUID = "([0-9a-fA-F-]{36})";
const ROLE_ICON: Record<string, string> = {
  user: "\u{1F464}",
  assistant: "\u{1F916}",
  tool: "\u{1F527}",
  system: "\u2139\uFE0F",
};
const ENTRY_MAX = 700;
/** Max session cards to send for one /running (avoids flooding the chat). */
const CARD_LIMIT = 12;

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

/** Compact "time ago" label from an elapsed-milliseconds value. */
function timeAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Reduce a stored first prompt to a clean one-liner: drop the leading reasoning
 *  directive and any fork-priming preamble, then collapse whitespace. */
function cleanPrompt(raw: string): string {
  let t = raw.trim().replace(/^\([^)]*\)\s*/, "");
  const marker = "User's new message:";
  const i = t.lastIndexOf(marker);
  if (i !== -1) t = t.slice(i + marker.length);
  return t.replace(/\s+/g, " ").trim();
}

/** Build a rich card (plain text, no MarkdownV2) + buttons for one controlled
 *  session: Switch / History / Close.
 *
 *  The comment line always answers "what is happening / what was solved":
 *    busy  → live current step (tool / thinking / working on …)
 *    idle  → last-turn outcome (assistant result + files), never bare import noise
 */
function buildRunningCard(s: RunningSession, deps: BotDeps, now: number): { text: string; kb: InlineKeyboard } {
  const dot = s.foreground ? "\u25B6\uFE0F" : s.busy ? "\u{1F7E0}" : "\u26AA";
  const state = s.foreground ? "foreground" : s.busy ? "working" : "idle";

  let when = "new";
  let historySummary = "";
  let firstPrompt = "";
  if (s.sessionId) {
    const path = deps.store.jsonlPath(s.sessionId);
    const mtime = jsonlMtimeMs(path);
    if (mtime) when = timeAgo(now - mtime);
    // Last assistant outcome beats first-prompt import-confirm noise.
    historySummary = readLastCardSummary(path);
    firstPrompt = cleanPrompt(readFirstPrompt(path));
    if (/session import complete/i.test(firstPrompt)) firstPrompt = "";
  }

  const diskComment = s.sessionId ? deps.store.get(s.sessionId)?.comment?.trim() : undefined;
  // Order: live runtime comment → persisted last-turn summary → history tail → first prompt.
  const comment =
    (s.comment && s.comment.trim()) ||
    diskComment ||
    historySummary ||
    firstPrompt;

  const meta = [when, state];
  if (s.busy) meta.push("\u23F3");
  if (s.unread > 0) meta.push(`${s.unread} \u{1F4EC} unread`);

  const commentLabel = s.busy ? "\u23F3" : "\u{1F4AC}";
  const lines = [
    `${dot} ${s.projectName}`,
    comment
      ? `${commentLabel} ${trunc(comment, 200)}`
      : "\u{1F4AC} (no messages yet)",
    `\u{1F552} ${meta.join(" \u00B7 ")}`,
  ];
  if (s.progress !== undefined) lines.push(`\u{1F4C8} ${progressBar(s.progress)}`);
  if (s.sessionId) lines.push(`\u{1F194} ${s.sessionId.slice(0, 8)}`);

  const kb = new InlineKeyboard();
  if (!s.sessionId) {
    kb.text("\u23F3 starting\u2026", "run:noop");
    return { text: lines.join("\n"), kb };
  }
  if (s.foreground) kb.text("\u25B6\uFE0F Current", "run:noop");
  else kb.text("\u{1F500} Switch", `run:switch:${s.sessionId}`);
  kb.text("\u{1F4DC} History", `hist:${s.sessionId}`).text("\u2716 Close", `run:close:${s.sessionId}`);
  return { text: lines.join("\n"), kb };
}

export async function showRunning(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.ephemeral.open(ctx);
  const { resolveScope } = await import("../scope.js");
  const scope = resolveScope(ctx, deps);
  // Topic: only this topic's controlled sessions. Private: this chat + same-project forum sessions.
  let list = dedupeBySession(scope.controller.list());
  if (!scope.isForum) {
    const path = scope.rt.cwd;
    for (const fc of deps.registry.allForumControllers()) {
      if (fc.fixedCwd && samePath(fc.fixedCwd, path)) {
        list = dedupeBySession([...list, ...fc.list().map((s) => ({ ...s, projectName: `${s.projectName} \u00B7 topic` }))]);
      }
    }
  } else {
    // Also surface private-bot sessions for the same project path.
    for (const chatId of deps.settings.chatIds()) {
      if (chatId === scope.chatId) continue;
      try {
        const priv = deps.registry.controller(chatId);
        for (const s of priv.list()) {
          // Match by session cwd via store or name — use store meta if available.
          if (s.sessionId) {
            const meta = deps.store.get(s.sessionId);
            if (meta?.cwd && samePath(meta.cwd, scope.rt.cwd)) {
              list = dedupeBySession([
                ...list,
                { ...s, projectName: `${s.projectName} \u00B7 DM`, foreground: false },
              ]);
            }
          }
        }
      } catch {
        /* skip */
      }
    }
  }
  if (list.length === 0) {
    await deps.ephemeral.reply(
      ctx,
      scope.isForum
        ? "No sessions in this topic yet. Send a message or tap \u{1F195} New."
        : "No sessions controlled yet. Use \u{1F4C1} Project or /new to start one.",
    );
    return;
  }
  const now = Date.now();
  const shown = list.slice(0, CARD_LIMIT);
  const header = scope.isForum
    ? `\u{1F9ED} Running in topic **${scope.projectName ?? "topic"}** (${list.length})`
    : `\u{1F9ED} Sessions controlled by this chat (${list.length}) \u2014 tap \u{1F500} Switch on a card:`;
  await deps.ephemeral.reply(ctx, header);
  for (const s of shown) {
    const { text, kb } = buildRunningCard(s, deps, now);
    await deps.ephemeral.reply(ctx, text, { reply_markup: kb });
  }
  if (list.length > shown.length) {
    await deps.ephemeral.reply(ctx, `\u2026and ${list.length - shown.length} more.`);
  }
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ===
    b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Collapse any cards that share a session id (defensive — the controller
 *  already prunes duplicate runtimes, but never show the same session twice). */
function dedupeBySession(list: RunningSession[]): RunningSession[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    if (!s.sessionId) return true;
    if (seen.has(s.sessionId)) return false;
    seen.add(s.sessionId);
    return true;
  });
}

/** Switch the chat to a session and show its summary + unread. */
export async function switchAndShow(ctx: Context, deps: BotDeps, sessionId: string): Promise<void> {
  const { resolveScope } = await import("../scope.js");
  const scope = resolveScope(ctx, deps);
  // Always bring the session into *this* scope's controller (never switch FG on
  // another surface — that would dual-own one ACP session across controllers).
  let res = await scope.controller.switchTo(sessionId);
  if (!res) {
    const meta = deps.store.get(sessionId);
    let cwd = meta?.cwd;
    let name = meta?.title || (cwd ? basenameSafe(cwd) : undefined);
    if (!cwd) {
      // Discover cwd from whatever controller currently lists it.
      for (const c of [scope.controller, ...deps.registry.allForumControllers()]) {
        const hit = c.list().find((s) => s.sessionId === sessionId);
        if (hit) {
          cwd = (c as { fixedCwd?: string }).fixedCwd || scope.rt.cwd;
          name = hit.projectName || name;
          break;
        }
      }
    }
    if (cwd) {
      // Topic controllers are fixed-path — refuse foreign projects.
      if (scope.controller.fixedCwd && !samePath(scope.controller.fixedCwd, cwd)) {
        await ctx.reply(
          "That session belongs to a different project than this topic.",
          scope.threadExtra,
        );
        return;
      }
      // Drop dual ownership: release from any other controller first.
      await releaseSessionElsewhere(deps, scope.controller, sessionId);
      const hist = (await import("../../sessions/history.js")).readHistory(
        deps.store.jsonlPath(sessionId),
      );
      await scope.controller.addAttach(sessionId, cwd, name || basenameSafe(cwd), hist);
      res = await scope.controller.switchTo(sessionId);
    }
  }
  if (!res) {
    await ctx.reply("Session not found (it may have been closed).", scope.threadExtra);
    return;
  }
  await deliverSwitch(ctx, deps, res);
}

/** Stop controlling a session on every controller except `keep`. */
async function releaseSessionElsewhere(
  deps: BotDeps,
  keep: import("../chat-controller.js").ChatController,
  sessionId: string,
): Promise<void> {
  for (const c of deps.registry.allForumControllers()) {
    if (c !== keep && c.findBySession(sessionId)) await c.close(sessionId);
  }
  for (const chatId of deps.settings.chatIds()) {
    try {
      const c = deps.registry.controller(chatId);
      if (c !== keep && c.findBySession(sessionId)) await c.close(sessionId);
    } catch {
      /* skip */
    }
  }
}

function basenameSafe(p: string): string {
  const n = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

export function registerRunning(bot: Bot, deps: BotDeps): void {
  bot.command("running", (ctx) => showRunning(ctx, deps));

  bot.callbackQuery("run:noop", (ctx) => ctx.answerCallbackQuery({ text: "Already in foreground" }));

  bot.callbackQuery(new RegExp(`^run:switch:${UUID}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    await deps.ephemeral.clear(ctx.chat!.id); // remove the /running cards; 🔀 Switched stays
    await switchAndShow(ctx, deps, ctx.match![1]!);
  });

  bot.callbackQuery(new RegExp(`^run:close:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    const { resolveScope } = await import("../scope.js");
    const scope = resolveScope(ctx, deps);
    let closed = await scope.controller.close(id);
    // Card may show a session owned by the other surface — close on owner.
    if (!closed) {
      const fc = deps.registry.forumControllerForSession(id);
      if (fc) closed = await fc.close(id);
    }
    if (!closed) {
      for (const chatId of deps.settings.chatIds()) {
        const c = deps.registry.controller(chatId);
        if (c.findBySession(id)) {
          closed = await c.close(id);
          break;
        }
      }
    }
    await ctx.answerCallbackQuery({ text: closed ? "Closed" : "Not found" });
    await ctx.deleteMessage().catch(() => {}); // remove just this card
  });
}

async function deliverSwitch(ctx: Context, deps: BotDeps, res: SwitchResult): Promise<void> {
  const proj = res.projectName ?? "session";
  const sid = res.sessionId ? res.sessionId.slice(0, 8) : "?";
  if (res.alreadyForeground) {
    await ctx.reply(`You're already on ${proj} (${sid}).`);
    return;
  }
  const working = res.busy ? " \u00B7 \u23F3 still working (live updates follow)" : "";
  await refreshMenu(ctx, deps, `\u{1F500} Switched to ${proj} (${sid})${working}`);

  if (res.unread.length === 0) {
    if (!res.busy) await ctx.reply(res.firstView ? "No earlier messages here." : "\u2705 Nothing new while you were away.");
    return;
  }
  const header = res.firstView
    ? `\u{1F4DC} **Recent history** \u2014 ${proj}`
    : `\u{1F4EC} **${res.unread.length} message(s) while away** \u2014 ${proj}`;
  const body = res.unread.map(fmtEntry).join("\n\n");
  await sendMarkdownDoc(deps.api, ctx.chat!.id, `${header}\n\n${body}\n\n${res.rt.tags}`);

  // Replay how the session's last turn ended (Done + file summary) — this isn't
  // in the .jsonl, so it's the footer you'd have seen had you been watching.
  if (!res.busy && res.rt.lastTurnSummary) {
    await ctx.reply(res.rt.lastTurnSummary);
  }

  // Re-show post-turn suggestions generated while this session was in the
  // background (or if the user missed the Done notify). Buttons stay wired to
  // the same batch ids so taps still submit the follow-up.
  if (!res.busy) {
    const sug = res.rt.peekPendingSuggestions();
    if (sug) {
      await ctx.reply(sug.text, { reply_markup: sug.markup }).catch(() => {});
    }
  }
}

function fmtEntry(e: HistoryEntry): string {
  const icon = ROLE_ICON[e.role] ?? "\u2022";
  if (e.role === "tool") return `${icon} ${e.tool ? `\`${e.tool}\`` : "tool"}`;
  const text = e.text.length > ENTRY_MAX ? e.text.slice(0, ENTRY_MAX) + " \u2026" : e.text;
  return `${icon} ${text}`;
}
