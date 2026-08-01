/**
 * SessionRuntime вЂ” binds one Telegram chat to one Grok ACP session and drives
 * the prompt/stream lifecycle, typing indicator, follow-up queue, live watch,
 * and per-chat preferences (project, agent, model, reasoning). State persists
 * to the settings store so it survives restarts.
 */
import { basename, join } from "node:path";
import { type Api, InlineKeyboard } from "grammy";
import {
  type GrokClient,
  isAccountRotationError,
  isContextExhaustedError,
  isSessionLifecycleError,
  isTransientError,
  type SessionMetadata,
} from "../grok/client.js";
import type { AccountRotator } from "./account-rotator.js";
import { contentText, type ContentBlock, type PromptResult, type SessionUpdate } from "../grok/types.js";
import type { AppConfig } from "../config.js";
import { reasoningDirective } from "../app/reasoning.js";
import type { SettingsStore } from "../app/settings-store.js";
import { type PromptInput, type ReasoningEffort, textPrompt } from "../app/types.js";
import { createLogger } from "../logger.js";
import { buildTranscript, readHistory } from "../sessions/history.js";
import { sessionHashtags } from "../render/hashtags.js";
import { PROGRESS_DIRECTIVE } from "../render/progress.js";
import { buildPriming, recentTranscript } from "./session-fork.js";
import { TailWatcher } from "../sessions/tail.js";
import type { HistoryEntry } from "../sessions/types.js";
import { formatToolCall } from "../render/tool-call.js";
import {
  mergeToolSnapshot,
  snapshotHasDetail,
  type ToolSnapshot,
} from "../render/tool-call-merge.js";
import {
  type FileOp,
  cloneFileOps,
  fileOpFromUpdate,
  mergeFileOp,
  summarizeFileOps,
  summarizeFileOpsShort,
  summarizeFileOpsSplit,
} from "../render/file-summary.js";
import { isActiveStatus, renderSubagentTransition, statusKey } from "../render/subagent.js";
import type { PendingStage, SubagentInfo } from "../grok/types.js";
import { ResponseStreamer } from "../stream/streamer.js";
import { IMAGE_OUTPUT_DIRECTIVE } from "../render/image-output.js";
import { collectTurnImagePaths, sendImages } from "./image-return.js";
import { buildContentBlocks, mergeInputs } from "./prompt-content.js";
import { wrapAutoComplexityPrompt } from "./complexity-gate.js";
import {
  autoApproveSuggestions,
  buildSelfRecheckDecisionPrompt,
  buildSelfRecheckPrompt,
  buildSuggestionsPrompt,
  composeSelfRecheckTurn,
  formatBatchedSuggestionsPrompt,
  isSelfRecheckPrompt,
  parseSelfRecheckDecision,
  parseSuggestions,
  type Suggestion,
  suggestionsKeyboard,
} from "./suggestions.js";
import {
  parsePlanUpdate,
  renderPlanMarkdown,
  renderPlanOneLine,
  type PlanEntry,
} from "../render/plan.js";
import {
  buildLastTurnSummary,
  cleanCommentLine,
  cleanUserPreview,
  stepFromThought,
  stepFromToolUpdate,
  stripDirectiveWrappers,
} from "../render/session-comment.js";
import {
  backoffSchedule,
  fmtSeconds,
  formatAccountSwitchNotice,
  formatErrorSummary,
  formatRetryNotice,
  RETRY_BASE_MS,
} from "./prompt-retry.js";
import { sendMarkdownDoc } from "./telegram-io.js";
import { TypingIndicator } from "./typing.js";

const log = createLogger("runtime");

const WATCH_ENTRY_MAX = 700;
const WATCH_ICON: Record<string, string> = {
  user: "\u{1F464}",
  assistant: "\u{1F916}",
  tool: "\u{1F527}",
  system: "\u2139\uFE0F",
};

export type AttachResult = "resumed" | "forked";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Continuation nudge sent to the SAME session to recover from a transient error
 * that struck mid-stream. The partial reply + any completed tool results are
 * already in the session history, so we ask the agent to finish WITHOUT redoing
 * work (which is why we resume rather than re-send the original prompt).
 */
const RESUME_INSTRUCTION =
  "Your previous response was interrupted by a transient service error (the model stream was throttled), " +
  "so your last turn did not finish. Continue from exactly where you stopped and complete the response. " +
  "Do NOT repeat any file edits, commands, or other tool calls you already completed вЂ” their results are " +
  "already in this conversation. If you had already fully answered, just briefly conclude.";

export class SessionRuntime {
  sessionId: string | undefined;
  cwd: string;
  projectName: string | undefined;
  /** Invoked whenever observable state changes (for the status panel). */
  onStateChange: (() => void) | undefined;

