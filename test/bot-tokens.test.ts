import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseBotTokens } from "../src/app/bot-tokens.js";
import { SettingsStore } from "../src/app/settings-store.js";
import { TaskStore } from "../src/tasks/store.js";

test("parseBotTokens keeps TELEGRAM_BOT_TOKEN as primary", () => {
  const bots = parseBotTokens({
    TELEGRAM_BOT_TOKEN: "111:aaa",
    TELEGRAM_BOT_TOKEN_APP: "222:bbb",
    TELEGRAM_BOT_TOKEN_CONTENT: "333:ccc",
  });
  assert.equal(bots.length, 3);
  assert.deepEqual(
    bots.map((b) => ({ label: b.label, primary: b.primary, envKey: b.envKey })),
    [
      { label: "default", primary: true, envKey: "TELEGRAM_BOT_TOKEN" },
      { label: "app", primary: false, envKey: "TELEGRAM_BOT_TOKEN_APP" },
      { label: "content", primary: false, envKey: "TELEGRAM_BOT_TOKEN_CONTENT" },
    ],
  );
});

test("parseBotTokens uses labeled keys when TELEGRAM_BOT_TOKEN is absent", () => {
  const bots = parseBotTokens({
    TELEGRAM_BOT_TOKEN_CONTENT: "333:ccc",
    TELEGRAM_BOT_TOKEN_APP: "222:bbb",
  });
  assert.equal(bots[0]?.label, "app");
  assert.equal(bots[0]?.primary, true);
  assert.equal(bots[1]?.label, "content");
  assert.equal(bots[1]?.primary, false);
});

test("parseBotTokens ignores empty values and dedupes the same token", () => {
  const bots = parseBotTokens({
    TELEGRAM_BOT_TOKEN: "111:aaa",
    TELEGRAM_BOT_TOKEN_APP: "111:aaa",
    TELEGRAM_BOT_TOKEN_CONTENT: "",
  });
  assert.equal(bots.length, 1);
  assert.equal(bots[0]?.envKey, "TELEGRAM_BOT_TOKEN");
});

test("parseBotTokens throws when nothing is set", () => {
  assert.throws(() => parseBotTokens({}), /No Telegram bot token/);
});

test("SettingsStore namespaces isolate the same chat id", () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-tg-settings-"));
  try {
    const primary = new SettingsStore(dir);
    const extra = new SettingsStore(dir, "99");
    primary.update(1, { projectName: "app-repo", sessionId: "sess-a" });
    extra.update(1, { projectName: "content-repo", sessionId: "sess-c" });
    assert.equal(primary.get(1).projectName, "app-repo");
    assert.equal(extra.get(1).projectName, "content-repo");
    assert.deepEqual(primary.chatIds(), [1]);
    assert.deepEqual(extra.chatIds(), [1]);
    assert.equal(primary.hasSession("sess-a"), true);
    assert.equal(primary.hasSession("sess-c"), false);
    assert.equal(extra.hasSession("sess-c"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TaskStore.forChat hides the other bot's tasks for the same chat", () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-tg-tasks-"));
  mkdirSync(dir, { recursive: true });
  try {
    const store = new TaskStore(dir);
    store.create({
      chatId: 1,
      name: "primary",
      prompt: "p",
      projectPath: "/a",
      schedule: { type: "once", at: "2099-01-01T00:00:00" },
    });
    store.create({
      chatId: 1,
      botId: 99,
      name: "content",
      prompt: "c",
      projectPath: "/c",
      schedule: { type: "once", at: "2099-01-01T00:00:00" },
    });
    assert.deepEqual(
      store.forChat(1).map((t) => t.name),
      ["primary"],
    );
    assert.deepEqual(
      store.forChat(1, 99).map((t) => t.name),
      ["content"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
