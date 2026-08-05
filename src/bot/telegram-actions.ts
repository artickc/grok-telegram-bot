/**
 * Execute agent-requested Telegram bridge actions and produce results +
 * user-facing status lines.
 */
import type { Api } from "grammy";
import type { AppConfig } from "../config.js";
import type { ForumManager } from "../forum/manager.js";
import type { ForumTopicBinding } from "../forum/types.js";
import { FORUM_GENERAL_THREAD_ID } from "../forum/thread.js";
import type { SessionStore } from "../sessions/store.js";
import { createLogger } from "../logger.js";
import { searchGroupMemory } from "./group-memory.js";
import type { TelegramBotService } from "./telegram-bots.js";
import type { TelegramAction } from "../render/telegram-bridge.js";

const log = createLogger("telegram-actions");

/** Cross-topic prompt injection (implemented by bot.ts via registry). */
export type SubmitTopicPromptFn = (opts: {
  threadId: number;
  cwd: string;
  projectName: string;
  prompt: string;
  newSession?: boolean;
}) => Promise<{ outcome: "ran" | "queued"; sessionId?: string }>;

export interface TelegramActionContext {
  api: Api;
  cfg: AppConfig;
  chatId: number;
  messageThreadId?: number;
  forum?: ForumManager;
  store: SessionStore;
  bots: TelegramBotService;
  /** Dispatch a prompt into another forum topic's session. */
  submitTopicPrompt?: SubmitTopicPromptFn;
}

export interface TelegramActionResult {
  action: string;
  ok: boolean;
  /** Machine-readable payload for the agent. */
  data?: unknown;
  error?: string;
  /** Short line to show the user (optional). */
  userNote?: string;
}

/** Run actions sequentially; bot_command may await a sibling bot. */
export async function executeTelegramActions(
  actions: TelegramAction[],
  ctx: TelegramActionContext,
): Promise<TelegramActionResult[]> {
  const results: TelegramActionResult[] = [];
  for (const action of actions) {
    try {
      results.push(await runOne(action, ctx));
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      log.warn(`action ${action.action} failed: ${msg}`);
      results.push({ action: action.action, ok: false, error: msg });
    }
  }
  return results;
}

async function runOne(
  action: TelegramAction,
  ctx: TelegramActionContext,
): Promise<TelegramActionResult> {
  switch (action.action) {
    case "create_topic":
      return createTopic(action, ctx);
    case "set_path":
      return setPath(action, ctx);
    case "send_prompt":
      return sendPrompt(action, ctx);
    case "search_memory":
      return searchMemory(action, ctx);
    case "list_bots":
      return listBots(ctx);
    case "bot_command":
      return botCommand(action, ctx);
    default:
      return { action: "unknown", ok: false, error: "unsupported action" };
  }
}

async function createTopic(
  action: Extract<TelegramAction, { action: "create_topic" }>,
  ctx: TelegramActionContext,
): Promise<TelegramActionResult> {
  const forum = ctx.forum;
  if (!forum?.isReady) {
    return {
      action: "create_topic",
      ok: false,
      error:
        "Forum topics not available (TOPIC_GROUP_ID unset, bot not admin, or Topics disabled)",
    };
  }
  const created = await forum.createBoundTopic(action.name, action.path);
  if (!created.ok) {
    return { action: "create_topic", ok: false, error: created.error };
  }
  const b = created.binding;
  return {
    action: "create_topic",
    ok: true,
    data: {
      threadId: b.threadId,
      name: b.name,
      projectPath: b.projectPath,
      kind: b.kind,
    },
    userNote: b.projectPath
      ? `\u{1F4CC} Created topic **${b.name}** (#${b.threadId}) \u2192 \`${b.projectPath}\``
      : `\u{1F4CC} Created topic **${b.name}** (#${b.threadId}) (unbound — use set_path)`,
  };
}

function setPath(
  action: Extract<TelegramAction, { action: "set_path" }>,
  ctx: TelegramActionContext,
): TelegramActionResult {
  const forum = ctx.forum;
  if (!forum?.isReady) {
    return {
      action: "set_path",
      ok: false,
      error: "Forum topics not available",
    };
  }
  const resolved = resolveTopicRef(forum, action.topic, ctx.cfg);
  if (!resolved.ok) {
    return { action: "set_path", ok: false, error: resolved.error };
  }
  const { binding } = resolved;
  if (binding.threadId === FORUM_GENERAL_THREAD_ID) {
    return {
      action: "set_path",
      ok: false,
      error: "Cannot rebind the General topic (always GROK_WORKSPACE)",
    };
  }
  if (binding.kind === "ai_chat") {
    return {
      action: "set_path",
      ok: false,
      error: "Cannot rebind the AI Chat topic (always GROK_WORKSPACE)",
    };
  }

  // Agent set_path: create missing absolute folders (new project flow).
  const result = forum.tryBindPath(binding.threadId, action.path, { createIfMissing: true });
  if (!result.ok) {
    return { action: "set_path", ok: false, error: result.error };
  }
  const b = result.binding;
  const createdNote = result.created ? " (folder created)" : "";
  return {
    action: "set_path",
    ok: true,
    data: {
      threadId: b.threadId,
      name: b.name,
      projectPath: b.projectPath,
      kind: b.kind,
      created: !!result.created,
    },
    userNote: `\u{1F4C1} Topic **${b.name}** (#${b.threadId}) \u2192 \`${b.projectPath}\`${createdNote}`,
  };
}

