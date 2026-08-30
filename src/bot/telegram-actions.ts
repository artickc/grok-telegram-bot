/**
 * Execute agent-requested Telegram bridge actions and produce results +
 * user-facing status lines.
 */
import type { Api } from "grammy";
import type { AppConfig } from "../config.js";
import type { ForumManager } from "../forum/manager.js";
import type { ForumTopicBinding } from "../forum/types.js";
import {
  FORUM_GENERAL_THREAD_ID,
  isGeneralThread,
  outboundThreadExtra,
} from "../forum/thread.js";
import type { SessionStore } from "../sessions/store.js";
import { createLogger } from "../logger.js";
import { searchGroupMemory } from "./group-memory.js";
import {
  bindJobSession,
  listRecentManagerJobs,
  registerManagerJob,
  updateManagerJob,
  type ReportBackMeta,
} from "./manager-jobs.js";
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
  /**
   * Resume this exact Grok session in the target topic (full UUID or short
   * prefix from memory hits). When set, overrides newSession / foreground.
   */
  sessionId?: string;
  /** When set, child session reports completion back to General. */
  reportBack?: ReportBackMeta;
}) => Promise<{ outcome: "ran" | "queued"; sessionId?: string }>;

export interface TelegramActionContext {
  api: Api;
  cfg: AppConfig;
  chatId: number;
  messageThreadId?: number;
  /** Reply-to for notify (usually the user's message that started the turn). */
  replyToMessageId?: number;
  forum?: ForumManager;
  store: SessionStore;
  bots: TelegramBotService;
  /** Dispatch a prompt into another forum topic's session. */
  submitTopicPrompt?: SubmitTopicPromptFn;
  /**
   * When actions originate from General manager, register jobs + report-back
   * and suppress chat spam notes for durable actions.
   */
  managerMode?: boolean;
  /** Short preview of the user ask that triggered this manager turn. */
  managerUserAskPreview?: string;
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
    case "notify":
      return notifyUser(action, ctx);
    case "search_memory":
      return searchMemory(action, ctx);
    case "list_topics":
      return listTopics(ctx);
    case "list_jobs":
      return listJobs();
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
    userNote: ctx.managerMode
      ? undefined
      : b.projectPath
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
    userNote: ctx.managerMode
      ? undefined
      : `\u{1F4C1} Topic **${b.name}** (#${b.threadId}) \u2192 \`${b.projectPath}\`${createdNote}`,
  };
}

/**
 * Explicit user-facing message. In General this is the only chat surface —
 * free-form agent prose is not streamed.
 */
