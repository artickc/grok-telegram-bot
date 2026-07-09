/**
 * Safe Telegram I/O: send/edit messages with MarkdownV2, automatically falling
 * back to plain text on parse errors and retrying on rate limits (429).
 */
import { type Api, GrammyError } from "grammy";
import { createLogger } from "../logger.js";
import { chunkMarkdown } from "../render/chunk.js";
import { toTelegramMarkdown } from "../render/markdown.js";

const log = createLogger("tg:io");
const MAX_RETRIES = 3;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 429) {
        const wait = (err.parameters?.retry_after ?? 1) * 1000 + 250;
        if (attempt++ < MAX_RETRIES) {
          log.debug(`429 rate limited, waiting ${wait}ms`);
          await sleep(wait);
          continue;
        }
      }
      throw err;
    }
  }
}

/** Send a message as MarkdownV2, falling back to plain text on parse errors. */
export async function safeSend(
  api: Api,
  chatId: number,
  markdownV2: string,
  plain: string,
  extra: Record<string, unknown> = {},
): Promise<number | undefined> {
  try {
    const msg = await withRetry(() =>
      api.sendMessage(chatId, markdownV2, { parse_mode: "MarkdownV2", ...extra }),
    );
    return msg.message_id;
  } catch (err) {
    if (isParseError(err)) {
      const msg = await withRetry(() => api.sendMessage(chatId, plain, extra));
      return msg.message_id;
    }
    log.warn("sendMessage failed:", (err as Error).message);
    return undefined;
  }
}

/** Edit a message as MarkdownV2, falling back to plain text on parse errors. */
export async function safeEdit(
  api: Api,
  chatId: number,
  messageId: number,
  markdownV2: string,
  plain: string,
): Promise<void> {
  try {
    await withRetry(() =>
      api.editMessageText(chatId, messageId, markdownV2, { parse_mode: "MarkdownV2" }),
    );
  } catch (err) {
    if (isNotModified(err)) return;
    if (isParseError(err)) {
      try {
        await withRetry(() => api.editMessageText(chatId, messageId, plain));
      } catch (e2) {
        if (!isNotModified(e2)) log.debug("plain edit failed:", (e2 as Error).message);
      }
      return;
    }
    log.debug("editMessageText failed:", (err as Error).message);
  }
}

function isParseError(err: unknown): boolean {
  return err instanceof GrammyError && /can't parse entities|parse entities/i.test(err.description);
}
function isNotModified(err: unknown): boolean {
  return err instanceof GrammyError && /message is not modified/i.test(err.description);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Convert a raw Markdown document to MarkdownV2, split it into Telegram-sized
 * chunks, and send each — with plain-text fallback per chunk.
 */
export async function sendMarkdownDoc(
  api: Api,
  chatId: number,
  rawMarkdown: string,
  opts?: { loud?: boolean },
): Promise<void> {
  const extra = opts?.loud ? { disable_notification: false } : {};
  const rendered = toTelegramMarkdown(rawMarkdown);
  const mdChunks = chunkMarkdown(rendered);
  const plainChunks = chunkMarkdown(rawMarkdown);
  for (let i = 0; i < mdChunks.length; i++) {
    await safeSend(api, chatId, mdChunks[i]!, plainChunks[i] ?? mdChunks[i]!, extra);
  }
}
