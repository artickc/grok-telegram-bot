import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  autoApproveSuggestions,
  buildSelfRecheckDecisionPrompt,
  buildSelfRecheckPrompt,
  composeSelfRecheckTurn,
  DEFAULT_SELF_RECHECK_PROMPT,
  formatBatchedSuggestionsPrompt,
  hasSelfRecheckFinishRules,
  isSelfRecheckDecisionPrompt,
  isSelfRecheckPrompt,
  isSuggestionsMetaPrompt,
  parseSelfRecheckDecision,
  parseSuggestions,
  SELF_RECHECK_COMPOSE_RULES,
  SELF_RECHECK_DECISION_MARKER,
  SELF_RECHECK_MARKER,
} from "../src/bot/suggestions.js";

test("parseSuggestions accepts clean JSON array", () => {
  const raw = JSON.stringify([
    { text: "Run the typecheck", need: 92 },
    { text: "Add unit tests for the parser", need: 55 },
  ]);
  const s = parseSuggestions(raw);
  assert.equal(s.length, 2);
  assert.equal(s[0]!.need, 92);
  assert.ok(s[0]!.text.includes("typecheck"));
  // Sorted highest need first.
  assert.ok(s[0]!.need >= s[1]!.need);
});

test("parseSuggestions strips fences and progress markers", () => {
  const raw = '```json\n[{"text":"Verify the fix","need":88}]\n```\n{progress: 100%}';
  const s = parseSuggestions(raw);
  assert.equal(s.length, 1);
  assert.equal(s[0]!.need, 88);
});

test("parseSuggestions clamps need and drops empty text", () => {
  const raw = JSON.stringify([
    { text: "ok", need: 150 },
    { text: "", need: 90 },
    { text: "   ", need: 10 },
    { text: "Related polish", need: -5 },
  ]);
  const s = parseSuggestions(raw);
  assert.equal(s.length, 2);
  assert.equal(s.find((x) => x.text === "ok")?.need, 100);
  assert.equal(s.find((x) => x.text.includes("polish"))?.need, 0);
});

test("autoApproveSuggestions respects threshold", () => {
  const all = [
    { text: "a", need: 95 },
    { text: "b", need: 80 },
    { text: "c", need: 60 },
  ];
  assert.deepEqual(
    autoApproveSuggestions(all, 95).map((s) => s.text),
    ["a"],
  );
  assert.equal(autoApproveSuggestions(all, 0).length, 0);
  assert.equal(autoApproveSuggestions(all, 60).length, 3);
});

test("formatBatchedSuggestionsPrompt merges multiple into one numbered prompt", () => {
  const auto = [
    { text: "Run typecheck", need: 98 },
    { text: "Fix leftover bugs", need: 96 },
    { text: "Commit the fix", need: 95 },
  ];
  const batched = formatBatchedSuggestionsPrompt(auto);
  assert.equal(batched, "1) Run typecheck\n2) Fix leftover bugs\n3) Commit the fix");
  // Single item stays plain (no forced "1)").
  assert.equal(formatBatchedSuggestionsPrompt([{ text: "only", need: 99 }]), "only");
  assert.equal(formatBatchedSuggestionsPrompt([]), "");
});

test("isSuggestionsMetaPrompt detects quiet prompt", () => {
  assert.ok(isSuggestionsMetaPrompt("FOLLOW-UP SUGGESTIONS (meta only). Do NOT use tools."));
  assert.equal(isSuggestionsMetaPrompt("please fix the bug"), false);
});

test("self-recheck prompt is detectable and one-shot safe", () => {
  const p = buildSelfRecheckPrompt("fix plan exit", "implemented handler");
  assert.ok(p.startsWith(SELF_RECHECK_MARKER));
  assert.ok(isSelfRecheckPrompt(p));
  assert.equal(isSelfRecheckPrompt("please implement feature X"), false);
  // Second pass must not match nested recheck of recheck via wrong prefix only.
  assert.ok(isSelfRecheckPrompt(p + "\nmore"));
  assert.ok(DEFAULT_SELF_RECHECK_PROMPT.includes("{{USER}}"));
});

test("default self-recheck requires finish-all + production gaps + per-bug checklist", () => {
  const t = DEFAULT_SELF_RECHECK_PROMPT.toLowerCase();
  assert.ok(t.includes("still need"), "finish-all bans still-need leftovers");
  assert.ok(t.includes("production"), "production-related completeness");
  assert.ok(t.includes("rate limit") || t.includes("rate limits"), "auth/production example");
  assert.ok(t.includes("per-bug") || t.includes("plausible bug"), "per-bug recheck section");
  assert.ok(SELF_RECHECK_COMPOSE_RULES.toLowerCase().includes("still need"));
  assert.ok(SELF_RECHECK_COMPOSE_RULES.toLowerCase().includes("per-bug"));
});

test("self-recheck prompt supports env template placeholders", () => {
  const p = buildSelfRecheckPrompt(
    "add password reset",
    "added /reset route",
    "CUSTOM {{USER}} :: {{DONE}}",
  );
  assert.ok(p.startsWith(SELF_RECHECK_MARKER), "marker prepended for custom templates");
  assert.ok(p.includes("add password reset"));
  assert.ok(p.includes("added /reset route"));
  assert.ok(!p.includes("{{USER}}"));
});