async function sendPrompt(
  action: Extract<TelegramAction, { action: "send_prompt" }>,
  ctx: TelegramActionContext,
): Promise<TelegramActionResult> {
  const forum = ctx.forum;
  if (!forum?.isReady) {
    return {
      action: "send_prompt",
      ok: false,
      error: "Forum topics not available",
    };
  }
  if (!ctx.submitTopicPrompt) {
    return {
      action: "send_prompt",
      ok: false,
      error: "Cross-topic prompt dispatch is not wired",
    };
  }

  const resolved = resolveTopicRef(forum, action.topic, ctx.cfg);
  if (!resolved.ok) {
    return { action: "send_prompt", ok: false, error: resolved.error };
  }
  const { binding } = resolved;
  const cwd = binding.projectPath;
  if (!cwd) {
    return {
      action: "send_prompt",
      ok: false,
      error: `Topic **${binding.name}** (#${binding.threadId}) has no project path — use set_path or create_topic with path first`,
    };
  }

  const projectName =
    binding.kind === "ai_chat"
      ? ctx.cfg.topicAiChatName
      : binding.kind === "general"
        ? "General"
        : binding.name;

  // Visible injection in the *target* topic so humans see the orchestrated prompt.
  // Plain text (no Markdown) so agent prompts with * _ ` cannot break the send.
  const preview =
    action.prompt.length > 1500 ? action.prompt.slice(0, 1499) + "\u2026" : action.prompt;
  await ctx.api
    .sendMessage(
      forum.groupId,
      `\u{1F4E8} Prompt from bridge${action.newSession ? " (new session)" : ""}\n\n${preview}`,
      { message_thread_id: binding.threadId },
    )
    .catch((e) => {
      log.debug(`send_prompt announce failed: ${(e as Error).message}`);
    });

  try {
    const res = await ctx.submitTopicPrompt({
      threadId: binding.threadId,
      cwd,
      projectName,
      prompt: action.prompt,
      newSession: action.newSession,
    });
    return {
      action: "send_prompt",
      ok: true,
      data: {
        threadId: binding.threadId,
        name: binding.name,
        projectPath: cwd,
        outcome: res.outcome,
        sessionId: res.sessionId,
        newSession: !!action.newSession,
        promptPreview: action.prompt.slice(0, 200),
      },
      userNote: `\u{1F4E8} Prompt ${res.outcome} in **${binding.name}** (#${binding.threadId})`,
    };
  } catch (e) {
    return {
      action: "send_prompt",
      ok: false,
      error: (e as Error).message ?? String(e),
      data: { threadId: binding.threadId, name: binding.name, projectPath: cwd },
    };
  }
}

/**
 * Resolve a topic ref: numeric / #id, "general", "ai chat", or exact title.
 */
export function resolveTopicRef(
  forum: ForumManager,
  ref: string,
  cfg: AppConfig,
): { ok: true; binding: ForumTopicBinding } | { ok: false; error: string } {
  const raw = ref.trim();
  if (!raw) return { ok: false, error: "Empty topic reference" };

  // #123 or plain digits
  const idMatch = /^#?(\d+)$/.exec(raw);
  if (idMatch) {
    const threadId = Number(idMatch[1]);
    const b = forum.store.get(threadId);
    if (!b) {
      // General (1) may not be in store yet — synthesize workspace bind.
      if (threadId === FORUM_GENERAL_THREAD_ID) {
        const bound = forum.store.bindProject(threadId, cfg.workspace, "General", "general");
        return { ok: true, binding: bound };
      }
      return { ok: false, error: `No topic mapped for thread #${threadId}` };
    }
    return { ok: true, binding: b };
  }

  const key = raw.toLowerCase();
  if (key === "general" || key === "general topic") {
    let b = forum.store.get(FORUM_GENERAL_THREAD_ID);
    if (!b?.projectPath) {
      b = forum.store.bindProject(FORUM_GENERAL_THREAD_ID, cfg.workspace, "General", "general");
    }
    return { ok: true, binding: b };
  }

  const aiName = (cfg.topicAiChatName || "AI Chat").toLowerCase();
  if (key === "ai chat" || key === "ai_chat" || key === aiName) {
    const ai = forum.store.findAiChat();
    if (ai) return { ok: true, binding: ai };
    // Fallback: ensure workspace topic by name match
    const byName = forum.store.all().find((t) => t.name.toLowerCase() === aiName);
    if (byName) return { ok: true, binding: byName };
    return { ok: false, error: "AI Chat topic not found — run /forum_setup" };
  }

  // Exact title match (case-insensitive)
  const hits = forum.store.all().filter((t) => t.name.toLowerCase() === key);
  if (hits.length === 1) return { ok: true, binding: hits[0]! };
  if (hits.length > 1) {
    return {
      ok: false,
      error: `Multiple topics named "${raw}" (${hits.map((h) => "#" + h.threadId).join(", ")}). Use #threadId.`,
    };
  }
  return {
    ok: false,
    error: `Topic not found: "${raw}". Use exact title, #threadId, "general", or "ai chat".`,
  };
}

