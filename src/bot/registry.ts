/**
 * Tracks one ChatController per Telegram chat (each controlling one or more
 * sessions). `get(chatId)` returns the chat's foreground SessionRuntime so the
 * existing handlers keep operating on "the current session".
 *
 * It also owns **subagent attribution**: Grok reports a single, process-global
 * subagent list (with no parent session id on the wire), so we attribute new
 * subagents to the chat whose turn is currently running (most-recent first).
 * That mapping drives both subagent *visibility* (routed to the owner's
 * foreground runtime) and *permission* routing (a subagent's permission request
 * is asked of its parent chat).
 */
import type { Api } from "grammy";
import type { GrokClient } from "../grok/client.js";
import type { PendingStage, SubagentInfo } from "../grok/types.js";
import type { SettingsStore } from "../app/settings-store.js";
import type { AppConfig } from "../config.js";
import { subagentSummary } from "../render/subagent.js";
import type { SessionStore } from "../sessions/store.js";
import type { AccountRotator } from "./account-rotator.js";
import { ChatController, type ChatBridgeServices } from "./chat-controller.js";
import type { SessionRuntime } from "./session-runtime.js";

export interface SessionDescription {
  /** Chat that owns the session (controlled session or subagent parent). */
  chatId?: number;
  /** Forum topic thread id when the session lives in a project topic. */
  threadId?: number;
  /** True when this is a session the chat directly controls. */
  controlled: boolean;
  /** True when this is a subagent of a controlled turn. */
  subagent: boolean;
  projectName?: string;
  subagentName?: string;
}

export class RuntimeRegistry {
  private readonly controllers = new Map<number, ChatController>();
  /**
   * Forum topic controllers keyed by `chatId:threadId`.
   * Each topic has its own multi-session controller + settings (model/reasoning).
   */
  private readonly forumControllers = new Map<string, ChatController>();
  private refresher: ((chatId: number) => void) | undefined;
  private rotator: AccountRotator | undefined;
  private bridge: ChatBridgeServices | undefined;
  /** Turns currently busy, most-recently-started last (forum thread when set). */
  private readonly activeTurns: Array<{ chatId: number; threadId?: number }> = [];
  /** Subagent sessionId -> owner chat id. */
  private readonly subagentParents = new Map<string, number>();

  constructor(
    private readonly api: Api,
    private readonly acp: GrokClient,
    private readonly cfg: AppConfig,
    private readonly settings: SettingsStore,
    private readonly store: SessionStore,
  ) {
    this.acp.on("subagents", (subagents, pending) => this.onSubagents(subagents, pending));
  }

  setRefresher(fn: (chatId: number) => void): void {
    this.refresher = fn;
  }

  /** Provide the account rotator used for auto-rotate-on-give-up. */
  setAccountRotator(rotator: AccountRotator): void {
    this.rotator = rotator;
  }

  /** Telegram bridge services (forum, session store, sibling bots). */
  setBridge(bridge: ChatBridgeServices): void {
    this.bridge = bridge;
    for (const c of this.controllers.values()) c.bridge = bridge;
    for (const c of this.forumControllers.values()) c.bridge = bridge;
  }

  controller(chatId: number): ChatController {
    let c = this.controllers.get(chatId);
    if (!c) {
      c = new ChatController(
        this.api,
        chatId,
        this.acp,
        this.cfg,
        this.settings,
        this.store,
        (id) => this.refresher?.(id),
        (busy) => this.noteActivity(chatId, busy, undefined),
        () => this.rotator,
      );
      c.bridge = this.bridge;
      this.controllers.set(chatId, c);
    }
    return c;
  }

  /** The chat's foreground runtime (backward-compatible with existing handlers). */
  get(chatId: number): SessionRuntime {
    return this.controller(chatId).foreground();
  }

