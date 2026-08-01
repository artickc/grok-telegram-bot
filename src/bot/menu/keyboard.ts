/**
 * Menu surfaces:
 *  - a tiny PERSISTENT bar (☰ Menu · 🧭 Running · ⏹ Stop) — minimal footprint;
 *  - a full, organized INLINE menu opened on demand (and hideable).
 * Live state (project/model/reasoning/context) lives in the pinned panel,
 * so the bar stays clean. (Agent picker removed — Grok has no useful headless
 * agent switch; plan mode is entered automatically when the agent judges the task complex.)
 */
import { InlineKeyboard, Keyboard } from "grammy";

export const MENU_BTN = "\u2630 Menu"; // ☰
export const RUNNING_BTN = "\u{1F9ED} Running";
export const STOP_BTN = "\u23F9 Stop";
export const BAR_LABELS = [MENU_BTN, RUNNING_BTN, STOP_BTN];

/** The always-visible compact bar. */
export function compactKeyboard(): Keyboard {
  return new Keyboard().text(MENU_BTN).text(RUNNING_BTN).text(STOP_BTN).resized().persistent();
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
    kb.text(`\u{1F4C1} ${t(state.forumTopic.name, 28)}`, "m:topicinfo").text("\u{1F195} New", "m:new").row();
  } else {
    kb.text("\u{1F4C1} Project", "m:project").text("\u{1F195} New", "m:new").row();
  }
  kb.text("\u{1F9ED} Running", "m:running")
    .text("\u{1F5C2} Sessions", "m:sessions")
    .row()
    .text("\u{1F4E5} Import session", "m:import")
    .row()
    .text(`\u{1F9E9} Model \u00B7 ${t(state.model, 24)}`, "m:model")
    .row()
    .text(`\u{1F9E0} Reasoning \u00B7 ${t(state.reasoning, 24)}`, "m:reasoning")
    .row();
  if (state.forumTopic?.account) {
    kb.text(`\u{1F465} Account \u00B7 ${t(state.forumTopic.account, 20)}`, "m:accounts").row();
  }
  if (!state.forumTopic) {
    kb.text("\u2705 Tasks", "m:tasks")
      .text("\u{1F4CA} Status", "m:status")
      .text("\u{1F4B3} Usage", "m:usage")
      .row()
      .text("\u{1F465} Accounts", "m:accounts")
      .row()
      .text("\u{1F9E9} MCP", "m:mcp")
      .text("\u23F9 Stop", "m:stop")
      .text("\u{1F6D1} Kill all", "m:killall")
      .row()
      .text("\u2328\uFE0F Show bar", "m:showbar")
      .text("\u{1F648} Hide bar", "m:hidebar")
      .text("\u2716 Close", "m:close");
  } else {
    kb.text("\u{1F4CA} Status", "m:status")
      .text("\u23F9 Stop", "m:stop")
      .text("\u2716 Close", "m:close");
  }
  return kb;
}
