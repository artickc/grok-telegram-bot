/**
 * tool-call-detail.ts
 *
 * Rich detail extractors + tool identity resolution for ACP tool updates.
 * Maps Grok tool names (read_file, run_terminal_command, grep, …) to display
 * kinds and pulls path / command / query / offset args from many raw shapes.
 */
import { contentText, type SessionUpdate, type ToolCallContent } from "../grok/types.js";

/** Max chars to show for search queries, command previews, etc. */
export const PREVIEW_MAX = 600;
/** Max chars for file content preview on write/create. */
export const CONTENT_PREVIEW_MAX = 1000;
/** Max chars for terminal / tool result bodies (display-only middle truncate). */
export const OUTPUT_PREVIEW_MAX = 3500;
/** Max lines for multi-line tool outputs before middle-omission. */
export const OUTPUT_PREVIEW_LINES = 80;

/**
 * Canonical display kinds used by the Telegram renderer.
 * (ACP often reports kind "other" — we re-derive from the tool name.)
 */
export type ToolDisplayKind =
  | "read"
  | "edit"
  | "write"
  | "create"
  | "execute"
  | "search"
  | "delete"
  | "move"
  | "rename"
  | "fetch"
  | "web_search"
  | "web_fetch"
  | "list"
  | "todo"
  | "think"
  | "image"
  | "mcp"
  | "other";

export interface ToolIdentity {
  /** Canonical kind for icons + formatters. */
  kind: ToolDisplayKind;
  /** Raw tool name when known (read_file, grep, server__tool, …). */
  toolName: string;
  /** True when this is a real namespaced MCP call. */
  isMcp: boolean;
  mcpServer?: string;
  mcpMethod?: string;
}

/** Normalize a loose ACP kind string (aliases only — no name inference). */
export function normalizeKind(kind: string | undefined): string {
  const k = (kind || "other").toLowerCase().trim();
  const ALIASES: Record<string, string> = {
    bash: "execute",
    shell: "execute",
    command: "execute",
    terminal: "execute",
    grep: "search",
    glob: "search",
    find: "search",
    ripgrep: "search",
    web_search: "web_search",
    web_fetch: "fetch",
    url: "fetch",
    http: "fetch",
    request: "fetch",
    rename: "move",
    copy: "move",
    mkdir: "create",
    touch: "create",
    list: "list",
    ls: "list",
  };
  return ALIASES[k] ?? k;
}

/**
 * Resolve display identity from ACP kind + title + rawInput.
 * Prefer the real tool name (read_file / grep / …) over a vague ACP `other`.
 */
export function resolveToolIdentity(u: SessionUpdate, raw: Record<string, unknown>): ToolIdentity {
  const toolName = extractToolName(u, raw);
  const lower = toolName.toLowerCase();
  const acpKind = normalizeKind(u.kind);

  // True MCP only when namespaced (server__tool, @server/tool, …).
  const mcp = parseMcpName(toolName);
  if (mcp) {
    // Still map known methods (e.g. filesystem__read_file) to a display kind.
    const methodKind = kindFromToolName(mcp.method);
    const kind: ToolDisplayKind =
      methodKind && methodKind !== "other" ? methodKind : "mcp";
    return {
      kind,
      toolName,
      isMcp: true,
      mcpServer: mcp.server,
      mcpMethod: mcp.method,
    };
  }

  const fromName = kindFromToolName(toolName) || kindFromTitle(u.title);
  // ACP kinds that are specific win; "other"/empty defer to the name.
  if (acpKind && acpKind !== "other" && acpKind !== "") {
    // Name is more specific for Grok tools (kind=other often, or wrong kind).
    if (fromName && fromName !== "other" && (acpKind === "other" || looksLikeGrokToolName(lower))) {
      return { kind: fromName, toolName, isMcp: false };
    }
    return { kind: (acpKind as ToolDisplayKind) || "other", toolName, isMcp: false };
  }
  return { kind: fromName ?? "other", toolName, isMcp: false };
}

/** Extract the tool name from update fields / raw input / title. */
export function extractToolName(u: SessionUpdate, raw: Record<string, unknown>): string {
  // ACP top-level name (RFD) and common Grok extensions first.
  const top =
    strOf(u.name) ||
    strOf(u.toolName) ||
    strOf((u as { tool_name?: unknown }).tool_name);
  if (top) return top.trim();

  const explicit =
    strOf(raw.tool_name) ||
    strOf(raw.toolName) ||
    strOf(raw.name) ||
    strOf(raw.tool) ||
    strOf(raw.function) ||
    strOf(raw.function_name);
  if (explicit) return explicit.trim();
  const t = (u.title || "").trim();
  // Title that looks like an identifier (read_file, run_terminal_command).
  if (t && /^[@a-zA-Z0-9._/-]+$/.test(t) && !t.includes(" ") && !/^tool[_ ]?call$/i.test(t)) {
    return t;
  }
  return "";
}

