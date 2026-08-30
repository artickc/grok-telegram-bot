import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PromptInput } from "../src/app/types.js";
import { mergeInputs } from "../src/bot/prompt-content.js";
import {
  fitCaption,
  formatPromptAnchorBody,
  formatPromptTag,
  newPromptId,
  splitPromptAnchorParts,
} from "../src/bot/prompt-anchor.js";
import { sessionHashtags, tagSafe } from "../src/render/hashtags.js";

test("newPromptId produces tag-safe ids", () => {
  const id = newPromptId();
  assert.match(id, /^[a-z0-9_]+$/);
  assert.ok(id.length > 4);
  assert.equal(formatPromptTag(id), `#prompt_${id}`);
});

test("formatPromptTag sanitises arbitrary input", () => {
  assert.equal(formatPromptTag("Ab C!"), `#prompt_${tagSafe("Ab C!")}`);
});

test("formatPromptAnchorBody includes prefix, body and tags", () => {
  const body = formatPromptAnchorBody("hello world", "abc123", {
    prefix: "📝 Prompt",
    projectName: "My App",
  });
  assert.ok(body.includes("📝 Prompt"));
  assert.ok(body.includes("hello world"));
  assert.ok(body.includes("#prompt_abc123"));
  assert.ok(body.includes("#proj_my_app"));
});

test("splitPromptAnchorParts keeps full long prompts across parts", () => {
  const long = "x".repeat(10_000);
  const parts = splitPromptAnchorParts(long, "z9");
  assert.ok(parts.length >= 3);
  for (const p of parts) {
    assert.ok(p.length < 4200);
    assert.ok(p.includes("#prompt_z9"));
  }
  const joined = parts.map((p) => p.replace(/^[^\n]*\n/, "").replace(/\n\n#prompt_[\s\S]*$/, "")).join("");
  assert.equal(joined, long);
});

test("fitCaption keeps #prompt_ tags within 1024", () => {
  const long = "y".repeat(2000);
  const full = formatPromptAnchorBody(long, "cap1", { prefix: "📷 Image" });
  const cap = fitCaption(full, 1024);
  assert.ok(cap.length <= 1024);
  assert.ok(cap.includes("#prompt_cap1"), "tags must not be sliced off");
  assert.ok(cap.endsWith("#prompt_cap1") || cap.includes("#prompt_cap1"));
});

test("fitCaption is exact when body already short", () => {
  const full = formatPromptAnchorBody("hi", "z");
  assert.equal(fitCaption(full, 1024), full);
});

test("sessionHashtags appends #prompt_ after proj and sess", () => {
  const tags = sessionHashtags({
    projectName: "demo",
    sessionId: "abcdef12-rest",
    promptId: "p1q2",
  });
  assert.equal(tags, "#proj_demo #sess_abcdef12 #prompt_p1q2");
});

test("sessionHashtags omits prompt when missing", () => {
  assert.equal(sessionHashtags({ projectName: "demo" }), "#proj_demo");
});

test("mergeInputs keeps the first promptId and replyTo", () => {
  const a: PromptInput = {
    text: "one",
    images: [],
    replyTo: 10,
    promptId: "first",
  };
  const b: PromptInput = {
    text: "two",
    images: [],
    replyTo: 20,
    promptId: "second",
  };
  const m = mergeInputs([a, b]);
  assert.equal(m.replyTo, 10);
  assert.equal(m.promptId, "first");
  assert.equal(m.text, "one\n\ntwo");
});
