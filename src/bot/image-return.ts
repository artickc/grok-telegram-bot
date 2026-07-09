/**
 * Agent image return — detects image files the agent produced this turn
 * (screenshots, diagrams…) from its output and tool inputs, and sends them
 * back to Telegram. Only fresh files (modified during the turn) are sent.
 */
import { type Api, InputFile } from "grammy";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("image-return");

const PATH_RE = /[^\s"'`<>|()*\[\]]+\.(?:png|jpe?g|gif|webp|bmp)/gi;
const PHOTO_EXT = new Set(["png", "jpg", "jpeg", "webp"]);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 45 * 1024 * 1024;

/** Pull candidate image paths out of arbitrary text, resolved against cwd. */
export function extractImagePaths(text: string, cwd: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) {
    const raw = m[0].replace(/[).,;:]+$/, "");
    out.add(isAbsolute(raw) ? raw : join(cwd, raw));
  }
  return [...out];
}

export interface SendImagesOptions {
  /** Only send files modified at/after this epoch ms (fresh this turn). */
  since: number;
  /** Paths already sent (mutated to dedupe). */
  already: Set<string>;
  /** Max images to send in this call. */
  max: number;
}

/** Send the valid, fresh, not-yet-sent images. Returns how many were sent. */
export async function sendImages(
  api: Api,
  chatId: number,
  paths: string[],
  opts: SendImagesOptions,
): Promise<number> {
  let sent = 0;
  for (const path of paths) {
    if (sent >= opts.max) break;
    if (opts.already.has(path)) continue;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) continue;
    if (st.mtimeMs < opts.since - 2000) continue; // skip pre-existing files
    opts.already.add(path);
    try {
      const ext = path.toLowerCase().split(".").pop() ?? "";
      const asPhoto = PHOTO_EXT.has(ext) && st.size <= MAX_PHOTO_BYTES;
      const file = new InputFile(path);
      if (asPhoto) await api.sendPhoto(chatId, file, { caption: basename(path) });
      else await api.sendDocument(chatId, file, { caption: basename(path) });
      sent++;
    } catch (e) {
      log.debug(`failed to send ${path}:`, (e as Error).message);
    }
  }
  return sent;
}
