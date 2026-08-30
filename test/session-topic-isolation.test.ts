import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cwdAllowsContinue } from "../src/bot/chat-controller.js";

test("cwdAllowsContinue same project path", () => {
  assert.equal(
    cwdAllowsContinue("H:\\Lucru\\Domains\\amo.watch", "H:/Lucru/Domains/amo.watch/"),
    true,
  );
});

test("cwdAllowsContinue refuses General adopting project session", () => {
  assert.equal(
    cwdAllowsContinue("H:\\Lucru\\Domains", "H:\\Lucru\\Domains\\amo.watch"),
    false,
  );
});

test("cwdAllowsContinue refuses empty session cwd when expected set", () => {
  assert.equal(cwdAllowsContinue("H:\\Lucru\\Domains", ""), false);
  assert.equal(cwdAllowsContinue("H:\\Lucru\\Domains", undefined), false);
});

test("cwdAllowsContinue allows when expected empty", () => {
  assert.equal(cwdAllowsContinue("", "H:\\Lucru\\Domains\\amo.watch"), true);
  assert.equal(cwdAllowsContinue(undefined, "x"), true);
});
