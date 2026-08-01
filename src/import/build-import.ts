/**
 * Build a lossless import package: full transcript on disk + priming text for
 * the first Grok turn so the conversation can continue with full context.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryEntry } from "../sessions/types.js";
import { readForeignHistory, type ForeignSessionMeta } from "./history-readers.js";
import type { ImportSource } from "./sources.js";

/** Inline priming budget — keep under typical model input comfort zone. */
const INLINE_MAX_CHARS = 100_000;
/** Per-entry cap when writing the archive file (still very generous). */
const FILE_ENTRY_MAX = 100_000;
/** Per-entry cap inside the inline priming block. */
const INLINE_ENTRY_MAX = 12_000;

export interface ImportPackage {
  /** Absolute path of the written full-transcript markdown (always present). */
  transcriptPath: string;
  /** Priming preamble to inject into the first Grok prompt. */
  priming: string;
  /** How many history entries were captured. */
  entryCount: number;
  /** Characters written to the transcript file. */
  transcriptChars: number;
  /** True when the full transcript did not fit inline (file is authoritative). */
  truncatedInline: boolean;
  meta: ForeignSessionMeta;
  sourceLabel: string;
}

/**
 * Extract full history, write a durable transcript under `importsDir`, and
 * build priming text that references it.
 */
export function buildImportPackage(
  src: ImportSource,
  meta: ForeignSessionMeta,
  importsDir: string,
): ImportPackage {
  const entries = readForeignHistory(src.format, src.sessionsRoot, meta.sessionId);
  const fullBody = formatTranscript(entries, FILE_ENTRY_MAX);
  const transcriptChars = fullBody.length;

  mkdirSync(importsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const short = meta.sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "session";
  const fileName = `${src.id}-${short}-${stamp}.md`;
  const transcriptPath = join(importsDir, fileName);

  const header = [
    `# Imported session transcript`,
    ``,
    `- **Source tool:** ${src.label} (\`${src.id}\`)`,
    `- **Source session id:** \`${meta.sessionId}\``,
    `- **Project:** ${meta.projectName ?? "(unknown)"}`,
    `- **Working directory:** \`${meta.cwd || "(unknown)"}\``,
    `- **Title:** ${meta.title}`,
    `- **Entries:** ${entries.length}`,
    `- **Imported at:** ${new Date().toISOString()}`,
    ``,
    `---`,
    ``,
    fullBody || "_(no history entries found on disk)_",
    ``,
  ].join("\n");

  writeFileSync(transcriptPath, header, "utf-8");

  const inline = formatTranscript(entries, INLINE_ENTRY_MAX);
  let truncatedInline = false;
  let inlineBlock = inline;
  if (inlineBlock.length > INLINE_MAX_CHARS) {
    truncatedInline = true;
    // Keep the *end* of the conversation (most relevant to continue).
    inlineBlock = inlineBlock.slice(inlineBlock.length - INLINE_MAX_CHARS);
    const nl = inlineBlock.indexOf("\n");
    if (nl !== -1) inlineBlock = inlineBlock.slice(nl + 1);
    inlineBlock = `[…earlier messages omitted inline; full transcript is in the file…]\n\n` + inlineBlock;
  }

  const priming = [
    `You are continuing a conversation that was imported from **${src.label}** into Grok.`,
    `Nothing from the original session must be lost — the complete transcript is on disk.`,
    ``,
    `**Source:** ${src.label}`,
    `**Original session id:** ${meta.sessionId}`,
    `**Project:** ${meta.projectName ?? "(unknown)"}`,
    `**Working directory (cwd):** ${meta.cwd || "(unknown)"}`,
    `**Full transcript file (authoritative, complete):** ${transcriptPath}`,
    ``,
    `Instructions:`,
    `1. Treat the transcript below (and the full file above) as your prior conversation history.`,
    `2. If anything seems truncated inline, READ the full transcript file before acting.`,
    `3. Continue seamlessly: same project, same goals, same unfinished work, same decisions.`,
    `4. Do not restart finished work; do not ask the user to re-explain what is already in the transcript.`,
    `5. On this first turn only: reply with a short confirmation (project path + one-sentence summary of the task so far) and WAIT for the user's next instruction. Do not make further tool calls yet unless the transcript shows an urgent incomplete action that would leave the workspace broken.`,
    ``,
    `=== IMPORTED TRANSCRIPT (${entries.length} entries${truncatedInline ? ", recent slice inline" : ", full inline"}) ===`,
    inlineBlock || "(empty — see transcript file)",
    `=== END IMPORTED TRANSCRIPT ===`,
  ].join("\n");

  return {
    transcriptPath,
    priming,
    entryCount: entries.length,
    transcriptChars,
    truncatedInline,
    meta,
    sourceLabel: src.label,
  };
}

/** Full-fidelity plain-text transcript (no 600-char UI truncation). */
export function formatTranscript(entries: HistoryEntry[], perEntryMax: number): string {
  const label: Record<string, string> = {
    user: "User",
    assistant: "Assistant",
    tool: "Tool",
    system: "System",
  };
  return entries
    .map((e, i) => {
      let text = e.text ?? "";
      if (text.length > perEntryMax) text = text.slice(0, perEntryMax) + " …";
      const tool = e.tool && e.role === "tool" ? ` (${e.tool})` : "";
      return `### ${i + 1}. ${label[e.role] ?? e.role}${tool}\n${text}`;
    })
    .join("\n\n");
}
