import { strict as assert } from "node:assert";
import { resolve as pathResolve } from "node:path";
import { test } from "node:test";
import { resolveBindTarget } from "../src/forum/bind-path.js";

/** Absolute paths that work on both Windows and Linux CI. */
const ROOT = pathResolve("/Lucru/Domains");
const DEMO = pathResolve(ROOT, "DemoApp");
const OTHER = pathResolve(ROOT, "Other");
const BRAND_NEW = pathResolve(ROOT, "BrandNewApp");
const MISSING = pathResolve(ROOT, "MissingApp");

const catalog = [
  { name: "DemoApp", path: DEMO },
  { name: "Other", path: OTHER },
];

function lookup(name: string) {
  const key = name.trim().toLowerCase();
  return catalog.find((p) => p.name.toLowerCase() === key);
}

test("resolveBindTarget: exact catalog name (case-insensitive)", () => {
  const r = resolveBindTarget("demoapp", {
    existsSync: () => false,
    isDirectory: () => true,
    findExactByName: lookup,
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.path, DEMO);
});

test("resolveBindTarget: rejects partial / fuzzy names", () => {
  const r = resolveBindTarget("Demo", {
    existsSync: () => false,
    isDirectory: () => true,
    findExactByName: lookup,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /exact/i);
});

test("resolveBindTarget: absolute existing directory", () => {
  const abs = DEMO;
  const r = resolveBindTarget(abs, {
    existsSync: (p) => p === abs,
    isDirectory: (p) => p === abs || p.endsWith("DemoApp"),
    findExactByName: lookup,
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.path.toLowerCase().includes("demoapp"));
});

test("resolveBindTarget: empty and unknown", () => {
  assert.equal(
    resolveBindTarget("  ", {
      existsSync: () => false,
      isDirectory: () => true,
      findExactByName: lookup,
    }).ok,
    false,
  );
  assert.equal(
    resolveBindTarget("hello world", {
      existsSync: () => false,
      isDirectory: () => true,
      findExactByName: lookup,
    }).ok,
    false,
  );
});

test("resolveBindTarget: not a directory", () => {
  const r = resolveBindTarget("DemoApp", {
    existsSync: () => false,
    isDirectory: () => false,
    findExactByName: lookup,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /Not a directory/i);
});

test("resolveBindTarget: createIfMissing makes absolute path", () => {
  const abs = BRAND_NEW;
  const created: string[] = [];
  const r = resolveBindTarget(abs, {
    existsSync: () => false,
    isDirectory: (p) => created.some((c) => p === c || p.endsWith("BrandNewApp")),
    findExactByName: lookup,
    createIfMissing: true,
    mkdirSync: (p) => {
      created.push(p);
    },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.created, true);
    assert.ok(r.path.toLowerCase().includes("brandnewapp"));
  }
  assert.equal(created.length, 1);
});

test("resolveBindTarget: createIfMissing short name under defaultRoot", () => {
  const created: string[] = [];
  const root = ROOT;
  const r = resolveBindTarget("FreshApp", {
    existsSync: () => false,
    isDirectory: (p) => created.includes(p),
    findExactByName: lookup,
    createIfMissing: true,
    defaultRoot: root,
    mkdirSync: (p) => {
      created.push(p);
    },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.created, true);
    assert.ok(r.path.replace(/\\/g, "/").includes("Domains/FreshApp") || r.path.includes("FreshApp"));
  }
});

test("resolveBindTarget: without createIfMissing still fails missing absolute", () => {
  const abs = MISSING;
  const r = resolveBindTarget(abs, {
    existsSync: () => false,
    isDirectory: () => false,
    findExactByName: lookup,
  });
  assert.equal(r.ok, false);
});
