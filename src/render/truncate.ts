/**
 * Display-only truncation helpers.
 *
 * Long tool outputs, diffs, and reasoning are shortened for Telegram so messages
 * stay readable and under size limits. Session history / agent context is
 * unaffected — these helpers never touch what is stored on disk for context.
 */

/** Ellipsis used in truncated regions (single character). */
const ELLIPSIS = "\u2026";

/**
 * Keep the start of `text` when longer than `max` (classic head truncate).
 * Prefer {@link truncateMiddle} for long command/diff/reasoning bodies.
 */
export function truncateHead(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return ELLIPSIS;
  return text.slice(0, max - 1) + ELLIPSIS;
}

/**
 * Keep both ends of a long string, cutting the middle with an explicit note.
 * Head ~40% / tail ~60% of the budget so recent terminal output stays visible.
 */
export function truncateMiddle(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 24) return truncateHead(text, max);

  const omitted = text.length;
  const marker = `\n${ELLIPSIS} (${omitted.toLocaleString("en-US")} chars total; middle omitted) ${ELLIPSIS}\n`;
  const budget = max - marker.length;
  if (budget < 8) return truncateHead(text, max);

  const headLen = Math.max(4, Math.floor(budget * 0.4));
  const tailLen = Math.max(4, budget - headLen);
  // Avoid overlapping when max is only slightly under length.
  if (headLen + tailLen >= text.length) return text;
  return text.slice(0, headLen) + marker + text.slice(text.length - tailLen);
}

/**
 * Middle-truncate a multi-line block by whole lines when possible (better for
 * diffs and command output). Falls back to character middle-truncate.
 */
export function truncateMiddleLines(text: string, maxLines: number, maxChars = 12_000): string {
  const lines = text.split("\n");
  let body: string;
  if (lines.length <= maxLines) {
    body = text;
  } else {
    const headN = Math.max(1, Math.floor(maxLines * 0.45));
    const tailN = Math.max(1, maxLines - headN);
    const omitted = lines.length - headN - tailN;
    body = [
      ...lines.slice(0, headN),
      `${ELLIPSIS} (${omitted} lines omitted) ${ELLIPSIS}`,
      ...lines.slice(lines.length - tailN),
    ].join("\n");
  }
  return truncateMiddle(body, maxChars);
}

/**
 * Live terminal display: keep the first output line + the last `tailLines`
 * lines so long command runs update in place without spamming new blocks.
 * Display-only — full text stays in the agent session / tool snapshot.
 */
export function formatLiveTerminalOutput(full: string, tailLines = 12, maxChars = 3500): string {
  const normalized = full.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  // Drop trailing empty lines for a cleaner tail.
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return "";
  if (lines.length <= tailLines + 1) {
    return truncateMiddle(lines.join("\n"), maxChars);
  }
  const first = lines[0]!;
  const tail = lines.slice(-tailLines);
  const omitted = lines.length - 1 - tailLines;
  const body = [first, `${ELLIPSIS} (${omitted} lines omitted; live tail) ${ELLIPSIS}`, ...tail].join("\n");
  return truncateMiddle(body, maxChars);
}
