/**
 * Safe callback-query helpers — stale Telegram answers must never crash handlers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { GrammyError } from "grammy";
import { isStaleCallbackError } from "../src/bot/callback.js";

function grammy(code: number, description: string): GrammyError {
  return new GrammyError(
    description,
    {
      ok: false,
      error_code: code,
      description,
    } as never,
    "answerCallbackQuery",
    {},
  );
}

test("isStaleCallbackError detects query-too-old 400", () => {
  const err = grammy(
    400,
    "Bad Request: query is too old and response timeout expired or query ID is invalid",
  );
  assert.equal(isStaleCallbackError(err), true);
});

test("isStaleCallbackError detects invalid query id", () => {
  assert.equal(isStaleCallbackError(grammy(400, "Bad Request: query ID is invalid")), true);
});

test("isStaleCallbackError ignores unrelated 400s", () => {
  assert.equal(isStaleCallbackError(grammy(400, "Bad Request: message is not modified")), false);
});

test("isStaleCallbackError ignores non-Grammy errors", () => {
  assert.equal(isStaleCallbackError(new Error("query is too old")), false);
  assert.equal(isStaleCallbackError(undefined), false);
});
