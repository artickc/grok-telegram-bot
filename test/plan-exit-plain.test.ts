import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PlanExitService } from "../src/bot/plan-exit-service.js";

describe("plain message during plan review", () => {
  it("treats the next chat text as request_changes without tapping Changes", async () => {
    const api = {
      sendMessage: async () => ({ message_id: 7 }),
      pinChatMessage: async () => {},
      editMessageText: async () => {},
      unpinChatMessage: async () => {},
    };
    const svc = new PlanExitService(api as never, false);
    const decision = svc.handle({ plan_content: "do the thing", sessionId: "s1" }, { chatId: 42 });
    await new Promise((r) => setImmediate(r));
    const notes = svc.takeFeedback(42, "please use the other approach");
    assert.equal(notes, true);
    const result = await decision;
    assert.equal(result.outcome, "request_changes");
    assert.equal(result.feedback, "please use the other approach");
  });

  it("ignores plain text when no plan is waiting", () => {
    const svc = new PlanExitService({} as never, false);
    assert.equal(svc.takeFeedback(1, "hello"), false);
  });
});
