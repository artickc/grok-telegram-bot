/**
 * @deprecated `/goal` is owned by `handlers/grok-slash.ts` (Telegram menu + catch-all).
 * Kept as thin helpers for older tests; do not register a second `bot.command("goal")`.
 */

const GOAL_SUBCOMMANDS = new Set(["status", "pause", "resume", "clear"]);

/**
 * Build the exact slash line to send to Grok ACP, or undefined when usage is needed.
 */
export function normalizeGoalSlashLine(rawArgs: string): string | undefined {
  let args = (rawArgs || "").trim();
  if (!args) return undefined;
  args = args.replace(/^\/?goal(?:\s+|$)/i, "").trim();
  if (!args) return undefined;
  args = args.replace(/^\/?goal\s+/i, "").trim();
  if (!args) return undefined;
  const first = args.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (GOAL_SUBCOMMANDS.has(first)) return `/goal ${first}`;
  return `/goal ${args}`;
}

export function formatGoalUsage(): string {
  return [
    "\u{1F3AF} Grok /goal — run until done",
    "",
    "Usage:",
    "/goal <objective> [--budget <tokens>]",
    "/goal status | pause | resume | clear",
    "",
    "Use in a project topic or AI Chat (not General).",
    "Handled by the Grok slash forwarder (handlers/grok-slash.ts).",
  ].join("\n");
}
