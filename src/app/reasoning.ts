/**
 * Reasoning effort — a per-chat preference that steers how much deliberation
 * the agent applies. Implemented as a concise directive prepended to prompts so
 * it works regardless of backend-specific knobs.
 */
import type { ReasoningEffort } from "./types.js";

const DIRECTIVE: Record<ReasoningEffort, string> = {
  minimal: "Answer directly and briefly with minimal deliberation.",
  low: "Keep reasoning light; prefer a quick, concise solution.",
  medium: "", // default behaviour — no directive
  high: "Think carefully and thoroughly before answering; verify your work.",
  max: "Use maximum rigor: explore edge cases, double-check assumptions, and verify the result before finishing.",
};

const LABEL: Record<ReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
};

export function reasoningDirective(effort: ReasoningEffort): string {
  return DIRECTIVE[effort] ?? "";
}

export function reasoningLabel(effort: ReasoningEffort): string {
  return LABEL[effort] ?? effort;
}
