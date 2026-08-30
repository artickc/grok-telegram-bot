/**
 * Local "group memory" search across forum topics, session metadata, and
 * recent session history. Telegram bots have no general message-search API,
 * so this indexes what the bridge already stores on disk.
 *
 * Ranking is **relevance + recency**: newer sessions / history win over old
 * matching text so "what was last worked on" does not surface stale Done notes.
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
  /** Epoch ms for secondary sort / display (session or entry time). */
  at?: number;
}

export interface GroupMemorySearchOpts {
  query: string;
  limit?: number;
  sessionsDir: string;
  store: SessionStore;
  topics?: ForumTopicBinding[];
  /** Max sessions whose JSONL tails are scanned. */
  maxSessions?: number;
  /**
   * Prefer sessions under these paths (e.g. workspace for General, then a
   * project path). Earlier paths get a higher score boost.
   */
  preferPaths?: string[];
  /** Boost history from sessions whose title/comment looks like General manager. */
  preferGeneral?: boolean;
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
 * True when the user is asking what happened *recently* (last mods, last work).
 * These queries weight recency much higher than pure text match.
 * Avoid bare "work"/"done" — those appear in many normal asks and would
 * over-prioritize recency over relevance.
 */
export function queryWantsRecency(query: string): boolean {
  return /\b(last|latest|recent|newest|today|yesterday|modif(?:y|ied|ication|ications)?|changes?|changed|updated|what\s+was|what\s+did|last\s+work|recent\s+work|last\s+done)\b/i.test(
    query,
  );
}

/**
 * Normalize epoch seconds vs milliseconds (or ISO string) to ms.
 * Returns undefined when missing/invalid (never NaN).
 */
export function normalizeEpochMs(
  value: string | number | undefined,
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let t: number;
  if (typeof value === "number") {
    t = value;
  } else {
    t = Date.parse(value);
  }
  if (!Number.isFinite(t) || t <= 0) return undefined;
  // Seconds since epoch (~1e9) → ms. ms since epoch is ~1e12+.
  if (t > 0 && t < 1e11) t *= 1000;
  if (!Number.isFinite(t) || t <= 0) return undefined;
  return t;
}

/**
 * Recency score 0–20 from an updatedAt ISO string or epoch ms/seconds.
 * <1h:20, <6h:16, <24h:12, <3d:8, <7d:4, <30d:2, older:0.
 */
export function recencyBoost(updatedAt: string | number | undefined, now = Date.now()): number {
  const t = normalizeEpochMs(updatedAt);
  if (t === undefined) return 0;
  const ageH = Math.max(0, (now - t) / 3_600_000);
  if (ageH < 1) return 20;
  if (ageH < 6) return 16;
  if (ageH < 24) return 12;
  if (ageH < 72) return 8;
  if (ageH < 168) return 4;
  if (ageH < 720) return 2;
  return 0;
}

/** Human-ish age for snippets. */
export function formatAge(at: number | undefined, now = Date.now()): string {
  if (!at || !Number.isFinite(at)) return "";
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Search topics + session store + recent history. Pure ranking over provided
 * store; safe to call on the main bot thread (capped I/O).
 *
 * Sort key: score (relevance + recency) DESC, then `at` DESC (newest first).
 */
export function searchGroupMemory(opts: GroupMemorySearchOpts): MemoryHit[] {
  const tokens = tokenizeQuery(opts.query);
  if (tokens.length === 0) return [];
  const limit = Math.max(1, Math.min(20, opts.limit ?? 8));
  const maxSessions = opts.maxSessions ?? 40;
  const now = Date.now();
  const wantsRecent = queryWantsRecency(opts.query);
  /** Multiply recency when user asks for last/recent work. */
  const recencyMul = wantsRecent ? 2.5 : 1.2;
  const hits: MemoryHit[] = [];

  for (const t of opts.topics ?? []) {
    const hay = [t.name, t.projectPath ?? "", t.kind, t.sessionId ?? ""].join("\n");
    const score = scoreTokens(hay, tokens);
    if (score <= 0) continue;
    // Topic map updatedAt is already epoch ms.
    const at = normalizeEpochMs(t.updatedAt);
    // Mild recency on topics (routing), not full "last work" weight.
    const r = recencyBoost(at, now) * Math.min(1.2, recencyMul);
    hits.push({
      kind: "topic",
      title: t.name,
      snippet: t.projectPath ? `path: ${t.projectPath}` : `kind: ${t.kind}`,
      score: score + 2 + r,
      path: t.projectPath ?? undefined,
      threadId: t.threadId,
      sessionId: t.sessionId,
      at,
    });
  }

  let metas: SessionMeta[] = [];
  try {
    // Store already returns most-recently-updated first.
    metas = opts.store.list(maxSessions);
  } catch {
    metas = [];
  }

  const prefer = (opts.preferPaths ?? []).map((p) => p.replace(/\\/g, "/").toLowerCase());

  // Per project path: which session is the newest (for "last work in X").
  const newestByCwd = new Map<string, number>();
  for (const m of metas) {
    const key = normPath(m.cwd);
    if (!key) continue;
    const t = normalizeEpochMs(m.updatedAt) ?? 0;
    const prev = newestByCwd.get(key) ?? 0;
    if (t > prev) newestByCwd.set(key, t);
  }

  for (const m of metas) {
    const pathBoost = pathPreferenceBoost(m.cwd, prefer);
    const generalBoost =
      opts.preferGeneral &&
      (/^general$/i.test(m.title || "") || /general/i.test(m.comment || ""))
        ? 5
        : 0;
    const sessionAt = normalizeEpochMs(m.updatedAt);
    const rBoost = recencyBoost(sessionAt, now) * recencyMul;
    const newestBoost =
      sessionAt !== undefined && newestByCwd.get(normPath(m.cwd)) === sessionAt ? 10 : 0;

    const hay = [m.title, m.comment ?? "", m.cwd, m.sessionId].join("\n");
    const base = scoreTokens(hay, tokens);
    // Require text relevance — path/recency alone never invents a hit.
    if (base <= 0) {
      // Still scan history below if the session might contain matching tails.
    }
    const score = base + pathBoost + generalBoost + rBoost + newestBoost;
    const age = formatAge(sessionAt, now);

    if (base > 0 && Number.isFinite(score) && score > 0) {
      hits.push({
        kind: "session",
        title: m.title || m.sessionId.slice(0, 8),
        snippet: clamp(
          [age ? `[${age}]` : "", m.comment, m.cwd].filter(Boolean).join(" · ") || m.sessionId,
          240,
        ),
        score,
        path: m.cwd || undefined,
        sessionId: m.sessionId,
        at: sessionAt,
      });
    }

    // History: deeper tail for recent or path-matched sessions.
    const histDepth =
      rBoost >= 12 || pathBoost + generalBoost > 0 || wantsRecent ? 28 : 14;
    if (m.historyBytes <= 0) continue;
    try {
      const path = join(opts.sessionsDir, `${m.sessionId}.jsonl`);
      const entries = readHistory(path, histDepth);
      // Prefer newer entries: history is oldest→newest; weight later indices.
      const n = entries.length;
      for (let i = 0; i < n; i++) {
        const e = entries[i]!;
        if (!e.text?.trim()) continue;
        // Skip meta dumps that pollute "last work" answers.
        if (/MANAGER CONTEXT \(auto/i.test(e.text)) continue;
        if (/^COMPLEXITY \(decide yourself/i.test(e.text)) continue;
        if (/TELEGRAM BRIDGE \(how to work/i.test(e.text)) continue;

        const textScore = scoreTokens(e.text, tokens);
        if (textScore <= 0) continue;

        // Prefer entry timestamp; fall back to session updatedAt (not 0/NaN).
        const entryAt = normalizeEpochMs(e.timestamp) ?? sessionAt;
        const entryRecency = recencyBoost(entryAt, now) * recencyMul;
        // Position boost: last entries in the tail are newest.
        const posBoost = n > 1 ? Math.round((i / (n - 1)) * 6) : 3;
        // Prefer user prompts + assistant Done prose for "what was last done".
        const roleBoost = e.role === "user" ? 3 : e.role === "assistant" ? 3 : 0;
        const s =
          textScore +
          pathBoost +
          generalBoost +
          entryRecency +
          posBoost +
          roleBoost +
          (newestBoost > 0 ? 4 : 0);
        if (!Number.isFinite(s) || s <= 0) continue;
        const eAge = formatAge(entryAt, now);
        hits.push({
          kind: "history",
          title: `${e.role} · ${(m.title || m.sessionId.slice(0, 8)).slice(0, 40)}`,
          snippet: clamp(
            [eAge ? `[${eAge}]` : "", e.text.replace(/\s+/g, " ").trim()].filter(Boolean).join(" "),
            240,
          ),
          score: s,
          path: m.cwd || undefined,
          sessionId: m.sessionId,
          at: entryAt,
        });
      }
    } catch {
      /* ignore unreadable logs */
    }
  }

  // Newest high scores first.
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (b.at ?? 0) - (a.at ?? 0) ||
      a.kind.localeCompare(b.kind),
  );
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

function normPath(p: string | undefined): string {
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Higher boost for earlier preferred paths.
 * Index 0 is usually the workspace (General) — use **exact** match only so we
 * do not treat every child project under Domains as "General memory".
 * Later entries (project paths) allow prefix match.
 */
function pathPreferenceBoost(cwd: string | undefined, prefer: string[]): number {
  if (!cwd || prefer.length === 0) return 0;
  const n = cwd.replace(/\\/g, "/").toLowerCase();
  for (let i = 0; i < prefer.length; i++) {
    const p = prefer[i]!.replace(/\\/g, "/").toLowerCase();
    if (!p) continue;
    const exact = n === p;
    const child = i > 0 && (n === p || n.startsWith(p + "/"));
    if (exact || child) {
      return 8 - Math.min(6, i * 2);
    }
  }
  return 0;
}
