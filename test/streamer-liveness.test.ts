import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  formatLivenessHint,
  LIVENESS_MIN_SILENCE_MS,
  shouldPulseLiveness,
} from "../src/stream/streamer.js";

test("formatLivenessHint is empty without a real step (no Still working spam)", () => {
  assert.equal(formatLivenessHint("2m 14s"), "");
  assert.equal(formatLivenessHint("2m 14s", "   "), "");
});

test("formatLivenessHint shows step with elapsed", () => {
  assert.equal(formatLivenessHint("45s", "Run ssh deploy"), "Run ssh deploy · 45s");
  assert.ok(formatLivenessHint("1m", "x".repeat(200)).endsWith("· 1m"));
  assert.ok(!formatLivenessHint("1m", "Run tool").includes("Still working"));
});

test("shouldPulseLiveness skips empty hints and duplicates", () => {
  const base = {
    closed: false,
    lastContentAt: 1_000,
    now: 1_000 + LIVENESS_MIN_SILENCE_MS + 1,
    nextHint: "Run ssh · 15s",
    hasLiveSurface: true,
  };
  assert.equal(shouldPulseLiveness(base), true);
  assert.equal(shouldPulseLiveness({ ...base, nextHint: "" }), false);
  assert.equal(shouldPulseLiveness({ ...base, currentHint: base.nextHint }), false);
  assert.equal(
    shouldPulseLiveness({ ...base, now: 1_000 + LIVENESS_MIN_SILENCE_MS - 1 }),
    false,
  );
  assert.equal(shouldPulseLiveness({ ...base, closed: true }), false);
  assert.equal(shouldPulseLiveness({ ...base, hasLiveSurface: false }), false);
});

test("pulse interval aligned with silence floor eventually allows elapsed update", () => {
  // SessionRuntime pulses at LIVENESS_MIN_SILENCE_MS — first tick must clear silence.
  const lastContentAt = 0;
  const pulseAt = LIVENESS_MIN_SILENCE_MS;
  assert.equal(
    shouldPulseLiveness({
      closed: false,
      lastContentAt,
      now: pulseAt,
      nextHint: "Run: npm test · 12s",
      hasLiveSurface: true,
    }),
    true,
  );
  assert.equal(
    shouldPulseLiveness({
      closed: false,
      lastContentAt,
      now: pulseAt - 1,
      nextHint: "Run: npm test · 12s",
      hasLiveSurface: true,
    }),
    false,
  );
});
