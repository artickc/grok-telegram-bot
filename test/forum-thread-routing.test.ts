/**
 * Forum interactive routing: typed answers and wait notices must stay in-topic.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AskUserService } from "../src/bot/ask-user-service.js";
import type { RuntimeRegistry } from "../src/bot/registry.js";
import {
  forumThreadId,
  interactiveWaitKey,
  outboundThreadExtra,
} from "../src/forum/thread.js";

const GROUP = -1003946158318;

test("interactiveWaitKey scopes forum topics separately in the same group", () => {
  assert.notEqual(interactiveWaitKey(GROUP, 5902), interactiveWaitKey(GROUP, 17));
  assert.notEqual(interactiveWaitKey(GROUP, 5902), interactiveWaitKey(GROUP, 1));
  assert.equal(interactiveWaitKey(GROUP, undefined), `${GROUP}:0`);
  assert.equal(interactiveWaitKey(GROUP, 1), `${GROUP}:1`);
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

test("ask_user typed answers do not cross forum topics in the same group", async () => {
  const noticed: number[] = [];
  const api = {
    sendMessage: async (_chat: number, _text: string, extra?: { message_thread_id?: number }) => {
      assert.equal(extra?.message_thread_id, 5902, "question must post in owning topic");
      return { message_id: 42 };
    },
    editMessageText: async () => {},
  } as never;

  const registry = {
    describeSession: () => ({
      chatId: GROUP,
      threadId: 5902,
      controlled: true,
      subagent: false,
      projectName: "amo.watch",
    }),
    busyRuntimesForChat: (chatId: number, preferThreadId?: number) => {
      assert.equal(chatId, GROUP);
      // Exclusive prefer: only the matching topic (simulates fixed registry).
      if (preferThreadId !== undefined && preferThreadId !== 5902) return [];
      noticed.push(preferThreadId ?? -1);
      return [
        {
          noticePermissionWait: () => {},
        },
      ];
    },
  } as unknown as RuntimeRegistry;

  const ask = new AskUserService(api, registry, false);
  const pending = ask.handle({
    sessionId: "sess-amo",
    questions: [
      {
        question: "Ship now?",
        header: "Ship now?",
        options: [
          { label: "Yes", description: "y" },
          { label: "No", description: "n" },
        ],
      },
    ],
  });

  // Let sendMessage + pending register.
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(noticed, [5902], "wait notice only for owning thread");

  // Enter free-text mode via Type answer…
  const toast = ask.tap("1", "type");
  assert.ok(toast);

  // Typing in a DIFFERENT topic must not be consumed.
  assert.equal(ask.takeText(GROUP, "stolen from other topic", 17), false);
  // Private-style undefined thread must not steal either.
  assert.equal(ask.takeText(GROUP, "also wrong", undefined), false);

  // Owning topic consumes the answer.
  assert.equal(ask.takeText(GROUP, "my answer", 5902), true);

  ask.cancelForSession("sess-amo");
  await pending.catch(() => {});
});
