/**
 * Prompt anchors & command acks — instant bot feedback while the CLI/ACP warms up.
 *
 * When the user sends a prompt we:
 *   1. post a bot-owned message with the prompt text + `#prompt_<id>`
 *      (and re-attach any photos/files/voice so media is not lost when the
 *      user's original is deleted)
 *   2. best-effort delete the user's original message(s)
 *   3. thread every AI reply (and Done/error) to that bot message
 *
 * Commands use {@link ackCommand}: delete the slash message immediately and
 * post a short status so the chat never looks dead during slow handlers.
 */
import type { Api, Context } from "grammy";
import { InputMediaBuilder } from "grammy";
import { createLogger } from "../logger.js";
import { tagSafe } from "../render/hashtags.js";
import { outboundThreadExtra } from "../forum/thread.js";

const log = createLogger("prompt-anchor");

/** Telegram hard cap for text messages; leave room for prefix + tags. */
const BODY_BUDGET = 3500;
/** Telegram caption hard cap on photo/document/audio/video. */
const CAPTION_BUDGET = 1024;

export type AdoptMediaItem =
  | { type: "photo"; fileId: string }
  | { type: "document"; fileId: string; fileName?: string }
  | { type: "voice"; fileId: string }
  | { type: "audio"; fileId: string; fileName?: string }
  | { type: "video"; fileId: string }
  | { type: "video_note"; fileId: string };

export interface AdoptPromptOpts {
  chatId: number;
  /** User prompt body to echo on the anchor (not sent to the agent twice — agent gets original text). */
  text: string;
  /** User Telegram message ids to delete after the anchor is posted. */
  userMessageIds: number[];
  messageThreadId?: number;
  projectName?: string;
  /** Leading emoji/label, e.g. "📝", "📷", "🎤". */
  prefix?: string;
  /**
   * Media from the user's message(s), re-posted via Telegram file_id so the
   * chat keeps images/files after the original is deleted. Same bot may reuse
   * file_ids it received.
   */
  media?: AdoptMediaItem[];
}

export interface PromptAnchor {
  /** Bot message id — use as PromptInput.replyTo. */
  replyTo: number;
  /** Short id for `#prompt_<id>` footers. */
  promptId: string;
}

/** Short unique id safe for Telegram hashtag bodies. */
export function newPromptId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return tagSafe(`${t}${r}`);
}

export function formatPromptTag(promptId: string): string {
  return `#prompt_${tagSafe(promptId)}`;
}

/** Build tag footer for prompt anchors (hashtags stay tappable). */
export function formatPromptAnchorTags(
  promptId: string,
  opts?: { projectName?: string },
): string {
  const tags = [formatPromptTag(promptId)];
  if (opts?.projectName?.trim()) {
    tags.push(`#proj_${tagSafe(opts.projectName)}`);
  }
  return tags.join(" ");
}

/**
 * Split a long user prompt into Telegram-safe parts (no middle crop).
 * Part 1 carries the prefix; every part ends with the same #prompt_ tags.
 */
export function splitPromptAnchorParts(
  text: string,
  promptId: string,
  opts?: { prefix?: string; projectName?: string },
): string[] {
  const prefix = (opts?.prefix ?? "\u{1F4DD}").trim();
  const tags = formatPromptAnchorTags(promptId, opts);
  const raw = text.trim() || "(empty)";
  const footer = `\n\n${tags}`;
  // Conservative body so headers + tags never push over Telegram's 4096.
  const partBudget = Math.max(800, BODY_BUDGET - footer.length - 80);
  if (prefix.length + 1 + raw.length + footer.length <= BODY_BUDGET + 200) {
    return [`${prefix}\n${raw}${footer}`];
  }
  const chunks: string[] = [];
  for (let i = 0; i < raw.length; i += partBudget) {
    chunks.push(raw.slice(i, i + partBudget));
  }
  const total = chunks.length;
  return chunks.map((chunk, i) => {
    const head =
      i === 0
        ? `${prefix} (part 1/${total})\n`
        : `\u{1F4DD} (part ${i + 1}/${total})\n`;
    return `${head}${chunk}${footer}`;
  });
}

