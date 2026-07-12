/**
 * Grok ACP client — spawns `grok agent stdio` and speaks JSON-RPC 2.0 over
 * stdio (the Agent Client Protocol). One persistent process manages many
 * sessions. After `initialize` it runs the `authenticate` step (using the
 * cached `grok login` token, or XAI_API_KEY), then callers create/load sessions
 * and send prompts; streamed `session/update` notifications are re-emitted as
 * "session-update" events keyed by sessionId.
 *
 * The bot also records the sessions it drives on disk (see SessionLog) so
 * `/sessions`, `/history` and live-watch keep working regardless of Grok's own
 * internal session store.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createLogger } from "../logger.js";
import { hasLogin } from "../app/grok-credentials.js";
import { contextWindowFor, DEFAULT_MODEL, KNOWN_MODELS } from "./models.js";
import { PROGRESS_DIRECTIVE } from "../render/progress.js";
import { SessionLog } from "./session-log.js";
import { JsonRpcTransport } from "./transport.js";
import type {
  ContentBlock,
  InitializeResult,
  JsonRpcMessage,
  PendingStage,
  PermissionOutcome,
  PromptResult,
  RequestPermissionParams,
  SessionNotificationParams,
  SessionUpdate,
  SubagentInfo,
  SubagentListUpdate,
} from "./types.js";

const log = createLogger("grok:client");

export interface SessionMetadata {
  contextUsagePercentage?: number;
  effort?: string;
  credits?: number;
  totalTokens?: number;
}

const TRANSIENT_CODES = new Set([-32603, -32500, -32000, 500, 502, 503, 504, 429]);
const TRANSIENT_RE =
  /internal error|high volume|experiencing|overloaded|temporar|unavailable|rate.?limit|too many requests|try again|capacity|dispatch failure|response stream|connection (?:reset|closed|refused|error)|reset by peer|broken pipe|socket hang ?up|econnreset|econnrefused|enotfound|eai_again|etimedout|\b50[234]\b|\b429\b/i;
const CONTEXT_EXHAUSTED_RE =
  /context (?:length|window|limit|size|overflow)|maximum context|input (?:is )?too long|prompt (?:is )?too long|too many (?:input )?tokens|token limit|exceeds? (?:the )?(?:maximum|context|token)|reduce the (?:length|size)|context.{0,24}exhaust/i;

export class GrokError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "GrokError";
  }
}

export function isTransientError(err: Error): boolean {
  const code = (err as GrokError).code;
  if (typeof code === "number" && TRANSIENT_CODES.has(code)) return true;
  return TRANSIENT_RE.test(err.message);
}

export function isContextExhaustedError(err: Error): boolean {
  return CONTEXT_EXHAUSTED_RE.test(err.message);
}

function shortJson(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 300 ? `${s.slice(0, 300)}\u2026` : s;
  } catch {
    return String(v);
  }
}

/** Auth methods that open a browser / interactive UI — never use from the bot. */
const BROWSER_AUTH_RE = /grok\.com|browser|oauth|interactive|web.?login/i;

/**
 * Pick a headless-safe auth method. Prefer `cached_token` (auth.json) so
 * multi-account rotation works by swapping that file; then `xai.api_key` when
 * an API key is configured. Never falls back to browser methods.
 */
export function pickHeadlessAuthMethod(
  methods: Array<{ id: string; name?: string }>,
  hasApiKey: boolean,
): string | undefined {
  const ids = methods.map((m) => m.id);
  const safe = (id: string) => !BROWSER_AUTH_RE.test(id) && !/login|sign.?in/i.test(id);
  if (ids.includes("cached_token") && safe("cached_token")) return "cached_token";
  if (hasApiKey && ids.includes("xai.api_key") && safe("xai.api_key")) return "xai.api_key";
  // Any other non-browser, non-key method the agent advertises.
  return ids.find((id) => safe(id) && id !== "xai.api_key");
}

/** Auto-pick an allow option for permission requests (prefer session/always). */
function pickAllowOption(
  opts: Array<{ optionId: string; name?: string; kind?: string }>,
): PermissionOutcome {
  let best: { optionId: string; score: number } | undefined;
  for (const o of opts) {
    const k = `${o.kind ?? ""} ${o.name ?? ""}`.toLowerCase();
    let score = 0;
    if (/reject|deny|cancel|no\b|block/.test(k)) score = 0;
    else if (/all.?sessions|always_allow_all|forever/.test(k)) score = 4;
    else if (/this.?session|session|allow_session/.test(k)) score = 3;
    else if (/always|allow_always|allow.?all\b/.test(k)) score = 2;
    else if (/allow|approve|yes|once|ok\b/.test(k)) score = 1;
    if (score > 0 && (!best || score > best.score)) best = { optionId: o.optionId, score };
  }
  if (best) return { outcome: { outcome: "selected", optionId: best.optionId } };
  return opts[0]
    ? { outcome: { outcome: "selected", optionId: opts[0].optionId } }
    : { outcome: { outcome: "cancelled" } };
}

