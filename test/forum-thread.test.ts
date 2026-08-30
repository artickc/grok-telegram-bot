import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  batchKey,
  FORUM_GENERAL_THREAD_ID,
  forumThreadId,
  outboundMessageThreadId,
  outboundThreadExtra,
} from "../src/forum/thread.js";

test("forumThreadId defaults to General (1)", () => {
  assert.equal(forumThreadId(undefined), FORUM_GENERAL_THREAD_ID);
  assert.equal(forumThreadId(42), 42);
});

test("batchKey is consistent for forum General vs private chat", () => {
  assert.equal(batchKey(-1001, undefined, true), "-1001:1");
  assert.equal(batchKey(-1001, 1, true), "-1001:1");
  assert.equal(batchKey(-1001, 99, true), "-1001:99");
  // Private / non-forum: no thread → 0
  assert.equal(batchKey(12345, undefined, false), "12345:0");
});

test("outboundMessageThreadId omits General (1) so Bot API does not reject", () => {
  assert.equal(outboundMessageThreadId(undefined), undefined);
  assert.equal(outboundMessageThreadId(FORUM_GENERAL_THREAD_ID), undefined);
  assert.equal(outboundMessageThreadId(1), undefined);
  assert.equal(outboundMessageThreadId(17), 17);
  assert.deepEqual(outboundThreadExtra(1), {});
  assert.deepEqual(outboundThreadExtra(17), { message_thread_id: 17 });
});
