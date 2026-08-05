/**
 * Format ACP tool-call updates into clear, RAW markdown blocks so they read
 * distinctly from the agent's prose and thinking. Each tool kind gets its own
 * rich detail: commands in bash blocks, diffs in diff blocks, search queries,
 * file paths (with offset/limit), URLs, content previews, MCP args.
 *
 * Grok often reports kind "other" with title/name `read_file` / `grep` / etc.
 * {@link resolveToolIdentity} maps those to real display kinds so users never
 * see a bare "Other" or a false "Call MCP: read_file".
 */
import type { SessionUpdate } from "../grok/types.js";
import { renderUnifiedDiff } from "./diff.js";
import {
  resolveToolIdentity,
  extractPath,
  extractDestPath,
  extractSearchQuery,
  extractSearchPath,
  extractUrl,
  extractCommand,
  extractContent,
  extractFilters,
  extractReadRange,
  extractToolOutput,
  extractToolName,
  formatArgLines,
  truncate,
  collectContent,
  gatherPaths,
  PREVIEW_MAX,
  CONTENT_PREVIEW_MAX,
  OUTPUT_PREVIEW_MAX,
  OUTPUT_PREVIEW_LINES,
  type ToolDisplayKind,
} from "./tool-call-detail.js";
import { formatLiveTerminalOutput, truncateMiddle, truncateMiddleLines } from "./truncate.js";

const KIND_ICON: Record<string, string> = {
  read: "\u{1F4D6}", // 📖
  edit: "\u270F\uFE0F", // ✏️
  write: "\u{1F4DD}", // 📝
  create: "\u{1F4DD}",
  execute: "\u{1F4BB}", // 💻
  search: "\u{1F50E}", // 🔎
  delete: "\u{1F5D1}\uFE0F", // 🗑️
  move: "\u{1F4E6}", // 📦
  rename: "\u{1F4E6}",
  fetch: "\u{1F310}", // 🌐
  web_search: "\u{1F310}",
  web_fetch: "\u{1F310}",
  list: "\u{1F4C1}", // 📁
  todo: "\u2705", // ✅
  think: "\u{1F4AD}", // 💭
  image: "\u{1F5BC}\uFE0F", // 🖼️
  mcp: "\u{1F9E9}", // 🧩
  other: "\u{1F527}", // 🔧
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
  const raw = flattenRawInput(u);
  // Inject path from ACP locations when rawInput is thin.
  if (u.locations?.[0]?.path && !raw.path && !raw.target_file && !raw.file_path) {
    raw.path = u.locations[0].path;
    if (u.locations[0].line != null && raw.start_line == null) raw.start_line = u.locations[0].line;
  }
  const id = resolveToolIdentity(u, raw);
  const status = u.status ? (STATUS_ICON[u.status] ?? "") : "";
  const tail = status ? " " + status : "";

  // Plan mode enter/exit — surface clearly (exit failures used to look opaque).
  const planCard = formatPlanModeTool(u, raw, id.toolName, tail);
  if (planCard) return planCard;

  // Skill load (SKILL.md path) — not a normal edit.
  if (id.kind !== "edit" && id.kind !== "delete" && id.kind !== "move" && id.kind !== "write" && id.kind !== "create") {
    const skill = detectSkill(u, raw);
    if (skill) return "\u{1F4DA} **Loaded skill: " + skill + "**" + tail;
  }

  // Real MCP (namespaced) — badge + rich method-specific detail when possible.
  if (id.isMcp) {
    const label = id.mcpServer
      ? `\u{1F9E9} **MCP ${id.mcpServer} \u00B7 ${id.mcpMethod || id.toolName}**${tail}`
      : `\u{1F9E9} **MCP: ${id.mcpMethod || id.toolName}**${tail}`;
    // Prefer rich formatter for known methods (read/search/…); keep MCP header.
    if (id.kind !== "mcp" && id.kind !== "other") {
      const body = formatByKind(id.kind, u, raw, "", opts, id.mcpMethod || id.toolName);
      return label + "\n" + body;
    }
    let out = label;
    const args = formatArgLines(raw);
    if (args) out += "\n" + fence(truncateMiddle(args, PREVIEW_MAX)) + "\n";
    const result = extractToolOutput(u);
    if (result) {
      out +=
        "\n**Output:**\n" +
        fence(truncateMiddleLines(result, OUTPUT_PREVIEW_LINES, OUTPUT_PREVIEW_MAX)) +
        "\n";
    }
    return out;
  }

  return formatByKind(id.kind, u, raw, tail, opts, id.toolName);
}

