/**
 * Foreign session sources that can be imported into Grok: the four sibling
 * Telegram bots on this machine. Each source has a bot root (for settings /
 * /running controlled sessions) and a tool session store (history on disk).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ImportSourceId = "kiro" | "opencode" | "claude" | "codex";

/** How history is stored for a source tool. */
export type HistoryFormat = "acp-jsonl" | "codex-rollout" | "opencode-storage";

export interface ImportSource {
  id: ImportSourceId;
  /** Short label shown in the source picker. */
  label: string;
  /** Absolute path to the sibling telegram-bot project root. */
  botRoot: string;
  /** Path to that bot's settings.json (holds controlledSessions /running). */
  settingsPath: string;
  /**
   * Tool session store root:
   *  - acp-jsonl: dir of `<id>.json` + `<id>.jsonl`
   *  - codex-rollout: `$CODEX_HOME/sessions` tree of rollouts
   *  - opencode-storage: `~/.local/share/opencode` (storage/ under it)
   */
  sessionsRoot: string;
  format: HistoryFormat;
}

const DOMAINS = "H:\\Lucru\\Domains";

/** Built-in import sources (fixed paths as requested). */
export const IMPORT_SOURCES: readonly ImportSource[] = [
  {
    id: "kiro",
    label: "Kiro",
    botRoot: join(DOMAINS, "kiro-telegram-bot"),
    settingsPath: join(DOMAINS, "kiro-telegram-bot", "data", "settings.json"),
    sessionsRoot: join(homedir(), ".kiro", "sessions", "cli"),
    format: "acp-jsonl",
  },
  {
    id: "opencode",
    label: "OpenCode",
    botRoot: join(DOMAINS, "opencode-telegram-bot"),
    settingsPath: join(DOMAINS, "opencode-telegram-bot", "data", "settings.json"),
    sessionsRoot: join(homedir(), ".local", "share", "opencode"),
    format: "opencode-storage",
  },
  {
    id: "claude",
    label: "Claude",
    botRoot: join(DOMAINS, "claude-telegram-bot"),
    settingsPath: join(DOMAINS, "claude-telegram-bot", "data", "settings.json"),
    sessionsRoot: join(DOMAINS, "claude-telegram-bot", "data", "sessions"),
    format: "acp-jsonl",
  },
  {
    id: "codex",
    label: "Codex",
    botRoot: join(DOMAINS, "codex-telegram-bot"),
    settingsPath: join(DOMAINS, "codex-telegram-bot", "data", "settings.json"),
    sessionsRoot: join(homedir(), ".codex", "sessions"),
    format: "codex-rollout",
  },
] as const;

export function getImportSource(id: string): ImportSource | undefined {
  return IMPORT_SOURCES.find((s) => s.id === id);
}

/** True when the bot root exists on disk. */
export function sourceAvailable(src: ImportSource): boolean {
  return existsSync(src.botRoot);
}
