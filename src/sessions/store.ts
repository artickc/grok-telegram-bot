/**
 * Session store — reads ~/.grok/sessions/cli to discover existing Grok CLI
 * sessions, sorts them by recency, and detects which ones are currently
 * running on this PC (a .lock file whose PID is alive).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import type { SessionMeta } from "./types.js";

const log = createLogger("sessions:store");

interface RawSessionJson {
  session_id?: string;
  cwd?: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  session_created_reason?: string;
}

interface RawLock {
  pid?: number;
  started_at?: string;
}

export class SessionStore {
  constructor(private readonly dir: string) {}

  /** Returns true once the sessions directory exists. */
  available(): boolean {
    try {
      return statSync(this.dir).isDirectory();
    } catch {
      return false;
    }
  }

  /** List all sessions, most recently updated first. */
  list(limit = 50): SessionMeta[] {
    if (!this.available()) return [];
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch (e) {
      log.warn("cannot read sessions dir:", (e as Error).message);
      return [];
    }

    const metas: SessionMeta[] = [];
    for (const file of files) {
      const meta = this.readMeta(file);
      if (meta) metas.push(meta);
    }
    // Active sessions first, then most-recently-updated.
    metas.sort(
      (a, b) => Number(b.active) - Number(a.active) || b.updatedAt.localeCompare(a.updatedAt),
    );
    return metas.slice(0, limit);
  }

  /** List only sessions currently running on this PC. */
  listActive(): SessionMeta[] {
    return this.list(200).filter((s) => s.active);
  }

  get(sessionId: string): SessionMeta | undefined {
    return this.readMeta(`${sessionId}.json`);
  }

  jsonlPath(sessionId: string): string {
    return join(this.dir, `${sessionId}.jsonl`);
  }

  private readMeta(file: string): SessionMeta | undefined {
    const full = join(this.dir, file);
    let raw: RawSessionJson;
    let mtime = new Date(0).toISOString();
    try {
      raw = JSON.parse(readFileSync(full, "utf-8")) as RawSessionJson;
      mtime = statSync(full).mtime.toISOString();
    } catch {
      return undefined;
    }
    const sessionId = raw.session_id || file.replace(/\.json$/, "");
    const base = sessionId;

    const { lockPid, active } = this.checkLock(base);
    let historyBytes = 0;
    try {
      historyBytes = statSync(join(this.dir, `${base}.jsonl`)).size;
    } catch {
      /* no history yet */
    }

    return {
      sessionId,
      cwd: raw.cwd || "",
      title: (raw.title || "").trim() || "(untitled)",
      createdAt: raw.created_at || mtime,
      updatedAt: raw.updated_at || mtime,
      reason: raw.session_created_reason,
      lockPid,
      active,
      historyBytes,
    };
  }

  private checkLock(base: string): { lockPid?: number; active: boolean } {
    try {
      const lock = JSON.parse(readFileSync(join(this.dir, `${base}.lock`), "utf-8")) as RawLock;
      if (typeof lock.pid === "number") {
        return { lockPid: lock.pid, active: isPidAlive(lock.pid) };
      }
    } catch {
      /* no lock => not active */
    }
    return { active: false };
  }
}

/** Cross-platform "is this process still running?" check. */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    // Signal 0 does not kill; it only checks for existence/permission.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we can't signal it => still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
