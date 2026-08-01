/**
 * First-prompt complexity steering (fully automatic — never asks the user).
 *
 * On the first user message of a fresh session the bot prepends a directive so
 * Grok itself decides Simple vs Complex:
 *   • Simple  — implement directly.
 *   • Complex — enter plan mode, investigate carefully, write a plan,
 *               exit_plan_mode (auto-approved by this bridge), implement,
 *               then re-review the result.
 *
 * No Telegram buttons, no user choice, no waiting.
 */
import type { PromptInput } from "../app/types.js";

/**
 * Agent-only directive. Must stay free of real `{progress: N%}` digit markers
 * (history cleaner strips those). Uses the letter N only if mentioning format.
 */
export const AUTO_COMPLEXITY_DIRECTIVE = [
  "COMPLEXITY (decide yourself — never ask the user):",
  "Silently classify this task as Simple or Complex. Do NOT ask the user which it is. Do NOT show Simple/Complex buttons or questions.",
  "",
  "If SIMPLE (clear path, small change, obvious fix, short answer):",
  "  implement or answer directly with normal care.",
  "",
  "If COMPLEX (ambiguity, multi-file architecture, high rework risk, unclear approach):",
  "  1. Enter plan mode (enter_plan_mode) when available.",
  "  2. Investigate carefully: explore the codebase, map patterns, edge cases, and risks before coding.",
  "  3. Write a solid plan to the plan file; prefer investigation over speed.",
  "  4. Call exit_plan_mode when ready. This Telegram bridge auto-approves plan exit",
  "     (there is no TUI plan popup). After exit_plan_mode succeeds, implement fully.",
  "     Do NOT wait for the user to \"approve a popup\" — just call exit_plan_mode and proceed.",
  "  5. After implementation, re-review your work (verify correctness, edge cases, and that the plan was followed) before finishing.",
  "",
  "User task:",
].join("\n");

/** Optional mode ids Grok may advertise for plan mode (best-effort only). */
export const PLAN_MODE_CANDIDATES = ["plan", "planning", "architect", "design"] as const;

/**
 * Prepend the auto-complexity directive so the agent decides Simple vs Complex
 * without any user interaction.
 */
export function wrapAutoComplexityPrompt(input: PromptInput): PromptInput {
  const body = input.text.trim() || "(see attached media / files)";
  // Avoid double-wrapping if a retry/queue path already applied it.
  if (body.startsWith("COMPLEXITY (decide yourself")) return input;
  return {
    ...input,
    text: `${AUTO_COMPLEXITY_DIRECTIVE}\n${body}`,
  };
}

/** Pick a plan-mode id from the agent's advertised modes, if any. */
export function pickPlanModeId(
  modes: Array<{ id: string; name: string }>,
  hasMode: (id: string) => boolean,
): string | undefined {
  for (const id of PLAN_MODE_CANDIDATES) {
    if (hasMode(id)) return id;
  }
  for (const m of modes) {
    if (/plan|architect|design/i.test(m.id) || /plan|architect|design/i.test(m.name)) {
      return m.id;
    }
  }
  return undefined;
}
