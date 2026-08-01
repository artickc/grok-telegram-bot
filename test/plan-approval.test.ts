import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  autoApproveExitPlanMode,
  autoSkipAskUserQuestion,
  EXT_ASK_USER_QUESTION,
  EXT_EXIT_PLAN_MODE,
  isAskUserQuestionMethod,
  isPlanExitMethod,
} from "../src/grok/plan-approval.js";
import { formatToolCall } from "../src/render/tool-call.js";
import type { SessionUpdate } from "../src/grok/types.js";

test("isPlanExitMethod matches live _x.ai/exit_plan_mode and bare form", () => {
  // Live ACP (smoke-tested): leading underscore.
  assert.equal(isPlanExitMethod("_x.ai/exit_plan_mode"), true);
  assert.equal(isPlanExitMethod(EXT_EXIT_PLAN_MODE), true);
  assert.equal(isPlanExitMethod("x.ai/exit_plan_mode"), true);
  assert.equal(isPlanExitMethod("session/request_permission"), false);
  assert.equal(isPlanExitMethod("_x.ai/other"), false);
});

test("isAskUserQuestionMethod matches live underscore form", () => {
  assert.equal(isAskUserQuestionMethod("_x.ai/ask_user_question"), true);
  assert.equal(isAskUserQuestionMethod(EXT_ASK_USER_QUESTION), true);
  assert.equal(isAskUserQuestionMethod("x.ai/ask_user_question"), true);
  assert.equal(isAskUserQuestionMethod("x.ai/other"), false);
});

test("autoApproveExitPlanMode returns smoke-verified outcome shape", () => {
  const r = autoApproveExitPlanMode({
    sessionId: "x",
    toolCallId: "y",
    planContent: "do the thing",
  });
  // Live-verified against grok agent stdio (smoke-exit-shapes.ts).
  assert.equal(r.outcome, "approved");
  assert.equal(r.feedback, "");
});

test("autoSkipAskUserQuestion returns SkipInterview", () => {
  const r = autoSkipAskUserQuestion({ questions: [] });
  assert.ok("SkipInterview" in r);
});

test("formatToolCall surfaces exit_plan_mode failure reason", () => {
  const u = {
    sessionUpdate: "tool_call_update",
    title: "Plan: Exit",
    name: "exit_plan_mode",
    status: "failed",
    rawInput: { variant: "ExitPlanMode" },
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: "Plan approval could not be completed because the client disconnected.",
        },
      },
    ],
  } as SessionUpdate;
  const md = formatToolCall(u, { showDiffs: false, diffMaxLines: 20 });
  assert.ok(md.includes("Plan: Exit"), md);
  assert.ok(md.includes("client disconnected") || md.includes("disconnected"), md);
});

test("formatToolCall formats enter_plan_mode", () => {
  const u = {
    sessionUpdate: "tool_call_update",
    title: "Plan mode entered",
    name: "enter_plan_mode",
    status: "completed",
    rawInput: { variant: "EnterPlanMode" },
    content: [
      {
        type: "content",
        content: { type: "text", text: "Plan file: /tmp/plan.md" },
      },
    ],
  } as SessionUpdate;
  const md = formatToolCall(u, { showDiffs: false, diffMaxLines: 20 });
  assert.ok(md.includes("Plan: Enter"), md);
  assert.ok(md.includes("Plan file") || md.includes("plan.md"), md);
});
