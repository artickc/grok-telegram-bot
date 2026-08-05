/**
 * Telegram bridge protocol: first-prompt directive + parse/strip of agent
 * JSON action blocks (`{"telegram":[...]}`) from assistant responses.
 *
 * Keep TELEGRAM_BRIDGE_DIRECTIVE tidy-idempotent (no trailing spaces / 3+ blank
 * lines, no digit `{progress:…}` tokens) so history cleaners can strip by
 * exact match after extractProgress/tidy.
 */
import type { PromptInput } from "../app/types.js";

/** Marker prefix for first-prompt teaching block (used by strip / history). */
export const TELEGRAM_BRIDGE_MARKER = "TELEGRAM BRIDGE (how to work in this chat):";

/** Marker for results injected back into the agent after actions run. */
export const TELEGRAM_BRIDGE_RESULTS_MARKER =
  "TELEGRAM BRIDGE RESULTS (system — use these facts; do not re-emit the same request unless needed):";

/** Max actions accepted from one agent turn (create + path + several prompts). */
export const TELEGRAM_ACTION_MAX = 9;
/** Max bot_command actions per turn. */
export const TELEGRAM_BOT_COMMAND_MAX = 2;
/** Max send_prompt actions per turn (cross-topic work). */
export const TELEGRAM_SEND_PROMPT_MAX = 5;

export type TelegramAction =
  | { action: "create_topic"; name: string; path?: string }
  | { action: "set_path"; topic: string; path: string }
  | { action: "send_prompt"; topic: string; prompt: string; newSession?: boolean }
  | { action: "search_memory"; query: string; limit?: number }
  | { action: "list_bots" }
  | { action: "bot_command"; bot: string; command: string; args?: string };

export interface TelegramActionExtract {
  actions: TelegramAction[];
  /** Text with telegram action fences removed. */
  cleaned: string;
}

/**
 * Static teaching block. Dynamic capability lines are appended by
 * {@link buildTelegramBridgeDirective}.
 */
export const TELEGRAM_BRIDGE_DIRECTIVE_BASE = [
  TELEGRAM_BRIDGE_MARKER,
  "You are driven by the Grok Telegram Bot bridge over ACP. Beyond normal coding tools you may request Telegram-side actions by putting a fenced JSON block in your response (language json preferred), BEFORE the final progress marker line.",
  "",
  "Format (one block; multiple actions allowed, run in order — up to 9):",
  "```json",
  '{ "telegram": [',
  '  { "action": "create_topic", "name": "Topic title", "path": "optional absolute project path or exact catalog name" },',
  '  { "action": "set_path", "topic": "Topic title or #threadId", "path": "absolute path or exact catalog name" },',
  '  { "action": "send_prompt", "topic": "Topic title or #threadId", "prompt": "work for that topic", "new_session": false },',
  '  { "action": "search_memory", "query": "keywords about past work", "limit": 8 },',
  '  { "action": "list_bots" },',
  '  { "action": "bot_command", "bot": "username_without_at", "command": "status", "args": "optional" }',
  "] }",
  "```",
  "",
  "Actions:",
  "- create_topic — new forum topic; optional path binds the project immediately.",
  "  Absolute paths that do not exist yet are created on disk (new project flow).",
  "- set_path — bind/rebind an existing topic to a project path (absolute dir or exact catalog name).",
  "  Absolute paths that do not exist yet are created on disk.",
  "- send_prompt — start or queue a prompt in another topic's session (does not wait for that turn to finish).",
  "  From General/AI Chat (GROK_WORKSPACE) you can create a project topic, set_path, then send_prompt with multi-step work.",
  "  topic = exact topic title, #threadId, \"general\", or \"ai chat\". Optional new_session=true starts a fresh session there.",
  "- search_memory — search indexed forum topics + session titles/comments/history.",
  "- list_bots — list allowlisted sibling Telegram bots and command catalogs.",
  "- bot_command — /command@bot; waits for that bot to settle. NOT a Done; timeouts return ok=false.",
  "",
  "Example (from General): create project topic + path + kick off work there:",
  '```json',
  '{ "telegram": [',
  '  { "action": "create_topic", "name": "MyApp", "path": "H:\\\\Projects\\\\MyApp" },',
  '  { "action": "send_prompt", "topic": "MyApp", "prompt": "1) scaffold\\n2) tests\\n3) README" }',
  "] }",
  "```",
  "",
  "After you emit these actions, the bridge runs them and may send TELEGRAM BRIDGE RESULTS. Use those facts; do not invent replies.",
  "The bridge strips the JSON fence from the user-visible message. Prefer plain prose for the user; put protocol only in the fence.",
  "Do not spam actions. Prefer one orchestration block per turn.",
].join("\n");

