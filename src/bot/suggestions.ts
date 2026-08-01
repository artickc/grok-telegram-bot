/**
 * Post-turn follow-up suggestions + gated self-recheck helpers.
 *
 * Self-recheck (once per real user turn, when enabled):
 *  1. Hard-skip if no files were modified.
 *  2. Quiet meta ask: AI refuses (simple / pure build / nothing to re-verify)
 *     or writes a focused recheck prompt.
 *  3. That prompt is queued as the one-shot SELF-RECHECK turn.
 *  4. Then Done + suggestions.
 *
 * After Done, the bot quietly asks for 1–3 short next steps as JSON with a
 * "need" score (0–100). Suggestions appear as inline buttons; those at/above
 * SUGGESTIONS_AUTO_APPROVE_PCT are merged into **one** auto-queued prompt
 * (`1) …\n2) …`) so they run as a single turn.
 */
import { InlineKeyboard } from "grammy";

/** Max suggestions shown / accepted. */
export const SUGGESTION_MAX = 3;
/** Button label budget (Telegram ~64 chars). */
const BTN_MAX = 56;

/** Marker for the automatic post-turn self-recheck prompt (once per user turn). */
export const SELF_RECHECK_MARKER = "SELF-RECHECK (automatic quality pass";

/**
 * Default self-recheck body (user can override via SELF_RECHECK_PROMPT).
 * Placeholders: {{USER}} = user's request, {{DONE}} = first-turn summary.
 */
export const DEFAULT_SELF_RECHECK_PROMPT = [
  `${SELF_RECHECK_MARKER} — once only).`,
  "Do a rigorous self-review of the work just completed for the user request below.",
  "",
  "You are both a bugs/logic finder AND a completeness checker for related follow-ups.",
  "Look for:",
  "1) Bugs, regressions, incomplete steps, wrong assumptions, missing verification, edge cases.",
  "2) Logical gaps the user would still need — e.g. if they asked for password reset and you",
  "   shipped the happy path only, also cover brute-force protection, rate limits, token expiry,",
  "   email enumeration, CSRF, audit logging, and similar security/ops follow-through that a",
  "   solid implementation of THAT feature should include (not a random new product idea).",
  "",
  "Rules:",
  "- Prefer fixing real problems with tools when needed; do not invent unrelated features.",
  "- If something is unfinished relative to the user request (or a tightly related follow-up",
  "  that leaves the feature incomplete/insecure), finish or fix it now.",
  "- If everything checks out, briefly confirm what you verified (no long essay).",
  "- Do NOT ask the user questions. Do NOT call enter_plan_mode unless truly necessary.",
  "- End with an honest {progress: N%} marker for this recheck pass.",
  "",
  "USER'S REQUEST:",
  "{{USER}}",
  "",
  "WHAT WAS JUST DONE (summary):",
  "{{DONE}}",
].join("\n");

export interface Suggestion {
  /** Plain follow-up the user would type / the bot will submit. */
  text: string;
  /** How needed/critical relative to the last user prompt (0–100). */
  need: number;
}

/**
 * Quiet meta-prompt after a successful turn. Must produce JSON only.
 * Percentage rules enforce honesty: unrelated ideas cannot score above 60.
 */
export function buildSuggestionsPrompt(userText: string, assistantSnippet: string): string {
  const user = clamp(userText.replace(/\s+/g, " ").trim(), 500) || "(empty)";
  const did = clamp(assistantSnippet.replace(/\s+/g, " ").trim(), 600) || "(no assistant text)";
  return [
    "FOLLOW-UP SUGGESTIONS (meta only). Do NOT use tools. Do NOT write code. Do NOT continue the task.",
    "Based ONLY on the user's last request and what was just done, propose 1 to 3 short next steps.",
    "",
    "USER'S LAST PROMPT:",
    user,
    "",
    "WHAT WAS JUST DONE (summary):",
    did,
    "",
    "For each suggestion set need = integer 0–100 = how needed/critical it is for completing or properly finishing THAT user prompt:",
    "- High need (70–100): tightly related, critical next step for the same request (fix a gap, verify, finish unfinished part).",
    "- Medium (40–69): related polish or natural continuation of the same task.",
    "- Low (1–39): optional or weakly related.",
    "- HARD RULE: if a suggestion is NOT clearly related to the user's last prompt, need MUST be ≤ 60 (never higher).",
    "- Do not invent unrelated new features just to fill slots; prefer fewer high-quality items.",
    "- Prefer the highest need for the single most critical related follow-up.",
    "",
    "Reply with ONLY a JSON array (no markdown fences, no keys other than text/need, no commentary):",
    '[{"text":"short imperative follow-up the user would send","need":85}]',
    "Constraints: 1–3 items; text ≤ 120 chars; plain language; no quotes wrapping the whole array.",
  ].join("\n");
}

