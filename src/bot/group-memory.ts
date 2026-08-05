/**
 * Local "group memory" search across forum topics, session metadata, and
 * recent session history. Telegram bots have no general message-search API,
 * so this indexes what the bridge already stores on disk.
 */
import { join } from "node:path";
import { readHistory } from "../sessions/history.js";
import type { SessionMeta } from "../sessions/types.js";
import type { SessionStore } from "../sessions/store.js";
import type { ForumTopicBinding } from "../forum/types.js";

export type MemoryHitKind = "topic" | "session" | "history";

export interface MemoryHit {
  kind: MemoryHitKind;
  title: string;
  snippet: string;
  score: number;
  path?: string;
  sessionId?: string;
  threadId?: number;
}

export interface GroupMemorySearchOpts {
  query: string;
  limit?: number;
  sessionsDir: string;
  store: SessionStore;
  topics?: ForumTopicBinding[];
  /** Max sessions whose JSONL tails are scanned. */
  maxSessions?: number;
}

/** Tokenize a query into lowercase alphanumeric tokens (min length 2). */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_./\\-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 12);
}

/** Score how well `haystack` matches tokens (0 if no token hits). */
export function scoreTokens(haystack: string, tokens: string[]): number {
  if (!tokens.length || !haystack) return 0;
  const h = haystack.toLowerCase();
  let score = 0;
  let hits = 0;
  for (const t of tokens) {
    if (!h.includes(t)) continue;
    hits++;
    // Prefer whole-word-ish hits slightly.
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeReg(t)}(?:[^a-z0-9]|$)`, "i");
    score += re.test(h) ? 3 : 1;
    // Density bonus for short fields.
    if (h.length < 120) score += 1;
  }
  if (hits === 0) return 0;
  // All-token bonus.
  if (hits === tokens.length) score += 4;
  return score;
}

/**
 * Search topics + session store + recent history. Pure ranking over provided
 * store; safe to call on the main bot thread (capped I/O).
 */
export function searchGroupMemory(opts: GroupMemorySearchOpts): MemoryHit[] {
  const tokens = tokenizeQuery(opts.query);
  if (tokens.length === 0) return [];
  const limit = Math.max(1, Math.min(20, opts.limit ?? 8));
  const maxSessions = opts.maxSessions ?? 40;
  const hits: MemoryHit[] = [];

  for (const t of opts.topics ?? []) {
    const hay = [t.name, t.projectPath ?? "", t.kind, t.sessionId ?? ""].join("\n");
    const score = scoreTokens(hay, tokens);
    if (score <= 0) continue;
    hits.push({
      kind: "topic",
      title: t.name,
      snippet: t.projectPath ? `path: ${t.projectPath}` : `kind: ${t.kind}`,
      score: score + 2, // slight boost for topic map
      path: t.projectPath ?? undefined,
      threadId: t.threadId,
      sessionId: t.sessionId,
    });
  }

  let metas: SessionMeta[] = [];
  try {
    metas = opts.store.list(maxSessions);
  } catch {
    metas = [];
  }

  for (const m of metas) {
    const hay = [m.title, m.comment ?? "", m.cwd, m.sessionId].join("\n");
    const score = scoreTokens(hay, tokens);
    if (score > 0) {
      hits.push({
        kind: "session",
        title: m.title || m.sessionId.slice(0, 8),
        snippet: clamp(
          [m.comment, m.cwd].filter(Boolean).join(" · ") || m.sessionId,
          220,
        ),
        score,
        path: m.cwd || undefined,
        sessionId: m.sessionId,
      });
    }

    // History tail (cheap): few entries, short text.
    if (m.historyBytes <= 0) continue;
    try {
      const path = join(opts.sessionsDir, `${m.sessionId}.jsonl`);
      const entries = readHistory(path, 12);
      for (const e of entries) {
        if (!e.text?.trim()) continue;
        const s = scoreTokens(e.text, tokens);
        if (s <= 0) continue;
        hits.push({
          kind: "history",
          title: `${e.role} · ${(m.title || m.sessionId.slice(0, 8)).slice(0, 40)}`,
          snippet: clamp(e.text.replace(/\s+/g, " ").trim(), 220),
          score: s,
          path: m.cwd || undefined,
          sessionId: m.sessionId,
        });
      }
    } catch {
      /* ignore unreadable logs */
    }
  }

  hits.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind));
  // Dedupe near-identical snippets.
  const seen = new Set<string>();
  const out: MemoryHit[] = [];
  for (const h of hits) {
    const key = `${h.kind}|${h.sessionId ?? h.threadId ?? ""}|${h.snippet.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
