/**
 * Voice requires STT — resource_link audio attachment was removed because the
 * Grok CLI rejects ACP audio blocks and cannot hear raw OGG without STT.
 * Keep prompt-content resource_link tests for document/file attachments.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildContentBlocks, mergeInputs } from "../src/bot/prompt-content.js";
import { textPrompt, type PromptInput } from "../src/app/types.js";

test("buildContentBlocks emits resource_link blocks before text", () => {
  const input: PromptInput = {
    text: "Please process the attached file.",
    images: [],
    resourceLinks: [{ uri: "file:///tmp/v.ogg", name: "v.ogg", mimeType: "audio/ogg", size: 100 }],
  };
  const blocks = buildContentBlocks(input);
  assert.equal(blocks[0]?.type, "resource_link");
  assert.equal(blocks[0]?.uri, "file:///tmp/v.ogg");
  assert.equal(blocks[blocks.length - 1]?.type, "text");
});

test("mergeInputs concatenates resource links", () => {
  const a: PromptInput = {
    text: "file a",
    images: [],
    resourceLinks: [{ uri: "file:///a.ogg", name: "a.ogg", mimeType: "audio/ogg", size: 1 }],
  };
  const b = textPrompt("hello");
  const m = mergeInputs([a, b]);
  assert.equal(m.resourceLinks?.length, 1);
  assert.match(m.text, /hello/);
});

test("buildContentBlocks appends imageOutput then progress", () => {
  const blocks = buildContentBlocks(textPrompt("hi"), {
    imageOutput: "IMAGE OUTPUT RULES:\nkeep in session",
    progress: "PROGRESS REPORTING",
  });
  const text = blocks.find((b) => b.type === "text")?.text ?? "";
  assert.match(text, /hi/);
  assert.ok(text.indexOf("IMAGE OUTPUT") < text.indexOf("PROGRESS REPORTING"));
});
