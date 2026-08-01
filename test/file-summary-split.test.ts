import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  cloneFileOps,
  summarizeFileOpsSplit,
  type FileOp,
} from "../src/render/file-summary.js";

test("summarizeFileOpsSplit labels first turn vs recheck", () => {
  const first = new Map<string, FileOp>([
    ["src/a.ts", "created"],
    ["src/b.ts", "edited"],
  ]);
  const recheck = new Map<string, FileOp>([["src/c.ts", "created"]]);
  const out = summarizeFileOpsSplit(first, recheck, process.cwd());
  assert.ok(out.includes("After first turn"), out);
  assert.ok(out.includes("After self-recheck"), out);
  assert.ok(out.includes("a.ts") || out.includes("src/a.ts"), out);
  assert.ok(out.includes("c.ts") || out.includes("src/c.ts"), out);
});

test("cloneFileOps is independent", () => {
  const a = new Map<string, FileOp>([["x", "edited"]]);
  const b = cloneFileOps(a);
  b.set("y", "created");
  assert.equal(a.has("y"), false);
  assert.equal(b.get("x"), "edited");
});