export interface TelegramBridgeCaps {
  forumReady: boolean;
  topicGroupId?: number;
  allowedBots: string[];
  /** username → command list for first-prompt teaching */
  botCommands?: Record<string, Array<{ command: string; description?: string }>>;
}

/** Full first-prompt directive including live capabilities. */
export function buildTelegramBridgeDirective(caps: TelegramBridgeCaps): string {
  const lines = [TELEGRAM_BRIDGE_DIRECTIVE_BASE, "", "Capabilities right now:"];
  if (caps.forumReady && caps.topicGroupId !== undefined) {
    lines.push(
      `- Forum topics: READY (group ${caps.topicGroupId}). You may create_topic, set_path, and send_prompt.`,
      `- General / AI Chat sessions use GROK_WORKSPACE; other topics use their bound project path.`,
    );
  } else if (caps.topicGroupId !== undefined) {
    lines.push(
      `- Forum topics: NOT READY (group ${caps.topicGroupId} configured but setup failed or bot is not admin). Do not rely on create_topic / set_path / send_prompt.`,
    );
  } else {
    lines.push("- Forum topics: OFF (TOPIC_GROUP_ID unset). create_topic / set_path / send_prompt will fail.");
  }
  if (caps.allowedBots.length > 0) {
    lines.push(
      `- Sibling bots (allowlist): ${caps.allowedBots.map((b) => "@" + b).join(", ")}. Use list_bots / bot_command like MCP.`,
    );
    for (const u of caps.allowedBots) {
      const cmds = caps.botCommands?.[u];
      if (cmds && cmds.length > 0) {
        lines.push(
          `  - @${u}: ${cmds
            .map((c) => (c.description ? `/${c.command} (${c.description})` : `/${c.command}`))
            .join(", ")}`,
        );
      }
    }
  } else {
    lines.push(
      "- Sibling bots: none configured (ALLOWED_TELEGRAM_BOTS empty). list_bots returns empty; bot_command disabled.",
    );
  }
  lines.push("- search_memory: always available against bot-owned session/topic indexes.");
  return lines.join("\n");
}

/**
 * Prepend the telegram bridge teaching block (idempotent if already present).
 * Call after complexity wrapping so it sits between complexity and user task body.
 */
export function wrapTelegramBridgePrompt(input: PromptInput, directive: string): PromptInput {
  const body = input.text.trim() || "(see attached media / files)";
  if (body.includes(TELEGRAM_BRIDGE_MARKER)) return input;
  // Prefer inserting after "User task:\n" when complexity wrapper is present.
  const marker = "User task:";
  const idx = body.indexOf(marker);
  if (idx !== -1) {
    const before = body.slice(0, idx + marker.length);
    const after = body.slice(idx + marker.length);
    return {
      ...input,
      text: `${before}\n\n${directive}\n\nUser task (continued):\n${after.trimStart()}`,
    };
  }
  return {
    ...input,
    text: `${directive}\n\n${body}`,
  };
}

/** True when text is the bridge results follow-up (meta; skip recheck). */
export function isTelegramBridgeResultsPrompt(text: string): boolean {
  return text.trimStart().startsWith(TELEGRAM_BRIDGE_RESULTS_MARKER);
}

/** Build the meta prompt that feeds action results back to the agent. */
export function buildTelegramBridgeResultsPrompt(results: unknown[]): string {
  const payload = JSON.stringify({ results }, null, 2);
  return [
    TELEGRAM_BRIDGE_RESULTS_MARKER,
    "```json",
    payload,
    "```",
    "Continue the user's task with this information. Do not ask the user to paste results. Do not re-emit the same telegram actions unless something failed and a retry is useful.",
  ].join("\n");
}

/**
 * Extract telegram actions from fenced JSON blocks and strip those fences from
 * the visible text. Non-telegram fences are left intact.
 */
