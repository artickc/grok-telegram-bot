/**
 * Format ACP tool-call updates into clear, RAW markdown blocks so they read
 * distinctly from the agent's prose and thinking. Commands appear in a `bash`
 * block, file edits as a `diff` block.
 */
import type { SessionUpdate, ToolCallContent } from "../grok/types.js";
import { renderUnifiedDiff } from "./diff.js";

const KIND_ICON: Record<string, string> = {
  read: "\u{1F4D6}",
  edit: "\u270F\uFE0F",
  execute: "\u{1F4BB}",
  search: "\u{1F50E}",
  delete: "\u{1F5D1}\uFE0F",
  move: "\u{1F4E6}",
  fetch: "\u{1F310}",
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
  const kind = (u.kind || "other").toLowerCase();
  const raw = (u.rawInput || {}) as Record<string, unknown>;
  const status = u.status ? (STATUS_ICON[u.status] ?? "") : "";
  const tail = status ? ` ${status}` : "";

  // Skill load — reading a `.../skills/<name>/SKILL.md`. Don't treat edits/
  // deletes of a SKILL.md (skill authoring) as a "load".
  if (kind !== "edit" && kind !== "delete" && kind !== "move") {
    const skill = detectSkill(u, raw);
    if (skill) return `\u{1F4DA} **Loaded skill: ${skill}**${tail}`;
  }

  // MCP / extension tool call → "Call MCP <server>: <method>" (or "Call MCP:
  // <tool>" when the call carries no server name).
  const mcp = detectMcp(u, raw, kind);
  if (mcp) {
    const label = mcp.server ? `Call MCP ${mcp.server}: ${mcp.method}` : `Call MCP: ${mcp.method}`;
    return `\u{1F9E9} **${label}**${tail}`;
  }

  const icon = KIND_ICON[kind] ?? KIND_ICON.other;
  const title = u.title || titleFromRaw(kind, raw);

  let out = `${icon} **${title}**${tail}`;

  if (kind === "execute") {
    const cmd = strOf(raw.command ?? raw.cmd);
    if (cmd) out += "\n```bash\n" + cmd + "\n```";
  }

  if (kind === "edit" && opts.showDiffs) {
    const diff = buildEditDiff(u, raw, opts.diffMaxLines);
    if (diff && diff.block) {
      const stat = `${diff.added > 0 ? "+" + diff.added : ""}${diff.removed > 0 ? " -" + diff.removed : ""}`.trim();
      out += `${stat ? `  (${stat})` : ""}\n${diff.block}`;
    }
  }

  return out;
}

/** Built-in Grok tools that must never be labelled as MCP calls. */
const BUILTIN_TOOLS = new Set([
  "read", "write", "shell", "grep", "glob", "web_fetch", "web_search", "fs_read",
  "fs_write", "fs_replace", "fs_search", "execute_bash", "report_issue", "use_aws",
  "todo_list", "introspect", "knowledge", "thinking", "summary", "subagent",
]);
/** Tool kinds that are first-class file/shell operations (never MCP). */
const FILE_KINDS = new Set(["read", "edit", "execute", "search", "delete", "move"]);
/** `.../skills/<name>/SKILL.md` — the signature of loading a skill. */
const SKILL_RE = /[\\/]skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i;
/** Namespaced MCP tool-name shapes → [, server, method]. */
const MCP_NS = [
  /^@([a-z0-9._-]+)[/_]{1,3}(.+)$/i, // @server/method · @server___method
  /^([a-z0-9.-]+)___(.+)$/i, // server___method
  /^([a-z0-9.-]+)__(.+)$/i, // server__method
  /^([a-z0-9.-]+)\/(.+)$/i, // server/method
  /^([a-z0-9-]+)\.(.+)$/i, // server.method
];

/** The skill name if this tool call loads a `SKILL.md`, else undefined. */
function detectSkill(u: SessionUpdate, raw: Record<string, unknown>): string | undefined {
  for (const p of gatherPaths(u, raw)) {
    const m = SKILL_RE.exec(p);
    if (m) return m[1];
  }
  return undefined;
}

/** The MCP server + method this call targets, if it looks like an MCP/external
 *  tool. Built-in file/shell tools return undefined. */
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
  // Bare external tool: not a built-in, and not a file/shell operation.
  if (!BUILTIN_TOOLS.has(name.toLowerCase()) && !FILE_KINDS.has(kind)) {
    return { method: name };
  }
  return undefined;
}

/** Best-effort tool name from the raw input or a tool-name-like title. */
function mcpToolName(u: SessionUpdate, raw: Record<string, unknown>): string {
  const explicit = strOf(raw.tool_name) || strOf(raw.toolName) || strOf(raw.name) || strOf(raw.tool);
  if (explicit) return explicit;
  const t = (u.title || "").trim();
  // Use the title only when it reads like a tool identifier (no spaces, not a
  // "file:line" read title like "SKILL.md:1").
  return /^[@a-z0-9._/-]+$/i.test(t) && !t.includes(":") ? t : "";
}

/** Collect every file path referenced by a tool call (incl. nested ops/diffs). */
function gatherPaths(u: SessionUpdate, raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === "string" && v) out.push(v);
  };
  add(raw.path);
  add(raw.file_path);
  add(raw.filename);
  add(raw.file);
  if (Array.isArray(raw.operations)) {
    for (const op of raw.operations) {
      if (op && typeof op === "object") add((op as Record<string, unknown>).path);
    }
  }
  for (const b of collectContent(u)) add(b.path);
  return out;
}

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
  const oldStr = strOf(raw.old_str ?? raw.oldStr);
  const newStr = strOf(raw.new_str ?? raw.newStr);
  if (oldStr || newStr) {
    return renderUnifiedDiff({ path: strOf(raw.path) || "file", oldText: oldStr, newText: newStr, maxLines });
  }
  const content = strOf(raw.file_text ?? raw.content ?? raw.text);
  if (content) {
    return renderUnifiedDiff({ path: strOf(raw.path) || "file", oldText: "", newText: content, maxLines });
  }
  return undefined;
}

function titleFromRaw(kind: string, raw: Record<string, unknown>): string {
  const path = strOf(raw.path ?? raw.file_path ?? raw.filename);
  if (path) return `${capitalize(kind)} ${path}`;
  return capitalize(kind);
}

function collectContent(u: SessionUpdate): ToolCallContent[] {
  const out: ToolCallContent[] = [];
  if (Array.isArray(u.content_blocks)) out.push(...u.content_blocks);
  const content = (u as unknown as { content?: unknown }).content;
  if (Array.isArray(content)) out.push(...(content as ToolCallContent[]));
  return out;
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}
