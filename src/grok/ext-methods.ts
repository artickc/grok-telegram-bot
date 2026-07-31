/**
 * Handle Grok ACP reverse requests for plan-mode exit and related extensions.
 *
 * Grok intercepts `exit_plan_mode` and sends a client reverse-request
 * (`ext_method` / `x.ai/exit_plan_mode`). If the client returns Method-not-found
 * or errors out, the agent reports:
 *   "Plan approval could not be completed because the client disconnected."
 * and plan mode stays Active (edits remain blocked).
 *
 * Headless clients (this bot) must answer the reverse request with an approve /
 * request-changes / abandon outcome so plan mode can leave.
 */
import { createLogger } from "../logger.js";

const log = createLogger("ext-methods");

/** Plan approval outcomes accepted by Grok Build's ExitPlanModeExtResponse. */
export type PlanExitOutcome = "approved" | "abandoned" | "request_changes";

export interface PlanExitDecision {
  outcome: PlanExitOutcome;
  /** Optional free-form notes for request_changes / approved review comments. */
  feedback?: string;
}

/**
 * Build the JSON-RPC result for exit_plan_mode reverse requests.
 * Shape reverse-engineered from Grok 0.2.x (ExitPlanModeExtResponse: 2 fields).
 */
export function planExitResult(decision: PlanExitDecision): Record<string, unknown> {
  const feedback = decision.feedback ?? "";
  // Primary shape: { outcome, feedback }
  return { outcome: decision.outcome, feedback };
}

/** True if this ACP method is a plan-exit reverse request (any naming variant). */
export function isExitPlanMethod(method: string, nested?: string): boolean {
  const names = [method, nested]
    .filter((m): m is string => Boolean(m) && m !== "ext_method" && m !== "_ext_method")
    .map((m) => m.toLowerCase());
  return names.some(
    (m) =>
      m.includes("exit_plan_mode") ||
      m.includes("exitplanmode") ||
      m.endsWith("/exit_plan_mode") ||
      m.includes("plan_approval") ||
      m.includes("planapproval"),
  );
}

/** Unwrap ACP `ext_method` params → { method, params }. */
export function unwrapExtMethod(params: Record<string, unknown>): {
  method: string;
  params: Record<string, unknown>;
} {
  const method =
    (typeof params.method === "string" && params.method) ||
    (typeof params.methodName === "string" && params.methodName) ||
    (typeof params.name === "string" && params.name) ||
    "";
  const inner =
    params.params && typeof params.params === "object" && !Array.isArray(params.params)
      ? (params.params as Record<string, unknown>)
      : params;
  return { method, params: inner };
}

/**
 * Resolve a reverse request from the agent.
 * Returns a result object, or undefined if this module does not handle the method
 * (caller should fall through to other handlers / Method-not-found).
 */
export function handleAgentReverseRequest(
  method: string,
  params: Record<string, unknown>,
  decidePlanExit: (ctx: {
    method: string;
    params: Record<string, unknown>;
  }) => PlanExitDecision | Promise<PlanExitDecision>,
): Promise<unknown | undefined> | unknown | undefined {
  // Direct method names
  if (isExitPlanMethod(method) && method !== "ext_method") {
    log.info(`plan-exit reverse request via ${method}`);
    return Promise.resolve(decidePlanExit({ method, params })).then(planExitResult);
  }

  // Nested: ext_method { method: "x.ai/exit_plan_mode", params: {...} }
  if (method === "ext_method" || method === "_ext_method") {
    const { method: nested, params: inner } = unwrapExtMethod(params);
    log.info(`ext_method nested=${nested || "(empty)"} keys=${Object.keys(params).join(",")}`);
    if (isExitPlanMethod(method, nested) && nested) {
      return Promise.resolve(decidePlanExit({ method: nested, params: inner })).then(planExitResult);
    }
    // Unknown x.ai/* extensions: acknowledge empty so the agent does not treat
    // Method-not-found as a client disconnect mid-turn.
    if (nested.startsWith("x.ai/") || nested.startsWith("_x.ai/") || nested.startsWith("_")) {
      log.warn(`ack empty result for unhandled ext_method ${nested}`);
      return {};
    }
    return undefined;
  }

  // Underscore-prefixed custom methods (ACP extensibility)
  if (method.startsWith("_") || method.startsWith("x.ai/")) {
    if (isExitPlanMethod(method)) {
      return Promise.resolve(decidePlanExit({ method, params })).then(planExitResult);
    }
    // ask_user_question — auto-skip so turns do not hang headless
    if (method.toLowerCase().includes("ask_user_question")) {
      log.info(`auto-skip ask_user_question via ${method}`);
      return { type: "SkipInterview" };
    }
    log.warn(`ack empty result for unhandled reverse method ${method}`);
    return {};
  }

  // ACP elicitation/create (if agent uses form elicitation for plan UI)
  if (method === "elicitation/create") {
    log.info("elicitation/create — auto-accept");
    const schema = params.requestedSchema as { properties?: Record<string, unknown> } | undefined;
    const props = schema?.properties ? Object.keys(schema.properties) : [];
    const content: Record<string, unknown> = {};
    for (const p of props) {
      // Prefer approve-like defaults when present
      content[p] = /approv|outcome|action|decision/i.test(p) ? "approved" : "";
    }
    return { action: "accept", content };
  }

  return undefined;
}