test("self-recheck decision prompt is meta-only and detectable", () => {
  const p = buildSelfRecheckDecisionPrompt("fix auth", "edited handler", "+1 created · ~2 edited");
  assert.ok(p.startsWith(SELF_RECHECK_DECISION_MARKER));
  assert.ok(isSelfRecheckDecisionPrompt(p));
  assert.equal(isSelfRecheckDecisionPrompt("normal user text"), false);
  assert.ok(p.includes("fix auth"));
  assert.ok(p.includes("FILES MODIFIED"));
  const lower = p.toLowerCase();
  assert.ok(lower.includes("finish-all") || lower.includes("still need"), "decision requires finish-all in generated prompt");
  assert.ok(lower.includes("production"), "decision requires production-related section");
  assert.ok(lower.includes("per-bug") || lower.includes("plausible bug"), "decision requires bug checklist section");
});

test("parseSelfRecheckDecision accepts refuse and needed+prompt", () => {
  const skip = parseSelfRecheckDecision('{"needed":false,"reason":"simple Q&A"}');
  assert.equal(skip.needed, false);
  if (!skip.needed) assert.equal(skip.reason, "simple Q&A");

  const go = parseSelfRecheckDecision(
    '```json\n{"needed":true,"prompt":"Re-check race in account rotation and run typecheck"}\n```',
  );
  assert.equal(go.needed, true);
  if (go.needed) assert.ok(go.prompt.toLowerCase().includes("race"));

  assert.equal(parseSelfRecheckDecision("").needed, false);
  assert.equal(parseSelfRecheckDecision("not needed, skip recheck").needed, false);
  assert.equal(parseSelfRecheckDecision('{"recheck":true,"text":"Verify edge cases thoroughly"}').needed, true);
});

test("parseSelfRecheckDecision: prompt-only JSON and plain prose imply needed", () => {
  const only = parseSelfRecheckDecision(
    '{"prompt":"Verify cancel does not queue recheck after quiet decision"}',
  );
  assert.equal(only.needed, true);
  if (only.needed) assert.ok(only.prompt.includes("cancel"));

  const prose = parseSelfRecheckDecision(
    "Re-read session-runtime self-recheck path and fix any cancel races left.",
  );
  assert.equal(prose.needed, true);
  if (prose.needed) assert.ok(prose.prompt.toLowerCase().includes("session-runtime"));
});

test("parseSelfRecheckDecision does not treat suggestion need score as gate", () => {
  // Malformed mix: "need" is a 0–100 score, not the boolean gate.
  const d = parseSelfRecheckDecision('{"need":95,"text":"Run typecheck"}');
  // Without needed/recheck/required, prompt-only path uses text → needed true.
  assert.equal(d.needed, true);
  // Explicit false with stray need score still skips.
  const skip = parseSelfRecheckDecision('{"needed":false,"need":99,"reason":"trivial"}');
  assert.equal(skip.needed, false);
});

test("composeSelfRecheckTurn wraps AI prompt with marker and context", () => {
  const t = composeSelfRecheckTurn(
    "Verify mergeInputs keeps skipSelfRecheck and run tests",
    "harden self-recheck",
    "fixed merge + flushQueue",
  );
  assert.ok(isSelfRecheckPrompt(t));
  assert.ok(t.includes("Verify mergeInputs"));
  assert.ok(t.includes("harden self-recheck"));
  assert.ok(t.includes("fixed merge"));
  const lower = t.toLowerCase();
  assert.ok(lower.includes("still need"), "compose rules ban still-need leftovers");
  assert.ok(lower.includes("per-bug") || lower.includes("plausible bug"), "compose rules require bug recheck");
  assert.ok(lower.includes("production") || lower.includes("rate limit"), "compose rules mention production gaps");
});

test("composeSelfRecheckTurn does not double-wrap on casual USER mention alone", () => {
  const t = composeSelfRecheckTurn(
    "Check that USER'S REQUEST is still readable in cards",
    "card preview",
    "updated cleaners",
  );
  assert.ok(isSelfRecheckPrompt(t));
  // Context sections appended once (agent body lacked WHAT WAS JUST DONE).
  assert.ok(t.includes("WHAT WAS JUST DONE"));
  assert.ok(t.includes("card preview"));
});

test("compose injects finish-all rules even when headers make body look complete", () => {
  // AI brief copied section headers but omitted production/finish-all/per-bug.
  const thin = [
    "Re-read the auth handler and fix edge cases.",
    "",
    "USER'S REQUEST:",
    "add login",
    "",
    "WHAT WAS JUST DONE (summary):",
    "added route",
  ].join("\n");
  assert.equal(hasSelfRecheckFinishRules(thin), false);
  const t = composeSelfRecheckTurn(thin, "add login", "added route");
  assert.ok(isSelfRecheckPrompt(t));
  assert.ok(hasSelfRecheckFinishRules(t), "rules injected despite looksComplete headers");
  assert.ok(t.toLowerCase().includes("still need"));
  // Default full template already has rules — no double "Finish-all:" spam.
  const full = composeSelfRecheckTurn(
    DEFAULT_SELF_RECHECK_PROMPT.replace("{{USER}}", "x").replace("{{DONE}}", "y"),
    "x",
    "y",
  );
  const finishHits = (full.match(/Finish-all/gi) || []).length;
  assert.ok(finishHits >= 1 && finishHits <= 2, `expected 1–2 Finish-all mentions, got ${finishHits}`);
});
