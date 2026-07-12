import { strict as assert } from "node:assert";
import { test } from "node:test";
import { pickHeadlessAuthMethod } from "../src/grok/client.js";
import { autoDecideSession } from "../src/bot/permission-service.js";

test("pickHeadlessAuthMethod prefers cached_token and never picks grok.com", () => {
  const methods = [
    { id: "cached_token", name: "cached_token" },
    { id: "grok.com", name: "Grok" },
  ];
  assert.equal(pickHeadlessAuthMethod(methods, false), "cached_token");
  assert.equal(pickHeadlessAuthMethod(methods, true), "cached_token");
});

test("pickHeadlessAuthMethod uses xai.api_key when no cached_token", () => {
  const methods = [
    { id: "xai.api_key", name: "API key" },
    { id: "grok.com", name: "Grok" },
  ];
  assert.equal(pickHeadlessAuthMethod(methods, true), "xai.api_key");
  assert.equal(pickHeadlessAuthMethod(methods, false), undefined);
});

test("pickHeadlessAuthMethod refuses browser-only methods", () => {
  assert.equal(pickHeadlessAuthMethod([{ id: "grok.com", name: "Grok" }], false), undefined);
  assert.equal(pickHeadlessAuthMethod([{ id: "browser", name: "Browser" }], true), undefined);
});

test("autoDecideSession prefers allow-for-this-session over allow-once", () => {
  const outcome = autoDecideSession({
    sessionId: "s1",
    options: [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "session", name: "Allow for this session", kind: "allow_always" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });
  assert.deepEqual(outcome, { outcome: { outcome: "selected", optionId: "session" } });
});

test("autoDecideSession prefers all-sessions when present", () => {
  const outcome = autoDecideSession({
    sessionId: "s1",
    options: [
      { optionId: "session", name: "Allow for Session", kind: "allow_always" },
      { optionId: "all", name: "Always Allow All Sessions", kind: "allow_always" },
    ],
  });
  assert.deepEqual(outcome, { outcome: { outcome: "selected", optionId: "all" } });
});

test("autoDecideSession never picks deny when an allow exists", () => {
  const outcome = autoDecideSession({
    sessionId: "s1",
    options: [
      { optionId: "deny", name: "Reject", kind: "reject_once" },
      { optionId: "yes", name: "Allow", kind: "allow_once" },
    ],
  });
  assert.deepEqual(outcome, { outcome: { outcome: "selected", optionId: "yes" } });
});
