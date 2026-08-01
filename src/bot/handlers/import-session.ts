/**
 * Import session — pick a sibling bot (Kiro / OpenCode / Claude / Codex), list
 * its /running (controlled) sessions, and import one into this chat as a new
 * Grok session primed with the full transcript (nothing lost).
 *
 * Flow:
 *   Menu → Import session → source → running session cards → Import
 */
import { basename, join } from "node:path";
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { textPrompt } from "../../app/types.js";
import { buildImportPackage } from "../../import/build-import.js";
import { listRunningFromSource, type ImportableSession } from "../../import/list-running.js";
import {
  getImportSource,
  IMPORT_SOURCES,
  sourceAvailable,
  type ImportSourceId,
} from "../../import/sources.js";
import { createLogger } from "../../logger.js";
import type { BotDeps } from "../deps.js";
import { IMPORT_CONFIRM_PROMPT } from "../session-fork.js";
import { refreshMenu } from "../menu/refresh.js";

const log = createLogger("import-session");

const CARD_LIMIT = 20;

/** Open the source picker (menu entry / /import). */
export async function showImportSources(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.ephemeral.open(ctx);
  const kb = new InlineKeyboard();
  for (const src of IMPORT_SOURCES) {
    const ok = sourceAvailable(src);
    const mark = ok ? "" : " \u26A0";
    kb.text(`${labelEmoji(src.id)} ${src.label}${mark}`, `imp:src:${src.id}`).row();
  }
  kb.text("\u2716 Cancel", "imp:cancel");
  await deps.ephemeral.reply(
    ctx,
    [
      "\u{1F4E5} Import session",
      "",
      "Choose the source tool. You will then see its /running sessions",
      "and can import one into Grok with full conversation context.",
    ].join("\n"),
    { reply_markup: kb },
  );
}

/** List /running sessions for a source bot. */
export async function showImportRunning(
  ctx: Context,
  deps: BotDeps,
  sourceId: ImportSourceId,
): Promise<void> {
  const src = getImportSource(sourceId);
  if (!src) {
    await ctx.reply("Unknown source.");
    return;
  }
  await deps.ephemeral.open(ctx);

  if (!sourceAvailable(src)) {
    await deps.ephemeral.reply(
      ctx,
      `\u26A0\uFE0F ${src.label} bot root not found:\n\`${src.botRoot}\``,
    );
    return;
  }

  const chatId = ctx.chat!.id;
  let sessions = listRunningFromSource(src, chatId);
  // If this Telegram chat id has no controlled sessions there, union all chats
  // on that bot (same human often uses one chat id everywhere).
  if (sessions.length === 0) sessions = listRunningFromSource(src);

  if (sessions.length === 0) {
    const kb = new InlineKeyboard().text("\u25C0 Sources", "imp:back").text("\u2716 Cancel", "imp:cancel");
    await deps.ephemeral.reply(
      ctx,
      [
        `\u{1F4E5} ${src.label} \u2014 no /running sessions`,
        "",
        "That bot has no controlled sessions in its settings right now.",
        "Open a session there first (Project / message), then try Import again.",
      ].join("\n"),
      { reply_markup: kb },
    );
    return;
  }

  deps.menuCache.setImportSessions(chatId, sourceId, sessions);
  const shown = sessions.slice(0, CARD_LIMIT);
  await deps.ephemeral.reply(
    ctx,
    `\u{1F4E5} ${src.label} /running \u2014 ${sessions.length} session(s). Tap Import on a card:`,
  );

  const now = Date.now();
  for (let i = 0; i < shown.length; i++) {
    const s = shown[i]!;
    const { text, kb } = buildImportCard(s, i, now);
    await deps.ephemeral.reply(ctx, text, { reply_markup: kb });
  }
  if (sessions.length > shown.length) {
    await deps.ephemeral.reply(ctx, `\u2026and ${sessions.length - shown.length} more (not shown).`);
  }
  const nav = new InlineKeyboard().text("\u25C0 Sources", "imp:back").text("\u2716 Cancel", "imp:cancel");
  await deps.ephemeral.reply(ctx, "Pick a session above, or go back.", { reply_markup: nav });
}

