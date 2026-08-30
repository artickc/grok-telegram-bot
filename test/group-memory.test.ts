import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  queryWantsRecency,
  recencyBoost,
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

  it("prefers newest session for same project on last-modifications queries", () => {
    assert.ok(queryWantsRecency("what was last modifications in vibeproxy"));
    assert.ok(!queryWantsRecency("password reset auth"));
    assert.ok(recencyBoost(Date.now()) >= recencyBoost(Date.now() - 10 * 24 * 3600_000));
    assert.equal(recencyBoost(undefined), 0);
    assert.equal(recencyBoost(""), 0);
    assert.equal(recencyBoost("not-a-date"), 0);

    const now = Date.now();
    const metas: SessionMeta[] = [
      {
        sessionId: "old-sess",
        cwd: "H:\\Lucru\\Domains\\vibeproxy-windows",
        title: "OmniRoute cleanup vibeproxy",
        createdAt: new Date(now - 5 * 24 * 3600_000).toISOString(),
        updatedAt: new Date(now - 4 * 24 * 3600_000).toISOString(),
        active: false,
        historyBytes: 0,
        comment: "Remove OmniRoute from ProviderCatalog and ProvidersViewModel",
      },
      {
        sessionId: "new-sess",
        cwd: "H:\\Lucru\\Domains\\vibeproxy-windows",
        title: "adobe firefly 408 after image generation",
        createdAt: new Date(now - 3600_000).toISOString(),
        updatedAt: new Date(now - 10 * 60_000).toISOString(),
        active: false,
        historyBytes: 0,
        comment: "Fixed Firefly 408 timeout handling after image generation",
      },
    ];
    const hits = searchGroupMemory({
      query: "last modifications in vibeproxy",
      limit: 5,
      sessionsDir: "/tmp",
      store: fakeStore(metas),
      preferPaths: ["H:\\Lucru\\Domains", "H:\\Lucru\\Domains\\vibeproxy-windows"],
    });
    assert.ok(hits.length >= 1);
    const topSession = hits.find((h) => h.kind === "session");
    assert.ok(topSession, "expected a session hit");
    assert.equal(
      topSession!.sessionId,
      "new-sess",
      "newest vibeproxy session must rank above older OmniRoute session",
    );
    assert.ok(
      topSession!.snippet.includes("ago") || topSession!.snippet.includes("Firefly"),
      "snippet should surface age or newest work",
    );
  });

  it("non-recency queries still return relevant hits", () => {
    const now = Date.now();
    const metas: SessionMeta[] = [
      {
        sessionId: "auth-sess",
        cwd: "H:\\Lucru\\Domains\\auth-service",
        title: "password reset flow",
        createdAt: new Date(now - 10 * 24 * 3600_000).toISOString(),
        updatedAt: new Date(now - 9 * 24 * 3600_000).toISOString(),
        active: false,
        historyBytes: 0,
        comment: "implemented password reset email",
      },
    ];
    const hits = searchGroupMemory({
      query: "password reset email",
      limit: 5,
      sessionsDir: "/tmp",
      store: fakeStore(metas),
    });
    assert.ok(hits.some((h) => h.sessionId === "auth-sess"));
  });

  it("missing updatedAt does not crash and still matches", () => {
    const metas: SessionMeta[] = [
      {
        sessionId: "no-date",
        cwd: "H:\\Lucru\\Domains\\foo",
        title: "foo bar feature",
        createdAt: "",
        updatedAt: "",
        active: false,
        historyBytes: 0,
        comment: "foo bar",
      },
    ];
    const hits = searchGroupMemory({
      query: "foo bar",
      limit: 5,
      sessionsDir: "/tmp",
      store: fakeStore(metas),
    });
    assert.ok(hits.some((h) => h.sessionId === "no-date"));
    assert.ok(hits.every((h) => Number.isFinite(h.score)));
  });
});
