/**
 * ACP plan updates → compact, professional status lines for Telegram.
 *
 * Plan steps stay visible on the live stream (above the progress bar) so the
 * user always sees what's done / in progress / pending.
 */
import type { SessionUpdate } from "../grok/types.js";

export type PlanStatus = "pending" | "in_progress" | "completed" | "cancelled" | string;

export interface PlanEntry {
  content: string;
  status: PlanStatus;
  priority?: string;
}

const ICON: Record<string, string> = {
  completed: "\u2705", // ✅
  done: "\u2705",
  finished: "\u2705",
  in_progress: "\u25B6\uFE0F", // ▶️
  inprogress: "\u25B6\uFE0F",
  active: "\u25B6\uFE0F",
  running: "\u25B6\uFE0F",
  pending: "\u25CB", // ○
  todo: "\u25CB",
  cancelled: "\u2716", // ✖
  canceled: "\u2716",
  skipped: "\u2716",
};

/**
 * Parse a session/update plan payload into entries.
 * Supports common ACP shapes: entries[], plan[], or steps[].
 */
export function parsePlanUpdate(u: SessionUpdate): PlanEntry[] | undefined {
  const raw =
    (u as { entries?: unknown }).entries ??
    (u as { plan?: unknown }).plan ??
    (u as { steps?: unknown }).steps ??
    (u as { items?: unknown }).items;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const out: PlanEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const content = String(
      rec.content ?? rec.text ?? rec.title ?? rec.description ?? rec.step ?? "",
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!content) continue;
    const status = String(rec.status ?? rec.state ?? "pending")
      .toLowerCase()
      .trim()
      .replace(/[\s-]+/g, "_");
    const priority =
      typeof rec.priority === "string"
        ? rec.priority
        : typeof rec.priority === "number"
          ? String(rec.priority)
          : undefined;
    out.push({ content: content.slice(0, 200), status, priority });
  }
  return out.length ? out : undefined;
}

/**
 * Compact plan board for the live stream and status panel (always above the
 * progress bar). Plain text + emoji — safe for both MarkdownV2 and plain API.
 */
export function renderPlanMarkdown(entries: PlanEntry[]): string {
  if (!entries.length) return "";
  const done = entries.filter((e) => isDone(e.status)).length;
  const active = entries.filter((e) => isActive(e.status)).length;
  const total = entries.length;
  // Header: clipboard · done/total · optional "N active"
  const head =
    active > 0
      ? `\u{1F4CB} Plan \u00B7 ${done}/${total} \u00B7 ${active} active`
      : `\u{1F4CB} Plan \u00B7 ${done}/${total}`;
  const lines: string[] = [head];

  for (const e of entries) {
    const icon = ICON[e.status] ?? "\u25CB";
    // Minimalist: icon + step text (status is encoded in the icon)
    const suffix = statusSuffix(e.status);
    lines.push(`${icon}${suffix} ${e.content}`);
  }
  return lines.join("\n");
}

/** One-line summary for status panel / cards. */
export function renderPlanOneLine(entries: PlanEntry[]): string {
  if (!entries.length) return "";
  const current = entries.find((e) => isActive(e.status));
  const done = entries.filter((e) => isDone(e.status)).length;
  const total = entries.length;
  if (current) {
    return `\u{1F4CB} ${done}/${total} \u00B7 \u25B6\uFE0F ${truncate(current.content, 80)}`;
  }
  if (done === total) return `\u{1F4CB} ${done}/${total} complete`;
  const next = entries.find((e) => isPending(e.status));
  if (next) return `\u{1F4CB} ${done}/${total} \u00B7 next: ${truncate(next.content, 70)}`;
  return `\u{1F4CB} ${done}/${total}`;
}

function isDone(s: string): boolean {
  return s === "completed" || s === "done" || s === "finished";
}
function isActive(s: string): boolean {
  return s === "in_progress" || s === "inprogress" || s === "active" || s === "running";
}
function isPending(s: string): boolean {
  return s === "pending" || s === "todo" || s === "";
}

/** Optional short tag after the icon for cancelled/skipped only. */
function statusSuffix(s: string): string {
  if (s === "cancelled" || s === "canceled" || s === "skipped") return " skip";
  return "";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "\u2026";
}
