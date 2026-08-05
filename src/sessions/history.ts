/**
 * History parser — turns a session's .jsonl event log into readable entries.
 * Reads only the tail of large logs to stay fast.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { IMAGE_OUTPUT_DIRECTIVE } from "../render/image-output.js";
import { extractProgress, PROGRESS_DIRECTIVE } from "../render/progress.js";
import {
  extractTelegramActions,
  TELEGRAM_BRIDGE_MARKER,
  TELEGRAM_BRIDGE_RESULTS_MARKER,
} from "../render/telegram-bridge.js";
import type { HistoryEntry, HistoryRole } from "./types.js";

const TAIL_WINDOWS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024]; // grow until entries found

interface RawEvent {
  kind?: string;
  data?: {
    content?: Array<{ kind?: string; data?: unknown; text?: unknown }>;
    meta?: { timestamp?: number };
    name?: string;
    tool_name?: string;
  };
}

/** Parse the most recent `maxEntries` history entries from a session log. */
export function readHistory(jsonlPath: string, maxEntries = 20): HistoryEntry[] {
  for (const window of TAIL_WINDOWS) {
    const entries = parseTail(jsonlPath, window, maxEntries);
    if (entries.length > 0) return entries;
  }
  return [];
}

/** Current byte size of a session log (0 if missing). */
export function jsonlSize(jsonlPath: string): number {
  try {
    return statSync(jsonlPath).size;
  } catch {
    return 0;
  }
}

/** Last-write time of a session log in epoch ms (0 if missing). */
export function jsonlMtimeMs(jsonlPath: string): number {
  try {
    return statSync(jsonlPath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Best-effort card blurb from the tail of a session log: last assistant prose
 * (what was solved), else last user prompt. Skips import-confirm noise.
 * @deprecated Prefer {@link readLastUserPrompt} for session card comments.
 */
export function readLastCardSummary(jsonlPath: string, maxEntries = 30): string {
  const entries = readHistory(jsonlPath, maxEntries);
  if (entries.length === 0) return "";
  // Walk newest → oldest for a useful assistant conclusion.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.role === "assistant" && e.text.trim()) {
      const t = cleanCardProse(e.text);
      if (t.length >= 20) return t;
    }
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.role === "user" && e.text.trim()) {
      const t = cleanCardProse(e.text);
      if (t && !/session import complete/i.test(t)) return t;
    }
  }
  return "";
}

/**
 * Last user prompt from the session log for card comments (newest → oldest).
 * Strips complexity wrappers / import-confirm noise. Empty when none found.
 */
export function readLastUserPrompt(jsonlPath: string, maxEntries = 40, maxLen = 250): string {
  const entries = readHistory(jsonlPath, maxEntries);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.role !== "user" || !e.text.trim()) continue;
    const t = cleanCardProse(e.text, maxLen);
    if (!t) continue;
    if (/session import complete/i.test(t)) continue;
    return t;
  }
  return "";
}

function cleanCardProse(raw: string, max = 250): string {
  let t = extractProgress(raw).cleaned;
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/^COMPLEXITY \(decide yourself[\s\S]*?User task:\s*/i, "");
  t = t.replace(/^TASK COMPLEXITY:[\s\S]*?User task:\s*/i, "");
  if (/^Session status update \(meta only\)/i.test(t.trim())) return "";
  t = t.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  // Prefer the ending (conclusions).
  if (t.length > max + 40) {
    const tail = t.slice(-max + 1);
    const sp = tail.indexOf(" ");
    return "\u2026" + (sp > 0 && sp < 30 ? tail.slice(sp + 1) : tail);
  }
  return t.slice(0, max - 1) + "\u2026";
}

/** The first user prompt in a session log (read from the start), or "". */
export function readFirstPrompt(jsonlPath: string, maxBytes = 256 * 1024): string {
  let size: number;
  try {
    size = statSync(jsonlPath).size;
  } catch {
    return "";
  }
  if (size === 0) return "";
  const length = Math.min(size, maxBytes);
  const fd = openSync(jsonlPath, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, 0);
    for (const line of buf.toString("utf-8").split("\n")) {
      const e = parseEventLine(line);
      if (e && e.role === "user" && e.text.trim()) return e.text;
    }
    return "";
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the entries appended after `fromByte` (the "unread" since last seen).
 * Returns the parsed entries and the new end-of-file byte offset. Grok appends
 * whole newline-terminated JSON objects, so `fromByte` is always a line boundary.
 */
export function readEntriesFrom(jsonlPath: string, fromByte: number): { entries: HistoryEntry[]; size: number } {
  const size = jsonlSize(jsonlPath);
  if (size <= fromByte || size === 0) return { entries: [], size };
  const length = size - fromByte;
  const fd = openSync(jsonlPath, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, fromByte);
    const lines = buf.toString("utf-8").split("\n").filter((l) => l.trim().length > 0);
    const entries: HistoryEntry[] = [];
    for (const line of lines) {
      const e = parseEventLine(line);
      if (e) entries.push(e);
    }
    return { entries, size };
  } finally {
    closeSync(fd);
  }
}

