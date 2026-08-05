/**
 * Photo & image-document handler. Downloads images (including multi-image
 * albums / media groups) and submits them to Grok as ACP image content blocks
 * alongside the caption text.
 *
 * User media messages are replaced by a bot prompt anchor (`#prompt_<id>`);
 * the agent still receives the downloaded image bytes.
 */
import type { Bot, Context } from "grammy";
import type { PromptImage } from "../../app/types.js";
import { createLogger } from "../../logger.js";
import type { BotDeps } from "../deps.js";
import { type AdoptMediaItem, adoptUserPrompt } from "../prompt-anchor.js";
import { extractReplyContext } from "../reply-context.js";

const log = createLogger("photo");
const GROUP_DEBOUNCE_MS = 900;

interface GroupBuffer {
  chatId: number;
  caption: string;
  /** Agent-bound image bytes (may be shorter than media if a download failed). */
  images: PromptImage[];
  /** Chat re-post descriptors (file_id + correct photo vs document kind). */
  media: AdoptMediaItem[];
  /** User Telegram message ids in this album (for delete after anchor). */
  userMessageIds: number[];
  quoted?: string;
  threadId?: number;
  timer: NodeJS.Timeout;
}

export function registerPhotos(bot: Bot, deps: BotDeps): void {
  const groups = new Map<string, GroupBuffer>();

  const onMedia = async (
    ctx: Context,
    image: PromptImage | undefined,
    mediaItem: AdoptMediaItem | undefined,
    caption: string,
  ): Promise<void> => {
    // Still re-post to chat when download fails — user must not lose the file.
    if (!mediaItem?.fileId) return;
    const chatId = ctx.chat!.id;
    const msgId = ctx.message?.message_id;
    const threadId = ctx.message?.message_thread_id;
    const quoted = extractReplyContext(ctx);

    // Don't hijack the task wizard.
    if (deps.wizard.isActive(chatId)) {
      await ctx.reply("Finish or /cancel the current task wizard before sending images.");
      return;
    }

    const images = image ? [image] : [];
    const media = [mediaItem];

    const groupId = ctx.message?.media_group_id;
    if (!groupId) {
      await submit(
        deps,
        chatId,
        caption,
        images,
        media,
        msgId !== undefined ? [msgId] : [],
        quoted,
        threadId,
      );
      return;
    }

    // Buffer album items and submit once the group settles.
    const existing = groups.get(groupId);
    if (existing) {
      clearTimeout(existing.timer);
      if (image) existing.images.push(image);
      existing.media.push(mediaItem);
      if (caption) existing.caption = caption;
      if (quoted && !existing.quoted) existing.quoted = quoted;
      if (msgId !== undefined) existing.userMessageIds.push(msgId);
      existing.timer = setTimeout(() => flush(groups, groupId, deps), GROUP_DEBOUNCE_MS);
    } else {
      groups.set(groupId, {
        chatId,
        caption,
        images,
        media,
        userMessageIds: msgId !== undefined ? [msgId] : [],
        quoted,
        threadId,
        timer: setTimeout(() => flush(groups, groupId, deps), GROUP_DEBOUNCE_MS),
      });
    }
  };

  bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const fileId = largest?.file_id;
    const image = fileId
      ? await download(ctx, fileId, "image/jpeg", deps.cfg.token)
      : undefined;
    await onMedia(
      ctx,
      image,
      fileId ? { type: "photo", fileId } : undefined,
      ctx.message.caption ?? "",
    );
  });

  bot.on("message:document", async (ctx, next) => {
    const doc = ctx.message.document;
    if (!doc.mime_type?.startsWith("image/")) return next(); // let document-handler logic pass
    const image = await download(ctx, doc.file_id, doc.mime_type, deps.cfg.token);
    // Image-as-document must re-post as document — photo file_ids are a different kind.
    await onMedia(
      ctx,
      image,
      {
        type: "document",
        fileId: doc.file_id,
        fileName: doc.file_name ?? undefined,
      },
      ctx.message.caption ?? "",
    );
  });
}

async function flush(groups: Map<string, GroupBuffer>, groupId: string, deps: BotDeps): Promise<void> {
  const buf = groups.get(groupId);
  if (!buf) return;
  groups.delete(groupId);
  await submit(
    deps,
    buf.chatId,
    buf.caption,
    buf.images,
    buf.media,
    buf.userMessageIds,
    buf.quoted,
    buf.threadId,
  );
}

async function submit(
  deps: BotDeps,
  chatId: number,
  caption: string,
  images: PromptImage[],
  media: AdoptMediaItem[],
  userMessageIds: number[],
  quoted?: string,
  threadId?: number,
): Promise<void> {
  let rt = deps.registry.get(chatId);
  if (deps.forum?.isActiveForumChat(chatId) && threadId !== undefined) {
    const { forumThreadId } = await import("../../forum/thread.js");
    const tid = forumThreadId(threadId);
    const resolved = deps.forum.resolveCwd(tid);
    if (resolved) {
      rt = deps.registry.getForumTopic(chatId, tid, resolved.cwd, resolved.projectName);
    }
  }

  const n = Math.max(images.length, media.length);
  const label =
    n === 1
      ? "\u{1F4F7} Image"
      : `\u{1F4F7} ${n} images`;
  const body = caption.trim()
    ? caption
    : n === 1
      ? "(image attached)"
      : `(${n} images attached)`;

  const anchor = await adoptUserPrompt(deps.api, {
    chatId,
    text: body,
    userMessageIds,
    messageThreadId: threadId,
    projectName: rt.projectName,
    prefix: label,
    media,
  });

  // Agent gets whatever bytes we could download (may be empty if download failed).
  const outcome = await rt.submit({
    text: caption,
    images,
    replyTo: anchor?.replyTo ?? userMessageIds[0],
    promptId: anchor?.promptId,
    quotedText: quoted,
  });
  if (outcome === "queued") {
    const extra: Record<string, unknown> =
      threadId !== undefined ? { message_thread_id: threadId } : {};
    if (anchor?.replyTo !== undefined) {
      extra.reply_parameters = {
        message_id: anchor.replyTo,
        allow_sending_without_reply: true,
      };
    }
    await deps.api.sendMessage(
      chatId,
      `\u{1F4E5} Queued ${n} image${n > 1 ? "s" : ""} \u2014 will run after the current task.`,
      extra,
    );
  }
}

async function download(
  ctx: Context,
  fileId: string,
  mimeType: string,
  token: string,
): Promise<PromptImage | undefined> {
  try {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) return undefined;
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf.toString("base64"), mimeType };
  } catch (e) {
    log.warn("image download failed:", (e as Error).message);
    return undefined;
  }
}