  /**
   * Multi-session controller for a forum topic (fixed project path).
   * Settings key: `{chatId}:t{threadId}` — own model / reasoning / sessions.
   */
  forumController(
    chatId: number,
    threadId: number,
    cwd: string,
    projectName?: string,
  ): ChatController {
    const key = `${chatId}:${threadId}`;
    let c = this.forumControllers.get(key);
    if (c && c.fixedCwd && normPath(c.fixedCwd) !== normPath(cwd)) {
      // Path re-bind — dispose and recreate.
      c.dispose();
      this.forumControllers.delete(key);
      c = undefined;
    }
    if (!c) {
      c = new ChatController(
        this.api,
        chatId,
        this.acp,
        this.cfg,
        this.settings,
        this.store,
        (id) => this.refresher?.(id),
        (busy) => this.noteActivity(chatId, busy, threadId),
        () => this.rotator,
        {
          messageThreadId: threadId,
          settingsKey: `${chatId}:t${threadId}`,
          fixedCwd: cwd,
          fixedProjectName: projectName,
        },
      );
      c.bridge = this.bridge;
      this.forumControllers.set(key, c);
    }
    return c;
  }

  /**
   * Foreground runtime for a forum topic. Creates the topic controller lazily.
   */
  getForumTopic(
    chatId: number,
    threadId: number,
    cwd: string,
    projectName?: string,
  ): SessionRuntime {
    return this.forumController(chatId, threadId, cwd, projectName).foreground();
  }

  /** All forum topic controllers (for bidirectional session listing). */
  allForumControllers(): ChatController[] {
    return [...this.forumControllers.values()];
  }

  /** Forum controller that currently owns a session id, if any. */
  forumControllerForSession(sessionId: string): ChatController | undefined {
    for (const c of this.forumControllers.values()) {
      if (c.findBySession(sessionId)) return c;
    }
    return undefined;
  }

  disposeAll(): void {
    for (const c of this.controllers.values()) c.dispose();
    this.controllers.clear();
    for (const c of this.forumControllers.values()) c.dispose();
    this.forumControllers.clear();
  }

  /** Find the chat that currently controls a given session id. */
  findChatBySession(sessionId: string): number | undefined {
    for (const [chatId, c] of this.controllers) {
      if (c.findBySession(sessionId)) return chatId;
    }
    for (const [key, c] of this.forumControllers) {
      if (c.findBySession(sessionId)) {
        const chatId = Number(key.split(":")[0]);
        return Number.isFinite(chatId) ? chatId : undefined;
      }
    }
    return undefined;
  }

  isControlledSession(sessionId: string): boolean {
    return this.findChatBySession(sessionId) !== undefined;
  }

  /**
   * The chat a session belongs to for permission/routing purposes: a directly
   * controlled session, otherwise the parent chat of a subagent.
   */
  ownerChatForSession(sessionId: string): number | undefined {
    return this.findChatBySession(sessionId) ?? this.subagentParents.get(sessionId);
  }

  /** Runtime that currently controls a session id (any forum/private controller). */
  runtimeForSession(sessionId: string): SessionRuntime | undefined {
    for (const c of this.forumControllers.values()) {
      const rt = c.runtimeBySession(sessionId);
      if (rt) return rt;
    }
    for (const c of this.controllers.values()) {
      const rt = c.runtimeBySession(sessionId);
      if (rt) return rt;
    }
    return undefined;
  }

  /** Describe a session so a permission prompt can label it correctly. */
  describeSession(sessionId: string): SessionDescription {
    const controlledChat = this.findChatBySession(sessionId);
    if (controlledChat !== undefined) {
      const forum = this.forumControllerForSession(sessionId);
      const project = (forum ?? this.controller(controlledChat))
        .list()
        .find((s) => s.sessionId === sessionId)?.projectName;
      return {
        chatId: controlledChat,
        threadId: forum?.messageThreadId,
        controlled: true,
        subagent: false,
        projectName: project,
      };
    }
    const parent = this.subagentParents.get(sessionId);
    const info = this.acp.subagentById(sessionId);
    if (parent !== undefined || info) {
      // Prefer the parent chat's active forum thread so SSH/exec prompts land
      // in the project topic, not General.
      const owner = this.currentOwner();
      let threadId =
        owner && owner.chatId === parent ? owner.threadId : undefined;
      if (threadId === undefined && parent !== undefined) {
        const prefix = `${parent}:`;
        for (const [key, c] of this.forumControllers) {
          if (!key.startsWith(prefix)) continue;
          if (c.foreground().isBusy && c.messageThreadId !== undefined) {
            threadId = c.messageThreadId;
            break;
          }
        }
      }
      return {
        chatId: parent,
        threadId,
        controlled: false,
        subagent: true,
        subagentName: info?.sessionName || info?.agentName || sessionId.slice(0, 8),
      };
    }
    return { controlled: false, subagent: false };
  }

