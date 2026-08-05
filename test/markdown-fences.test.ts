import { strict as assert } from "node:assert";
import { test } from "node:test";
import { toTelegramMarkdown } from "../src/render/markdown.js";

test("empty code fence closes on first body line", () => {
  const md = toTelegramMarkdown("before\n```ts\n```\nafter");
  assert.ok(md.includes("before"), md);
  assert.ok(md.includes("after"), md);
  assert.ok(md.includes("```"), md);
});

test("closed fence preserves body and continues prose", () => {
  const md = toTelegramMarkdown("intro\n```bash\necho hi\n```\nok");
  assert.ok(md.includes("echo hi"), md);
  assert.ok(md.includes("ok"), md);
  assert.ok(md.includes("intro"), md);
});

test("body with nested backticks uses longer outer fence", () => {
  const src = "```\nuse ``` inside\n```";
  const md = toTelegramMarkdown(src);
  // Output fence longer than 3 so inner ``` is literal in code body.
  assert.ok(md.includes("use ``` inside") || md.includes("use \\`\\`\\` inside"), md);
  assert.ok(md.startsWith("````") || md.includes("\n````"), md);
});

test("unclosed fence keeps content (streaming)", () => {
  const md = toTelegramMarkdown("before\n```js\nconst x = 1;");
  assert.ok(md.includes("before"));
  assert.ok(md.includes("const x = 1;"));
});

test("thinking quotes neutralize triple backticks", () => {
  const src = "> \u{1F4AD} thinking: looks at ```ts code``` fence";
  const md = toTelegramMarkdown(src);
  // Should not leave an unclosed/broken fence entity.
  assert.ok(md.includes(">"));
  assert.ok(!/`{3,}ts/.test(md) || md.includes("\\`"), md);
});

test("unbalanced bold is escaped not dropped", () => {
  const md = toTelegramMarkdown("hello **world and more");
  assert.ok(md.includes("hello"));
  assert.ok(md.includes("world"));
  assert.ok(md.includes("more"));
});

test("snake_case is not italicized", () => {
  const md = toTelegramMarkdown("use foo_bar_baz here");
  assert.ok(md.includes("foo") && md.includes("bar") && md.includes("baz"), md);
  // Should not wrap whole thing in italic.
  assert.ok(!md.includes("_foo\\_bar\\_baz_"), md);
});

test("inline code and bold together", () => {
  const md = toTelegramMarkdown("**bold** and `code` ok");
  assert.ok(md.includes("*bold*"), md);
  assert.ok(md.includes("`code`"), md);
});

test("Windows path in inline code stays code (not bold body)", () => {
  const path =
    "C:\\Users\\artic\\.grok\\sessions\\H%3A%5CLucru%5CDomains%5CApp\\plan.md";
  const md = toTelegramMarkdown(`✏️ **Edit** \`${path}\` ✅`);
  assert.ok(md.includes("*Edit*"), md);
  // Path must appear inside a code span, not inside the bold entity.
  assert.ok(md.includes("`"), md);
  assert.ok(md.includes("plan.md") || md.includes("plan\\.md"), md);
  // Bold entity should not swallow the drive letter alone as **Edit C:**.
  assert.ok(!md.includes("*Edit C:"), md);
});
