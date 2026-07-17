/**
 * Callback-query helpers — Telegram requires answerCallbackQuery within a few
 * seconds of the tap. Stale/expired IDs throw 400; without a catch those become
 * unhandled bot errors and the client spinner never clears.
 */
import { type Context, type MiddlewareFn, GrammyError } from "grammy";

/** True when Telegram rejected the answer because the query expired or is invalid. */
export function isStaleCallbackError(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  if (err.error_code !== 400 && err.error_code !== 440) return false;
  return /query is too old|query ID is invalid|response timeout expired/i.test(err.description);
}

type AnswerParams = Parameters<Context["answerCallbackQuery"]>[0];

/**
 * Idempotent, non-throwing answer for a single handler (when middleware is not
 * in play). Safe to call after slow work — stale queries are swallowed.
 */
export async function safeAnswerCallbackQuery(ctx: Context, params?: AnswerParams): Promise<boolean> {
  try {
    await ctx.answerCallbackQuery(params);
    return true;
  } catch (err) {
    if (isStaleCallbackError(err)) return false;
    throw err;
  }
}

/**
 * Patch every callback update so:
 *   1. answerCallbackQuery never throws on stale/expired query IDs,
 *   2. double-answers are no-ops,
 *   3. if a handler forgets to answer, we answer once in `finally` so the
 *      client spinner always stops (best-effort; may already be too late).
 */
export function safeCallbackMiddleware(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    if (!ctx.callbackQuery) {
      await next();
      return;
    }

    let answered = false;
    const original = ctx.answerCallbackQuery.bind(ctx);

    ctx.answerCallbackQuery = (async (params?: AnswerParams) => {
      if (answered) return true;
      answered = true;
      try {
        return await original(params);
      } catch (err) {
        if (isStaleCallbackError(err)) return true;
        // Leave answered=true so a retry storm can't spam Telegram; surface
        // unexpected errors to bot.catch for visibility.
        throw err;
      }
    }) as Context["answerCallbackQuery"];

    try {
      await next();
    } finally {
      if (!answered) {
        try {
          await original();
        } catch {
          /* stale or network — spinner already gone */
        }
        answered = true;
      }
    }
  };
}
