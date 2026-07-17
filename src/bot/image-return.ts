/**
 * Agent image return — finds image files the agent produced this turn
 * (Imagine `image_gen` / `image_edit`, screenshots, diagrams…) and sends them
 * back to Telegram as **downloadable files** (`sendDocument`).
 *
 * Discovery sources:
 *   1. Paths mentioned in agent text / tool inputs (project-relative or absolute)
 *   2. Fresh files under the Grok session media dirs
 *      (`~/.grok/sessions/<encoded-cwd>/<sessionId>/images/` and `…/assets/`)
 *   3. Fresh files under `<cwd>/images/` (common short path reported by tools)
 */
import { type Api, InputFile } from "grammy";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { createLogger } from "../logger.js";

// Re-export so existing import paths (`./image-return.js`) keep working.
export { IMAGE_OUTPUT_DIRECTIVE } from "../render/image-output.js";

const log = createLogger("image-return");

/** Absolute / relative image path tokens in free text (Unix + Windows). */
const PATH_RE =
  /(?:[A-Za-z]:[\\/]|\/|~[\\/]|\.{1,2}[\\/])?[^\s"'`<>|()*\[\]{}]+\.(?:png|jpe?g|gif|webp|bmp)/gi;
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const MAX_FILE_BYTES = 45 * 1024 * 1024;

/** Pull candidate image paths out of arbitrary text, resolved against cwd. */
export function extractImagePaths(text: string, cwd: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) {
    let raw = m[0].replace(/[).,;:]+$/, "");
    if (raw.startsWith("~/") || raw.startsWith("~\\")) {
      raw = join(homedir(), raw.slice(2));
    }
    out.add(isAbsolute(raw) ? raw : join(cwd, raw));
  }
  return [...out];
}

/**
 * Grok stores per-session media under:
 *   ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/{images,assets}/
 * Imagine `image_gen` currently prefers `images/`; older runs used `assets/`.
 */
export function grokSessionMediaRoot(cwd: string, sessionId: string): string {
  return join(homedir(), ".grok", "sessions", encodeURIComponent(cwd), sessionId);
}

/** @deprecated Prefer grokSessionMediaDirs — kept for callers/tests that used assets. */
export function grokSessionAssetsDir(cwd: string, sessionId: string): string {
  return join(grokSessionMediaRoot(cwd, sessionId), "assets");
}

/** Session folders where Imagine / tools drop generated images. */
export function grokSessionMediaDirs(cwd: string, sessionId: string): string[] {
  const root = grokSessionMediaRoot(cwd, sessionId);
  return [join(root, "images"), join(root, "assets")];
}

/** List image files under `dir` modified at/after `since` (non-recursive). */
export function listFreshImagesInDir(dir: string, since: number): string[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const ext = name.toLowerCase().split(".").pop() ?? "";
    if (!IMAGE_EXT.has(ext)) continue;
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) continue;
      // 2s slack for clock skew / write completion.
      if (st.mtimeMs < since - 2000) continue;
      out.push(path);
    } catch {
      /* skip */
    }
  }
  // Newest first so max-cap still keeps the latest gens.
  return out.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
}

/** Collect all image candidates for a turn from text + known asset locations. */
export function collectTurnImagePaths(opts: {
  scanText: string;
  cwd: string;
  sessionId?: string;
  since: number;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (paths: string[]) => {
    for (const p of paths) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  };

  add(extractImagePaths(opts.scanText, opts.cwd));
  add(listFreshImagesInDir(join(opts.cwd, "images"), opts.since));
  if (opts.sessionId) {
    for (const dir of grokSessionMediaDirs(opts.cwd, opts.sessionId)) {
      add(listFreshImagesInDir(dir, opts.since));
    }
  }
  return out;
}

export interface SendImagesOptions {
  /** Only send files modified at/after this epoch ms (fresh this turn). */
  since: number;
  /** Paths already sent (mutated to dedupe). */
  already: Set<string>;
  /** Max images to send in this call. */
  max: number;
  /** Optional Telegram message id to thread replies under. */
  replyTo?: number;
}

/** Send the valid, fresh, not-yet-sent images as documents. Returns how many were sent. */
export async function sendImages(
  api: Api,
  chatId: number,
  paths: string[],
  opts: SendImagesOptions,
): Promise<number> {
  let sent = 0;
  const replyExtra =
    opts.replyTo !== undefined
      ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } }
      : {};
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
      // Always send as a document so Telegram delivers a downloadable file
      // (not a compressed photo bubble).
      const file = new InputFile(path, basename(path));
      await api.sendDocument(chatId, file, {
        caption: basename(path),
        ...replyExtra,
      });
      sent++;
      log.debug(`sent document ${path}`);
    } catch (e) {
      log.debug(`failed to send ${path}:`, (e as Error).message);
    }
  }
  return sent;
}