function searchMemory(
  action: Extract<TelegramAction, { action: "search_memory" }>,
  ctx: TelegramActionContext,
): TelegramActionResult {
  const topics = ctx.forum?.isReady ? ctx.forum.store.all() : undefined;
  const hits = searchGroupMemory({
    query: action.query,
    limit: action.limit,
    sessionsDir: ctx.cfg.sessionsDir,
    store: ctx.store,
    topics,
  });
  return {
    action: "search_memory",
    ok: true,
    data: { query: action.query, hits },
    userNote:
      hits.length > 0
        ? `\u{1F50D} Memory search: ${hits.length} hit(s) for \u201c${action.query.slice(0, 60)}\u201d`
        : `\u{1F50D} Memory search: no hits for \u201c${action.query.slice(0, 60)}\u201d`,
  };
}

async function listBots(ctx: TelegramActionContext): Promise<TelegramActionResult> {
  if (ctx.cfg.allowedTelegramBots.length === 0) {
    return {
      action: "list_bots",
      ok: true,
      data: { bots: [], note: "ALLOWED_TELEGRAM_BOTS is empty" },
      userNote: "\u{1F916} No sibling bots configured (ALLOWED_TELEGRAM_BOTS)",
    };
  }
  const bots = await ctx.bots.listBots(true);
  const catalog = Object.fromEntries(
    bots.map((b) => [
      b.username,
      b.commands.map((c) =>
        c.description ? `/${c.command} — ${c.description}` : `/${c.command}`,
      ),
    ]),
  );
  return {
    action: "list_bots",
    ok: true,
    data: {
      bots,
      commands: catalog,
      usage:
        "Call bot_command with bot=username (no @), command without leading slash, optional args. " +
        "Treat replies like MCP tool results. Unknown/timeout commands return ok=false — continue the session; do not treat them as Done.",
    },
    userNote: `\u{1F916} Sibling bots: ${bots
      .map((b) => {
        const cmds = b.commands.length
          ? ` (${b.commands.map((c) => "/" + c.command).join(", ")})`
          : "";
        return "@" + b.username + cmds;
      })
      .join(", ") || "(none)"}`,
  };
}

async function botCommand(
  action: Extract<TelegramAction, { action: "bot_command" }>,
  ctx: TelegramActionContext,
): Promise<TelegramActionResult> {
  // Prefer the configured forum group so sibling bots (group-scoped) see the command.
  const chatId = ctx.cfg.topicGroupId ?? ctx.chatId;
  const messageThreadId =
    ctx.cfg.topicGroupId !== undefined && chatId === ctx.cfg.topicGroupId
      ? ctx.messageThreadId
      : undefined;

  const res = await ctx.bots.invokeCommand({
    bot: action.bot,
    command: action.command,
    args: action.args,
    chatId,
    messageThreadId,
  });

  if (!res.ok) {
    // Timeout / dead bot / bad command: session continues via bridge results.
    // Never surface as a successful Done.
    const kind = res.kind;
    const icon = kind === "timeout" ? "\u23F1\uFE0F" : "\u26A0\uFE0F";
    return {
      action: "bot_command",
      ok: false,
      error: res.error,
      data: {
        bot: action.bot,
        command: action.command,
        args: action.args,
        kind,
        sessionContinues: true,
        partialReply: res.partialReply,
      },
      userNote: `${icon} Waiting for @${action.bot} /${action.command} failed: ${res.error} (session continues)`,
    };
  }

  const partialNote = res.partial
    ? " \u2014 partial (hard timeout; stream may be incomplete)"
    : "";
  return {
    action: "bot_command",
    ok: true,
    data: {
      bot: action.bot,
      command: action.command,
      args: action.args,
      reply: res.reply,
      partial: res.partial,
    },
    userNote: `\u{1F916} @${action.bot} /${action.command} \u2014 reply ready (${res.reply.length} chars)${partialNote}`,
  };
}
