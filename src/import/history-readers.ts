/**
 * Multi-format full-history readers for foreign sessions.
 * Unlike the UI tail parsers, these read the *entire* conversation so an
 * import loses nothing.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import type { HistoryEntry, HistoryRole } from "../sessions/types.js";
import type { HistoryFormat } from "./sources.js";

const log = createLogger("import:history");

/** Hard cap on raw log bytes we will load into memory (20 MB). */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Cap a single tool result / json blob so one grep dump can't blow the import. */
const TOOL_BLOB_MAX = 24_000;

export interface ForeignSessionMeta {
  sessionId: string;
  cwd: string;
  title: string;
  projectName?: string;
  historyBytes: number;
  /** Absolute path of the primary history file/dir, if known. */
  historyPath?: string;
  updatedAt?: string;
  active?: boolean;
}

/** Read the full conversation history for a foreign session. */
export function readForeignHistory(
  format: HistoryFormat,
  sessionsRoot: string,
  sessionId: string,
): HistoryEntry[] {
  switch (format) {
    case "acp-jsonl":
      return readAcpJsonl(join(sessionsRoot, `${sessionId}.jsonl`));
    case "codex-rollout":
      return readCodexRollout(resolveCodexRollout(sessionsRoot, sessionId));
    case "opencode-storage":
      return readOpencodeStorage(sessionsRoot, sessionId);
    default:
      return [];
  }
}

/** Locate meta + history path for a foreign session id. */
export function resolveForeignMeta(
  format: HistoryFormat,
  sessionsRoot: string,
  sessionId: string,
  fallback?: { cwd?: string; projectName?: string },
): ForeignSessionMeta {
  const base: ForeignSessionMeta = {
    sessionId,
    cwd: fallback?.cwd || "",
    title: "(untitled)",
    projectName: fallback?.projectName,
    historyBytes: 0,
  };

  if (format === "acp-jsonl") {
    const metaPath = join(sessionsRoot, `${sessionId}.json`);
    const jsonl = join(sessionsRoot, `${sessionId}.jsonl`);
    base.historyPath = jsonl;
    try {
      const raw = JSON.parse(readFileSync(metaPath, "utf-8")) as {
        cwd?: string;
        title?: string;
        updated_at?: string;
      };
      if (raw.cwd) base.cwd = raw.cwd;
      if (raw.title?.trim()) base.title = raw.title.trim();
      if (raw.updated_at) base.updatedAt = raw.updated_at;
    } catch {
      /* meta optional */
    }
    try {
      base.historyBytes = statSync(jsonl).size;
      if (!base.updatedAt) base.updatedAt = statSync(jsonl).mtime.toISOString();
    } catch {
      /* no history */
    }
    if (!base.title || base.title === "(untitled)") {
      const first = firstUserText(readAcpJsonl(jsonl, 64 * 1024));
      if (first) base.title = trunc(first, 80);
    }
    return base;
  }

  if (format === "codex-rollout") {
    const path = resolveCodexRollout(sessionsRoot, sessionId);
    base.historyPath = path;
    if (path) {
      try {
        const st = statSync(path);
        base.historyBytes = st.size;
        base.updatedAt = st.mtime.toISOString();
      } catch {
        /* ignore */
      }
      const head = readHeadText(path, 64 * 1024);
      const cwd = extractCodexCwd(head);
      if (cwd) base.cwd = cwd;
      const first = firstUserText(readCodexRollout(path));
      if (first) base.title = trunc(first, 80);
    }
    return base;
  }

  // opencode-storage
  const metaPath = findOpencodeSessionMeta(sessionsRoot, sessionId);
  base.historyPath = metaPath;
  if (metaPath) {
    try {
      const raw = JSON.parse(readFileSync(metaPath, "utf-8")) as {
        directory?: string;
        title?: string;
        time?: { updated?: number; created?: number };
      };
      if (raw.directory) base.cwd = raw.directory;
      if (raw.title?.trim()) base.title = raw.title.trim();
      const ts = raw.time?.updated ?? raw.time?.created;
      if (ts) base.updatedAt = new Date(ts).toISOString();
    } catch {
      /* ignore */
    }
  }
  const msgDir = join(sessionsRoot, "storage", "message", sessionId);
  if (existsSync(msgDir)) {
    try {
      let bytes = 0;
      for (const f of readdirSync(msgDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          bytes += statSync(join(msgDir, f)).size;
        } catch {
          /* skip */
        }
      }
      base.historyBytes = bytes;
    } catch {
      /* ignore */
    }
  }
  return base;
}

