import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionLog } from "../src/grok/session-log.js";
import { readHistory } from "../src/sessions/history.js";
import { SessionStore } from "../src/sessions/store.js";

const dir = mkdtempSync(join(tmpdir(), "grok-tg-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("SessionLog writes a history-parser-compatible log", () => {
  const slog = new SessionLog(dir);
  const id = "grok-testsession";
  slog.create(id, "/tmp/project");
  slog.logUser(id, "add a hello function");
  slog.logTool(id, "write_file", "wrote hello.ts");
  slog.logAssistant(id, "Done — added hello().");
  slog.update(id, { title: "add a hello function", grok_session_id: "abc-123" });

  const meta = slog.read(id);
  assert.equal(meta?.session_id, id);
  assert.equal(meta?.grok_session_id, "abc-123");
  assert.equal(meta?.cwd, "/tmp/project");

  const entries = readHistory(join(dir, `${id}.jsonl`), 20);
  const roles = entries.map((e) => e.role);
  assert.deepEqual(roles, ["user", "tool", "assistant"]);
  assert.equal(entries[0]!.text, "add a hello function");
  assert.equal(entries[2]!.text, "Done — added hello().");
  assert.equal(entries[1]!.tool, "write_file");
});

test("SessionStore lists sessions and detects the lock", () => {
  const slog = new SessionLog(dir);
  const id = "grok-locked";
  slog.create(id, "/tmp/p2");
  slog.logUser(id, "hi");
  slog.lock(id, process.pid); // this test process is alive => active

  const store = new SessionStore(dir);
  const metas = store.list(50);
  const found = metas.find((m) => m.sessionId === id);
  assert.ok(found, "session should be listed");
  assert.equal(found!.active, true, "locked session with a live pid is active");
  assert.equal(found!.lockPid, process.pid);

  slog.unlock(id);
  assert.equal(store.get(id)!.active, false, "after unlock the session is idle");
});
