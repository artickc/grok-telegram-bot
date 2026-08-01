/**
 * Convert standard Markdown (as produced by the agent) into Telegram
 * MarkdownV2, with correct escaping and graceful handling of code blocks,
 * headings, lists, quotes, links and inline styles.
 *
 * Design goals:
 *  - Nothing meaningful is dropped: unbalanced fences, partial markup, and
 *    orphan backticks are escaped as literal text rather than deleted.
 *  - Code fences use a dynamic fence length so bodies that contain ``` never
 *    break the outer block (common when displaying source of fence helpers).
 *  - Closing fences must match open length (CommonMark-style ≥ open ticks) and
 *    are recognized on the first body line (empty code blocks).
 *  - Inline styles nest safely; unclosed markers fall through as escaped text.
 *  - Quote / thinking lines use a safer inline subset to avoid mid-stream
 *    breakage from half-open ** or nested fences.
 */
import { escapeCode, escapeMdV2, escapeUrl } from "./escape.js";

/**
 * Match a fenced code block: opening run of 3+ backticks, optional lang,
 * optional trailing newline. `^` is only applied at the start of the remaining
 * slice (we never search with multiline ^).
 */
const FENCE_OPEN = /^(```+)([^\n`]*)\n?/;

/** Main entry: returns a MarkdownV2-safe string. */
export function toTelegramMarkdown(src: string): string {
  if (!src) return "";
  // Normalize newlines; strip zero-width / bidi junk that Telegram chokes on.
  const normalized = src
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g, "");

  let out = "";
  let i = 0;
  const n = normalized.length;

  while (i < n) {
    const slice = normalized.slice(i);
    const open = FENCE_OPEN.exec(slice);
    if (open && open.index === 0) {
      const ticks = open[1]!;
      const minTicks = ticks.length;
      const langRaw = (open[2] ?? "").trim();
      const bodyStart = i + open[0].length;
      const close = findClosingFence(normalized, bodyStart, minTicks);
      if (close) {
        const code = normalized.slice(bodyStart, close.bodyEnd);
        out += fenceOut(code, sanitizeFenceLang(langRaw));
        i = close.afterClose;
        continue;
      }
      // Unclosed fence → treat rest as code (streaming-safe).
      const code = normalized.slice(bodyStart);
      out += fenceOut(code, sanitizeFenceLang(langRaw));
      break;
    }

    // Find next fence start (line-start ``` only).
    const nextFence = findNextFenceStart(normalized, i);
    const end = nextFence === -1 ? n : nextFence;
    out += renderTextBlock(normalized.slice(i, end));
    i = end;
    if (nextFence === -1) break;
  }

  return out.replace(/\n{4,}/g, "\n\n\n").trim();
}