/** Parse model output into 0–3 validated suggestions. */
export function parseSuggestions(raw: string): Suggestion[] {
  if (!raw?.trim()) return [];
  let t = raw.trim();
  // Strip accidental code fences / progress markers.
  t = t.replace(/\{[\s]*progress[\s]*:[\s]*\d{1,3}\s*%?[\s]*\}/gi, "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(t);
  if (fence) t = fence[1]!.trim();
  // Extract first JSON array if prose sneaks in.
  const arrMatch = /\[[\s\S]*\]/.exec(t);
  if (arrMatch) t = arrMatch[0]!;

  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    // Try line-wise objects.
    const objs = [...t.matchAll(/\{[^{}]*"text"[^{}]*\}/g)].map((m) => {
      try {
        return JSON.parse(m[0]!) as unknown;
      } catch {
        return undefined;
      }
    });
    parsed = objs.filter(Boolean);
  }

  const list = Array.isArray(parsed) ? parsed : [];
  const out: Suggestion[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const text = String(rec.text ?? rec.suggestion ?? rec.prompt ?? "").replace(/\s+/g, " ").trim();
    if (!text || text.length < 2) continue;
    let need = Number(rec.need ?? rec.pct ?? rec.percent ?? rec.score ?? 0);
    if (!Number.isFinite(need)) need = 0;
    need = Math.max(0, Math.min(100, Math.round(need)));
    out.push({ text: text.slice(0, 120), need });
    if (out.length >= SUGGESTION_MAX) break;
  }
  // Highest need first for auto-approve + button order.
  out.sort((a, b) => b.need - a.need);
  return out;
}

/** Inline keyboard for Done: one row per suggestion + optional extra rows. */
export function suggestionsKeyboard(
  batchId: number,
  suggestions: Suggestion[],
  extra?: InlineKeyboard,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  suggestions.forEach((s, i) => {
    const label = clamp(`${s.need}% · ${s.text}`, BTN_MAX);
    kb.text(label, `sug:${batchId}:${i}`).row();
  });
  if (extra) {
    // Append extra keyboard rows (e.g. Switch session).
    const rows = (extra as unknown as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> })
      .inline_keyboard;
    if (rows) {
      for (const row of rows) {
        for (let i = 0; i < row.length; i++) {
          const b = row[i]!;
          if (i === row.length - 1) kb.text(b.text, b.callback_data).row();
          else kb.text(b.text, b.callback_data);
        }
      }
    }
  }
  return kb;
}

/** Suggestions at/above the auto-approve threshold (need >= pct). */
export function autoApproveSuggestions(suggestions: Suggestion[], thresholdPct: number): Suggestion[] {
  if (thresholdPct <= 0) return [];
  const thr = Math.max(0, Math.min(100, Math.round(thresholdPct)));
  return suggestions.filter((s) => s.need >= thr);
}

/**
 * Merge auto-approved suggestions into a single multi-step prompt so they run
 * as one agent turn: `1) …\n2) …\n3) …` (already sorted highest need first).
 */
export function formatBatchedSuggestionsPrompt(suggestions: Suggestion[]): string {
  if (suggestions.length === 0) return "";
  if (suggestions.length === 1) return suggestions[0]!.text;
  return suggestions.map((s, i) => `${i + 1}) ${s.text}`).join("\n");
}

/** Detect the quiet suggestions meta-prompt (history strip / title guard). */
export function isSuggestionsMetaPrompt(text: string): boolean {
  return /^FOLLOW-UP SUGGESTIONS \(meta only\)/i.test(text.trim());
}

/** Marker for the quiet "should we recheck?" meta-prompt. */
export const SELF_RECHECK_DECISION_MARKER = "SELF-RECHECK DECISION (meta only)";

/** Detect the quiet self-recheck decision meta-prompt. */
export function isSelfRecheckDecisionPrompt(text: string): boolean {
  return text.trim().startsWith(SELF_RECHECK_DECISION_MARKER);
}

/** Detect the automatic self-recheck pass (not a normal user message). */
export function isSelfRecheckPrompt(text: string): boolean {
  return text.trim().startsWith(SELF_RECHECK_MARKER);
}

/** Outcome of the quiet recheck-decision turn. */
export type SelfRecheckDecision =
  | { needed: false; reason?: string }
  | { needed: true; prompt: string };

/**
 * Quiet meta-prompt: AI either refuses recheck (simple / no value) or writes
 * the focused recheck instructions that will be submitted as the next turn.
 */
