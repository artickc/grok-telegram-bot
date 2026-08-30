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

/**
 * Map key for pending typed answers (ask_user / plan-exit) so forum topics in
 * the same group chat do not steal each other's free-text replies.
 * Private chats use thread 0; forum topics use their real thread id (General=1).
 */
export function interactiveWaitKey(chatId: number, threadId?: number): string {
  return `${chatId}:${threadId ?? 0}`;
}

/**
 * True when this forum thread is the General manager topic.
 * Only exact id `1` — do NOT treat private chats (undefined) as General.
 * Callers should pass {@link forumThreadId} first when reading raw Telegram ids.
 */
export function isGeneralThread(threadId: number | undefined): boolean {
  return threadId === FORUM_GENERAL_THREAD_ID;
}

/**
 * Thread id for **outbound** Telegram API calls (`sendMessage`, `editMessage`, …).
 *
 * Critical: Bot API often rejects `message_thread_id: 1` for the General forum
 * topic with "Bad Request: message thread not found". Omitting the field posts
 * to General correctly. Real project topics (id > 1) must still pass the id.
 *
 * Inbound routing still uses {@link forumThreadId} (undefined → 1).
 */
export function outboundMessageThreadId(
  threadId: number | undefined,
): number | undefined {
  if (threadId === undefined || threadId === FORUM_GENERAL_THREAD_ID) return undefined;
  return threadId;
}

/** Extra object for send/edit: only includes message_thread_id when safe. */
export function outboundThreadExtra(
  threadId: number | undefined,
): { message_thread_id?: number } {
  const id = outboundMessageThreadId(threadId);
  return id !== undefined ? { message_thread_id: id } : {};
}