/** Map a tool name (or MCP method) to a display kind. */
export function kindFromToolName(name: string): ToolDisplayKind | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase().replace(/[\s-]+/g, "_");

  // Exact / suffix matches for Grok Build + common agent tools.
  if (
    /^(read_file|read|fs_read|file_read|view|open_file|cat)$/.test(n) ||
    n.endsWith("_read") ||
    n.includes("read_file")
  ) {
    return "read";
  }
  if (
    /^(write|write_file|fs_write|create_file|create)$/.test(n) ||
    n.includes("write_file") ||
    n === "write"
  ) {
    return "write";
  }
  if (
    /^(search_replace|str_replace|string_replace|edit|edit_file|apply_patch|multi_edit|smart_edit)$/.test(n) ||
    n.includes("replace") ||
    n.includes("search_replace")
  ) {
    return "edit";
  }
  if (/^(delete|delete_file|rm|unlink|remove_file)$/.test(n) || n.includes("delete_file")) {
    return "delete";
  }
  if (/^(move|rename|mv|copy|cp)$/.test(n)) {
    return n.includes("rename") ? "rename" : "move";
  }
  if (
    /^(run_terminal_command|run_terminal|shell|bash|execute|execute_bash|command|terminal)$/.test(n) ||
    n.includes("terminal") ||
    n.includes("shell") ||
    n.startsWith("run_")
  ) {
    return "execute";
  }
  if (
    /^(grep|glob|search|rg|smart_grep|smart_glob|find_files|codebase_search)$/.test(n) ||
    n.includes("grep") ||
    n.includes("glob") ||
    n.endsWith("_search")
  ) {
    // web_search handled below
    if (n.includes("web")) return "web_search";
    return "search";
  }
  if (/^(list_dir|list|ls|listdir|list_directory|read_dir)$/.test(n) || n.includes("list_dir")) {
    return "list";
  }
  if (/^(web_search|websearch)$/.test(n) || (n.includes("web") && n.includes("search"))) {
    return "web_search";
  }
  if (
    /^(web_fetch|webfetch|open_page|browse|fetch_url|http_request)$/.test(n) ||
    n.includes("web_fetch") ||
    n.includes("open_page")
  ) {
    return "web_fetch";
  }
  if (/^(todo_write|todo_list|todowrite|todoread)$/.test(n) || n.includes("todo")) {
    return "todo";
  }
  if (
    /^(spawn_subagent|task|delegate|subagent|think|thinking)$/.test(n) ||
    n.includes("subagent") ||
    n.includes("spawn")
  ) {
    return "think";
  }
  if (/image|video|imagine|nano.?banana|screenshot/.test(n)) {
    return "image";
  }
  // Broad regex fallbacks (same spirit as models.toolKind).
  if (/write|edit|create|apply|patch|str_replace|delete|move|mkdir/.test(n) && !/read/.test(n)) {
    if (/delete|rm|unlink/.test(n)) return "delete";
    if (/move|rename/.test(n)) return "move";
    if (/write|create|mkdir|touch/.test(n)) return "write";
    return "edit";
  }
  if (/read|view|open|cat|stat/.test(n)) return "read";
  if (/search|grep|find|glob/.test(n)) return "search";
  if (/bash|shell|exec|run|command|terminal|process/.test(n)) return "execute";
  if (/fetch|http|curl|browse/.test(n)) return "fetch";
  return undefined;
}

function kindFromTitle(title: string | undefined): ToolDisplayKind | undefined {
  if (!title) return undefined;
  const t = title.toLowerCase();
  if (/^read\b|reading\b/.test(t)) return "read";
  if (/^edit\b|^write\b|^create\b|edited|writing/.test(t)) return "edit";
  if (/^run\b|^exec\b|command|shell|bash|terminal/.test(t)) return "execute";
  if (/search|grep|glob|find/.test(t)) return "search";
  if (/delete|remove/.test(t)) return "delete";
  if (/fetch|http|url/.test(t)) return "fetch";
  if (/web search/.test(t)) return "web_search";
  if (/list|directory|folder/.test(t)) return "list";
  return kindFromToolName(title.replace(/\s+/g, "_"));
}

function looksLikeGrokToolName(n: string): boolean {
  return (
    n.includes("_") ||
    /^(read|write|grep|glob|shell|bash|edit|search|list|todo|fetch|run)/i.test(n)
  );
}

