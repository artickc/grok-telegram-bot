import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectTurnImagePaths,
  extractImagePaths,
  grokSessionAssetsDir,
  grokSessionMediaDirs,
  listFreshImagesInDir,
} from "../src/bot/image-return.js";
import { IMAGE_OUTPUT_DIRECTIVE } from "../src/render/image-output.js";

test("extractImagePaths resolves relative and absolute paths", () => {
  const cwd = "H:\\proj";
  const paths = extractImagePaths(
    'saved as images/1.jpg and also H:\\\\tmp\\\\shot.png and "./out/diagram.webp"',
    cwd,
  );
  assert.ok(paths.some((p) => p.endsWith(join("images", "1.jpg")) || p.includes("images")));
  assert.ok(paths.some((p) => /shot\.png$/i.test(p)));
  assert.ok(paths.some((p) => /diagram\.webp$/i.test(p)));
});

test("grokSessionAssetsDir matches encodeURIComponent(cwd) layout", () => {
  const cwd = "H:\\Lucru\\Domains\\WinAppBuilder";
  const dir = grokSessionAssetsDir(cwd, "abc-session");
  assert.equal(
    dir,
    join(homedir(), ".grok", "sessions", encodeURIComponent(cwd), "abc-session", "assets"),
  );
});

test("grokSessionMediaDirs includes both images and assets", () => {
  const cwd = "H:\\Lucru\\Domains\\WinAppBuilder";
  const dirs = grokSessionMediaDirs(cwd, "abc-session");
  assert.equal(dirs.length, 2);
  assert.ok(dirs[0]!.endsWith(join("abc-session", "images")));
  assert.ok(dirs[1]!.endsWith(join("abc-session", "assets")));
});

test("IMAGE_OUTPUT_DIRECTIVE is tidy-idempotent (no trailing junk)", () => {
  assert.ok(IMAGE_OUTPUT_DIRECTIVE.startsWith("IMAGE OUTPUT RULES:"));
  assert.ok(!/\s$/.test(IMAGE_OUTPUT_DIRECTIVE));
  assert.ok(!/\n{3,}/.test(IMAGE_OUTPUT_DIRECTIVE));
  assert.match(IMAGE_OUTPUT_DIRECTIVE, /session media folder/i);
  assert.match(IMAGE_OUTPUT_DIRECTIVE, /absolute path/i);
});

test("listFreshImagesInDir only returns recent image files", () => {
  const dir = mkdtempSync(join(tmpdir(), "imgret-"));
  const fresh = join(dir, "new.png");
  const old = join(dir, "old.jpg");
  writeFileSync(fresh, Buffer.from([1, 2, 3, 4]));
  writeFileSync(old, Buffer.from([1, 2, 3, 4]));
  const now = Date.now();
  utimesSync(old, new Date(now - 60_000), new Date(now - 60_000));
  utimesSync(fresh, new Date(now), new Date(now));
  const list = listFreshImagesInDir(dir, now - 5_000);
  assert.deepEqual(list, [fresh]);
});

test("collectTurnImagePaths merges text paths and assets dir", () => {
  const root = mkdtempSync(join(tmpdir(), "imgret-root-"));
  const images = join(root, "images");
  mkdirSync(images);
  const shot = join(images, "shot.webp");
  writeFileSync(shot, Buffer.from([9, 9, 9]));
  const now = Date.now();
  utimesSync(shot, new Date(now), new Date(now));

  const paths = collectTurnImagePaths({
    scanText: "see images/shot.webp",
    cwd: root,
    since: now - 1000,
  });
  assert.ok(paths.some((p) => p === shot || p.endsWith("shot.webp")));
});
