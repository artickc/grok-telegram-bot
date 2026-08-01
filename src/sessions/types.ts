/** Types for discovered Grok CLI sessions on disk. */

export interface SessionMeta {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  /** PID holding the .lock file, if any. */
  lockPid?: number;
  /** True when lockPid refers to a live process => running on this PC. */
  active: boolean;
  /** Size of the .jsonl history in bytes (proxy for conversation length). */
  historyBytes: number;
  /**
   * Short status line for cards: current step while working, or chat summary
   * when idle (persisted by the bot after turns).
   */
  comment?: string;
}

export type HistoryRole = "user" | "assistant" | "tool" | "system";

export interface HistoryEntry {
  role: HistoryRole;
  text: string;
  /** Optional tool name for tool entries. */
  tool?: string;
  timestamp?: number;
}
