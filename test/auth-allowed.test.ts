import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isAllowed } from "../src/bot/auth.js";
import { parseAllowedUsers, type AppConfig } from "../src/config.js";

function cfg(partial: {
  allowedUsers: Set<string>;
  allowAllUsers: boolean;
}): AppConfig {
  return partial as AppConfig;
}

test("isAllowed: allowAllUsers opens everyone", () => {
  assert.equal(isAllowed(cfg({ allowedUsers: new Set(), allowAllUsers: true }), 1), true);
  assert.equal(isAllowed(cfg({ allowedUsers: new Set(), allowAllUsers: true }), "999"), true);
});

test("isAllowed: listed ids match string or number", () => {
  const c = cfg({ allowedUsers: new Set(["111", "222"]), allowAllUsers: false });
  assert.equal(isAllowed(c, 111), true);
  assert.equal(isAllowed(c, "222"), true);
  assert.equal(isAllowed(c, 333), false);
});

test("isAllowed: fail closed when allowAll false and empty set", () => {
  const c = cfg({ allowedUsers: new Set(), allowAllUsers: false });
  assert.equal(isAllowed(c, 111), false);
});

test("parseAllowedUsers: blank opens", () => {
  assert.equal(parseAllowedUsers(undefined).allowAll, true);
  assert.equal(parseAllowedUsers("").allowAll, true);
  assert.equal(parseAllowedUsers("  ").allowAll, true);
});

test("parseAllowedUsers: comma-separated multi ids", () => {
  const p = parseAllowedUsers("111, 222 ,333");
  assert.equal(p.allowAll, false);
  assert.deepEqual([...p.ids].sort(), ["111", "222", "333"]);
  assert.equal(p.dropped.length, 0);
});

test("parseAllowedUsers: strips quotes and drops non-numeric", () => {
  const p = parseAllowedUsers(`"111", not-an-id, '222'`);
  assert.equal(p.allowAll, false);
  assert.ok(p.ids.has("111"));
  assert.ok(p.ids.has("222"));
  assert.ok(p.dropped.includes("not-an-id"));
});

test("parseAllowedUsers: only junk fails closed (not open)", () => {
  const p = parseAllowedUsers("foo, bar");
  assert.equal(p.allowAll, false);
  assert.equal(p.ids.size, 0);
});
