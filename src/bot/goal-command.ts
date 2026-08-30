/**
 * Helpers for Telegram `/goal` → Grok Build slash command forwarding.
 *
 * Grok expects the prompt text to start with `/goal …` (status/pause/resume/clear
 * or an objective). Wrappers must not prepend anything in front of that line.
 */

const GOAL_SUBCOMMANDS = new Set(["status", "pause", "resume", "clear"]);

/**
 * Build the exact slash line to send to Grok ACP, or undefined when usage is needed.
 * Accepts bare subcommands / objectives; strips a leading `/goal` if the user typed it twice.
 */
export function normalizeGoalSlashLine(rawArgs: string): string | undefined {
  let args = (rawArgs || "").trim();
  if (!args) return undefined;
  // Tolerate "/goal /goal status", bare "/goal", or pasted "/goal …" in match.
  args = args.replace(/^\/?goal(?:\s+|$)/i, "").trim();
  if (!args) return undefined;
  // Drop a duplicated leading "/goal" token if still present.
  args = args.replace(/^\/?goal\s+/i, "").trim();
  if (!args) return undefined;
  const first = args.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (GOAL_SUBCOMMANDS.has(first)) {
    // Keep only the known subcommand token (ignore trailing junk).
    return `/goal ${first}`;
  }
  // Objective — keep full text (may include --budget N).
  return `/goal ${args}`;
}

export function formatGoalUsage(): string {
  return [
    "\u{1F3AF} Grok /goal — run until done",
    "",
    "Usage:",
    "/goal <objective> [--budget <tokens>]",
    "/goal status",
    "/goal pause",
    "/goal resume",
    "/goal clear",
    "",
    "Example:",
    "/goal Fix shortDescription length auto-repair. Done when typecheck + tests pass.",
    "",
    "Use this in a project topic or AI Chat (not General).",
  ].join("\n");
}
