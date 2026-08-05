/**
 * Forum topic group: auto-setup, user-created topic binding, and path prompts.
 */
import type { Bot } from "grammy";
import { createLogger } from "../../logger.js";
import type { ForumManager } from "../../forum/manager.js";
import type { BotDeps } from "../deps.js";
import { FORUM_GENERAL_THREAD_ID, forumThreadId } from "../../forum/thread.js";

const log = createLogger("forum-handler");

const BIND_HINT =
  `Send the **absolute project path** or an **exact** catalog project name to bind this topic.\n` +
  `Example: \`H:\\\\Lucru\\\\Domains\\\\MyApp\``;

export function registerForum(bot: Bot, deps: BotDeps, forum: ForumManager): void {
  const groupId = forum.groupId;

  // Service message: user (or another admin) created a topic.
  bot.on("message:forum_topic_created", async (ctx) => {
    if (ctx.chat?.id !== groupId) return;
    // Group ignored (not admin / no Topics / probe failed).
    if (!forum.isReady) {
      log.debug(`ignore forum_topic_created — forum not ready (${forum.getStatusText()})`);
      return;
    }
    const created = ctx.message.forum_topic_created;
    const threadId = ctx.message.message_thread_id;
    if (!created || threadId === undefined) return;
    // Skip General — always workspace-bound.
    if (threadId === FORUM_GENERAL_THREAD_ID) return;

    forum.noteUserTopic(threadId, created.name);
    log.info(`user topic created: ${created.name} (#${threadId})`);

    // Exact catalog name → bind immediately (no message required).
    const auto = await forum.tryAutoBindByTopicName(threadId, created.name);
    if (auto.status === "bound") {
      await ctx
        .reply(
          `\u2705 Topic **${created.name}** auto-bound to project:\n\`${auto.binding.projectPath}\`\n\nYou can chat here now.`,
          { parse_mode: "Markdown", message_thread_id: threadId },
        )
        .catch(() => {});
      return;
    }

    if (auto.status === "already_bound") {
      await ctx
        .reply(
          `\u{1F4CC} New topic **${created.name}**.\n\n` +
            `Exact catalog match \`${auto.projectPath}\` is already bound to topic #${auto.otherThreadId}.\n` +
            BIND_HINT,
          { parse_mode: "Markdown", message_thread_id: threadId },
        )
        .catch(() => {});
      return;
    }

    await ctx
      .reply(
        `\u{1F4CC} New topic **${created.name}**.\n\n` +
          `No exact catalog project matched this name.\n` +
          BIND_HINT,
        { parse_mode: "Markdown", message_thread_id: threadId },
      )
      .catch(() => {});
  });

  // Re-probe when the bot is promoted/demoted in the configured group.
  bot.on("my_chat_member", async (ctx) => {
    if (ctx.chat?.id !== groupId) return;
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === "administrator" || status === "creator") {
      log.info(`bot became ${status} in topic group — re-running forum setup`);
      void forum.ensureSetup().catch((e) => {
        log.warn(`forum re-setup after promotion failed: ${(e as Error).message}`);
      });
      return;
    }
    if (status === "member" || status === "restricted" || status === "left" || status === "kicked") {
      forum.markDisabled(
        "not_admin",
        `bot status is now "${status}" — forum topic management ignored until the bot is admin again`,
      );
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
    await ctx
      .reply(
        "Setting up forum topics (this can take a while for large catalogs)…",
        replyOpts,
      )
      .catch(() => {});
    try {
      await forum.ensureSetup();
      if (!forum.isReady) {
        await ctx
          .reply(
            `\u26A0\uFE0F Forum setup skipped / group ignored.\n${forum.getStatusText()}`,
            replyOpts,
          )
          .catch(() => {});
        return;
      }
      const n = forum.store.all().length;
      await ctx
        .reply(`\u2705 Forum setup done. ${n} topic(s) mapped.\n${forum.getStatusText()}`, replyOpts)
        .catch(() => {});
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
  // Not admin / Topics off / probe failed — do not steal group messages.
  if (!forum.isReady) return "ignore";
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

  // Unbound only: try to interpret text as path / exact catalog name (do not
  // steal normal prompts when already bound — even if pending flag is stale).
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
        `\u2753 ${result.error}\n\n${BIND_HINT.replace(/\*\*/g, "")}`,
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
        `\u2753 This topic is not linked to a project yet.\n${BIND_HINT.replace(/\*\*/g, "")}`,
        { message_thread_id: tid },
      )
      .catch(() => {});
    return "handled";
  }

  // Multi-session controller for this topic (own model/reasoning/running list).
  // First message with no sessionId creates one via ensureSession on submit.
  const controller = deps.registry.forumController(chatId, tid, resolved.cwd, resolved.projectName);
  return { rt: controller.foreground() };
}