function formatByKind(
  kind: ToolDisplayKind | string,
  u: SessionUpdate,
  raw: Record<string, unknown>,
  tail: string,
  opts: ToolFormatOptions,
  toolName: string,
): string {
  switch (kind) {
    case "execute":
      return formatExecute(u, raw, tail, toolName);
    case "edit":
      return formatEdit(u, raw, tail, opts, toolName);
    case "write":
    case "create":
      return formatWrite(u, kind, raw, tail);
    case "read":
      return formatRead(u, raw, tail, toolName);
    case "list":
      return formatList(u, raw, tail, toolName);
    case "search":
      return formatSearch(u, raw, tail, toolName);
    case "delete":
      return formatDelete(raw, tail);
    case "move":
    case "rename":
      return formatMove(kind, raw, tail);
    case "fetch":
    case "web_fetch":
      return formatFetch(u, raw, tail);
    case "web_search":
      return formatWebSearch(u, raw, tail);
    case "todo":
      return formatTodo(raw, tail, toolName);
    case "think":
      return formatThink(raw, tail, toolName, u);
    case "image":
      return formatImage(raw, tail, toolName);
    default:
      return formatGeneric(u, raw, tail, kind, toolName);
  }
}

// ---- helpers for code fences / path labels ----

/**
 * File paths in **bold** break Telegram MarkdownV2 (Windows `\`, dots, long
 * session paths). Always put paths in inline code; keep only the verb bold.
 *   ✏️ **Edit** `C:\Users\…\plan.md`
 */
