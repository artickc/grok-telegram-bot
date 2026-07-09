/**
 * tool-call-detail.ts
 *
 * Rich detail extractors for specific tool kinds: search queries, file reads,
 * URLs, writes/creates content previews, move/rename source+dest, delete paths,
 * web search queries, and MCP argument previews.
 *
 * Each function returns a RAW markdown string (code blocks, etc.) appended after
 * the tool-call icon + title line.
 */
import type { SessionUpdate, ToolCallContent } from "../grok/types.js";

/** Max chars to show for search queries, command previews, etc. */
export const PREVIEW_MAX = 600;
/** Max chars for file content preview on write/create. */
export const CONTENT_PREVIEW_MAX = 1000;

/** Normalize a tool-call kind string to a canonical lowercase value. */
export function normalizeKind(kind: string | undefined): string {
  const k = (kind || "other").toLowerCase().trim();
  // Map common variants to canonical kinds.
  const ALIASES: Record<string, string> = {
    bash: "execute",
    shell: "execute",
    command: "execute",
    terminal: "execute",
    grep: "search",
    glob: "search",
    find: "search",
    ripgrep: "search",
    "web_search": "web_search",
    "web_fetch": "fetch",
    url: "fetch",
    http: "fetch",
    request: "fetch",
    rename: "move",
    copy: "move",
    mkdir: "create",
    touch: "create",
  };
  return ALIASES[k] ?? k;
}

/** Extract the primary file path from a tool-call raw input. */
export function extractPath(raw: Record<string, unknown>): string {
  return (
    strOf(raw.path) ||
    strOf(raw.file_path) ||
    strOf(raw.filename) ||
    strOf(raw.file) ||
    strOf(raw.filePath) ||
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
    ""
  );
}

/** Extract command string from an execute/shell call. */
export function extractCommand(raw: Record<string, unknown>): string {
  return strOf(raw.command) || strOf(raw.cmd) || strOf(raw.shell_command) || "";
}

/** Extract file content for write/create operations. */
export function extractContent(raw: Record<string, unknown>): string {
  return (
    strOf(raw.content) ||
    strOf(raw.file_text) ||
    strOf(raw.text) ||
    strOf(raw.data) ||
    ""
  );
}

/** Extract include/exclude filters from a search call. */
export function extractFilters(raw: Record<string, unknown>): { include?: string; exclude?: string } {
  const include = strOf(raw.include) || strOf(raw.glob) || strOf(raw.file_pattern) || strOf(raw.type);
  const exclude = strOf(raw.exclude) || strOf(raw.ignore);
  const out: { include?: string; exclude?: string } = {};
  if (include) out.include = include;
  if (exclude) out.exclude = exclude;
  return out;
}

/** Truncate text to max chars with ellipsis. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
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
  if (Array.isArray(raw.operations)) {
    for (const op of raw.operations) {
      if (op && typeof op === "object") add((op as Record<string, unknown>).path);
    }
  }
  for (const b of collectContent(u)) add(b.path);
  return out;
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}