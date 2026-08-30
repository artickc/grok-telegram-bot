/**
 * Shared application types: per-chat settings, reasoning levels, and the
 * prompt input model (text plus optional images) used across the bot.
 */

export const REASONING_LEVELS = ["minimal", "low", "medium", "high", "max"] as const;
export type ReasoningEffort = (typeof REASONING_LEVELS)[number];

export interface ChatSettings {
  projectPath?: string;
  projectName?: string;
  sessionId?: string;
  agent?: string;
  model?: string;
  reasoning: ReasoningEffort;
  /**
   * Preferred saved Grok account login id for this chat/topic (optional).
   * Applied when starting turns if different from the process-active account.
   */
  preferredAccountId?: string;
  /** Telegram message id of the pinned status panel, if any. */
  statusMessageId?: number;
  /** Sessions this chat controls (for multi-session switching). */
  controlledSessions?: ControlledSession[];
  /** Which controlled session is currently in the foreground. */
  foregroundSessionId?: string;
}

export interface ControlledSession {
  sessionId?: string;
  projectPath: string;
  projectName?: string;
}

export function defaultSettings(): ChatSettings {
  return { reasoning: "medium" };
}

/** A decoded image to attach to a prompt as an ACP image content block. */
export interface PromptImage {
  data: string; // base64-encoded bytes
  mimeType: string;
}

/**
 * A file the agent can open (ACP `resource_link`). Used for voice notes and
 * other binaries when we cannot embed the media as a first-class content type
 * (Grok CLI currently rejects ACP `audio` blocks).
 */
export interface PromptResourceLink {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
}

/** A unit of work submitted to the agent: text plus optional images / links. */
export interface PromptInput {
  text: string;
  images: PromptImage[];
  /** Optional file references (voice notes, binaries). */
  resourceLinks?: PromptResourceLink[];
  /** Telegram message id of the prompt, so the reply threads to it. */
  replyTo?: number;
  /**
   * Short id for the bot-owned prompt anchor (`#prompt_<id>`). All AI messages
   * for this turn carry the same tag so the user can search related replies.
   */
  promptId?: string;
  /**
   * Content of the message the user was replying to (or the portion they
   * quoted). Injected as context so the agent sees what the user is responding
   * to. See {@link ../bot/reply-context.ts}.
   */
  quotedText?: string;
  /**
   * System/meta turns (self-recheck, auto-approved suggestion batches) must not
   * trigger another self-recheck — only real user prompts do (once each).
   */
  skipSelfRecheck?: boolean;
  /**
   * Manager dispatch metadata for this prompt only (General → project).
   * Carried through the queue so concurrent send_prompt jobs do not steal
   * each other's report-back. Shape matches bot/manager-jobs ReportBackMeta.
   */
  reportBack?: {
    jobId: string;
    originChatId: number;
    originThreadId: number;
    userAskPreview: string;
    targetName: string;
    targetPath: string;
    dispatchPrompt: string;
  };
  /**
   * Pre-posted status bubble (General: "Starting…") that the turn edits to
   * "Thinking…" then streams the agent reply into.
   */
  seedMessageId?: number;
}

export function textPrompt(
  text: string,
  replyTo?: number,
  quotedText?: string,
  opts?: {
    skipSelfRecheck?: boolean;
    promptId?: string;
    reportBack?: PromptInput["reportBack"];
    seedMessageId?: number;
  },
): PromptInput {
  return {
    text,
    images: [],
    resourceLinks: [],
    replyTo,
    promptId: opts?.promptId,
    quotedText,
    skipSelfRecheck: opts?.skipSelfRecheck,
    reportBack: opts?.reportBack,
    seedMessageId: opts?.seedMessageId,
  };
}
