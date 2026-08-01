/** Telegram General forum topic id (always 1). */
export const FORUM_GENERAL_THREAD_ID = 1;

/**
 * Batch/runtime key for a chat. Private chats use thread 0.
 * Forum messages without message_thread_id are treated as General (1).
 */
export function batchKey(chatId: number, threadId: number | undefined, isForumGroup: boolean): string {
  if (!isForumGroup) return `${chatId}:0`;
  return `${chatId}:${threadId ?? FORUM_GENERAL_THREAD_ID}`;
}

/** Normalize forum thread id (undefined → General). */
export function forumThreadId(threadId: number | undefined): number {
  return threadId ?? FORUM_GENERAL_THREAD_ID;
}