export function buildSelfRecheckDecisionPrompt(
  userText: string,
  assistantSnippet: string,
  filesSummary: string,
): string {
  const user = clamp(userText.replace(/\s+/g, " ").trim(), 700) || "(empty)";
  const did = clamp(assistantSnippet.replace(/\s+/g, " ").trim(), 900) || "(no assistant text)";
  const files = clamp(filesSummary.replace(/\s+/g, " ").trim(), 400) || "(none)";
  return [
    `${SELF_RECHECK_DECISION_MARKER}. Do NOT use tools. Do NOT write code. Do NOT continue the task.`,
    "Decide whether a second automatic quality pass is worth running for the work just completed.",
    "",
    "Set needed=false (skip recheck) when ANY of these apply:",
    "- Simple task: Q&A, explanation, status, one-liner, or trivial change.",
    "- Pure build / install / run / package with no non-trivial logic to re-audit.",
    "- Work is clearly complete and low-risk; a re-verify would add little value.",
    "- No plausible bugs, incomplete steps, or tightly related security/ops gaps.",
    "",
    "Set needed=true when:",
    "- Non-trivial code/config changed and edge cases, regressions, or incomplete",
    "  follow-through are plausible (auth, multi-file logic, concurrency, data paths).",
    "- A focused second pass with tools could catch real bugs or finish related gaps.",
    "",
    "If needed=true, write a focused recheck prompt: imperative instructions for a one-shot",
    "second pass that may use tools to fix REAL issues. Do not invent unrelated features.",
    "If needed=false, give a short reason.",
    "",
    "USER'S REQUEST:",
    user,
    "",
    "WHAT WAS JUST DONE (summary):",
    did,
    "",
    "FILES MODIFIED THIS TURN:",
    files,
    "",
    "Reply with ONLY one JSON object (no markdown fences, no commentary):",
    '{"needed":false,"reason":"short reason"}',
    "or",
    '{"needed":true,"prompt":"focused recheck / fix instructions for the agent"}',
  ].join("\n");
}

/**
 * Parse quiet recheck-decision JSON. Defaults to skip on empty/invalid output
 * so a bad meta reply never blocks Done — except when the model clearly wrote a
 * recheck body without wrapping JSON (treated as needed=true).
 */
