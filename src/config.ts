/**
 * Configuration: loads .env, validates required values, resolves paths.
 *
 * The bot drives the official Grok Build CLI over ACP (`grok agent stdio`) and
 * authenticates with your xAI account sign-in (`grok login`, `~/.grok/auth.json`),
 * or an optional `XAI_API_KEY` on headless hosts.
 */
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_DIR,
  expandHome,
  resolveInstanceDir as resolveNamedInstanceDir,
} from "./app/instance.js";

export { CANONICAL_DIR, expandHome };

/** Absolute path to the installed bot code (one level above src/). For a global
 *  npm install this lives inside node_modules — code lives here, never user data. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Directory holding THIS instance's `.env`, `logs/` and `data/`. Resolution
 * (first match wins):
 *   1. `--instance <dir>` argv — set by the installed background service,
 *   2. `--name` / `GROK_TG_NAME` — named instance under `~/.grok/tg/instances/`,
 *   3. `GROK_TG_DIR` env — an explicit override,
 *   4. `GROK_TG_CWD` or cwd IF that folder already contains a `.env`,
 *   5. the canonical `~/.grok/tg` home — the path-independent default.
 */
export const INSTANCE_DIR = resolveNamedInstanceDir({
  argv: process.argv,
  envDir: process.env.GROK_TG_DIR,
  nameEnv: process.env.GROK_TG_NAME,
  cwdHint: process.env.GROK_TG_CWD,
});

/** Absolute path to the `.env` this instance loads (and that `setup` writes). */
export const ENV_PATH = join(INSTANCE_DIR, ".env");

