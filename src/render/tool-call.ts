/**
 * Format ACP tool-call updates into clear, RAW markdown blocks so they read
 * distinctly from the agent's prose and thinking. Each tool kind gets its own
 * rich detail: commands in bash blocks, diffs in diff blocks, search queries,
 * file paths, URLs, content previews, move/rename source+dest, delete paths.
 */
import type { SessionUpdate } from "../grok/types.js";
import { renderUnifiedDiff } from "./diff.js";
import {
  normalizeKind,
  extractPath,
  extractDestPath,
  extractSearchQuery,
  extractSearchPath,
  extractUrl,
  extractCommand,
  extractContent,
  extractFilters,
  truncate,
  collectContent,
  gatherPaths,
  PREVIEW_MAX,
  CONTENT_PREVIEW_MAX,
} from "./tool-call-detail.js";

const KIND_ICON: Record<string, string> = {
  read: "\u{1F4D6}",
  edit: "\u270F\uFE0F",
  write: "\u{1F4DD}",
  create: "\u{1F4DD}",
  execute: "\u{1F4BB}",
  search: "\u{1F50E}",
  delete: "\u{1F5D1}\uFE0F",
  move: "\u{1F4E6}",
  rename: "\u{1F4E6}",
  fetch: "\u{1F310}",
  web_search: "\u{1F310}",
  web_fetch: "\u{1F310}",
  think: "\u{1F4AD}",
  other: "\u{1F527}",
};

const STATUS_ICON: Record<string, string> = {
  pending: "",
  in_progress: "\u23F3",
  completed: "\u2705",
  failed: "\u274C",
};

export interface ToolFormatOptions {
  showDiffs: boolean;
  diffMaxLines: number;
}

/** Returns a RAW markdown block describing the tool call, or "" to skip. */
export function formatToolCall(u: SessionUpdate, opts: ToolFormatOptions): string {
  const kind = normalizeKind(u.kind);
  const raw = (u.rawInput || {}) as Record<string, unknown>;
  const status = u.status ? (STATUS_ICON[u.status] ?? "") : "";
  const tail = status ? " " + status : "";

  // Skill load
  if (kind !== "edit" && kind !== "delete" && kind !== "move" && kind !== "write" && kind !== "create") {
    const skill = detectSkill(u, raw);
    if (skill) return "\u{1F4DA} **Loaded skill: " + skill + "**" + tail;
  }

  // MCP / extension tool call
  const mcp = detectMcp(u, raw, kind);
  if (mcp) {
    const label = mcp.server ? "Call MCP " + mcp.server + ": " + mcp.method : "Call MCP: " + mcp.method;
    let out = "\u{1F9E9} **" + label + "**" + tail;
    const argPreview = mcpArgPreview(raw);
    if (argPreview) out += "\n" + fence(argPreview) + "\n";
    return out;
  }

  switch (kind) {
    case "execute":
      return formatExecute(raw, tail);
    case "edit":
      return formatEdit(u, raw, tail, opts);
    case "write":
    case "create":
      return formatWrite(kind, raw, tail);
    case "read":
      return formatRead(raw, tail);
    case "search":
      return formatSearch(raw, tail);
    case "delete":
      return formatDelete(raw, tail);
    case "move":
    case "rename":
      return formatMove(kind, raw, tail);
    case "fetch":
    case "web_fetch":
      return formatFetch(raw, tail);
    case "web_search":
      return formatWebSearch(raw, tail);
    default:
      return formatGeneric(u, raw, tail, kind);
  }
}

// ---- helpers for code fences (avoid backtick-in-template-literal issues) ----

/** Wrap text in a fenced code block with optional language. */
function fence(text: string, lang?: string): string {
  const marker = "```";
  return marker + (lang || "") + "\n" + text + "\n" + marker;
}

// ---- per-kind formatters ----

function formatExecute(raw: Record<string, unknown>, tail: string): string {
  const cmd = extractCommand(raw);
  const cwd = strOf(raw.cwd);
  const title = "Run command" + (cwd ? " in " + truncate(cwd, 80) : "");
  let out = "\u{1F4BB} **" + title + "**" + tail;
  if (cmd) out += "\n" + fence(truncate(cmd, PREVIEW_MAX), "bash") + "\n";
  return out;
}

function formatEdit(u: SessionUpdate, raw: Record<string, unknown>, tail: string, opts: ToolFormatOptions): string {
  const path = extractPath(raw);
  const title = "Edit " + (path || "file");
  let out = "\u270F\uFE0F **" + title + "**" + tail;
  if (opts.showDiffs) {
    const diff = buildEditDiff(u, raw, opts.diffMaxLines);
    if (diff && diff.block) {
      const stat = (diff.added > 0 ? "+" + diff.added : "") + (diff.removed > 0 ? " -" + diff.removed : "");
      out += (stat.trim() ? "  (" + stat.trim() + ")" : "") + "\n" + diff.block;
    }
  }
  return out;
}

