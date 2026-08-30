/**
 * Plain text messages -> Grok prompts.
 *
 * Telegram caps a single message at 4096 characters, so a long paste is
 * delivered to the bot as several back-to-back messages. Naively, each part
 * became its own queued turn ("Queued position 1…4") and a part that happened
 * to start with "/" was misread as an "Unknown command". We therefore COALESCE
 * rapid consecutive text messages per chat within a short debounce window
 * (`MESSAGE_BATCH_MS`) into a single prompt — one submission, one confirmation.
 *
 * Project topics: user messages are replaced by a bot-owned prompt anchor
 * (`#prompt_<id>`) so the chat shows immediate life while CLI/ACP starts.
 *
 * General (manager): user messages are KEPT; AI replies thread to the user
 * message. Each message is a NEW session (parallel), unless the user replies
 * to a bot message — then that session continues.
 */
import type { Bot } from "grammy";
import { textPrompt } from "../../app/types.js";
import { createLogger } from "../../logger.js";
import {
  batchKey,
  forumThreadId,
  isGeneralThread,
  outboundThreadExtra,
} from "../../forum/thread.js";
import type { BotDeps } from "../deps.js";
import { adoptUserPrompt, newPromptId } from "../prompt-anchor.js";
import { extractReplyContext } from "../reply-context.js";
import { resolveForumRuntime } from "./forum.js";
import type { SessionRuntime } from "../session-runtime.js";

const log = createLogger("message");

/** A pending burst of text messages from one chat/topic, awaiting coalescing. */
interface TextBatch {
  parts: string[];
  ids: number[];
  /** Forum topic thread id (undefined for private chats / General without id). */
  threadId?: number;
  /** Reference content if the burst began as a reply to another message. */
  quoted?: string;
  /** Telegram message_id the user is replying to (for session follow-up). */
  replyToMessageId?: number;
  /** Text of the replied-to message (for #sess_ recovery). */
  replyToText?: string;
  timer: NodeJS.Timeout;
}

export function registerMessages(bot: Bot, deps: BotDeps): void {
  const batches = new Map<string, TextBatch>();
  const windowMs = deps.cfg.messageBatchMs;

  const arm = (key: string): NodeJS.Timeout =>
    setTimeout(() => void flush(deps, batches, key), windowMs);

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (!text.trim()) return;
    // Slash commands are handled by bot.command / menu — never batch as agent prompts.
    if (!text.includes("\n") && text.startsWith("/")) return;

    const chatId = ctx.chat.id;
    const id = ctx.message.message_id;
    const rawThreadId = ctx.message.message_thread_id;
    const isForum = Boolean(deps.forum?.isActiveForumChat(chatId));
    const threadId = isForum ? forumThreadId(rawThreadId) : rawThreadId;
    const quoted = extractReplyContext(ctx);
    const replyToMessageId = ctx.message.reply_to_message?.message_id;
    const replyToText =
      ctx.message.reply_to_message?.text ?? ctx.message.reply_to_message?.caption;
    // General: do not coalesce independent messages (parallel sessions).
    // Still coalesce multi-part 4096 splits when reply chain is empty and rapid.
    const key = isGeneralThread(threadId) && isForum
      ? `${chatId}:${threadId ?? 1}:m${id}`
      : batchKey(chatId, rawThreadId, isForum);

    const batch = batches.get(key);
    if (batch) {
      clearTimeout(batch.timer);
      batch.parts.push(text);
      batch.ids.push(id);
      if (quoted && !batch.quoted) batch.quoted = quoted;
      if (replyToMessageId !== undefined && batch.replyToMessageId === undefined) {
        batch.replyToMessageId = replyToMessageId;
        batch.replyToText = replyToText;
      }
      batch.timer = arm(key);
      return;
    }
    batches.set(key, {
      parts: [text],
      ids: [id],
      threadId,
      quoted,
      replyToMessageId,
      replyToText,
      timer: arm(key),
    });
  });
}