// ── ACP-compatible .jsonl (Kiro, Claude bot, Grok) ───────────────────────────
// Full-fidelity import parser — keeps thinking, tool calls, and tool results
// (the UI history parser intentionally drops most of that noise).

interface AcpContentBlock {
  kind?: string;
  data?: unknown;
  text?: unknown;
}

interface AcpEvent {
  kind?: string;
  data?: {
    content?: AcpContentBlock[];
    results?: unknown;
    meta?: { timestamp?: number };
    name?: string;
    tool_name?: string;
    message_id?: string;
  };
}

function readAcpJsonl(path: string, maxBytes = MAX_FILE_BYTES): HistoryEntry[] {
  const text = readFileCapped(path, maxBytes);
  if (!text) return [];
  const entries: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    for (const e of parseImportAcpLine(line)) entries.push(e);
  }
  return entries;
}

/** One source line may expand to multiple entries (text + tools + results). */
function parseImportAcpLine(line: string): HistoryEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let ev: AcpEvent;
  try {
    ev = JSON.parse(trimmed) as AcpEvent;
  } catch {
    return [];
  }
  const kind = ev.kind || "";
  const ts = ev.data?.meta?.timestamp;
  const content = Array.isArray(ev.data?.content) ? ev.data!.content! : [];

  if (kind === "Prompt" || kind === "UserMessage") {
    const text = extractAcpRichText(content, { includeThinking: false, includeTools: false });
    if (!text.trim()) return [];
    return [{ role: "user", text, timestamp: ts }];
  }

  if (kind === "AssistantMessage" || kind === "Response") {
    const text = extractAcpRichText(content, { includeThinking: true, includeTools: true });
    if (!text.trim()) return [];
    return [{ role: "assistant", text, timestamp: ts }];
  }

  if (kind === "ToolUse" || kind === "ToolUseResults" || kind === "ToolResults") {
    const text = extractAcpToolPayload(ev);
    if (!text.trim()) return [];
    const tool = ev.data?.tool_name || ev.data?.name || "tool";
    return [{ role: "tool", text, tool, timestamp: ts }];
  }

  return [];
}