export function parseSelfRecheckDecision(raw: string): SelfRecheckDecision {
  if (!raw?.trim()) return { needed: false, reason: "empty decision" };
  let t = raw.trim();
  // Strip trailing progress markers only (avoid eating prompt text mid-JSON).
  t = t.replace(/\n?\s*\{[\s]*progress[\s]*:[\s]*\d{1,3}\s*%?[\s]*\}\s*$/gi, "").trim();
  t = t.replace(/\{[\s]*progress[\s]*:[\s]*\d{1,3}\s*%?[\s]*\}/gi, "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(t);
  if (fence) t = fence[1]!.trim();

  // Soft refuse phrases (JSON or prose).
  if (/\b(not needed|no recheck|skip recheck|unnecessary|not necessary|no need to recheck)\b/i.test(t)
    && !/"needed"\s*:\s*true/i.test(t)) {
    // Only force-skip when JSON does not explicitly set needed:true.
    if (!/"needed"\s*:\s*true/i.test(raw) && !/"recheck"\s*:\s*true/i.test(raw)) {
      const asJson = tryParseDecisionObject(t);
      if (!asJson || asJson.needed !== true) {
        return { needed: false, reason: "refused in prose" };
      }
    }
  }

  const asJson = tryParseDecisionObject(t);
  if (asJson) return asJson;

  // Plain imperative body (model forgot JSON) → treat as recheck prompt.
  const prose = t.replace(/\s+/g, " ").trim();
  if (prose.length >= 24 && !/^(ok|done|none|n\/a|skip)\b/i.test(prose)) {
    return { needed: true, prompt: prose.slice(0, 4000) };
  }
  return { needed: false, reason: "unparseable decision" };
}

/** Best-effort extract/parse of a decision object from model text. */
function tryParseDecisionObject(t: string): SelfRecheckDecision | undefined {
  // Prefer balanced-ish first object; fall back to greedy match.
  let candidate = t;
  const objMatch = /\{[\s\S]*\}/.exec(t);
  if (objMatch) candidate = objMatch[0]!;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Try smaller object if trailing junk broke parse.
    const m = /\{[^{}]*"needed"[^{}]*\}/i.exec(t)
      || /\{[^{}]*"recheck"[^{}]*\}/i.exec(t)
      || /\{[^{}]*"prompt"[^{}]*\}/i.exec(t);
    if (!m) return undefined;
    try {
      parsed = JSON.parse(m[0]!);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const rec = parsed as Record<string, unknown>;

  // Do not treat suggestion-style "need" (0–100 score) as the needed flag.
  // Only needed / recheck / required (boolean-ish) control the gate.
  const neededRaw = rec.needed ?? rec.recheck ?? rec.required;
  const prompt = String(rec.prompt ?? rec.text ?? rec.instructions ?? rec.recheck_prompt ?? "")
    .replace(/\r\n/g, "\n")
    .trim();

  let needed: boolean | undefined;
  if (typeof neededRaw === "boolean") needed = neededRaw;
  else if (typeof neededRaw === "string") {
    const s = neededRaw.trim().toLowerCase();
    if (/^(1|true|yes|y|needed|recheck)$/i.test(s)) needed = true;
    else if (/^(0|false|no|n|skip|none)$/i.test(s)) needed = false;
  } else if (typeof neededRaw === "number") {
    needed = neededRaw > 0;
  }

  // Explicit skip / refuse keys always win.
  if (rec.skip === true || rec.refuse === true) needed = false;

  // Prompt-only object: model wrote instructions without a needed flag → run.
  if (needed === undefined && prompt.length >= 3) needed = true;
  if (needed === undefined) needed = false;

  if (!needed) {
    const reason = String(rec.reason ?? rec.why ?? rec.message ?? "").replace(/\s+/g, " ").trim();
    return { needed: false, reason: reason || undefined };
  }

  // needed=true but no usable prompt → empty body; caller fills default template.
  if (!prompt || prompt.length < 3) {
    return { needed: true, prompt: "" };
  }
  return { needed: true, prompt: prompt.slice(0, 4000) };
}

/**
 * Build the one-shot self-recheck turn text from an optional env template.
 * Placeholders: {{USER}}, {{DONE}} (also {USER}/{DONE} for convenience).
 */
export function buildSelfRecheckPrompt(
  userText: string,
  assistantSnippet: string,
  template?: string,
): string {
  const user = clamp(userText.replace(/\s+/g, " ").trim(), 700) || "(empty)";
  const did = clamp(assistantSnippet.replace(/\s+/g, " ").trim(), 900) || "(no assistant text)";
  const tpl = (template?.trim() || DEFAULT_SELF_RECHECK_PROMPT).trim();
  let out = tpl
    .replace(/\{\{\s*USER\s*\}\}/gi, user)
    .replace(/\{\{\s*DONE\s*\}\}/gi, did)
    .replace(/\{USER\}/gi, user)
    .replace(/\{DONE\}/gi, did);
  // Ensure the marker is present so isSelfRecheckPrompt / one-shot guard work
  // even if the user customized SELF_RECHECK_PROMPT and dropped it.
  return ensureSelfRecheckMarker(out);
}

/**
 * Turn an AI-written recheck body into a full one-shot turn (marker + context).
 */
export function composeSelfRecheckTurn(
  agentPrompt: string,
  userText: string,
  assistantSnippet: string,
): string {
  const user = clamp(userText.replace(/\s+/g, " ").trim(), 700) || "(empty)";
  const did = clamp(assistantSnippet.replace(/\s+/g, " ").trim(), 900) || "(no assistant text)";
  const body =
    agentPrompt.trim() ||
    DEFAULT_SELF_RECHECK_PROMPT
      .replace(/\{\{\s*USER\s*\}\}/gi, user)
      .replace(/\{\{\s*DONE\s*\}\}/gi, did)
      .replace(/\{USER\}/gi, user)
      .replace(/\{DONE\}/gi, did);
  // Full template already has context — don't double-append USER/DONE sections.
  // Only skip wrapping when the body looks like a complete recheck brief (marker
  // or both a request header and a done header), not a casual mention of the words.
  const looksComplete =
    isSelfRecheckPrompt(body) ||
    (/USER'S REQUEST:/i.test(body) && /WHAT WAS JUST DONE/i.test(body));
  if (looksComplete) {
    return ensureSelfRecheckMarker(body);
  }
  return ensureSelfRecheckMarker(
    [
      body,
      "",
      "Rules:",
      "- Prefer fixing real problems with tools when needed; do not invent unrelated features.",
      "- Do NOT ask the user questions. Do NOT call enter_plan_mode unless truly necessary.",
      "- End with an honest {progress: N%} marker for this recheck pass.",
      "",
      "USER'S REQUEST:",
      user,
      "",
      "WHAT WAS JUST DONE (summary):",
      did,
    ].join("\n"),
  );
}

/** Prepend the self-recheck marker when missing. */
export function ensureSelfRecheckMarker(text: string): string {
  const t = text.trim();
  if (t.startsWith(SELF_RECHECK_MARKER)) return t;
  return `${SELF_RECHECK_MARKER} — once only).\n\n${t}`;
}

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}
