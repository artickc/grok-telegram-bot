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
   * Content of the message the user was replying to (or the portion they
   * quoted). Injected as context so the agent sees what the user is responding
   * to. See {@link ../bot/reply-context.ts}.
   */
  quotedText?: string;
}

export function textPrompt(text: string, replyTo?: number, quotedText?: string): PromptInput {
  return { text, images: [], resourceLinks: [], replyTo, quotedText };
}
