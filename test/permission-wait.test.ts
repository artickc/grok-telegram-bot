import { strict as assert } from "node:assert";
import { test } from "node:test";
import { permissionWaitDetail } from "../src/bot/permission-service.js";
import type { RequestPermissionParams } from "../src/grok/types.js";

test("permissionWaitDetail prefers command", () => {
  const p = {
    sessionId: "abc",
    options: [],
    toolCall: {
      kind: "execute",
      title: "Run command",
      rawInput: { command: "ssh amo uptime" },
    },
  } as RequestPermissionParams;
  assert.equal(permissionWaitDetail(p), "Run command: ssh amo uptime");
});

test("permissionWaitDetail falls back to title", () => {
  const p = {
    sessionId: "abc",
    options: [],
    toolCall: { kind: "execute", title: "Shell" },
  } as RequestPermissionParams;
  assert.equal(permissionWaitDetail(p), "Shell");
});
