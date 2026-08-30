import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  buildManagerWorkReportPrompt,
  isManagerWorkReportPrompt,
  MANAGER_DIRECTIVE_MARKER,
  MANAGER_WORK_REPORT_MARKER,
  wrapManagerDirective,
} from "../src/render/manager-directive.js";
import { textPrompt } from "../src/app/types.js";
import { extractTelegramActions } from "../src/render/telegram-bridge.js";
import {
  clearManagerJobsForTests,
  listActiveManagerJobs,
  registerManagerJob,
  updateManagerJob,
  bindJobSession,
  getJobBySession,
} from "../src/bot/manager-jobs.js";
import {
  buildManagerContextBlock,
  injectManagerContext,
  MANAGER_CONTEXT_MARKER,
} from "../src/bot/manager-context.js";
import { isGeneralThread, FORUM_GENERAL_THREAD_ID } from "../src/forum/thread.js";
import { stripDirectiveWrappers } from "../src/render/session-comment.js";
import type { SessionStore } from "../src/sessions/store.js";

describe("manager mode helpers", () => {
  beforeEach(() => {
    clearManagerJobsForTests();
  });

  it("detects General thread id", () => {
    assert.equal(isGeneralThread(FORUM_GENERAL_THREAD_ID), true);
    assert.equal(isGeneralThread(1), true);
    // Private chats / missing thread are NOT General manager mode.
    assert.equal(isGeneralThread(undefined), false);
    assert.equal(isGeneralThread(42), false);
  });

  it("wraps manager directive once", () => {
    const once = wrapManagerDirective(textPrompt("fix login in MyApp"));
    assert.ok(once.text.startsWith(MANAGER_DIRECTIVE_MARKER));
    assert.ok(once.text.includes("fix login in MyApp"));
    const twice = wrapManagerDirective(once);
    assert.equal(
      twice.text.split(MANAGER_DIRECTIVE_MARKER).length - 1,
      1,
      "directive should not double-wrap",
    );
  });

  it("builds and detects work report prompts", () => {
    const prompt = buildManagerWorkReportPrompt({
      jobId: "mj_test",
      targetName: "MyApp",
      targetThreadId: 99,
      targetPath: "H:\\App",
      userAskPreview: "fix login",
      dispatchPromptPreview: "Implement login fix",
      status: "done",
      stopReason: "end_turn",
      assistantSummary: "Fixed the login bug and added tests.",
      filesSummary: "2 files",
      childSessionId: "abc12345-session",
    });
    assert.ok(isManagerWorkReportPrompt(prompt));
    assert.ok(prompt.startsWith(MANAGER_WORK_REPORT_MARKER));
    assert.ok(prompt.includes("MyApp"));
    assert.ok(prompt.includes("Fixed the login"));
  });

  it("parses list_topics and list_jobs actions", () => {
    const raw = [
      "```json",
      JSON.stringify({
        telegram: [
          { action: "list_topics" },
          { action: "list_jobs" },
          { action: "search_memory", query: "auth" },
        ],
      }),
      "```",
    ].join("\n");
    const { actions, cleaned } = extractTelegramActions(raw);
    assert.equal(actions.length, 3);
    assert.equal(actions[0]?.action, "list_topics");
    assert.equal(actions[1]?.action, "list_jobs");
    assert.equal(actions[2]?.action, "search_memory");
    assert.ok(!cleaned.includes("list_topics"));
  });

  it("tracks manager jobs and session bind", () => {
    const job = registerManagerJob({
      originChatId: -100,
      originThreadId: 1,
      targetThreadId: 7,
      targetName: "Demo",
      targetPath: "H:\\Demo",
      dispatchPrompt: "do work",
      userAskPreview: "please do work",
    });
    assert.equal(listActiveManagerJobs().length, 1);
    bindJobSession(job.id, "sess-xyz");
    const found = getJobBySession("sess-xyz");
    assert.ok(found);
    assert.equal(found!.status, "running");
    updateManagerJob(job.id, { status: "done", resultSummary: "ok" });
    assert.equal(listActiveManagerJobs().length, 0);
  });

  it("injects manager context idempotently", () => {
    const store = {
      list: () => [],
    } as unknown as SessionStore;
    const block = buildManagerContextBlock({
      userText: "fix MyApp login",
      sessionsDir: ".",
      store,
      jobs: [],
    });
    assert.ok(block.startsWith(MANAGER_CONTEXT_MARKER));
    const once = injectManagerContext("hello", block);
    assert.ok(once.includes("hello"));
    assert.ok(once.includes(MANAGER_CONTEXT_MARKER));
    const twice = injectManagerContext(once, block);
    assert.equal(
      twice.split(MANAGER_CONTEXT_MARKER).length - 1,
      1,
      "context should not double-inject",
    );
  });

  it("strips manager wrappers from card previews", () => {
    const wrapped =
      `${MANAGER_DIRECTIVE_MARKER}\nYou are manager\n\nUser message:\n` +
      `please fix billing`;
    assert.equal(stripDirectiveWrappers(wrapped).includes("please fix billing"), true);
    assert.ok(!stripDirectiveWrappers(wrapped).includes(MANAGER_DIRECTIVE_MARKER));

    const report = `${MANAGER_WORK_REPORT_MARKER}\n{"status":"done"}`;
    assert.equal(stripDirectiveWrappers(report), "");
  });

  it("textPrompt and mergeInputs carry reportBack FIFO", async () => {
    const { textPrompt } = await import("../src/app/types.js");
    const { mergeInputs } = await import("../src/bot/prompt-content.js");
    const rb1 = {
      jobId: "j1",
      originChatId: 1,
      originThreadId: 1,
      userAskPreview: "a",
      targetName: "A",
      targetPath: "H:\\A",
      dispatchPrompt: "do a",
    };
    const rb2 = {
      jobId: "j2",
      originChatId: 1,
      originThreadId: 1,
      userAskPreview: "b",
      targetName: "B",
      targetPath: "H:\\B",
      dispatchPrompt: "do b",
    };
    const p1 = textPrompt("first", undefined, undefined, { reportBack: rb1 });
    const p2 = textPrompt("second", undefined, undefined, { reportBack: rb2 });
    assert.equal(p1.reportBack?.jobId, "j1");
    const merged = mergeInputs([p1, p2]);
    assert.equal(merged.reportBack?.jobId, "j1", "first reportBack wins on merge");
    assert.ok(merged.text.includes("first") && merged.text.includes("second"));
  });

  it("marks superseded staged job cancelled", () => {
    const a = registerManagerJob({
      originChatId: -1,
      originThreadId: 1,
      targetThreadId: 2,
      targetName: "A",
      targetPath: "H:\\A",
      dispatchPrompt: "a",
      userAskPreview: "a",
    });
    updateManagerJob(a.id, {
      status: "cancelled",
      resultSummary: "superseded by a newer manager dispatch before start",
    });
    assert.equal(listActiveManagerJobs().length, 0);
  });

  it("manager context builds and prefers memory-first wording", async () => {
    const { buildManagerContextBlock, MANAGER_CONTEXT_MARKER } = await import(
      "../src/bot/manager-context.js"
    );
    const store = {
      list: () => [
        {
          sessionId: "019fcd6d-e2be-7ba3-8f43-c69f5934ac81",
          cwd: "H:\\Lucru\\Domains",
          title: "General",
          createdAt: "2026-01-01",
          updatedAt: "2026-08-05",
          active: false,
          historyBytes: 0,
        },
        {
          sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          cwd: "H:\\Lucru\\Domains\\MyApp",
          title: "MyApp work",
          createdAt: "2026-01-01",
          updatedAt: "2026-08-05",
          active: false,
          historyBytes: 0,
        },
      ],
    } as unknown as import("../src/sessions/store.js").SessionStore;
    const block = buildManagerContextBlock({
      userText: "last modifications",
      sessionsDir: ".",
      store,
      forum: undefined,
      jobs: [],
    });
    assert.ok(block.includes(MANAGER_CONTEXT_MARKER));
    assert.ok(block.includes("not git") || block.includes("search_memory"));
    assert.ok(
      block.includes("session_id") || block.includes("session="),
      "context should surface session ids for resume dispatch",
    );
  });

  it("resolveSessionRef matches short prefix and prefers topic cwd", async () => {
    const { resolveSessionRef } = await import("../src/bot/telegram-actions.js");
    const metas = [
      {
        sessionId: "019fc9ec-aaaa-bbbb-cccc-111111111111",
        cwd: "H:\\Lucru\\Domains\\WSLG",
        title: "WSLG fix",
        createdAt: "2026-01-01",
        updatedAt: "2026-08-04T10:00:00Z",
        active: false,
        historyBytes: 0,
      },
      {
        sessionId: "019fc9ec-dddd-eeee-ffff-222222222222",
        cwd: "H:\\Other\\Unrelated",
        title: "other",
        createdAt: "2026-01-01",
        updatedAt: "2026-08-05T10:00:00Z",
        active: false,
        historyBytes: 0,
      },
      {
        sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        cwd: "H:\\Lucru\\Domains\\WSLG",
        title: "newer wrong id",
        createdAt: "2026-01-01",
        updatedAt: "2026-08-05T12:00:00Z",
        active: false,
        historyBytes: 0,
      },
    ];
    const store = {
      get: (id: string) => metas.find((m) => m.sessionId === id),
      list: () => metas,
    } as unknown as import("../src/sessions/store.js").SessionStore;

    const short = resolveSessionRef(store, "019fc9ec", "H:\\Lucru\\Domains\\WSLG");
    assert.equal(short.ok, true);
    if (short.ok) {
      assert.equal(short.sessionId, "019fc9ec-aaaa-bbbb-cccc-111111111111");
      assert.ok(short.cwd?.includes("WSLG"));
    }

    const exact = resolveSessionRef(
      store,
      "019fc9ec-aaaa-bbbb-cccc-111111111111",
      "H:\\Lucru\\Domains\\WSLG",
    );
    assert.equal(exact.ok, true);
    if (exact.ok) {
      assert.equal(exact.sessionId, "019fc9ec-aaaa-bbbb-cccc-111111111111");
    }

    const missing = resolveSessionRef(store, "deadbeef", "H:\\Lucru\\Domains\\WSLG");
    assert.equal(missing.ok, false);

    const sessPrefix = resolveSessionRef(store, "#sess_019fc9ec", "H:\\Lucru\\Domains\\WSLG");
    assert.equal(sessPrefix.ok, true);
  });

  it("manager directive requires session_id for related-session follow-ups", async () => {
    const { MANAGER_DIRECTIVE } = await import("../src/render/manager-directive.js");
    assert.ok(MANAGER_DIRECTIVE.includes("session_id"));
    assert.ok(
      MANAGER_DIRECTIVE.includes("RESUME") || MANAGER_DIRECTIVE.includes("related session"),
    );
  });

  it("manager directive requires quiet notify for user-facing chat", async () => {
    const { MANAGER_DIRECTIVE } = await import("../src/render/manager-directive.js");
    assert.ok(MANAGER_DIRECTIVE.includes("notify"));
    assert.ok(/quiet by default/i.test(MANAGER_DIRECTIVE));
    assert.ok(/never spam|job tables|sending to/i.test(MANAGER_DIRECTIVE));
  });

  it("pickManagerFallbackText drops tables and dispatch spam", async () => {
    const { pickManagerFallbackText } = await import("../src/bot/session-runtime.js");
    assert.equal(pickManagerFallbackText(""), undefined);
    assert.equal(pickManagerFallbackText("Thinking…"), undefined);
    assert.equal(
      pickManagerFallbackText("Dispatching the ship gate to WindowsStoreListingGenerator."),
      undefined,
    );
    assert.equal(
      pickManagerFallbackText(
        "| Job | Status |\n|---|---|\n| a | Running |\n| b | Queued |",
      ),
      undefined,
    );
    const ok = pickManagerFallbackText(
      "On it — continuing the ship gate in WindowsStoreListingGenerator.",
    );
    assert.ok(ok && ok.includes("ship gate"));
  });

  it("notify action replies to user message when replyToMessageId set", async () => {
    const { executeTelegramActions } = await import("../src/bot/telegram-actions.js");
    let captured: Record<string, unknown> | undefined;
    const results = await executeTelegramActions(
      [{ action: "notify", text: "Short update.", important: true }],
      {
        api: {
          sendMessage: async (_chat: number, text: string, extra: Record<string, unknown>) => {
            captured = { text, ...extra };
            return { message_id: 99 };
          },
        } as unknown as import("grammy").Api,
        cfg: {
          workspace: "H:\\Lucru\\Domains",
          sessionsDir: ".",
          topicAiChatName: "AI Chat",
        } as import("../src/config.js").AppConfig,
        chatId: -100,
        messageThreadId: 1,
        replyToMessageId: 42,
        forum: undefined,
        store: { list: () => [], get: () => undefined } as unknown as import("../src/sessions/store.js").SessionStore,
        bots: {} as import("../src/bot/telegram-bots.js").TelegramBotService,
        managerMode: true,
      },
    );
    assert.equal(results[0]?.ok, true, results[0]?.error);
    assert.equal(captured?.text, "Short update.");
    assert.equal(captured?.disable_notification, false);
    // General: no message_thread_id=1
    assert.equal(captured?.message_thread_id, undefined);
    assert.deepEqual(captured?.reply_parameters, {
      message_id: 42,
      allow_sending_without_reply: true,
    });
    assert.equal((results[0]?.data as { messageId?: number })?.messageId, 99);
  });

  it("send_prompt passes sessionId into submitTopicPrompt (not foreground-only)", async () => {
    const { executeTelegramActions } = await import("../src/bot/telegram-actions.js");
    const calls: Array<Record<string, unknown>> = [];
    const metas = [
      {
        sessionId: "019fc9ec-aaaa-bbbb-cccc-111111111111",
        cwd: "H:\\Lucru\\Domains\\WSLG",
        title: "WSLG",
        createdAt: "2026-01-01",
        updatedAt: "2026-08-05",
        active: false,
        historyBytes: 0,
      },
    ];
    const store = {
      get: (id: string) => metas.find((m) => m.sessionId === id),
      list: () => metas,
    } as unknown as import("../src/sessions/store.js").SessionStore;

    const binding = {
      threadId: 42,
      name: "WSLG",
      kind: "project" as const,
      projectPath: "H:\\Lucru\\Domains\\WSLG",
    };
    const forum = {
      isReady: true,
      groupId: -100,
      store: {
        get: (id: number) => (id === 42 ? binding : undefined),
        all: () => [binding],
        bindProject: () => binding,
      },
      resolveTopicByName: (name: string) =>
        name.toLowerCase() === "wslg" ? binding : undefined,
    } as unknown as import("../src/forum/manager.js").ForumManager;

    const results = await executeTelegramActions(
      [
        {
          action: "send_prompt",
          topic: "WSLG",
          sessionId: "019fc9ec",
          prompt: "follow up on the related session",
        },
      ],
      {
        api: {
          sendMessage: async () => ({ message_id: 1 }),
        } as unknown as import("grammy").Api,
        cfg: {
          workspace: "H:\\Lucru\\Domains",
          sessionsDir: ".",
          topicAiChatName: "AI Chat",
        } as import("../src/config.js").AppConfig,
        chatId: -100,
        messageThreadId: 1,
        forum,
        store,
        bots: {} as import("../src/bot/telegram-bots.js").TelegramBotService,
        managerMode: true,
        managerUserAskPreview: "send follow up there",
        submitTopicPrompt: async (opts) => {
          calls.push(opts as unknown as Record<string, unknown>);
          return { outcome: "ran" as const, sessionId: opts.sessionId };
        },
      },
    );

    assert.equal(results[0]?.ok, true, results[0]?.error);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.sessionId, "019fc9ec-aaaa-bbbb-cccc-111111111111");
    assert.equal(calls[0]!.threadId, 42);
    assert.equal(calls[0]!.newSession, false);
    assert.ok(String(calls[0]!.prompt).includes("follow up"));
  });

  it("send_prompt recovers topic from session_id when topic is placeholder …", async () => {
    const { executeTelegramActions, isPlaceholderTopicRef, resolveTopicFromPath } = await import(
      "../src/bot/telegram-actions.js"
    );
    assert.equal(isPlaceholderTopicRef("…"), true);
    assert.equal(isPlaceholderTopicRef("..."), true);
    assert.equal(isPlaceholderTopicRef("WSLG"), false);

    const binding = {
      threadId: 42,
      name: "WSLG",
      kind: "project" as const,
      projectPath: "H:\\Lucru\\Domains\\WSLG",
    };
    const forum = {
      isReady: true,
      groupId: -100,
      store: {
        get: (id: number) => (id === 42 ? binding : undefined),
        all: () => [binding],
        bindProject: () => binding,
        findAiChat: () => undefined,
      },
    } as unknown as import("../src/forum/manager.js").ForumManager;

    assert.equal(
      resolveTopicFromPath(forum, "H:\\Lucru\\Domains\\WSLG")?.threadId,
      42,
    );

    const metas = [
      {
        sessionId: "019fc9ec-aaaa-bbbb-cccc-111111111111",
        cwd: "H:\\Lucru\\Domains\\WSLG",
        title: "WSLG",
        createdAt: "2026-01-01",
        updatedAt: "2026-08-05",
        active: false,
        historyBytes: 0,
      },
    ];
    const store = {
      get: (id: string) => metas.find((m) => m.sessionId === id),
      list: () => metas,
    } as unknown as import("../src/sessions/store.js").SessionStore;

    const calls: Array<Record<string, unknown>> = [];
    const results = await executeTelegramActions(
      [
        {
          action: "send_prompt",
          topic: "…",
          sessionId: "019fc9ec",
          prompt: "continue related work",
        },
      ],
      {
        api: {
          sendMessage: async () => ({ message_id: 1 }),
        } as unknown as import("grammy").Api,
        cfg: {
          workspace: "H:\\Lucru\\Domains",
          sessionsDir: ".",
          topicAiChatName: "AI Chat",
        } as import("../src/config.js").AppConfig,
        chatId: -100,
        messageThreadId: 1,
        forum,
        store,
        bots: {} as import("../src/bot/telegram-bots.js").TelegramBotService,
        managerMode: true,
        submitTopicPrompt: async (opts) => {
          calls.push(opts as unknown as Record<string, unknown>);
          return { outcome: "ran" as const, sessionId: opts.sessionId };
        },
      },
    );

    assert.equal(results[0]?.ok, true, results[0]?.error);
    assert.equal(calls[0]!.threadId, 42);
    assert.equal(calls[0]!.sessionId, "019fc9ec-aaaa-bbbb-cccc-111111111111");
  });

  it("resolveTopicRef fuzzy-matches unique prefix and rejects placeholders", async () => {
    const { resolveTopicRef } = await import("../src/bot/telegram-actions.js");
    const binding = {
      threadId: 7,
      name: "WindowsStoreListingGenerator",
      kind: "project" as const,
      projectPath: "H:\\Lucru\\Domains\\WindowsStoreListingGenerator",
    };
    const forum = {
      store: {
        get: (id: number) => (id === 7 ? binding : undefined),
        all: () => [binding],
        bindProject: () => binding,
        findAiChat: () => undefined,
      },
    } as unknown as import("../src/forum/manager.js").ForumManager;
    const cfg = {
      workspace: "H:\\Lucru\\Domains",
      topicAiChatName: "AI Chat",
    } as import("../src/config.js").AppConfig;

    const fuzzy = resolveTopicRef(forum, "WindowsStore", cfg);
    assert.equal(fuzzy.ok, true);
    if (fuzzy.ok) assert.equal(fuzzy.binding.threadId, 7);

    const bad = resolveTopicRef(forum, "…", cfg);
    assert.equal(bad.ok, false);
  });

  it("send_prompt with topic … and no session_id infers topic from memory/ask", async () => {
    const { executeTelegramActions } = await import("../src/bot/telegram-actions.js");
    const binding = {
      threadId: 42,
      name: "WSLG",
      kind: "project" as const,
      projectPath: "H:\\Lucru\\Domains\\WSLG",
    };
    const forum = {
      isReady: true,
      groupId: -100,
      store: {
        get: (id: number) => (id === 42 ? binding : undefined),
        all: () => [binding],
        bindProject: () => binding,
        findAiChat: () => undefined,
      },
    } as unknown as import("../src/forum/manager.js").ForumManager;

    const metas = [
      {
        sessionId: "019fc9ec-aaaa-bbbb-cccc-111111111111",
        cwd: "H:\\Lucru\\Domains\\WSLG",
        title: "WSLG display fix",
        createdAt: "2026-01-01",
        updatedAt: "2026-08-05T12:00:00Z",
        active: false,
        historyBytes: 100,
      },
    ];
    const store = {
      get: (id: string) => metas.find((m) => m.sessionId === id),
      list: () => metas,
    } as unknown as import("../src/sessions/store.js").SessionStore;

    const calls: Array<Record<string, unknown>> = [];
    const results = await executeTelegramActions(
      [
        {
          action: "send_prompt",
          topic: "…",
          prompt: "please continue the WSLG display fix follow-up",
        },
      ],
      {
        api: {
          sendMessage: async () => ({ message_id: 1 }),
        } as unknown as import("grammy").Api,
        cfg: {
          workspace: "H:\\Lucru\\Domains",
          sessionsDir: ".",
          topicAiChatName: "AI Chat",
        } as import("../src/config.js").AppConfig,
        chatId: -100,
        messageThreadId: 1,
        forum,
        store,
        bots: {} as import("../src/bot/telegram-bots.js").TelegramBotService,
        managerMode: true,
        managerUserAskPreview: "send follow up on WSLG related session",
        submitTopicPrompt: async (opts) => {
          calls.push(opts as unknown as Record<string, unknown>);
          return { outcome: "ran" as const, sessionId: opts.sessionId };
        },
      },
    );

    assert.equal(results[0]?.ok, true, results[0]?.error);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.threadId, 42);
    // Should prefer the related session when inferred from memory.
    assert.equal(calls[0]!.sessionId, "019fc9ec-aaaa-bbbb-cccc-111111111111");
    assert.equal((results[0]?.data as { inferredFromMemory?: boolean })?.inferredFromMemory, true);
  });
});