function pathCode(path: string | undefined | null, fallback = "file"): string {
  const p = (path || "").trim() || fallback;
  // Inline code cannot contain raw backticks unescaped in our MD pipeline;
  // replace rare ` in paths so the span stays closed.
  return "`" + p.replace(/`/g, "'") + "`";
}

/** `**Edit** \`path\`` style header fragment (no leading emoji). */
function boldVerbPath(verb: string, path: string | undefined | null, fallback = "file"): string {
  return "**" + verb + "** " + pathCode(path, fallback);
}

/** Fence that lengthens itself when the body contains backticks (avoids MD break). */
function fence(text: string, lang?: string): string {
  let tickLen = 3;
  const runs = text.match(/`+/g);
  if (runs) {
    const max = Math.max(...runs.map((r) => r.length));
    if (max >= tickLen) tickLen = max + 1;
  }
  const marker = "`".repeat(tickLen);
  return marker + (lang || "") + "\n" + text + "\n" + marker;
}

/** Merge rawInput with nested arguments/input objects Grok sometimes uses. */
function flattenRawInput(u: SessionUpdate): Record<string, unknown> {
  const raw = { ...((u.rawInput || {}) as Record<string, unknown>) };
  for (const key of ["arguments", "input", "args", "parameters"]) {
    const nested = raw[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
        if (raw[k] === undefined) raw[k] = v;
      }
    }
  }
  return raw;
}

// ---- per-kind formatters ----

function formatExecute(
  u: SessionUpdate,
  raw: Record<string, unknown>,
  tail: string,
  toolName: string,
): string {
  const cmd = extractCommand(raw);
  const cwd = strOf(raw.cwd) || strOf(raw.working_directory) || strOf(raw.workingDirectory);
  let out = "\u{1F4BB} **Run command**" + tail;
  if (cwd) out += " in " + pathCode(truncate(cwd, 80));
  if (toolName && toolName !== "execute" && toolName !== "shell" && toolName !== "bash") {
    out += `\n  tool: \`${toolName}\``;
  }
  if (cmd) out += "\n" + fence(truncateMiddle(cmd, PREVIEW_MAX), "bash") + "\n";
  else {
    // No command field — dump args so the user still sees what ran.
    const args = formatArgLines(raw);
    if (args) out += "\n" + fence(truncateMiddle(args, PREVIEW_MAX)) + "\n";
  }
  // Display: first output line + live tail (one block, updated in place via upsert).
  // Full stdout remains in the agent session / merged tool snapshot.
  const result = extractToolOutput(u);
  if (result) {
    const live = formatLiveTerminalOutput(result, 12, OUTPUT_PREVIEW_MAX);
    out += "\n**Output:**\n" + fence(live) + "\n";
  }
  return out;
}

function formatEdit(
  u: SessionUpdate,
  raw: Record<string, unknown>,
  tail: string,
  opts: ToolFormatOptions,
  toolName: string,
): string {
  const path = extractPath(raw);
  let out = "\u270F\uFE0F " + boldVerbPath("Edit", path) + tail;
  if (toolName && !/edit|replace/i.test(toolName)) out += `\n  tool: \`${toolName}\``;
  if (opts.showDiffs) {
    const diff = buildEditDiff(u, raw, opts.diffMaxLines);
    if (diff && diff.block) {
      const stat = (diff.added > 0 ? "+" + diff.added : "") + (diff.removed > 0 ? " -" + diff.removed : "");
      out += (stat.trim() ? "  (" + stat.trim() + ")" : "") + "\n" + diff.block;
    }
  }
  return out;
}

function formatWrite(u: SessionUpdate, kind: string, raw: Record<string, unknown>, tail: string): string {
  const path = extractPath(raw);
  const verb = kind === "create" ? "Create" : "Write";
  let out = "\u{1F4DD} " + boldVerbPath(verb, path) + tail;
  const content = extractContent(raw) || extractToolOutput(u);
  if (content) {
    out += "\n" + fence(truncateMiddleLines(content, OUTPUT_PREVIEW_LINES, CONTENT_PREVIEW_MAX), detectLang(path)) + "\n";
  }
  return out;
}

function formatRead(
  u: SessionUpdate,
  raw: Record<string, unknown>,
  tail: string,
  toolName: string,
): string {
  const path = extractPath(raw, u);
  const range = extractReadRange(raw);
  const parts: string[] = [];
  if (range.startLine) parts.push("line " + range.startLine);
  if (range.offset) parts.push("offset " + range.offset);
  if (range.limit) parts.push("limit " + range.limit);
  if (range.pages) parts.push("pages " + range.pages);
  let out = "\u{1F4D6} " + boldVerbPath("Read", path) + tail;
  if (parts.length) out += " (" + parts.join(", ") + ")";
  if (toolName && toolName !== "read" && toolName !== "read_file") {
    out += `\n  tool: \`${toolName}\``;
  }
  // Extra range detail lines for clarity when many fields present.
  if (parts.length >= 2) {
    out += "\n  " + parts.join(" \u00B7 ");
  }
  const body = extractToolOutput(u);
  if (body) {
    out += "\n" + fence(truncateMiddleLines(body, OUTPUT_PREVIEW_LINES, OUTPUT_PREVIEW_MAX), detectLang(path)) + "\n";
  }
  return out;
}

function formatList(
  u: SessionUpdate,
  raw: Record<string, unknown>,
  tail: string,
  toolName: string,
): string {
  const path =
    extractPath(raw) ||
    extractSearchPath(raw) ||
    strOf(raw.target_directory) ||
    strOf(raw.targetDirectory) ||
    ".";
  let out = "\u{1F4C1} " + boldVerbPath("List", truncate(path, 120), ".") + tail;
  if (toolName) out += `\n  tool: \`${toolName}\``;
  const filters = extractFilters(raw);
  if (filters.include) out += "\n  include: `" + filters.include.replace(/`/g, "'") + "`";
  if (filters.exclude) out += "\n  exclude: `" + filters.exclude.replace(/`/g, "'") + "`";
  const body = extractToolOutput(u);
  if (body) {
    out += "\n" + fence(truncateMiddleLines(body, OUTPUT_PREVIEW_LINES, OUTPUT_PREVIEW_MAX)) + "\n";
  }
  return out;
}

function formatSearch(
  u: SessionUpdate,
  raw: Record<string, unknown>,
  tail: string,
  toolName: string,
): string {
  const query = extractSearchQuery(raw);
  const path = extractSearchPath(raw);
  const filters = extractFilters(raw);
  const isGlob = /glob/i.test(toolName) || (!!filters.include && !query);
  const verb = isGlob ? "Glob" : "Search";
  let out = "\u{1F50E} **" + verb + "**" + tail;
  if (query) out += " " + pathCode(truncate(query, 120), "query");
  else if (path) out += " " + pathCode(truncate(path, 120));
  if (toolName && toolName !== "search" && toolName !== "grep") {
    out += `\n  tool: \`${toolName}\``;
  }
  if (path && query) out += "\n  \u{1F4C2} in: " + pathCode(truncate(path, 100));
  if (filters.include) out += "\n  \u{1F4C1} include: " + pathCode(filters.include);
  if (filters.exclude) out += "\n  \u{1F6AB} exclude: " + pathCode(filters.exclude);
  if (raw.case_sensitive !== undefined) {
    out += "\n  case-sensitive: " + (raw.case_sensitive ? "yes" : "no");
  }
  if (raw.multiline !== undefined) out += "\n  multiline: " + (raw.multiline ? "yes" : "no");
  if (raw.type) out += "\n  type: " + String(raw.type);
  const hits = extractToolOutput(u);
  if (hits) {
    out += "\n" + fence(truncateMiddleLines(hits, OUTPUT_PREVIEW_LINES, OUTPUT_PREVIEW_MAX)) + "\n";
  }
  return out;
}

function formatDelete(raw: Record<string, unknown>, tail: string): string {
  const path = extractPath(raw);
  return "\u{1F5D1}\uFE0F " + boldVerbPath("Delete", path) + tail;
}

function formatMove(kind: string, raw: Record<string, unknown>, tail: string): string {
  const src = extractPath(raw);
  const dst = extractDestPath(raw);
  const verb = kind === "rename" ? "Rename" : "Move";
  if (src && dst) {
    return (
      "\u{1F4E6} **" +
      verb +
      "**" +
      tail +
      "\n  \u{1F4C4} " +
      pathCode(truncate(src, 100)) +
      "\n  \u27A1\uFE0F " +
      pathCode(truncate(dst, 100))
    );
  }
  return "\u{1F4E6} " + boldVerbPath(verb, src || dst) + tail;
}

function formatFetch(u: SessionUpdate, raw: Record<string, unknown>, tail: string): string {
  const url = extractUrl(raw);
  const method = strOf(raw.method) || strOf(raw.verb) || "GET";
  let out = url
    ? "\u{1F310} **Fetch** " + pathCode(truncate(url, 200), "URL") + tail
    : "\u{1F310} **Fetch URL**" + tail;
  if (method && method !== "GET") out += "\n  method: " + method;
  const headers = raw.headers;
  if (headers && typeof headers === "object") {
    const hs = JSON.stringify(headers);
    if (hs !== "{}") out += "\n  headers: " + truncate(hs, 200);
  }
  const body = strOf(raw.body) || strOf(raw.data);
  if (body) out += "\n  body: " + truncate(body, 200);
  const result = extractToolOutput(u);
  if (result) {
    out += "\n" + fence(truncateMiddleLines(result, OUTPUT_PREVIEW_LINES, OUTPUT_PREVIEW_MAX)) + "\n";
  }
  return out;
}

function formatWebSearch(u: SessionUpdate, raw: Record<string, unknown>, tail: string): string {
  const query = extractSearchQuery(raw) || extractUrl(raw);
  const count = strOf(raw.count) || strOf(raw.num) || strOf(raw.num_results) || numStr(raw.num_results);
  let out = "\u{1F310} **Web search**" + tail;
  if (query) out += " " + pathCode(truncate(query, 150), "query");
  if (count) out += "\n  results: " + count;
  const result = extractToolOutput(u);
  if (result) {
    out += "\n" + fence(truncateMiddleLines(result, OUTPUT_PREVIEW_LINES, OUTPUT_PREVIEW_MAX)) + "\n";
  }
  return out;
}

function formatTodo(raw: Record<string, unknown>, tail: string, toolName: string): string {
  let out = "\u2705 **Todos**" + tail;
  if (toolName) out += `\n  tool: \`${toolName}\``;
  const args = formatArgLines(raw);
  if (args) out += "\n" + fence(truncateMiddle(args, PREVIEW_MAX)) + "\n";
  return out;
}

function formatThink(
  raw: Record<string, unknown>,
  tail: string,
  toolName: string,
  u: SessionUpdate,
): string {
  const desc =
    strOf(raw.description) ||
    strOf(raw.prompt) ||
    strOf(raw.message) ||
    strOf(raw.task) ||
    u.title ||
    toolName ||
    "subagent";
  let out = "\u{1F4AD} **Delegate / think**" + tail + "\n  " + truncate(desc, 300);
  if (toolName) out += `\n  tool: \`${toolName}\``;
  const args = formatArgLines(raw);
  if (args) out += "\n" + fence(truncateMiddle(args, PREVIEW_MAX)) + "\n";
  return out;
}

function formatImage(raw: Record<string, unknown>, tail: string, toolName: string): string {
  const path = extractPath(raw) || strOf(raw.image) || strOf(raw.output);
  let out = "\u{1F5BC}\uFE0F **Image**" + tail;
  if (toolName) out += `\n  tool: \`${toolName}\``;
  if (path) out += "\n  " + pathCode(truncate(path, 200));
  const prompt = strOf(raw.prompt);
  if (prompt) out += "\n  prompt: " + truncate(prompt, 200);
  return out;
}

/**
 * Enter/exit plan mode tools — show status + failure reason (e.g. client
 * disconnected when the bridge did not answer the plan-approval reverse-request).
 */
function formatPlanModeTool(
  u: SessionUpdate,
  raw: Record<string, unknown>,
  toolName: string,
  tail: string,
): string | undefined {
  const name = (toolName || u.title || "").toLowerCase();
  const variant = String(raw.variant ?? raw.action ?? "").toLowerCase();
  const isEnter =
    name.includes("enter_plan") ||
    name === "plan: enter" ||
    variant.includes("enterplan");
  const isExit =
    name.includes("exit_plan") ||
    name === "plan: exit" ||
    variant.includes("exitplan");
  if (!isEnter && !isExit) return undefined;

  const icon = isExit ? "\u{1F4CB}" : "\u{1F4D1}";
  const label = isExit ? "Plan: Exit" : "Plan: Enter";
  let out = `${icon} **${label}**${tail}`;
  if (variant) out += `\n  variant: \`${String(raw.variant ?? raw.action)}\``;
  const result = extractToolOutput(u);
  if (result) {
    // Prefer a short, visible failure/success reason over a huge dump.
    const short = truncateMiddle(result.trim(), 500);
    out += "\n" + fence(short) + "\n";
  } else if ((u.status || "").toLowerCase() === "failed") {
    out += "\n  \u274C Plan approval failed (bridge should auto-approve exit).";
  }
  return out;
}

function formatGeneric(
  u: SessionUpdate,
  raw: Record<string, unknown>,
  tail: string,
  kind: string,
  toolName: string,
): string {
  const icon = KIND_ICON[kind] ?? KIND_ICON.other;
  const path = extractPath(raw);
  const cmd = extractCommand(raw);
  const query = extractSearchQuery(raw);
  // Never show a bare "Other" / "Tool call" — prefer real tool name. Paths/queries
  // go in inline code (not bold) so Windows paths cannot break MarkdownV2.
  let label =
    (toolName && !/^tool[_ ]?call$/i.test(toolName) ? toolName : "") ||
    (u.title && !/^other$/i.test(u.title.trim()) && !/^tool[_ ]?call$/i.test(u.title.trim())
      ? u.title.trim()
      : "") ||
    (path ? capitalize(kind !== "other" ? kind : "use") : "") ||
    (cmd ? "Run command" : "") ||
    (query ? "Search" : "") ||
    (kind && kind !== "other" ? capitalize(kind) : "") ||
    (toolName || "Tool");
  if (/^other$/i.test(label) || /^tool[_ ]?call$/i.test(label)) {
    label = toolName && !/^tool[_ ]?call$/i.test(toolName) ? toolName : "Tool";
  }
  // Titles that accidentally embed a path stay short: drop path from bold label.
  if (path && label.includes(path)) {
    label = label.replace(path, "").replace(/\s+/g, " ").trim() || capitalize(kind !== "other" ? kind : "Tool");
  }

  let out = icon + " **" + label + "**" + tail;
  if (toolName && toolName !== label) out += `\n  tool: \`${toolName}\``;
  if (path) out += "\n  \u{1F4C4} " + pathCode(truncate(path, 120));
  if (cmd) out += "\n" + fence(truncateMiddle(cmd, PREVIEW_MAX), "bash") + "\n";
  else if (query) out += "\n  query: " + pathCode(truncate(query, 150), "query");
  else if (!path && !cmd) {
    const args = formatArgLines(raw);
    if (args) out += "\n" + fence(truncateMiddle(args, PREVIEW_MAX)) + "\n";
  }
  const result = extractToolOutput(u);
  if (result) {
    out += "\n" + fence(truncateMiddleLines(result, OUTPUT_PREVIEW_LINES, OUTPUT_PREVIEW_MAX)) + "\n";
  }
  return out;
}

// ---- diff building ----

function buildEditDiff(u: SessionUpdate, raw: Record<string, unknown>, maxLines: number) {
  const blocks = collectContent(u);
  const diffBlock = blocks.find((b) => b.type === "diff");
  if (diffBlock) {
    return renderUnifiedDiff({
      path: strOf(diffBlock.path) || extractPath(raw) || "file",
      oldText: typeof diffBlock.oldText === "string" ? diffBlock.oldText : "",
      newText: typeof diffBlock.newText === "string" ? diffBlock.newText : "",
      maxLines,
    });
  }
  const oldStr = strOf(raw.old_str) || strOf(raw.oldStr) || strOf(raw.old_string) || strOf(raw.find);
  const newStr = strOf(raw.new_str) || strOf(raw.newStr) || strOf(raw.new_string) || strOf(raw.replace);
  if (oldStr || newStr) {
    return renderUnifiedDiff({
      path: extractPath(raw) || "file",
      oldText: oldStr,
      newText: newStr,
      maxLines,
    });
  }
  const content = strOf(raw.file_text) || strOf(raw.content) || strOf(raw.text);
  if (content) {
    return renderUnifiedDiff({ path: extractPath(raw) || "file", oldText: "", newText: content, maxLines });
  }
  return undefined;
}

// ---- language detection ----

function detectLang(path: string): string {
  const ext = (path.split(".").pop() || "").toLowerCase();
  const MAP: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    rb: "ruby",
    php: "php",
    swift: "swift",
    kt: "kotlin",
    scala: "scala",
    sh: "bash",
    bash: "bash",
    sql: "sql",
    html: "html",
    css: "css",
    scss: "scss",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    xml: "xml",
    md: "markdown",
    toml: "toml",
    ini: "ini",
    cfg: "ini",
    vue: "vue",
    svelte: "svelte",
    dart: "dart",
    lua: "lua",
    r: "r",
    pl: "perl",
    ps1: "powershell",
  };
  return MAP[ext] || "";
}

// ---- skill ----

const SKILL_RE = /[\\/]skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i;

function detectSkill(u: SessionUpdate, raw: Record<string, unknown>): string | undefined {
  for (const p of gatherPaths(u, raw)) {
    const m = SKILL_RE.exec(p);
    if (m) return m[1]!;
  }
  return undefined;
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function numStr(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

// Re-export for tests / step-from-tool helpers.
export { extractToolName, resolveToolIdentity };
