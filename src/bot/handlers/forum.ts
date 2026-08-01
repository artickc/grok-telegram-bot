/**
 * Forum topic group: auto-setup, user-created topic binding, and path prompts.
 */
import type { Bot } from "grammy";
import { createLogger } from "../../logger.js";
import type { ForumManager } from "../../forum/manager.js";
import type { BotDeps } from "../deps.js";

const log = createLogger("forum-handler");

export function registerForum(bot: Bot, deps: BotDeps, forum: ForumManager): void {
  const groupId = forum.groupId;

  // Service message: user (or another admin) created a topic.
  bot.on("message:forum_topic_created", async (ctx) => {
    if (ctx.chat?.id !== groupId) return;
    const created = ctx.message.forum_topic_created;
    const threadId = ctx.message.message_thread_id;
    if (!created || threadId === undefined) return;
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
    if (ctx.chat?.id !== groupId) {
      await ctx.reply("Use this command inside the configured forum group.").catch(() => {});
      return;
    }
    await ctx.reply("Setting up forum topics…").catch(() => {});
    try {
      await forum.ensureSetup();
      const n = forum.store.all().length;
      await ctx.reply(`Forum setup done. ${n} topic(s) mapped.`).catch(() => {});
    } catch (e) {
      await ctx.reply(`Setup failed: ${(e as Error).message}`).catch(() => {});
    }
  });

  void deps; // registry used via message handler
}

/**
 * Resolve a forum-group text message to a SessionRuntime, or handle bind flow.
 * Returns null when the message was consumed (bind ask / bind result) and must
 * not be submitted as a normal prompt.
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
  // General topic without thread id — treat as AI chat workspace if configured.
  const tid = threadId ?? 1;

  // Ensure we know about this thread.
  let binding = forum.store.get(tid);
  if (!binding) {
    binding = forum.noteUserTopic(tid, `Topic ${tid}`);
  }

  // Pending bind or unbound: try to interpret text as path.
  if (!binding.projectPath || forum.store.isPending(tid)) {
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
      // Fall through to create runtime and optionally ignore this message as
      // the path only — user often sends path alone.
      const resolved = forum.resolveCwd(tid);
      if (!resolved) return "handled";
      const rt = deps.registry.getForumTopic(chatId, tid, resolved.cwd, resolved.projectName);
      // Path-only message: don't also run as agent prompt.
      return "handled";
    }
    // If it didn't look like a path and we're still unbound, re-prompt.
    if (!binding.projectPath) {
      await deps.api
        .sendMessage(
          chatId,
          `\u2753 ${result.error}\n\nSend an absolute project folder path or catalog project name to bind this topic.`,
          { message_thread_id: tid, reply_parameters: { message_id: messageId } },
        )
        .catch(() => {});
      return "handled";
    }
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
