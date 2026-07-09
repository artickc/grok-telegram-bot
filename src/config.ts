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

/** Absolute path to the installed bot code (one level above src/). For a global
 *  npm install this lives inside node_modules — code lives here, never user data. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Canonical, path-independent home for this bot's `.env`, `logs/`, `data/` and
 *  the single-instance locks: `~/.grok/tg`. Used whenever the bot is started
 *  without an explicit instance dir and there's no `.env` in the current folder,
 *  so the SAME configuration is found no matter which directory you launch from. */
export const CANONICAL_DIR = join(homedir(), ".grok", "tg");

/**
 * Directory holding THIS instance's `.env`, `logs/` and `data/`. Resolution
 * (first match wins):
 *   1. `--instance <dir>` argv — set by the installed background service,
 *   2. `GROK_TG_DIR` env — an explicit override,
 *   3. `GROK_TG_CWD` env — the legacy launcher variable,
 *   4. the current folder, IF it already contains a `.env`,
 *   5. the canonical `~/.grok/tg` home — the path-independent default.
 */
export const INSTANCE_DIR = resolveInstanceDir();

/** Absolute path to the `.env` this instance loads (and that `setup` writes). */
export const ENV_PATH = join(INSTANCE_DIR, ".env");

function resolveInstanceDir(): string {
  const flag = process.argv.indexOf("--instance");
  if (flag !== -1 && process.argv[flag + 1]) return resolve(process.argv[flag + 1]!);
  const envDir = process.env.GROK_TG_DIR?.trim() || process.env.GROK_TG_CWD?.trim();
  if (envDir) return resolve(expandHome(envDir));
  if (existsSync(join(process.cwd(), ".env"))) return process.cwd();
  return CANONICAL_DIR;
}

// Load .env from the resolved instance directory. dotenv does NOT override
// variables already present in the environment (the launcher/service env wins).
loadDotenv({ path: ENV_PATH });

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

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

function list(v: string | undefined): string[] {
  return (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface AppConfig {
  token: string;
  allowedUsers: Set<string>;
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
}

export function loadConfig(): AppConfig {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
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

  const cfg: AppConfig = {
    token,
    allowedUsers: new Set(list(process.env.ALLOWED_USERS)),
    grokCliPath: resolveGrokPath(process.env.GROK_CLI_PATH?.trim()),
    workspace,
    grokApiKey: process.env.XAI_API_KEY?.trim() || process.env.GROK_API_KEY?.trim() || undefined,
    grokBaseUrl: process.env.GROK_BASE_URL?.trim() || undefined,
    grokModel: process.env.GROK_MODEL?.trim() || "grok-4.5",
    grokMaxTokens: process.env.GROK_MAX_TOKENS ? num(process.env.GROK_MAX_TOKENS, 0) || undefined : undefined,
    maxToolRounds: num(process.env.GROK_MAX_TOOL_ROUNDS, 400),
    agent: process.env.GROK_AGENT?.trim() || undefined,
    trustAllTools: bool(process.env.GROK_TRUST_ALL_TOOLS, true),
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
  };

  return cfg;
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