export function extractTelegramActions(text: string): TelegramActionExtract {
  if (!text) return { actions: [], cleaned: text };
  const actions: TelegramAction[] = [];
  // Match complete fenced blocks (``` or ```json etc.).
  const fenceRe = /```(?:json|JSON)?\s*\r?\n([\s\S]*?)```/g;
  let cleaned = text.replace(fenceRe, (full, body: string) => {
    const parsed = tryParseTelegramFence(body);
    if (!parsed) return full;
    for (const a of parsed) {
      if (actions.length >= TELEGRAM_ACTION_MAX) break;
      actions.push(a);
    }
    return "";
  });
  // Hide a trailing incomplete ```json … telegram block mid-stream.
  cleaned = cleaned.replace(/```(?:json|JSON)?\s*\r?\n[\s\S]*$/i, (tail) => {
    if (
      /"telegram"\s*:/i.test(tail) ||
      /"action"\s*:\s*"(?:create_topic|set_path|send_prompt|search_memory|list_bots|bot_command)"/i.test(
        tail,
      )
    ) {
      return "";
    }
    return tail;
  });
  cleaned = tidy(cleaned);
  return { actions: capBotCommands(actions), cleaned };
}

/** Strip only (no need for actions) — streamer path. */
export function stripTelegramActionFences(text: string): string {
  return extractTelegramActions(text).cleaned;
}

function tryParseTelegramFence(body: string): TelegramAction[] | undefined {
  const raw = body.trim();
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const list = coerceActionList(parsed);
  if (!list) return undefined;
  const out: TelegramAction[] = [];
  for (const item of list) {
    const a = normalizeAction(item);
    if (a) out.push(a);
  }
  return out.length > 0 ? out : undefined;
}

function coerceActionList(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return undefined;
    // Bare array only if every element looks like an action.
    if (parsed.every((x) => x && typeof x === "object" && "action" in (x as object))) {
      return parsed;
    }
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const rec = parsed as Record<string, unknown>;
  if ("telegram" in rec) {
    const t = rec.telegram;
    if (Array.isArray(t)) return t;
    if (t && typeof t === "object") return [t];
    return undefined;
  }
  // Single action object at top level.
  if (typeof rec.action === "string") return [rec];
  return undefined;
}

function normalizeAction(item: unknown): TelegramAction | undefined {
  if (!item || typeof item !== "object") return undefined;
  const rec = item as Record<string, unknown>;
  const action = String(rec.action ?? rec.type ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");

  switch (action) {
    case "create_topic": {
      const name = String(rec.name ?? rec.title ?? "").trim();
      if (!name) return undefined;
      const path = String(rec.path ?? rec.project_path ?? rec.projectPath ?? "").trim();
      return path
        ? { action: "create_topic", name: name.slice(0, 128), path: path.slice(0, 500) }
        : { action: "create_topic", name: name.slice(0, 128) };
    }
    case "set_path":
    case "bind_path":
    case "bind_topic": {
      const topic = String(rec.topic ?? rec.name ?? rec.thread ?? rec.thread_id ?? rec.threadId ?? "").trim();
      const path = String(rec.path ?? rec.project_path ?? rec.projectPath ?? "").trim();
      if (!topic || !path) return undefined;
      return {
        action: "set_path",
        topic: topic.slice(0, 128),
        path: path.slice(0, 500),
      };
    }
    case "send_prompt":
    case "topic_prompt":
    case "prompt_topic": {
      const topic = String(rec.topic ?? rec.name ?? rec.thread ?? rec.thread_id ?? rec.threadId ?? "").trim();
      const prompt = String(rec.prompt ?? rec.text ?? rec.message ?? "").trim();
      if (!topic || !prompt) return undefined;
      const newSessionRaw = rec.new_session ?? rec.newSession ?? rec.fresh;
      const newSession =
        newSessionRaw === true ||
        newSessionRaw === 1 ||
        /^(1|true|yes|y)$/i.test(String(newSessionRaw ?? "").trim());
      return {
        action: "send_prompt",
        topic: topic.slice(0, 128),
        prompt: prompt.slice(0, 4000),
        newSession: newSession || undefined,
      };
    }
    case "search_memory":
    case "search":
    case "memory_search": {
      const query = String(rec.query ?? rec.q ?? rec.text ?? "").trim();
      if (!query) return undefined;
      let limit = Number(rec.limit ?? rec.max ?? 8);
      if (!Number.isFinite(limit)) limit = 8;
      limit = Math.max(1, Math.min(20, Math.round(limit)));
      return { action: "search_memory", query: query.slice(0, 300), limit };
    }
    case "list_bots":
    case "bots":
      return { action: "list_bots" };
    case "bot_command":
    case "call_bot":
    case "invoke_bot": {
      const bot = normalizeUsername(String(rec.bot ?? rec.username ?? ""));
      const command = String(rec.command ?? rec.cmd ?? "")
        .trim()
        .replace(/^\//, "");
      if (!bot || !command) return undefined;
      const args = String(rec.args ?? rec.arguments ?? rec.text ?? "").trim();
      return {
        action: "bot_command",
        bot,
        command: command.slice(0, 64),
        args: args ? args.slice(0, 500) : undefined,
      };
    }
    default:
      return undefined;
  }
}

function capBotCommands(actions: TelegramAction[]): TelegramAction[] {
  let botCmds = 0;
  let sendPrompts = 0;
  const out: TelegramAction[] = [];
  for (const a of actions) {
    if (a.action === "bot_command") {
      if (botCmds >= TELEGRAM_BOT_COMMAND_MAX) continue;
      botCmds++;
    }
    if (a.action === "send_prompt") {
      if (sendPrompts >= TELEGRAM_SEND_PROMPT_MAX) continue;
      sendPrompts++;
    }
    out.push(a);
    if (out.length >= TELEGRAM_ACTION_MAX) break;
  }
  return out;
}

export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

function tidy(s: string): string {
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/g, "");
}