export interface GrokClientOptions {
  grokCliPath: string;
  workspace: string;
  sessionsDir: string;
  /** Pass --always-approve to run tools without per-call permission prompts. */
  trustAllTools: boolean;
  /** Optional XAI_API_KEY to export for the agent (else it uses `grok login`). */
  apiKey?: string;
  model?: string;
  requestTimeoutMs?: number;
  autoRestart?: boolean;
  promptIdleTimeoutMs?: number;
  promptMaxMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
  method: string;
}

export declare interface GrokClient {
  on(e: "session-update", l: (sessionId: string, update: SessionUpdate) => void): this;
  on(e: "notification", l: (method: string, params: unknown) => void): this;
  on(e: "exit", l: (code: number | null) => void): this;
  on(e: "restarted", l: () => void): this;
  on(e: "subagents", l: (subagents: SubagentInfo[], pending: PendingStage[]) => void): this;
  emit(e: "session-update", sessionId: string, update: SessionUpdate): boolean;
  emit(e: "notification", method: string, params: unknown): boolean;
  emit(e: "exit", code: number | null): boolean;
  emit(e: "restarted"): boolean;
  emit(e: "subagents", subagents: SubagentInfo[], pending: PendingStage[]): boolean;
}

export class GrokClient extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private transport?: JsonRpcTransport;
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private readonly timeout: number;
  private readonly promptIdleMs: number;
  private readonly promptMaxMs: number;
  private readonly slog: SessionLog;
  private readonly lastActivity = new Map<string, number>();
  private lastActivityAny = 0;
  private stopped = false;
  private restartAttempts = 0;
  private restartTimer?: NodeJS.Timeout;
  /** Per-session cwd (for logging + re-bind). */
  private readonly cwd = new Map<string, string>();
  /** Sessions with an in-flight prompt (drives "active"). */
  private readonly running = new Set<string>();
  /** Accumulated assistant text per in-flight turn (flushed to the log on end). */
  private readonly assistantBuf = new Map<string, string>();
  private authMethodId?: string;

  agentInfo?: { name?: string; version?: string };
  capabilities?: InitializeResult["agentCapabilities"];
  availableModes: Array<{ id: string; name: string; description?: string }> = [];
  currentModeId?: string;
  availableModels: Array<{ modelId: string; name: string; description?: string }> = [];
  currentModelId?: string;
  private readonly metadata = new Map<string, SessionMetadata>();
  private subagents: SubagentInfo[] = [];
  private pendingStages: PendingStage[] = [];
  permissionHandler?: (params: RequestPermissionParams) => Promise<PermissionOutcome>;

  constructor(private readonly opts: GrokClientOptions) {
    super();
    this.setMaxListeners(0);
    this.slog = new SessionLog(opts.sessionsDir);
    this.timeout = opts.requestTimeoutMs ?? 120_000;
    this.promptIdleMs = opts.promptIdleTimeoutMs ?? 900_000;
    this.promptMaxMs = opts.promptMaxMs ?? 6 * 60 * 60_000;
    this.currentModelId = opts.model || DEFAULT_MODEL;
    this.availableModels = KNOWN_MODELS.map((m) => ({ modelId: m.modelId, name: m.name, description: m.description }));
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    // `--always-approve` is a `grok agent` option (not `grok agent stdio`),
    // so it must come before the `stdio` subcommand. `--no-leader` keeps auth
    // process-local so swapping ~/.grok/auth.json + restart actually picks up
    // the new token. `--no-auto-update` was removed in grok 0.2.x (exit 2).
    const args = ["agent", "--no-leader"];
    if (this.opts.trustAllTools) args.push("--always-approve");
    args.push("stdio");

    log.info(`spawning: ${this.opts.grokCliPath} ${args.join(" ")}`);
    const env = { ...process.env };
    if (this.opts.apiKey) env.XAI_API_KEY = this.opts.apiKey;
    const proc = spawn(this.opts.grokCliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.workspace,
      env,
    }) as ChildProcessWithoutNullStreams;
    this.proc = proc;

    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      log.warn(`grok agent exited (code ${code})`);
      this.failAllPending(new Error(`grok agent stdio exited (code ${code})`));
      this.emit("exit", code);
      this.maybeRestart();
    });
    proc.on("error", (err) => {
      if (this.proc !== proc) return;
      log.error("failed to spawn grok:", err.message);
      this.failAllPending(err);
    });

    this.transport = new JsonRpcTransport(proc);
    this.transport.on("message", (m: JsonRpcMessage) => this.onMessage(m));

    const init = (await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "grok-telegram-bot", version: "2.2.0" },
    })) as InitializeResult;

    this.agentInfo = init.agentInfo ?? { name: "grok" };
    this.capabilities = init.agentCapabilities;
    this.restartAttempts = 0;
    this.subagents = [];
    this.pendingStages = [];

    // Authenticate headlessly only. NEVER pick browser methods (e.g. "grok.com")
    // — those open a browser and hang/kill the bot host. Prefer cached_token
    // from ~/.grok/auth.json, then xai.api_key when configured.
    this.authMethodId = pickHeadlessAuthMethod(init.authMethods ?? [], !!this.opts.apiKey);
    if (!this.authMethodId) {
      // Never fall back to browser methods (e.g. grok.com) — that opens a
      // browser and freezes headless hosts. Boot unauthenticated so /reauth works.
      log.warn(
        "No headless Grok auth method available. Run `grok login` / /reauth, or set XAI_API_KEY. " +
          "Refusing browser-based auth methods.",
      );
    } else {
      try {
        await this.request("authenticate", { methodId: this.authMethodId, _meta: { headless: true } });
      } catch (e) {
        const msg = (e as Error).message;
        log.warn(`authenticate (${this.authMethodId}) failed: ${msg}`);
        // If a login (or API key) is present, auth should have worked — surface
        // the error so account switch/rotation doesn't silently keep a dead agent.
        // If nothing is configured yet, soft-fail so the bot can still boot for /reauth.
        if (hasLogin() || this.opts.apiKey) {
          throw new Error(`Grok authenticate (${this.authMethodId}) failed: ${msg}`);
        }
      }
    }
    log.info(`connected: ${this.agentInfo?.name ?? "grok"} ${this.agentInfo?.version ?? ""}`.trim());
  }

  private maybeRestart(): void {
    if (this.stopped || !this.opts.autoRestart) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.restartAttempts);
    this.restartAttempts += 1;
    log.warn(`auto-restarting ACP in ${delay}ms (attempt ${this.restartAttempts})`);
    this.restartTimer = setTimeout(() => {
      this.connect()
        .then(() => {
          log.info("ACP reconnected");
          this.emit("restarted");
        })
        .catch((e) => {
          log.error("ACP restart failed:", (e as Error).message);
          this.maybeRestart();
        });
    }, delay);
  }

  get supportsLoadSession(): boolean {
    return Boolean(this.capabilities?.loadSession);
  }

  hasInflightPrompt(): boolean {
    for (const p of this.pending.values()) if (p.method === "session/prompt") return true;
    return false;
  }

  /** True while the given session has a turn in flight. */
  isSessionActive(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /** PID of the shared `grok agent stdio` process. */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  async newSession(cwd: string): Promise<string> {
    const res = (await this.request("session/new", { cwd, mcpServers: [] })) as { sessionId: string };
    this.parseSessionExtras(res);
    this.cwd.set(res.sessionId, cwd);
    this.slog.create(res.sessionId, cwd);
    return res.sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    const res = await this.request("session/load", { sessionId, cwd, mcpServers: [] });
    this.parseSessionExtras(res);
    this.cwd.set(sessionId, cwd);
    this.slog.create(sessionId, cwd, "resumed");
  }

  hasMode(id: string): boolean {
    return this.availableModes.some((m) => m.id === id);
  }

  hasModel(id: string): boolean {
    return id === "auto" || this.availableModels.some((m) => m.modelId === id);
  }

  private parseSessionExtras(result: unknown): void {
    const r = result as {
      modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name: string; description?: string }> };
      models?: { currentModelId?: string; availableModels?: Array<{ modelId: string; name: string; description?: string }> };
    };
    if (r?.modes?.availableModes?.length) this.availableModes = r.modes.availableModes;
    if (r?.modes?.currentModeId) this.currentModeId = r.modes.currentModeId;
    if (r?.models?.availableModels?.length) this.availableModels = r.models.availableModels;
    if (r?.models?.currentModelId) this.currentModelId = r.models.currentModelId;
  }

  prompt(sessionId: string, content: ContentBlock[]): Promise<PromptResult> {
    return new Promise<PromptResult>((resolve, reject) => {
      const id = this.nextId++;
      const start = Date.now();
      this.lastActivity.set(sessionId, start);
      this.running.add(sessionId);
      if (this.proc?.pid) this.slog.lock(sessionId, this.proc.pid);
      const userText = this.cleanUserText(content);
      this.slog.logUser(sessionId, userText);
      const meta = this.slog.read(sessionId);
      if (!meta?.title || meta.title === "(untitled)") {
        const title = userText.replace(/\s+/g, " ").trim().slice(0, 80);
        if (title) this.slog.update(sessionId, { title });
      }
      const watch = setInterval(() => {
        const last = Math.max(this.lastActivity.get(sessionId) ?? start, this.lastActivityAny);
        const idle = Date.now() - last;
        const total = Date.now() - start;
        if (total > this.promptMaxMs) {
          this.pending.delete(id);
          this.finishPrompt(sessionId, id);
          clearInterval(watch);
          void this.cancel(sessionId);
          reject(new Error(`Prompt exceeded the ${Math.round(this.promptMaxMs / 60_000)}min cap`));
        } else if (idle > this.promptIdleMs) {
          this.pending.delete(id);
          this.finishPrompt(sessionId, id);
          clearInterval(watch);
          void this.cancel(sessionId);
          reject(new Error(`No agent activity for ${Math.round(idle / 1000)}s — giving up`));
        }
      }, 15_000);
      this.pending.set(id, {
        resolve: (v) => {
          this.finishPrompt(sessionId, id);
          resolve(v as PromptResult);
        },
        reject: (e) => {
          this.finishPrompt(sessionId, id);
          reject(e);
        },
        cleanup: () => clearInterval(watch),
        method: "session/prompt",
      });
      try {
        this.transport!.send({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: content } });
      } catch (e) {
        clearInterval(watch);
        this.pending.delete(id);
        this.finishPrompt(sessionId, id);
        reject(e as Error);
      }
    });
  }

  /** Clear the running/lock state for a finished turn and flush its transcript. */
  private finishPrompt(sessionId: string, _id: number): void {
    this.running.delete(sessionId);
    this.slog.unlock(sessionId);
    const buf = this.assistantBuf.get(sessionId);
    if (buf && buf.trim()) this.slog.logAssistant(sessionId, buf);
    this.assistantBuf.delete(sessionId);
  }

  async cancel(sessionId: string): Promise<void> {
    try {
      this.transport?.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    } catch (e) {
      log.debug("cancel failed:", (e as Error).message);
    }
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.request("session/set_model", { sessionId, modelId });
    this.currentModelId = modelId;
    this.slog.update(sessionId, { model: modelId });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.request("session/set_mode", { sessionId, modeId });
    this.currentModeId = modeId;
  }

  async executeCommand(sessionId: string, command: string): Promise<unknown> {
    return this.request("_grok.dev/commands/execute", { sessionId, command });
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    void this.killCurrent();
  }

  async stopAndWait(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    await this.killCurrent();
  }

  async restart(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.stopped = true;
    this.restartAttempts = 0;
    await this.killCurrent();
    this.stopped = false;
    await this.connect();
    this.emit("restarted");
  }

  private killCurrent(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    this.transport = undefined;
    this.failAllPending(new Error("grok agent is restarting"));
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(hard);
        resolve();
      };
      const hard = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        setTimeout(done, 500);
      }, 4000);
      proc.once("exit", done);
      try {
        proc.kill();
      } catch {
        done();
      }
    });
  }

  metadataFor(sessionId: string | undefined): SessionMetadata | undefined {
    return sessionId ? this.metadata.get(sessionId) : undefined;
  }

  currentSubagents(): SubagentInfo[] {
    return this.subagents.slice();
  }

  currentPendingStages(): PendingStage[] {
    return this.pendingStages.slice();
  }

  subagentById(sessionId: string): SubagentInfo | undefined {
    return this.subagents.find((s) => s.sessionId === sessionId);
  }

  // ── JSON-RPC plumbing ──────────────────────────────────────────────────────

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout after ${this.timeout}ms: ${method}`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, cleanup: () => clearTimeout(timer), method });
      try {
        this.transport!.send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private toGrokError(error: { code: number; message: string; data?: unknown }, method: string): GrokError {
    const codeStr = typeof error.code === "number" ? ` [${error.code}]` : "";
    const detail = error.data === undefined ? "" : ` — ${shortJson(error.data)}`;
    const text = `${error.message || "ACP error"}${codeStr}${detail}`;
    log.warn(`${method} failed: ${text}`);
    return new GrokError(text, error.code, error.data);
  }

  private onMessage(msg: JsonRpcMessage): void {
    // Response to one of our requests.
    if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id) && msg.method === undefined) {
      const p = this.pending.get(msg.id)!;
      p.cleanup();
      this.pending.delete(msg.id);
      if (msg.error) p.reject(this.toGrokError(msg.error, p.method));
      else p.resolve(msg.result);
      return;
    }
    // Request from the agent (has both id and method) — needs a response.
    if (msg.id !== undefined && msg.id !== null && msg.method) {
      void this.respondToServerRequest(msg.id, msg.method, (msg.params as Record<string, unknown>) || {});
      return;
    }
    // Notification (method, no id).
    if (msg.method) this.routeNotification(msg.method, msg.params);
  }

  private async respondToServerRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      let result: unknown;
      if (method === "session/request_permission" && this.permissionHandler) {
        result = await this.permissionHandler(params as unknown as RequestPermissionParams);
      } else if (method === "session/request_permission") {
        // No handler: auto-approve, preferring session-scope / always options.
        const opts = (params.options as Array<{ optionId: string; name?: string; kind?: string }>) ?? [];
        result = pickAllowOption(opts);
      } else {
        // We advertise no fs/terminal capabilities, so the agent shouldn't ask.
        throw new GrokError(`unsupported client method: ${method}`, -32601);
      }
      this.transport?.send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      this.transport?.send({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } });
    }
  }

  private routeNotification(method: string, params: unknown): void {
    if (method === "session/update" || method === "_grok.dev/metadata" || method === "_grok.dev/subagent/list_update") {
      this.lastActivityAny = Date.now();
    }
    if (method === "session/update") {
      const p = params as SessionNotificationParams;
      if (p?.sessionId && p.update) {
        this.lastActivity.set(p.sessionId, Date.now());
        this.recordUpdate(p.sessionId, p.update);
        this.emit("session-update", p.sessionId, p.update);
        return;
      }
    }
    if (method === "_grok.dev/metadata") {
      const p = (params as Record<string, unknown>) ?? {};
      const sessionId = p.sessionId as string | undefined;
      if (sessionId) {
        const prev = this.metadata.get(sessionId);
        this.metadata.set(sessionId, {
          contextUsagePercentage: (p.contextUsagePercentage as number | undefined) ?? prev?.contextUsagePercentage,
          effort: (p.effort as string | undefined) ?? prev?.effort,
          credits: (p.creditsUsed as number | undefined) ?? (p.credits as number | undefined) ?? prev?.credits,
          totalTokens: (p.totalTokens as number | undefined) ?? prev?.totalTokens,
        });
      }
    }
    if (method === "_grok.dev/subagent/list_update") {
      const p = (params as SubagentListUpdate) || {};
      this.subagents = Array.isArray(p.subagents) ? p.subagents : [];
      this.pendingStages = Array.isArray(p.pendingStages) ? p.pendingStages : [];
      this.emit("subagents", this.subagents, this.pendingStages);
    }
    this.emit("notification", method, params);
  }

  /** Accumulate assistant text and log tool calls to the session's jsonl. */
  private recordUpdate(sessionId: string, u: SessionUpdate): void {
    if (u.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string") {
      this.assistantBuf.set(sessionId, (this.assistantBuf.get(sessionId) ?? "") + u.content.text);
    } else if (u.sessionUpdate === "tool_call" && (u.title || u.kind)) {
      this.slog.logTool(sessionId, u.title || u.kind || "tool", "");
    }
    // Derive a context-usage %/token count if the update carries usage info.
    const usage = (u as { usage?: { totalTokens?: number } }).usage;
    if (usage?.totalTokens) {
      const prev = this.metadata.get(sessionId) ?? {};
      const win = contextWindowFor(this.currentModelId);
      this.metadata.set(sessionId, {
        ...prev,
        totalTokens: usage.totalTokens,
        contextUsagePercentage: Math.min(100, Math.round((usage.totalTokens / win) * 100)),
      });
    }
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      p.cleanup();
      p.reject(err);
    }
    this.pending.clear();
    this.running.clear();
  }

  private visibleText(content: ContentBlock[]): string {
    return content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")
      .trim();
  }

  /** The user's message with bot-added decorations (progress directive, a
   *  leading reasoning directive, fork/priming preamble) removed, for a clean log. */
  private cleanUserText(content: ContentBlock[]): string {
    let t = this.visibleText(content);
    const pi = t.indexOf(PROGRESS_DIRECTIVE);
    if (pi !== -1) t = t.slice(0, pi).trimEnd();
    const marker = "User's new message:\n";
    const mi = t.lastIndexOf(marker);
    if (mi !== -1) t = t.slice(mi + marker.length);
    t = t.replace(/^\([^\n)]*\)\s*\n+/, "");
    return t.trim();
  }
}
