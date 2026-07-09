/**
 * Searchable Telegram hashtags for a session's messages. Tapping a tag in
 * Telegram pulls up every message that carries it, so the SAME footer is
 * appended to every AI-output surface: live streams, Done/error summaries, the
 * history/unread you see when switching back to a session, and live watch.
 */
import { basename } from "node:path";

export interface TagInput {
  projectName?: string;
  cwd?: string;
  sessionId?: string;
}

/** Sanitise a value into a Telegram-safe hashtag body (letters/digits/_ only). */
export function tagSafe(v: string): string {
  const s = v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return s || "none";
}

/**
 * Build the hashtag footer. `#proj_` is always present; `#sess_` is added only
 * when the session id is known, so partial callers (e.g. a static /history view)
 * still tag consistently. Order: project · session.
 */
export function sessionHashtags(input: TagInput): string {
  const tags = [`#proj_${tagSafe(input.projectName || basename(input.cwd || "") || "none")}`];
  if (input.sessionId) tags.push(`#sess_${tagSafe(input.sessionId.slice(0, 8))}`);
  return tags.join(" ");
}