function formatWrite(kind: string, raw: Record<string, unknown>, tail: string): string {
  const path = extractPath(raw);
  const verb = kind === "create" ? "Create" : "Write";
  let out = "\u{1F4DD} **" + verb + " " + (path || "file") + "**" + tail;
  const content = extractContent(raw);
  if (content) {
    out += "\n" + fence(truncate(content, CONTENT_PREVIEW_MAX), detectLang(path)) + "\n";
  }
  return out;
}

function formatRead(raw: Record<string, unknown>, tail: string): string {
  const path = extractPath(raw);
  const lines = strOf(raw.start_line) || strOf(raw.line);
  const offset = strOf(raw.offset);
  const limit = strOf(raw.limit);
  let title = "Read " + (path || "file");
  const parts: string[] = [];
  if (lines) parts.push("line " + lines);
  if (offset) parts.push("offset " + offset);
  if (limit) parts.push("limit " + limit);
  if (parts.length) title += " (" + parts.join(", ") + ")";
  return "\u{1F4D6} **" + title + "**" + tail;
}

function formatSearch(raw: Record<string, unknown>, tail: string): string {
  const query = extractSearchQuery(raw);
  const path = extractSearchPath(raw);
  const filters = extractFilters(raw);
  let title = "Search";
  if (query) title += ": " + truncate(query, 120);
  else if (path) title += " " + path;
  let out = "\u{1F50E} **" + title + "**" + tail;
  if (path && !query.includes(path)) out += "\n  \u{1F4C2} in: " + truncate(path, 100);
  if (filters.include) out += "\n  \u{1F4C1} include: " + filters.include;
  if (filters.exclude) out += "\n  \u{1F6AB} exclude: " + filters.exclude;
  if (raw.case_sensitive !== undefined)
    out += "\n  case-sensitive: " + (raw.case_sensitive ? "yes" : "no");
  return out;
}

function formatDelete(raw: Record<string, unknown>, tail: string): string {
  const path = extractPath(raw);
  return "\u{1F5D1}\uFE0F **Delete " + (path || "file") + "**" + tail;
}

function formatMove(kind: string, raw: Record<string, unknown>, tail: string): string {
  const src = extractPath(raw);
  const dst = extractDestPath(raw);
  const verb = kind === "rename" ? "Rename" : "Move";
  if (src && dst) {
    return "\u{1F4E6} **" + verb + "**" + tail + "\n  \u{1F4C4} " + truncate(src, 100) + "\n  \u27A1\uFE0F " + truncate(dst, 100);
  }
  return "\u{1F4E6} **" + verb + " " + (src || dst || "file") + "**" + tail;
}

function formatFetch(raw: Record<string, unknown>, tail: string): string {
  const url = extractUrl(raw);
  const method = strOf(raw.method) || strOf(raw.verb) || "GET";
  let title = "Fetch URL";
  if (url) title = "Fetch " + truncate(url, 200);
  let out = "\u{1F310} **" + title + "**" + tail;
  if (method && method !== "GET") out += "\n  method: " + method;
  const headers = raw.headers;
  if (headers && typeof headers === "object") {
    const hs = JSON.stringify(headers);
    if (hs !== "{}") out += "\n  headers: " + truncate(hs, 200);
  }
  const body = strOf(raw.body) || strOf(raw.data);
  if (body) out += "\n  body: " + truncate(body, 200);
  return out;
}

function formatWebSearch(raw: Record<string, unknown>, tail: string): string {
  const query = extractSearchQuery(raw) || extractUrl(raw);
  const count = strOf(raw.count) || strOf(raw.num) || strOf(raw.num_results);
  let title = "Web search";
  if (query) title += ": " + truncate(query, 150);
  let out = "\u{1F310} **" + title + "**" + tail;
  if (count) out += "\n  results: " + count;
  return out;
}

function formatGeneric(u: SessionUpdate, raw: Record<string, unknown>, tail: string, kind: string): string {
  const icon = KIND_ICON[kind] ?? KIND_ICON.other;
  const path = extractPath(raw);
  const title = u.title || (path ? capitalize(kind) + " " + path : capitalize(kind));
  let out = icon + " **" + title + "**" + tail;
  const desc = strOf(raw.description) || strOf(raw.message) || strOf(raw.prompt);
  if (desc) out += "\n  " + truncate(desc, 300);
  return out;
}

// ---- diff building ----

