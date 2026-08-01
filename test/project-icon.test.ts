import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { discoverProjectIcon } from "../src/forum/project-icon.js";

test("discoverProjectIcon finds root favicon.ico", () => {
  const dir = join(tmpdir(), `grok-icon-${Date.now()}-a`);
  mkdirSync(dir, { recursive: true });
  const fav = join(dir, "favicon.ico");
  writeFileSync(fav, Buffer.from([0, 0, 1, 0]));
  try {
    assert.equal(discoverProjectIcon(dir), fav);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverProjectIcon finds MSIX Assets StoreLogo", () => {
  const dir = join(tmpdir(), `grok-icon-${Date.now()}-b`);
  const assets = join(dir, "Assets");
  mkdirSync(assets, { recursive: true });
  const logo = join(assets, "StoreLogo.png");
  writeFileSync(logo, Buffer.alloc(100, 1));
  try {
    assert.equal(discoverProjectIcon(dir), logo);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverProjectIcon reads Package.appxmanifest Logo path", () => {
  const dir = join(tmpdir(), `grok-icon-${Date.now()}-c`);
  const assets = join(dir, "Assets");
  mkdirSync(assets, { recursive: true });
  const logo = join(assets, "AppList.png");
  writeFileSync(logo, Buffer.alloc(80, 2));
  writeFileSync(
    join(dir, "Package.appxmanifest"),
    `<?xml version="1.0"?><Package><Properties><Logo>Assets\\AppList.png</Logo></Properties></Package>`,
  );
  try {
    assert.equal(discoverProjectIcon(dir), logo);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverProjectIcon returns undefined for empty dir", () => {
  const dir = join(tmpdir(), `grok-icon-${Date.now()}-d`);
  mkdirSync(dir, { recursive: true });
  try {
    assert.equal(discoverProjectIcon(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
