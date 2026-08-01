/**
 * Resolve private-chat vs forum-topic scope for handlers (menu, running, sessions).
 * Forum topics use a dedicated ChatController with per-topic settings + sessions.
 */
import type { Context } from "grammy";
import type { BotDeps } from "./deps.js";
import type { ChatController } from "./chat-controller.js";
import type { SessionRuntime } from "./session-runtime.js";
import { forumThreadId } from "../forum/thread.js";
import { FORUM_GENERAL_THREAD_ID } from "../forum/thread.js";

export interface HandlerScope {
  chatId: number;
  /** Forum message_thread_id when in the configured topic group. */
  threadId?: number;
  isForum: boolean;
  /** Settings key for this scope (chat or chat:t{thread}). */
  settingsKey: string;
  controller: ChatController;
  /** Foreground runtime for this scope. */
  rt: SessionRuntime;
  /** Extra fields so replies land in the same topic. */
  threadExtra: { message_thread_id?: number };
  /** Project path when forum topic is bound. */
  projectPath?: string;
  projectName?: string;
}

/** Build settings storage key. */
export function settingsKeyFor(chatId: number, threadId?: number): string {
  if (threadId === undefined) return String(chatId);
  return `${chatId}:t${threadId}`;
}

/** Extract thread id from message or callback message. */
export function threadIdFromContext(ctx: Context): number | undefined {
  const msg = ctx.message ?? ctx.callbackQuery?.message;
  if (!msg || !("message_thread_id" in msg)) return undefined;
  const tid = (msg as { message_thread_id?: number }).message_thread_id;
  return typeof tid === "number" ? tid : undefined;
}

/**
 * Resolve handler scope. For the forum group, ensures topic binding (General →
 * workspace) and returns the topic's ChatController + foreground runtime.
 */
export function resolveScope(ctx: Context, deps: BotDeps): HandlerScope {
  const chatId = ctx.chat!.id;
  const rawThread = threadIdFromContext(ctx);
  const isForum = Boolean(deps.forum && deps.cfg.topicGroupId === chatId);
  const threadExtra =
    isForum || rawThread !== undefined
      ? { message_thread_id: isForum ? forumThreadId(rawThread) : rawThread }
      : {};

  if (!isForum || !deps.forum) {
    const controller = deps.registry.controller(chatId);
    return {
      chatId,
      isForum: false,
      settingsKey: settingsKeyFor(chatId),
      controller,
      rt: controller.foreground(),
      threadExtra: rawThread !== undefined ? { message_thread_id: rawThread } : {},
    };
  }

  const tid = forumThreadId(rawThread);
  // Ensure General / AI paths are bound before opening menus.
  if (tid === FORUM_GENERAL_THREAD_ID) {
    if (!deps.forum.store.get(tid)?.projectPath) {
      deps.forum.store.bindProject(tid, deps.cfg.workspace, "General", "general");
    }
  }
  const resolved = deps.forum.resolveCwd(tid);
  const cwd = resolved?.cwd ?? deps.cfg.workspace;
  const projectName = resolved?.projectName ?? (tid === FORUM_GENERAL_THREAD_ID ? "General" : `Topic ${tid}`);
  if (!resolved && tid !== FORUM_GENERAL_THREAD_ID) {
    // Unbound topic — still allow menu with workspace fallback for prefs; path
    // bind happens on next text message via resolveForumRuntime.
  }
  const controller = deps.registry.forumController(chatId, tid, cwd, projectName);
  return {
    chatId,
    threadId: tid,
    isForum: true,
    settingsKey: settingsKeyFor(chatId, tid),
    controller,
    rt: controller.foreground(),
    threadExtra: { message_thread_id: tid },
    projectPath: cwd,
    projectName,
  };
}
