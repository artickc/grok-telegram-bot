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
 * While a turn is running, the combined message is queued and runs
 * automatically when the current turn finishes.
 * (Wizard input and menu-button text are intercepted by earlier handlers.)
 */
import type { Bot } from "grammy";
import { textPrompt } from "../../app/types.js";
import { createLogger } from "../../logger.js";
import { batchKey, forumThreadId } from "../../forum/thread.js";
import type { BotDeps } from "../deps.js";
import { extractReplyContext } from "../reply-context.js";
import { resolveForumRuntime } from "./forum.js";

const log = createLogger("message");

/** A pending burst of text messages from one chat/topic, awaiting coalescing. */
interface TextBatch {
  parts: string[];
  ids: number[];
  /** Forum topic thread id (undefined for private chats / General without id). */
  threadId?: number;
  /** Reference content if the burst began as a reply to another message. */
  quoted?: string;
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
    // (Otherwise /forum_setup and /help would also hit the debounce → agent path.)
    if (!text.includes("\n") && text.startsWith("/")) return;

    const chatId = ctx.chat.id;
    const id = ctx.message.message_id;
    const rawThreadId = ctx.message.message_thread_id;
    const isForum = Boolean(deps.cfg.topicGroupId && chatId === deps.cfg.topicGroupId);
    const threadId = isForum ? forumThreadId(rawThreadId) : rawThreadId;
    const quoted = extractReplyContext(ctx);
    const key = batchKey(chatId, rawThreadId, isForum);

    const batch = batches.get(key);
    if (batch) {
      clearTimeout(batch.timer);
      batch.parts.push(text);
      batch.ids.push(id);
      if (quoted && !batch.quoted) batch.quoted = quoted;
      batch.timer = arm(key);
      return;
    }
    batches.set(key, {
      parts: [text],
      ids: [id],
      threadId,
      quoted,
      timer: arm(key),
    });
  });
}

/** Coalesce a chat's buffered parts into one prompt and submit it once. */
async function flush(deps: BotDeps, batches: Map<string, TextBatch>, key: string): Promise<void> {
  const batch = batches.get(key);
  if (!batch) return;
  batches.delete(key);

  // Telegram splits at 4096 chars, almost always on a line boundary, so
  // rejoining with a newline reconstructs the original text faithfully.
  const combined = batch.parts.join("\n").trim();
  if (!combined) return;

  const [chatIdStr] = key.split(":");
  const chatId = Number(chatIdStr);
  const threadId = batch.threadId;

  // Defense-in-depth: never submit slash-only lines as agent prompts.
  if (batch.parts.length === 1 && !combined.includes("\n") && combined.startsWith("/")) {
    return;
  }

  let rt = deps.registry.get(chatId);
  // Forum group: topic-scoped multi-session controller (model/reasoning/running).
  if (deps.forum && deps.cfg.topicGroupId && chatId === deps.cfg.topicGroupId) {
    const resolved = await resolveForumRuntime(
      deps,
      deps.forum,
      chatId,
      threadId,
      combined,
      batch.ids[0]!,
    );
    if (resolved === "handled" || resolved === "ignore") return;
    rt = resolved.rt;
    // If nothing is selected / no session yet, ensure a new session is created
    // on first message (ensureSession inside submit). If FG has no sessionId
    // after a closed session, start a fresh one for this topic.
    if (!rt.sessionId && !rt.isBusy) {
      try {
        await rt.startNewSession(rt.cwd, rt.projectName);
      } catch {
        /* ensureSession on submit will retry */
      }
    }
  }

  const note = batch.parts.length > 1 ? ` (combined ${batch.parts.length} messages)` : "";
  try {
    // Thread the reply to the prompt message (the user's message is left intact;
    // the agent's response + Done reply to it, and carry searchable hashtags).
    const outcome = await rt.submit(textPrompt(combined, batch.ids[0], batch.quoted));
    if (outcome === "queued") {
      await send(
        deps,
        chatId,
        `\u{1F4E5} Queued (position ${rt.queueLength})${note} \u2014 I'm still working on the previous task. It'll run next.`,
        threadId,
      );
    }
    // "ran": turn started; complexity is steered silently by the agent.
  } catch (err) {
    log.warn(`submit failed for chat ${chatId}: ${(err as Error).message}`);
    await send(deps, chatId, `\u274C Couldn't start your message: ${(err as Error).message}`, threadId);
  }
}

async function send(
  deps: BotDeps,
  chatId: number,
  text: string,
  threadId?: number,
): Promise<void> {
  try {
    const extra: Record<string, unknown> = {};
    if (threadId !== undefined) extra.message_thread_id = threadId;
    await deps.api.sendMessage(chatId, text, extra);
  } catch {
    /* non-fatal */
  }
}
