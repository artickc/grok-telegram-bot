/**
 * Task-progress support: parse the `{progress: N%}` marker the agent appends to
 * its messages, strip it from the visible text, and render a green loading bar.
 *
 * The agent is asked (see PROGRESS_DIRECTIVE) to end each message with a marker
 * like `{progress: 65%}`. The bot extracts the latest value, removes the marker
 * so it never shows raw, and renders a 0–100% bar (filled = 🟩, empty = ⬜) on
 * the live message, in session cards, and in the pinned status panel.
 */

/** Matches a complete marker: `{progress: 65%}`, `{ progress:65 }`, etc. */
const PROGRESS_RE = /\{\s*progress\s*:\s*(\d{1,3})\s*%?\s*\}/gi;
/** Matches a trailing, not-yet-closed marker mid-stream (e.g. `…{progress: 6`). */
const PARTIAL_TAIL_RE = /\{\s*progress\b[^}]*$/i;

const FILLED = "\u{1F7E9}"; // 🟩
const EMPTY = "\u2B1C"; // ⬜
const SEGMENTS = 10;

/**
 * The instruction appended to prompts so the agent emits a progress marker.
 *
 * IMPORTANT for maintainers:
 *  - The ONLY brace token may be the literal `{progress: N%}` with the letter
 *    `N` (never a digit). A digit inside braces would be parsed by PROGRESS_RE
 *    as a real value AND would break the exact-string strip in
 *    `sessions/history.ts` (`cleanStoredText`).
 *  - Keep this string "tidy-idempotent": no trailing spaces on any line, no run
 *    of 3+ newlines, and no trailing whitespace at the end. `cleanStoredText`
 *    runs `extractProgress` (which calls `tidy()`) before stripping the
 *    directive by exact match, so any whitespace `tidy()` would rewrite must
 *    not appear here, or the directive leaks into history/previews.
 */
export const PROGRESS_DIRECTIVE = [
  "PROGRESS REPORTING IS MANDATORY ON EVERY SINGLE MESSAGE YOU SEND \u2014 NO EXCEPTIONS.",
  "Rule 1 (format): finish EVERY message with a task-completion marker on its own final line, in EXACTLY this format, with nothing at all after it: {progress: N%}",
  "N is a plain integer from 0 to 100 (no decimals, no ranges, no math). The marker is the very last thing in the message: no text, punctuation, spaces, emoji, backticks, or code fences may follow it, and it must NEVER be placed inside a code block or quote.",
  "Rule 2 (frequency): emit the marker on your FIRST message, on EVERY intermediate message, after EVERY tool call or group of tool calls, around any subagent delegation, and on your FINAL message. Short replies, plans, questions, acknowledgements, clarifications, errors, and tool-only or status updates are NOT exempt \u2014 if you output any text at all, it ends with the marker. Do not batch it only into the last message.",
  "Rule 3 (compute it for real, never random): before each message, decompose the overall task into the concrete steps it actually needs (understand the request, read the relevant files, each separate edit, run the build/tests, fix failures, verify) and set N = round(100 * completed_steps / total_steps), re-estimated fresh from the real current state each time.",
  "Rule 4 (be granular and honest): start low (about 5 to 15 on your first message; use 0 only when literally nothing is started yet), then climb in realistic increments that mirror real progress. Do NOT jump from a low number straight to a high one, and do NOT keep repeating the same number across messages while work is clearly advancing.",
  "Rule 5 (monotonic): within one task the number must NEVER decrease \u2014 each marker is greater than or equal to the previous one you emitted.",
  "Rule 6 (terminal): report 100 ONLY when the entire task is fully complete and verified with nothing left to do. While ANY work, fix, verification, question, or follow-up remains, cap the number at 99.",
  "The client parses this marker, removes it from the visible text, and renders it as a live progress bar, so its presence on every message and the accuracy of the number both matter.",
].join("\n");

export interface ProgressExtract {
  /** Latest progress value found (0–100), or undefined if none. */
  value?: number;
  /** The input text with all progress markers removed. */
  cleaned: string;
}

/** Pull the latest `{progress: N%}` value out of `text` and strip every marker
 *  (plus any trailing half-streamed marker so it never flashes raw). */
export function extractProgress(text: string): ProgressExtract {
  let value: number | undefined;
  let cleaned = text.replace(PROGRESS_RE, (_m, digits: string) => {
    const v = Math.max(0, Math.min(100, Number.parseInt(digits, 10)));
    if (Number.isFinite(v)) value = v; // keep the LAST occurrence (most recent)
    return "";
  });
  cleaned = cleaned.replace(PARTIAL_TAIL_RE, "");
  return { value, cleaned: tidy(cleaned) };
}

/** Tidy whitespace left behind by a removed marker. */
function tidy(s: string): string {
  return s
    .replace(/[ \t]+\n/g, "\n") // trailing spaces on lines
    .replace(/\n{3,}/g, "\n\n") // collapse blank-line runs
    .replace(/\s+$/g, ""); // trailing whitespace/newlines
}

/** A 10-segment green progress bar, e.g. `🟩🟩🟩🟩🟩⬜⬜⬜⬜⬜ 50%` (✅ at 100%). */
export function progressBar(pct: number): string {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.round((v / 100) * SEGMENTS);
  const bar = FILLED.repeat(filled) + EMPTY.repeat(SEGMENTS - filled);
  return `${bar} ${v}%${v >= 100 ? " \u2705" : ""}`;
}