function parseTail(jsonlPath: string, window: number, maxEntries: number): HistoryEntry[] {
  const text = readTail(jsonlPath, window);
  if (!text) return [];

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const entries: HistoryEntry[] = [];

  for (const line of lines) {
    const entry = parseEventLine(line);
    if (entry) entries.push(entry);
  }

  return entries.slice(-maxEntries);
}

/** Parse a single .jsonl event line into a history entry (or undefined). */
export function parseEventLine(line: string): HistoryEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let ev: RawEvent;
  try {
    ev = JSON.parse(trimmed) as RawEvent;
  } catch {
    return undefined;
  }
  return toEntry(ev);
}

/** Build a compact plain-text transcript from history entries (for priming). */
export function buildTranscript(entries: HistoryEntry[], perEntryMax = 600): string {
  const label: Record<string, string> = {
    user: "User",
    assistant: "Assistant",
    tool: "Tool",
    system: "System",
  };
  return entries
    .map((e) => {
      const text = e.text.length > perEntryMax ? e.text.slice(0, perEntryMax) + " …" : e.text;
      return `${label[e.role] ?? e.role}: ${text}`;
    })
    .join("\n");
}

function toEntry(ev: RawEvent): HistoryEntry | undefined {
  const role = roleOf(ev.kind);
  if (!role) return undefined;

  const text = cleanStoredText(extractText(ev.data?.content));
  const tool = ev.data?.tool_name || ev.data?.name;
  if (!text && !tool) return undefined;

  return {
    role,
    text: text || (tool ? `(${tool})` : ""),
    tool,
    timestamp: ev.data?.meta?.timestamp,
  };
}

/** Strip the `{progress: N%}` markers (any role) and the appended progress
 *  directive (user prompts) from persisted text so history / unread / previews
 *  / fork-priming never surface the raw plumbing. */
function cleanStoredText(text: string): string {
  if (!text) return text;
  let t = extractProgress(text).cleaned;
  t = extractTelegramActions(t).cleaned;
  if (t.includes(PROGRESS_DIRECTIVE)) t = t.split(PROGRESS_DIRECTIVE).join("").trim();
  if (t.includes(IMAGE_OUTPUT_DIRECTIVE)) t = t.split(IMAGE_OUTPUT_DIRECTIVE).join("").trim();
  // Prefer "User task (continued):" BEFORE plain "User task:" — the continued
  // marker contains the substring "User task:", so lastIndexOf("User task:")
  // would slice into "(continued):…" and leak bridge teaching into cards/logs.
  const cont = "User task (continued):";
  const ci = t.lastIndexOf(cont);
  if (ci !== -1) {
    t = t.slice(ci + cont.length).trim();
  } else if (
    /^COMPLEXITY \(decide yourself/i.test(t) ||
    /^TASK COMPLEXITY:/i.test(t)
  ) {
    const taskMarker = "User task:";
    const ti = t.indexOf(taskMarker);
    if (ti !== -1) t = t.slice(ti + taskMarker.length).trim();
  }
  // Strip leftover telegram bridge teaching if still present (directive-only wrap).
  if (t.includes(TELEGRAM_BRIDGE_MARKER)) {
    const mi = t.indexOf(TELEGRAM_BRIDGE_MARKER);
    if (mi === 0) {
      const after = t.slice(TELEGRAM_BRIDGE_MARKER.length);
      const dbl = after.search(/\n\n(?![-*`])/);
      t = dbl !== -1 ? after.slice(dbl).trim() : "";
    } else {
      t = t.slice(0, mi).trim();
    }
  }
  // Drop removed/quiet meta-prompts if they landed in history.
  if (/^Session status update \(meta only\)/i.test(t.trim())) t = "";
  if (/^FOLLOW-UP SUGGESTIONS \(meta only\)/i.test(t.trim())) t = "";
  if (/^SELF-RECHECK DECISION \(meta only\)/i.test(t.trim())) t = "";
  if (/^SELF-RECHECK \(automatic quality pass/i.test(t.trim())) t = "";
  if (t.trimStart().startsWith(TELEGRAM_BRIDGE_RESULTS_MARKER)) t = "";
  return t;
}

function roleOf(kind?: string): HistoryRole | undefined {
  switch (kind) {
    case "Prompt":
    case "UserMessage":
      return "user";
    case "AssistantMessage":
    case "Response":
      return "assistant";
    case "ToolUse":
    case "ToolUseResults":
      return "tool";
    default:
      return undefined;
  }
}

function extractText(content?: Array<{ kind?: string; data?: unknown; text?: unknown }>): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block.kind === "text") {
      if (typeof block.data === "string") parts.push(block.data);
      else if (block.data && typeof (block.data as { text?: unknown }).text === "string") {
        parts.push((block.data as { text: string }).text);
      }
    } else if (typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("").trim();
}

/** Read up to `maxBytes` from the end of a file as UTF-8 text. */
function readTail(path: string, maxBytes: number): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return "";
  }
  if (size === 0) return "";

  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    let text = buf.toString("utf-8");
    // If we started mid-file, drop the partial first line.
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    closeSync(fd);
  }
}
