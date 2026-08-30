/**
 * Session "comment" shown on Running / Sessions cards:
 *   • always     — last user prompt (≤ COMMENT_MAX)
 *   • while busy — also last AI agent thinking (≤ COMMENT_MAX), second line
 *
 * Built only from data already in the turn — no extra agent prompt (those
 * leaked into chat/history). Display-only; never truncates agent context.
 */
import { basename } from "node:path";
import type { SessionUpdate } from "../grok/types.js";
import { extractProgress } from "./progress.js";
import {
  extractCommand,
  extractPath,
  extractSearchQuery,
  extractUrl,
  resolveToolIdentity,
} from "./tool-call-detail.js";
import type { FileOp } from "./file-summary.js";

/** Max length of each card comment line (user prompt or thinking). */
export const COMMENT_MAX = 250;

/**
 * Legacy marker for the removed silent AI card-summary prompt. Kept only so
 * history / previews can strip it if an old session log still contains it.
 */
export const COMMENT_SUMMARY_PROMPT_PREFIX = "Session status update (meta only).";

/** Collapse whitespace and clamp to card width. */
export function cleanCommentLine(raw: string, max = COMMENT_MAX): string {
  // Drop leaked meta-summary prompts (should never be a card comment).
  if (raw.includes(COMMENT_SUMMARY_PROMPT_PREFIX) || /^Session status update\b/i.test(raw.trim())) {
    return "";
  }
  let t = raw
    .replace(/\{[\s]*progress[\s]*:[\s]*\d{1,3}\s*%?[\s]*\}/gi, "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
  // Prefer the first non-empty line if multi-line junk remains.
  const first = t.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  t = (first ?? t).replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "\u2026";
}

/**
 * Strip bot-injected wrappers (complexity directive, reply markers) so recheck
 * prompts and card previews see the user's real request text.
 */
export function stripDirectiveWrappers(raw: string): string {
  let t = raw.trim().replace(/^\([^)]*\)\s*/, "");
  // Manager context + work reports (meta).
  if (/^MANAGER WORK REPORT \(system/i.test(t)) t = "";
  if (/MANAGER CONTEXT \(auto/i.test(t)) {
    t = t.replace(/MANAGER CONTEXT \(auto[\s\S]*?\n---\n\n/i, "");
  }
  if (/^MANAGER MODE \(General topic/i.test(t)) {
    t = t.replace(/^MANAGER MODE \(General topic[\s\S]*?User message:\s*/i, "");
  }
  const marker = "User's new message:";
  const i = t.lastIndexOf(marker);
  if (i !== -1) t = t.slice(i + marker.length);
  // Continued marker first — it contains the substring "User task:".
  const cont = "User task (continued):";
  const ci = t.lastIndexOf(cont);
  if (ci !== -1) {
    t = t.slice(ci + cont.length);
  } else {
    t = t.replace(/^TASK COMPLEXITY:[\s\S]*?User task:\s*/i, "");
    t = t.replace(/^COMPLEXITY \(decide yourself[\s\S]*?User task:\s*/i, "");
    if (/TELEGRAM BRIDGE \(how to work/i.test(t)) {
      t = t.replace(/TELEGRAM BRIDGE \(how to work[\s\S]*?(?=\n\n[A-Za-z]|$)/i, "");
    }
  }
  if (/^TELEGRAM BRIDGE RESULTS \(system/i.test(t.trim())) t = "";
  if (/^MANAGER WORK REPORT \(system/i.test(t.trim())) t = "";
  return t.trim();
}

/** Strip bot directives so a user prompt is card-friendly. */
export function cleanUserPreview(raw: string, max = COMMENT_MAX): string {
  let t = stripDirectiveWrappers(raw);
  // Import confirm prompts are noise on cards.
  if (/session import complete/i.test(t)) return "";
  // Self-recheck / quiet meta prompts should not appear as user "Working:" text.
  if (/^SELF-RECHECK \(automatic quality pass/i.test(t)) return "Self-recheck";
  if (/^SELF-RECHECK DECISION \(meta only\)/i.test(t)) return "";
  if (/^FOLLOW-UP SUGGESTIONS \(meta only\)/i.test(t)) return "";
  if (/^TELEGRAM BRIDGE RESULTS \(system/i.test(t)) return "Telegram bridge";
  if (/^MANAGER WORK REPORT \(system/i.test(t)) return "Manager work report";
  return cleanCommentLine(t, max);
}

/**
 * Format the session-card comment body:
 *   idle  → last user prompt (≤ max)
 *   busy  → user prompt + last agent thinking on the next line (each ≤ max)
 *
 * Returns "" when neither line has content. Caller adds icons per line.
 */
export function buildSessionCardComment(opts: {
  userPrompt?: string;
  thinking?: string;
  busy?: boolean;
  max?: number;
}): string {
  const max = opts.max ?? COMMENT_MAX;
  const user = opts.userPrompt?.trim()
    ? cleanUserPreview(opts.userPrompt, max)
    : "";
  const thinkRaw = opts.busy && opts.thinking?.trim() ? opts.thinking.trim() : "";
  const thinking = thinkRaw ? clampThinking(thinkRaw, max) : "";

  if (user && thinking) return `${user}\n${thinking}`;
  if (user) return user;
  if (thinking) return thinking;
  return "";
}

/**
 * Prefer the latest portion of accumulated thought text (streaming chunks
 * append; conclusions land at the end). Collapse whitespace and clamp.
 */
export function clampThinking(raw: string, max = COMMENT_MAX): string {
  let t = extractProgress(raw).cleaned;
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  // Prefer the ending (most recent thinking).
  if (t.length > max + 40) {
    const tail = t.slice(-(max - 1));
    const sp = tail.indexOf(" ");
    return "\u2026" + (sp > 0 && sp < 40 ? tail.slice(sp + 1) : tail);
  }
  return t.slice(0, max - 1) + "\u2026";
}

/**
 * Pull a human-useful outcome snippet from the assistant's streamed reply.
 * Prefers the closing sentences (where conclusions land) over mid-turn "I'll…".
 */
export function extractResultSnippet(assistantText: string | undefined, max = 160): string {
  if (!assistantText?.trim()) return "";
  let t = extractProgress(assistantText).cleaned;
  // Drop fenced code / diffs / tool-looking blocks — keep prose.
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/^>\s?.*$/gm, " "); // quoted thinking
  // Drop lines that look like tool-call headers (emoji + bold title).
  t = t.replace(/^[^\nA-Za-z0-9]*\*\*[^*\n]+\*\*[^\n]*$/gm, " ");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return "";
  // Filter pure meta / plumbing lines.
  if (/^Session status update\b/i.test(t)) return "";
  if (/^COMPLEXITY \(decide yourself/i.test(t)) return "";

  // Prefer last 1–2 substantial sentences (what was solved).
  const sentences = t
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 24 && !isWeakOpener(s));
  if (sentences.length >= 2) {
    const tail = sentences.slice(-2).join(" ");
    return cleanCommentLine(tail, max);
  }
  if (sentences.length === 1) return cleanCommentLine(sentences[0]!, max);

  // Fallback: whole cleaned text, clamped.
  return cleanCommentLine(t, max);
}

/** Mid-turn openers that are not useful as a "what was solved" line. */
function isWeakOpener(s: string): boolean {
  return /^(i'?ll |i will |let me |looking |investigat|tracing |checking |reading |searching )/i.test(
    s,
  );
}

/** Compact file-change phrase: "~3: tool-call.ts, running.ts +1". */
export function formatFilesPhrase(fileOps: Map<string, FileOp>, maxNames = 3): string {
  const n = fileOps.size;
  if (n === 0) return "";
  const names = [...fileOps.keys()]
    .slice(0, maxNames)
    .map((p) => basename(p.replace(/\\/g, "/")));
  const more = n > maxNames ? ` +${n - maxNames}` : "";
  const counts = countsShort(fileOps);
  return `${counts} ${names.join(", ")}${more}`.trim();
}

function countsShort(ops: Map<string, FileOp>): string {
  let c = 0,
    e = 0,
    d = 0,
    m = 0;
  for (const op of ops.values()) {
    if (op === "created") c++;
    else if (op === "edited") e++;
    else if (op === "deleted") d++;
    else if (op === "moved") m++;
  }
  const parts: string[] = [];
  if (c) parts.push(`+${c}`);
  if (e) parts.push(`~${e}`);
  if (d) parts.push(`\u2212${d}`);
  if (m) parts.push(`\u2192${m}`);
  return parts.length ? parts.join("") : `${ops.size} files`;
}

/**
 * Card summary for a finished turn: what was solved (assistant result) + files.
 * Never uses a follow-up model call.
 */
export function buildLastTurnSummary(opts: {
  userText?: string;
  assistantText?: string;
  fileOps: Map<string, FileOp>;
  stopReason?: string;
  cancelled?: boolean;
  error?: string;
  max?: number;
}): string {
  const max = opts.max ?? COMMENT_MAX;
  if (opts.cancelled) return "Stopped by user";
  if (opts.error) return cleanCommentLine(`Error: ${opts.error}`, max);

  const result = extractResultSnippet(opts.assistantText, Math.min(160, max - 20));
  const files = formatFilesPhrase(opts.fileOps);
  const intent = cleanUserPreview(opts.userText || "", 55);

  // Prefer outcome prose (what was solved) over the user's ask.
  if (result && files) {
    const combined = `${result} \u00B7 ${files}`;
    return cleanCommentLine(combined, max);
  }
  if (result) return cleanCommentLine(result, max);
  if (files && intent) return cleanCommentLine(`${intent} \u2192 ${files}`, max);
  if (files) return cleanCommentLine(`Changed ${files}`, max);
  if (intent) return cleanCommentLine(intent, max);

  if (opts.stopReason && opts.stopReason !== "end_turn" && opts.stopReason !== "cancelled") {
    return cleanCommentLine(`Done (${opts.stopReason})`, max);
  }
  return "Turn complete";
}

/** @deprecated Use {@link buildLastTurnSummary}. */
export function buildLocalTurnComment(opts: {
  userText?: string;
  assistantText?: string;
  fileOps: Map<string, FileOp>;
  stopReason?: string;
  cancelled?: boolean;
  error?: string;
}): string {
  return buildLastTurnSummary(opts);
}

/** Derive a live "current step" line from an ACP tool update. */
export function stepFromToolUpdate(u: SessionUpdate): string | undefined {
  const raw = { ...((u.rawInput || {}) as Record<string, unknown>) };
  const id = resolveToolIdentity(u, raw);
  const kind = id.kind;
  const path = extractPath(raw);
  const short = path ? basename(path.replace(/\\/g, "/")) : "";
  const status = (u.status || "").toLowerCase();
  const done = status === "completed" || status === "failed";
  const fail = status === "failed" ? " failed" : done ? " done" : "";

  switch (kind) {
    case "execute": {
      const cmd = extractCommand(raw);
      if (cmd) return cleanCommentLine(`Run: ${cmd}${fail}`, COMMENT_MAX);
      break;
    }
    case "edit":
      return cleanCommentLine(`Edit ${short || path || "file"}${fail}`, COMMENT_MAX);
    case "write":
    case "create":
      return cleanCommentLine(`${kind === "create" ? "Create" : "Write"} ${short || path || "file"}${fail}`, COMMENT_MAX);
    case "read":
      return cleanCommentLine(`Read ${short || path || id.toolName || "file"}${fail}`, COMMENT_MAX);
    case "list":
      return cleanCommentLine(`List ${short || path || "."}${fail}`, COMMENT_MAX);
    case "search": {
      const q = extractSearchQuery(raw);
      return cleanCommentLine(`Search${q ? `: ${q}` : ""}${fail}`, COMMENT_MAX);
    }
    case "delete":
      return cleanCommentLine(`Delete ${short || path || "file"}${fail}`, COMMENT_MAX);
    case "move":
    case "rename":
      return cleanCommentLine(`${kind === "rename" ? "Rename" : "Move"} ${short || path || "file"}${fail}`, COMMENT_MAX);
    case "fetch":
    case "web_fetch": {
      const url = extractUrl(raw);
      return cleanCommentLine(`Fetch ${url || "URL"}${fail}`, COMMENT_MAX);
    }
    case "web_search": {
      const q = extractSearchQuery(raw) || extractUrl(raw);
      return cleanCommentLine(`Web search${q ? `: ${q}` : ""}${fail}`, COMMENT_MAX);
    }
    case "mcp":
      return cleanCommentLine(
        `MCP ${id.mcpServer ? id.mcpServer + ": " : ""}${id.mcpMethod || id.toolName}${fail}`,
        COMMENT_MAX,
      );
    default:
      break;
  }
  if (id.toolName) return cleanCommentLine(`${id.toolName}${fail}`, COMMENT_MAX);
  if (u.title?.trim() && !/^other$/i.test(u.title.trim())) {
    return cleanCommentLine(u.title.trim() + fail, COMMENT_MAX);
  }
  return undefined;
}

/** Thinking step line from a thought chunk (display only). */
export function stepFromThought(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "Thinking\u2026";
  return cleanCommentLine(`Thinking: ${t}`, COMMENT_MAX);
}
