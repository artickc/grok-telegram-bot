/**
 * Bot-owned session log. Grok CLI keeps its own sessions in an internal SQLite
 * store, but this bridge is the source of truth for the sessions IT drives: for
 * each one it writes the SAME on-disk layout the original ACP bridge used, under
 * the bot's data dir, so the session store, history parser and live-tail watcher
 * all keep working without change:
 *
 *   <sessionsDir>/<id>.json    metadata (session_id, cwd, title, timestamps, …)
 *   <sessionsDir>/<id>.jsonl   event log (Prompt / AssistantMessage / ToolUse)
 *   <sessionsDir>/<id>.lock    { pid } while a turn is running (drives "active")
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("grok:session-log");

interface SessionFile {
  session_id: string;
  cwd: string;
  title: string;
  created_at: string;
  updated_at: string;
  session_created_reason?: string;
  /** The id the underlying `grok --session` uses (may differ from ours). */
  grok_session_id?: string;
  /** Model last used for this session (applied via `grok --model`). */
  model?: string;
}

export class SessionLog {
  constructor(private readonly dir: string) {}

  private path(id: string, ext: string): string {
    return join(this.dir, `${id}.${ext}`);
  }

  private ensureDir(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      /* best-effort */
    }
  }

  /** Create the metadata file for a new session if it doesn't exist yet. */
  create(id: string, cwd: string, reason = "user"): void {
    this.ensureDir();
    if (existsSync(this.path(id, "json"))) return;
    const now = new Date().toISOString();
    const meta: SessionFile = {
      session_id: id,
      cwd,
      title: "(untitled)",
      created_at: now,
      updated_at: now,
      session_created_reason: reason,
    };
    this.writeMeta(id, meta);
  }

  read(id: string): SessionFile | undefined {
    try {
      return JSON.parse(readFileSync(this.path(id, "json"), "utf-8")) as SessionFile;
    } catch {
      return undefined;
    }
  }

  private writeMeta(id: string, meta: SessionFile): void {
    try {
      this.ensureDir();
      writeFileSync(this.path(id, "json"), JSON.stringify(meta, null, 2), "utf-8");
    } catch (e) {
      log.debug("writeMeta failed:", (e as Error).message);
    }
  }

  /** Merge a partial update into the metadata file (touches updated_at). */
  update(id: string, patch: Partial<SessionFile>): void {
    const cur = this.read(id) ?? {
      session_id: id,
      cwd: patch.cwd ?? "",
      title: "(untitled)",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const next: SessionFile = { ...cur, ...patch, session_id: id, updated_at: new Date().toISOString() };
    this.writeMeta(id, next);
  }

  grokIdFor(id: string): string | undefined {
    return this.read(id)?.grok_session_id;
  }

  modelFor(id: string): string | undefined {
    return this.read(id)?.model;
  }

  cwdFor(id: string): string | undefined {
    return this.read(id)?.cwd;
  }

  // ── event log (history-compatible jsonl) ──────────────────────────────────

  private append(id: string, kind: string, data: Record<string, unknown>): void {
    try {
      this.ensureDir();
      const line = JSON.stringify({ kind, data: { ...data, meta: { timestamp: Date.now() } } });
      appendFileSync(this.path(id, "jsonl"), line + "\n", "utf-8");
    } catch (e) {
      log.debug("append failed:", (e as Error).message);
    }
  }

  logUser(id: string, text: string): void {
    if (!text.trim()) return;
    this.append(id, "Prompt", { content: [{ kind: "text", data: text }] });
  }

  logAssistant(id: string, text: string): void {
    if (!text.trim()) return;
    this.append(id, "AssistantMessage", { content: [{ kind: "text", data: text }] });
  }

  logTool(id: string, name: string, summary: string): void {
    this.append(id, "ToolUse", { tool_name: name, content: [{ kind: "text", data: summary }] });
  }

  // ── lock (active detection) ───────────────────────────────────────────────

  lock(id: string, pid: number): void {
    try {
      this.ensureDir();
      writeFileSync(this.path(id, "lock"), JSON.stringify({ pid, started_at: new Date().toISOString() }), "utf-8");
    } catch {
      /* best-effort */
    }
  }

  unlock(id: string): void {
    try {
      rmSync(this.path(id, "lock"), { force: true });
    } catch {
      /* best-effort */
    }
  }
}
