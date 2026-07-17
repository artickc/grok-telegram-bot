/**
 * Prompt appendix so the agent keeps generated images in the session media
 * folder and mentions absolute paths (the bot delivers those as Telegram files).
 *
 * Keep tidy-idempotent (no trailing spaces / 3+ blank lines) so
 * `cleanStoredText` can strip it by exact match after extractProgress/tidy.
 */
export const IMAGE_OUTPUT_DIRECTIVE = [
  "IMAGE OUTPUT RULES:",
  "When generating images (image_gen / image_edit) or saving image files, write them under the current Grok session media folder (session images/ or assets/) or the project images/ directory — not random temp locations.",
  "Always mention the absolute path of each image file you create in your reply so the client can deliver it as a downloadable Telegram file.",
].join("\n");