/** Perform the import into a new Grok /running session. */
export async function doImportSession(ctx: Context, deps: BotDeps, index: number): Promise<void> {
  const chatId = ctx.chat!.id;
  const cached = deps.menuCache.getImportSessions(chatId);
  const session = cached?.sessions[index];
  if (!session || !cached) {
    await ctx.reply("That import list expired \u2014 open Import session again.");
    return;
  }
  const src = getImportSource(cached.sourceId);
  if (!src) {
    await ctx.reply("Unknown source.");
    return;
  }

  await deps.ephemeral.clear(chatId).catch(() => {});
  await ctx.reply(
    `\u23F3 Importing from ${src.label} \u2026\n\`${session.sessionId.slice(0, 12)}\` \u00B7 ${session.projectName ?? (basename(session.cwd || "") || "project")}`,
  );

  const cwd = resolveImportCwd(session, deps, chatId);
  const projectName = session.projectName || (cwd ? basename(cwd) : "imported");
  const importsDir = join(deps.cfg.dataDir, "imports");

  let pkg;
  try {
    pkg = buildImportPackage(src, { ...session, cwd }, importsDir);
  } catch (e) {
    log.error("buildImportPackage failed:", (e as Error).message);
    await ctx.reply(`\u274C Could not read source history: ${(e as Error).message}`);
    return;
  }

  if (pkg.entryCount === 0) {
    await ctx.reply(
      [
        `\u26A0\uFE0F No history entries found on disk for this session.`,
        `Session id: \`${session.sessionId}\``,
        `I will still open a Grok session in the project, but context may be empty.`,
        `Transcript archive: \`${pkg.transcriptPath}\``,
      ].join("\n"),
    );
  }

  try {
    const rt = await deps.registry.controller(chatId).addImport(cwd, projectName, pkg.priming);
    // Flush priming into the live Grok session immediately so context is not
    // waiting on the user's next free-form message.
    void rt.submit(textPrompt(IMPORT_CONFIRM_PROMPT));

    const lines = [
      `\u2705 Imported into Grok /running`,
      `\u{1F4E5} ${src.label} \u2192 Grok`,
      `\u{1F4C1} ${projectName}`,
      cwd ? `   ${cwd}` : "",
      `\u{1F4DC} ${pkg.entryCount} history entries \u00B7 ${humanSize(pkg.transcriptChars)} transcript`,
      pkg.truncatedInline
        ? `\u2139\uFE0F Full transcript is on disk (inline slice was capped); Grok will use the file if needed.`
        : `\u2705 Full transcript inlined into the first Grok turn.`,
      `\u{1F4C4} ${pkg.transcriptPath}`,
      rt.sessionId ? `\u{1F194} new Grok session ${rt.sessionId.slice(0, 8)}` : "",
      ``,
      `Grok is loading the context now. After the short confirmation, send your next instruction to continue.`,
    ].filter(Boolean);

    await refreshMenu(ctx, deps, `\u{1F4E5} Imported ${src.label} \u00B7 ${projectName}`);
    await ctx.reply(lines.join("\n"));
  } catch (e) {
    log.error("import failed:", (e as Error).message);
    await ctx.reply(
      `\u274C Import failed: ${(e as Error).message}\nTranscript (if written): \`${pkg.transcriptPath}\``,
    );
  }
}

export function registerImportSession(bot: Bot, deps: BotDeps): void {
  bot.command("import", (ctx) => showImportSources(ctx, deps));

  bot.callbackQuery("imp:cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
  });

  bot.callbackQuery("imp:back", async (ctx) => {
    await ctx.answerCallbackQuery();
    await deps.ephemeral.clear(ctx.chat!.id).catch(() => {});
    await showImportSources(ctx, deps);
  });

  bot.callbackQuery(/^imp:src:(kiro|opencode|claude|codex)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await deps.ephemeral.clear(ctx.chat!.id).catch(() => {});
    await showImportRunning(ctx, deps, ctx.match![1] as ImportSourceId);
  });

  bot.callbackQuery(/^imp:go:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Importing\u2026" });
    await doImportSession(ctx, deps, Number(ctx.match![1]));
  });
}

// ── cards / helpers ──────────────────────────────────────────────────────────

function buildImportCard(
  s: ImportableSession,
  index: number,
  now: number,
): { text: string; kb: InlineKeyboard } {
  const proj = s.projectName || (s.cwd ? basename(s.cwd) : "(no project)");
  const when = s.updatedAt ? timeAgo(now - Date.parse(s.updatedAt)) : "unknown";
  const title = cleanTitle(s.title);
  const hist =
    s.historyBytes > 0 ? humanSize(s.historyBytes) : s.historyPath ? "0 B" : "no history file";

  const lines = [
    `\u{1F4E5} ${proj}`,
    title ? `\u{1F4AC} \u201C${trunc(title, 120)}\u201D` : "\u{1F4AC} (no title)",
    s.cwd ? `\u{1F4C1} ${s.cwd}` : "\u{1F4C1} (no cwd recorded)",
    `\u{1F552} ${when} \u00B7 \u{1F4DC} ${hist}`,
    `\u{1F194} ${s.sessionId.length > 16 ? s.sessionId.slice(0, 12) + "\u2026" : s.sessionId}`,
  ];

  const kb = new InlineKeyboard().text("\u{1F4E5} Import into Grok", `imp:go:${index}`);
  return { text: lines.join("\n"), kb };
}

function resolveImportCwd(session: ImportableSession, deps: BotDeps, chatId: number): string {
  if (session.cwd) return session.cwd;
  // No cwd on the source session — stay on this chat's current project.
  try {
    return deps.registry.get(chatId).cwd || deps.cfg.workspace;
  } catch {
    return deps.cfg.workspace;
  }
}

function labelEmoji(id: ImportSourceId): string {
  switch (id) {
    case "kiro":
      return "\u{1F3AF}";
    case "opencode":
      return "\u26A1";
    case "claude":
      return "\u{1F9E0}";
    case "codex":
      return "\u{1F4D6}";
  }
}

function cleanTitle(raw: string): string {
  let t = (raw || "").trim().replace(/^\([^)]*\)\s*/, "");
  const marker = "User's new message:";
  const i = t.lastIndexOf(marker);
  if (i !== -1) t = t.slice(i + marker.length);
  return t.replace(/\s+/g, " ").trim();
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

function timeAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const s = Math.round(ms / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