function buildEditDiff(u: SessionUpdate, raw: Record<string, unknown>, maxLines: number) {
  const blocks = collectContent(u);
  const diffBlock = blocks.find((b) => b.type === "diff");
  if (diffBlock) {
    return renderUnifiedDiff({
      path: strOf(diffBlock.path) || strOf(raw.path) || "file",
      oldText: typeof diffBlock.oldText === "string" ? diffBlock.oldText : "",
      newText: typeof diffBlock.newText === "string" ? diffBlock.newText : "",
      maxLines,
    });
  }
  const oldStr = strOf(raw.old_str) || strOf(raw.oldStr) || strOf(raw.old_string) || strOf(raw.find);
  const newStr = strOf(raw.new_str) || strOf(raw.newStr) || strOf(raw.new_string) || strOf(raw.replace);
  if (oldStr || newStr) {
    return renderUnifiedDiff({ path: strOf(raw.path) || "file", oldText: oldStr, newText: newStr, maxLines });
  }
  const content = strOf(raw.file_text) || strOf(raw.content) || strOf(raw.text);
  if (content) {
    return renderUnifiedDiff({ path: strOf(raw.path) || "file", oldText: "", newText: content, maxLines });
  }
  return undefined;
}

// ---- language detection ----

function detectLang(path: string): string {
  const ext = (path.split(".").pop() || "").toLowerCase();
  const MAP: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", go: "go", rs: "rust", java: "java",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    cs: "csharp", rb: "ruby", php: "php", swift: "swift",
    kt: "kotlin", scala: "scala", sh: "bash", bash: "bash",
    sql: "sql", html: "html", css: "css", scss: "scss",
    json: "json", yaml: "yaml", yml: "yaml", xml: "xml",
    md: "markdown", toml: "toml", ini: "ini", cfg: "ini",
    vue: "vue", svelte: "svelte", dart: "dart", lua: "lua",
    r: "r", pl: "perl", ps1: "powershell",
  };
  return MAP[ext] || "";
}

// ---- MCP helpers ----

/** Compact one-line-per-key preview of an MCP call's arguments. */
function mcpArgPreview(raw: Record<string, unknown>): string {
  const SKIP = new Set(["tool_name", "toolName", "name", "tool", "type", "_meta"]);
  const lines: string[] = [];
  for (const [key, val] of Object.entries(raw)) {
    if (SKIP.has(key)) continue;
    let s: string;
    if (typeof val === "string") s = val;
    else if (typeof val === "number" || typeof val === "boolean") s = String(val);
    else {
      try { s = JSON.stringify(val); } catch { s = String(val); }
    }
    if (s.length > 200) s = s.slice(0, 199) + "\u2026";
    lines.push(key + ": " + s);
  }
  return truncate(lines.join("\n"), PREVIEW_MAX);
}

/** Built-in Grok tools that must never be labelled as MCP calls. */
const BUILTIN_TOOLS = new Set([
  "read", "write", "shell", "grep", "glob", "web_fetch", "web_search", "fs_read",
  "fs_write", "fs_replace", "fs_search", "execute_bash", "report_issue", "use_aws",
  "todo_list", "introspect", "knowledge", "thinking", "summary", "subagent",
  "edit", "create", "delete", "move", "rename", "execute", "search", "fetch",
]);
/** Tool kinds that are first-class file/shell operations (never MCP). */
const FILE_KINDS = new Set([
  "read", "edit", "execute", "search", "delete", "move", "write", "create",
  "rename", "fetch", "web_fetch", "web_search",
]);
/** `.../skills/<name>/SKILL.md` - the signature of loading a skill. */
const SKILL_RE = /[\\/]skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i;
/** Namespaced MCP tool-name shapes - [, server, method]. */
const MCP_NS = [
  /^@([a-z0-9._-]+)[/_]{1,3}(.+)$/i,
  /^([a-z0-9.-]+)___(.+)$/i,
  /^([a-z0-9.-]+)__(.+)$/i,
  /^([a-z0-9.-]+)\/(.+)$/i,
  /^([a-z0-9-]+)\.(.+)$/i,
];

function detectSkill(u: SessionUpdate, raw: Record<string, unknown>): string | undefined {
  for (const p of gatherPaths(u, raw)) {
    const m = SKILL_RE.exec(p);
    if (m) return m[1]!;
  }
  return undefined;
}

function detectMcp(
  u: SessionUpdate,
  raw: Record<string, unknown>,
  kind: string,
): { server?: string; method: string } | undefined {
  const name = mcpToolName(u, raw);
  if (!name) return undefined;
  for (const re of MCP_NS) {
    const m = re.exec(name);
    if (m) return { server: m[1]!, method: m[2]! };
  }
  if (!BUILTIN_TOOLS.has(name.toLowerCase()) && !FILE_KINDS.has(kind)) {
    return { method: name };
  }
  return undefined;
}

function mcpToolName(u: SessionUpdate, raw: Record<string, unknown>): string {
  const explicit = strOf(raw.tool_name) || strOf(raw.toolName) || strOf(raw.name) || strOf(raw.tool);
  if (explicit) return explicit;
  const t = (u.title || "").trim();
  return /^[@a-z0-9._/-]+$/i.test(t) && !t.includes(":") ? t : "";
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}
