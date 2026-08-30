/**
 * Trust/auto-approve must never leave the bot stuck on Allow/Deny when
 * GROK_TRUST_ALL_TOOLS or AUTO_APPROVE_PERMISSIONS say so (including defaults).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { envFlagOn, PermissionService } from "../src/bot/permission-service.js";
import type { RuntimeRegistry } from "../src/bot/registry.js";

test("envFlagOn defaults and parses", () => {
  assert.equal(envFlagOn(undefined, true), true);
  assert.equal(envFlagOn("", true), true);
  assert.equal(envFlagOn("  ", false), false);
  assert.equal(envFlagOn("true", false), true);
  assert.equal(envFlagOn("YES", false), true);
  assert.equal(envFlagOn("false", true), false);
  assert.equal(envFlagOn("0", true), false);
});

test("stale autoApprove=false still auto-approves when env trust is on", async () => {
  const prevTrust = process.env.GROK_TRUST_ALL_TOOLS;
  const prevAuto = process.env.AUTO_APPROVE_PERMISSIONS;
  process.env.GROK_TRUST_ALL_TOOLS = "true";
  process.env.AUTO_APPROVE_PERMISSIONS = "false";
  let sent = 0;
  try {
    const api = {
      sendMessage: async () => {
        sent++;
        return { message_id: 1 };
      },
      pinChatMessage: async () => {},
      unpinChatMessage: async () => {},
      editMessageText: async () => {},
    } as never;
    const registry = {
      describeSession: () => ({
        chatId: 1,
        controlled: true,
        subagent: false,
        projectName: "t",
      }),
      get: () => undefined,
      runtimeForSession: () => undefined,
      busyRuntimesForChat: () => [],
    } as unknown as RuntimeRegistry;

    // Constructor says interactive, but live env trust must win.
    const perms = new PermissionService(api, registry, false);
    const out = await perms.handle({
      sessionId: "sess-trust",
      options: [
        { optionId: "allow-session", name: "Allow for this session", kind: "allow_always" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      toolCall: { toolCallId: "t1", title: "ssh amo", kind: "execute" },
    } as never);

    assert.equal(sent, 0, "must not send Allow/Deny when trust env is on");
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
    const api = {
      sendMessage: async () => {
        sent++;
        return { message_id: 99 };
      },
      pinChatMessage: async () => {},
      unpinChatMessage: async () => {},
      editMessageText: async () => {},
    } as never;
    const registry = {
      describeSession: () => ({
        chatId: 1,
        controlled: true,
        subagent: false,
        projectName: "t",
      }),
      get: () => undefined,
      runtimeForSession: () => undefined,
      busyRuntimesForChat: () => [],
    } as unknown as RuntimeRegistry;

    const perms = new PermissionService(api, registry, false);
    const pending = perms.handle({
      sessionId: "sess-ask",
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      toolCall: { toolCallId: "t2", title: "ssh", kind: "execute" },
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