async function notifyUser(
  action: Extract<TelegramAction, { action: "notify" }>,
  ctx: TelegramActionContext,
): Promise<TelegramActionResult> {
  const text = action.text.trim();
  if (!text) {
    return { action: "notify", ok: false, error: "Empty notify text" };
  }
  try {
    const extra: Record<string, unknown> = {
      disable_notification: !action.important,
      // General: never pass message_thread_id=1 (Telegram rejects it).
      ...outboundThreadExtra(ctx.messageThreadId),
    };
    if (ctx.replyToMessageId !== undefined) {
      extra.reply_parameters = {
        message_id: ctx.replyToMessageId,
        allow_sending_without_reply: true,
      };
    }
    const msg = await ctx.api.sendMessage(ctx.chatId, text, extra);
    return {
      action: "notify",
      ok: true,
      data: {
        messageId: msg.message_id,
        chars: text.length,
        important: !!action.important,
      },
      // Never double-post via userNote — the message already went out.
      userNote: undefined,
    };
  } catch (e) {
    return {
      action: "notify",
      ok: false,
      error: (e as Error).message ?? String(e),
    };
  }
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

  // Resolve session_id first when present. A real session can recover a missing
  // or placeholder topic (e.g. topic: "…") by matching session.cwd → forum binding.
  let resumeSessionId: string | undefined;
  let resumeCwd: string | undefined;
  let inferredFromMemory = false;
  if (action.sessionId) {
    const resolvedSess = resolveSessionRef(ctx.store, action.sessionId);
    if (!resolvedSess.ok) {
      return {
        action: "send_prompt",
        ok: false,
        error: resolvedSess.error,
        data: { topic: action.topic, sessionRef: action.sessionId },
      };
    }
    resumeSessionId = resolvedSess.sessionId;
    if (resolvedSess.cwd) resumeCwd = resolvedSess.cwd;
  }

  let binding: ForumTopicBinding | undefined;
  let topicError: string | undefined;
  const topicRef = (action.topic || "").trim();
  const topicIsPlaceholder = isPlaceholderTopicRef(topicRef);

  if (topicRef && !topicIsPlaceholder) {
    const resolved = resolveTopicRef(forum, topicRef, ctx.cfg);
    if (resolved.ok) {
      binding = resolved.binding;
    } else {
      topicError = resolved.error;
    }
  }

  // Fallback: map session cwd → topic when topic missing, placeholder, or not found.
  if (!binding && resumeCwd) {
    const fromPath = resolveTopicFromPath(forum, resumeCwd);
    if (fromPath) binding = fromPath;
  }

  // Last resort: model used topic "…" / wrong name without session_id — infer from
  // memory using the user ask + prompt text, then map path → forum topic.
  if (!binding) {
    const inferred = inferDispatchTarget(ctx, forum, [
      ctx.managerUserAskPreview || "",
      action.prompt.slice(0, 400),
      topicIsPlaceholder ? "" : topicRef,
    ]);
    if (inferred) {
      binding = inferred.binding;
      if (!resumeSessionId && inferred.sessionId) {
        resumeSessionId = inferred.sessionId;
        resumeCwd = inferred.cwd || inferred.binding.projectPath || resumeCwd;
        inferredFromMemory = true;
      } else if (!resumeCwd && inferred.cwd) {
        resumeCwd = inferred.cwd;
        inferredFromMemory = true;
      } else {
        inferredFromMemory = true;
      }
    }
  }

  if (!binding) {
    const hint = listTopicHints(forum);
    const topics = safeListTopics(forum);
    if (topicIsPlaceholder || !topicRef) {
      return {
        action: "send_prompt",
        ok: false,
        error:
          (topicIsPlaceholder
            ? `Topic is a placeholder ("${topicRef || "…"}"). Pass exact title, #threadId, or session_id (memory could not auto-infer a project topic).`
            : "Topic missing. Pass exact title, #threadId, or session_id.") +
          (hint ? ` Available: ${hint}` : " Call list_topics first."),
        data: {
          topic: action.topic,
          sessionRef: action.sessionId,
          resumeSessionId,
          availableTopics: topics,
        },
      };
    }
    return {
      action: "send_prompt",
      ok: false,
      error: (topicError || `Topic not found: "${topicRef}".`) + (hint ? ` Available: ${hint}` : ""),
      data: {
        topic: action.topic,
        sessionRef: action.sessionId,
        resumeSessionId,
        availableTopics: topics,
      },
    };
  }

  const cwd = binding.projectPath || resumeCwd;
  if (!cwd) {
    return {
      action: "send_prompt",
      ok: false,
      error: `Topic **${binding.name}** (#${binding.threadId}) has no project path — use set_path or create_topic with path first`,
    };
  }
  if (!resumeCwd) resumeCwd = cwd;

  // If session was resolved without path filter, re-prefer under this topic when ambiguous.
  if (action.sessionId && resumeSessionId) {
    const refined = resolveSessionRef(ctx.store, action.sessionId, cwd);
    if (refined.ok) {
      resumeSessionId = refined.sessionId;
      if (refined.cwd) resumeCwd = refined.cwd;
    }
  }

  const projectName =
    binding.kind === "ai_chat"
      ? ctx.cfg.topicAiChatName
      : binding.kind === "general"
        ? "General"
        : binding.name;

  // Human-visible announce in the *target* topic (may be multi-message).
  // The full `action.prompt` is always submitted to the agent below — never crop it here.
  const sessNote = resumeSessionId ? ` → session ${resumeSessionId.slice(0, 8)}` : "";
  await announceBridgePrompt(
    ctx.api,
    forum.groupId,
    binding.threadId,
    action.prompt,
    !!action.newSession && !resumeSessionId,
    sessNote,
  );

  // Manager → project: register job and ask the child runtime to report back.
  let reportBack: ReportBackMeta | undefined;
  if (ctx.managerMode && isGeneralThread(ctx.messageThreadId)) {
    // Never report-back into the same general loop for self-prompts.
    if (binding.threadId !== FORUM_GENERAL_THREAD_ID) {
      const job = registerManagerJob({
        originChatId: ctx.chatId,
        originThreadId: FORUM_GENERAL_THREAD_ID,
        targetThreadId: binding.threadId,
        targetName: binding.name,
        targetPath: resumeCwd,
        dispatchPrompt: action.prompt,
        userAskPreview: (ctx.managerUserAskPreview || action.prompt).slice(0, 400),
      });
      reportBack = {
        jobId: job.id,
        originChatId: job.originChatId,
        originThreadId: job.originThreadId,
        userAskPreview: job.userAskPreview,
        targetName: job.targetName,
        targetPath: job.targetPath,
        dispatchPrompt: job.dispatchPrompt,
      };
    }
  }

  try {
    const res = await ctx.submitTopicPrompt({
      threadId: binding.threadId,
      cwd: resumeCwd,
      projectName,
      prompt: action.prompt,
      newSession: !!action.newSession && !resumeSessionId,
      sessionId: resumeSessionId,
      reportBack,
    });
    if (reportBack && res.sessionId) {
      bindJobSession(reportBack.jobId, res.sessionId);
    }
    return {
      action: "send_prompt",
      ok: true,
      data: {
        threadId: binding.threadId,
        name: binding.name,
        projectPath: cwd,
        outcome: res.outcome,
        sessionId: res.sessionId,
        resumedSessionId: resumeSessionId,
        inferredFromMemory: inferredFromMemory || undefined,
        newSession: !!action.newSession && !resumeSessionId,
        promptPreview: action.prompt.slice(0, 200),
        jobId: reportBack?.jobId,
        reportBack: !!reportBack,
      },
      // Manager mode: keep General quiet — agent prose confirms dispatch.
      userNote: ctx.managerMode
        ? undefined
        : `\u{1F4E8} Prompt ${res.outcome} in **${binding.name}** (#${binding.threadId})` +
          (resumeSessionId ? ` session ${resumeSessionId.slice(0, 8)}` : ""),
    };
  } catch (e) {
    if (reportBack) {
      updateManagerJob(reportBack.jobId, {
        status: "failed",
        resultSummary: `dispatch failed: ${(e as Error).message ?? String(e)}`.slice(0, 400),
      });
    }
    return {
      action: "send_prompt",
      ok: false,
      error: (e as Error).message ?? String(e),
      data: {
        threadId: binding.threadId,
        name: binding.name,
        projectPath: cwd,
        jobId: reportBack?.jobId,
        sessionRef: action.sessionId,
      },
    };
  }
}