/** Coalesce a chat's buffered parts into one prompt and submit it once. */
async function flush(deps: BotDeps, batches: Map<string, TextBatch>, key: string): Promise<void> {
  const batch = batches.get(key);
  if (!batch) return;
  batches.delete(key);

  const combined = batch.parts.join("\n").trim();
  if (!combined) return;

  const [chatIdStr] = key.split(":");
  const chatId = Number(chatIdStr);
  const threadId = batch.threadId;

  if (batch.parts.length === 1 && !combined.includes("\n") && combined.startsWith("/")) {
    return;
  }

  const isForum = Boolean(deps.forum?.isActiveForumChat(chatId));
  const isGeneral = isForum && isGeneralThread(threadId);

  let rt: SessionRuntime = deps.registry.get(chatId);

  if (isForum && deps.forum) {
    const resolved = await resolveForumRuntime(
      deps,
      deps.forum,
      chatId,
      threadId,
      combined,
      batch.ids[0]!,
    );
    if (resolved === "handled" || resolved === "ignore") return;

    if (isGeneral) {
      // ── General manager path ─────────────────────────────────────────
      const controller = deps.registry.forumController(
        chatId,
        forumThreadId(threadId),
        resolved.rt.cwd,
        resolved.rt.projectName ?? "General",
      );

      // Reply → continue same session (map, #sess_ on controlled runtimes, or disk).
      // Fresh message → new parallel session (does not queue behind other General work).
      const continueRt = await controller.resolveContinueFromReply({
        replyToMessageId: batch.replyToMessageId,
        replyToText: batch.replyToText,
        cwd: resolved.rt.cwd,
        projectName: resolved.rt.projectName ?? "General",
      });

      const userMsgId = batch.ids[0]!;
      const replyTo = userMsgId;
      // Keep user message; reply to it. No overwrite / adopt delete.

      // New session: post "Starting…" FIRST (before ACP session/new) so the user
      // sees life immediately. runTurn later edits it to Thinking… then streams.
      // Follow-up on existing session: skip Starting (runTurn posts Thinking…).
      let seedMessageId: number | undefined;
      if (!continueRt) {
        seedMessageId = await sendStatus(
          deps,
          chatId,
          "Starting\u2026",
          threadId,
          replyTo,
        );
        rt = await controller.addParallel(
          resolved.rt.cwd,
          resolved.rt.projectName ?? "General",
        );
        if (seedMessageId !== undefined && rt.sessionId) {
          controller.bindTelegramMessage(seedMessageId, rt.sessionId);
        }
      } else {
        rt = continueRt;
        // FG for status panel; manager setForeground keeps busy siblings streaming.
        if (rt.sessionId) await controller.switchTo(rt.sessionId).catch(() => {});
      }
      if (rt.sessionId) controller.bindTelegramMessage(userMsgId, rt.sessionId);

      try {
        const outcome = await rt.submit(
          textPrompt(combined, replyTo, batch.quoted, {
            promptId: newPromptId(),
            seedMessageId,
          }),
        );
        if (rt.sessionId) {
          controller.bindTelegramMessage(userMsgId, rt.sessionId);
          if (seedMessageId !== undefined) {
            controller.bindTelegramMessage(seedMessageId, rt.sessionId);
          }
        }
        // Never show "queued" spam for new parallel sessions; only if continuing
        // the same session that is already busy.
        if (outcome === "queued" && continueRt) {
          await send(
            deps,
            chatId,
            `\u{1F4E5} Got it — queued as a follow-up on that thread.`,
            threadId,
            replyTo,
          );
        }
      } catch (err) {
        log.warn(`general submit failed chat ${chatId}: ${(err as Error).message}`);
        if (seedMessageId !== undefined) {
          await editStatus(deps, chatId, seedMessageId, `\u274C Couldn't start: ${(err as Error).message}`);
        } else {
          await send(
            deps,
            chatId,
            `\u274C Couldn't start: ${(err as Error).message}`,
            threadId,
            replyTo,
          );
        }
      }
      return;
    }

    // ── Project / AI Chat topics (existing behavior) ─────────────────
    rt = resolved.rt;
    if (!rt.sessionId && !rt.isBusy) {
      try {
        await rt.startNewSession(rt.cwd, rt.projectName);
      } catch {
        /* ensureSession on submit will retry */
      }
    }
  }

  const note = batch.parts.length > 1 ? ` (combined ${batch.parts.length} messages)` : "";
  let replyTo: number | undefined = batch.ids[0];
  try {
    const anchor = await adoptUserPrompt(deps.api, {
      chatId,
      text: combined,
      userMessageIds: batch.ids,
      messageThreadId: threadId,
      projectName: rt.projectName,
      prefix: "\u{1F4DD} Prompt",
    });
    replyTo = anchor?.replyTo ?? batch.ids[0];
    const outcome = await rt.submit(
      textPrompt(combined, replyTo, batch.quoted, { promptId: anchor?.promptId }),
    );
    if (outcome === "queued") {
      await send(
        deps,
        chatId,
        `\u{1F4E5} Queued (position ${rt.queueLength})${note} \u2014 I'm still working on the previous task. It'll run next.`,
        threadId,
        replyTo,
      );
    }
  } catch (err) {
    log.warn(`submit failed for chat ${chatId}: ${(err as Error).message}`);
    await send(
      deps,
      chatId,
      `\u274C Couldn't start your message: ${(err as Error).message}`,
      threadId,
      replyTo,
    );
  }
}

async function send(
  deps: BotDeps,
  chatId: number,
  text: string,
  threadId?: number,
  replyTo?: number,
): Promise<void> {
  try {
    const extra: Record<string, unknown> = { ...outboundThreadExtra(threadId) };
    if (replyTo !== undefined) {
      extra.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    }
    await deps.api.sendMessage(chatId, text, extra);
  } catch {
    /* non-fatal */
  }
}

/** Post status bubble; returns message_id for later edit (Starting… → Thinking…). */
async function sendStatus(
  deps: BotDeps,
  chatId: number,
  text: string,
  threadId?: number,
  replyTo?: number,
): Promise<number | undefined> {
  try {
    const extra: Record<string, unknown> = {
      disable_notification: true,
      ...outboundThreadExtra(threadId),
    };
    if (replyTo !== undefined) {
      extra.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    }
    const msg = await deps.api.sendMessage(chatId, text, extra);
    return msg.message_id;
  } catch {
    return undefined;
  }
}

async function editStatus(
  deps: BotDeps,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await deps.api.editMessageText(chatId, messageId, text);
  } catch {
    /* non-fatal */
  }
}
