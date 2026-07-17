/**
 * ChatController — manages the set of Grok sessions a single Telegram chat is
 * controlling, with exactly one "foreground" session streaming live. Other
 * (background) sessions keep running quietly; their output lands in the
 * session's .jsonl and is replayed as "unread" when you switch to them.
 */
import { basename } from "node:path";
import type { Api } from "grammy";
import type { GrokClient } from "../grok/client.js";
import type { SettingsStore } from "../app/settings-store.js";
import type { AppConfig } from "../config.js";
import { jsonlSize, readEntriesFrom, readHistory } from "../sessions/history.js";
import type { SessionStore } from "../sessions/store.js";
import type { HistoryEntry } from "../sessions/types.js";
import type { AccountRotator } from "./account-rotator.js";
import { SessionRuntime } from "./session-runtime.js";

export interface RunningSession {
  sessionId?: string;
  projectName: string;
  busy: boolean;
  foreground: boolean;
  unread: number;
  /** Latest task-completion % (0–100) for this session, if known. */
  progress?: number;
}

export interface SwitchResult {
  rt: SessionRuntime;
  sessionId?: string;
  projectName?: string;
  busy: boolean;
  unread: HistoryEntry[];
  firstView: boolean;
  alreadyForeground: boolean;
}

export class ChatController {
  private readonly runtimes: SessionRuntime[] = [];
  private fg: SessionRuntime | undefined;
  private readonly lastRead = new Map<string, number>();
  private restored = false;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly acp: GrokClient,
    private readonly cfg: AppConfig,
    private readonly settings: SettingsStore,
    private readonly store: SessionStore,
    private readonly refresh: (chatId: number) => void,
    private readonly notifyActivity: (busy: boolean) => void,
    private readonly getRotator?: () => AccountRotator | undefined,
  ) {}

  /** The current foreground runtime (created/restored lazily). */
  foreground(): SessionRuntime {
    this.ensureRestored();
    if (!this.fg) {
      const s = this.settings.get(this.chatId);
      const rt = this.create({ cwd: s.projectPath ?? this.cfg.workspace, projectName: s.projectName, sessionId: s.sessionId });
      this.runtimes.push(rt);
      this.fg = rt;
    }
    return this.fg;
  }

  /** List the controlled sessions (for /running). */
  list(): RunningSession[] {
    this.ensureRestored();
    this.pruneDuplicates();
    return this.runtimes.map((rt) => ({
      sessionId: rt.sessionId,
      projectName: rt.projectName ?? basename(rt.cwd),
      busy: rt.isBusy,
      foreground: rt.isForeground,
      unread: this.unreadCount(rt),
      progress: rt.taskProgress,
    }));
  }

  /** Start a brand-new session and bring it to the foreground.
   *  Always binds a live ACP session (`session/new`) — use {@link switchProject}
   *  when you only need to change the working directory (instant). */
  async addNew(cwd: string, projectName?: string): Promise<SessionRuntime> {
    this.ensureRestored();
    const prevFg = this.fg;
    const rt = this.create({ cwd, projectName });
    this.runtimes.push(rt);
    this.fg = rt;
    // Fire-and-forget: finalizing the previous streamer must not block the new
    // session bind (that was a major source of "bot freezes on switch").
    void this.background(prevFg);
    await rt.startNewSession(cwd, projectName);
    this.markSeen(rt);
    this.persist();
    return rt;
  }

  /**
   * Switch the chat to a project directory **without** waiting on ACP.
   * - Reuses an existing controlled runtime for the same path when possible.
   * - Does **not** call `session/new` — the live session is created lazily on
   *   the first prompt / prepare (via `ensureSession`).
   * This keeps the project picker responsive even while another turn is running.
   */
  async switchProject(cwd: string, projectName?: string): Promise<SessionRuntime> {
    this.ensureRestored();
    const key = normPath(cwd);
    const same = this.runtimes.filter((r) => normPath(r.cwd) === key);
    // Prefer the current FG if it already points here, else the most recent match.
    const existing = same.find((r) => r === this.fg) ?? same.at(-1);

    if (existing) {
      if (projectName) existing.projectName = projectName;
      if (existing === this.fg) {
        this.persist();
        return existing;
      }
      if (existing.sessionId) {
        // Fast path: switchTo no longer awaits ACP re-bind.
        const sw = await this.switchTo(existing.sessionId);
        return sw?.rt ?? existing;
      }
      void this.background(this.fg);
      this.fg = existing;
      await existing.setForeground(true);
      this.persist();
      return existing;
    }

    const prevFg = this.fg;
    const rt = this.create({ cwd, projectName });
    this.runtimes.push(rt);
    this.fg = rt;
    void this.background(prevFg);
    // Drop other never-used project placeholders (no session yet) so rapid
    // project browsing can't accumulate infinite idle runtimes/listeners.
    this.pruneUnusedPlaceholders(rt);
    // No startNewSession — sessionId stays undefined until the first message.
    this.persist();
    return rt;
  }

  /**
   * Connect to a session with resume-or-fork semantics (used by /sessions),
   * adding it as a controlled session and bringing it to the foreground.
   */
  async addAttach(
    sessionId: string,
    cwd: string,
    projectName: string | undefined,
    priorEntries: HistoryEntry[],
  ): Promise<{ rt: SessionRuntime; result: "resumed" | "forked"; alreadyControlled: boolean }> {
    this.ensureRestored();
    if (this.runtimes.some((r) => r.sessionId === sessionId)) {
      const sw = await this.switchTo(sessionId);
      return { rt: sw!.rt, result: "resumed", alreadyControlled: true };
    }
    // Reserve the runtime synchronously (before any await) so a concurrent tap
    // on the same session finds it and switches instead of creating a duplicate.
    const prevFg = this.fg;
    const rt = this.create({ cwd, projectName, sessionId });
    this.runtimes.push(rt);
    this.fg = rt;
    void this.background(prevFg);
    const result = await rt.attach(sessionId, cwd, projectName, priorEntries);
    this.markSeen(rt);
    this.persist();
    return { rt, result, alreadyControlled: false };
  }

  /** Connect to an existing session: switch if already controlled, else add it. */
  async addResume(sessionId: string, cwd: string, projectName?: string): Promise<SwitchResult> {
    this.ensureRestored();
    if (this.runtimes.some((r) => r.sessionId === sessionId)) {
      return (await this.switchTo(sessionId))!;
    }
    const prevFg = this.fg;
    const rt = this.create({ cwd, projectName, sessionId });
    this.runtimes.push(rt);
    this.fg = rt;
    void this.background(prevFg);
    // Lazy re-bind on first prompt (rebindPending); don't block the resume UI.
    const path = this.store.jsonlPath(sessionId);
    const unread = readHistory(path, 12);
    this.lastRead.set(sessionId, jsonlSize(path));
    this.persist();
    return { rt, sessionId, projectName, busy: rt.isBusy, unread, firstView: true, alreadyForeground: false };
  }

  /** Switch the foreground to an already-controlled session. */
  async switchTo(sessionId: string): Promise<SwitchResult | undefined> {
    this.ensureRestored();
    const rt = this.runtimes.find((r) => r.sessionId === sessionId);
    if (!rt) return undefined;
    if (rt === this.fg) {
      return { rt, sessionId, projectName: rt.projectName, busy: rt.isBusy, unread: [], firstView: false, alreadyForeground: true };
    }
    void this.background(this.fg);
    this.fg = rt;
    await rt.setForeground(true);
    // Do NOT await prepare()/loadSession here — re-bind is lazy on the next
    // prompt (rebindPending). Awaiting ACP mid-switch freezes the bot when the
    // agent is busy with another turn.

    const path = this.store.jsonlPath(sessionId);
    const seen = this.lastRead.get(sessionId);
    let unread: HistoryEntry[] = [];
    let firstView = false;
    if (seen !== undefined) {
      unread = readEntriesFrom(path, seen).entries;
    } else {
      unread = readHistory(path, 12);
      firstView = true;
    }
    this.lastRead.set(sessionId, jsonlSize(path));
    // No tail-watch here: setForeground(true) above already resumed RICH live
    // streaming for the in-flight turn via the agent's own session/update
    // events. Tailing the .jsonl too would double-render every update.
    this.persist();
    return { rt, sessionId, projectName: rt.projectName, busy: rt.isBusy, unread, firstView, alreadyForeground: false };
  }

  /** Stop controlling a session (does not kill it). */
  async close(sessionId: string): Promise<boolean> {
    this.ensureRestored();
    const idx = this.runtimes.findIndex((r) => r.sessionId === sessionId);
    if (idx === -1) return false;
    const rt = this.runtimes[idx]!;
    rt.dispose();
    this.runtimes.splice(idx, 1);
    this.lastRead.delete(sessionId);
    if (this.fg === rt) {
      this.fg = this.runtimes[0];
      if (this.fg) await this.fg.setForeground(true);
    }
    this.persist();
    return true;
  }

  count(): number {
    this.ensureRestored();
    return this.runtimes.length;
  }

  /** Latest task-progress % for a controlled session id, if this chat runs it. */
  progressFor(sessionId?: string): number | undefined {
    if (!sessionId) return undefined;
    this.ensureRestored();
    return this.runtimes.find((r) => r.sessionId === sessionId)?.taskProgress;
  }

  findBySession(sessionId: string): boolean {
    return this.runtimes.some((r) => r.sessionId === sessionId);
  }

  dispose(): void {
    for (const rt of this.runtimes) rt.dispose();
    this.runtimes.length = 0;
    this.fg = undefined;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private ensureRestored(): void {
    if (this.restored) return;
    this.restored = true;
    const s = this.settings.get(this.chatId);
    const seen = new Set<string>();
    for (const cs of s.controlledSessions ?? []) {
      if (!cs.sessionId || seen.has(cs.sessionId)) continue; // never restore the same session twice
      seen.add(cs.sessionId);
      this.runtimes.push(this.create({ cwd: cs.projectPath, projectName: cs.projectName, sessionId: cs.sessionId }));
    }
    // Lazy project switches persist projectPath without a sessionId. If the
    // saved project is not among controlled sessions, recreate an unbound FG
    // so a restart lands on the project the user last chose.
    if (s.projectPath) {
      const key = normPath(s.projectPath);
      const hasProject = this.runtimes.some((r) => normPath(r.cwd) === key);
      if (!hasProject) {
        this.runtimes.push(this.create({ cwd: s.projectPath, projectName: s.projectName }));
      }
    }
    if (this.runtimes.length > 0) {
      let fg = this.runtimes.find((r) => r.sessionId && r.sessionId === s.foregroundSessionId);
      if (!fg && s.projectPath) {
        const key = normPath(s.projectPath);
        fg = this.runtimes.find((r) => normPath(r.cwd) === key);
      }
      fg = fg ?? this.runtimes[0]!;
      for (const r of this.runtimes) void r.setForeground(r === fg);
      this.fg = fg;
    }
  }

  /** Drop any runtime that duplicates another's sessionId (keeping the
   *  foreground one), healing a state where two runtimes wrap one session. */
  private pruneDuplicates(): void {
    const byId = new Map<string, SessionRuntime>();
    const kept: SessionRuntime[] = [];
    for (const rt of this.runtimes) {
      const id = rt.sessionId;
      if (!id) {
        kept.push(rt);
        continue;
      }
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, rt);
        kept.push(rt);
        continue;
      }
      const loser = prev.isForeground || !rt.isForeground ? rt : prev;
      const winner = loser === rt ? prev : rt;
      if (winner !== prev) {
        byId.set(id, winner);
        const i = kept.indexOf(prev);
        if (i !== -1) kept[i] = winner;
      }
      if (this.fg === loser) this.fg = winner;
      loser.dispose();
    }
    if (kept.length !== this.runtimes.length) {
      this.runtimes.length = 0;
      this.runtimes.push(...kept);
      this.persist();
    }
  }

  private create(init: { cwd: string; projectName?: string; sessionId?: string }): SessionRuntime {
    const rt = new SessionRuntime(this.api, this.chatId, this.acp, this.cfg, this.settings, init);
    rt.onStateChange = () => this.refresh(this.chatId);
    rt.onActivity = (busy) => this.notifyActivity(busy);
    rt.accountRotator = this.getRotator?.();
    // A logical fork (auto-fork-on-error / lost-session recovery) swaps the
    // runtime's session id in place — re-persist the controlled list with the
    // new id and treat the fresh session as already-seen.
    rt.onSessionChange = () => {
      this.markSeen(rt);
      this.persist();
    };
    return rt;
  }

  private async background(rt: SessionRuntime | undefined): Promise<void> {
    if (!rt) return;
    this.markSeen(rt);
    await rt.setForeground(false);
  }

  /** Remove idle runtimes that never bound an ACP session (lazy project taps). */
  private pruneUnusedPlaceholders(keep: SessionRuntime): void {
    for (let i = this.runtimes.length - 1; i >= 0; i--) {
      const r = this.runtimes[i]!;
      if (r === keep || r === this.fg) continue;
      if (r.sessionId || r.isBusy) continue;
      r.dispose();
      this.runtimes.splice(i, 1);
    }
  }

  private markSeen(rt: SessionRuntime): void {
    if (rt.sessionId) this.lastRead.set(rt.sessionId, jsonlSize(this.store.jsonlPath(rt.sessionId)));
  }

  private unreadCount(rt: SessionRuntime): number {
    if (!rt.sessionId || rt.isForeground) return 0;
    const seen = this.lastRead.get(rt.sessionId);
    if (seen === undefined) return 0;
    return readEntriesFrom(this.store.jsonlPath(rt.sessionId), seen).entries.length;
  }

  private persist(): void {
    const seen = new Set<string>();
    const controlled: { sessionId?: string; projectPath: string; projectName?: string }[] = [];
    for (const r of this.runtimes) {
      if (!r.sessionId || seen.has(r.sessionId)) continue;
      seen.add(r.sessionId);
      controlled.push({ sessionId: r.sessionId, projectPath: r.cwd, projectName: r.projectName });
    }
    this.settings.update(this.chatId, {
      controlledSessions: controlled,
      foregroundSessionId: this.fg?.sessionId,
      // Keep the single-session restore fields aligned with the foreground so
      // the pinned status panel and a fresh restore never show a project that
      // belongs to a different (previously-foreground) session.
      sessionId: this.fg?.sessionId,
      projectPath: this.fg?.cwd,
      projectName: this.fg?.projectName,
    });
  }
}

/** Path key for project matching (case / separators / trailing slash). */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
