/**
 * Trust/auto-approve must never leave the bot stuck on Allow/Deny when
 * GROK_TRUST_ALL_TOOLS or AUTO_APPROVE_PERMISSIONS say so (including defaults).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  autoDecideSession,
  envFlagOn,
  PermissionService,
} from "../src/bot/permission-service.js";
import type { RuntimeRegistry } from "../src/bot/registry.js";

function mockApi(onSend?: () => void) {
  return {
    sendMessage: async () => {
      onSend?.();
      return { message_id: 1 };
    },
    pinChatMessage: async () => {},
    unpinChatMessage: async () => {},
    editMessageText: async () => {},
  } as never;
}

/** Pass `null` for orphan/unattended (no chatId). Do not pass `undefined` — that
 *  would hit a default param and look like chat 1. */
function mockRegistry(chatId: number | null = 1): RuntimeRegistry {
  return {
    describeSession: () => ({
      chatId: chatId === null ? undefined : chatId,
      controlled: true,
      subagent: false,
      projectName: "t",
    }),
    get: () => undefined,
    runtimeForSession: () => undefined,
    busyRuntimesForChat: () => [],
  } as unknown as RuntimeRegistry;
}

const allowOnceDeny = [
  { optionId: "allow-once", name: "Allow", kind: "allow_once" },
  { optionId: "allow-session", name: "Allow for this session", kind: "allow_always" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
] as const;

test("envFlagOn defaults and parses", () => {
  assert.equal(envFlagOn(undefined, true), true);
  assert.equal(envFlagOn("", true), true);
  assert.equal(envFlagOn("  ", false), false);
  assert.equal(envFlagOn("true", false), true);
  assert.equal(envFlagOn("YES", false), true);
  assert.equal(envFlagOn("on", false), true);
  assert.equal(envFlagOn("1", false), true);
  assert.equal(envFlagOn("false", true), false);
  assert.equal(envFlagOn("0", true), false);
});

test("autoDecideSession prefers session/always over allow-once", () => {
  const out = autoDecideSession({
    sessionId: "s",
    options: [...allowOnceDeny],
    toolCall: { toolCallId: "t", title: "ssh", kind: "execute" },
  } as never);
  assert.deepEqual(out, {
    outcome: { outcome: "selected", optionId: "allow-session" },
  });
});

test("stale autoApprove=false still auto-approves when env trust is on", async () => {
  const prevTrust = process.env.GROK_TRUST_ALL_TOOLS;
  const prevAuto = process.env.AUTO_APPROVE_PERMISSIONS;
  process.env.GROK_TRUST_ALL_TOOLS = "true";
  process.env.AUTO_APPROVE_PERMISSIONS = "false";
  let sent = 0;
  try {
    const perms = new PermissionService(mockApi(() => sent++), mockRegistry(), false);
    const out = await perms.handle({
      sessionId: "sess-trust",
      options: [...allowOnceDeny],
      toolCall: { toolCallId: "t1", title: "ssh amo", kind: "execute" },
    } as never);

    assert.equal(sent, 0, "must not send Allow/Deny when trust env is on");
    assert.deepEqual(out, {
      outcome: { outcome: "selected", optionId: "allow-session" },
    });
  } finally {
    if (prevTrust === undefined) delete process.env.GROK_TRUST_ALL_TOOLS;
    else process.env.GROK_TRUST_ALL_TOOLS = prevTrust;
    if (prevAuto === undefined) delete process.env.AUTO_APPROVE_PERMISSIONS;
    else process.env.AUTO_APPROVE_PERMISSIONS = prevAuto;
  }
});

test("auto-approve=true and trust=false still auto-approves (OR rule)", async () => {
  const prevTrust = process.env.GROK_TRUST_ALL_TOOLS;
  const prevAuto = process.env.AUTO_APPROVE_PERMISSIONS;
  process.env.GROK_TRUST_ALL_TOOLS = "false";
  process.env.AUTO_APPROVE_PERMISSIONS = "true";
  let sent = 0;
  try {
    const perms = new PermissionService(mockApi(() => sent++), mockRegistry(), false);
    const out = await perms.handle({
      sessionId: "sess-auto",
      options: [...allowOnceDeny],
      toolCall: { toolCallId: "t2", title: "shell", kind: "execute" },
    } as never);
    assert.equal(sent, 0);
    assert.equal((out as { outcome: { optionId: string } }).outcome.optionId, "allow-session");
  } finally {
    if (prevTrust === undefined) delete process.env.GROK_TRUST_ALL_TOOLS;
    else process.env.GROK_TRUST_ALL_TOOLS = prevTrust;
    if (prevAuto === undefined) delete process.env.AUTO_APPROVE_PERMISSIONS;
    else process.env.AUTO_APPROVE_PERMISSIONS = prevAuto;
  }
});

test("both trust and auto unset defaults to auto-approve", async () => {
  const prevTrust = process.env.GROK_TRUST_ALL_TOOLS;
  const prevAuto = process.env.AUTO_APPROVE_PERMISSIONS;
  delete process.env.GROK_TRUST_ALL_TOOLS;
  delete process.env.AUTO_APPROVE_PERMISSIONS;
  let sent = 0;
  try {
    const perms = new PermissionService(mockApi(() => sent++), mockRegistry(), false);
    const out = await perms.handle({
      sessionId: "sess-default",
      options: [...allowOnceDeny],
      toolCall: { toolCallId: "t3", title: "edit", kind: "edit" },
    } as never);
    assert.equal(sent, 0, "defaults must not freeze on Allow/Deny");
    assert.equal((out as { outcome: { outcome: string } }).outcome.outcome, "selected");
  } finally {
    if (prevTrust === undefined) delete process.env.GROK_TRUST_ALL_TOOLS;
    else process.env.GROK_TRUST_ALL_TOOLS = prevTrust;
    if (prevAuto === undefined) delete process.env.AUTO_APPROVE_PERMISSIONS;
    else process.env.AUTO_APPROVE_PERMISSIONS = prevAuto;
  }
});

test("both trust and auto-approve false keeps interactive path", async () => {
  const prevTrust = process.env.GROK_TRUST_ALL_TOOLS;
  const prevAuto = process.env.AUTO_APPROVE_PERMISSIONS;
  process.env.GROK_TRUST_ALL_TOOLS = "false";
  process.env.AUTO_APPROVE_PERMISSIONS = "false";
  let sent = 0;
  try {
    const perms = new PermissionService(mockApi(() => sent++), mockRegistry(), false);
    const pending = perms.handle({
      sessionId: "sess-ask",
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      toolCall: { toolCallId: "t4", title: "ssh", kind: "execute" },
    } as never);

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sent, 1, "interactive mode must prompt");
    perms.cancelForSession("sess-ask");
    await pending;
  } finally {
    if (prevTrust === undefined) delete process.env.GROK_TRUST_ALL_TOOLS;
    else process.env.GROK_TRUST_ALL_TOOLS = prevTrust;
    if (prevAuto === undefined) delete process.env.AUTO_APPROVE_PERMISSIONS;
    else process.env.AUTO_APPROVE_PERMISSIONS = prevAuto;
  }
});

test("orphan session (no chatId) auto-approves even when interactive", async () => {
  const prevTrust = process.env.GROK_TRUST_ALL_TOOLS;
  const prevAuto = process.env.AUTO_APPROVE_PERMISSIONS;
  process.env.GROK_TRUST_ALL_TOOLS = "false";
  process.env.AUTO_APPROVE_PERMISSIONS = "false";
  let sent = 0;
  try {
    const perms = new PermissionService(mockApi(() => sent++), mockRegistry(null), false);
    const out = await perms.handle({
      sessionId: "sess-orphan",
      options: [...allowOnceDeny],
      toolCall: { toolCallId: "t5", title: "ssh", kind: "execute" },
    } as never);
    assert.equal(sent, 0, "unattended must not wait on Telegram");
    assert.deepEqual(out, {
      outcome: { outcome: "selected", optionId: "allow-session" },
    });
  } finally {
    if (prevTrust === undefined) delete process.env.GROK_TRUST_ALL_TOOLS;
    else process.env.GROK_TRUST_ALL_TOOLS = prevTrust;
    if (prevAuto === undefined) delete process.env.AUTO_APPROVE_PERMISSIONS;
    else process.env.AUTO_APPROVE_PERMISSIONS = prevAuto;
  }
});