// Load .env from the resolved instance directory. Keep the parsed values as
// well: a machine-wide TELEGRAM_BOT_TOKEN may belong to a sibling bot (Codex,
// Kiro, etc.) and must never override this Grok instance's identity.
const instanceEnv = loadDotenv({ path: ENV_PATH }).parsed ?? {};

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Like num() but allows 0 (e.g. to disable retries). Rejects negatives. */
function nonNegNum(v: string | undefined, def: number): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/** Comma-separated list (spaces around commas ok). Used for ALLOWED_USERS, PROJECT_ROOTS, etc. */
function list(v: string | undefined): string[] {
  return (v || "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * Parse ALLOWED_USERS. Blank/unset → allow everyone. Non-blank → only numeric
 * Telegram user ids (invalid tokens dropped). If every token is invalid, deny
 * everyone (fail closed) rather than treating as open.
 */
export function parseAllowedUsers(raw: string | undefined): {
  ids: Set<string>;
  allowAll: boolean;
  dropped: string[];
} {
  if (raw === undefined || raw.trim() === "") {
    return { ids: new Set(), allowAll: true, dropped: [] };
  }
  const tokens = list(raw);
  const dropped: string[] = [];
  const ids = new Set<string>();
  for (const t of tokens) {
    // Telegram user ids are positive integers (string form).
    if (/^\d+$/.test(t)) ids.add(t);
    else dropped.push(t);
  }
  return { ids, allowAll: false, dropped };
}

export interface AppConfig {
  token: string;
  /**
   * Telegram user ids allowed to use the bot (private + groups). Populated from
   * comma-separated ALLOWED_USERS. See {@link allowAllUsers}.
   */
  allowedUsers: Set<string>;
  /**
   * True only when ALLOWED_USERS was blank/unset. When false, only ids in
   * {@link allowedUsers} may use the bot (even if the set is empty after
   * filtering invalid tokens — fail closed).
   */
  allowAllUsers: boolean;
  grokCliPath: string;
  workspace: string;
  /** Optional xAI API key for headless hosts. When set, exported to the agent
   *  as XAI_API_KEY. Otherwise the agent uses the `grok login` token in
   *  ~/.grok/auth.json. */
  grokApiKey?: string;
  /** Optional Grok API base URL (default https://api.x.ai/v1). */
  grokBaseUrl?: string;
  /** Default model for new sessions (e.g. grok-4-1-fast). */
  grokModel: string;
  /** Optional max output tokens (exported as GROK_MAX_TOKENS). */
  grokMaxTokens?: number;
  /** Cap on tool-execution rounds per headless turn (grok --max-tool-rounds). */
  maxToolRounds: number;
  /** Custom sub-agent name to hint in prompts (informational; Grok has no
   *  --agent flag headlessly). */
  agent?: string;
  trustAllTools: boolean;
  /**
   * Auto-approve ACP `session/request_permission` prompts (prefer "allow for
   * this session"). Defaults true — Telegram bots shouldn't block on tool
   * approvals. Set false (and GROK_TRUST_ALL_TOOLS=false) for interactive
   * Approve/Deny buttons.
   */
  autoApprovePermissions: boolean;
  /**
   * Auto-approve Grok plan-mode exit (no Approve/Changes/Abandon buttons).
   * Default true so unattended/24/7 bots never wait on a TUI. Set false for
   * interactive review in Telegram.
   */
  autoApprovePlan: boolean;
  /** GROK_SANDBOX profile (workspace-safe, strict, off, …). */
  sandboxProfile?: string;
  /** GROK_MEMORY setting forwarded to the agent process. */
  grokMemory?: string;
  /** `--agent-profile` for `grok agent`. */
  agentProfile?: string;
  /** `--plugin-dir` for `grok agent`. */
  pluginDir?: string;
  projectRoots: string[];
  streamThrottleMs: number;
  messageBatchMs: number;
  showToolCalls: boolean;
  showEditDiffs: boolean;
  diffMaxLines: number;
  sendAgentImages: boolean;
  agentImagesMax: number;
  docMaxChars: number;
  logLevel: string;
  sessionsDir: string;
  projectRoot: string;
  logsDir: string;
  logFile: string;
  /** Emit a `restarted` event / clear running turns when asked (kept for the
   *  self-healing + reauth flows; there is no persistent daemon with Grok). */
  grokAutoRestart: boolean;
  dataDir: string;
  promptIdleMs: number;
  quietNotifications: boolean;
  promptRetryAttempts: number;
  autoForkOnError: boolean;
  autoForkContextPct: number;
  resumeOnStreamError: boolean;
  sttApiUrl?: string;
  sttApiKey?: string;
  sttModel: string;
  sttLanguage?: string;
  mcpProbeTimeoutMs: number;
  mcpProbeConcurrency: number;
  showSubagents: boolean;
  showProgress: boolean;
  progressFallback: boolean;
  notifyOtherSessions: boolean;
  autoUpdate: boolean;
  updateCheckMs: number;
  singleInstance: boolean;
  /**
   * After a successful Done, ask Grok for 1–3 follow-up suggestions (JSON) and
   * attach them as inline buttons on the Done message. Default true.
   */
  suggestionsEnabled: boolean;
  /**
   * Auto-queue any suggestion whose need score is ≥ this percent (0–100).
   * 0 disables auto-approve (buttons only). Default 95.
   * Multiple hits are merged into one numbered multi-step prompt.
   */
  suggestionsAutoApprovePct: number;
  /**
   * After a successful user turn (queue empty), optionally run one self-recheck
   * pass before Done + suggestions. Skipped when no files changed or when a
   * quiet AI decision refuses. Default true. Typo alias: SLEF_RECHECK.
   */
  selfRecheckEnabled: boolean;
  /**
   * Optional override for the recheck turn body when the AI decides recheck is
   * needed (SELF_RECHECK_PROMPT). Supports {{USER}} and {{DONE}}. Empty → use
   * the AI-written recheck prompt (or built-in default if the AI left it blank).
   */
  selfRecheckPrompt: string;
  /**
   * Max wait for quiet meta ACP prompts (self-recheck decision, suggestions).
   * On timeout the session prompt is cancelled so Done is not blocked forever.
   * QUIET_PROMPT_TIMEOUT_MS, default 90s.
   */
  quietPromptTimeoutMs: number;
  /**
   * Telegram forum supergroup id for project topics (TOPIC_GROUP_ID). When set
   * and the bot is admin, the bot manages topics: AI Chat + optional one topic
   * per catalog project. Empty/undefined disables forum management.
   */
  topicGroupId?: number;
  /**
   * Auto-create a forum topic for each catalog project (TOPIC_AUTO_CREATE).
   * Default true when TOPIC_GROUP_ID is set.
   */
  topicAutoCreateProjects: boolean;
  /**
   * How often (ms) to poll PROJECT_ROOTS for new folders when forum auto-create
   * is on (TOPIC_WATCH_INTERVAL_MS). Default 10000.
   */
  topicWatchIntervalMs: number;
  /** Display name for the default AI chat topic (TOPIC_AI_CHAT_NAME). */
  topicAiChatName: string;
  /**
   * Sibling Telegram bot usernames the agent may call via telegram bridge
   * `bot_command` / `list_bots` (ALLOWED_TELEGRAM_BOTS, comma-separated, with
   * or without @). Empty = feature off.
   */
  allowedTelegramBots: string[];
  /**
   * Optional command catalogs per bot (TELEGRAM_BOT_COMMANDS). Keys are
   * usernames (no @); values are command names without slash + optional
   * description. Shown by list_bots / first-prompt directive.
   */
  telegramBotCommands: Record<string, Array<{ command: string; description?: string }>>;
  /** Hard timeout waiting for a sibling bot's reply (TELEGRAM_BOT_REPLY_TIMEOUT_MS). */
  telegramBotReplyTimeoutMs: number;
  /**
   * After the last message/edit from the triggered bot, wait this many ms of
   * silence before treating the reply as finished (TELEGRAM_BOT_SETTLE_MS).
   * Streaming bots that edit one message need this "typing done" equivalent.
   */
  telegramBotSettleMs: number;
}

export function loadConfig(): AppConfig {
  // Telegram long polling permits one consumer per token. Prefer the token in
  // this bot's own instance file over a globally inherited environment value,
  // otherwise a Grok process can accidentally poll as a sibling bot.
  const token = (instanceEnv.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is missing. Copy .env.example to .env and set it (run `npm run setup`).",
    );
  }

  const workspaceRaw = process.env.GROK_WORKSPACE?.trim() || process.cwd();
  const workspace = resolve(expandHome(workspaceRaw));

  // Default project roots: the workspace parent + home directory.
  const roots = list(process.env.PROJECT_ROOTS).map((p) => resolve(expandHome(p)));
  if (roots.length === 0) {
    roots.push(dirname(workspace), homedir());
  }

  const dataDir = process.env.DATA_DIR?.trim()
    ? resolve(expandHome(process.env.DATA_DIR.trim()))
    : join(INSTANCE_DIR, "data");
  // The bot owns its sessions on disk (Grok itself keeps them in SQLite): one
  // `<id>.json` + `<id>.jsonl` + `<id>.lock` per session, mirroring the layout
  // the session store / history parser / tail watcher already understand.
  const sessionsDir = process.env.SESSIONS_DIR?.trim()
    ? resolve(expandHome(process.env.SESSIONS_DIR.trim()))
    : join(dataDir, "sessions");
  const logsDir = process.env.LOG_DIR?.trim()
    ? resolve(expandHome(process.env.LOG_DIR.trim()))
    : join(INSTANCE_DIR, "logs");
  const logFile = process.env.LOG_FILE?.trim()
    ? resolve(expandHome(process.env.LOG_FILE.trim()))
    : join(logsDir, "grok-telegram-bot.log");

  const allowedParsed = parseAllowedUsers(process.env.ALLOWED_USERS);
  if (allowedParsed.dropped.length > 0) {
    // Avoid importing logger at top (config loads early); stderr is fine at boot.
    console.warn(
      `[config] ALLOWED_USERS ignored non-numeric token(s): ${allowedParsed.dropped.join(", ")}`,
    );
  }
  const cfg: AppConfig = {
    token,
    allowedUsers: allowedParsed.ids,
    allowAllUsers: allowedParsed.allowAll,
    grokCliPath: resolveGrokPath(process.env.GROK_CLI_PATH?.trim()),
    workspace,
    grokApiKey: process.env.XAI_API_KEY?.trim() || process.env.GROK_API_KEY?.trim() || undefined,
    grokBaseUrl: process.env.GROK_BASE_URL?.trim() || undefined,
    grokModel: process.env.GROK_MODEL?.trim() || "grok-4.5",
    grokMaxTokens: process.env.GROK_MAX_TOKENS ? num(process.env.GROK_MAX_TOKENS, 0) || undefined : undefined,
    maxToolRounds: num(process.env.GROK_MAX_TOOL_ROUNDS, 400),
    agent: process.env.GROK_AGENT?.trim() || undefined,
    trustAllTools: bool(process.env.GROK_TRUST_ALL_TOOLS, true),
    // Default true: auto-approve with session-scope when the agent still asks.
    autoApprovePermissions: bool(process.env.AUTO_APPROVE_PERMISSIONS, true),
    autoApprovePlan: bool(process.env.AUTO_APPROVE_PLAN, true),
    sandboxProfile: process.env.GROK_SANDBOX?.trim() || undefined,
    grokMemory: process.env.GROK_MEMORY?.trim() || undefined,
    agentProfile: process.env.GROK_AGENT_PROFILE?.trim() || undefined,
    pluginDir: process.env.GROK_PLUGIN_DIR?.trim() || undefined,
    projectRoots: [...new Set(roots)],
    streamThrottleMs: num(process.env.STREAM_THROTTLE_MS, 1500),
    messageBatchMs: nonNegNum(process.env.MESSAGE_BATCH_MS, 800),
    showToolCalls: bool(process.env.SHOW_TOOL_CALLS, true),
    showEditDiffs: bool(process.env.SHOW_EDIT_DIFFS, true),
    diffMaxLines: num(process.env.DIFF_MAX_LINES, 120),
    sendAgentImages: bool(process.env.SEND_AGENT_IMAGES, true),
    agentImagesMax: num(process.env.AGENT_IMAGES_MAX, 8),
    docMaxChars: nonNegNum(process.env.DOC_MAX_CHARS, 100_000),
    logLevel: process.env.LOG_LEVEL?.trim() || "info",
    sessionsDir,
    projectRoot: PROJECT_ROOT,
    logsDir,
    logFile,
    grokAutoRestart: bool(process.env.GROK_AUTO_RESTART, true),
    promptIdleMs: num(process.env.PROMPT_IDLE_TIMEOUT_MS, 900_000),
    quietNotifications: bool(process.env.QUIET_NOTIFICATIONS, true),
    promptRetryAttempts: nonNegNum(process.env.PROMPT_RETRY_ATTEMPTS, 5),
    autoForkOnError: bool(process.env.AUTO_FORK_ON_ERROR, true),
    autoForkContextPct: nonNegNum(process.env.AUTO_FORK_CONTEXT_PCT, 85),
    resumeOnStreamError: bool(process.env.RESUME_ON_STREAM_ERROR, true),
    dataDir,
    sttApiUrl: process.env.STT_API_URL?.trim() || undefined,
    sttApiKey: process.env.STT_API_KEY?.trim() || undefined,
    sttModel: process.env.STT_MODEL?.trim() || "whisper-1",
    sttLanguage: process.env.STT_LANGUAGE?.trim() || undefined,
    mcpProbeTimeoutMs: num(process.env.MCP_PROBE_TIMEOUT_MS, 8000),
    mcpProbeConcurrency: num(process.env.MCP_PROBE_CONCURRENCY, 6),
    showSubagents: bool(process.env.SHOW_SUBAGENTS, true),
    showProgress: bool(process.env.SHOW_PROGRESS, true),
    progressFallback: bool(process.env.PROGRESS_FALLBACK, true),
    notifyOtherSessions: bool(process.env.NOTIFY_OTHER_SESSIONS, true),
    autoUpdate: bool(process.env.AUTO_UPDATE, true),
    updateCheckMs: num(process.env.UPDATE_CHECK_MS, 3_600_000),
    singleInstance: bool(process.env.GROK_TG_SINGLE_INSTANCE, true),
    // Post-turn follow-ups: default on; auto-run suggestions scoring ≥ 95%.
    suggestionsEnabled: bool(process.env.SUGGESTIONS_ENABLED, true),
    suggestionsAutoApprovePct: clampPct(process.env.SUGGESTIONS_AUTO_APPROVE_PCT, 95),
    // One-shot post-turn self-recheck before Done/suggestions (default on).
    // Accept typo SLEF_RECHECK as alias.
    selfRecheckEnabled: bool(
      process.env.SELF_RECHECK ?? process.env.SLEF_RECHECK,
      true,
    ),
    selfRecheckPrompt: (process.env.SELF_RECHECK_PROMPT ?? "").trim(),
    quietPromptTimeoutMs: num(process.env.QUIET_PROMPT_TIMEOUT_MS, 90_000),
    topicGroupId: parseTopicGroupId(
      process.env.TOPIC_GROUP_ID ?? process.env.FORUM_GROUP_ID,
    ),
    topicAutoCreateProjects: bool(process.env.TOPIC_AUTO_CREATE, true),
    topicWatchIntervalMs: num(process.env.TOPIC_WATCH_INTERVAL_MS, 10_000),
    topicAiChatName: (process.env.TOPIC_AI_CHAT_NAME ?? "AI Chat").trim() || "AI Chat",
    allowedTelegramBots: parseTelegramBotUsernames(process.env.ALLOWED_TELEGRAM_BOTS),
    telegramBotCommands: parseTelegramBotCommands(process.env.TELEGRAM_BOT_COMMANDS),
    telegramBotReplyTimeoutMs: num(process.env.TELEGRAM_BOT_REPLY_TIMEOUT_MS, 45_000),
    telegramBotSettleMs: num(process.env.TELEGRAM_BOT_SETTLE_MS, 2_000),
  };

  return cfg;
}

/** Normalize comma-separated bot usernames (strip @, lowercase, unique). */
export function parseTelegramBotUsernames(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of list(raw)) {
    const u = t.replace(/^@/, "").toLowerCase();
    if (!u || seen.has(u)) continue;
    // Telegram usernames: 5–32 characters (letter first, then alnum/underscore).
    if (!/^[a-z][a-z0-9_]{4,31}$/i.test(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/**
 * Parse optional command catalogs.
 *
 * Formats (both supported):
 *  1) Compact: `helperbot:status,help,ping;otherbot:start|Start the bot,info`
 *     - `;` separates bots, `:` separates username from commands
 *     - `,` separates commands; optional `cmd|description`
 *  2) JSON object: `{"helperbot":["status","help"],"otherbot":[{"command":"start","description":"…"}]}`
 */
export function parseTelegramBotCommands(
  raw: string | undefined,
): Record<string, Array<{ command: string; description?: string }>> {
  const out: Record<string, Array<{ command: string; description?: string }>> = {};
  if (raw === undefined || raw.trim() === "") return out;
  const trimmed = raw.trim();

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
          const u = key.replace(/^@/, "").toLowerCase();
          if (!u) continue;
          const cmds = normalizeCommandList(val);
          if (cmds.length) out[u] = cmds;
        }
      }
    } catch {
      /* fall through to compact parser */
    }
    if (Object.keys(out).length > 0) return out;
  }

  for (const botPart of trimmed.split(";")) {
    const piece = botPart.trim();
    if (!piece) continue;
    const colon = piece.indexOf(":");
    if (colon <= 0) continue;
    const u = piece.slice(0, colon).replace(/^@/, "").toLowerCase().trim();
    if (!u) continue;
    const rest = piece.slice(colon + 1).trim();
    if (!rest) continue;
    const cmds = normalizeCommandList(rest.split(",").map((s) => s.trim()).filter(Boolean));
    if (cmds.length) out[u] = cmds;
  }
  return out;
}