/**
 * Resolve a session ref from memory (full UUID or short prefix like 019fc9ec)
 * to a concrete on-disk session. Prefer sessions under topicCwd when multiple match.
 */
export function resolveSessionRef(
  store: SessionStore,
  ref: string,
  topicCwd?: string,
): { ok: true; sessionId: string; cwd?: string } | { ok: false; error: string } {
  const raw = ref.trim().replace(/^#?sess[_-]?/i, "");
  if (!raw || raw.length < 4) {
    return { ok: false, error: `Invalid session_id "${ref}"` };
  }
  const compact = raw.replace(/-/g, "").toLowerCase();
  const topicKey = topicCwd
    ? topicCwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    : "";

  // Exact get first.
  const exact = store.get(raw) ?? store.get(raw.toLowerCase());
  if (exact) return { ok: true, sessionId: exact.sessionId, cwd: exact.cwd || undefined };

  let metas;
  try {
    metas = store.list(200);
  } catch {
    return { ok: false, error: `Session store unreadable for "${ref}"` };
  }

  const matches = metas.filter((m) => {
    const id = m.sessionId.toLowerCase();
    const idCompact = id.replace(/-/g, "");
    return (
      id === raw.toLowerCase() ||
      id.startsWith(raw.toLowerCase()) ||
      idCompact.startsWith(compact) ||
      idCompact.includes(compact)
    );
  });
  if (matches.length === 0) {
    return {
      ok: false,
      error: `No session found for session_id "${ref}". Use a full id or longer prefix from memory hits.`,
    };
  }
  // Prefer path under the topic project, then most recently updated.
  matches.sort((a, b) => {
    const aPath = (a.cwd || "").replace(/\\/g, "/").toLowerCase();
    const bPath = (b.cwd || "").replace(/\\/g, "/").toLowerCase();
    const aIn =
      topicKey && (aPath === topicKey || aPath.startsWith(topicKey + "/")) ? 1 : 0;
    const bIn =
      topicKey && (bPath === topicKey || bPath.startsWith(topicKey + "/")) ? 1 : 0;
    if (bIn !== aIn) return bIn - aIn;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });
  const best = matches[0]!;
  return { ok: true, sessionId: best.sessionId, cwd: best.cwd || undefined };
}

/** True when the model used a non-topic placeholder like "…" or "TODO". */
export function isPlaceholderTopicRef(ref: string): boolean {
  const t = ref.trim().toLowerCase();
  if (!t) return true;
  // Any pure punctuation / ellipsis run (incl. multi-char "……" and fullwidth).
  if (/^[\s.…·•⋯︙\-–—_*~`'"“”‘’\u2026\u22ef\u3002]+$/u.test(t)) return true;
  if (t.includes("…") && t.replace(/[.…\s]/g, "").length === 0) return true;
  if (t === "..." || t === "…" || t === "topic" || t === "name" || t === "project") return true;
  if (t === "todo" || t === "tbd" || t === "null" || t === "undefined" || t === "none") return true;
  if (t === "here" || t === "there" || t === "same" || t === "related" || t === "target") return true;
  if (t === "the topic" || t === "that topic" || t === "this topic") return true;
  return false;
}

function safeListTopics(forum: ForumManager): Array<{
  threadId: number;
  name: string;
  kind: string;
  projectPath?: string;
}> {
  try {
    return forum.store.all().map((t) => ({
      threadId: t.threadId,
      name: t.name,
      kind: t.kind,
      projectPath: t.projectPath ?? undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * When the model omits topic / uses "…" / wrong name, pick the best forum topic
 * (+ optional session) from group memory using the user ask and prompt body.
 */
export function inferDispatchTarget(
  ctx: Pick<TelegramActionContext, "store" | "cfg" | "managerUserAskPreview">,
  forum: ForumManager,
  queryParts: string[],
): { binding: ForumTopicBinding; sessionId?: string; cwd?: string } | undefined {
  const query = queryParts
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 400);
  if (query.length < 3) return undefined;

  let topics: ForumTopicBinding[] = [];
  try {
    topics = forum.store.all();
  } catch {
    return undefined;
  }
  if (topics.length === 0) return undefined;

  const preferPaths = topics
    .filter((t) => t.kind === "project" && t.projectPath)
    .map((t) => t.projectPath!)
    .slice(0, 30);

  let hits;
  try {
    hits = searchGroupMemory({
      query,
      limit: 16,
      sessionsDir: ctx.cfg.sessionsDir,
      store: ctx.store,
      topics,
      preferPaths,
      preferGeneral: false,
      maxSessions: 80,
    });
  } catch {
    return undefined;
  }
  if (!hits.length) return undefined;

  // 1) Session / history hit → path → topic (prefer resume for follow-ups).
  for (const h of hits) {
    if (!h.sessionId) continue;
    let path = h.path;
    if (!path) {
      try {
        path = ctx.store.get(h.sessionId)?.cwd;
      } catch {
        path = undefined;
      }
    }
    if (!path) continue;
    const b = resolveTopicFromPath(forum, path);
    if (!b?.projectPath || b.kind === "general") continue;
    const sess = resolveSessionRef(ctx.store, h.sessionId, path);
    return {
      binding: b,
      sessionId: sess.ok ? sess.sessionId : h.sessionId,
      cwd: (sess.ok && sess.cwd) || path,
    };
  }

  // 2) Direct topic hit (project preferred), then attach newest session under path.
  for (const h of hits) {
    if (h.kind !== "topic" || h.threadId === undefined) continue;
    const b = forum.store.get(h.threadId);
    if (!b?.projectPath) continue;
    if (b.kind === "general") continue;
    const under = newestSessionUnderPath(ctx.store, b.projectPath);
    if (under) {
      return { binding: b, sessionId: under.sessionId, cwd: under.cwd || b.projectPath };
    }
    return { binding: b };
  }

  // 3) Unique project-topic name token match from query.
  const qn = normalizeTopicKey(query);
  const nameHits = topics.filter((t) => {
    if (t.kind === "general" || !t.projectPath) return false;
    const tn = normalizeTopicKey(t.name);
    return tn.length >= 4 && (qn.includes(tn) || tn.includes(qn.slice(0, Math.min(12, qn.length))));
  });
  if (nameHits.length === 1) {
    const b = nameHits[0]!;
    const under = newestSessionUnderPath(ctx.store, b.projectPath!);
    if (under) {
      return { binding: b, sessionId: under.sessionId, cwd: under.cwd || b.projectPath || undefined };
    }
    return { binding: b };
  }

  return undefined;
}

function newestSessionUnderPath(
  store: SessionStore,
  projectPath: string,
): { sessionId: string; cwd?: string } | undefined {
  const key = normPath(projectPath);
  if (!key) return undefined;
  let metas;
  try {
    metas = store.list(80);
  } catch {
    return undefined;
  }
  const under = metas
    .filter((m) => {
      const p = normPath(m.cwd || "");
      return p === key || p.startsWith(key + "/");
    })
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  const best = under[0];
  if (!best) return undefined;
  return { sessionId: best.sessionId, cwd: best.cwd || undefined };
}

function normalizeTopicKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Map a session/project path to a forum topic binding (exact path, then parent). */
export function resolveTopicFromPath(
  forum: ForumManager,
  cwd: string,
): ForumTopicBinding | undefined {
  const key = normPath(cwd);
  if (!key) return undefined;
  const all = forum.store.all().filter((t) => t.projectPath);
  // Exact path match first.
  const exact = all.filter((t) => normPath(t.projectPath!) === key);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    // Prefer project kind over general/ai_chat.
    const proj = exact.find((t) => t.kind === "project");
    return proj || exact[0];
  }
  // Session cwd may be a subfolder of the bound project path.
  const parents = all.filter((t) => {
    const tp = normPath(t.projectPath!);
    return key === tp || key.startsWith(tp + "/");
  });
  if (parents.length === 0) {
    // Or topic path is under session cwd (less common).
    const children = all.filter((t) => {
      const tp = normPath(t.projectPath!);
      return tp.startsWith(key + "/");
    });
    if (children.length === 1) return children[0];
    if (children.length > 1) {
      children.sort((a, b) => normPath(a.projectPath!).length - normPath(b.projectPath!).length);
      return children[0];
    }
    return undefined;
  }
  // Longest matching project path wins.
  parents.sort((a, b) => normPath(b.projectPath!).length - normPath(a.projectPath!).length);
  const topLen = normPath(parents[0]!.projectPath!).length;
  const top = parents.filter((t) => normPath(t.projectPath!).length === topLen);
  if (top.length === 1) return top[0];
  return top.find((t) => t.kind === "project") || top[0];
}

function listTopicHints(forum: ForumManager, limit = 12): string {
  try {
    const topics = forum.store.all().slice(0, limit);
    if (topics.length === 0) return "";
    return topics.map((t) => `«${t.name}» #${t.threadId}`).join(", ");
  } catch {
    return "";
  }
}

/**
 * Resolve a topic ref: numeric / #id, "general", "ai chat", exact title,
 * or fuzzy (prefix / contains / normalized) when unique.
 */
export function resolveTopicRef(
  forum: ForumManager,
  ref: string,
  cfg: AppConfig,
): { ok: true; binding: ForumTopicBinding } | { ok: false; error: string } {
  const raw = ref.trim();
  if (!raw || isPlaceholderTopicRef(raw)) {
    return {
      ok: false,
      error: `Empty or placeholder topic "${raw || "…"}". Use exact title, #threadId, "general", or "ai chat".`,
    };
  }

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

  const all = forum.store.all();

  // Exact title match (case-insensitive)
  const hits = all.filter((t) => t.name.toLowerCase() === key);
  if (hits.length === 1) return { ok: true, binding: hits[0]! };
  if (hits.length > 1) {
    return {
      ok: false,
      error: `Multiple topics named "${raw}" (${hits.map((h) => "#" + h.threadId).join(", ")}). Use #threadId.`,
    };
  }

  // Fuzzy: starts-with / includes / normalized alphanumeric.
  // Require at least 3 useful chars to avoid accidental matches.
  const keyN = normalizeTopicKey(raw);
  if (keyN.length >= 3 || key.length >= 3) {
    const scored = all
      .map((t) => {
        const n = t.name.toLowerCase();
        const nn = normalizeTopicKey(t.name);
        let score = 0;
        if (n === key || nn === keyN) score = 100;
        else if (n.startsWith(key) || nn.startsWith(keyN)) score = 80;
        else if (key.startsWith(n) && n.length >= 3) score = 70;
        else if (n.includes(key) || (keyN.length >= 4 && nn.includes(keyN))) score = 50;
        else if (keyN.length >= 4 && keyN.includes(nn) && nn.length >= 4) score = 40;
        return { t, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.t.name.length - b.t.name.length);

    if (scored.length === 1 && scored[0]!.score >= 40) {
      return { ok: true, binding: scored[0]!.t };
    }
    if (scored.length > 1) {
      const best = scored[0]!.score;
      const top = scored.filter((x) => x.score === best);
      if (top.length === 1 && best >= 70) {
        return { ok: true, binding: top[0]!.t };
      }
      return {
        ok: false,
        error:
          `Ambiguous topic "${raw}" — matches: ` +
          top
            .slice(0, 6)
            .map((x) => `«${x.t.name}» #${x.t.threadId}`)
            .join(", ") +
          ". Use exact title or #threadId.",
      };
    }
  }

  const hint = listTopicHints(forum);
  return {
    ok: false,
    error:
      `Topic not found: "${raw}". Use exact title, #threadId, "general", or "ai chat".` +
      (hint ? ` Available: ${hint}` : ""),
  };
}

function searchMemory(
  action: Extract<TelegramAction, { action: "search_memory" }>,
  ctx: TelegramActionContext,
): TelegramActionResult {
  const topics = ctx.forum?.isReady ? ctx.forum.store.all() : undefined;
  const workspace =
    topics?.find((t) => t.kind === "general")?.projectPath ||
    topics?.find((t) => t.kind === "ai_chat")?.projectPath ||
    ctx.cfg.workspace;
  const preferPaths = [
    workspace,
    ...(topics ?? [])
      .filter((t) => t.kind === "project" && t.projectPath)
      .map((t) => t.projectPath!)
      .slice(0, 20),
  ];
  const hits = searchGroupMemory({
    query: action.query,
    limit: action.limit ?? 14,
    sessionsDir: ctx.cfg.sessionsDir,
    store: ctx.store,
    topics,
    preferPaths,
    preferGeneral: !!ctx.managerMode,
    maxSessions: ctx.managerMode ? 80 : 50,
  });
  return {
    action: "search_memory",
    ok: true,
    data: {
      query: action.query,
      hits,
      note:
        "Hits ranked by relevance + recency (newest sessions/history first). " +
        "Snippets may include [age]. Prefer the newest session for a project path. " +
        "When following up on a hit, pass its sessionId as send_prompt.session_id " +
        "(full id or first 8 chars) so the bridge resumes that session, not the topic foreground. " +
        (ctx.managerMode ? "Use before git." : ""),
    },
    // Silent in chat (manager or not) — results go to the agent.
    userNote: undefined,
  };
}

function listTopics(ctx: TelegramActionContext): TelegramActionResult {
  const forum = ctx.forum;
  if (!forum?.isReady) {
    return {
      action: "list_topics",
      ok: true,
      data: { topics: [], note: "Forum not ready" },
    };
  }
  const topics = forum.store.all().map((t) => ({
    threadId: t.threadId,
    name: t.name,
    kind: t.kind,
    projectPath: t.projectPath,
    sessionId: t.sessionId,
  }));
  return {
    action: "list_topics",
    ok: true,
    data: { topics, count: topics.length },
  };
}

function listJobs(): TelegramActionResult {
  const jobs = listRecentManagerJobs(20).map((j) => ({
    id: j.id,
    status: j.status,
    targetName: j.targetName,
    targetThreadId: j.targetThreadId,
    targetPath: j.targetPath,
    childSessionId: j.childSessionId,
    userAskPreview: j.userAskPreview.slice(0, 160),
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    resultSummary: j.resultSummary?.slice(0, 200),
  }));
  return {
    action: "list_jobs",
    ok: true,
    data: { jobs, count: jobs.length },
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

/** Telegram hard cap; leave headroom for UTF-16 / markup surprises. */
const TG_MSG_SAFE = 4000;

/**
 * Split a bridge prompt into Telegram-safe announce parts (full coverage, no crop).
 * Exported for tests — agent still receives the unsplit string separately.
 */
export function splitBridgeAnnounceParts(
  prompt: string,
  newSession: boolean,
  sessNote = "",
): string[] {
  const flag = newSession ? " (new session)" : "";
  const note = sessNote || "";
  const singleHeader = `\u{1F4E8} Prompt from bridge${flag}${note} (${prompt.length} chars)\n\n`;
  if (singleHeader.length + prompt.length <= TG_MSG_SAFE) {
    return [singleHeader + prompt];
  }
  // Conservative body size so part headers never push over TG_MSG_SAFE.
  const BODY = 3400;
  const total = Math.max(1, Math.ceil(prompt.length / BODY));
  const parts: string[] = [];
  for (let i = 0; i < total; i++) {
    const chunk = prompt.slice(i * BODY, (i + 1) * BODY);
    const prefix =
      i === 0
        ? `\u{1F4E8} Prompt from bridge${flag}${note} (part 1/${total}, ${prompt.length} chars)\n\n`
        : `\u{1F4E8} Prompt from bridge (part ${i + 1}/${total})\n\n`;
    const full = prefix + chunk;
    if (full.length <= TG_MSG_SAFE) {
      parts.push(full);
    } else {
      const room = Math.max(500, TG_MSG_SAFE - prefix.length);
      for (let o = 0; o < chunk.length; o += room) {
        parts.push(prefix + chunk.slice(o, o + room));
      }
    }
  }
  return parts;
}

/**
 * Post the bridge prompt into the target topic for humans to read.
 * Splits across multiple Telegram messages (4096 hard limit) so long
 * orchestration prompts are not silently cropped in the topic UI.
 * The agent still receives the full unsplit string via submitTopicPrompt.
 */
async function announceBridgePrompt(
  api: Api,
  chatId: number,
  threadId: number,
  prompt: string,
  newSession: boolean,
  sessNote = "",
): Promise<void> {
  const thread = outboundThreadExtra(threadId);
  const parts = splitBridgeAnnounceParts(prompt, newSession, sessNote);
  try {
    for (const part of parts) {
      await api.sendMessage(chatId, part, thread);
    }
  } catch (e) {
    log.debug(`send_prompt announce failed: ${(e as Error).message}`);
  }
}
