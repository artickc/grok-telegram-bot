/**
 * Merge ACP tool_call + tool_call_update patches by toolCallId.
 *
 * Grok often sends a rich first notification (title/kind/rawInput/locations),
 * then a completed update with only { toolCallId, status }. Formatting the
 * update alone produces the useless "Tool call ✓" line — always format the
 * merged snapshot instead.
 */
import type { SessionUpdate, ToolCallContent } from "../grok/types.js";

export type ToolSnapshot = SessionUpdate & {
  toolCallId?: string;
  rawInput?: Record<string, unknown>;
  locations?: Array<{ path?: string; line?: number }>;
};

/** Merge a new patch onto a previous snapshot (patch semantics: only set fields replace). */
export function mergeToolSnapshot(prev: ToolSnapshot | undefined, patch: SessionUpdate): ToolSnapshot {
  const base: ToolSnapshot = prev ? { ...prev } : { sessionUpdate: patch.sessionUpdate };
  // Always keep latest sessionUpdate type for debugging; display uses fields not type.
  base.sessionUpdate = patch.sessionUpdate || base.sessionUpdate;

  if (patch.toolCallId) base.toolCallId = patch.toolCallId;
  if (patch.title != null && String(patch.title).trim() && !isGenericTitle(String(patch.title))) {
    base.title = patch.title;
  } else if (patch.title != null && !base.title) {
    base.title = patch.title;
  }
  if (patch.name != null && String(patch.name).trim()) base.name = patch.name;
  if (patch.toolName != null && String(patch.toolName).trim()) base.toolName = patch.toolName;
  if (patch.kind != null && String(patch.kind).trim() && String(patch.kind).toLowerCase() !== "other") {
    base.kind = patch.kind;
  } else if (patch.kind != null && !base.kind) {
    base.kind = patch.kind;
  }
  if (patch.status != null) base.status = patch.status;

  if (patch.rawInput && typeof patch.rawInput === "object") {
    base.rawInput = { ...(base.rawInput || {}), ...normalizeRawKeys(patch.rawInput as Record<string, unknown>) };
  }
  // snake_case wire variants
  const snakeIn = (patch as { raw_input?: unknown }).raw_input;
  if (snakeIn && typeof snakeIn === "object" && !Array.isArray(snakeIn)) {
    base.rawInput = {
      ...(base.rawInput || {}),
      ...normalizeRawKeys(snakeIn as Record<string, unknown>),
    };
  }

  if (patch.rawOutput !== undefined) base.rawOutput = patch.rawOutput;
  const snakeOut = (patch as { raw_output?: unknown }).raw_output;
  if (snakeOut !== undefined) base.rawOutput = snakeOut;

  if (Array.isArray(patch.locations) && patch.locations.length) {
    base.locations = patch.locations;
  }

  // Content: prefer non-empty arrays
  if (Array.isArray(patch.content_blocks) && patch.content_blocks.length) {
    base.content_blocks = patch.content_blocks as ToolCallContent[];
  }
  if (Array.isArray(patch.content) && (patch.content as unknown[]).length) {
    base.content = patch.content;
    // Mirror into content_blocks for older formatters.
    if (!base.content_blocks?.length) {
      base.content_blocks = patch.content as ToolCallContent[];
    }
  }

  // Lift path from locations into rawInput for path extractors.
  if (base.locations?.[0]?.path) {
    base.rawInput = base.rawInput || {};
    if (!base.rawInput.path && !base.rawInput.target_file && !base.rawInput.file_path) {
      base.rawInput.path = base.locations[0].path;
    }
    if (base.locations[0].line != null && base.rawInput.start_line == null) {
      base.rawInput.start_line = base.locations[0].line;
    }
  }

  return base;
}

/** True when a title is useless alone (Grok default). */
export function isGenericTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  return !t || t === "tool call" || t === "tool" || t === "other" || t === "tool_call";
}

/** Whether the snapshot has enough info to show a meaningful card. */
export function snapshotHasDetail(s: ToolSnapshot): boolean {
  if (s.name || s.toolName) return true;
  if (s.title && !isGenericTitle(String(s.title))) return true;
  if (s.kind && String(s.kind).toLowerCase() !== "other") return true;
  const raw = s.rawInput || {};
  if (Object.keys(raw).length > 0) return true;
  if (s.locations?.some((l) => l.path)) return true;
  if (Array.isArray(s.content_blocks) && s.content_blocks.length > 0) return true;
  if (Array.isArray(s.content) && (s.content as unknown[]).length > 0) return true;
  return false;
}

function normalizeRawKeys(raw: Record<string, unknown>): Record<string, unknown> {
  // Flatten nested arguments once so path/command extractors see them.
  const out: Record<string, unknown> = { ...raw };
  for (const key of ["arguments", "input", "args", "parameters"]) {
    const nested = raw[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
        if (out[k] === undefined) out[k] = v;
      }
    }
  }
  return out;
}
