/**
 * Telegram MarkdownV2 escaping helpers.
 * @see https://core.telegram.org/bots/api#markdownv2-style
 */

// Characters that must be escaped in normal MarkdownV2 text.
const SPECIAL = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

/** Escape text that appears in normal (non-entity) MarkdownV2 context. */
export function escapeMdV2(text: string): string {
  return text.replace(SPECIAL, (c) => `\\${c}`);
}

/** Escape the body of an inline code span or code block (only ` and \). */
export function escapeCode(text: string): string {
  return text.replace(/([`\\])/g, "\\$1");
}

/** Escape a URL used inside a MarkdownV2 link target. */
export function escapeUrl(url: string): string {
  return url.replace(/([)\\])/g, "\\$1");
}
