/**
 * Session forking helpers — "logical fork" of a Grok session.
 *
 * A fork is a fresh session in the same project, *primed* with the recent
 * transcript of the session it continues, so the conversation survives when the
 * original can't be used: its exclusive lock is held by another window, or it
 * got throttled / exhausted / stuck mid-turn. Used by:
 *   • lost-session recovery (a persisted session we can't reload), and
 *   • auto-fork-on-error (a transient prompt failure with no streamed output).
 */
import { join } from "node:path";
import { buildTranscript, readHistory } from "../sessions/history.js";

/** Read a compact transcript of a session's recent history from disk, or "". */
export function recentTranscript(sessionsDir: string, sessionId: string, entries = 24): string {
  try {
    const hist = readHistory(join(sessionsDir, `${sessionId}.jsonl`), entries);
    return hist.length > 0 ? buildTranscript(hist) : "";
  } catch {
    return "";
  }
}

/** Priming preamble injected as context into a forked (linked) continuation. */
export function buildPriming(transcript: string): string {
  return [
    "You are resuming a conversation that is currently still running in another",
    "window on this machine, so this is a linked continuation. Below is the recent",
    "transcript for context — use it to continue seamlessly.",
    "",
    "=== RECENT TRANSCRIPT ===",
    transcript,
    "=== END TRANSCRIPT ===",
  ].join("\n");
}