  /** Subagent summary line for a chat's status panel, or undefined. */
  subagentSummaryForChat(chatId: number): string | undefined {
    const mine = this.acp.currentSubagents().filter((s) => this.subagentParents.get(s.sessionId) === chatId);
    if (mine.length === 0) return undefined;
    return subagentSummary(mine, this.acp.currentPendingStages());
  }

  // ── subagent attribution ─────────────────────────────────────────────────

  private noteActivity(chatId: number, busy: boolean, threadId?: number): void {
    for (let i = this.activeTurns.length - 1; i >= 0; i--) {
      const t = this.activeTurns[i]!;
      if (t.chatId === chatId && t.threadId === threadId) this.activeTurns.splice(i, 1);
    }
    if (busy) this.activeTurns.push({ chatId, threadId });
  }

  /** The chat most likely to own freshly-spawned subagents. */
  private currentOwner(): { chatId: number; threadId?: number } | undefined {
    return this.activeTurns.at(-1);
  }

  /**
   * Busy foreground runtimes for a chat — forum topic controllers first, then
   * the non-forum controller. Project /goal turns live on forumController, not
   * controller(chatId), so subagent UI must target these.
   *
   * When `preferThreadId` is set, ONLY that topic's busy runtime is returned.
   * Previously we appended every other busy topic too, which leaked ask_user /
   * permission "waiting" notices across forum topics.
   */
  busyRuntimesForChat(chatId: number, preferThreadId?: number): SessionRuntime[] {
    const out: SessionRuntime[] = [];
    const prefix = `${chatId}:`;
    for (const [key, c] of this.forumControllers) {
      if (!key.startsWith(prefix)) continue;
      const fg = c.foreground();
      if (!fg.isBusy) continue;
      if (preferThreadId !== undefined && c.messageThreadId !== preferThreadId) continue;
      out.push(fg);
    }
    // Private / non-forum controller — only when not scoping to a project topic.
    if (preferThreadId === undefined) {
      const main = this.controllers.get(chatId);
      if (main) {
        const fg = main.foreground();
        if (fg.isBusy) out.push(fg);
      }
    }
    return out;
  }

  private onSubagents(subagents: SubagentInfo[], pending: PendingStage[]): void {
    const owner = this.currentOwner();
    // Record parents for any subagent we haven't attributed yet.
    if (owner !== undefined) {
      for (const s of subagents) {
        if (!this.subagentParents.has(s.sessionId)) {
          this.subagentParents.set(s.sessionId, owner.chatId);
        }
      }
    }
    // Group by attributed chat and route visibility to each owner's *busy*
    // runtime (forum topic streamer for project /goal — not the bare chat controller).
    const byChat = new Map<number, SubagentInfo[]>();
    for (const s of subagents) {
      const chatId = this.subagentParents.get(s.sessionId);
      if (chatId === undefined) continue;
      const arr = byChat.get(chatId);
      if (arr) arr.push(s);
      else byChat.set(chatId, [s]);
    }
    for (const [chatId, list] of byChat) {
      const preferThread =
        owner?.chatId === chatId ? owner.threadId : undefined;
      const runtimes = this.busyRuntimesForChat(chatId, preferThread);
      for (const rt of runtimes) {
        try {
          if (rt.sessionId) this.acp.touchActivity(rt.sessionId);
          rt.renderSubagents(list, pending);
        } catch {
          /* non-fatal */
        }
      }
      this.refresher?.(chatId);
    }
    // Prune mappings for subagents no longer present (they're terminated and
    // won't issue further permission requests) so the map stays bounded.
    const live = new Set(subagents.map((s) => s.sessionId));
    for (const sid of this.subagentParents.keys()) {
      if (!live.has(sid)) this.subagentParents.delete(sid);
    }
  }
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