  private busy = false;
  private cancelled = false;
  private readonly queue: PromptInput[] = [];
  private streamer: ResponseStreamer | undefined;
  private readonly typing: TypingIndicator;
  private shownToolIds = new Set<string>();
  /** toolCallId → merged snapshot so completed updates keep title/args. */
  private toolCallCache = new Map<string, ToolSnapshot>();
  /** Files touched this turn (path -> operation), tracked even in background so
   *  the completion message can summarise what changed. */
  private fileOps = new Map<string, FileOp>();
  /** The full Done/summary of the most recent finished turn, replayed when you
   *  switch (back) into this session so you see how it ended. */
  private lastCompletion: string | undefined;
  /** Latest task-completion % parsed from the agent's `{progress: N%}` markers,
   *  shown as a bar in the status panel and session cards. Reset each turn. */
  private progress: number | undefined;
  /** Subagent sessionId -> last status key shown this turn (dedupe). */
  private subagentShown = new Map<string, string>();
  private turnStartedAt = 0;
  /** Count of completed (non-cancelled) turns this session вЂ” shown in /usage. */
  private turnCount = 0;
  /** Telegram message id of the current turn's prompt, so replies thread to it. */
  private turnReplyTo: number | undefined;
  private imageScanText = "";
  private sentImagesThisTurn = new Set<string>();
  /** Monotonic count used to reject ACP "success" responses with no turn updates. */
  private sessionUpdateCount = 0;
  private readonly listener: (sessionId: string, update: SessionUpdate) => void;
  private primingContext: string | undefined;
  private watcher: TailWatcher | undefined;
  /** True when the active watch is a transient "follow" of this session's own
   *  in-flight turn (started on switch) rather than an explicit /watch of
   *  another session вЂ” follow-watches are auto-stopped when a new turn streams. */
  private watchIsFollow = false;
  private rebindPending = false;
  private sessionLive = false;
  /** Only the foreground runtime streams to Telegram; background ones stay quiet
   *  (their output lands in the session's .jsonl and shows as "unread" on switch). */
  private foreground = true;
  private readonly restartListener: () => void;
  /** Invoked when this runtime starts/stops a turn (for subagent attribution). */
  onActivity: ((busy: boolean) => void) | undefined;
  /** Invoked when this runtime adopts a *different* session id (new session or
   *  a logical fork), so the owning ChatController can re-persist its controlled
   *  list and mark the new session seen. */
  onSessionChange: (() => void) | undefined;
  /** Optional multi-account rotator: when a turn gives up, cycle through the
   *  other saved logins once and retry on each. Injected by the registry. */
  accountRotator: AccountRotator | undefined;
  /** Session ids that already received the first-prompt auto-complexity directive. */
  private complexitySteered = new Set<string>();
  /** Last credits total reported for this session (for per-turn delta accounting). */
  private lastReportedCredits = 0;
  /** Live "what is happening now" line while a turn is in flight. */
  private liveStep: string | undefined;
  /** Idle card comment (AI/local summary of the chat after the last turn). */
  private sessionComment: string | undefined;
  /** User text of the turn currently running (for local card-comment fallback). */
  private turnUserText = "";
  /** Assistant prose streamed this turn — used to build the idle card summary. */
  private turnAssistantText = "";
  /** Quiet meta capture (suggestions) — never stream to Telegram. */
  private capturingQuiet = false;
  private quietCaptureBuf = "";
  /** Batches of post-turn suggestions for inline-button callbacks. */
  private suggestionBatches = new Map<number, Suggestion[]>();
  private suggestionBatchSeq = 0;
  /**
   * Last successful Done's suggestions — kept so a background "Done from other
   * session" can carry buttons, and so switching back to this session re-shows
   * them even if the user missed the notify (or notify was off).
   */
  private pendingSuggestions:
    | { batchId: number; suggestions: Suggestion[]; banner: string }
    | undefined;
  /** Live ACP plan board for the current turn (done / in-progress / pending). */
  private planEntries: PlanEntry[] | undefined;
  /** True while the active turn is the automatic one-shot self-recheck pass. */
  private isSelfRecheckTurn = false;
  /**
   * Original user prompt (and first-pass assistant text) for suggestions after
   * a self-recheck turn, so follow-ups stay grounded in the real user request.
   */
  private suggestionUserText = "";
  private preRecheckAssistantText = "";
  /** File ops from the first turn, frozen before the self-recheck pass. */
  private preRecheckFileOps = new Map<string, FileOp>();
  /**
   * When true, this turn must not schedule a self-recheck (meta / auto-queue /
   * already-recheck). Set from PromptInput.skipSelfRecheck or recheck marker.
   */
  private skipSelfRecheck = false;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly acp: GrokClient,
    private readonly cfg: AppConfig,
    private readonly settings: SettingsStore,
    init?: { cwd: string; projectName?: string; sessionId?: string },
  ) {
    if (init) {
      this.cwd = init.cwd;
      this.projectName = init.projectName;
      this.sessionId = init.sessionId;
    } else {
      const s = settings.get(chatId);
      this.cwd = s.projectPath ?? cfg.workspace;
      this.projectName = s.projectName;
      this.sessionId = s.sessionId;
    }
    if (this.sessionId) this.rebindPending = true; // lazily reload on first use

    this.typing = new TypingIndicator(api, chatId);
    this.listener = (sid, update) => this.onUpdate(sid, update);
    this.acp.on("session-update", this.listener);
    this.restartListener = () => {
      this.sessionLive = false;
      if (this.sessionId) this.rebindPending = true;
    };
    this.acp.on("restarted", this.restartListener);
  }

  get isBusy(): boolean {
    return this.busy;
  }
  get queueLength(): number {
    return this.queue.length;
  }
  get isWatching(): boolean {
    return this.watcher?.running ?? false;
  }
  get isForeground(): boolean {
    return this.foreground;
  }

  /** The Done/summary of this session's most recent finished turn, if any. */
  get lastTurnSummary(): string | undefined {
    return this.lastCompletion;
  }

  /** Latest task-completion % (0–100) parsed this turn, or undefined if none. */
  get taskProgress(): number | undefined {
    return this.progress;
  }

  /**
   * Full plan board for the live stream / status panel (above the progress bar).
   * Empty when no plan is active this turn.
   */
  get planBoard(): string | undefined {
    if (!this.planEntries?.length) return undefined;
    return renderPlanMarkdown(this.planEntries);
  }

  /** One-line plan summary for compact cards. */
  get planSummary(): string | undefined {
    if (!this.planEntries?.length) return undefined;
    return renderPlanOneLine(this.planEntries);
  }

  /**
   * Pending post-turn suggestions for switch replay / Done markup.
   * Returns text + keyboard without clearing (taps still resolve via batch id).
   */
  peekPendingSuggestions():
    | { text: string; markup: InlineKeyboard; batchId: number }
    | undefined {
    const p = this.pendingSuggestions;
    if (!p?.suggestions.length) return undefined;
    return {
      text: p.banner,
      markup: suggestionsKeyboard(p.batchId, p.suggestions),
      batchId: p.batchId,
    };
  }

  /**
   * One-line status for Running/Sessions cards:
   * live step while busy, otherwise the last chat summary / comment.
   */
  get cardComment(): string | undefined {
    if (this.busy && this.liveStep) return this.liveStep;
    if (this.sessionComment) return this.sessionComment;
    if (this.sessionId) return this.acp.sessionComment(this.sessionId);
    return undefined;
  }

  /** Record a new progress value and refresh the status panel / cards. The bar
   *  is monotonic within a turn (it's reset to undefined when a new turn starts),
   *  so a streamer recreated mid-turn can't make it jump backwards. */
  private setProgress(pct: number): void {
    const next = Math.max(this.progress ?? 0, pct);
    if (next === this.progress) return;
    this.progress = next;
    this.changed();
  }

  /** Update the live step shown on session cards (throttled by equality). */
  private setLiveStep(step: string | undefined): void {
    const next = step?.trim() ? cleanCommentLine(step) : undefined;
    if (next === this.liveStep) return;
    this.liveStep = next;
    this.changed();
  }

  /** Persist idle card comment (disk + memory) so /running and /sessions see it. */
  private setSessionComment(comment: string | undefined): void {
    const next = comment?.trim() ? cleanCommentLine(comment) : undefined;
    if (next === this.sessionComment) return;
    this.sessionComment = next;
    if (next && this.sessionId) {
      try {
        this.acp.setSessionComment(this.sessionId, next);
      } catch {
        /* non-fatal */
      }
    }
    this.changed();
  }

  /** Hydrate comment from disk after bind/resume. */
  private loadPersistedComment(): void {
    if (!this.sessionId) return;
    const c = this.acp.sessionComment(this.sessionId);
    if (c) this.sessionComment = c;
  }

  /** Searchable hashtag footer for this session (project В· session В· model В·
   *  reasoning) вЂ” appended to every AI-output surface for this session. */
  get tags(): string {
    return this.hashtags();
  }

  /** Switch live-streaming on/off. Going background seals any in-flight turn;
   *  returning to the foreground while a turn is still running resumes RICH
   *  live streaming (thinking / tools / prose) rather than a degraded tail. */
  async setForeground(value: boolean): Promise<void> {
    if (this.foreground === value) return;
    this.foreground = value;
    if (value) {
      // A turn was started here and is still in flight, but its streamer was
      // finalized when we went background. Recreate it and let onUpdate feed
      // the remaining chunks/thoughts/tools just like a normal live turn вЂ” we
      // own the agent's session/update events, so no tail-watch is needed.
      if (this.busy && !this.streamer) {
        // Any transient follow-watch of this session is now superseded.
        if (this.watchIsFollow) this.stopWatch();
        this.streamer = new ResponseStreamer(this.api, this.chatId, this.cfg.streamThrottleMs, this.turnReplyTo, this.hashtags(), (pct) => this.setProgress(pct), this.cfg.progressFallback, this.turnStartedAt);
        // Restore the live plan board so steps stay visible above the progress bar.
        if (this.planEntries?.length) {
          this.streamer.setPlan(renderPlanMarkdown(this.planEntries));
        }
        this.typing.start();
      }
    } else {
      this.typing.stop();
      this.stopWatch();
      if (this.streamer) {
        // Finalize off the critical path so project/session switches never wait
        // on Telegram edits of the previous live stream.
        const prev = this.streamer;
        this.streamer = undefined;
        void prev.finalize().catch(() => {});
      }
    }
    this.changed();
  }
  get reasoning(): ReasoningEffort {
    return this.settings.get(this.chatId).reasoning;
  }
  get agent(): string | undefined {
    return this.settings.get(this.chatId).agent;
  }
  get model(): string | undefined {
    return this.settings.get(this.chatId).model;
  }

  /** Latest context-usage % / effort / credits for the current session. */
  contextInfo(): SessionMetadata | undefined {
    return this.acp.metadataFor(this.sessionId);
  }

  /** Number of turns (prompts) this runtime has completed this session. */
  get turns(): number {
    return this.turnCount;
  }

  dispose(): void {
    this.acp.off("session-update", this.listener);
    this.acp.off("restarted", this.restartListener);
    this.typing.stop();
    this.stopWatch();
  }

  // в”Ђв”Ђ sessions в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

  async startNewSession(cwd: string, projectName?: string): Promise<void> {
    await this.accountRotator?.waitForIdle();
    if (this.busy) await this.cancel();
    await this.bindNewSession(cwd, projectName);
  }

  /**
   * Create a fresh live session and adopt it. Does NOT cancel an in-flight turn
   * (the caller decides), so the auto-fork-on-error path can swap to a clean
   * session mid-turn without flagging the turn as user-cancelled.
   */
  private async bindNewSession(cwd: string, projectName?: string): Promise<void> {
    this.stopWatch();
    this.sessionId = await this.acp.newSession(cwd);
    this.sessionLive = true;
    this.rebindPending = false;
    this.cwd = cwd;
    this.projectName = projectName;
    this.turnCount = 0;
    this.lastReportedCredits = 0;
    this.liveStep = undefined;
    this.sessionComment = undefined;
    await this.applySessionPrefs();
    this.persist();
    this.sessionChanged();
    log.info(`chat ${this.chatId} -> new session ${this.sessionId} @ ${cwd}`);
    this.changed();
  }

  /** Ensure a session is live in the current ACP process (used before menus). */
  async prepare(): Promise<void> {
    await this.ensureSession();
  }

  async resumeSession(sessionId: string, cwd: string, projectName?: string): Promise<void> {
    if (!this.acp.supportsLoadSession) {
      throw new Error("This Grok CLI build does not support loading sessions.");
    }
    if (this.busy) await this.cancel();
    this.stopWatch();
    await this.acp.loadSession(sessionId, cwd);
    this.sessionId = sessionId;
    this.sessionLive = true;
    this.rebindPending = false;
    this.cwd = cwd;
    this.projectName = projectName;
    this.loadPersistedComment();
    this.persist();
    log.info(`chat ${this.chatId} -> resumed session ${sessionId} @ ${cwd}`);
    this.changed();
  }

  async attach(
    sessionId: string,
    cwd: string,
    projectName: string | undefined,
    priorEntries: HistoryEntry[],
  ): Promise<AttachResult> {
    try {
      await this.resumeSession(sessionId, cwd, projectName);
      return "resumed";
    } catch (err) {
      log.warn(`load failed (${(err as Error).message}); forking ${sessionId.slice(0, 8)}`);
      await this.startNewSession(cwd, projectName);
      if (priorEntries.length > 0) this.primingContext = buildPriming(buildTranscript(priorEntries));
      return "forked";
    }
  }

  /**
   * Start a brand-new Grok session primed with a full foreign transcript
   * (import from Kiro / OpenCode / Claude / Codex). Priming is applied on the
   * next {@link submit} so the imported context becomes part of Grok's history.
   */
  async startImportedSession(cwd: string, projectName: string | undefined, priming: string): Promise<void> {
    await this.startNewSession(cwd, projectName);
    if (priming.trim()) this.primingContext = priming;
    // Imported transcripts already have context — skip first-prompt complexity steering.
    this.markComplexitySteered();
  }

  startWatch(jsonlPath: string, follow = false): void {
    this.stopWatch();
    this.watchIsFollow = follow;
    this.watcher = new TailWatcher(jsonlPath, (entries) => void this.onWatchEntries(entries));
    this.watcher.start(true);
  }

  stopWatch(): boolean {
    if (!this.watcher) return false;
    this.watcher.stop();
    this.watcher = undefined;
    this.watchIsFollow = false;
    return true;
  }

  // в”Ђв”Ђ preferences в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

  async setModelPref(modelId: string): Promise<{ ok: boolean; error?: string }> {
    // Persist the choice always; only talk to Grok when a session is live in
    // the current process (set_model on an unloaded session crashes the agent).
    this.settings.update(this.chatId, { model: modelId });
    if (modelId && this.sessionLive && this.sessionId) {
      if (!this.acp.hasModel(modelId)) return { ok: false, error: `unknown model: ${modelId}` };
      try {
        await this.acp.setModel(this.sessionId, modelId);
      } catch (e) {
        this.changed();
        return { ok: false, error: (e as Error).message };
      }
    }
    this.changed();
    return { ok: true };
  }

  async setAgentPref(agent: string): Promise<void> {
    this.settings.update(this.chatId, { agent });
    if (agent && this.sessionLive && this.sessionId && this.acp.hasMode(agent)) {
      try {
        await this.acp.setMode(this.sessionId, agent);
      } catch (e) {
        log.warn(`set_mode(${agent}) failed: ${(e as Error).message}`);
      }
    }
    this.changed();
  }

  setReasoningPref(effort: ReasoningEffort): void {
    this.settings.update(this.chatId, { reasoning: effort });
    this.changed();
  }

  private async applySessionPrefs(): Promise<void> {
    const s = this.settings.get(this.chatId);
    // Drop any persisted model the agent doesn't actually offer (an unknown id
    // is silently accepted by set_model but then breaks the next prompt).
    if (s.model && !this.acp.hasModel(s.model)) {
      log.warn(`clearing invalid persisted model "${s.model}" for chat ${this.chatId}`);
      this.settings.update(this.chatId, { model: "" });
    }
    const cur = this.settings.get(this.chatId);
    // Adopt the session's current agent (mode) when the user hasn't chosen one.
    if (!cur.agent && this.acp.currentModeId) {
      this.settings.update(this.chatId, { agent: this.acp.currentModeId });
    } else if (this.sessionId && cur.agent && this.acp.hasMode(cur.agent) && cur.agent !== this.acp.currentModeId) {
      try {
        await this.acp.setMode(this.sessionId, cur.agent);
      } catch (e) {
        log.debug(`apply agent failed: ${(e as Error).message}`);
      }
    }
    if (this.sessionId && cur.model && this.acp.hasModel(cur.model)) {
      try {
        await this.acp.setModel(this.sessionId, cur.model);
      } catch (e) {
        log.debug(`apply model failed: ${(e as Error).message}`);
      }
    }
  }

  // ── prompting ────────────────────────────────────────────────────────────

  async submit(input: PromptInput): Promise<"ran" | "queued"> {
    await this.ensureSession();
    if (this.busy) {
      this.queue.push(input);
      this.changed();
      return "queued";
    }
    // First prompt of a fresh session: steer the agent to decide complexity
    // itself (plan if complex, implement if simple) — never ask the user.
    let toRun = input;
    if (this.shouldSteerComplexity()) {
      toRun = wrapAutoComplexityPrompt(input);
      this.markComplexitySteered();
      log.info(`chat ${this.chatId}: first-prompt auto-complexity steering applied`);
    }
    void this.runTurn(toRun);
    return "ran";
  }

  private markComplexitySteered(): void {
    if (this.sessionId) this.complexitySteered.add(this.sessionId);
  }

  /**
   * Apply auto-complexity directive only on the first prompt of a brand-new
   * conversation (no prior user turns in this process / session jsonl).
   */
  private shouldSteerComplexity(): boolean {
    if (!this.sessionId) return false;
    if (this.complexitySteered.has(this.sessionId)) return false;
    if (this.turnCount > 0) return false;
    try {
      const path = join(this.cfg.sessionsDir, `${this.sessionId}.jsonl`);
      const hist = readHistory(path, 8);
      if (hist.some((e) => e.role === "user" && e.text.trim().length > 0)) {
        this.complexitySteered.add(this.sessionId);
        return false;
      }
    } catch {
      /* treat as fresh */
    }
    return true;
  }

  async cancel(): Promise<boolean> {
    if (!this.busy || !this.sessionId) return false;
    this.cancelled = true;
    await this.acp.cancel(this.sessionId);
    return true;
  }

  clearQueue(): number {
    const n = this.queue.length;
    this.queue.length = 0;
    this.changed();
    return n;
  }

  drainQueueToPrompt(): PromptInput | undefined {
    if (this.queue.length === 0) return undefined;
    return mergeInputs(this.queue.splice(0, this.queue.length));
  }

  private async ensureSession(): Promise<void> {
    // Account rotation restarts the process globally. Do not bind a new chat
    // to a candidate account until the owner has finished probing it.
    await this.accountRotator?.waitForIdle();
    if (this.rebindPending && this.sessionId) {
      // The ACP process is frequently mid-restart the first time we re-bind
      // (auto-restart after a crash, or a fresh bot boot), so a single attempt
      // is flaky. Retry briefly before giving up.
      if (await this.rebindWithRetries(this.sessionId)) {
        this.sessionLive = true;
        this.rebindPending = false;
        await this.applySessionPrefs();
        log.info(`chat ${this.chatId} re-bound session ${this.sessionId.slice(0, 8)}`);
        return;
      }
      // The session genuinely can't be reloaded (its exclusive lock is held,
      // or its log/metadata is gone). Never silently drop the conversation:
      // fork a linked continuation primed with the recent transcript so the
      // thread survives вЂ” including any question the agent had just asked.
      // forkFromLostSession() only throws if the agent is fully down, in which
      // case we leave rebindPending set so the next message retries cleanly.
      await this.forkFromLostSession(this.sessionId);
      this.rebindPending = false;
      return;
    }
    if (!this.sessionId) await this.startNewSession(this.cwd, this.projectName);
  }

  /** Reload a persisted session, retrying flaky failures with a short backoff.
   *  Returns true once loaded, false after the attempts are exhausted. */
  private async rebindWithRetries(sessionId: string, attempts = 4): Promise<boolean> {
    const delays = [400, 1200, 3000]; // ~4.6s total before giving up
    for (let i = 0; i < attempts; i++) {
      try {
        await this.acp.loadSession(sessionId, this.cwd);
        this.loadPersistedComment();
        return true;
      } catch (err) {
        log.warn(
          `re-bind ${sessionId.slice(0, 8)} attempt ${i + 1}/${attempts} failed: ${(err as Error).message}`,
        );
        if (i === attempts - 1) return false;
        await sleep(delays[Math.min(i, delays.length - 1)]!);
      }
    }
    return false;
  }

  /** Continue a session we could not reload by forking a fresh one primed with
   *  the lost session's recent transcript, so no context is dropped. */
  private async forkFromLostSession(lostId: string): Promise<void> {
    const transcript = recentTranscript(this.cfg.sessionsDir, lostId);
    log.warn(
      `chat ${this.chatId} could not reload ${lostId.slice(0, 8)}; forking a linked continuation` +
        (transcript ? " (primed with recent transcript)" : ""),
    );
    await this.startNewSession(this.cwd, this.projectName); // sets a fresh, live sessionId
    if (transcript) this.primingContext = buildPriming(transcript);
    if (this.foreground) {
      await this.notify(
        transcript
          ? "\u{1F517} Couldn't reopen the previous session, so I started a linked continuation primed with the recent transcript \u2014 we can keep going from where we left off."
          : "\u{1F517} Couldn't reopen the previous session, so I started a fresh one here.",
      );
    }
  }

  private async runTurn(input: PromptInput): Promise<void> {
    this.busy = true;
    this.cancelled = false;
    this.turnReplyTo = input.replyTo;
    this.turnUserText = input.text;
    this.turnAssistantText = "";
    this.isSelfRecheckTurn = isSelfRecheckPrompt(input.text);
    // Meta turns (recheck, auto-suggestion batches) never arm another recheck.
    this.skipSelfRecheck = !!input.skipSelfRecheck || this.isSelfRecheckTurn;
    // Fresh user work resets suggestion anchors; recheck keeps the original ask.
    // Strip complexity/reply wrappers so suggestions + recheck see the real ask.
    if (!this.isSelfRecheckTurn) {
      this.suggestionUserText = stripDirectiveWrappers(input.text) || input.text;
      this.preRecheckAssistantText = "";
      this.preRecheckFileOps = new Map();
    }
    this.shownToolIds = new Set();
    this.toolCallCache = new Map();
    this.fileOps = new Map();
    this.subagentShown = new Map();
    this.progress = undefined; // a new turn = a new task; clear the old bar
    this.planEntries = undefined; // plan board is per-turn
    this.pendingSuggestions = undefined; // new work supersedes previous Done suggestions
    this.setLiveStep(
      this.isSelfRecheckTurn
        ? "Self-recheck: hunting bugs / incomplete logic\u2026"
        : input.text.trim()
          ? `Working: ${cleanUserPreview(input.text, 110)}`
          : input.images.length
            ? "Working on attached image(s)\u2026"
            : "Working\u2026",
    );
    // A new streamed turn supersedes any transient "follow" watch of this same
    // session's previous in-flight turn (avoids duplicated output).
    if (this.watchIsFollow) this.stopWatch();
    const live = this.foreground;
    const startedAt = Date.now();
    this.turnStartedAt = startedAt;
    this.streamer = live
      ? new ResponseStreamer(this.api, this.chatId, this.cfg.streamThrottleMs, this.turnReplyTo, this.hashtags(), (pct) => this.setProgress(pct), this.cfg.progressFallback, startedAt)
      : undefined;
    if (live) this.typing.start();
    this.activity(true);
    this.changed();
    this.imageScanText = "";
    this.sentImagesThisTurn = new Set();

    const content = buildContentBlocks(input, {
      reasoning: reasoningDirective(this.reasoning),
      priming: this.primingContext,
      imageOutput: this.cfg.sendAgentImages ? IMAGE_OUTPUT_DIRECTIVE : undefined,
      progress: this.cfg.showProgress ? PROGRESS_DIRECTIVE : undefined,
    });
    this.primingContext = undefined;

    try {
      const outcome = await this.runPromptWithRetries(content);
      const rebound = await this.maybeRecoverAgentSession(input, outcome);
      let final = rebound ?? outcome;
      const recovered = await this.maybeAutoFork(input, final);
      final = recovered ?? final;
      // Last resort: if the turn still failed, rotate through other saved
      // accounts (once) and retry on each until one works.
      const rotated = await this.maybeRotateAccount(input, final);
      if (rotated) final = rotated;
      // A transient error that struck AFTER streaming began skips the paths
      // above (they must not re-run already-executed tools). Recover by asking
      // the SAME session to CONTINUE from where it stopped, with backoff.
      const resumed = await this.maybeResumeAfterStream(final);
      if (resumed) final = resumed;
      const streamedOutput = this.streamer?.hasOutput ?? false;
      // On a successful, non-cancelled turn, top the fallback bar up to 100 (a
      // no-op when the agent reported its own progress — its value is kept).
      if (final.result && !this.cancelled) this.streamer?.completeFallback();
      if (this.streamer) await this.streamer.finalize();
      if (this.foreground) await this.sendTurnImages();
      // Always build the completion (records `lastCompletion` so switching back
      // to this session can replay its Done + summary). Only PING the chat for
      // the foreground turn, or a background turn when NOTIFY_OTHER_SESSIONS is on.
      const canPing = this.foreground || this.cfg.notifyOtherSessions;
      // A background session about to run a queued follow-up shouldn't ping its
      // interim "Done" — only the final, queue-empty turn announces completion.
      const hasQueued = this.queue.length > 0;
      const switchKb = this.switchKeyboard();
      if (final.result && !this.cancelled) {
        this.turnCount++;
        // Persist real per-account usage (turns + reported credits) for /accounts and /usage.
        this.recordAccountUsage();
        // Card comment: what this turn solved (assistant result + files) — no extra agent call.
        this.setSessionComment(
          buildLastTurnSummary({
            userText: this.turnUserText,
            assistantText: this.turnAssistantText,
            fileOps: this.fileOps,
            stopReason: final.result.stopReason,
          }),
        );
        this.setLiveStep(undefined);
      } else if (this.cancelled) {
        this.setSessionComment(
          buildLastTurnSummary({
            userText: this.turnUserText,
            assistantText: this.turnAssistantText,
            fileOps: this.fileOps,
            cancelled: true,
          }),
        );
        this.setLiveStep(undefined);
      } else if (final.error) {
        this.setSessionComment(
          buildLastTurnSummary({
            userText: this.turnUserText,
            assistantText: this.turnAssistantText,
            fileOps: this.fileOps,
            error: final.error.message,
          }),
        );
        this.setLiveStep(undefined);
      }
      if (final.result || this.cancelled) {
        const liveMsg = this.completionMessage(final.result?.stopReason, startedAt, streamedOutput);
        const pingDone = canPing && (this.foreground || !hasQueued);

        // One-shot self-recheck: only after a real *user* turn (not meta/auto),
        // with idle queue. skipSelfRecheck blocks loops after recheck / auto-batch.
        // Also skipped when no files were modified, or when a quiet AI decision
        // refuses (simple tasks, pure build, nothing worth re-verifying).
        const wantSelfRecheck =
          !!final.result &&
          !this.cancelled &&
          !hasQueued &&
          this.cfg.selfRecheckEnabled &&
          !this.skipSelfRecheck &&
          !this.isSelfRecheckTurn;

        let queuedRecheck = false;
        if (wantSelfRecheck) {
          this.preRecheckAssistantText = this.turnAssistantText;
          // Strip COMPLEXITY wrapper so recheck + suggestions see the real ask.
          this.suggestionUserText = stripDirectiveWrappers(this.turnUserText) || this.turnUserText;
          this.preRecheckFileOps = cloneFileOps(this.fileOps);
          this.setLiveStep("Deciding if self-recheck is needed\u2026");
          this.changed();
          const recheck = await this.maybePlanSelfRecheck();
          this.setLiveStep(undefined);
          // User may cancel during the quiet decision call — first turn still
          // succeeded; never queue a recheck after cancel.
          if (this.cancelled) {
            this.preRecheckFileOps = new Map();
            this.preRecheckAssistantText = "";
          } else if (recheck) {
            queuedRecheck = true;
            // Front of queue; mark skip so the recheck turn never re-arms itself.
            this.queue.unshift(
              textPrompt(recheck, this.turnReplyTo, undefined, { skipSelfRecheck: true }),
            );
            this.changed();
            if (pingDone) {
              // Interim status + first-turn file list (final Done comes after recheck).
              const firstFiles = summarizeFileOps(this.preRecheckFileOps, this.cwd);
              await this.notify(
                `\u{1F50D} Self-recheck \u2014 bugs, logic gaps, related follow-through (once)\u2026\n\n` +
                  `\u{1F4C1} After first turn\n${firstFiles}`,
                { loud: true, replyTo: this.turnReplyTo, replyMarkup: switchKb },
              );
            }
          } else {
            // No recheck — clear frozen first-turn ops (nothing to split later).
            this.preRecheckFileOps = new Map();
            this.preRecheckAssistantText = "";
          }
        }

        if (!queuedRecheck) {
          // Post-turn suggestions on successful, non-cancelled Done with idle queue —
          // both foreground and background (so switch-to-session can re-show them).
          let doneMarkup = switchKb;
          // After a recheck pass, rebuild Done with split first-turn / recheck files.
          let doneText = this.isSelfRecheckTurn
            ? this.completionMessageSplit(final.result?.stopReason, startedAt, streamedOutput)
            : liveMsg;
          if (final.result && !this.cancelled && !hasQueued) {
            const sug = await this.collectAndApplySuggestions(doneText, switchKb, {
              // Only auto-queue high-need follow-ups when the user is watching;
              // background sessions store buttons for the Done ping / switch replay.
              autoQueue: this.foreground,
            });
            doneText = sug.text;
            doneMarkup = sug.markup;
          }
          if (pingDone) await this.notify(doneText, { loud: true, replyTo: this.turnReplyTo, replyMarkup: doneMarkup });
          // Clear frozen first-turn ops after final Done (recheck path done).
          if (this.isSelfRecheckTurn) this.preRecheckFileOps = new Map();
        }
      } else if (final.error) {
        // If the self-recheck pass itself failed, still surface Done for the
        // original work (split files + suggestions) so the user is not stuck.
        if (this.isSelfRecheckTurn && !hasQueued) {
          const switchKb = this.switchKeyboard();
          const pingDone = canPing && (this.foreground || !hasQueued);
          let doneText =
            this.completionMessageSplit(undefined, startedAt, streamedOutput) +
            `\n\n\u26A0\uFE0F Self-recheck failed: ${final.error.message}`;
          if (!this.cancelled) {
            const sug = await this.collectAndApplySuggestions(doneText, switchKb, {
              autoQueue: this.foreground,
            });
            doneText = sug.text;
            if (pingDone) {
              await this.notify(doneText, {
                loud: true,
                replyTo: this.turnReplyTo,
                replyMarkup: sug.markup,
              });
            }
          } else if (pingDone) {
            await this.notify(doneText, { loud: true, replyTo: this.turnReplyTo, replyMarkup: switchKb });
          }
          this.preRecheckFileOps = new Map();
        } else {
          const transient = isTransientError(final.error);
          const liveMsg = this.errorMessage(final.error, startedAt, final.attempts, transient);
          if (canPing) await this.notify(liveMsg, { loud: true, replyTo: this.turnReplyTo, replyMarkup: switchKb });
        }
      }
    } catch (err) {
      // Unexpected failure outside the prompt path (e.g. while finalizing).
      await this.streamer?.finalize().catch(() => {});
      const errMsg = (err as Error).message;
      this.setSessionComment(
        buildLastTurnSummary({
          userText: this.turnUserText,
          assistantText: this.turnAssistantText,
          fileOps: this.fileOps,
          error: errMsg,
        }),
      );
      this.setLiveStep(undefined);
      // If the self-recheck pass itself blew up, still surface Done for the
      // original work (split files + suggestions) so the user is not stuck.
      if (this.isSelfRecheckTurn && this.queue.length === 0) {
        const switchKb = this.switchKeyboard();
        const canPing = this.foreground || this.cfg.notifyOtherSessions;
        let doneText =
          this.completionMessageSplit(undefined, startedAt, this.streamer?.hasOutput ?? false) +
          `\n\n\u26A0\uFE0F Self-recheck failed: ${errMsg}`;
        try {
          if (!this.cancelled) {
            const sug = await this.collectAndApplySuggestions(doneText, switchKb, {
              autoQueue: this.foreground,
            });
            doneText = sug.text;
            if (canPing) {
              await this.notify(doneText, {
                loud: true,
                replyTo: this.turnReplyTo,
                replyMarkup: sug.markup,
              });
            }
          } else if (canPing) {
            await this.notify(doneText, {
              loud: true,
              replyTo: this.turnReplyTo,
              replyMarkup: switchKb,
            });
          }
        } catch (e2) {
          log.debug(`recheck catch recovery failed: ${(e2 as Error).message}`);
          if (canPing) {
            await this.notify(doneText, {
              loud: true,
              replyTo: this.turnReplyTo,
              replyMarkup: switchKb,
            }).catch(() => {});
          }
        }
        this.preRecheckFileOps = new Map();
      } else {
        const msg = `\u274C Error after ${fmtDuration(Date.now() - startedAt)}: ${errMsg}`;
        this.lastCompletion = msg;
        if (this.foreground || this.cfg.notifyOtherSessions) {
          const from = this.foreground ? "" : `\u{1F4E8} From other session ${this.sessionTag()}\n`;
          await this.notify(`${from}${msg}`, {
            loud: true,
            replyTo: this.turnReplyTo,
            replyMarkup: this.switchKeyboard(),
          });
        }
      }
    } finally {
      this.typing.stop();
      this.streamer = undefined;
      this.capturingQuiet = false;
      this.quietCaptureBuf = "";
      this.busy = false;
      this.activity(false);
      // The in-flight turn we may have been following live is over.
      if (this.watchIsFollow) this.stopWatch();
      // Turn ended (done / stopped / error): drop the live task-progress value so
      // the bar is removed from the status panel, session cards and switch
      // messages. The finished streamed bubble keeps its own (frozen) bar.
      this.progress = undefined;
      this.planEntries = undefined;
      // Prefer stored summary on cards once idle (clear live step if still set).
      if (!this.liveStep || this.sessionComment) this.liveStep = undefined;
      this.changed();
    }

    await this.flushQueue();
  }

  private activity(busy: boolean): void {
    try {
      this.onActivity?.(busy);
    } catch {
      /* non-fatal */
    }
  }

  /**
   * Quietly ask for 1–3 follow-ups, attach buttons to the Done text, store them
   * for switch-replay, and optionally queue auto-approved items as **one**
   * numbered multi-step prompt (`1) …\n2) …`).
   */
  private async collectAndApplySuggestions(
    doneText: string,
    switchKb: InlineKeyboard | undefined,
    opts?: { autoQueue?: boolean },
  ): Promise<{ text: string; markup?: InlineKeyboard }> {
    if (!this.cfg.suggestionsEnabled || !this.sessionId) {
      return { text: doneText, markup: switchKb };
    }
    let suggestions: Suggestion[] = [];
    try {
      suggestions = await this.fetchSuggestionsQuiet();
    } catch (e) {
      log.debug(`suggestions fetch failed: ${(e as Error).message}`);
    }
    if (suggestions.length === 0) return { text: doneText, markup: switchKb };

    const batchId = ++this.suggestionBatchSeq;
    this.suggestionBatches.set(batchId, suggestions);
    // Bound memory: keep last ~20 batches.
    if (this.suggestionBatches.size > 20) {
      const oldest = [...this.suggestionBatches.keys()].sort((a, b) => a - b)[0]!;
      this.suggestionBatches.delete(oldest);
    }

    const thr = this.cfg.suggestionsAutoApprovePct;
    const autoQueue = opts?.autoQueue !== false;
    const auto = autoQueue ? autoApproveSuggestions(suggestions, thr) : [];
    let text = doneText;
    let banner: string;
    if (auto.length > 0) {
      const batched = formatBatchedSuggestionsPrompt(auto);
      const lines = auto.map((s, i) => `  ${i + 1}) ${s.need}% \u2014 ${s.text}`);
      const autoBlock =
        `\n\n\u{1F4A1} Auto-running ${auto.length} suggestion${auto.length === 1 ? "" : "s"}` +
        ` as one prompt (\u2265 ${thr}% need):\n${lines.join("\n")}`;
      text += autoBlock;
      banner = `\u{1F4A1} Suggestions (auto-running ${auto.length} as one prompt):\n${lines.join("\n")}`;
      // Single queue entry — agent executes 1) 2) 3) in one turn.
      // skipSelfRecheck: auto-follow-ups must not arm another recheck cycle.
      this.queue.push(textPrompt(batched, this.turnReplyTo, undefined, { skipSelfRecheck: true }));
      this.changed();
    } else {
      text += "\n\n\u{1F4A1} Suggestions \u2014 tap one to continue:";
      banner = "\u{1F4A1} Suggestions \u2014 tap one to continue:";
    }

    // Keep for switch-to-session replay (and for Done pings that already include
    // the same keyboard). Cleared when a new turn starts.
    this.pendingSuggestions = { batchId, suggestions, banner };

    const markup = suggestionsKeyboard(batchId, suggestions, switchKb);
    return { text, markup };
  }

  /**
   * Decide whether to queue a self-recheck turn.
   * - Hard skip when no files were modified this turn.
   * - Quiet AI decision: refuse (simple / not needed) or write recheck prompt.
   * - Returns the full recheck turn text, or undefined to skip.
   */
  private async maybePlanSelfRecheck(): Promise<string | undefined> {
    if (this.fileOps.size === 0) {
      log.info(`chat ${this.chatId}: self-recheck skipped (no files modified)`);
      return undefined;
    }
    if (this.cancelled) return undefined;
    const user =
      this.suggestionUserText ||
      stripDirectiveWrappers(this.turnUserText) ||
      this.turnUserText;
    const did = this.turnAssistantText;
    const files = summarizeFileOpsShort(this.fileOps);

    let decision;
    try {
      decision = await this.fetchSelfRecheckDecisionQuiet(user, did, files);
    } catch (e) {
      log.debug(`self-recheck decision failed: ${(e as Error).message}; skipping`);
      return undefined;
    }
    if (this.cancelled) return undefined;
    if (!decision.needed) {
      log.info(
        `chat ${this.chatId}: self-recheck skipped by agent` +
          (decision.reason ? ` (${decision.reason})` : ""),
      );
      return undefined;
    }

    // Optional env template overrides the AI-written body when set.
    if (this.cfg.selfRecheckPrompt) {
      return buildSelfRecheckPrompt(user, did, this.cfg.selfRecheckPrompt);
    }
    if (decision.prompt.trim()) {
      return composeSelfRecheckTurn(decision.prompt, user, did);
    }
    // needed=true but empty prompt — fall back to built-in default template.
    return buildSelfRecheckPrompt(user, did);
  }

  /** Quiet JSON: should we recheck, and if so what prompt? Never streams. */
  private async fetchSelfRecheckDecisionQuiet(
    user: string,
    did: string,
    filesSummary: string,
  ): Promise<ReturnType<typeof parseSelfRecheckDecision>> {
    if (!this.sessionId) return { needed: false, reason: "no session" };
    const prompt = buildSelfRecheckDecisionPrompt(user, did, filesSummary);
    this.capturingQuiet = true;
    this.quietCaptureBuf = "";
    try {
      await this.acp.prompt(this.sessionId, [{ type: "text", text: prompt }]);
      return parseSelfRecheckDecision(this.quietCaptureBuf);
    } finally {
      this.capturingQuiet = false;
      this.quietCaptureBuf = "";
    }
  }

  /** Quiet JSON suggestion turn — never streams to Telegram. */
  private async fetchSuggestionsQuiet(): Promise<Suggestion[]> {
    if (!this.sessionId) return [];
    // Prefer the original user ask (before self-recheck) so need scores stay honest.
    const user =
      this.suggestionUserText ||
      stripDirectiveWrappers(this.turnUserText) ||
      this.turnUserText;
    const didParts = [this.preRecheckAssistantText, this.turnAssistantText].filter((s) => s?.trim());
    const did = didParts.join("\n") || this.turnAssistantText;
    const prompt = buildSuggestionsPrompt(user, did);
    this.capturingQuiet = true;
    this.quietCaptureBuf = "";
    try {
      await this.acp.prompt(this.sessionId, [{ type: "text", text: prompt }]);
      return parseSuggestions(this.quietCaptureBuf);
    } finally {
      this.capturingQuiet = false;
      this.quietCaptureBuf = "";
    }
  }

  /** Resolve a tapped suggestion button; returns the prompt text or undefined. */
  takeSuggestion(batchId: number, index: number): string | undefined {
    const batch = this.suggestionBatches.get(batchId);
    if (!batch) return undefined;
    const s = batch[index];
    if (!s) return undefined;
    return s.text;
  }

  /** Attribute a finished turn's credits/context to the active saved account. */
  private recordAccountUsage(): void {
    const meta = this.contextInfo();
    // Grok's metadata credits are typically a running session total — store the
    // per-turn delta so /accounts totals stay accurate across many turns.
    let turnCredits: number | undefined;
    if (typeof meta?.credits === "number" && Number.isFinite(meta.credits)) {
      const delta = meta.credits - this.lastReportedCredits;
      turnCredits = delta > 0 ? delta : meta.credits > 0 && this.lastReportedCredits === 0 ? meta.credits : undefined;
      if (meta.credits >= this.lastReportedCredits) this.lastReportedCredits = meta.credits;
      else this.lastReportedCredits = meta.credits; // reset if agent restarted counters
    }
    try {
      this.accountRotator?.recordTurnUsage({
        credits: turnCredits,
        contextPct: meta?.contextUsagePercentage,
      });
    } catch {
      /* non-fatal */
    }
  }

  /**
   * Show subagent ("crew") status transitions for the given (already
   * chat-attributed) subagents, so the user sees progress while the main agent
   * waits on them. No-op unless this runtime is the live foreground turn.
   */
  renderSubagents(subagents: SubagentInfo[], _pending: PendingStage[]): void {
    if (!this.cfg.showSubagents) return;
    if (!this.foreground || !this.busy || !this.streamer) return;
    for (const s of subagents) {
      const key = statusKey(s);
      const prev = this.subagentShown.get(s.sessionId);
      if (prev === key) continue;
      const kind: "start" | "status" = prev === undefined && isActiveStatus(key) ? "start" : "status";
      this.subagentShown.set(s.sessionId, key);
      const md = renderSubagentTransition(s, kind);
      if (md) this.streamer.addTool(md);
    }
  }

  /**
   * True when a prompt failure is attributable to an exhausted context window вЂ”
   * either the error message says so, or this session's last-known context
   * usage is at/above the configured fork threshold. Such failures won't clear
   * by retrying the same oversized prompt (throttling on a near-full session
   * surfaces as a plain "-32603 вЂ¦ throttled"), so the session must be compacted
   * by forking a fresh, smaller continuation.
   */
  private isContextRelatedFailure(error: Error): boolean {
    if (isContextExhaustedError(error)) return true;
    const threshold = this.cfg.autoForkContextPct;
    if (threshold <= 0) return false;
    const pct = this.contextInfo()?.contextUsagePercentage;
    return pct !== undefined && pct >= threshold;
  }

  /** A shared-process restart invalidates this runtime's ACP session binding,
   * but says nothing about account health. Wait for any account probe to
   * settle, re-bind/fork this chat on the selected account, and retry once. */
  private async maybeRecoverAgentSession(
    input: PromptInput,
    outcome: { result?: PromptResult; error?: Error; attempts: number },
  ): Promise<{ result?: PromptResult; error?: Error; attempts: number } | undefined> {
    if (
      !outcome.error ||
      !isSessionLifecycleError(outcome.error) ||
      this.cancelled ||
      (this.streamer?.hasOutput ?? false)
    ) {
      return undefined;
    }
    try {
      await this.accountRotator?.waitForIdle();
      if (this.cancelled) return outcome;
      const previousId = this.sessionId;
      this.sessionLive = false;
      this.rebindPending = Boolean(previousId);
      await this.ensureSession();
      this.shownToolIds = new Set();
      this.subagentShown = new Map();
      this.streamer?.setFooter(this.hashtags());
      const retryContent = buildContentBlocks(input, {
        reasoning: reasoningDirective(this.reasoning),
        priming: this.primingContext,
        imageOutput: this.cfg.sendAgentImages ? IMAGE_OUTPUT_DIRECTIVE : undefined,
        progress: this.cfg.showProgress ? PROGRESS_DIRECTIVE : undefined,
      });
      this.primingContext = undefined;
      log.info(
        `chat ${this.chatId} recovered lifecycle error on the active account` +
          (previousId && this.sessionId !== previousId
            ? ` with fresh session ${this.sessionId?.slice(0, 8)}`
            : " by re-binding its session"),
      );
      return this.runPromptWithRetries(retryContent);
    } catch (error) {
      log.warn(`chat ${this.chatId} session recovery failed: ${(error as Error).message}`);
      return { error: error as Error, attempts: outcome.attempts };
    }
  }

  /**
   * Auto-fork-on-error recovery. When a turn fails with a *transient* error (or
   * a context-exhaustion error) and nothing was streamed to the user, the
   * session is throttled / context-exhausted / stuck. We "logically fork" it:
   * open a fresh session in the same project primed with the recent transcript
   * (the old session is dropped from this chat), then retry the SAME message
   * once on the clean session. For context-exhausted sessions the retry backoff
   * is skipped upstream so this fires immediately. Returns the retried outcome,
   * or undefined when no fork was attempted.
   */
  private async maybeAutoFork(
    input: PromptInput,
    outcome: { result?: PromptResult; error?: Error; attempts: number },
  ): Promise<{ result?: PromptResult; error?: Error; attempts: number } | undefined> {
    if (!this.cfg.autoForkOnError || !outcome.error || !this.sessionId) return undefined;
    if (this.cancelled || (this.streamer?.hasOutput ?? false)) return undefined;
    const contextRelated = this.isContextRelatedFailure(outcome.error);
    if (!isTransientError(outcome.error) && !contextRelated) return undefined;

    const lostId = this.sessionId;
    const transcript = recentTranscript(this.cfg.sessionsDir, lostId);
    if (this.foreground) {
      const reason = contextRelated
        ? "That session's context looks full \u2014 compacting into a fresh continuation and retrying"
        : "That session looks exhausted or stuck \u2014 forking a fresh continuation and retrying";
      await this.notify(
        `\u26A0\uFE0F ${outcome.error.message}\n\n\u{1F517} ${reason}${transcript ? " (primed with the recent transcript)" : ""}\u2026`,
        { replyTo: this.turnReplyTo },
      );
    }
    try {
      await this.bindNewSession(this.cwd, this.projectName); // new live id; old session dropped
    } catch (e) {
      log.warn(`auto-fork failed (agent down?): ${(e as Error).message}`);
      return undefined;
    }
    log.info(
      `chat ${this.chatId} auto-forked ${lostId.slice(0, 8)} -> ${this.sessionId!.slice(0, 8)} after ${contextRelated ? "context-exhaustion" : "transient"} error`,
    );
    // Reset per-turn render state so the retry streams cleanly on the new session.
    this.shownToolIds = new Set();
    this.subagentShown = new Map();
    this.streamer?.setFooter(this.hashtags()); // streamed reply tags the NEW session
    const forkContent = buildContentBlocks(input, {
      reasoning: reasoningDirective(this.reasoning),
      priming: transcript ? buildPriming(transcript) : undefined,
      imageOutput: this.cfg.sendAgentImages ? IMAGE_OUTPUT_DIRECTIVE : undefined,
      progress: this.cfg.showProgress ? PROGRESS_DIRECTIVE : undefined,
    });
    return this.runPromptWithRetries(forkContent);
  }

  /**
   * Auto-rotate-on-give-up. When a turn has failed (retries exhausted / billing
   * 402 with no same-account retry, auto-fork didn't recover) and nothing was
   * streamed, cycle through the OTHER saved accounts once — each step:
   *   stop Grok CLI → replace ~/.grok/auth.json → start CLI + headless auth →
   *   open a fresh session → retry the same prompt.
   * The first account that succeeds wins and stays active; if every account
   * fails we stop with a combined error. Bounded to ONE pass (no infinite
   * loop). No-op unless the rotator is enabled and other accounts exist.
   *
   * Billing/quota failures (402 balance exhausted) skip backoff retries on
   * each account and rotate instantly so the turn continues without a long wait.
   */
  private async maybeRotateAccount(
    input: PromptInput,
    final: { result?: PromptResult; error?: Error; attempts: number },
  ): Promise<{ result?: PromptResult; error?: Error; attempts: number } | undefined> {
    const rotator = this.accountRotator;
    if (!rotator?.enabled() || !final.error || this.cancelled) return undefined;
    if (isSessionLifecycleError(final.error)) return undefined;
    const originalError = final.error;
    const observed = rotator.state();
    return rotator.withRotationLock(observed, async (changed) => {
      if (this.cancelled) return final;
      if (changed) {
        if (this.streamer?.hasOutput ?? false) return undefined;
        const current = rotator.state();
        const transcript = this.sessionId ? recentTranscript(this.cfg.sessionsDir, this.sessionId) : undefined;
        if (this.foreground) {
          await this.notify(
            `\u{1F504} Reusing ${current.activeLabel ?? "the account selected by another chat"} with a fresh session…`,
            { replyTo: this.turnReplyTo },
          );
        }
        log.info(`chat ${this.chatId} reusing account generation ${current.generation} selected by another chat`);
        try {
          await this.bindNewSession(this.cwd, this.projectName);
        } catch (error) {
          return { error: error as Error, attempts: final.attempts };
        }
        this.shownToolIds = new Set();
        this.subagentShown = new Map();
        this.streamer?.setFooter(this.hashtags());
        const content = buildContentBlocks(input, {
          reasoning: reasoningDirective(this.reasoning),
          priming: transcript ? buildPriming(transcript) : undefined,
          imageOutput: this.cfg.sendAgentImages ? IMAGE_OUTPUT_DIRECTIVE : undefined,
          progress: this.cfg.showProgress ? PROGRESS_DIRECTIVE : undefined,
        });
        return this.runPromptWithRetries(content);
      }
    // A quota-exhausted or access-denied response cannot be recovered by retrying
    // this login. Quarantine it before choosing targets, so later rotations do not
    // cycle back to a known-bad account. This intentionally happens before the
    // partial-stream guard: we must not retry/rotate a partial reply, but its
    // account still needs to be skipped during a future rotation.
    if (isAccountRotationError(originalError)) {
      await rotator.markFailed(observed.activeId, originalError.message);
    }
    if (this.streamer?.hasOutput ?? false) return undefined;
    const targets = await rotator.targets().catch(() => [] as { id: string; label: string }[]);
    if (targets.length === 0) return undefined;

    const transcript = this.sessionId ? recentTranscript(this.cfg.sessionsDir, this.sessionId) : undefined;
    const errors: string[] = [`\u2022 previous: ${originalError.message}`];
    let last = final;

    for (const t of targets) {
      if (this.cancelled) return last;
      const failReason = last.error ?? originalError;
      if (this.foreground) {
        await this.notify(formatAccountSwitchNotice(t.label, failReason), { replyTo: this.turnReplyTo });
      }
      try {
        // stop CLI → swap auth.json → start CLI + authenticate(cached_token)
        await rotator.activate(t.id);
      } catch (e) {
        errors.push(`\u2022 ${t.label}: couldn't switch \u2014 ${(e as Error).message}`);
        continue;
      }
      try {
        await this.bindNewSession(this.cwd, this.projectName); // fresh session on the new login
      } catch (e) {
        errors.push(`\u2022 ${t.label}: no session \u2014 ${(e as Error).message}`);
        continue;
      }
      // Reset per-turn render state so the retry streams cleanly.
      this.shownToolIds = new Set();
      this.subagentShown = new Map();
      this.streamer?.setFooter(this.hashtags());
      const content = buildContentBlocks(input, {
        reasoning: reasoningDirective(this.reasoning),
        priming: transcript ? buildPriming(transcript) : undefined,
        imageOutput: this.cfg.sendAgentImages ? IMAGE_OUTPUT_DIRECTIVE : undefined,
      progress: this.cfg.showProgress ? PROGRESS_DIRECTIVE : undefined,
      });
      log.info(
        `chat ${this.chatId} auto-rotating to account ${t.label}` +
          (isAccountRotationError(failReason) ? " (previous account unavailable)" : ""),
      );
      // runPromptWithRetries already skips backoff for 402 / balance exhausted.
      last = await this.runPromptWithRetries(content);
      if (last.result && !this.cancelled) {
        if (this.foreground) {
          await this.notify(`\u2705 Recovered on ${t.label}.`, { replyTo: this.turnReplyTo });
        }
        return last;
      }
      if (last.error && isAccountRotationError(last.error)) {
        await rotator.markFailed(t.id, last.error.message);
      }
      if (this.cancelled || (this.streamer?.hasOutput ?? false)) return last;
      errors.push(`\u2022 ${t.label}: ${last.error?.message ?? "failed"}`);
    }

    // One full cycle done and still failing — stop with a combined report.
    const combined = new Error(`Tried ${targets.length + 1} account(s), all failed:\n${errors.join("\n")}`);
    return { error: combined, attempts: last.attempts };
    });
  }

  /**
   * Run the prompt, retrying *transient* agent errors (e.g. "high volume of
   * traffic" / -32603) with an exponential backoff (6s в†’ 12s в†’ 24s в†’ 48s в†’ 60s,
   * then give up). The real error is shown to the user on every failed attempt.
   *
   * We only retry while the turn has produced **no streamed output** (so tools
   * aren't re-run and text isn't duplicated) and the user hasn't cancelled.
   * Returns the result, or the last error once retries are exhausted.
   */
  private async runPromptWithRetries(
    content: ContentBlock[],
  ): Promise<{ result?: PromptResult; error?: Error; attempts: number }> {
    const delays = this.cfg.promptRetryAttempts > 0 ? backoffSchedule(this.cfg.promptRetryAttempts) : [];
    const totalAttempts = delays.length + 1;
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const updatesBeforePrompt = this.sessionUpdateCount;
        const result = await this.acp.prompt(this.sessionId!, content);
        // A healthy ACP turn emits at least one session/update (text, thought,
        // or tool event) before resolving session/prompt. Grok can otherwise
        // report a successful end-turn after an upstream model failure; never
        // present that as a completed user request.
        await sleep(0);
        if (this.sessionUpdateCount === updatesBeforePrompt) {
          throw new Error("Empty agent response — Grok ended the turn without any output or tool activity");
        }
        return { result, attempts: attempt };
      } catch (err) {
        const error = err as Error;
        const canRecover = !this.cancelled && !(this.streamer?.hasOutput ?? false);
        // A context-exhausted session won't recover by retrying the same
        // oversized prompt — skip the backoff and let auto-fork compact it now.
        const forkInstead = canRecover && this.cfg.autoForkOnError && this.isContextRelatedFailure(error);
        // Billing/quota 402 (balance exhausted) is permanent for this login —
        // never backoff-retry; surface immediately so auto-rotate can switch.
        const willRetry =
          attempt <= delays.length &&
          canRecover &&
          !forkInstead &&
          !isAccountRotationError(error) &&
          isTransientError(error);
        if (!willRetry) return { error, attempts: attempt };
        const waitMs = delays[attempt - 1]!;
        if (this.foreground) {
          await this.notify(formatRetryNotice(error, attempt + 1, totalAttempts, waitMs), {
            replyTo: this.turnReplyTo,
          });
        }
        if (await this.interruptibleSleep(waitMs)) return { error, attempts: attempt };
      }
    }
  }

  /** Sleep that returns true early if the user cancels the turn meanwhile. */
  private async interruptibleSleep(ms: number): Promise<boolean> {
    const step = 500;
    for (let waited = 0; waited < ms; waited += step) {
      if (this.cancelled) return true;
      await sleep(Math.min(step, ms - waited));
    }
    return this.cancelled;
  }

  /**
   * Recover from a transient error (throttle / internal error / dropped
   * response stream) that struck AFTER the turn already started streaming.
   *
   * The pre-stream paths (retry / auto-fork / account-rotate) all bail once any
   * output exists, because re-sending the original prompt would re-execute the
   * tools that already ran (duplicate/destructive side effects). Instead we ask
   * the SAME session to CONTINUE from where it stopped вЂ” its partial reply and
   * any completed tool results are already in history, so nothing is repeated вЂ”
   * using the same exponential backoff so a throttle has time to clear. The
   * open streamer keeps appending, so the reply is completed in place.
   *
   * Returns the recovered outcome, or `undefined` when this path doesn't apply
   * (feature off, no error, cancelled, nothing streamed, or non-transient).
   */
  private async maybeResumeAfterStream(
    final: { result?: PromptResult; error?: Error; attempts: number },
  ): Promise<{ result?: PromptResult; error?: Error; attempts: number } | undefined> {
    if (!this.cfg.resumeOnStreamError || !final.error || this.cancelled || !this.sessionId) return undefined;
    // Only for the post-stream case; the pre-stream paths own the rest.
    if (!(this.streamer?.hasOutput ?? false)) return undefined;
    if (!isTransientError(final.error)) return undefined;
    // A context-full session won't recover by continuing (it'll just throttle
    // again each attempt) вЂ” don't burn the backoff; surface the error so the
    // user can fork/compact. Resume targets transient throttles on a session
    // that still has headroom.
    if (this.isContextRelatedFailure(final.error)) return undefined;

    const sessionId = this.sessionId;
    const delays = this.cfg.promptRetryAttempts > 0 ? backoffSchedule(this.cfg.promptRetryAttempts) : [RETRY_BASE_MS];
    const resumeContent = buildContentBlocks(textPrompt(RESUME_INSTRUCTION), {
      reasoning: reasoningDirective(this.reasoning),
      imageOutput: this.cfg.sendAgentImages ? IMAGE_OUTPUT_DIRECTIVE : undefined,
      progress: this.cfg.showProgress ? PROGRESS_DIRECTIVE : undefined,
    });

    let last = final;
    let attempts = final.attempts;
    for (let i = 0; i < delays.length; i++) {
      if (this.cancelled) return last;
      const waitMs = delays[i]!;
      if (this.foreground) {
        await this.notify(
          `\u26A0\uFE0F ${last.error!.message}\n\n\u{1F501} The reply was cut off mid-stream \u2014 resuming in ${fmtSeconds(waitMs)} (attempt ${i + 1} of ${delays.length})\u2026`,
          { replyTo: this.turnReplyTo },
        );
      }
      if (await this.interruptibleSleep(waitMs)) return last;
      attempts++; // this resume prompt is one more attempt for the turn
      try {
        const result = await this.acp.prompt(sessionId, resumeContent);
        log.info(`chat ${this.chatId} resumed after mid-stream ${last.error!.message.slice(0, 40)} (attempt ${i + 1})`);
        return { result, attempts };
      } catch (err) {
        last = { error: err as Error, attempts };
        // If the follow-up fails for a NON-transient reason, stop early.
        if (!isTransientError(last.error!)) return last;
      }
    }
    return last;
  }

  /** Send any fresh images the agent produced this turn (Imagine, screenshots…). */
  private async sendTurnImages(): Promise<void> {
    if (!this.cfg.sendAgentImages) return;
    // Always check session images/ + assets/ even when the agent never named a
    // path in text — image_gen writes under ~/.grok/sessions/.../images/.
    const paths = collectTurnImagePaths({
      scanText: this.imageScanText,
      cwd: this.cwd,
      sessionId: this.sessionId,
      since: this.turnStartedAt,
    });
    if (paths.length === 0) return;
    try {
      const n = await sendImages(this.api, this.chatId, paths, {
        since: this.turnStartedAt,
        already: this.sentImagesThisTurn,
        max: this.cfg.agentImagesMax,
        replyTo: this.turnReplyTo,
      });
      if (n > 0) log.info(`chat ${this.chatId}: sent ${n} agent image file(s)`);
    } catch {
      /* non-fatal */
    }
  }

  /** Build the "turn finished" message and record `lastCompletion` (the full
   *  in-session version with the file list). Foreground gets the full version;
   *  a background turn gets a labelled "other session" ping with short counts. */
  private completionMessage(stopReason: string | undefined, startedAt: number, streamedOutput: boolean): string {
    const head = this.doneHead(stopReason, startedAt, streamedOutput);
    const tags = this.hashtags();
    const base = `${head}\n${summarizeFileOps(this.fileOps, this.cwd)}`;
    this.lastCompletion = `${base}\n\n${tags}`; // switch-replay stays searchable
    if (this.foreground) {
      // The streamed response already carries the tag footer; only add tags to
      // the Done line when there was no response to tag (tool-only / no output).
      return streamedOutput ? base : `${base}\n\n${tags}`;
    }
    return `\u{1F4E8} From other session ${this.sessionTag()}\n${head}\n${summarizeFileOpsShort(this.fileOps)}\n\n${tags}`;
  }

  /**
   * Final Done after a self-recheck: head + split file lists (first turn vs recheck).
   */
  private completionMessageSplit(
    stopReason: string | undefined,
    startedAt: number,
    streamedOutput: boolean,
  ): string {
    const head = this.doneHead(stopReason, startedAt, streamedOutput);
    const tags = this.hashtags();
    const files = summarizeFileOpsSplit(this.preRecheckFileOps, this.fileOps, this.cwd);
    const base = `${head}\n${files}`;
    this.lastCompletion = `${base}\n\n${tags}`;
    if (this.foreground) {
      return streamedOutput ? base : `${base}\n\n${tags}`;
    }
    return (
      `\u{1F4E8} From other session ${this.sessionTag()}\n${head}\n` +
      `${summarizeFileOpsShort(this.preRecheckFileOps)} \u2192 recheck ${summarizeFileOpsShort(this.fileOps)}\n\n${tags}`
    );
  }

  /** The compact one-line status of a finished turn (no "end_turn" noise). */
  private doneHead(stopReason: string | undefined, startedAt: number, streamedOutput: boolean): string {
    const elapsed = fmtDuration(Date.now() - startedAt);
    if (this.cancelled || stopReason === "cancelled") return `\u23F9 Stopped \u00B7 ${elapsed}`;
    const reason = stopReason && stopReason !== "end_turn" ? ` \u00B7 ${stopReason}` : "";
    const meta = this.contextInfo();
    const ctx = meta?.contextUsagePercentage;
    const ctxStr = ctx !== undefined ? ` \u00B7 ctx ${ctx.toFixed(0)}%` : "";
    // Credits consumed this turn вЂ” only shown when Grok actually reports it
    // (not part of ACP today; degrades to nothing rather than guessing).
    const credits = meta?.credits;
    const creditStr = credits !== undefined ? ` \u00B7 \u{1FA99} ${fmtCredits(credits)}` : "";
    // Only claim "no text output" when we were actually streaming (foreground).
    const noOut = this.foreground && !streamedOutput ? " \u00B7 no text output" : "";
    return `\u2705 Done${reason} \u00B7 ${elapsed}${ctxStr}${creditStr}${noOut}`;
  }

  /** Build the turn-failed message and record `lastCompletion`. */
  private errorMessage(error: Error, startedAt: number, attempts: number, transient: boolean): string {
    const summary = formatErrorSummary(error, fmtDuration(Date.now() - startedAt), attempts, transient);
    const files = this.fileOps.size > 0 ? `\n${summarizeFileOps(this.fileOps, this.cwd)}` : "";
    const tags = this.hashtags();
    this.lastCompletion = `${summary}${files}\n\n${tags}`;
    if (this.foreground) return this.lastCompletion;
    const shortFiles = this.fileOps.size > 0 ? `\n${summarizeFileOpsShort(this.fileOps)}` : "";
    return `\u{1F4E8} From other session ${this.sessionTag()}\n${summary}${shortFiles}\n\n${tags}`;
  }

  /** "[project В· 1a2b3c4d]" вЂ” identifies which background session a ping is from. */
  private sessionTag(): string {
    const name = this.projectName || basename(this.cwd) || "session";
    const id = this.sessionId ? ` \u00B7 ${this.sessionId.slice(0, 8)}` : "";
    return `[${name}${id}]`;
  }

  /** Inline keyboard offering to switch to this session, attached to background
   *  ("From other session") pings so you can jump straight in. Foreground turns
   *  are already in view, so they get no button. */
  private switchKeyboard(): InlineKeyboard | undefined {
    if (this.foreground || !this.sessionId) return undefined;
    return new InlineKeyboard().text("\u{1F500} Switch to this session", `run:switch:${this.sessionId}`);
  }

  /** Searchable Telegram hashtags so you can pull up every message of a session
   *  or project by tapping the tag. */
  private hashtags(): string {
    return sessionHashtags({
      projectName: this.projectName,
      cwd: this.cwd,
      sessionId: this.sessionId,
    });
  }

  private async flushQueue(): Promise<void> {
    if (this.queue.length === 0 || this.busy) return;
    // Meta / system turns (self-recheck, auto-suggestion batches) must run
    // alone: merging them with user messages corrupts the prompt and can drop
    // the one-shot skipSelfRecheck guard via text concatenation.
    const head = this.queue[0]!;
    const isMeta =
      !!head.skipSelfRecheck ||
      isSelfRecheckPrompt(head.text);
    const batch = isMeta
      ? this.queue.shift()!
      : mergeInputs(this.queue.splice(0, this.queue.length));
    if (this.foreground) await this.notify("\u25B6\uFE0F Processing queued message\u2026");
    void this.runTurn(batch);
  }

  private onUpdate(sessionId: string, update: SessionUpdate): void {
    if (!this.busy || sessionId !== this.sessionId) return;
    this.sessionUpdateCount++;
    const kind = update.sessionUpdate;

    // Quiet meta turns (follow-up suggestions): capture prose only, never stream.
    if (this.capturingQuiet) {
      if (kind === "agent_message_chunk") {
        const text = contentText(update.content);
        if (text) this.quietCaptureBuf += text;
      }
      return;
    }

    // Accumulate the turn's file-change summary + image-scan text even when this
    // session is in the background (its output isn't streamed here, but the
    // completion message still reports what changed / which images were made).
    if (kind === "tool_call" || kind === "tool_call_update") {
      // Merge early so background live-step + file ops use full title/args.
      const tid = update.toolCallId || "";
      const mergedEarly = mergeToolSnapshot(tid ? this.toolCallCache.get(tid) : undefined, update);
      if (tid) this.toolCallCache.set(tid, mergedEarly);

      if (mergedEarly.rawInput) this.imageScanText += " " + JSON.stringify(mergedEarly.rawInput);
      if (mergedEarly.title) this.imageScanText += " " + mergedEarly.title;
      if (Array.isArray(mergedEarly.content_blocks)) {
        this.imageScanText += " " + JSON.stringify(mergedEarly.content_blocks);
      }
      const ct = contentText(mergedEarly.content);
      if (ct) this.imageScanText += " " + ct;
      const fo = fileOpFromUpdate(mergedEarly);
      if (fo) this.fileOps.set(fo.path, mergeFileOp(this.fileOps.get(fo.path), fo.op));
      // Live card step — always, even for background sessions.
      const step = stepFromToolUpdate(mergedEarly);
      if (step) this.setLiveStep(step);
    } else if (kind === "agent_message_chunk") {
      const text = contentText(update.content);
      if (text) {
        this.imageScanText += text;
        this.turnAssistantText += text;
      }
    } else if (kind === "agent_thought_chunk") {
      const text = contentText(update.content);
      if (text?.trim()) this.setLiveStep(stepFromThought(text));
    } else if (kind === "plan") {
      // Always track plan entries (background too) so switch-to-live restores the board.
      const entries = parsePlanUpdate(update);
      if (entries?.length) {
        this.planEntries = entries;
        const one = renderPlanOneLine(entries);
        if (one) this.setLiveStep(one);
        this.changed();
      }
    }

    // Only the live foreground turn streams to Telegram.
    if (!this.foreground || !this.streamer) return;

    if (kind === "plan") {
      if (this.planEntries?.length) {
        this.streamer.setPlan(renderPlanMarkdown(this.planEntries));
      }
      return;
    }
    if (kind === "agent_message_chunk") {
      const text = contentText(update.content);
      if (text) this.streamer.appendOutput(text);
      return;
    }
    if (kind === "agent_thought_chunk") {
      const text = contentText(update.content);
      if (text) this.streamer.appendThought(text);
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      if (!this.cfg.showToolCalls) return;
      const id = update.toolCallId || "";
      const status = (update.status || "").toLowerCase();

      // Snapshot already merged above for file-ops / live step.
      const merged = (id && this.toolCallCache.get(id)) || mergeToolSnapshot(undefined, update);

      // Skip hollow shells with nothing useful yet.
      if (!snapshotHasDetail(merged) && status !== "completed" && status !== "failed") {
        return;
      }

      // Status-only mid-flight patches (no new content/input): skip if we already
      // painted this tool once — upsert would be a no-op anyway.
      if (kind === "tool_call_update" && (status === "pending" || status === "in_progress")) {
        const hasNewContent =
          (Array.isArray(update.content_blocks) && update.content_blocks.length > 0) ||
          (Array.isArray(update.content) && (update.content as unknown[]).length > 0) ||
          (!!update.rawInput && Object.keys(update.rawInput).length > 0) ||
          update.rawOutput !== undefined;
        const key = id || `tool_call:${update.title ?? ""}`;
        if (!hasNewContent && this.shownToolIds.has(key)) return;
      }

      const md = formatToolCall(merged, {
        showDiffs: this.cfg.showEditDiffs,
        diffMaxLines: this.cfg.diffMaxLines,
      });
      if (!md) return;

      // One live card per toolCallId: replace in place as output streams
      // (no spam of new code sections). Session/agent context keeps full output.
      const key = id || `tool_call:${merged.title ?? merged.name ?? ""}`;
      this.shownToolIds.add(key);
      if (status === "completed" || status === "failed") {
        this.shownToolIds.add(key + ":done");
      }
      this.streamer.upsertTool(id || undefined, md);
    }
  }

  private persist(): void {
    if (!this.foreground) return; // only the foreground session is the chat's restored default
    this.settings.update(this.chatId, {
      projectPath: this.cwd,
      projectName: this.projectName,
      sessionId: this.sessionId,
    });
  }

  private changed(): void {
    try {
      this.onStateChange?.();
    } catch {
      /* non-fatal */
    }
  }

  private sessionChanged(): void {
    try {
      this.onSessionChange?.();
    } catch {
      /* non-fatal */
    }
  }

  private async notify(
    text: string,
    opts?: { loud?: boolean; replyTo?: number; replyMarkup?: InlineKeyboard },
  ): Promise<void> {
    try {
      const extra: Record<string, unknown> = opts?.loud ? { disable_notification: false } : {};
      if (opts?.replyTo !== undefined) {
        extra.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
      }
      if (opts?.replyMarkup) extra.reply_markup = opts.replyMarkup;
      await this.api.sendMessage(this.chatId, text, extra);
    } catch (e) {
      log.debug("notify failed:", (e as Error).message);
    }
  }

  private async onWatchEntries(entries: HistoryEntry[]): Promise<void> {
    const body = entries
      .map((e) => {
        const icon = WATCH_ICON[e.role] ?? "\u2022";
        if (e.role === "tool") return `${icon} ${e.tool ? `\`${e.tool}\`` : "tool"}`;
        const text = e.text.length > WATCH_ENTRY_MAX ? e.text.slice(0, WATCH_ENTRY_MAX) + " вЂ¦" : e.text;
        return `${icon} ${text}`;
      })
      .filter(Boolean)
      .join("\n\n");
    if (body.trim()) await sendMarkdownDoc(this.api, this.chatId, `${body}\n\n${this.tags}`);
  }
}

/** Format an elapsed duration compactly (e.g. "8s", "2m 13s", "1h 4m"). */
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Format a credits/cost figure compactly (drops noise decimals). */
function fmtCredits(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toFixed(2);
}

/** Convenience for callers that only have text. */
export { textPrompt };
