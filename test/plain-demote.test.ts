import { strict as assert } from "node:assert";
import { test } from "node:test";
import { demoteMarkdownForPlain } from "../src/bot/telegram-io.js";

test("demoteMarkdownForPlain strips bold and keeps path readable", () => {
  const path =
    "C:\\Users\\artic\\.grok\\sessions\\H%3A%5CLucru\\plan.md";
  const plain = demoteMarkdownForPlain(`✏️ **Edit** \`${path}\` ✅ (+93)`);
  assert.ok(!plain.includes("**"), plain);
  assert.ok(plain.includes("Edit"), plain);
  assert.ok(plain.includes("plan.md"), plain);
  assert.ok(plain.includes("C:\\Users") || plain.includes("C:\\Users"), plain);
});

test("demoteMarkdownForPlain unwraps diff fences", () => {
  const src = "header\n```diff\n@@ -1 +1 @@\n+line with **bold**\n```\nfooter";
  const plain = demoteMarkdownForPlain(src);
  assert.ok(!plain.includes("```"), plain);
  assert.ok(plain.includes("+line with bold") || plain.includes("+line with **bold**") === false, plain);
  assert.ok(plain.includes("header") && plain.includes("footer"), plain);
});

test("demoteMarkdownForPlain strips legacy path-in-bold headers", () => {
  const plain = demoteMarkdownForPlain(
    "✏️ **Edit C:\\Users\\artic\\.grok\\plan.md** ✅\n```diff\n+x\n```",
  );
  assert.ok(!plain.includes("**"), plain);
  assert.ok(!plain.includes("```"), plain);
  assert.ok(plain.includes("Edit") && plain.includes("plan.md"), plain);
});
