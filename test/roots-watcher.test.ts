import { strict as assert } from "node:assert";
import { test } from "node:test";
import { shouldIgnoreProjectDirName } from "../src/projects/manager.js";
import {
  diffNewProjectDirs,
  listRootProjectDirs,
  type RootsWatcherFs,
} from "../src/projects/roots-watcher.js";

test("shouldIgnoreProjectDirName skips dot and known junk", () => {
  assert.equal(shouldIgnoreProjectDirName(".git"), true);
  assert.equal(shouldIgnoreProjectDirName("node_modules"), true);
  assert.equal(shouldIgnoreProjectDirName(".hidden"), true);
  assert.equal(shouldIgnoreProjectDirName(""), true);
  assert.equal(shouldIgnoreProjectDirName("MyApp"), false);
});

test("listRootProjectDirs returns only real dirs and skips ignore", () => {
  const fsApi: RootsWatcherFs = {
    readdirSync: () => ["MyApp", "node_modules", ".cache", "readme.txt", "Other"],
    statSync: (p) => {
      const base = p.replace(/\\/g, "/").split("/").pop()!;
      if (base === "readme.txt") {
        return { isDirectory: () => false, mtimeMs: 1 };
      }
      return { isDirectory: () => true, mtimeMs: 100 };
    },
  };
  const list = listRootProjectDirs("H:/Domains", fsApi);
  assert.deepEqual(
    list.map((p) => p.name).sort(),
    ["MyApp", "Other"],
  );
});

test("diffNewProjectDirs returns only unknown paths", () => {
  const known = new Set(["/a/Old"]);
  const current = [
    { name: "Old", path: "/a/Old", lastUsed: 1 },
    { name: "New", path: "/a/New", lastUsed: 2 },
  ];
  const news = diffNewProjectDirs(known, current);
  assert.equal(news.length, 1);
  assert.equal(news[0]!.name, "New");
});