/** Emit a Telegram-safe fenced block; fence length adapts to body content. */
function fenceOut(code: string, lang: string): string {
  // Drop a single trailing newline so we don't pad every closed fence with a
  // blank line inside the code block; keep internal newlines intact.
  const body = code.endsWith("\n") ? code.slice(0, -1) : code;
  let tickLen = 3;
  const runs = body.match(/`+/g);
  if (runs) {
    const max = Math.max(...runs.map((r) => r.length));
    if (max >= tickLen) tickLen = max + 1;
  }
  const marker = "`".repeat(tickLen);
  return marker + lang + "\n" + escapeCode(body) + "\n" + marker + "\n";
}

/**
 * Find a closing fence starting at `from` (body start).
 * Closing fence: a line that is only ≥ minTicks backticks (optional trailing
 * spaces / lang-like junk), CommonMark-style.
 *
 * Returns bodyEnd (exclusive, before the closing fence line's leading newline
 * if any) and afterClose (index past the closing fence line + its newline).
 */
function findClosingFence(
  src: string,
  from: number,
  minTicks: number,
): { bodyEnd: number; afterClose: number } | undefined {
  let lineStart = from;
  while (lineStart <= src.length) {
    // Measure leading backticks on this line.
    let j = lineStart;
    while (j < src.length && src[j] === "`") j++;
    const tickCount = j - lineStart;
    if (tickCount >= minTicks) {
      const nl = src.indexOf("\n", j);
      const lineEnd = nl === -1 ? src.length : nl;
      const rest = src.slice(j, lineEnd);
      // Closing fence: rest empty/whitespace, or only a simple info string.
      if (/^\s*$/.test(rest) || /^[A-Za-z0-9_+\-#./]*\s*$/.test(rest)) {
        // bodyEnd: exclude the newline that precedes this line when the close
        // is not the first character of the body (so code doesn't keep a
        // trailing blank). When close is on the first body line (empty block),
        // bodyEnd == from.
        let bodyEnd = lineStart;
        if (lineStart > from && src[lineStart - 1] === "\n") {
          bodyEnd = lineStart - 1;
        }
        const afterClose = nl === -1 ? src.length : nl + 1;
        return { bodyEnd, afterClose };
      }
    }
    // Advance to next line.
    const nl = src.indexOf("\n", lineStart);
    if (nl === -1) return undefined;
    lineStart = nl + 1;
    if (lineStart > src.length) return undefined;
  }
  return undefined;
}

function findNextFenceStart(src: string, from: number): number {
  if (from === 0 && src.startsWith("```")) return 0;
  let idx = from;
  while (idx < src.length) {
    const nl = src.indexOf("\n", idx);
    if (nl === -1) return -1;
    if (src.startsWith("```", nl + 1)) return nl + 1;
    idx = nl + 1;
  }
  return -1;
}

function sanitizeFenceLang(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  // Telegram fence info is free-form but we keep it ASCII-safe.
  return /^[A-Za-z0-9_+\-#./]+$/.test(t) ? t : "";
}

function renderTextBlock(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .map((line) => renderLine(line))
    .join("\n");
}

function renderLine(line: string): string {
  // Heading -> bold
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return "*" + renderInline((heading[2] ?? "").replace(/#+\s*$/, "").trim()) + "*";

  // Horizontal rule
  if (/^\s*([-*_])\1{2,}\s*$/.test(line)) return "\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014";

  // Blockquote — process body with lighter inline rules to avoid * / ` breakage
  // inside long thinking dumps.
  const quote = /^(>+)\s?(.*)$/.exec(line);
  if (quote) {
    const depth = (quote[1] ?? ">").length;
    const prefix = ">".repeat(depth);
    return prefix + renderQuoteInline(quote[2] ?? "");
  }

  // Unordered list
  const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (ul) return (ul[1] ?? "") + "\u2022 " + renderInline(ul[2] ?? "");

  // Ordered list
  const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (ol) return (ol[1] ?? "") + (ol[2] ?? "") + "\\. " + renderInline(ol[3] ?? "");

  return renderInline(line);
}

/**
 * Quote bodies (thinking): prefer plain escaping + simple `code` only.
 * Nested **bold** and triple-backtick fences often break mid-stream thoughts.
 */
function renderQuoteInline(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === "`") {
      let ticks = 1;
      while (i + ticks < n && text[i + ticks] === "`") ticks++;
      if (ticks >= 3) {
        // Triple+ ticks inside a quote → escape as literals (never open a fence).
        out += escapeMdV2("`".repeat(ticks));
        i += ticks;
        continue;
      }
      // Prefer matching same-length close; skip empty ``.
      const end = findCloseTicks(text, i + ticks, ticks);
      if (end !== -1 && end > i + ticks) {
        out += "`" + escapeCode(text.slice(i + ticks, end)) + "`";
        i = end + ticks;
        continue;
      }
      out += escapeMdV2("`".repeat(ticks));
      i += ticks;
      continue;
    }
    out += escapeMdV2(c);
    i += 1;
  }
  return out;
}

/** Render inline markdown spans into MarkdownV2. */
function renderInline(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];

    // Inline code — count backticks; never treat ``` as inline.
    if (c === "`") {
      let ticks = 1;
      while (i + ticks < n && text[i + ticks] === "`") ticks++;
      if (ticks >= 3) {
        out += escapeMdV2("`".repeat(ticks));
        i += ticks;
        continue;
      }
      const close = findCloseTicks(text, i + ticks, ticks);
      if (close !== -1 && close > i + ticks) {
        const body = text.slice(i + ticks, close);
        out += "`" + escapeCode(body) + "`";
        i = close + ticks;
        continue;
      }
      out += escapeMdV2("`".repeat(ticks));
      i += ticks;
      continue;
    }

    // Bold ** ** or __ __
    if ((c === "*" && next === "*") || (c === "_" && next === "_")) {
      const marker = c + c;
      const end = findBalanced(text, i + 2, marker);
      if (end !== -1) {
        out += "*" + renderInline(text.slice(i + 2, end)) + "*";
        i = end + 2;
        continue;
      }
    }

    // Strikethrough ~~ ~~
    if (c === "~" && next === "~") {
      const end = findBalanced(text, i + 2, "~~");
      if (end !== -1) {
        out += "~" + renderInline(text.slice(i + 2, end)) + "~";
        i = end + 2;
        continue;
      }
    }

    // Italic * * (single)
    if (c === "*" && next !== "*") {
      const end = findSingleStar(text, i + 1);
      if (end !== -1) {
        out += "_" + renderInline(text.slice(i + 1, end)) + "_";
        i = end + 1;
        continue;
      }
    }

    // Italic _ _ (single) — skip snake_case
    if (c === "_" && next !== "_") {
      const prev = i > 0 ? text[i - 1]! : " ";
      if (!/\w/.test(prev)) {
        const end = findSingleUnderscore(text, i + 1);
        if (end !== -1) {
          out += "_" + renderInline(text.slice(i + 1, end)) + "_";
          i = end + 1;
          continue;
        }
      }
    }

    // Link [text](url)
    if (c === "[") {
      const link = parseLink(text, i);
      if (link) {
        out += "[" + renderInline(link.text) + "](" + escapeUrl(link.url) + ")";
        i = link.end;
        continue;
      }
    }

    out += escapeMdV2(c);
    i += 1;
  }

  return out;
}

function findCloseTicks(text: string, from: number, ticks: number): number {
  const needle = "`".repeat(ticks);
  let idx = from;
  while (idx < text.length) {
    const at = text.indexOf(needle, idx);
    if (at === -1) return -1;
    // Don't stop on a longer run (e.g. looking for ` but hit ```).
    const after = at + ticks;
    if (after < text.length && text[after] === "`") {
      // Skip the whole run.
      let j = after;
      while (j < text.length && text[j] === "`") j++;
      idx = j;
      continue;
    }
    return at;
  }
  return -1;
}

function findBalanced(text: string, from: number, marker: string): number {
  // Don't span blank lines — keeps half-open ** from swallowing the rest of
  // the message when the agent streams incomplete emphasis.
  const end = text.indexOf(marker, from);
  if (end === -1 || end <= from) return -1;
  const mid = text.slice(from, end);
  if (mid.includes("\n\n")) return -1;
  return end;
}

function findSingleStar(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "*" && text[i + 1] !== "*") {
      if (text.slice(from, i).includes("\n")) return -1;
      if (i > from) return i;
    }
  }
  return -1;
}

function findSingleUnderscore(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "_" && text[i + 1] !== "_") {
      if (text.slice(from, i).includes("\n")) return -1;
      const next = text[i + 1] ?? " ";
      if (/\w/.test(next)) continue;
      if (i > from) return i;
    }
  }
  return -1;
}

function parseLink(text: string, start: number): { text: string; url: string; end: number } | undefined {
  if (text[start] !== "[") return undefined;
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  if (depth !== 0 || text[i] !== "(") return undefined;
  const linkText = text.slice(start + 1, i - 1);
  const close = text.indexOf(")", i + 1);
  if (close === -1) return undefined;
  const url = text.slice(i + 1, close).trim();
  if (!url || /\s/.test(url)) return undefined;
  return { text: linkText, url, end: close + 1 };
}
