/**
 * Auto-injected context for General manager turns: topic catalog, memory hits,
 * recent General chat history, and active dispatch jobs.
 */
import { join } from "node:path";
import type { ForumManager } from "../forum/manager.js";
import { readHistory } from "../sessions/history.js";
import type { SessionStore } from "../sessions/store.js";
import { searchGroupMemory } from "./group-memory.js";
import { listActiveManagerJobs, listRecentManagerJobs, type ManagerJob } from "./manager-jobs.js";

export const MANAGER_CONTEXT_MARKER = "MANAGER CONTEXT (auto — use before dispatching work):";

const CONTEXT_MAX = 6500;

export interface ManagerContextOpts {
  userText: string;
  sessionsDir: string;
  store: SessionStore;
  forum?: ForumManager;
  /** Override jobs list (tests). */
  jobs?: ManagerJob[];
}

/** Build a capped context block for manager prompts. */
export function buildManagerContextBlock(opts: ManagerContextOpts): string {
  const lines: string[] = [MANAGER_CONTEXT_MARKER, ""];

  const topics = opts.forum?.isReady ? opts.forum.store.all() : [];
  lines.push("## Topics");
  if (topics.length === 0) {
    lines.push("(no forum topics mapped)");
  } else {
    const topicCap = 40;
    for (const t of topics.slice(0, topicCap)) {
      const path = t.projectPath ?? "(unbound)";
      lines.push(`- **${t.name}** #${t.threadId} [${t.kind}] \`${path}\``);
    }
    if (topics.length > topicCap) {
      lines.push(`… +${topics.length - topicCap} more (use list_topics)`);
    }
  }

  const workspace =
    topics.find((t) => t.kind === "general")?.projectPath ||
    topics.find((t) => t.kind === "ai_chat")?.projectPath ||
    undefined;
  const preferPaths = [
    workspace,
    ...topics
      .filter((t) => t.kind === "project" && t.projectPath)
      .map((t) => t.projectPath!)
      .slice(0, 12),
  ].filter(Boolean) as string[];

  // Always surface recent General chat so the manager "remembers" this room.
  lines.push("", "## Recent General chat (always available)");
  const generalSnips = recentGeneralHistory(opts, workspace, 10);
  if (generalSnips.length === 0) {
    lines.push("(no prior General history on disk yet)");
  } else {
    for (const s of generalSnips) lines.push(`- ${s}`);
  }

  lines.push(
    "",
    "## Memory hits (ranked: relevance + recency — newest work first, not git)",
  );
  const hits = searchGroupMemory({
    query: opts.userText,
    limit: 14,
    sessionsDir: opts.sessionsDir,
    store: opts.store,
    topics: topics.length ? topics : undefined,
    preferPaths,
    preferGeneral: true,
    maxSessions: 32,
  });
  if (hits.length === 0) {
    lines.push(
      "(no hits — call search_memory; do NOT run git until memory is exhausted)",
    );
  } else {
    for (const h of hits) {
      const where =
        h.threadId !== undefined
          ? ` #${h.threadId}`
          : h.sessionId
            ? ` session=${h.sessionId.slice(0, 8)}`
            : "";
      lines.push(`- [${h.kind}] ${h.title}${where}: ${h.snippet}`);
    }
  }

  lines.push(
    "",
    "Rules: for \"last modifications / last work\" trust hits with [Xm/h/d ago] stamps — prefer the newest session for that project path.",
    "Ignore older OmniRoute-style notes if a newer session for the same path exists.",
    "Do not use git log/status as the first step unless the user asked for git.",
  );

  const jobs = opts.jobs ?? [...listActiveManagerJobs(8), ...listRecentManagerJobs(4)];
  const seen = new Set<string>();
  const uniq: ManagerJob[] = [];
  for (const j of jobs) {
    if (seen.has(j.id)) continue;
    seen.add(j.id);
    uniq.push(j);
    if (uniq.length >= 10) break;
  }
  lines.push("", "## Manager jobs (this process)");
  if (uniq.length === 0) {
    lines.push("(none)");
  } else {
    for (const j of uniq) {
      const ageMin = Math.max(0, Math.round((Date.now() - j.createdAt) / 60_000));
      lines.push(
        `- ${j.status} **${j.targetName}** #${j.targetThreadId} (${ageMin}m ago) job=${j.id}` +
          (j.childSessionId ? ` session=${j.childSessionId.slice(0, 8)}` : ""),
      );
      if (j.userAskPreview) lines.push(`  ask: ${clamp(j.userAskPreview, 160)}`);
    }
  }

  lines.push(
    "",
    "Use this context to pick the right topic and write a strong send_prompt.",
    "When a hit shows session=XXXXXXXX and the user wants follow-up there, pass that exact",
    "prefix as session_id on send_prompt (do NOT rely on the topic's currently open session).",
    "Prefer search_memory again if you need deeper history before dispatching.",
  );

  let block = lines.join("\n");
  if (block.length > CONTEXT_MAX) {
    block = block.slice(0, CONTEXT_MAX - 1) + "\u2026";
  }
  return block;
}

/** Last user/assistant lines from General-named or workspace sessions. */
function recentGeneralHistory(
  opts: ManagerContextOpts,
  workspace: string | undefined,
  limit: number,
): string[] {
  const out: string[] = [];
  let metas;
  try {
    metas = opts.store.list(40);
  } catch {
    return out;
  }
  const ws = workspace?.replace(/\\/g, "/").toLowerCase();
  const ranked = metas
    .map((m) => {
      const title = (m.title || "").toLowerCase();
      const cwd = (m.cwd || "").replace(/\\/g, "/").toLowerCase();
      let rank = 0;
      // Prefer sessions explicitly labeled General — never treat every project
      // under the workspace root as "General chat" (path prefix trap).
      if (title === "general") rank += 12;
      else if (/\bgeneral\b/.test(title)) rank += 6;
      // Exact workspace cwd only (General/AI Chat bind), not child project paths.
      if (ws && cwd === ws) rank += 4;
      return { m, rank };
    })
    .filter((x) => x.rank > 0)
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        String(b.m.updatedAt || "").localeCompare(String(a.m.updatedAt || "")),
    );

  for (const { m } of ranked.slice(0, 4)) {
    try {
      const path = join(opts.sessionsDir, `${m.sessionId}.jsonl`);
      const entries = readHistory(path, 8);
      for (const e of entries) {
        if (!e.text?.trim()) continue;
        // Skip huge manager context dumps in history.
        if (e.text.includes(MANAGER_CONTEXT_MARKER)) continue;
        if (e.text.startsWith("MANAGER MODE")) continue;
        const role = e.role === "user" ? "user" : e.role === "assistant" ? "bot" : e.role;
        out.push(
          `${role} · ${m.sessionId.slice(0, 8)}: ${clamp(e.text.replace(/\s+/g, " "), 180)}`,
        );
        if (out.length >= limit) return out;
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Prepend context block to a user/manager prompt body (idempotent). */
export function injectManagerContext(text: string, contextBlock: string): string {
  const body = text.trim();
  if (!contextBlock.trim()) return body;
  if (body.includes(MANAGER_CONTEXT_MARKER)) return body;
  return `${contextBlock}\n\n---\n\n${body}`;
}

function clamp(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "\u2026";
}