function extractAcpRichText(
  content: AcpContentBlock[],
  opts: { includeThinking: boolean; includeTools: boolean },
): string {
  const parts: string[] = [];
  for (const block of content) {
    const k = block.kind || "";
    if (k === "text") {
      const t = blockText(block);
      if (t) parts.push(t);
    } else if (k === "thinking" && opts.includeThinking) {
      const t = blockText(block) || nestedText(block.data);
      if (t) parts.push(`[thinking] ${t}`);
    } else if ((k === "toolUse" || k === "tool_use") && opts.includeTools) {
      parts.push(formatToolUse(block.data));
    } else if (k === "toolResult" || k === "tool_result") {
      parts.push(formatToolResult(block.data));
    } else if (typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  return parts.join("\n").trim();
}

function extractAcpToolPayload(ev: AcpEvent): string {
  const parts: string[] = [];
  const toolName = ev.data?.tool_name || ev.data?.name || "tool";
  const content = Array.isArray(ev.data?.content) ? ev.data!.content! : [];
  for (const block of content) {
    if (block.kind === "toolResult" || block.kind === "tool_result") {
      parts.push(formatToolResult(block.data));
    } else if (block.kind === "toolUse" || block.kind === "tool_use") {
      parts.push(formatToolUse(block.data));
    } else {
      const t = blockText(block) || nestedText(block.data);
      if (t) parts.push(t);
    }
  }
  if (ev.data?.results !== undefined) {
    parts.push(`results: ${safeJson(ev.data.results, TOOL_BLOB_MAX)}`);
  }
  // Claude bot often logs ToolUse with only tool_name + empty text content.
  if (parts.length === 0) {
    return `[tool:${toolName}]`;
  }
  // Prefer prefixing the tool name when body has no explicit call label.
  if (!parts.some((p) => p.includes("[tool"))) {
    return `[tool:${toolName}] ${parts.join("\n")}`.trim();
  }
  return parts.join("\n").trim();
}

function formatToolUse(data: unknown): string {
  if (!data || typeof data !== "object") return "[tool]";
  const d = data as { name?: string; toolUseId?: string; input?: unknown; arguments?: unknown };
  const name = d.name || "tool";
  const input = d.input ?? d.arguments;
  const argText = input !== undefined ? safeJson(input, 8_000) : "";
  return argText ? `[tool_call:${name}] ${argText}` : `[tool_call:${name}]`;
}

function formatToolResult(data: unknown): string {
  if (!data || typeof data !== "object") return "[tool_result]";
  const d = data as {
    toolUseId?: string;
    status?: string;
    name?: string;
    content?: unknown;
  };
  const name = d.name || "tool";
  const status = d.status ? ` status=${d.status}` : "";
  const body = extractToolResultBody(d.content);
  return `[tool_result:${name}${status}] ${body}`.trim();
}

function extractToolResultBody(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return trunc(content, TOOL_BLOB_MAX);
  if (!Array.isArray(content)) return safeJson(content, TOOL_BLOB_MAX);
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const b = block as AcpContentBlock;
    if (b.kind === "text") {
      const t = blockText(b);
      if (t) parts.push(t);
    } else if (b.kind === "json") {
      parts.push(safeJson(b.data, TOOL_BLOB_MAX));
    } else if (b.kind === "resource" || b.kind === "resource_link") {
      parts.push(safeJson(b.data, 4_000));
    } else {
      const t = blockText(b) || nestedText(b.data);
      if (t) parts.push(t);
      else parts.push(safeJson(b, 4_000));
    }
  }
  return trunc(parts.join("\n"), TOOL_BLOB_MAX);
}

function blockText(block: AcpContentBlock): string {
  if (typeof block.data === "string") return block.data.trim();
  if (block.data && typeof block.data === "object") {
    const d = block.data as { text?: unknown };
    if (typeof d.text === "string") return d.text.trim();
  }
  if (typeof block.text === "string") return block.text.trim();
  return "";
}

function nestedText(data: unknown): string {
  if (typeof data === "string") return data.trim();
  if (data && typeof data === "object" && typeof (data as { text?: unknown }).text === "string") {
    return ((data as { text: string }).text || "").trim();
  }
  return "";
}

// ── Codex rollout ────────────────────────────────────────────────────────────

const ROLLOUT_ID_RE =
  /rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function resolveCodexRollout(sessionsRoot: string, sessionId: string): string | undefined {
  if (!existsSync(sessionsRoot)) return undefined;
  const needle = sessionId.toLowerCase();
  try {
    const names = readdirSync(sessionsRoot, { recursive: true }) as string[];
    for (const name of names) {
      const rel = String(name);
      if (!rel.endsWith(".jsonl") || !/rollout-/i.test(rel)) continue;
      const full = join(sessionsRoot, rel);
      const m = ROLLOUT_ID_RE.exec(full.replace(/\\/g, "/"));
      if (m && m[1]!.toLowerCase() === needle) return full;
      if (full.toLowerCase().includes(needle)) return full;
    }
  } catch (e) {
    log.warn("codex scan failed:", (e as Error).message);
  }
  return undefined;
}

function readCodexRollout(path: string | undefined): HistoryEntry[] {
  if (!path) return [];
  const text = readFileCapped(path, MAX_FILE_BYTES);
  if (!text) return [];
  const entries: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    const e = parseCodexLine(line);
    if (e) entries.push(e);
  }
  return entries;
}