/** Build the plain-text body of a prompt-anchor message (hashtags stay tappable). */
export function formatPromptAnchorBody(
  text: string,
  promptId: string,
  opts?: { prefix?: string; projectName?: string },
): string {
  // Prefer full text via multi-part; this helper returns part 1 only for callers
  // that still expect a single string (caption fitting uses split separately).
  return splitPromptAnchorParts(text, promptId, opts)[0]!;
}

/**
 * Fit anchor body into a media caption (1024). Prefer keeping the trailing
 * hashtag line so `#prompt_` stays searchable — never slice tags off the end.
 */
export function fitCaption(body: string, max = CAPTION_BUDGET): string {
  if (body.length <= max) return body;
  const lines = body.split("\n");
  const last = (lines[lines.length - 1] ?? "").trim();
  const tags = last.includes("#prompt_") ? last : "";
  if (tags) {
    // Reserve room for "\n…\n\n" + tags; never clip the tag line.
    const sep = "\n\u2026\n\n";
    const budget = max - tags.length - sep.length;
    if (budget > 40) {
      const cutAt = body.lastIndexOf(tags);
      const rawHead = (cutAt > 0 ? body.slice(0, cutAt) : body).replace(/\s+$/, "");
      const head = rawHead.length > budget ? rawHead.slice(0, budget) : rawHead;
      return `${head}${sep}${tags}`;
    }
    // Tags alone almost fill the caption — keep tags only.
    return tags.length <= max ? tags : tags.slice(0, max - 1) + "\u2026";
  }
  return body.slice(0, max - 1) + "\u2026";
}

/**
 * Post a bot-owned prompt message (with media when provided), delete the user's
 * original(s), return ids for threading + tagging. On send failure returns
 * undefined (caller falls back).
 */
export async function adoptUserPrompt(
  api: Api,
  opts: AdoptPromptOpts,
): Promise<PromptAnchor | undefined> {
  const promptId = newPromptId();
  const parts = splitPromptAnchorParts(opts.text, promptId, {
    prefix: opts.prefix,
    projectName: opts.projectName,
  });
  const body = parts[0]!;
  const threadExtra: Record<string, unknown> = {
    disable_notification: true,
    ...outboundThreadExtra(opts.messageThreadId),
  };

  let replyTo: number;
  try {
    const media = (opts.media ?? []).filter((m) => !!m.fileId);
    if (media.length > 0) {
      // Media caption may be short; send full multi-part text as follow-ups.
      replyTo = await sendAnchorWithMedia(api, opts.chatId, media, body, threadExtra, parts);
    } else {
      const msg = await api.sendMessage(opts.chatId, body, threadExtra);
      replyTo = msg.message_id;
      for (let i = 1; i < parts.length; i++) {
        await api
          .sendMessage(opts.chatId, parts[i]!, {
            ...threadExtra,
            reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
          })
          .catch((e) => log.debug(`anchor part ${i + 1} failed: ${(e as Error).message}`));
      }
    }
  } catch (err) {
    log.warn(`anchor send failed chat=${opts.chatId}: ${(err as Error).message}`);
    // Fallback: text-only anchor so threading still works if media re-post fails.
    try {
      const msg = await api.sendMessage(opts.chatId, body, threadExtra);
      replyTo = msg.message_id;
      for (let i = 1; i < parts.length; i++) {
        await api
          .sendMessage(opts.chatId, parts[i]!, {
            ...threadExtra,
            reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
          })
          .catch(() => {});
      }
    } catch (err2) {
      log.warn(`anchor text fallback failed chat=${opts.chatId}: ${(err2 as Error).message}`);
      return undefined;
    }
  }

  await deleteUserMessages(api, opts.chatId, opts.userMessageIds);
  return { replyTo, promptId };
}

