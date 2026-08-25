/**
 * Handle Grok ACP reverse requests for plan-mode exit and related extensions.
 *
 * Grok intercepts `exit_plan_mode` and sends a client reverse-request
 * (`_x.ai/exit_plan_mode` / `ext_method`). If the client returns
 * Method-not-found or errors out, the agent reports:
 *   "Plan approval could not be completed because the client disconnected."
 * and plan mode stays Active (edits remain blocked).
 *
 * Headless Telegram clients must answer approve / request-changes / abandon.
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

/** Build the JSON-RPC result for exit_plan_mode reverse requests. */
export function planExitResult(decision: PlanExitDecision): Record<string, unknown> {
  return { outcome: decision.outcome, feedback: decision.feedback ?? "" };
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
 * Returns a result object, or undefined if this module does not handle it.
 */
export function handleAgentReverseRequest(
  method: string,
  params: Record<string, unknown>,
  decidePlanExit: (ctx: {
    method: string;
    params: Record<string, unknown>;
  }) => PlanExitDecision | Promise<PlanExitDecision>,
): Promise<unknown | undefined> | unknown | undefined {
  if (isExitPlanMethod(method) && method !== "ext_method" && method !== "_ext_method") {
    log.info(`plan-exit reverse request via ${method}`);
    return Promise.resolve(decidePlanExit({ method, params })).then(planExitResult);
  }

  if (method === "ext_method" || method === "_ext_method") {
    const { method: nested, params: inner } = unwrapExtMethod(params);
    log.info(`ext_method nested=${nested || "(empty)"} keys=${Object.keys(params).join(",")}`);
    if (isExitPlanMethod(method, nested) && nested) {
      return Promise.resolve(decidePlanExit({ method: nested, params: inner })).then(planExitResult);
    }
    if (nested.toLowerCase().includes("ask_user_question")) {
      log.info(`auto-skip ask_user_question via ext_method ${nested}`);
      return { type: "SkipInterview" };
    }
    // Unknown x.ai/* extensions: ack empty so the agent does not treat
    // Method-not-found as a client disconnect mid-turn.
    if (nested.startsWith("x.ai/") || nested.startsWith("_x.ai/") || nested.startsWith("_")) {
      log.warn(`ack empty result for unhandled ext_method ${nested}`);
      return {};
    }
    return undefined;
  }

  if (method.startsWith("_") || method.startsWith("x.ai/")) {
    if (isExitPlanMethod(method)) {
      return Promise.resolve(decidePlanExit({ method, params })).then(planExitResult);
    }
    if (method.toLowerCase().includes("ask_user_question")) {
      log.info(`auto-skip ask_user_question via ${method}`);
      return { type: "SkipInterview" };
    }
    log.warn(`ack empty result for unhandled reverse method ${method}`);
    return {};
  }

  if (method === "elicitation/create") {
    log.info("elicitation/create — auto-accept");
    const schema = params.requestedSchema as { properties?: Record<string, unknown> } | undefined;
    const props = schema?.properties ? Object.keys(schema.properties) : [];
    const content: Record<string, unknown> = {};
    for (const p of props) {
      content[p] = /approv|outcome|action|decision/i.test(p) ? "approved" : "";
    }
    return { action: "accept", content };
  }

  return undefined;
}
