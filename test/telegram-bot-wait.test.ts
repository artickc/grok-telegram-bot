import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldAcceptBotContent } from "../src/bot/telegram-bots.js";

describe("shouldAcceptBotContent", () => {
  const startedAt = 1_000_000;

  it("accepts reply to our trigger", () => {
    assert.equal(
      shouldAcceptBotContent({
        kind: "message",
        alreadyTracked: false,
        startedAt,
        msgDateMs: startedAt + 100,
        editDateMs: 0,
        triggerMessageId: 42,
        replyToMessageId: 42,
      }),
      true,
    );
  });

  it("rejects reply to a different message", () => {
    assert.equal(
      shouldAcceptBotContent({
        kind: "message",
        alreadyTracked: false,
        startedAt,
        msgDateMs: startedAt + 100,
        editDateMs: 0,
        triggerMessageId: 42,
        replyToMessageId: 99,
      }),
      false,
    );
  });

  it("rejects stale messages from before the wait started", () => {
    assert.equal(
      shouldAcceptBotContent({
        kind: "message",
        alreadyTracked: false,
        startedAt,
        msgDateMs: startedAt - 10_000,
        editDateMs: 0,
        triggerMessageId: 42,
      }),
      false,
    );
  });

  it("accepts non-reply messages after wait started", () => {
    assert.equal(
      shouldAcceptBotContent({
        kind: "message",
        alreadyTracked: false,
        startedAt,
        msgDateMs: startedAt + 500,
        editDateMs: 0,
        triggerMessageId: 42,
      }),
      true,
    );
  });

  it("always accepts edits of already-tracked messages (streaming)", () => {
    assert.equal(
      shouldAcceptBotContent({
        kind: "edited_message",
        alreadyTracked: true,
        startedAt,
        msgDateMs: startedAt - 60_000,
        editDateMs: startedAt + 200,
        triggerMessageId: 42,
        replyToMessageId: 99, // even wrong reply_to — we already own this id
      }),
      true,
    );
  });

  it("rejects first-seen stale edits of ancient posts", () => {
    assert.equal(
      shouldAcceptBotContent({
        kind: "edited_message",
        alreadyTracked: false,
        startedAt,
        msgDateMs: startedAt - 60_000,
        editDateMs: startedAt - 50_000,
        triggerMessageId: 42,
      }),
      false,
    );
  });
});
