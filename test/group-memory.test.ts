import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  scoreTokens,
  searchGroupMemory,
  tokenizeQuery,
} from "../src/bot/group-memory.js";
import type { SessionStore } from "../src/sessions/store.js";
import type { SessionMeta } from "../src/sessions/types.js";
import type { ForumTopicBinding } from "../src/forum/types.js";

function fakeStore(metas: SessionMeta[]): SessionStore {
  return {
    available: () => true,
    list: () => metas,
    listActive: () => metas.filter((m) => m.active),
    get: (id) => metas.find((m) => m.sessionId === id),
    jsonlPath: (id) => `/tmp/${id}.jsonl`,
  } as unknown as SessionStore;
}

describe("tokenizeQuery / scoreTokens", () => {
  it("tokenizes and scores matches", () => {
    const tokens = tokenizeQuery("password reset rate-limit");
    assert.ok(tokens.includes("password"));
    assert.ok(tokens.includes("reset"));
    const score = scoreTokens("Implemented password reset with rate limit", tokens);
    assert.ok(score > 0);
    assert.equal(scoreTokens("unrelated text", tokens), 0);
  });
});

describe("searchGroupMemory", () => {
  it("ranks topic and session hits", () => {
    const topics: ForumTopicBinding[] = [
      {
        threadId: 10,
        name: "Auth Service",
        kind: "project",
        projectPath: "H:\\Lucru\\Domains\\auth-service",
        updatedAt: Date.now(),
      },
      {
        threadId: 11,
        name: "Unrelated",
        kind: "project",
        projectPath: "H:\\other",
        updatedAt: Date.now(),
      },
    ];
    const metas: SessionMeta[] = [
      {
        sessionId: "aaa",
        cwd: "H:\\Lucru\\Domains\\auth-service",
        title: "password reset flow",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        active: false,
        historyBytes: 0,
        comment: "working on reset email",
      },
    ];
    const hits = searchGroupMemory({
      query: "password reset auth",
      limit: 5,
      sessionsDir: "/tmp",
      store: fakeStore(metas),
      topics,
    });
    assert.ok(hits.length >= 1);
    assert.ok(hits.some((h) => h.kind === "topic" && h.threadId === 10));
    assert.ok(hits.some((h) => h.kind === "session" && h.sessionId === "aaa"));
  });

  it("returns empty for empty query tokens", () => {
    const hits = searchGroupMemory({
      query: "a",
      store: fakeStore([]),
      sessionsDir: "/tmp",
    });
    assert.deepEqual(hits, []);
  });
});
