import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isAllowed } from "../src/bot/auth.js";
import type { AppConfig } from "../src/config.js";

function cfg(ids: string[]): Pick<AppConfig, "allowedUsers" | "topicGroupId"> {
  return { allowedUsers: new Set(ids), topicGroupId: undefined };
}

test("isAllowed: empty set allows everyone", () => {
  assert.equal(isAllowed(cfg([]) as AppConfig, 1, true), true);
  assert.equal(isAllowed(cfg([]) as AppConfig, "999", true), true);
});

test("isAllowed: comma-configured ids match string or number", () => {
  const c = cfg(["111", "222"]) as AppConfig;
  assert.equal(isAllowed(c, 111), true);
  assert.equal(isAllowed(c, "222"), true);
  assert.equal(isAllowed(c, 333), false);
  assert.equal(isAllowed(c, "333"), false);
});
