/**
 * Menu surfaces:
 *  - PERSISTENT bar (reply keyboard): ☰ Menu · 🆕 New session / 🧭 Running · ⏹ Stop
 *    — primary place for New session in private chats (not the inline Menu message).
 *  - INLINE menu message (opened via ☰ Menu or /menu) — settings & navigation.
 *    Forum topics: reply keyboards are unreliable, so New stays on the topic inline menu.
 * Live state lives in the pinned status panel so the bar stays clean.
 */
import { InlineKeyboard, Keyboard } from "grammy";

export const MENU_BTN = "\u2630 Menu"; // ☰
/** Persistent bar + forum topic control — brand-new session (same as /new). */
export const NEW_BTN = "\u{1F195} New session";
export const RUNNING_BTN = "\u{1F9ED} Running";
export const STOP_BTN = "\u23F9 Stop";
export const BAR_LABELS = [MENU_BTN, NEW_BTN, RUNNING_BTN, STOP_BTN];

/** The always-visible compact bar (private chats; best-effort in groups). */
export function compactKeyboard(): Keyboard {
  return new Keyboard()
    .text(MENU_BTN)
    .text(NEW_BTN)
    .row()
    .text(RUNNING_BTN)
    .text(STOP_BTN)
    .resized()
    .persistent();
}

/** The full, grouped inline menu (opened via ☰ Menu or /menu). */
export function mainMenuInline(state: {
  model: string;
  reasoning: string;
  /** Forum topic scope — hide project switch; label topic sessions. */
  forumTopic?: { name: string; account?: string };
}): InlineKeyboard {
  const t = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "\u2026" : s);
  const kb = new InlineKeyboard();

  if (state.forumTopic) {
    // Groups/topics: control first (no reliable reply-keyboard bar). New session here.
    kb.text("\u23F9 Stop", "m:stop")
      .text("\u{1F9ED} Running", "m:running")
      .row()
      .text(NEW_BTN, "m:new")
      .text("\u{1F5C2} Sessions", "m:sessions")
      .row()
      .text(`\u{1F4C1} ${t(state.forumTopic.name, 28)}`, "m:topicinfo")
      .row()
      .text("\u{1F4E5} Import session", "m:import")
      .row()
      .text(`\u{1F9E9} Model \u00B7 ${t(state.model, 24)}`, "m:model")
      .row()
      .text(`\u{1F9E0} Reasoning \u00B7 ${t(state.reasoning, 24)}`, "m:reasoning")
      .row();
    if (state.forumTopic.account) {
      kb.text(`\u{1F465} Account \u00B7 ${t(state.forumTopic.account, 20)}`, "m:accounts").row();
    }
    kb.text("\u{1F4CA} Status", "m:status").text("\u2716 Close", "m:close");
    return kb;
  }

  // Private chat: New session is on the persistent bar + /new — not on this message.
  kb.text("\u{1F4C1} Project", "m:project")
    .text("\u{1F5C2} Sessions", "m:sessions")
    .row()
    .text("\u23F9 Stop", "m:stop")
    .text("\u{1F9ED} Running", "m:running")
    .row()
    .text("\u{1F4E5} Import session", "m:import")
    .row()
    .text(`\u{1F9E9} Model \u00B7 ${t(state.model, 24)}`, "m:model")
    .row()
    .text(`\u{1F9E0} Reasoning \u00B7 ${t(state.reasoning, 24)}`, "m:reasoning")
    .row()
    .text("\u2705 Tasks", "m:tasks")
    .text("\u{1F4CA} Status", "m:status")
    .text("\u{1F4B3} Usage", "m:usage")
    .row()
    .text("\u{1F465} Accounts", "m:accounts")
    .row()
    .text("\u{1F9E9} MCP", "m:mcp")
    .text("\u{1F6D1} Kill all", "m:killall")
    .row()
    .text("\u2328\uFE0F Show bar", "m:showbar")
    .text("\u{1F648} Hide bar", "m:hidebar")
    .text("\u2716 Close", "m:close");
  return kb;
}
