import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  GrokError,
  isAccountExhaustedError,
  isContextExhaustedError,
  isTransientError,
} from "../src/grok/client.js";
import { formatAccountSwitchNotice, shortSwitchReason } from "../src/bot/prompt-retry.js";

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

const BALANCE_MSG =
  'Internal error [-32603] — {"message":"API error (status 402 Payment Required): Grok Build usage balance exhausted\\n\\nRequest URL: https://cli-chat-proxy.grok.com/v1/responses","http_status":402}';

test("isAccountExhaustedError detects 402 balance exhausted (message + data)", () => {
  assert.ok(isAccountExhaustedError(new Error(BALANCE_MSG)));
  assert.ok(
    isAccountExhaustedError(
      new GrokError("Internal error [-32603]", -32603, {
        message: "API error (status 402 Payment Required): Grok Build usage balance exhausted",
        http_status: 402,
      }),
    ),
  );
  assert.ok(isAccountExhaustedError(new Error("Payment Required")));
  assert.ok(isAccountExhaustedError(new Error("out of credits")));
  assert.equal(isAccountExhaustedError(new Error("high volume of traffic")), false);
  assert.equal(isAccountExhaustedError(new GrokError("Internal error", -32603)), false);
});

test("402 balance exhausted is NOT transient (no same-account backoff retry)", () => {
  // Code is still -32603 (normally transient) but billing must short-circuit.
  const err = new GrokError(BALANCE_MSG, -32603, {
    message: "API error (status 402 Payment Required): Grok Build usage balance exhausted",
    http_status: 402,
  });
  assert.equal(isTransientError(err), false);
  assert.ok(isAccountExhaustedError(err));
  assert.equal(isTransientError(new Error(BALANCE_MSG)), false);
});

test("account switch notice includes label and reason", () => {
  const notice = formatAccountSwitchNotice("work@x.ai", new Error(BALANCE_MSG));
  assert.match(notice, /Account switched to work@x\.ai/);
  assert.match(notice, /because of:/i);
  assert.match(notice, /balance exhausted/i);
  assert.match(notice, /Restarting Grok CLI/i);
  assert.match(shortSwitchReason(new Error(BALANCE_MSG)), /balance exhausted/i);
});
