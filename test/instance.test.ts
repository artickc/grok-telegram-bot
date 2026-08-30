import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  listKnownInstances,
  parseInstanceFlags,
  parseInstanceSlug,
  resolveInstanceDir,
  serviceIdentity,
  stripInstanceFlags,
} from "../src/app/instance.js";

test("parseInstanceSlug accepts and lowercases valid names", () => {
  assert.equal(parseInstanceSlug("work"), "work");
  assert.equal(parseInstanceSlug("Home"), "home");
  assert.equal(parseInstanceSlug("coding-2"), "coding-2");
});

test("parseInstanceSlug rejects reserved and invalid names", () => {
  assert.throws(() => parseInstanceSlug("default"), /reserved/);
  assert.throws(() => parseInstanceSlug("logs"), /reserved/);
  assert.throws(() => parseInstanceSlug("1work"), /Invalid instance name/);
  assert.throws(() => parseInstanceSlug("has space"), /Invalid instance name/);
  assert.throws(() => parseInstanceSlug(""), /Invalid instance name/);
});

test("parseInstanceFlags and stripInstanceFlags handle both flag forms", () => {
  const argv = ["--name", "work", "install", "--instance=/tmp/x"];
  assert.deepEqual(parseInstanceFlags(argv), { name: "work", instanceDir: "/tmp/x" });
  assert.deepEqual(stripInstanceFlags(argv), ["install"]);
});

test("resolveInstanceDir prefers --instance over --name over GROK_TG_DIR", () => {
  const canonical = "/home/u/.grok/tg";
  assert.equal(
    resolveInstanceDir({
      argv: ["node", "x", "--name", "work", "--instance", "/tmp/custom"],
      envDir: "/tmp/envdir",
      canonicalDir: canonical,
      cwd: "/tmp",
    }),
    resolve("/tmp/custom"),
  );
  assert.equal(
    resolveInstanceDir({
      argv: ["node", "x", "--name", "work"],
      envDir: "/tmp/envdir",
      canonicalDir: canonical,
      cwd: "/tmp",
    }),
    join(canonical, "instances", "work"),
  );
  assert.equal(
    resolveInstanceDir({
      argv: ["node", "x"],
      envDir: "/tmp/envdir",
      canonicalDir: canonical,
      cwd: "/tmp",
    }),
    resolve("/tmp/envdir"),
  );
});

test("resolveInstanceDir ignores GROK_TG_CWD unless that folder has a .env", () => {
  const root = mkdtempSync(join(tmpdir(), "grok-tg-inst-"));
  const canonical = join(root, "canonical");
  const hinted = join(root, "hint");
  mkdirSync(canonical, { recursive: true });
  mkdirSync(hinted, { recursive: true });
  try {
    assert.equal(
      resolveInstanceDir({
        argv: ["node", "x"],
        cwdHint: hinted,
        canonicalDir: canonical,
        cwd: root,
      }),
      canonical,
    );
    writeFileSync(join(hinted, ".env"), "TELEGRAM_BOT_TOKEN=x\n");
    assert.equal(
      resolveInstanceDir({
        argv: ["node", "x"],
        cwdHint: hinted,
        canonicalDir: canonical,
        cwd: root,
      }),
      hinted,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("serviceIdentity keeps the default unit unless the dir is a named instance", () => {
  const canonical = "/home/u/.grok/tg";
  const def = serviceIdentity(canonical, undefined, canonical);
  assert.equal(def.id, "grok-telegram-bot");
  assert.equal(def.windowsTaskName, "GrokTelegramBot");
  assert.equal(def.macosLabel, "com.grok.telegrambot");
  assert.equal(def.slug, undefined);

  const folder = serviceIdentity("/home/u/my-bot", undefined, canonical);
  assert.equal(folder.id, "grok-telegram-bot");

  const named = serviceIdentity(join(canonical, "instances", "work"), "work", canonical);
  assert.equal(named.id, "grok-telegram-bot-work");
  assert.equal(named.displayName, "Grok Telegram Bot (work)");
  assert.equal(named.windowsTaskName, "GrokTelegramBot-work");
  assert.equal(named.macosLabel, "com.grok.telegrambot.work");
  assert.equal(named.slug, "work");

  const inferred = serviceIdentity(join(canonical, "instances", "home"), undefined, canonical);
  assert.equal(inferred.id, "grok-telegram-bot-home");
  assert.equal(inferred.slug, "home");
});

test("listKnownInstances finds the default and named .env files", () => {
  const root = mkdtempSync(join(tmpdir(), "grok-tg-list-"));
  mkdirSync(join(root, "instances", "work"), { recursive: true });
  writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=a\n");
  writeFileSync(join(root, "instances", "work", ".env"), "TELEGRAM_BOT_TOKEN=b\n");
  mkdirSync(join(root, "instances", "empty"), { recursive: true });
  try {
    const items = listKnownInstances(root);
    assert.equal(items.length, 2);
    assert.equal(items[0]?.name, "(default)");
    assert.equal(items[0]?.identity.id, "grok-telegram-bot");
    assert.equal(items[1]?.name, "work");
    assert.equal(items[1]?.identity.id, "grok-telegram-bot-work");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
