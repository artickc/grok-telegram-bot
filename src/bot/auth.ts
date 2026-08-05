/**
 * Authorization middleware: restricts the bot to ALLOWED_USERS when configured.
 *
 * Applies to **private chats and groups/forum topics alike**. User IDs are
 * comma-separated in env (`ALLOWED_USERS=111,222,333`). Empty set = allow all
 * (unsafe — especially with TOPIC_GROUP_ID).
 *
 * Unauthorized users in groups are ignored silently (no ⛔ spam). Private chats
 * get one clear denial. Callback taps get a toast.
 */
import type { Context, NextFunction } from "grammy";
import type { AppConfig } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("auth");

export function createAuthMiddleware(cfg: AppConfig) {
  if (cfg.allowAllUsers) {
    log.warn("ALLOWED_USERS is empty — the bot will respond to ANY Telegram user.");
    if (cfg.topicGroupId !== undefined) {
      log.warn(
        "TOPIC_GROUP_ID is set with empty ALLOWED_USERS — any group member can drive sessions.",
      );
    }
  } else {
    log.info(`ALLOWED_USERS: ${cfg.allowedUsers.size} id(s) (private + groups)`);
    if (cfg.allowedUsers.size === 0) {
      log.warn(
        "ALLOWED_USERS was set but no valid numeric ids remain — denying everyone (fail closed).",
      );
    }
  }

  return async (ctx: Context, next: NextFunction): Promise<void> => {
    // Bot membership changes (promote/demote) must always reach handlers so
    // forum readiness can re-probe — not gated on ALLOWED_USERS or from.is_bot.
    if (ctx.myChatMember) {
      await next();
      return;
    }

    const from = ctx.from;
    // Only a genuine USER action is subject to the auth gate. Ignore bot-authored
    // updates and missing `from` (service noise) so we never ⛔-spam ourselves.
    if (!from || from.is_bot) return;
    const m = ctx.message ?? ctx.editedMessage;
    if (
      m &&
      (m.pinned_message ||
        m.new_chat_members ||
        m.left_chat_member ||
        m.forum_topic_closed ||
        m.forum_topic_reopened ||
        m.forum_topic_edited ||
        m.general_forum_topic_hidden ||
        m.general_forum_topic_unhidden)
    ) {
      return;
    }

    // forum_topic_created: only allowed users get the path-bind prompt.
    if (m?.forum_topic_created) {
      if (isAllowed(cfg, from.id)) {
        await next();
        return;
      }
      log.debug(`blocked unauthorized forum_topic_created from ${from.id}`);
      return;
    }

    if (isAllowed(cfg, from.id)) {
      await next();
      return;
    }

    log.warn(
      `blocked unauthorized user ${from.id}` +
        (ctx.chat ? ` in chat ${ctx.chat.id} (${ctx.chat.type})` : ""),
    );
    await denyUnauthorized(ctx, m);
  };
}

/**
 * True when ALLOWED_USERS was blank (open) or `userId` is listed.
 * When allowAllUsers is false and the set is empty, nobody is allowed.
 */
export function isAllowed(cfg: AppConfig, userId: number | string): boolean {
  if (cfg.allowAllUsers) return true;
  return cfg.allowedUsers.has(String(userId));
}

/** Groups, supergroups, and channels: never ⛔-reply (silent deny). */
function isGroupChat(ctx: Context): boolean {
  const t = ctx.chat?.type;
  return t === "group" || t === "supergroup" || t === "channel";
}

/** Private: one ⛔ reply. Group: silent (or callback toast). Never spam topics. */
async function denyUnauthorized(
  ctx: Context,
  m: { message_thread_id?: number } | undefined,
): Promise<void> {
  if (ctx.callbackQuery) {
    await ctx
      .answerCallbackQuery({
        text: "\u26D4 Not authorized",
        show_alert: true,
      })
      .catch(() => {});
    return;
  }
  if (!ctx.chat || isGroupChat(ctx)) return; // groups: ignore quietly
  const threadId = m && "message_thread_id" in m ? m.message_thread_id : undefined;
  const extra = threadId !== undefined ? { message_thread_id: threadId as number } : {};
  await ctx
    .reply("\u26D4 Not authorized. Ask the bot owner to add your Telegram ID to ALLOWED_USERS.", extra)
    .catch(() => {});
}
