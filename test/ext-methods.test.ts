import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  handleAgentReverseRequest,
  isExitPlanMethod,
  planExitResult,
  unwrapExtMethod,
} from "../src/grok/ext-methods.js";

describe("ext-methods plan exit", () => {
  it("detects exit_plan method names", () => {
    assert.equal(isExitPlanMethod("x.ai/exit_plan_mode"), true);
    assert.equal(isExitPlanMethod("ext_method", "x.ai/exit_plan_mode"), true);
    assert.equal(isExitPlanMethod("session/request_permission"), false);
  });

  it("unwraps ext_method params", () => {
    const u = unwrapExtMethod({
      method: "x.ai/exit_plan_mode",
      params: { plan_content: "# hi", sessionId: "abc" },
    });
    assert.equal(u.method, "x.ai/exit_plan_mode");
    assert.equal(u.params.plan_content, "# hi");
  });

  it("returns approved result shape", () => {
    const r = planExitResult({ outcome: "approved" });
    assert.deepEqual(r, { outcome: "approved", feedback: "" });
  });

  it("handles ext_method exit_plan via reverse handler", async () => {
    const result = await handleAgentReverseRequest(
      "ext_method",
      { method: "x.ai/exit_plan_mode", params: { plan_content: "p" } },
      () => ({ outcome: "approved", feedback: "go" }),
    );
    assert.deepEqual(result, { outcome: "approved", feedback: "go" });
  });

  it("acks unknown x.ai extensions with empty object", async () => {
    const result = await handleAgentReverseRequest(
      "ext_method",
      { method: "x.ai/session/update", params: {} },
      () => ({ outcome: "approved" }),
    );
    assert.deepEqual(result, {});
  });

  it("routes ask_user_question through the optional handler", async () => {
    const result = await handleAgentReverseRequest(
      "ext_method",
      { method: "x.ai/ask_user_question", params: { questions: [] } },
      () => ({ outcome: "approved" }),
      () => ({ type: "SubmitAnswers", answers: [{ questionId: "q0", selected: ["a"] }] }),
    );
    assert.deepEqual(result, {
      type: "SubmitAnswers",
      answers: [{ questionId: "q0", selected: ["a"] }],
    });
  });

  it("skips ask_user_question when no handler is installed", async () => {
    const result = await handleAgentReverseRequest(
      "x.ai/ask_user_question",
      { questions: [] },
      () => ({ outcome: "approved" }),
    );
    assert.deepEqual(result, { type: "SkipInterview" });
  });
});
