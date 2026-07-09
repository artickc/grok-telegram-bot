import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GrokError, isContextExhaustedError, isTransientError } from "../src/grok/client.js";

test("isTransientError detects throttling and 5xx/429", () => {
  assert.ok(isTransientError(new Error("high volume of traffic, try again")));
  assert.ok(isTransientError(new Error("Internal error")));
  assert.ok(isTransientError(new Error("429 too many requests")));
  assert.ok(isTransientError(new GrokError("boom", 503)));
  assert.ok(isTransientError(new Error("ECONNRESET")));
  assert.equal(isTransientError(new Error("syntax error in your prompt")), false);
});

test("isContextExhaustedError detects context-window failures", () => {
  assert.ok(isContextExhaustedError(new Error("maximum context length exceeded")));
  assert.ok(isContextExhaustedError(new Error("prompt is too long")));
  assert.ok(isContextExhaustedError(new Error("token limit reached")));
  assert.equal(isContextExhaustedError(new Error("network reset")), false);
});
