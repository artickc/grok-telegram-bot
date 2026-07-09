/**
 * File-change summary for the turn-completion message. We classify each
 * tool-call update into a file operation (created / edited / deleted / moved)
 * and render a compact summary — independent of whether the turn streamed live,
 * so a background session's "Done" still reports what changed.
 */
import type { SessionUpdate, ToolCallContent } from "../grok/types.js";

export type FileOp = "created" | "edited" | "deleted" | "moved";

/** Tool kinds that never modify files. */
const NON_FILE = new Set(["read", "search", "fetch", "execute", "think", "other", ""]);

/** Merge priority — a stronger signal wins (deleted > moved > edited > created). */
const RANK: Record<FileOp, number> = { created: 1, edited: 2, moved: 3, deleted: 4 };

const SIGN: Record<FileOp, string> = { created: "+", edited: "~", deleted: "\u2212", moved: "\u2192" };
const ORDER: Record<FileOp, number> = { created: 0, edited: 1, deleted: 2, moved: 3 };

/** The file path + operation a tool-call update represents, or undefined. */
export function fileOpFromUpdate(u: SessionUpdate): { path: string; op: FileOp } | undefined {
  const kind = (u.kind || "").toLowerCase();
  if (NON_FILE.has(kind)) return undefined;

  const raw = (u.rawInput || {}) as Record<string, unknown>;
  const diff = findDiff(u);
  const path =
    str(diff?.path) || str(raw.path) || str(raw.file_path) || str(raw.filename) || pathFromTitle(u.title);
  if (!path) return undefined;

  if (kind === "delete") return { path, op: "deleted" };
  if (kind === "move" || kind === "rename") return { path, op: "moved" };

  // Edit-like: classify by whether the file had prior content.
  const oldText = diff && typeof diff.oldText === "string" ? diff.oldText : str(raw.old_str ?? raw.oldStr);
  const newText =
    diff && typeof diff.newText === "string"
      ? diff.newText
      : str(raw.new_str ?? raw.newStr ?? raw.file_text ?? raw.content ?? raw.text);
  const hasOld = oldText.trim().length > 0;
  const hasNew = newText.trim().length > 0;
  if (hasOld && !hasNew) return { path, op: "deleted" };
  if (!hasOld && hasNew) return { path, op: "created" };
  return { path, op: "edited" };
}

/** Combine a new op into an existing one for the same path (stronger wins). */
export function mergeFileOp(prev: FileOp | undefined, next: FileOp): FileOp {
  if (!prev) return next;
  return RANK[next] > RANK[prev] ? next : prev;
}

/**
 * Render the file-change summary appended to a turn's completion message.
 * Always returns a line — "No files modified" when nothing changed.
 */
export function summarizeFileOps(ops: Map<string, FileOp>, cwd: string, maxList = 15): string {
  if (ops.size === 0) return "\u{1F4C4} No files modified";

  const entries = [...ops.entries()].sort(
    (a, b) => ORDER[a[1]] - ORDER[b[1]] || a[0].localeCompare(b[0]),
  );
  const shown = entries.slice(0, maxList).map(([p, op]) => `${SIGN[op]} ${rel(cwd, p)}`);
  const more = entries.length > maxList ? `\n  \u2026and ${entries.length - maxList} more` : "";

  return `\u{1F4DD} ${countsLine(ops)}\n  ${shown.join("\n  ")}${more}`;
}

/** Compact, one-line counts (no file list) — used for "other session" pings. */
export function summarizeFileOpsShort(ops: Map<string, FileOp>): string {
  return ops.size === 0 ? "\u{1F4C4} No files modified" : `\u{1F4DD} ${countsLine(ops)}`;
}

/** "+2 created · ~3 edited · −1 deleted" — only the non-zero buckets. */
function countsLine(ops: Map<string, FileOp>): string {
  const counts: Record<FileOp, number> = { created: 0, edited: 0, deleted: 0, moved: 0 };
  for (const op of ops.values()) counts[op]++;
  const parts: string[] = [];
  if (counts.created) parts.push(`+${counts.created} created`);
  if (counts.edited) parts.push(`~${counts.edited} edited`);
  if (counts.deleted) parts.push(`\u2212${counts.deleted} deleted`);
  if (counts.moved) parts.push(`\u2192${counts.moved} moved`);
  return parts.join(" \u00B7 ");
}

function findDiff(u: SessionUpdate): ToolCallContent | undefined {
  const blocks: ToolCallContent[] = [];
  if (Array.isArray(u.content_blocks)) blocks.push(...u.content_blocks);
  const content = (u as unknown as { content?: unknown }).content;
  if (Array.isArray(content)) blocks.push(...(content as ToolCallContent[]));
  return blocks.find((b) => b.type === "diff");
}

function pathFromTitle(title?: string): string {
  if (!title) return "";
  // Titles look like "Edit src/foo.ts" / "Create /abs/path" — take the last token.
  const m = title.trim().match(/(\S+)\s*$/);
  const tok = m?.[1] ?? "";
  return /[\\/.]/.test(tok) ? tok : "";
}

/** Display a path relative to the session's cwd when it lives under it. */
function rel(cwd: string, p: string): string {
  const np = p.replace(/\\/g, "/");
  const c = cwd.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  return np.startsWith(c) ? np.slice(c.length) : np;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
