/**
 * /stop and /cancel must stay session-scoped: never kill this process, and
 * cancel permissions only for the targeted session.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PermissionService } from "../src/bot/permission-service.js";
import { CANCEL_FORCE_MS } from "../src/grok/client.js";
import { killPid } from "../src/sessions/process.js";
import type { RuntimeRegistry } from "../src/bot/registry.js";

test("killPid refuses to kill this bot process", () => {
  assert.equal(killPid(process.pid), false);
  assert.equal(killPid(0), false);
  assert.equal(killPid(-1), false);
  assert.equal(killPid(1.5 as unknown as number), false);
});

test("CANCEL_FORCE_MS is a short positive grace window", () => {
  assert.ok(CANCEL_FORCE_MS >= 500 && CANCEL_FORCE_MS <= 10_000);
});

test("cancelled stopReason is treated as intentional stop (not empty-response failure)", () => {
  // Mirrors session-runtime runPromptWithRetries: user /stop force-complete or
  // agent session/cancel must not throw "Empty agent response".
  const accept = (opts: { cancelled: boolean; stopReason?: string; updates: number }): boolean =>
    opts.cancelled || opts.stopReason === "cancelled" || opts.updates > 0;
  assert.equal(accept({ cancelled: true, stopReason: "cancelled", updates: 0 }), true);
  assert.equal(accept({ cancelled: false, stopReason: "cancelled", updates: 0 }), true);
  assert.equal(accept({ cancelled: false, stopReason: "end_turn", updates: 0 }), false);
  assert.equal(accept({ cancelled: false, stopReason: "end_turn", updates: 1 }), true);
});

test("PermissionService.cancelForSession only cancels matching session", async () => {
  const api = {
    sendMessage: async () => ({ message_id: 1 }),
    pinChatMessage: async () => {},
    unpinChatMessage: async () => {},
    editMessageText: async () => {},
  } as never;

  // Minimal registry: every session maps to chat 1 so interactive path runs.
  const registry = {
    describeSession: (sessionId: string) => ({
      chatId: 1,
      controlled: true,
      subagent: false,
      projectName: sessionId,
    }),
    get: () => ({ sessionId: "sess-a" }),
    runtimeForSession: () => undefined,
    busyRuntimesForChat: () => [],
  } as unknown as RuntimeRegistry;

  const perms = new PermissionService(api, registry, false /* interactive */);

  const pA = perms.handle({
    sessionId: "sess-a",
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
    toolCall: { toolCallId: "t1", title: "edit", kind: "edit" },
  } as never);

  const pB = perms.handle({
    sessionId: "sess-b",
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
    toolCall: { toolCallId: "t2", title: "read", kind: "read" },
  } as never);

  // Let the async sendMessage path register pending entries.
  await new Promise((r) => setTimeout(r, 20));

  const n = perms.cancelForSession("sess-a");
  assert.equal(n, 1);

  const outA = await pA;
  assert.deepEqual(outA, { outcome: { outcome: "cancelled" } });

  // sess-b still pending — cancel it so the test does not hang on open timers.
  assert.equal(perms.cancelForSession("sess-b"), 1);
  const outB = await pB;
  assert.deepEqual(outB, { outcome: { outcome: "cancelled" } });

  assert.equal(perms.cancelForSession("sess-a"), 0);
});
