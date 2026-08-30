/**
 * Forum interactive routing: typed answers and wait notices must stay in-topic.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  forumThreadId,
  interactiveWaitKey,
  outboundThreadExtra,
} from "../src/forum/thread.js";

test("interactiveWaitKey scopes forum topics separately in the same group", () => {
  const group = -1003946158318;
  assert.notEqual(interactiveWaitKey(group, 5902), interactiveWaitKey(group, 17));
  assert.notEqual(interactiveWaitKey(group, 5902), interactiveWaitKey(group, 1));
  assert.equal(interactiveWaitKey(group, undefined), `${group}:0`);
  assert.equal(interactiveWaitKey(group, 1), `${group}:1`);
});

test("outboundThreadExtra omits General (1) but keeps project topics", () => {
  assert.deepEqual(outboundThreadExtra(1), {});
  assert.deepEqual(outboundThreadExtra(undefined), {});
  assert.deepEqual(outboundThreadExtra(5902), { message_thread_id: 5902 });
});

test("forumThreadId normalizes missing inbound thread to General", () => {
  assert.equal(forumThreadId(undefined), 1);
  assert.equal(forumThreadId(1), 1);
  assert.equal(forumThreadId(5902), 5902);
});