/** Parse server__method / @server/method MCP-style names. */
export function parseMcpName(name: string): { server: string; method: string } | undefined {
  if (!name) return undefined;
  const patterns = [
    /^@([a-z0-9._-]+)[/_]{1,3}(.+)$/i,
    /^([a-z0-9.-]+)___(.+)$/i,
    /^([a-z0-9.-]+)__(.+)$/i,
    /^([a-z0-9.-]+)\/([a-z0-9_.-]+)$/i,
  ];
  for (const re of patterns) {
    const m = re.exec(name);
    if (m) return { server: m[1]!, method: m[2]! };
  }
  return undefined;
}

/** Extract the primary file path from a tool-call raw input (+ locations). */
export function extractPath(raw: Record<string, unknown>, u?: SessionUpdate): string {
  const fromLoc = u?.locations?.find((l) => l.path)?.path;
  return (
    strOf(fromLoc) ||
    strOf(raw.path) ||
    strOf(raw.file_path) ||
    strOf(raw.filePath) ||
    strOf(raw.target_file) ||
    strOf(raw.targetFile) ||
    strOf(raw.target_path) ||
    strOf(raw.targetPath) ||
    strOf(raw.filename) ||
    strOf(raw.file) ||
    strOf(raw.uri) ||
    // Nested args (some MCP wrappers).
    strOf(nested(raw, "arguments", "path")) ||
    strOf(nested(raw, "arguments", "file_path")) ||
    strOf(nested(raw, "arguments", "target_file")) ||
    strOf(nested(raw, "input", "path")) ||
    strOf(nested(raw, "input", "target_file")) ||
    ""
  );
}

/** Extract a secondary/destination path (for moves, renames, copies). */
export function extractDestPath(raw: Record<string, unknown>): string {
  return (
    strOf(raw.new_path) ||
    strOf(raw.newPath) ||
    strOf(raw.destination) ||
    strOf(raw.dest) ||
    strOf(raw.to) ||
    strOf(raw.target_path) ||
    strOf(raw.targetPath) ||
    ""
  );
}

/** Extract search query / pattern from various raw input shapes. */
export function extractSearchQuery(raw: Record<string, unknown>): string {
  return (
    strOf(raw.pattern) ||
    strOf(raw.query) ||
    strOf(raw.search) ||
    strOf(raw.regex) ||
    strOf(raw.glob) ||
    strOf(raw.term) ||
    strOf(raw.q) ||
    strOf(nested(raw, "arguments", "pattern")) ||
    strOf(nested(raw, "arguments", "query")) ||
    ""
  );
}

/** Extract the search path/scope if present. */
export function extractSearchPath(raw: Record<string, unknown>): string {
  return (
    strOf(raw.path) ||
    strOf(raw.directory) ||
    strOf(raw.dir) ||
    strOf(raw.scope) ||
    strOf(raw.cwd) ||
    strOf(raw.folder) ||
    strOf(raw.target_directory) ||
    strOf(raw.targetDirectory) ||
    ""
  );
}

/** Extract a URL from a fetch/web request. */
export function extractUrl(raw: Record<string, unknown>): string {
  return (
    strOf(raw.url) ||
    strOf(raw.uri) ||
    strOf(raw.link) ||
    strOf(raw.endpoint) ||
    strOf(nested(raw, "arguments", "url")) ||
    ""
  );
}

/** Extract command string from an execute/shell call. */
export function extractCommand(raw: Record<string, unknown>): string {
  return (
    strOf(raw.command) ||
    strOf(raw.cmd) ||
    strOf(raw.shell_command) ||
    strOf(raw.shellCommand) ||
    strOf(nested(raw, "arguments", "command")) ||
    ""
  );
}

/** Extract file content for write/create operations. */
export function extractContent(raw: Record<string, unknown>): string {
  return (
    strOf(raw.content) ||
    strOf(raw.file_text) ||
    strOf(raw.text) ||
    strOf(raw.data) ||
    strOf(raw.new_string) ||
    strOf(raw.newString) ||
    ""
  );
}

/** Read-range / paging args for display. */
export function extractReadRange(raw: Record<string, unknown>): {
  offset?: string;
  limit?: string;
  startLine?: string;
  pages?: string;
} {
  const offset = strOf(raw.offset) || strOf(raw.start) || numStr(raw.offset);
  const limit = strOf(raw.limit) || strOf(raw.count) || numStr(raw.limit);
  const startLine =
    strOf(raw.start_line) ||
    strOf(raw.startLine) ||
    strOf(raw.line) ||
    numStr(raw.start_line) ||
    numStr(raw.line);
  const pages = strOf(raw.pages) || strOf(raw.page);
  const out: { offset?: string; limit?: string; startLine?: string; pages?: string } = {};
  if (offset) out.offset = offset;
  if (limit) out.limit = limit;
  if (startLine) out.startLine = startLine;
  if (pages) out.pages = pages;
  return out;
}