function parseCodexLine(line: string): HistoryEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let ev: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
  try {
    ev = JSON.parse(trimmed) as typeof ev;
  } catch {
    return undefined;
  }
  if (ev.type !== "response_item" || !ev.payload || typeof ev.payload !== "object") return undefined;
  const p = ev.payload;
  const itemType = String(p.type ?? "");
  const ts = ev.timestamp ? Date.parse(ev.timestamp) : undefined;
  const timestamp = Number.isFinite(ts) ? ts : undefined;

  if (itemType === "message") {
    const role = codexRole(String(p.role ?? ""));
    if (!role) return undefined;
    const text = extractCodexText(p.content);
    if (!text.trim()) return undefined;
    return { role, text, timestamp };
  }
  if (itemType === "function_call" || itemType === "local_shell_call" || itemType === "custom_tool_call") {
    const tool =
      (typeof p.name === "string" && p.name) ||
      (typeof p.tool_name === "string" && p.tool_name) ||
      (itemType === "local_shell_call" ? "shell" : "tool");
    // Include arguments / output when present so tool work isn't lost.
    const detail = extractCodexToolDetail(p);
    return { role: "tool", text: detail || `(${tool})`, tool, timestamp };
  }
  if (itemType === "function_call_output") {
    const text = extractCodexText(p.content ?? p.output ?? p.text);
    if (!text.trim()) return undefined;
    return { role: "tool", text: trunc(text, 20_000), tool: "tool_result", timestamp };
  }
  return undefined;
}

function codexRole(role: string): HistoryRole | undefined {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "system" || role === "developer") return "system";
  return undefined;
}

