/**
 * Forum topic ↔ project mapping types (one Telegram forum group).
 */

export type TopicKind = "ai_chat" | "project" | "general" | "unbound";

export interface ForumTopicBinding {
  /** Telegram message_thread_id */
  threadId: number;
  /** Topic title when last seen / created */
  name: string;
  kind: TopicKind;
  /** Absolute project path, or workspace for AI chat. Null when unbound. */
  projectPath: string | null;
  /** Best-effort icon file path (favicon / MSIX logo), if discovered. */
  iconPath?: string;
  /** Last Grok ACP session id bound to this topic (optional resume hint). */
  sessionId?: string;
  updatedAt: number;
}

export interface ForumTopicState {
  groupId: number;
  topics: Record<string, ForumTopicBinding>; // key = String(threadId)
  /** Threads waiting for the user to provide a project path. */
  pendingBind: number[];
  /** Last successful auto-setup time (ms). */
  lastSetupAt?: number;
}
