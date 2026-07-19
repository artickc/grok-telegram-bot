import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  GrokError,
  isAccountExhaustedError,
  isAccountRotationError,
  isContextExhaustedError,
  isSessionLifecycleError,
  isTransientError,
} from "../src/grok/client.js";
import { formatAccountSwitchNotice, shortSwitchReason } from "../src/bot/prompt-retry.js";
import { AccountRotatorImpl } from "../src/bot/account-rotator.js";
import type { AccountManager } from "../src/app/accounts.js";
import type { GrokClient } from "../src/grok/client.js";

test("isTransientError detects throttling and 5xx/429", () => {
  assert.ok(isTransientError(new Error("high volume of traffic, try again")));
  assert.ok(isTransientError(new Error("Internal error")));
  assert.ok(isTransientError(new Error("429 too many requests")));
  assert.ok(isTransientError(new GrokError("boom", 503)));
  assert.ok(isTransientError(new Error("ECONNRESET")));
  assert.ok(isTransientError(new Error("Empty agent response — Grok ended the turn without any output or tool activity")));
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

test("403 access denied is an account-rotation error, not a transient retry", () => {
  const message = 'Internal error [-32603] — {"message":"API error (status 403 Forbidden): Access denied","http_status":403}';
  assert.ok(isAccountRotationError(new Error(message)));
  assert.ok(isAccountRotationError(new GrokError("Internal error", -32603, { http_status: 403 })));
  assert.equal(isTransientError(new Error(message)), false);
});

test("session/process lifecycle failures never trigger account retry semantics", () => {
  for (const error of [
    new GrokError("Invalid params [-32602] — unknown session id", -32602),
    new Error("grok agent is restarting"),
    new Error("grok agent stdio exited (code 1)"),
    new GrokError("Authentication required [-32000] — no auth method id provided", -32000),
  ]) {
    assert.ok(isSessionLifecycleError(error));
    assert.equal(isAccountRotationError(error), false);
    assert.equal(isTransientError(error), false);
  }
});

test("account switch notice includes label and reason", () => {
  const notice = formatAccountSwitchNotice("work@x.ai", new Error(BALANCE_MSG));
  assert.match(notice, /Account switched to work@x\.ai/);
  assert.match(notice, /because of:/i);
  assert.match(notice, /balance exhausted/i);
  assert.match(notice, /Restarting Grok CLI/i);
  assert.match(shortSwitchReason(new Error(BALANCE_MSG)), /balance exhausted/i);
});

test("auto-rotation skips warned accounts and can mark the active account", async () => {
  const marked: Array<{ id: string; reason: string }> = [];
  const accounts = {
    list: () => [
      { id: "active", label: "Active" },
      { id: "warned", label: "Warned", warning: { reason: "quota", markedAt: "2026-01-01T00:00:00Z" } },
      { id: "eligible", label: "Eligible" },
    ],
    activeAccountId: () => "active",
    autoRotateEnabled: () => true,
    markWarning: (id: string, reason: string) => marked.push({ id, reason }),
  } as unknown as AccountManager;
  const rotator = new AccountRotatorImpl(accounts, {} as GrokClient);

  assert.deepEqual(await rotator.targets(), [{ id: "eligible", label: "Eligible" }]);
  await rotator.markFailed(undefined, "balance exhausted");
  await rotator.markFailed("eligible", "quota exceeded");
  assert.deepEqual(marked, [
    { id: "active", reason: "balance exhausted" },
    { id: "eligible", reason: "quota exceeded" },
  ]);
});

test("auto-rotation captures an unmatched host login before warning it", async () => {
  const marked: Array<{ id: string; reason: string }> = [];
  const accounts = {
    activeAccountId: () => undefined,
    captureCurrent: async () => ({ id: "captured", label: "Host login" }),
    markWarning: (id: string, reason: string) => marked.push({ id, reason }),
  } as unknown as AccountManager;
  const rotator = new AccountRotatorImpl(accounts, {} as GrokClient);

  await rotator.markFailed(undefined, "Access denied");
  assert.deepEqual(marked, [{ id: "captured", reason: "Access denied" }]);
});

test("concurrent rotations serialize and a waiting chat observes the selected account", async () => {
  let activeId = "first";
  const starts: boolean[] = [];
  const accounts = {
    activeAccountId: () => activeId,
    get: (id: string) => ({ id, label: id === "second" ? "Working" : "First" }),
    captureCurrent: async () => ({ id: activeId, label: activeId }),
    switchTo: async (id: string) => {
      activeId = id;
      return { id, label: id === "second" ? "Working" : "First" };
    },
  } as unknown as AccountManager;
  const acp = {
    stopAndWait: async () => {},
    start: async (notifyRestarted?: boolean) => {
      starts.push(notifyRestarted === true);
    },
  } as unknown as GrokClient;
  const rotator = new AccountRotatorImpl(accounts, acp);
  const observed = rotator.state();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });

  const owner = rotator.withRotationLock(observed, async (changed) => {
    assert.equal(changed, false);
    await rotator.activate("second");
    await hold;
    return "owner";
  });
  const waiter = rotator.withRotationLock(observed, async (changed) => {
    assert.equal(changed, true);
    return rotator.state().activeLabel;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();

  assert.equal(await owner, "owner");
  assert.equal(await waiter, "Working");
  assert.deepEqual(starts, [true]);
});
