import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  formatLivenessHint,
  LIVENESS_MIN_SILENCE_MS,
  shouldPulseLiveness,
} from "../src/stream/streamer.js";

test("formatLivenessHint includes elapsed and optional step", () => {
  assert.equal(formatLivenessHint("2m 14s"), "⏳ Still working · 2m 14s");
  const withStep = formatLivenessHint("45s", "Run ssh deploy");
  assert.ok(withStep.startsWith("⏳ Still working · 45s"));
  assert.ok(withStep.includes("Run ssh deploy"));
});

test("formatLivenessHint clamps long steps", () => {
  const long = "x".repeat(200);
  const hint = formatLivenessHint("1m", long);
  assert.ok(hint.length < 120);
  assert.ok(hint.includes("…"));
});

test("shouldPulseLiveness waits for silence and skips duplicates", () => {
  const base = {
    closed: false,
    lastContentAt: 1_000,
    now: 1_000 + LIVENESS_MIN_SILENCE_MS + 1,
    nextHint: "⏳ Still working · 15s",
    hasLiveSurface: true,
  };
  assert.equal(shouldPulseLiveness(base), true);
  assert.equal(shouldPulseLiveness({ ...base, currentHint: base.nextHint }), false);
  assert.equal(
    shouldPulseLiveness({ ...base, now: 1_000 + LIVENESS_MIN_SILENCE_MS - 1 }),
    false,
  );
  assert.equal(shouldPulseLiveness({ ...base, closed: true }), false);
  assert.equal(shouldPulseLiveness({ ...base, hasLiveSurface: false }), false);
});