/** Re-post user media with caption/tags so files remain in chat history. */
async function sendAnchorWithMedia(
  api: Api,
  chatId: number,
  media: AdoptMediaItem[],
  body: string,
  threadExtra: Record<string, unknown>,
  allParts?: string[],
): Promise<number> {
  const caption = fitCaption(body);
  const parts = allParts && allParts.length > 0 ? allParts : [body];
  const needsFollowUp = parts.length > 1 || body.length > CAPTION_BUDGET;

  // Photo album: one media group (caption on first only).
  if (media.length > 1 && media.every((m) => m.type === "photo")) {
    const group = media.map((m, i) =>
      i === 0
        ? InputMediaBuilder.photo(m.fileId, { caption })
        : InputMediaBuilder.photo(m.fileId),
    );
    const msgs = await api.sendMediaGroup(chatId, group, threadExtra);
    const firstId = msgs[0]?.message_id;
    if (firstId === undefined) throw new Error("sendMediaGroup returned no messages");
    if (needsFollowUp) {
      for (const part of parts) {
        await api
          .sendMessage(chatId, part, {
            ...threadExtra,
            reply_parameters: { message_id: firstId, allow_sending_without_reply: true },
          })
          .catch(() => {});
      }
    }
    return firstId;
  }

  // Single (or primary) media item; extra photos sent as a follow-up group.
  const primary = media[0]!;
  const restPhotos = media.slice(1).filter((m): m is Extract<AdoptMediaItem, { type: "photo" }> => m.type === "photo");

  let replyTo: number;
  const capOpts = { caption, ...threadExtra };

  switch (primary.type) {
    case "photo": {
      const msg = await api.sendPhoto(chatId, primary.fileId, capOpts);
      replyTo = msg.message_id;
      break;
    }
    case "document": {
      const msg = await api.sendDocument(chatId, primary.fileId, capOpts);
      replyTo = msg.message_id;
      break;
    }
    case "voice": {
      const msg = await api.sendVoice(chatId, primary.fileId, capOpts);
      replyTo = msg.message_id;
      break;
    }
    case "audio": {
      const msg = await api.sendAudio(chatId, primary.fileId, capOpts);
      replyTo = msg.message_id;
      break;
    }
    case "video": {
      const msg = await api.sendVideo(chatId, primary.fileId, capOpts);
      replyTo = msg.message_id;
      break;
    }
    case "video_note": {
      // video_note has no caption — post note then text anchor as reply.
      const msg = await api.sendVideoNote(chatId, primary.fileId, threadExtra);
      replyTo = msg.message_id;
      await api
        .sendMessage(chatId, body, {
          ...threadExtra,
          reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
        })
        .catch(() => {});
      return replyTo;
    }
    default: {
      const msg = await api.sendMessage(chatId, body, threadExtra);
      return msg.message_id;
    }
  }

  if (restPhotos.length > 0) {
    const group = restPhotos.map((m) => InputMediaBuilder.photo(m.fileId));
    await api.sendMediaGroup(chatId, group, threadExtra).catch((e) => {
      log.debug(`extra photo group failed: ${(e as Error).message}`);
    });
  }

  if (needsFollowUp) {
    for (const part of parts) {
      await api
        .sendMessage(chatId, part, {
          ...threadExtra,
          reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
        })
        .catch(() => {});
    }
  }

  return replyTo;
}

/** Best-effort delete of user messages (private chats may refuse). */
export async function deleteUserMessages(
  api: Api,
  chatId: number,
  messageIds: number[],
): Promise<void> {
  const unique = [...new Set(messageIds.filter((id) => Number.isFinite(id) && id > 0))];
  await Promise.all(
    unique.map(async (id) => {
      try {
        await api.deleteMessage(chatId, id);
      } catch {
        /* no rights / already gone / too old — non-fatal */
      }
    }),
  );
}

/**
 * Instant command feedback: delete the user's command and post a bot status.
 * Fire-and-forget delete so slow work never waits on Telegram cleanup.
 */
export async function ackCommand(
  ctx: Context,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<number | undefined> {
  void ctx.deleteMessage().catch(() => {});
  try {
    const msg = await ctx.reply(text, extra);
    return msg.message_id;
  } catch (err) {
    log.debug(`ackCommand reply failed: ${(err as Error).message}`);
    return undefined;
  }
}

/** @deprecated Prefer {@link splitPromptAnchorParts} — kept for tests. */
export function truncateBody(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head - 5;
  return `${text.slice(0, head)}\n\u2026\n${text.slice(-tail)}`;
}
