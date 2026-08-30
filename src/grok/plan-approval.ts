/**
 * Grok plan-mode client reverse-requests (`x.ai/exit_plan_mode`,
 * `x.ai/ask_user_question`).
 *
 * When the agent finishes planning it calls the `exit_plan_mode` tool. Grok
 * intercepts that tool and sends a JSON-RPC **request** to the ACP client
 * (`x.ai/exit_plan_mode`) so a TUI can show the plan approval UI. The Telegram
 * bridge has no plan popup — it must answer the reverse-request immediately.
 *
 * Without a response (or with method-not-found), Grok fails the tool with:
 *   "Plan approval could not be completed because the client disconnected."
 * and plan mode stays Active (`awaiting_plan_approval: true`), blocking edits.
 */

/**
 * Method names Grok sends as client reverse-requests for plan / questions.
 *
 * Live ACP traffic (verified by smoke test) uses a leading underscore:
 *   `_x.ai/exit_plan_mode`
 * The bare `x.ai/…` form is kept for older builds / leader-path aliases.
 */
export const EXT_EXIT_PLAN_MODE = "_x.ai/exit_plan_mode";
export const EXT_EXIT_PLAN_MODE_ALT = "x.ai/exit_plan_mode";
export const EXT_ASK_USER_QUESTION = "_x.ai/ask_user_question";
export const EXT_ASK_USER_QUESTION_ALT = "x.ai/ask_user_question";

/** Plan approval outcomes accepted by Grok Build's ExitPlanModeExtResponse. */
export type PlanExitOutcome = "approved" | "abandoned" | "request_changes";

export interface PlanExitDecision {
  outcome: PlanExitOutcome;
  feedback?: string;
}

/**
 * Auto-approve leaving plan mode so the agent can implement.
 *
 * Reverse-request params (ExitPlanModeExtRequest, 3 fields) look like:
 *   { sessionId, toolCallId, planContent }
 *
 * Response shape verified by live smoke (`scripts/smoke-exit-shapes.ts`):
 *   { outcome: "approved", feedback: "" }
 * → plan_mode.json becomes `Inactive`.
 *
 * Wrong shapes (e.g. `decision: "approved"`, empty `{}`) are treated as
 * "user wants to revise the plan" and leave plan mode Active.
 */
export function autoApproveExitPlanMode(_params?: Record<string, unknown>): Record<string, unknown> {
  return {
    outcome: "approved",
    feedback: "",
  };
}

/**
 * Headless answer for ask_user_question reverse-request: skip the interview so
 * the agent is not stuck waiting for a TUI that does not exist.
 *
 * Current wire format: internally tagged `{ outcome: "skip_interview", ... }`.
 */
export function autoSkipAskUserQuestion(_params?: Record<string, unknown>): Record<string, unknown> {
  return { outcome: "skip_interview", partial_answers: {} };
}

/** Normalize method names: strip optional leading underscore for matching. */
function normMethod(method: string): string {
  const m = (method || "").trim();
  return m.startsWith("_") ? m.slice(1) : m;
}

/** True when the method is a plan-approval reverse-request we must answer. */
export function isPlanExitMethod(method: string): boolean {
  const m = normMethod(method);
  return m === "x.ai/exit_plan_mode" || m.endsWith("/exit_plan_mode");
}

export function isAskUserQuestionMethod(method: string): boolean {
  const m = normMethod(method);
  return m === "x.ai/ask_user_question" || m.endsWith("/ask_user_question");
}
