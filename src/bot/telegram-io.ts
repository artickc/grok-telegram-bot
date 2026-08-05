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

const TRANSIENT_NET =
  /econnreset|econnrefused|etimedout|eai_again|socket hang ?up|fetch failed|network|temporarily unavailable/i;

export type TelegramRetryOptions = {
  /** Max attempts after the first try for 429 (default 3). */
  maxRateLimitRetries?: number;
  /** Max attempts after the first try for transient network errors (default 0 = off). */
  maxNetworkRetries?: number;
  /** Logger label for debug lines. */
  label?: string;
};

/**
 * Retry a Telegram API call on 429 (respect `retry_after`) and optionally on
 * transient network failures. Used by safe send/edit and by long forum setup.
 */
export async function withTelegramRetry<T>(
  fn: () => Promise<T>,
  opts: TelegramRetryOptions = {},
): Promise<T> {
  const max429 = opts.maxRateLimitRetries ?? MAX_RETRIES;
  const maxNet = opts.maxNetworkRetries ?? 0;
  const label = opts.label ?? "tg";
  let rateAttempts = 0;
  let netAttempts = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 429) {
        const wait = (err.parameters?.retry_after ?? 1) * 1000 + 250;
        if (rateAttempts++ < max429) {
          log.debug(`${label}: 429 rate limited, waiting ${wait}ms (try ${rateAttempts}/${max429})`);
          await sleep(wait);
          continue;
        }
      } else if (maxNet > 0 && isTransientNetworkError(err) && netAttempts++ < maxNet) {
        const wait = Math.min(30_000, 1000 * 2 ** (netAttempts - 1));
        log.debug(`${label}: transient network error, retry in ${wait}ms (try ${netAttempts}/${maxNet})`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = String((err as Error).message ?? err);
  const code = String((err as { code?: string }).code ?? "");
  return TRANSIENT_NET.test(msg) || TRANSIENT_NET.test(code);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  return withTelegramRetry(fn, { maxRateLimitRetries: MAX_RETRIES });
}

/** Send a message as MarkdownV2, falling back to demoted plain text on parse errors. */
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
      // Do not send raw markdown — Telegram clients soft-render ** and ``` in
      // plain messages and Windows paths look broken (e.g. **Edit C:** wrap).
      const demoted = demoteMarkdownForPlain(plain);
      const msg = await withRetry(() => api.sendMessage(chatId, demoted, extra));
      return msg.message_id;
    }
    log.warn("sendMessage failed:", (err as Error).message);
    return undefined;
  }
}

/** Edit a message as MarkdownV2, falling back to demoted plain text on parse errors. */
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
        await withRetry(() => api.editMessageText(chatId, messageId, demoteMarkdownForPlain(plain)));
      } catch (e2) {
        if (!isNotModified(e2)) log.debug("plain edit failed:", (e2 as Error).message);
      }
      return;
    }
    log.debug("editMessageText failed:", (err as Error).message);
  }
}

/**
 * When MarkdownV2 parse fails, send readable plain text without `**` / fences
 * that clients soft-render into broken bold around Windows paths.
 */
export function demoteMarkdownForPlain(src: string): string {
  if (!src) return src;
  let s = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Fenced blocks → indented plain body (drop language tag). Same tick count open/close.
  s = s.replace(/^[ \t]*(`{3,})([^\n]*)\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm, (_m, _ticks, _lang, body: string) => {
    const lines = String(body).replace(/\n$/, "").split("\n");
    return lines.map((l) => (l ? "  " + l : "")).join("\n");
  });
  // Unclosed trailing fence only at end of message (streaming mid-fence).
  s = s.replace(/^[ \t]*`{3,}[^\n]*\n([\s\S]*)$/m, (full, body: string, offset: number) => {
    // Only treat as unclosed if this match reaches the true end of the string.
    if (offset + full.length < s.length) return full;
    return String(body)
      .split("\n")
      .map((l) => (l ? "  " + l : ""))
      .join("\n");
  });
  // Inline code → keep content.
  s = s.replace(/`([^`\n]+)`/g, "$1");
  // Bold / italic / strike markers (repeat until stable for adjacent spans).
  for (let i = 0; i < 3; i++) {
    const next = s
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1");
    if (next === s) break;
    s = next;
  }
  // Leftover emphasis markers (including broken **Edit C:** style).
  s = s.replace(/\*\*/g, "");
  s = s.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "$1");
  s = s.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1");
  // Collapse leftover fence ticks.
  s = s.replace(/`{3,}/g, "");
  return s.replace(/\n{4,}/g, "\n\n\n").trimEnd();
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
  opts?: { loud?: boolean; messageThreadId?: number },
): Promise<void> {
  const extra: Record<string, unknown> = opts?.loud ? { disable_notification: false } : {};
  if (opts?.messageThreadId !== undefined) extra.message_thread_id = opts.messageThreadId;
  const rendered = toTelegramMarkdown(rawMarkdown);
  const mdChunks = chunkMarkdown(rendered);
  const plainChunks = chunkMarkdown(rawMarkdown);
  for (let i = 0; i < mdChunks.length; i++) {
    await safeSend(api, chatId, mdChunks[i]!, plainChunks[i] ?? mdChunks[i]!, extra);
  }
}