function normalizeCommandList(
  val: unknown,
): Array<{ command: string; description?: string }> {
  const items: unknown[] = Array.isArray(val)
    ? val
    : typeof val === "string"
      ? val.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const seen = new Set<string>();
  const out: Array<{ command: string; description?: string }> = [];
  for (const item of items) {
    let command = "";
    let description: string | undefined;
    if (typeof item === "string") {
      const pipe = item.indexOf("|");
      if (pipe >= 0) {
        command = item.slice(0, pipe).trim();
        description = item.slice(pipe + 1).trim() || undefined;
      } else {
        command = item.trim();
      }
    } else if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      command = String(rec.command ?? rec.cmd ?? rec.name ?? "").trim();
      const d = String(rec.description ?? rec.desc ?? rec.help ?? "").trim();
      if (d) description = d;
    }
    command = command.replace(/^\//, "").toLowerCase();
    if (!command || !/^[a-z0-9_]{1,32}$/.test(command) || seen.has(command)) continue;
    seen.add(command);
    out.push(description ? { command, description: description.slice(0, 120) } : { command });
    if (out.length >= 40) break;
  }
  return out;
}

/** Parse a Telegram chat/group id (may be negative for supergroups). */
function parseTopicGroupId(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v.trim());
  if (!Number.isFinite(n) || n === 0) return undefined;
  return Math.trunc(n);
}

/** Parse 0–100 percentage; blank → default. */
function clampPct(v: string | undefined, def: number): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Resolve the `grok` binary path. The official installer puts it in
 *  ~/.grok/bin; also try common PATH locations before a bare `grok`. */
function resolveGrokPath(explicit?: string): string {
  if (explicit) return expandHome(explicit);

  const home = homedir();
  const exe = process.platform === "win32" ? "grok.exe" : "grok";
  const candidates = [
    join(home, ".grok", "bin", exe),
    join(home, ".local", "bin", "grok"),
    "/usr/local/bin/grok",
    "/opt/homebrew/bin/grok",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to PATH lookup.
  return "grok";
}

export function isAbsolutePath(p: string): boolean {
  return isAbsolute(p);
}
