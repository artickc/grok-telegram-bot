/**
 * Forum topic group: auto-setup, user-created topic binding, and path prompts.
 */
import type { Bot } from "grammy";
import { createLogger } from "../../logger.js";
import type { ForumManager } from "../../forum/manager.js";
import type { BotDeps } from "../deps.js";
import { FORUM_GENERAL_THREAD_ID, forumThreadId } from "../../forum/thread.js";

const log = createLogger("forum-handler");

export function registerForum(bot: Bot, deps: BotDeps, forum: ForumManager): void {
  const groupId = forum.groupId;

  // Service message: user (or another admin) created a topic.
  bot.on("message:forum_topic_created", async (ctx) => {
    if (ctx.chat?.id !== groupId) return;
    const created = ctx.message.forum_topic_created;
    const threadId = ctx.message.message_thread_id;
    if (!created || threadId === undefined) return;
    // Skip General — always workspace-bound.
    if (threadId === FORUM_GENERAL_THREAD_ID) return;
    const binding = forum.noteUserTopic(threadId, created.name);
    log.info(`user topic created: ${created.name} (#${threadId})`);
    if (!binding.projectPath) {
      await ctx.reply(
        `\u{1F4CC} New topic **${created.name}**.\n\n` +
          `Send the **absolute project path** (or exact catalog project name) to bind this topic.\n` +
          `Example: \`H:\\\\Lucru\\\\Domains\\\\MyApp\``,
        { parse_mode: "Markdown", message_thread_id: threadId },
      ).catch(() => {});
    }
  });

  // Optional: re-run setup command for admins in the group.
  bot.command("forum_setup", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    const replyOpts =
      threadId !== undefined ? { message_thread_id: threadId } : {};
    if (ctx.chat?.id !== groupId) {
      await ctx.reply("Use this command inside the configured forum group.", replyOpts).catch(() => {});
      return;
    }
    await ctx.reply("Setting up forum topics…", replyOpts).catch(() => {});
    try {
      await forum.ensureSetup();
      const n = forum.store.all().length;
      await ctx.reply(`Forum setup done. ${n} topic(s) mapped.`, replyOpts).catch(() => {});
    } catch (e) {
      await ctx.reply(`Setup failed: ${(e as Error).message}`, replyOpts).catch(() => {});
    }
  });

  void deps;
}

/**
 * Resolve a forum-group text message to a SessionRuntime, or handle bind flow.
 * Returns "handled" when the message was consumed (bind ask / bind result).
 */
export async function resolveForumRuntime(
  deps: BotDeps,
  forum: ForumManager,
  chatId: number,
  threadId: number | undefined,
  text: string,
  messageId: number,
): Promise<{ rt: import("../session-runtime.js").SessionRuntime } | "handled" | "ignore"> {
  if (chatId !== forum.groupId) return "ignore";
  const tid = forumThreadId(threadId);

  // General topic → always workspace (no path prompt).
  if (tid === FORUM_GENERAL_THREAD_ID) {
    const cwd = deps.cfg.workspace;
    if (!forum.store.get(tid)?.projectPath) {
      forum.store.bindProject(tid, cwd, "General", "general");
    }
    const rt = deps.registry.getForumTopic(chatId, tid, cwd, "General");
    return { rt };
  }

  // Ensure we know about this thread.
  let binding = forum.store.get(tid);
  if (!binding) {
    binding = forum.noteUserTopic(tid, `Topic ${tid}`);
  }

  // Unbound only: try to interpret text as path (do not steal normal prompts
  // when already bound — even if pending flag is stale).
  if (!binding.projectPath) {
    const result = forum.tryBindPath(tid, text);
    if (result.ok) {
      const iconNote = result.binding.iconPath ? `\nIcon: ${result.binding.iconPath}` : "";
      await deps.api
        .sendMessage(
          chatId,
          `\u2705 Bound to project:\n\`${result.binding.projectPath}\`${iconNote}\n\nYou can chat here now.`,
          { message_thread_id: tid, parse_mode: "Markdown", reply_parameters: { message_id: messageId } },
        )
        .catch(() => {});
      // Warm runtime; path-only message is not submitted as an agent prompt.
      const resolved = forum.resolveCwd(tid);
      if (resolved) {
        deps.registry.getForumTopic(chatId, tid, resolved.cwd, resolved.projectName);
      }
      return "handled";
    }
    await deps.api
      .sendMessage(
        chatId,
        `\u2753 ${result.error}\n\nSend an absolute project folder path or catalog project name to bind this topic.`,
        { message_thread_id: tid, reply_parameters: { message_id: messageId } },
      )
      .catch(() => {});
    return "handled";
  }

  const resolved = forum.resolveCwd(tid);
  if (!resolved) {
    forum.store.markPending(tid);
    await deps.api
      .sendMessage(
        chatId,
        `\u2753 This topic is not linked to a project yet.\nSend an absolute path or catalog project name.`,
        { message_thread_id: tid },
      )
      .catch(() => {});
    return "handled";
  }

  const rt = deps.registry.getForumTopic(chatId, tid, resolved.cwd, resolved.projectName);
  return { rt };
}