function extractCodexText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block && typeof block === "object") {
      const b = block as { text?: unknown; type?: string };
      if (typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("").trim();
}

function extractCodexToolDetail(p: Record<string, unknown>): string {
  const name =
    (typeof p.name === "string" && p.name) ||
    (typeof p.tool_name === "string" && p.tool_name) ||
    "tool";
  const args = p.arguments ?? p.params ?? p.command;
  let argText = "";
  if (typeof args === "string") argText = args;
  else if (args && typeof args === "object") {
    try {
      argText = JSON.stringify(args);
    } catch {
      argText = String(args);
    }
  }
  if (argText.length > 8_000) argText = argText.slice(0, 8_000) + " …";
  return argText ? `${name}: ${argText}` : `(${name})`;
}

function extractCodexCwd(head: string): string {
  for (const line of head.split("\n")) {
    try {
      const obj = JSON.parse(line) as { type?: string; payload?: { cwd?: string }; cwd?: string };
      if (obj.type && obj.type !== "session_meta") continue;
      const cwd = obj.payload?.cwd || obj.cwd;
      if (cwd) return cwd;
    } catch {
      continue;
    }
  }
  return "";
}

// ── OpenCode storage (message + part JSON trees) ─────────────────────────────

function findOpencodeSessionMeta(opencodeRoot: string, sessionId: string): string | undefined {
  const sessionDir = join(opencodeRoot, "storage", "session");
  if (!existsSync(sessionDir)) return undefined;
  try {
    const names = readdirSync(sessionDir, { recursive: true }) as string[];
    for (const name of names) {
      const rel = String(name);
      if (!rel.endsWith(`${sessionId}.json`) && !rel.endsWith(`${sessionId}.json`.replace(/\\/g, "/"))) {
        // Accept any path ending with the session file name.
        if (!rel.replace(/\\/g, "/").endsWith(`/${sessionId}.json`) && !rel.endsWith(`${sessionId}.json`)) {
          continue;
        }
      }
      return join(sessionDir, rel);
    }
  } catch (e) {
    log.warn("opencode meta scan failed:", (e as Error).message);
  }
  // Fallback: walk project buckets.
  try {
    for (const bucket of readdirSync(sessionDir)) {
      const candidate = join(sessionDir, bucket, `${sessionId}.json`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function readOpencodeStorage(opencodeRoot: string, sessionId: string): HistoryEntry[] {
  const msgDir = join(opencodeRoot, "storage", "message", sessionId);
  if (!existsSync(msgDir)) return [];
  let files: string[];
  try {
    files = readdirSync(msgDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  // Message ids encode time; lexicographic order matches creation order for ses_/msg_ ids.
  files.sort();
  const entries: HistoryEntry[] = [];
  for (const file of files) {
    const msgPath = join(msgDir, file);
    let msg: {
      id?: string;
      role?: string;
      time?: { created?: number };
    };
    try {
      msg = JSON.parse(readFileSync(msgPath, "utf-8")) as typeof msg;
    } catch {
      continue;
    }
    const role = ocRole(msg.role);
    if (!role) continue;
    const msgId = msg.id || file.replace(/\.json$/, "");
    const text = readOpencodeParts(opencodeRoot, msgId);
    if (!text.trim() && role === "tool") {
      entries.push({ role: "tool", text: "(tool)", tool: "tool", timestamp: msg.time?.created });
      continue;
    }
    if (!text.trim()) continue;
    entries.push({
      role,
      text,
      tool: role === "tool" ? "tool" : undefined,
      timestamp: msg.time?.created,
    });
  }
  return entries;
}

function readOpencodeParts(opencodeRoot: string, messageId: string): string {
  const partDir = join(opencodeRoot, "storage", "part", messageId);
  if (!existsSync(partDir)) return "";
  let files: string[];
  try {
    files = readdirSync(partDir).filter((f) => f.endsWith(".json"));
  } catch {
    return "";
  }
  files.sort();
  const parts: string[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(partDir, file), "utf-8")) as {
        type?: string;
        text?: string;
        name?: string;
        tool?: string;
        state?: { status?: string; output?: unknown; input?: unknown; error?: unknown };
        output?: unknown;
        input?: unknown;
      };
      if (raw.type === "text" && typeof raw.text === "string") {
        parts.push(raw.text);
      } else if (raw.type === "reasoning" && typeof raw.text === "string") {
        // Keep reasoning — "nothing should be lost".
        parts.push(`[reasoning] ${raw.text}`);
      } else if (raw.type === "tool" || raw.type === "tool-invocation" || raw.type === "tool-result") {
        const name = raw.name || raw.tool || "tool";
        const bits: string[] = [`[tool:${name}]`];
        const input = raw.input ?? raw.state?.input;
        const output = raw.output ?? raw.state?.output;
        if (input !== undefined) bits.push(`input: ${safeJson(input, 6_000)}`);
        if (output !== undefined) bits.push(`output: ${safeJson(output, 12_000)}`);
        if (raw.state?.error !== undefined) bits.push(`error: ${safeJson(raw.state.error, 2_000)}`);
        parts.push(bits.join("\n"));
      } else if (typeof raw.text === "string" && raw.text.trim()) {
        parts.push(raw.text);
      }
    } catch {
      /* skip bad part */
    }
  }
  return parts.join("\n").trim();
}

function ocRole(role?: string): HistoryRole | undefined {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
      return "tool";
    default:
      return undefined;
  }
}

// ── shared helpers ───────────────────────────────────────────────────────────

function readFileCapped(path: string, maxBytes: number): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return "";
  }
  if (size === 0) return "";
  // Prefer the tail if the file is huge so the most recent context survives.
  const length = Math.min(size, maxBytes);
  const start = size > maxBytes ? size - maxBytes : 0;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    let text = buf.toString("utf-8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl !== -1) text = text.slice(nl + 1);
      text = `[…earlier history truncated at ${(start / 1024 / 1024).toFixed(1)} MB…]\n` + text;
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

function readHeadText(path: string, maxBytes: number): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return "";
  }
  if (size === 0) return "";
  const length = Math.min(size, maxBytes);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, 0);
    return buf.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

function firstUserText(entries: HistoryEntry[]): string {
  for (const e of entries) {
    if (e.role === "user" && e.text.trim()) return e.text.trim();
  }
  return "";
}

function trunc(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function safeJson(v: unknown, max: number): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v, null, 0);
  } catch {
    s = String(v);
  }
  return s.length > max ? s.slice(0, max) + " …" : s;
}