/** Extract include/exclude filters from a search call. */
export function extractFilters(raw: Record<string, unknown>): { include?: string; exclude?: string } {
  const include =
    strOf(raw.include) || strOf(raw.glob) || strOf(raw.file_pattern) || strOf(raw.type) || strOf(raw.glob_pattern);
  const exclude = strOf(raw.exclude) || strOf(raw.ignore) || strOf(raw.exclude_pattern);
  const out: { include?: string; exclude?: string } = {};
  if (include) out.include = include;
  if (exclude) out.exclude = exclude;
  return out;
}

/**
 * Pretty-print non-empty raw args for "other" / MCP tools so nothing important
 * is hidden. Skips meta keys and huge blobs (middle-truncated later by caller).
 */
export function formatArgLines(raw: Record<string, unknown>, maxLines = 24): string {
  const SKIP = new Set([
    "tool_name",
    "toolName",
    "name",
    "tool",
    "type",
    "_meta",
    "function",
    "function_name",
  ]);
  const lines: string[] = [];
  for (const [key, val] of Object.entries(raw)) {
    if (SKIP.has(key)) continue;
    if (val === undefined || val === null || val === "") continue;
    let s: string;
    if (typeof val === "string") s = val;
    else if (typeof val === "number" || typeof val === "boolean") s = String(val);
    else {
      try {
        s = JSON.stringify(val);
      } catch {
        s = String(val);
      }
    }
    if (s.length > 240) s = s.slice(0, 239) + "\u2026";
    lines.push(`${key}: ${s}`);
    if (lines.length >= maxLines) {
      lines.push("\u2026");
      break;
    }
  }
  return lines.join("\n");
}

/** Truncate text to max chars with ellipsis (head-only). */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

/**
 * Extract human-readable tool result text from ACP content blocks / content.
 * Used so completed execute/search/fetch calls show their output in Telegram
 * (display-truncated later — full results still live in the agent session).
 */
export function extractToolOutput(u: SessionUpdate): string {
  const parts: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string" && v.trim()) parts.push(v);
  };

  for (const b of collectContent(u)) {
    if (b.type === "diff") continue; // handled separately as a unified diff
    const nested = b.content;
    if (nested && typeof nested === "object") {
      push((nested as { text?: unknown }).text);
      const data = (nested as { data?: unknown }).data;
      if (typeof data === "string") push(data);
    }
    const extra = b as Record<string, unknown>;
    push(extra.text);
    push(extra.output);
    push(extra.stdout);
    push(extra.stderr);
    if (typeof extra.data === "string") push(extra.data);
  }

  push(contentText(u.content));
  const rawOut = (u as { rawOutput?: unknown }).rawOutput;
  if (rawOut && typeof rawOut === "object") {
    const ro = rawOut as Record<string, unknown>;
    push(ro.output);
    push(ro.stdout);
    push(ro.stderr);
    push(ro.text);
    push(ro.message);
  } else if (typeof rawOut === "string") {
    push(rawOut);
  }

  const out: string[] = [];
  for (const p of parts) {
    if (out[out.length - 1] === p) continue;
    out.push(p);
  }
  return out.join("\n").trim();
}

/** Collect all content blocks (diffs, text, etc.) from a tool update. */
export function collectContent(u: SessionUpdate): ToolCallContent[] {
  const out: ToolCallContent[] = [];
  if (Array.isArray(u.content_blocks)) out.push(...u.content_blocks);
  const content = (u as unknown as { content?: unknown }).content;
  if (Array.isArray(content)) out.push(...(content as ToolCallContent[]));
  return out;
}

/** Collect every file path referenced by a tool call. */
export function gatherPaths(u: SessionUpdate, raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === "string" && v) out.push(v);
  };
  add(raw.path);
  add(raw.file_path);
  add(raw.filename);
  add(raw.file);
  add(raw.target_file);
  add(raw.targetFile);
  add(raw.target_path);
  if (Array.isArray(raw.operations)) {
    for (const op of raw.operations) {
      if (op && typeof op === "object") add((op as Record<string, unknown>).path);
    }
  }
  for (const b of collectContent(u)) add(b.path);
  return out;
}

function nested(raw: Record<string, unknown>, a: string, b: string): unknown {
  const o = raw[a];
  if (o && typeof o === "object" && !Array.isArray(o)) {
    return (o as Record<string, unknown>)[b];
  }
  return undefined;
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function numStr(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}
