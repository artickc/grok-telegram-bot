/**
 * Public bot assembly: one Grok host, one or more Telegram surfaces.
 */
export { createBots, type BotBundle, type BotHost } from "./host.js";
export { type BotSurface } from "./surface.js";
